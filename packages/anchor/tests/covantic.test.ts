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
import { startAnchor, type ProgramTestContext, type BanksClient } from 'solana-bankrun';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const IDL_PATH_EAGER = resolve(__dirname, '../target/idl/covantic.json');
const _PROGRAM_ID_FROM_IDL: string = existsSync(IDL_PATH_EAGER)
  ? (JSON.parse(readFileSync(IDL_PATH_EAGER, 'utf-8')) as { address?: string })
      .address ?? '52KrSMg3rsbtRw3FchxJ9jRwRzQmWcDzg1AiiHHHXz1D'
  : '52KrSMg3rsbtRw3FchxJ9jRwRzQmWcDzg1AiiHHHXz1D';
const PROGRAM_ID = new PublicKey(_PROGRAM_ID_FROM_IDL);

const CONFIG_SEED = Buffer.from('covantic_config');
const VAULT_SEED = Buffer.from('covantic_vault');
const POLICY_SEED = Buffer.from('covantic_policy');
const STAKER_SEED = Buffer.from('covantic_staker');

const USDC_DECIMALS = 6;
const usdc = (amount: number) => new BN(amount * 10 ** USDC_DECIMALS);

const IDL_PATH = resolve(__dirname, '../target/idl/covantic.json');
const hasIdl = existsSync(IDL_PATH);
const loadIdl = (): Idl =>
  JSON.parse(readFileSync(IDL_PATH, 'utf-8')) as Idl;

function u64LeBytes(value: BN): Buffer {
  const buf = Buffer.alloc(8);
  const bytes = value.toArrayLike(Buffer, 'le', 8);
  bytes.copy(buf);
  return buf;
}

function policyPda(holder: PublicKey, policyId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POLICY_SEED, holder.toBuffer(), u64LeBytes(policyId)],
    PROGRAM_ID,
  );
}

function stakerPda(staker: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [STAKER_SEED, staker.toBuffer()],
    PROGRAM_ID,
  );
}

function configPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
}

function vaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED], PROGRAM_ID);
}

async function advanceClockBySeconds(
  context: ProgramTestContext,
  seconds: number,
): Promise<void> {
  const currentClock = await context.banksClient.getClock();
  const newTimestamp = currentClock.unixTimestamp + BigInt(seconds);
  context.setClock({
    ...currentClock,
    unixTimestamp: newTimestamp,
  } as any);
}

async function airdropSol(
  context: ProgramTestContext,
  pubkey: PublicKey,
  lamports = 10_000_000_000,
): Promise<void> {
  const account = await context.banksClient.getAccount(pubkey);
  const current = account?.lamports ?? 0n;
  context.setAccount(pubkey, {
    lamports: Number(current) + lamports,
    data: Buffer.alloc(0),
    owner: SystemProgram.programId,
    executable: false,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasIdl)('Covantic — Anchor integration', () => {
  let context: ProgramTestContext;
  let banks: BanksClient;
  let provider: BankrunProvider;
  let program: Program<Idl>;

  const admin = Keypair.generate();
  const oracle = Keypair.generate();
  const holder = Keypair.generate();
  const staker = Keypair.generate();
  const staker2 = Keypair.generate();
  const agentWallet = Keypair.generate();
  const usdcMint = Keypair.generate();
  const strangerOracle = Keypair.generate();

  let holderAta: PublicKey;
  let stakerAta: PublicKey;
  let staker2Ata: PublicKey;
  let vaultAta: PublicKey;

  beforeAll(async () => {
    context = await startAnchor(resolve(__dirname, '..'), [], []);
    banks = context.banksClient;
    provider = new BankrunProvider(context);
    const idl = loadIdl();
    program = new Program(idl, provider as unknown as AnchorProvider);

    // Fund SOL for all signers
    for (const kp of [admin, oracle, holder, staker, staker2, strangerOracle]) {
      await airdropSol(context, kp.publicKey);
    }

    // Create USDC mint
    const lamports = await getMinimumBalanceForRentExemptMint(
      provider.connection as any,
    );
    const createMintTx = new Transaction().add(
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
        null,
        TOKEN_PROGRAM_ID,
      ),
    );
    createMintTx.recentBlockhash = (await banks.getLatestBlockhash())[0];
    createMintTx.feePayer = admin.publicKey;
    createMintTx.sign(admin, usdcMint);
    await banks.processTransaction(createMintTx);

    // Derive ATAs
    const [vault] = vaultPda();
    vaultAta = getAssociatedTokenAddressSync(usdcMint.publicKey, vault, true);
    holderAta = getAssociatedTokenAddressSync(
      usdcMint.publicKey,
      holder.publicKey,
    );
    stakerAta = getAssociatedTokenAddressSync(
      usdcMint.publicKey,
      staker.publicKey,
    );
    staker2Ata = getAssociatedTokenAddressSync(
      usdcMint.publicKey,
      staker2.publicKey,
    );

    // Create holder + staker ATAs and mint USDC to them
    const setupTx = new Transaction().add(
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
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        staker2Ata,
        staker2.publicKey,
        usdcMint.publicKey,
      ),
      createMintToInstruction(
        usdcMint.publicKey,
        holderAta,
        admin.publicKey,
        10_000n * 10n ** BigInt(USDC_DECIMALS),
      ),
      createMintToInstruction(
        usdcMint.publicKey,
        stakerAta,
        admin.publicKey,
        50_000n * 10n ** BigInt(USDC_DECIMALS),
      ),
      createMintToInstruction(
        usdcMint.publicKey,
        staker2Ata,
        admin.publicKey,
        50_000n * 10n ** BigInt(USDC_DECIMALS),
      ),
    );
    setupTx.recentBlockhash = (await banks.getLatestBlockhash())[0];
    setupTx.feePayer = admin.publicKey;
    setupTx.sign(admin);
    await banks.processTransaction(setupTx);
  });

  // -------------------------------------------------------------------------
  // 1.1 Initialize
  // -------------------------------------------------------------------------
  it('initializes protocol config and vault', async () => {
    const [config] = configPda();
    const [vault] = vaultPda();

    await program.methods
      .initialize(oracle.publicKey)
      .accounts({
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

    const cfg: any = await (program.account as any).protocolConfig.fetch(config);
    expect(cfg.oracleAuthority.toBase58()).toBe(oracle.publicKey.toBase58());
    expect(cfg.usdcMint.toBase58()).toBe(usdcMint.publicKey.toBase58());
    expect(cfg.paused).toBe(false);
    expect(cfg.policyCounter.toString()).toBe('0');

    const v: any = await (program.account as any).insuranceVault.fetch(vault);
    expect(v.totalStaked.toString()).toBe('0');
    expect(v.totalCoverage.toString()).toBe('0');
    expect(v.solvencyRatio).toBe(0xffff);
  });

  // -------------------------------------------------------------------------
  // 1.2 Stake
  // -------------------------------------------------------------------------
  it('stakes 10,000 USDC and updates vault', async () => {
    const [config] = configPda();
    const [vault] = vaultPda();
    const [position] = stakerPda(staker.publicKey);

    await program.methods
      .stake(usdc(10_000))
      .accounts({
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
    expect(pos.amountStaked.toString()).toBe(usdc(10_000).toString());

    const v: any = await (program.account as any).insuranceVault.fetch(vault);
    expect(v.totalStaked.toString()).toBe(usdc(10_000).toString());
    expect(v.stakerCount).toBe(1);

    const vaultBal = await getAccount(provider.connection as any, vaultAta);
    expect(vaultBal.amount).toBe(10_000n * 10n ** BigInt(USDC_DECIMALS));
  });

  // -------------------------------------------------------------------------
  // 1.3 Create policy
  // -------------------------------------------------------------------------
  let firstPolicyId: BN;
  it('creates a policy and splits premium 70/20/10', async () => {
    const [config] = configPda();
    const [vault] = vaultPda();

    const cfgBefore: any = await (program.account as any).protocolConfig.fetch(config);
    firstPolicyId = cfgBefore.policyCounter as BN;
    const [policy] = policyPda(holder.publicKey, firstPolicyId);

    const vaultBefore: any = await (program.account as any).insuranceVault.fetch(vault);
    const holderBefore = await getAccount(provider.connection as any, holderAta);

    await program.methods
      .createPolicy(
        usdc(100),
        new BN(86400),
        0,
        agentWallet.publicKey,
      )
      .accounts({
        holder: holder.publicKey,
        config,
        vault,
        policy,
        holderTokenAccount: holderAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([holder])
      .rpc();

    const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
    expect(pol.holder.toBase58()).toBe(holder.publicKey.toBase58());
    expect(pol.agentAddress.toBase58()).toBe(agentWallet.publicKey.toBase58());
    expect(pol.coverageAmount.toString()).toBe(usdc(100).toString());
    expect(pol.state).toBe(0);
    expect(pol.riskTier).toBe(0);

    const vaultAfter: any = await (program.account as any).insuranceVault.fetch(vault);
    expect(vaultAfter.totalCoverage.toString()).toBe(usdc(100).toString());
    const premium = BigInt(pol.premiumPaid.toString());
    expect(premium).toBeGreaterThan(0n);

    // 70/20/10 split (reconstruct)
    const staker70 = (premium * 7000n) / 10000n;
    const reserve20 = (premium * 2000n) / 10000n;
    const protocol10 = premium - staker70 - reserve20;
    expect(
      BigInt(vaultAfter.totalStakerRewards.toString()) -
        BigInt(vaultBefore.totalStakerRewards.toString()),
    ).toBe(staker70);
    expect(
      BigInt(vaultAfter.reserveFund.toString()) -
        BigInt(vaultBefore.reserveFund.toString()),
    ).toBe(reserve20);
    expect(
      BigInt(vaultAfter.protocolTreasury.toString()) -
        BigInt(vaultBefore.protocolTreasury.toString()),
    ).toBe(protocol10);

    const holderAfter = await getAccount(provider.connection as any, holderAta);
    expect(holderBefore.amount - holderAfter.amount).toBe(premium);
  });

  // -------------------------------------------------------------------------
  // 1.4 Submit claim
  // -------------------------------------------------------------------------
  it('submits a claim and transitions to ClaimPending', async () => {
    const [policy] = policyPda(holder.publicKey, firstPolicyId);
    const sig = Array.from({ length: 64 }, (_, i) => (i + 1) % 256);

    await program.methods
      .submitClaim(1, Buffer.from(sig))
      .accounts({ holder: holder.publicKey, policy } as any)
      .signers([holder])
      .rpc();

    const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
    expect(pol.state).toBe(1);
    expect(pol.triggerType).toBe(1);
    expect(Number(pol.claimSubmittedAt.toString())).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 1.5 Verify and payout — also exercises loss cascade
  // -------------------------------------------------------------------------
  it('verifies a claim, pays out, and cascades loss across treasury/reserve/stakers', async () => {
    const [config] = configPda();
    const [vault] = vaultPda();
    const [policy] = policyPda(holder.publicKey, firstPolicyId);

    const vaultBefore: any = await (program.account as any).insuranceVault.fetch(vault);
    const holderBefore = await getAccount(provider.connection as any, holderAta);
    const payout = usdc(80);

    await program.methods
      .verifyAndPayout(payout)
      .accounts({
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

    const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
    expect(pol.state).toBe(3);
    expect(pol.payoutAmount.toString()).toBe(payout.toString());

    const holderAfter = await getAccount(provider.connection as any, holderAta);
    expect(holderAfter.amount - holderBefore.amount).toBe(
      80n * 10n ** BigInt(USDC_DECIMALS),
    );

    const vaultAfter: any = await (program.account as any).insuranceVault.fetch(vault);
    expect(vaultAfter.totalClaimsPaid.toString()).toBe(payout.toString());

    // Loss cascade: protocol_treasury first, then reserve, then staked.
    const treasuryBefore = BigInt(vaultBefore.protocolTreasury.toString());
    const reserveBefore = BigInt(vaultBefore.reserveFund.toString());
    const stakedBefore = BigInt(vaultBefore.totalStaked.toString());
    const treasuryAfter = BigInt(vaultAfter.protocolTreasury.toString());
    const reserveAfter = BigInt(vaultAfter.reserveFund.toString());
    const stakedAfter = BigInt(vaultAfter.totalStaked.toString());

    const drained = treasuryBefore + reserveBefore + (stakedBefore - stakedAfter);
    expect(drained).toBeGreaterThanOrEqual(BigInt(payout.toString()) - 1n);
    expect(treasuryAfter).toBeLessThanOrEqual(treasuryBefore);
    expect(reserveAfter).toBeLessThanOrEqual(reserveBefore);
    // Cascade order: treasury must fully drain before reserve does,
    // and reserve must fully drain before staked does.
    if (reserveAfter < reserveBefore) {
      expect(treasuryAfter).toBe(0n);
    }
    if (stakedAfter < stakedBefore) {
      expect(treasuryAfter).toBe(0n);
      expect(reserveAfter).toBe(0n);
    }
  });

  // -------------------------------------------------------------------------
  // 1.6 Cancel policy (second policy)
  // -------------------------------------------------------------------------
  let secondPolicyId: BN;
  it('cancels a policy with partial refund', async () => {
    const [config] = configPda();
    const [vault] = vaultPda();
    const cfg: any = await (program.account as any).protocolConfig.fetch(config);
    secondPolicyId = cfg.policyCounter as BN;
    const [policy] = policyPda(holder.publicKey, secondPolicyId);

    await program.methods
      .createPolicy(usdc(50), new BN(86400), 0, agentWallet.publicKey)
      .accounts({
        holder: holder.publicKey,
        config,
        vault,
        policy,
        holderTokenAccount: holderAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([holder])
      .rpc();

    const holderBefore = await getAccount(provider.connection as any, holderAta);
    const vaultBefore: any = await (program.account as any).insuranceVault.fetch(vault);

    await program.methods
      .cancelPolicy()
      .accounts({
        holder: holder.publicKey,
        policy,
        vault,
        vaultTokenAccount: vaultAta,
        holderTokenAccount: holderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([holder])
      .rpc();

    const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
    expect(pol.state).toBe(5);

    const holderAfter = await getAccount(provider.connection as any, holderAta);
    expect(holderAfter.amount).toBeGreaterThanOrEqual(holderBefore.amount);

    const vaultAfter: any = await (program.account as any).insuranceVault.fetch(vault);
    expect(
      BigInt(vaultBefore.totalCoverage.toString()) -
        BigInt(vaultAfter.totalCoverage.toString()),
    ).toBe(50n * 10n ** BigInt(USDC_DECIMALS));
  });

  // -------------------------------------------------------------------------
  // 1.7 Expire policy
  // -------------------------------------------------------------------------
  it('expires a policy after duration elapses', async () => {
    const [config] = configPda();
    const [vault] = vaultPda();
    const cfg: any = await (program.account as any).protocolConfig.fetch(config);
    const policyId = cfg.policyCounter as BN;
    const [policy] = policyPda(holder.publicKey, policyId);

    await program.methods
      .createPolicy(usdc(20), new BN(3600), 0, agentWallet.publicKey)
      .accounts({
        holder: holder.publicKey,
        config,
        vault,
        policy,
        holderTokenAccount: holderAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([holder])
      .rpc();

    await advanceClockBySeconds(context, 3601);

    await program.methods
      .expirePolicy()
      .accounts({
        cranker: admin.publicKey,
        policy,
        vault,
      } as any)
      .signers([admin])
      .rpc();

    const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
    expect(pol.state).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 1.8 Request + execute unstake
  // -------------------------------------------------------------------------
  it('enforces 48h cooldown on unstake', async () => {
    const [vault] = vaultPda();
    const [position] = stakerPda(staker.publicKey);

    await program.methods
      .requestUnstake()
      .accounts({ staker: staker.publicKey, stakerPosition: position } as any)
      .signers([staker])
      .rpc();

    const pos: any = await (program.account as any).stakerPosition.fetch(position);
    expect(Number(pos.unstakeRequestedAt.toString())).toBeGreaterThan(0);

    // Immediate execute should fail
    await expect(
      program.methods
        .executeUnstake()
        .accounts({
          staker: staker.publicKey,
          stakerPosition: position,
          vault,
          vaultTokenAccount: vaultAta,
          stakerTokenAccount: stakerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([staker])
        .rpc(),
    ).rejects.toThrow();

    // Warp 48h + 1s and execute
    await advanceClockBySeconds(context, 48 * 3600 + 1);
    await program.methods
      .executeUnstake()
      .accounts({
        staker: staker.publicKey,
        stakerPosition: position,
        vault,
        vaultTokenAccount: vaultAta,
        stakerTokenAccount: stakerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([staker])
      .rpc();

    const posAfter: any = await (program.account as any).stakerPosition.fetch(position);
    expect(posAfter.amountStaked.toString()).toBe('0');
    const v: any = await (program.account as any).insuranceVault.fetch(vault);
    expect(v.stakerCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 1.9 Claim rewards (new staker + fresh policy)
  // -------------------------------------------------------------------------
  it('allows a staker to claim proportional rewards', async () => {
    const [config] = configPda();
    const [vault] = vaultPda();
    const [position2] = stakerPda(staker2.publicKey);

    await program.methods
      .stake(usdc(5_000))
      .accounts({
        staker: staker2.publicKey,
        config,
        vault,
        stakerPosition: position2,
        stakerTokenAccount: staker2Ata,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([staker2])
      .rpc();

    const cfg: any = await (program.account as any).protocolConfig.fetch(config);
    const policyId = cfg.policyCounter as BN;
    const [policy] = policyPda(holder.publicKey, policyId);
    await program.methods
      .createPolicy(usdc(100), new BN(86400 * 10), 2, agentWallet.publicKey)
      .accounts({
        holder: holder.publicKey,
        config,
        vault,
        policy,
        holderTokenAccount: holderAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([holder])
      .rpc();

    const vBefore: any = await (program.account as any).insuranceVault.fetch(vault);
    if (BigInt(vBefore.totalStakerRewards.toString()) === 0n) {
      return; // no rewards to claim — skip
    }

    await program.methods
      .claimRewards()
      .accounts({
        staker: staker2.publicKey,
        stakerPosition: position2,
        vault,
        vaultTokenAccount: vaultAta,
        stakerTokenAccount: staker2Ata,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([staker2])
      .rpc();

    const posAfter: any = await (program.account as any).stakerPosition.fetch(position2);
    expect(BigInt(posAfter.rewardsClaimed.toString())).toBeGreaterThan(0n);
  });

  // -------------------------------------------------------------------------
  // 1.10 Error cases
  // -------------------------------------------------------------------------
  describe('error cases', () => {
    it('rejects coverage below minimum', async () => {
      const [config] = configPda();
      const [vault] = vaultPda();
      const cfg: any = await (program.account as any).protocolConfig.fetch(config);
      const [policy] = policyPda(holder.publicKey, cfg.policyCounter as BN);

      await expect(
        program.methods
          .createPolicy(new BN(500_000), new BN(86400), 0, agentWallet.publicKey)
          .accounts({
            holder: holder.publicKey,
            config,
            vault,
            policy,
            holderTokenAccount: holderAta,
            vaultTokenAccount: vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([holder])
          .rpc(),
      ).rejects.toThrow(/CoverageTooLow|coverage/i);
    });

    it('rejects invalid risk tier', async () => {
      const [config] = configPda();
      const [vault] = vaultPda();
      const cfg: any = await (program.account as any).protocolConfig.fetch(config);
      const [policy] = policyPda(holder.publicKey, cfg.policyCounter as BN);

      await expect(
        program.methods
          .createPolicy(usdc(100), new BN(86400), 5, agentWallet.publicKey)
          .accounts({
            holder: holder.publicKey,
            config,
            vault,
            policy,
            holderTokenAccount: holderAta,
            vaultTokenAccount: vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([holder])
          .rpc(),
      ).rejects.toThrow(/InvalidRiskTier|risk/i);
    });

    it('rejects non-oracle verify_and_payout', async () => {
      // Create + submit a claim to have a pending one
      const [config] = configPda();
      const [vault] = vaultPda();
      const cfg: any = await (program.account as any).protocolConfig.fetch(config);
      const policyId = cfg.policyCounter as BN;
      const [policy] = policyPda(holder.publicKey, policyId);

      await program.methods
        .createPolicy(usdc(50), new BN(86400), 0, agentWallet.publicKey)
        .accounts({
          holder: holder.publicKey,
          config,
          vault,
          policy,
          holderTokenAccount: holderAta,
          vaultTokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([holder])
        .rpc();

      const sig = Array.from({ length: 64 }, () => 1);
      await program.methods
        .submitClaim(1, Buffer.from(sig))
        .accounts({ holder: holder.publicKey, policy } as any)
        .signers([holder])
        .rpc();

      await expect(
        program.methods
          .verifyAndPayout(usdc(10))
          .accounts({
            oracle: strangerOracle.publicKey,
            config,
            policy,
            vault,
            vaultTokenAccount: vaultAta,
            holderTokenAccount: holderAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([strangerOracle])
          .rpc(),
      ).rejects.toThrow(/UnauthorizedOracle|oracle/i);

      // Rejects payout > coverage using the real oracle
      await expect(
        program.methods
          .verifyAndPayout(usdc(500))
          .accounts({
            oracle: oracle.publicKey,
            config,
            policy,
            vault,
            vaultTokenAccount: vaultAta,
            holderTokenAccount: holderAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([oracle])
          .rpc(),
      ).rejects.toThrow(/PayoutExceedsCoverage|coverage/i);

      // Complete a real payout
      await program.methods
        .verifyAndPayout(usdc(10))
        .accounts({
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

      // Second submit_claim on the same (paid) policy must fail
      await expect(
        program.methods
          .submitClaim(1, Buffer.from(sig))
          .accounts({ holder: holder.publicKey, policy } as any)
          .signers([holder])
          .rpc(),
      ).rejects.toThrow(/PolicyNotActive|state|active/i);
    });
  });

  // -------------------------------------------------------------------------
  // Oracle-initiated claim flow (auto-claim pipeline)
  // -------------------------------------------------------------------------
  describe('oracle-initiated claim flow', () => {
    async function createFreshPolicy(): Promise<{ policy: PublicKey; policyId: BN }> {
      const [config] = configPda();
      const [vault] = vaultPda();
      const cfg: any = await (program.account as any).protocolConfig.fetch(config);
      const policyId = cfg.policyCounter as BN;
      const [policy] = policyPda(holder.publicKey, policyId);
      await program.methods
        .createPolicy(usdc(50), new BN(86400), 0, agentWallet.publicKey)
        .accounts({
          holder: holder.publicKey,
          config,
          vault,
          policy,
          holderTokenAccount: holderAta,
          vaultTokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([holder])
        .rpc();
      return { policy, policyId };
    }

    const trigSig = Array.from({ length: 64 }, (_, i) => (i + 7) % 256);

    it('lets the oracle submit a claim without holder signature', async () => {
      const { policy } = await createFreshPolicy();
      const [config] = configPda();

      await program.methods
        .oracleSubmitClaim(2, Buffer.from(trigSig))
        .accounts({ oracle: oracle.publicKey, config, policy } as any)
        .signers([oracle])
        .rpc();

      const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(pol.state).toBe(1);
      expect(pol.triggerType).toBe(2);
      expect(Number(pol.claimSubmittedAt.toString())).toBeGreaterThan(0);
    });

    it('rejects a non-oracle signer', async () => {
      const { policy } = await createFreshPolicy();
      const [config] = configPda();

      // bankrun flattens program errors into a generic string; we assert
      // the tx rejects and that state is unchanged.
      await expect(
        program.methods
          .oracleSubmitClaim(1, Buffer.from(trigSig))
          .accounts({ oracle: strangerOracle.publicKey, config, policy } as any)
          .signers([strangerOracle])
          .rpc(),
      ).rejects.toThrow();

      const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(pol.state).toBe(0);
    });

    it('rejects a non-active policy', async () => {
      const { policy } = await createFreshPolicy();
      const [config] = configPda();

      // First oracle submit succeeds and moves to ClaimPending
      await program.methods
        .oracleSubmitClaim(3, Buffer.from(trigSig))
        .accounts({ oracle: oracle.publicKey, config, policy } as any)
        .signers([oracle])
        .rpc();

      const polPending: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(polPending.state).toBe(1);

      // Second submit must fail because state != Active; state should stay ClaimPending.
      await expect(
        program.methods
          .oracleSubmitClaim(3, Buffer.from(trigSig))
          .accounts({ oracle: oracle.publicKey, config, policy } as any)
          .signers([oracle])
          .rpc(),
      ).rejects.toThrow();

      const polAfter: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(polAfter.state).toBe(1);
    });
  });
});

if (!hasIdl) {
  describe('Covantic — Anchor integration', () => {
    it.skip('IDL not found at target/idl/covantic.json; run `anchor build` before testing', () => {});
  });
}
