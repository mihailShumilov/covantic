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
 * The solvency floor on the way out of the vault.
 *
 * `create_policy` refuses to write new coverage below `SOLVENCY_CRITICAL`
 * (5000 bps = 0.5x). Until this landed, `execute_unstake` enforced nothing:
 * the ladder bound issuance while the capital backing policies already sold
 * could withdraw to zero, leaving holders with live cover and an empty vault.
 * Fractional backing is correct for insurance — a fraction of zero is not.
 *
 * This suite runs its own bankrun context rather than joining the main
 * integration file, because the property under test is arithmetic about vault
 * totals and it needs a vault whose numbers are known exactly.
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

describe.skipIf(!hasIdl)('unstake — solvency floor', () => {
  let context: ProgramTestContext;
  let banks: BanksClient;
  let provider: BankrunProvider;
  let program: Program;

  const admin = Keypair.generate();
  const oracle = Keypair.generate();
  const holder = Keypair.generate();
  const staker = Keypair.generate();
  const agent = Keypair.generate();
  const usdcMint = Keypair.generate();

  let vaultAta: PublicKey;
  let holderAta: PublicKey;
  let stakerAta: PublicKey;
  let policyId: BN;

  // 10,000 staked against 10,000 of coverage = ratio 10000 (1.0x).
  const STAKED = 10_000;
  const COVERAGE = 10_000;

  beforeAll(async () => {
    context = await startAnchor(resolve(__dirname, '..'), [], []);
    banks = context.banksClient;
    provider = new BankrunProvider(context);
    program = new Program(
      JSON.parse(readFileSync(IDL_PATH, 'utf-8')) as Idl,
      provider as unknown as AnchorProvider,
    );

    for (const kp of [admin, oracle, holder, staker]) airdrop(context, kp.publicKey);

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
    holderAta = getAssociatedTokenAddressSync(usdcMint.publicKey, holder.publicKey);
    stakerAta = getAssociatedTokenAddressSync(usdcMint.publicKey, staker.publicKey);

    const fundTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        holderAta,
        holder.publicKey,
        usdcMint.publicKey,
      ),
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        stakerAta,
        staker.publicKey,
        usdcMint.publicKey,
      ),
      createMintToInstruction(
        usdcMint.publicKey,
        holderAta,
        admin.publicKey,
        100_000n * 10n ** BigInt(USDC_DECIMALS),
      ),
      createMintToInstruction(
        usdcMint.publicKey,
        stakerAta,
        admin.publicKey,
        100_000n * 10n ** BigInt(USDC_DECIMALS),
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
      .stake(usdc(STAKED))
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

    // A one-hour policy, so it can be expired later without waiting 30 days.
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

  const fetchVault = async () => {
    const [vault] = vaultPda();
    return (program.account as any).insuranceVault.fetch(vault) as Promise<any>;
  };
  const fetchPosition = async () =>
    (program.account as any).stakerPosition.fetch(stakerPda(staker.publicKey)[0]) as Promise<any>;

  const executeUnstake = async () => {
    const [vault] = vaultPda();
    return program.methods
      .executeUnstake()
      .accountsPartial({
        staker: staker.publicKey,
        stakerPosition: stakerPda(staker.publicKey)[0],
        vault,
        vaultTokenAccount: vaultAta,
        stakerTokenAccount: stakerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([staker])
      .rpc();
  };

  it('starts with coverage fully backed', async () => {
    const v = await fetchVault();
    expect(v.totalStaked.toString()).toBe(usdc(STAKED).toString());
    expect(v.totalCoverage.toString()).toBe(usdc(COVERAGE).toString());
    expect(Number(v.solvencyRatio)).toBe(10000);
  });

  it('caps the withdrawal at the floor instead of draining the vault', async () => {
    await program.methods
      .requestUnstake()
      .accountsPartial({
        staker: staker.publicKey,
        stakerPosition: stakerPda(staker.publicKey)[0],
      } as any)
      .signers([staker])
      .rpc();

    await advanceClockBySeconds(context, 48 * 3600 + 1);

    const before = await getAccount(provider.connection as any, stakerAta);
    const vBefore = await fetchVault();
    await executeUnstake();
    const after = await getAccount(provider.connection as any, stakerAta);
    const vAfter = await fetchVault();

    // Reserve = coverage * 5000 / 10000 = half. The staker may take the rest.
    const coverage = BigInt(usdc(COVERAGE).toString());
    const reserve = (coverage * SOLVENCY_CRITICAL) / 10_000n;
    const expected = BigInt(usdc(STAKED).toString()) - reserve;

    // Principal released is exact — that is the quantity the floor governs.
    expect(
      BigInt(vBefore.totalStaked.toString()) - BigInt(vAfter.totalStaked.toString()),
    ).toBe(expected);

    // The transfer carries accrued rewards on top of principal. Rewards are
    // the staker's share of premiums, not backing capital: `solvency_ratio`
    // is computed from `total_staked`, so paying them cannot move the ratio
    // and the floor does not gate them. Bounded here to keep the assertion
    // honest about which of the two is being checked.
    const received = after.amount - before.amount;
    expect(received).toBeGreaterThanOrEqual(expected);
    expect(received - expected).toBeLessThan(BigInt(usdc(1).toString()));

    // The vault is left sitting exactly on the floor, not through it.
    expect(BigInt(vAfter.totalStaked.toString())).toBe(reserve);
    expect(Number(vAfter.solvencyRatio)).toBe(Number(SOLVENCY_CRITICAL));
  });

  it('keeps the request open so the rest can be drawn without a second cooldown', async () => {
    const pos = await fetchPosition();
    // The remainder is still staked, and still counted as one staker.
    expect(pos.amountStaked.toString()).not.toBe('0');
    expect(Number(pos.unstakeRequestedAt.toString())).toBeGreaterThan(0);

    const v = await fetchVault();
    expect(Number(v.stakerCount)).toBe(1);
  });

  it('refuses to go below the floor a second time', async () => {
    // Nothing is free while the coverage stands, so there is nothing to pay.
    await expect(executeUnstake()).rejects.toThrow();
  });

  it('releases the remainder once the coverage it backed has expired', async () => {
    const [vault] = vaultPda();
    await advanceClockBySeconds(context, 3601);

    await program.methods
      .expirePolicy()
      .accountsPartial({
        cranker: admin.publicKey,
        policy: policyPda(holder.publicKey, policyId)[0],
        vault,
      } as any)
      .signers([admin])
      .rpc();

    const drained = await fetchVault();
    expect(drained.totalCoverage.toString()).toBe('0');

    // Self-healing is the point: no new cooldown, no admin action. Coverage
    // expiring lifts the ratio, and the staker draws what the floor held back.
    const before = await getAccount(provider.connection as any, stakerAta);
    await executeUnstake();
    const after = await getAccount(provider.connection as any, stakerAta);

    const coverage = BigInt(usdc(COVERAGE).toString());
    const reserve = (coverage * SOLVENCY_CRITICAL) / 10_000n;
    expect(after.amount - before.amount).toBeGreaterThanOrEqual(reserve);

    const pos = await fetchPosition();
    expect(pos.amountStaked.toString()).toBe('0');
    expect(Number(pos.unstakeRequestedAt.toString())).toBe(0);

    const v = await fetchVault();
    expect(v.totalStaked.toString()).toBe('0');
    expect(Number(v.stakerCount)).toBe(0);
  });
});
