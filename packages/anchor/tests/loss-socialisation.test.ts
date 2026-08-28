import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
} from '@solana/spl-token';
import { BankrunProvider } from 'anchor-bankrun';
import { Clock, startAnchor, type ProgramTestContext, type BanksClient } from 'solana-bankrun';

/**
 * Socialising a loss across staker positions.
 *
 * The loss cascade in every `verify_and_payout*` path decremented
 * `vault.total_staked` but no `StakerPosition`, so a socialised loss was not
 * socialised at all: every position still recorded its original principal,
 * `execute_unstake` paid that in full, and whoever withdrew first was made
 * whole while the last staker absorbed everything — or could not withdraw,
 * because the vault token account was short.
 *
 * Two equal stakers, one loss, both exit. What is asserted is the property
 * that was missing: the loss lands on both in equal share, and the sum of what
 * they take out never exceeds what the vault actually holds.
 */
const IDL_PATH = resolve(__dirname, '../target/idl/covantic.json');
const hasIdl = existsSync(IDL_PATH);
const PROGRAM_ID = new PublicKey(
  hasIdl
    ? ((JSON.parse(readFileSync(IDL_PATH, 'utf-8')) as { address?: string }).address ??
        '52KrSMg3rsbtRw3FchxJ9jRwRzQmWcDzg1AiiHHHXz1D')
    : '52KrSMg3rsbtRw3FchxJ9jRwRzQmWcDzg1AiiHHHXz1D',
);

const CONFIG_SEED = Buffer.from('covantic_config');
const VAULT_SEED = Buffer.from('covantic_vault');
const POLICY_SEED = Buffer.from('covantic_policy');
const STAKER_SEED = Buffer.from('covantic_staker');
const ATTESTATION_SEED = Buffer.from('covantic_attestation');

const USDC_DECIMALS = 6;
const usdc = (n: number) => new BN(n * 10 ** USDC_DECIMALS);
/** `SOLVENCY_CRITICAL` — the same 5000 bps `create_policy` gates issuance on. */
const SOLVENCY_CRITICAL = 5000n;

function u64LeBytes(value: BN): Buffer {
  const buf = Buffer.alloc(8);
  value.toArrayLike(Buffer, 'le', 8).copy(buf);
  return buf;
}
const configPda = () => PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
const vaultPda = () => PublicKey.findProgramAddressSync([VAULT_SEED], PROGRAM_ID);
const stakerPda = (s: PublicKey) =>
  PublicKey.findProgramAddressSync([STAKER_SEED, s.toBuffer()], PROGRAM_ID);
const attestationPda = (a: PublicKey) =>
  PublicKey.findProgramAddressSync([ATTESTATION_SEED, a.toBuffer()], PROGRAM_ID);
const policyPda = (h: PublicKey, id: BN) =>
  PublicKey.findProgramAddressSync([POLICY_SEED, h.toBuffer(), u64LeBytes(id)], PROGRAM_ID);

async function advanceClockBySeconds(ctx: ProgramTestContext, seconds: number): Promise<void> {
  const current = await ctx.banksClient.getClock();
  ctx.warpToSlot(current.slot + 1n);
  const warped = await ctx.banksClient.getClock();
  ctx.setClock(
    new Clock(
      warped.slot,
      warped.epochStartTimestamp,
      warped.epoch,
      warped.leaderScheduleEpoch,
      current.unixTimestamp + BigInt(seconds),
    ),
  );
}

function airdrop(ctx: ProgramTestContext, pubkey: PublicKey): void {
  ctx.setAccount(pubkey, {
    lamports: 10_000_000_000,
    data: Buffer.alloc(0),
    owner: SystemProgram.programId,
    executable: false,
  });
}

describe.skipIf(!hasIdl)('loss socialisation across stakers', () => {
  let context: ProgramTestContext;
  let banks: BanksClient;
  let provider: BankrunProvider;
  let program: Program;

  const admin = Keypair.generate();
  const oracle = Keypair.generate();
  const holder = Keypair.generate();
  const stakerA = Keypair.generate();
  const stakerB = Keypair.generate();
  const agent = Keypair.generate();
  const usdcMint = Keypair.generate();

  let vaultAta: PublicKey;
  let holderAta: PublicKey;
  let aAta: PublicKey;
  let bAta: PublicKey;
  let policyId: BN;

  const STAKE_EACH = 10_000;
  const COVERAGE = 10_000;
  /** Paid out on the claim, so the vault takes a real loss. */
  const PAYOUT = 6_000;

  const ata = (owner: PublicKey, off = false) =>
    getAssociatedTokenAddressSync(usdcMint.publicKey, owner, off);

  beforeAll(async () => {
    context = await startAnchor(resolve(__dirname, '..'), [], []);
    banks = context.banksClient;
    provider = new BankrunProvider(context);
    program = new Program(
      JSON.parse(readFileSync(IDL_PATH, 'utf-8')) as Idl,
      provider as unknown as AnchorProvider,
    );

    for (const kp of [admin, oracle, holder, stakerA, stakerB]) airdrop(context, kp.publicKey);

    const lamports = await getMinimumBalanceForRentExemptMint(provider.connection as any);
    const mintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: usdcMint.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        usdcMint.publicKey,
        USDC_DECIMALS,
        admin.publicKey,
        admin.publicKey,
      ),
    );
    mintTx.recentBlockhash = (await banks.getLatestBlockhash())[0];
    mintTx.feePayer = admin.publicKey;
    mintTx.sign(admin, usdcMint);
    await banks.processTransaction(mintTx);

    const [vault] = vaultPda();
    vaultAta = ata(vault, true);
    holderAta = ata(holder.publicKey);
    aAta = ata(stakerA.publicKey);
    bAta = ata(stakerB.publicKey);

    const fundTx = new Transaction();
    for (const [owner, addr] of [
      [holder.publicKey, holderAta],
      [stakerA.publicKey, aAta],
      [stakerB.publicKey, bAta],
    ] as const) {
      fundTx.add(
        createAssociatedTokenAccountInstruction(admin.publicKey, addr, owner, usdcMint.publicKey),
        createMintToInstruction(
          usdcMint.publicKey,
          addr,
          admin.publicKey,
          100_000n * 10n ** BigInt(USDC_DECIMALS),
        ),
      );
    }
    fundTx.recentBlockhash = (await banks.getLatestBlockhash())[0];
    fundTx.feePayer = admin.publicKey;
    fundTx.sign(admin);
    await banks.processTransaction(fundTx);

    const [config] = configPda();
    await program.methods
      .initialize(oracle.publicKey)
      .accountsPartial({
        admin: admin.publicKey,
        config,
        vault,
        usdcMint: usdcMint.publicKey,
        vaultTokenAccount: vaultAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([admin])
      .rpc();

    for (const [kp, kpAta] of [
      [stakerA, aAta],
      [stakerB, bAta],
    ] as const) {
      await program.methods
        .stake(usdc(STAKE_EACH))
        .accountsPartial({
          staker: kp.publicKey,
          config,
          vault,
          stakerPosition: stakerPda(kp.publicKey)[0],
          stakerTokenAccount: kpAta,
          vaultTokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([kp])
        .rpc();
    }

    await program.methods
      .upsertAttestation(agent.publicKey, 0, new BN(3600))
      .accountsPartial({
        oracle: oracle.publicKey,
        config,
        attestation: attestationPda(agent.publicKey)[0],
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([oracle])
      .rpc();

    const cfg: any = await (program.account as any).protocolConfig.fetch(config);
    policyId = cfg.policyCounter as BN;

    await program.methods
      .createPolicy(usdc(COVERAGE), new BN(3600), agent.publicKey)
      .accountsPartial({
        holder: holder.publicKey,
        config,
        vault,
        policy: policyPda(holder.publicKey, policyId)[0],
        attestation: attestationPda(agent.publicKey)[0],
        holderTokenAccount: holderAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([holder])
      .rpc();
  });

  const fetchVault = async () =>
    (program.account as any).insuranceVault.fetch(vaultPda()[0]) as Promise<any>;

  const unstakeAll = async (kp: Keypair, kpAta: PublicKey): Promise<bigint> => {
    const [vault] = vaultPda();
    const position = stakerPda(kp.publicKey)[0];
    await program.methods
      .requestUnstake()
      .accountsPartial({ staker: kp.publicKey, stakerPosition: position } as any)
      .signers([kp])
      .rpc();
    await advanceClockBySeconds(context, 48 * 3600 + 1);
    const before = await getAccount(provider.connection as any, kpAta);
    await program.methods
      .executeUnstake()
      .accountsPartial({
        staker: kp.publicKey,
        stakerPosition: position,
        vault,
        vaultTokenAccount: vaultAta,
        stakerTokenAccount: kpAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([kp])
      .rpc();
    const after = await getAccount(provider.connection as any, kpAta);
    return after.amount - before.amount;
  };

  it('starts with a whole loss index and both stakes recorded', async () => {
    const v = await fetchVault();
    expect(v.lossIndex.toString()).toBe((10n ** 12n).toString());
    expect(v.totalStaked.toString()).toBe(usdc(STAKE_EACH * 2).toString());
  });

  it('drops the loss index in step with the pool when a claim is paid', async () => {
    const [config] = configPda();
    const [vault] = vaultPda();
    const policy = policyPda(holder.publicKey, policyId)[0];

    await program.methods
      .oracleSubmitClaim(1, Buffer.alloc(64, 7)) // TRIGGER_EXPLOIT
      .accountsPartial({ oracle: oracle.publicKey, config, policy } as any)
      .signers([oracle])
      .rpc();

    // Past the exploit lock period.
    await advanceClockBySeconds(context, 3601);

    const before = await fetchVault();
    await program.methods
      .verifyAndPayout(usdc(PAYOUT))
      .accountsPartial({
        oracle: oracle.publicKey,
        config,
        policy,
        vault,
        vaultTokenAccount: vaultAta,
        holderTokenAccount: holderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([oracle])
      .rpc();
    const after = await fetchVault();

    const stakedBefore = BigInt(before.totalStaked.toString());
    const stakedAfter = BigInt(after.totalStaked.toString());
    expect(stakedAfter).toBeLessThan(stakedBefore);

    // The index falls by exactly the factor the pool did. This is the link
    // that did not exist: total_staked moved on its own before.
    const expectedIndex = (BigInt(before.lossIndex.toString()) * stakedAfter) / stakedBefore;
    expect(BigInt(after.lossIndex.toString())).toBe(expectedIndex);
    expect(BigInt(after.lossIndex.toString())).toBeLessThan(10n ** 12n);
  });

  it('charges both stakers the same share, and neither is made whole', async () => {
    const v = await fetchVault();
    const staked = BigInt(v.totalStaked.toString());

    const gotA = await unstakeAll(stakerA, aAta);
    const gotB = await unstakeAll(stakerB, bAta);

    // Neither walks away with the principal they put in — that was the bug.
    const deposited = BigInt(usdc(STAKE_EACH).toString());
    expect(gotA).toBeLessThan(deposited);
    expect(gotB).toBeLessThan(deposited);

    // Equal stakes, equal loss. A unit of rounding is allowed; a first-mover
    // advantage is not.
    const gap = gotA > gotB ? gotA - gotB : gotB - gotA;
    expect(gap).toBeLessThanOrEqual(2n);

    // And the two together never draw more principal than the vault held.
    // Rewards ride on top of principal, so bound rather than equate.
    const principalOut = gotA + gotB;
    expect(principalOut).toBeGreaterThan(staked - BigInt(usdc(1).toString()));
    expect(principalOut).toBeLessThan(staked + BigInt(usdc(1).toString()));
  });

  it('leaves at most rounding dust behind, never a shortfall', async () => {
    const v = await fetchVault();
    expect(Number(v.stakerCount)).toBe(0);

    // Revaluing a position rounds down, so the last stakers out can leave a
    // few units of principal in the vault. That direction is deliberate: the
    // alternative rounds *up* and pays out principal the vault does not hold,
    // which is the failure this whole mechanism exists to prevent. Bounded at
    // one unit per staker.
    const dust = BigInt(v.totalStaked.toString());
    expect(dust).toBeLessThanOrEqual(2n);
  });
});

/**
 * Migrating accounts written by the previous layout.
 *
 * `loss_index` and `loss_index_snapshot` were appended as the final field of
 * their structs precisely so this is a resize plus one default rather than a
 * rewrite. The account is truncated here by exactly those 16 bytes, which is
 * byte-for-byte what the old layout produced, and then migrated.
 *
 * The instructions take `UncheckedAccount` because they have to: `Account<T>`
 * deserializes during `try_accounts`, so a short account fails before any
 * constraint — including a realloc — could run.
 */
describe.skipIf(!hasIdl)('migration from the pre-loss-index layout', () => {
  let context: ProgramTestContext;
  let banks: BanksClient;
  let provider: BankrunProvider;
  let program: Program;

  const admin = Keypair.generate();
  const oracle = Keypair.generate();
  const staker = Keypair.generate();
  const usdcMint = Keypair.generate();
  let vaultAta: PublicKey;
  let stakerAta: PublicKey;

  const SCALE = 1_000_000_000_000n;

  beforeAll(async () => {
    context = await startAnchor(resolve(__dirname, '..'), [], []);
    banks = context.banksClient;
    provider = new BankrunProvider(context);
    program = new Program(
      JSON.parse(readFileSync(IDL_PATH, 'utf-8')) as Idl,
      provider as unknown as AnchorProvider,
    );
    for (const kp of [admin, oracle, staker]) airdrop(context, kp.publicKey);

    const lamports = await getMinimumBalanceForRentExemptMint(provider.connection as any);
    const mintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: usdcMint.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        usdcMint.publicKey,
        USDC_DECIMALS,
        admin.publicKey,
        admin.publicKey,
      ),
    );
    mintTx.recentBlockhash = (await banks.getLatestBlockhash())[0];
    mintTx.feePayer = admin.publicKey;
    mintTx.sign(admin, usdcMint);
    await banks.processTransaction(mintTx);

    const [vault] = vaultPda();
    vaultAta = getAssociatedTokenAddressSync(usdcMint.publicKey, vault, true);
    stakerAta = getAssociatedTokenAddressSync(usdcMint.publicKey, staker.publicKey);

    const fundTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        stakerAta,
        staker.publicKey,
        usdcMint.publicKey,
      ),
      createMintToInstruction(
        usdcMint.publicKey,
        stakerAta,
        admin.publicKey,
        50_000n * 10n ** BigInt(USDC_DECIMALS),
      ),
    );
    fundTx.recentBlockhash = (await banks.getLatestBlockhash())[0];
    fundTx.feePayer = admin.publicKey;
    fundTx.sign(admin);
    await banks.processTransaction(fundTx);

    const [config] = configPda();
    await program.methods
      .initialize(oracle.publicKey)
      .accountsPartial({
        admin: admin.publicKey,
        config,
        vault,
        usdcMint: usdcMint.publicKey,
        vaultTokenAccount: vaultAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([admin])
      .rpc();

    await program.methods
      .stake(usdc(1_000))
      .accountsPartial({
        staker: staker.publicKey,
        config,
        vault,
        stakerPosition: stakerPda(staker.publicKey)[0],
        stakerTokenAccount: stakerAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([staker])
      .rpc();
  });

  /** Drop the trailing 16 bytes — exactly what the old layout wrote. */
  const truncate = async (pubkey: PublicKey): Promise<number> => {
    const acct = await banks.getAccount(pubkey);
    if (!acct) throw new Error('account missing');
    const shortened = Buffer.from(acct.data).subarray(0, acct.data.length - 16);
    context.setAccount(pubkey, {
      lamports: acct.lamports,
      data: shortened,
      owner: acct.owner,
      executable: acct.executable,
    });
    return acct.data.length;
  };

  it('grows a truncated vault and seeds the index whole', async () => {
    const [vault] = vaultPda();
    const fullLen = await truncate(vault);

    const short = await banks.getAccount(vault);
    expect(short!.data.length).toBe(fullLen - 16);

    await program.methods
      .migrateVault()
      .accountsPartial({
        payer: admin.publicKey,
        vault,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([admin])
      .rpc();

    const grown = await banks.getAccount(vault);
    expect(grown!.data.length).toBe(fullLen);

    // Readable as the current layout again, with a whole index.
    const v: any = await (program.account as any).insuranceVault.fetch(vault);
    expect(BigInt(v.lossIndex.toString())).toBe(SCALE);
    // And nothing before the appended field moved.
    expect(v.totalStaked.toString()).toBe(usdc(1_000).toString());
  });

  it('is idempotent — a second call changes nothing', async () => {
    const [vault] = vaultPda();

    // Advance a slot first. This call is byte-identical to the one in the
    // previous test, so without a fresh blockhash the two transactions
    // serialize to the same signature and the second is rejected as
    // already-processed — which surfaces as an opaque bankrun error and looks
    // exactly like a program failure. The same hazard `advanceClockBySeconds`
    // documents; it made this test fail about one run in three.
    await advanceClockBySeconds(context, 1);

    const before = await banks.getAccount(vault);

    await program.methods
      .migrateVault()
      .accountsPartial({
        payer: admin.publicKey,
        vault,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([admin])
      .rpc();

    const after = await banks.getAccount(vault);
    expect(after!.data.length).toBe(before!.data.length);
    expect(Buffer.from(after!.data).equals(Buffer.from(before!.data))).toBe(true);
  });

  it('grows a truncated staker position, leaving the snapshot to be adopted', async () => {
    const position = stakerPda(staker.publicKey)[0];
    const fullLen = await truncate(position);

    await program.methods
      .migrateStakerPosition()
      .accountsPartial({
        payer: admin.publicKey,
        stakerPosition: position,
        staker: staker.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([admin])
      .rpc();

    const grown = await banks.getAccount(position);
    expect(grown!.data.length).toBe(fullLen);

    // Zero is the "not yet initialised" value settle_losses adopts from, so a
    // migrated position needs no value written and is not charged past losses.
    const pos: any = await (program.account as any).stakerPosition.fetch(position);
    expect(pos.lossIndexSnapshot.toString()).toBe('0');
    expect(pos.amountStaked.toString()).toBe(usdc(1_000).toString());
  });

  it('adopts the current index the next time the position is touched', async () => {
    const [config] = configPda();
    const [vault] = vaultPda();
    const position = stakerPda(staker.publicKey)[0];

    await program.methods
      .stake(usdc(1))
      .accountsPartial({
        staker: staker.publicKey,
        config,
        vault,
        stakerPosition: position,
        stakerTokenAccount: stakerAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([staker])
      .rpc();

    const pos: any = await (program.account as any).stakerPosition.fetch(position);
    expect(BigInt(pos.lossIndexSnapshot.toString())).toBe(SCALE);
    expect(pos.amountStaked.toString()).toBe(usdc(1_001).toString());
  });

  it('refuses an account at the right address with the wrong discriminator', async () => {
    const position = stakerPda(staker.publicKey)[0];
    const real = await banks.getAccount(position);

    // Same PDA, so the seeds constraint passes and the hand-rolled
    // discriminator check is what has to catch this. That check exists because
    // `UncheckedAccount` gives up the one guarantee `Account<T>` provides, and
    // this is the test that it was actually replaced rather than dropped.
    // Truncated *and* corrupted: if the guard failed open, the account would
    // come back grown, which is what the assertion below rules out.
    const corrupted = Buffer.from(real!.data).subarray(0, real!.data.length - 16);
    corrupted.fill(0xab, 0, 8);
    context.setAccount(position, {
      lamports: real!.lamports,
      data: corrupted,
      owner: real!.owner,
      executable: real!.executable,
    });

    await expect(
      program.methods
        .migrateStakerPosition()
        .accountsPartial({
          payer: admin.publicKey,
          stakerPosition: position,
          staker: staker.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([admin])
        .rpc(),
    ).rejects.toThrow();

    // The behavioural half: it was refused before any resize. The program log
    // for this case reads `InvalidAccountForMigration`.
    const after = await banks.getAccount(position);
    expect(after!.data.length).toBe(real!.data.length - 16);

    // Put it back so the suite leaves nothing corrupted behind.
    context.setAccount(position, {
      lamports: real!.lamports,
      data: Buffer.from(real!.data),
      owner: real!.owner,
      executable: real!.executable,
    });
  });
});
