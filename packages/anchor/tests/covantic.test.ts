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
  createTransferInstruction,
  createSetAuthorityInstruction,
  createFreezeAccountInstruction,
  AuthorityType,
  getAssociatedTokenAddressSync,
  getAccount,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
} from '@solana/spl-token';
import { BankrunProvider } from 'anchor-bankrun';
import { Clock, startAnchor, type ProgramTestContext, type BanksClient } from 'solana-bankrun';

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
const ATTESTATION_SEED = Buffer.from('covantic_attestation');
const CHECKPOINT_SEED = Buffer.from('covantic_checkpoint');
const EXPLOIT_EVIDENCE_SEED = Buffer.from('covantic_exploit_evidence');
const GOVERNANCE_BASELINE_SEED = Buffer.from('covantic_gov_baseline');
const AUTHORITY_CHECKPOINT_SEED = Buffer.from('covantic_authority_checkpoint');
const GOVERNANCE_EVIDENCE_SEED = Buffer.from('covantic_gov_evidence');

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

function checkpointPda(policy: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CHECKPOINT_SEED, policy.toBuffer()], PROGRAM_ID);
}

function governanceBaselinePda(policy: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([GOVERNANCE_BASELINE_SEED, policy.toBuffer()], PROGRAM_ID);
}

function authorityCheckpointPda(policy: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [AUTHORITY_CHECKPOINT_SEED, policy.toBuffer()],
    PROGRAM_ID,
  );
}

function governanceEvidencePda(policy: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [GOVERNANCE_EVIDENCE_SEED, policy.toBuffer()],
    PROGRAM_ID,
  );
}

function exploitEvidencePda(policy: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [EXPLOIT_EVIDENCE_SEED, policy.toBuffer()],
    PROGRAM_ID,
  );
}

function attestationPda(agent: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([ATTESTATION_SEED, agent.toBuffer()], PROGRAM_ID);
}

function configPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
}

function vaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED], PROGRAM_ID);
}

async function advanceSlots(context: ProgramTestContext, slots: number): Promise<void> {
  const clock = await context.banksClient.getClock();
  context.warpToSlot(clock.slot + BigInt(slots));
}

async function advanceClockBySeconds(
  context: ProgramTestContext,
  seconds: number,
): Promise<void> {
  const current = await context.banksClient.getClock();
  // Advance the slot as well as the clock. Time passing means blocks passing,
  // and without a new blockhash two identical instructions serialize to the
  // same transaction — the second is then rejected as already-processed,
  // which looks exactly like a program error and is not one.
  context.warpToSlot(current.slot + 1n);
  const warped = await context.banksClient.getClock();
  // `setClock` takes a real `Clock` across the napi boundary — a spread of
  // the getters produces a plain object and fails to deserialize on the Rust
  // side ("Failed to recover `Clock` type from napi value").
  context.setClock(
    new Clock(
      warped.slot,
      warped.epochStartTimestamp,
      warped.epoch,
      warped.leaderScheduleEpoch,
      current.unixTimestamp + BigInt(seconds),
    ),
  );
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
        // Freeze authority, so the governance suite can exercise the one
        // takeover shape no value-based measurement can see: an account that
        // is still the agent's, still full, and no longer usable.
        admin.publicKey,
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


  /**
   * Publish an oracle-signed risk attestation for an agent.
   *
   * `create_policy` reads the tier from this PDA rather than accepting one
   * from the buyer — that is what closes the adverse-selection hole where a
   * holder could pick LOW for a HIGH-risk agent. Every policy therefore needs
   * a live attestation first.
   */
  async function ensureAttestation(agent: PublicKey, tier = 0): Promise<void> {
    const [config] = configPda();
    await program.methods
      .upsertAttestation(agent, tier, new BN(3600))
      .accountsPartial({
        oracle: oracle.publicKey,
        config,
        attestation: attestationPda(agent)[0],
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([oracle])
      .rpc();
  }

  // -------------------------------------------------------------------------
  // 1.1 Initialize
  // -------------------------------------------------------------------------
  it('initializes protocol config and vault', async () => {
    const [config] = configPda();
    const [vault] = vaultPda();

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
    await ensureAttestation(agentWallet.publicKey);
    const [config] = configPda();
    const [vault] = vaultPda();

    const cfgBefore: any = await (program.account as any).protocolConfig.fetch(config);
    firstPolicyId = cfgBefore.policyCounter as BN;
    const [policy] = policyPda(holder.publicKey, firstPolicyId);

    const vaultBefore: any = await (program.account as any).insuranceVault.fetch(vault);
    const holderBefore = await getAccount(provider.connection as any, holderAta);

    await ensureAttestation(agentWallet.publicKey);
    await program.methods
      .createPolicy(usdc(100), new BN(86400), agentWallet.publicKey)
      .accountsPartial({
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
      .accountsPartial({ holder: holder.publicKey, policy } as any)
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

    // Exploit claims carry a one-hour lock (`LOCK_EXPLOIT`), which is the
    // window an admin has to pause a compromised oracle before funds move.
    await advanceClockBySeconds(context, 3_601);

    await program.methods
      .verifyAndPayout(payout)
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

    const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
    expect(pol.state).toBe(2); // ClaimPaid
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

    await ensureAttestation(agentWallet.publicKey);
    await program.methods
      .createPolicy(usdc(50), new BN(86400), agentWallet.publicKey)
      .accountsPartial({
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
      .accountsPartial({
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
    expect(pol.state).toBe(4); // Cancelled

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

    await ensureAttestation(agentWallet.publicKey);
    await program.methods
      .createPolicy(usdc(20), new BN(3600), agentWallet.publicKey)
      .accountsPartial({
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
      .accountsPartial({
        cranker: admin.publicKey,
        policy,
        vault,
      } as any)
      .signers([admin])
      .rpc();

    const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
    expect(pol.state).toBe(3); // Expired
  });

  // -------------------------------------------------------------------------
  // 1.8 Request + execute unstake
  // -------------------------------------------------------------------------
  it('enforces 48h cooldown on unstake', async () => {
    const [position] = stakerPda(staker.publicKey);
    const [vault] = vaultPda();

    await program.methods
      .requestUnstake()
      .accountsPartial({ staker: staker.publicKey, stakerPosition: position } as any)
      .signers([staker])
      .rpc();

    const pos: any = await (program.account as any).stakerPosition.fetch(position);
    expect(Number(pos.unstakeRequestedAt.toString())).toBeGreaterThan(0);

    // Immediate execute must fail — the cooldown is the whole point.
    await expect(
      program.methods
        .executeUnstake()
        .accountsPartial({
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
  });

  /**
   * Known defect, pinned here rather than hidden.
   *
   * The loss cascade in every `verify_and_payout*` path decrements
   * `vault.total_staked`, but nothing decrements any `StakerPosition`. So a
   * socialised loss is not actually socialised: each position still records
   * its original principal, `execute_unstake` transfers that full amount, and
   * whoever withdraws first is paid in full while the last staker absorbs the
   * entire loss — or cannot withdraw at all, because the vault token account
   * is short and the transfer fails with an opaque SPL `InsufficientFunds`.
   *
   * This test asserts the *current* behaviour so the gap is visible and
   * measured. It is expected to start failing the day per-position loss
   * accounting lands, which is exactly the signal wanted.
   */
  it('cannot return full principal after a loss — staker positions carry no loss share', async () => {
    const [position] = stakerPda(staker.publicKey);
    const [vault] = vaultPda();

    await advanceClockBySeconds(context, 48 * 3600 + 1);

    const vaultState: any = await (program.account as any).insuranceVault.fetch(vault);
    const pos: any = await (program.account as any).stakerPosition.fetch(position);
    const vaultBalance = await getAccount(provider.connection as any, vaultAta);

    // The position still claims principal the vault no longer holds.
    expect(BigInt(pos.amountStaked.toString())).toBeGreaterThan(vaultBalance.amount);
    void vaultState;

    await expect(
      program.methods
        .executeUnstake()
        .accountsPartial({
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
      .accountsPartial({
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
    await ensureAttestation(agentWallet.publicKey);
    await program.methods
      .createPolicy(usdc(100), new BN(86400 * 10), agentWallet.publicKey)
      .accountsPartial({
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
      .accountsPartial({
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

      await ensureAttestation(agentWallet.publicKey);
      await expect(
        program.methods
          .createPolicy(new BN(500_000), new BN(86400), agentWallet.publicKey)
          .accountsPartial({
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
      ).rejects.toThrow();
    });

    it('rejects an uninsurable tier at the attestation, not the policy', async () => {
      // The tier stopped being a `create_policy` argument when attestations
      // landed — a buyer cannot select one at all now. The check that matters
      // moved to the oracle's own publish path.
      await expect(
        program.methods
          .upsertAttestation(agentWallet.publicKey, 5, new BN(3600))
          .accountsPartial({
            oracle: oracle.publicKey,
            config: configPda()[0],
            attestation: attestationPda(agentWallet.publicKey)[0],
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([oracle])
          .rpc(),
      ).rejects.toThrow();
    });

    it('rejects non-oracle verify_and_payout', async () => {
      // Create + submit a claim to have a pending one
      const [config] = configPda();
      const [vault] = vaultPda();
      const cfg: any = await (program.account as any).protocolConfig.fetch(config);
      const policyId = cfg.policyCounter as BN;
      const [policy] = policyPda(holder.publicKey, policyId);

      await ensureAttestation(agentWallet.publicKey);
      await program.methods
        .createPolicy(usdc(50), new BN(86400), agentWallet.publicKey)
        .accountsPartial({
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
        .accountsPartial({ holder: holder.publicKey, policy } as any)
        .signers([holder])
        .rpc();

      await expect(
        program.methods
          .verifyAndPayout(usdc(10))
          .accountsPartial({
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
      ).rejects.toThrow();

      // Rejects payout > coverage using the real oracle
      await expect(
        program.methods
          .verifyAndPayout(usdc(500))
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
          .rpc(),
      ).rejects.toThrow();

      // Complete a real payout, once the trigger's lock has elapsed.
      await advanceClockBySeconds(context, 3_601);
      await program.methods
        .verifyAndPayout(usdc(10))
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

      // Second submit_claim on the same (paid) policy must fail
      await expect(
        program.methods
          .submitClaim(1, Buffer.from(sig))
          .accountsPartial({ holder: holder.publicKey, policy } as any)
          .signers([holder])
          .rpc(),
      ).rejects.toThrow();
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
      await ensureAttestation(agentWallet.publicKey);
      await program.methods
        .createPolicy(usdc(50), new BN(86400), agentWallet.publicKey)
        .accountsPartial({
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
        .accountsPartial({ oracle: oracle.publicKey, config, policy } as any)
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
          .accountsPartial({ oracle: strangerOracle.publicKey, config, policy } as any)
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
        .accountsPartial({ oracle: oracle.publicKey, config, policy } as any)
        .signers([oracle])
        .rpc();

      const polPending: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(polPending.state).toBe(1);

      // Second submit must fail because state != Active; state should stay ClaimPending.
      await expect(
        program.methods
          .oracleSubmitClaim(3, Buffer.from(trigSig))
          .accountsPartial({ oracle: oracle.publicKey, config, policy } as any)
          .signers([oracle])
          .rpc(),
      ).rejects.toThrow();

      const polAfter: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(polAfter.state).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Proven exploit settlement (Phase 6)
  // -------------------------------------------------------------------------
  describe('proven exploit settlement', () => {
    /**
     * The mechanism under test, in one line: the program measures the drop
     * itself and refuses to pay more than it measured.
     *
     * Everything here exercises that bound. The oracle never supplies a
     * balance, an account, or a price — only a payout amount the program
     * checks against its own subtraction, and a hash committing to the
     * off-chain claim about *why* the money left, which the chain cannot see.
     */

    /** A fresh policy plus a funded ATA for its agent, which is the account
     *  the program will derive and read. */
    async function setupCoveredPolicy(agentFunding: BN): Promise<{
      policy: PublicKey;
      agent: Keypair;
      agentAta: PublicKey;
    }> {
      const agent = Keypair.generate();
      const agentAta = getAssociatedTokenAddressSync(usdcMint.publicKey, agent.publicKey);

      const fundTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          admin.publicKey,
          agentAta,
          agent.publicKey,
          usdcMint.publicKey,
        ),
        createMintToInstruction(
          usdcMint.publicKey,
          agentAta,
          admin.publicKey,
          BigInt(agentFunding.toString()),
        ),
      );
      fundTx.recentBlockhash = (await banks.getLatestBlockhash())[0];
      fundTx.feePayer = admin.publicKey;
      fundTx.sign(admin);
      await banks.processTransaction(fundTx);

      const [config] = configPda();
      const [vault] = vaultPda();
      const cfg: any = await (program.account as any).protocolConfig.fetch(config);
      const [policy] = policyPda(holder.publicKey, cfg.policyCounter as BN);

      await ensureAttestation(agent.publicKey);
      await program.methods
        .createPolicy(usdc(100), new BN(86_400), agent.publicKey)
        .accountsPartial({
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

      return { policy, agent, agentAta };
    }

    async function checkpoint(policy: PublicKey, agent: PublicKey): Promise<void> {
      const [config] = configPda();
      await program.methods
        .checkpointBalance()
        .accountsPartial({
          cranker: admin.publicKey,
          config,
          policy,
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent),
          usdcMint: usdcMint.publicKey,
          checkpoint: checkpointPda(policy)[0],
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([admin])
        .rpc();
    }

    /** Move tokens out of the agent's ATA, i.e. the drain itself. */
    async function drain(agent: Keypair, agentAta: PublicKey, amount: BN): Promise<void> {
      const sink = getAssociatedTokenAddressSync(usdcMint.publicKey, staker2.publicKey);
      const tx = new Transaction().add(
        createTransferInstruction(agentAta, sink, agent.publicKey, BigInt(amount.toString())),
      );
      tx.recentBlockhash = (await banks.getLatestBlockhash())[0];
      tx.feePayer = admin.publicKey;
      tx.sign(admin, agent);
      await banks.processTransaction(tx);
    }

    async function fileExploitClaim(policy: PublicKey): Promise<void> {
      const [config] = configPda();
      await program.methods
        .oracleSubmitClaim(1, Buffer.from(Array.from({ length: 64 }, (_, i) => (i + 3) % 256)))
        .accountsPartial({ oracle: oracle.publicKey, config, policy } as any)
        .signers([oracle])
        .rpc();
    }

    function payout(
      policy: PublicKey,
      agent: PublicKey,
      amount: BN,
    ) {
      const [config] = configPda();
      const [vault] = vaultPda();
      return program.methods
        .verifyAndPayoutExploit(amount, { bundleHash: Array.from(Buffer.alloc(32, 9)) })
        .accountsPartial({
          oracle: oracle.publicKey,
          config,
          policy,
          vault,
          vaultTokenAccount: vaultAta,
          holderTokenAccount: holderAta,
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent),
          usdcMint: usdcMint.publicKey,
          checkpoint: checkpointPda(policy)[0],
          evidenceRecord: exploitEvidencePda(policy)[0],
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([oracle]);
    }

    it('records the covered balance the program read for itself', async () => {
      const { policy, agent } = await setupCoveredPolicy(usdc(100));
      await checkpoint(policy, agent.publicKey);

      const cp: any = await (program.account as any).policyBalanceCheckpoint.fetch(
        checkpointPda(policy)[0],
      );
      expect(cp.amount.toString()).toBe(usdc(100).toString());
      expect(cp.coveredAccount.toBase58()).toBe(
        getAssociatedTokenAddressSync(usdcMint.publicKey, agent.publicKey).toBase58(),
      );
    });

    it('pays out an exploit bounded by the drop it measured', async () => {
      const { policy, agent, agentAta } = await setupCoveredPolicy(usdc(100));
      await checkpoint(policy, agent.publicKey);
      await drain(agent, agentAta, usdc(90)); // 90% gone
      await fileExploitClaim(policy);
      await advanceClockBySeconds(context, 3_601);

      await payout(policy, agent.publicKey, usdc(90)).rpc();

      const record: any = await (program.account as any).exploitEvidenceRecord.fetch(
        exploitEvidencePda(policy)[0],
      );
      expect(record.observedDrop.toString()).toBe(usdc(90).toString());
      expect(record.dropBps).toBe(9_000);
      expect(record.payoutAmount.toString()).toBe(usdc(90).toString());

      const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(pol.state).toBe(2); // ClaimPaid
    });

    it('refuses a payout larger than the drop, however the oracle asks', async () => {
      // The guarantee in one test. A compromised oracle key asking for the
      // full coverage gets the arithmetic, not the money.
      const { policy, agent, agentAta } = await setupCoveredPolicy(usdc(100));
      await checkpoint(policy, agent.publicKey);
      await drain(agent, agentAta, usdc(90));
      await fileExploitClaim(policy);
      await advanceClockBySeconds(context, 3_601);

      await expect(payout(policy, agent.publicKey, usdc(100)).rpc()).rejects.toThrow();

      const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(pol.state).toBe(1); // still ClaimPending
    });

    it('refuses when the balance barely moved', async () => {
      const { policy, agent, agentAta } = await setupCoveredPolicy(usdc(100));
      await checkpoint(policy, agent.publicKey);
      await drain(agent, agentAta, usdc(10)); // 10%, under the 50% floor
      await fileExploitClaim(policy);
      await advanceClockBySeconds(context, 3_601);

      await expect(payout(policy, agent.publicKey, usdc(10)).rpc()).rejects.toThrow();
    });

    it('refuses when the balance did not move at all', async () => {
      const { policy, agent } = await setupCoveredPolicy(usdc(100));
      await checkpoint(policy, agent.publicKey);
      await fileExploitClaim(policy);
      await advanceClockBySeconds(context, 3_601);

      await expect(payout(policy, agent.publicKey, usdc(1)).rpc()).rejects.toThrow();
    });

    it('refuses before the lock period has elapsed', async () => {
      const { policy, agent, agentAta } = await setupCoveredPolicy(usdc(100));
      await checkpoint(policy, agent.publicKey);
      await drain(agent, agentAta, usdc(90));
      await fileExploitClaim(policy);

      await expect(payout(policy, agent.publicKey, usdc(90)).rpc()).rejects.toThrow();
    });

    it('refuses to settle a non-exploit trigger on this path', async () => {
      // A balance drop says nothing about a mispriced fill. Letting this
      // instruction settle another trigger would wave one through.
      const { policy, agent, agentAta } = await setupCoveredPolicy(usdc(100));
      await checkpoint(policy, agent.publicKey);
      await drain(agent, agentAta, usdc(90));

      const [config] = configPda();
      await program.methods
        .oracleSubmitClaim(2, Buffer.from(Array.from({ length: 64 }, () => 5)))
        .accountsPartial({ oracle: oracle.publicKey, config, policy } as any)
        .signers([oracle])
        .rpc();
      await advanceClockBySeconds(context, 3_601);

      await expect(payout(policy, agent.publicKey, usdc(90)).rpc()).rejects.toThrow();
    });

    it('keeps the pre-incident baseline when a crank tick lands after the drain', async () => {
      // Without `prev_*`, a checkpoint written between the drain and the
      // claim would overwrite the only usable baseline with a post-incident
      // one and the payout would find nothing to measure against.
      const { policy, agent, agentAta } = await setupCoveredPolicy(usdc(100));
      await checkpoint(policy, agent.publicKey);
      await drain(agent, agentAta, usdc(90));
      await advanceSlots(context, 1);
      await checkpoint(policy, agent.publicKey); // tick lands after the drain

      const cp: any = await (program.account as any).policyBalanceCheckpoint.fetch(
        checkpointPda(policy)[0],
      );
      expect(cp.amount.toString()).toBe(usdc(10).toString());
      expect(cp.prevAmount.toString()).toBe(usdc(100).toString());
    });

    it('lets anyone write a checkpoint, not only the oracle', async () => {
      // Permissionless on purpose: a baseline only the oracle could write
      // would put the oracle back in charge of the number meant to bound it.
      const { policy, agent } = await setupCoveredPolicy(usdc(100));
      const [config] = configPda();

      await program.methods
        .checkpointBalance()
        .accountsPartial({
          cranker: staker.publicKey,
          config,
          policy,
          coveredTokenAccount: getAssociatedTokenAddressSync(
            usdcMint.publicKey,
            agent.publicKey,
          ),
          usdcMint: usdcMint.publicKey,
          checkpoint: checkpointPda(policy)[0],
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([staker])
        .rpc();

      const cp: any = await (program.account as any).policyBalanceCheckpoint.fetch(
        checkpointPda(policy)[0],
      );
      expect(cp.amount.toString()).toBe(usdc(100).toString());
    });

    it('rejects a checkpoint pointed at an account that is not the agent\'s', async () => {
      // The constraint that makes the drop a measurement rather than an
      // assertion: Anchor derives the covered account from the policy.
      const { policy, agent } = await setupCoveredPolicy(usdc(100));
      const [config] = configPda();

      await expect(
        program.methods
          .checkpointBalance()
          .accountsPartial({
            cranker: admin.publicKey,
            config,
            policy,
            coveredTokenAccount: holderAta, // not the agent's ATA
            usdcMint: usdcMint.publicKey,
            checkpoint: checkpointPda(policy)[0],
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([admin])
          .rpc(),
      ).rejects.toThrow();

      void agent;
    });

    it('pays a proven exploit only once', async () => {
      const { policy, agent, agentAta } = await setupCoveredPolicy(usdc(100));
      await checkpoint(policy, agent.publicKey);
      await drain(agent, agentAta, usdc(90));
      await fileExploitClaim(policy);
      await advanceClockBySeconds(context, 3_601);

      await payout(policy, agent.publicKey, usdc(90)).rpc();
      await expect(payout(policy, agent.publicKey, usdc(90)).rpc()).rejects.toThrow();
    });

    it('cannot settle a seizure — the covered account stops being the agent\'s', async () => {
      // The finding that made a separate governance path necessary rather
      // than merely nicer. `associated_token::authority = policy.agent_address`
      // compiles into an owner equality check, so once `SetAuthority` lands
      // the exploit instruction cannot load the account at all — and the
      // balance never dropped anyway, so there would be nothing to measure.
      const { policy, agent, agentAta } = await setupCoveredPolicy(usdc(100));
      await checkpoint(policy, agent.publicKey);

      const seizeTx = new Transaction().add(
        createSetAuthorityInstruction(
          agentAta,
          agent.publicKey,
          AuthorityType.AccountOwner,
          staker2.publicKey,
        ),
      );
      seizeTx.recentBlockhash = (await banks.getLatestBlockhash())[0];
      seizeTx.feePayer = admin.publicKey;
      seizeTx.sign(admin, agent);
      await banks.processTransaction(seizeTx);

      await fileExploitClaim(policy);
      await advanceClockBySeconds(context, 3_601);

      await expect(payout(policy, agent.publicKey, usdc(90)).rpc()).rejects.toThrow();
    });
  });

  describe('proven governance settlement', () => {
    /**
     * The mechanism under test: the program compares the holder's own matured
     * declaration of who may control the agent against what it reads on the
     * account now, and refuses to pay unless control actually left that set.
     *
     * The oracle supplies a payout amount and a bundle hash. Every fact the
     * verdict rests on — the declaration, the earlier authority reading, the
     * current owner — is read by the program.
     */

    const ATTACKER = Keypair.generate();

    async function setupGovernedPolicy(funding: BN): Promise<{
      policy: PublicKey;
      agent: Keypair;
      agentAta: PublicKey;
    }> {
      const agent = Keypair.generate();
      const agentAta = getAssociatedTokenAddressSync(usdcMint.publicKey, agent.publicKey);

      const fundTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          admin.publicKey,
          agentAta,
          agent.publicKey,
          usdcMint.publicKey,
        ),
        createMintToInstruction(
          usdcMint.publicKey,
          agentAta,
          admin.publicKey,
          BigInt(funding.toString()),
        ),
      );
      fundTx.recentBlockhash = (await banks.getLatestBlockhash())[0];
      fundTx.feePayer = admin.publicKey;
      fundTx.sign(admin);
      await banks.processTransaction(fundTx);

      const [config] = configPda();
      const [vault] = vaultPda();
      const cfg: any = await (program.account as any).protocolConfig.fetch(config);
      const [policy] = policyPda(holder.publicKey, cfg.policyCounter as BN);

      await ensureAttestation(agent.publicKey);
      await program.methods
        .createPolicy(usdc(100), new BN(86_400), agent.publicKey)
        .accountsPartial({
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

      return { policy, agent, agentAta };
    }

    function manifest(agent: PublicKey, extra: PublicKey[] = []) {
      return {
        tokenOwner: agent,
        expectedDelegate: null,
        expectedCloseAuthority: null,
        programUpgradeAuthority: null,
        controller: null,
        controllerMinThreshold: 0,
        extraAuthorities: extra,
        manifestHash: Array.from(Buffer.alloc(32, 7)),
      };
    }

    async function declare(policy: PublicKey, agent: PublicKey, extra: PublicKey[] = []) {
      await program.methods
        .declareGovernanceBaseline(manifest(agent, extra) as any)
        .accountsPartial({
          holder: holder.publicKey,
          policy,
          baseline: governanceBaselinePda(policy)[0],
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([holder])
        .rpc();
    }

    async function authorityCheckpoint(
      policy: PublicKey,
      agent: PublicKey,
      cranker: Keypair = admin,
    ) {
      const [config] = configPda();
      await program.methods
        .checkpointAuthority()
        .accountsPartial({
          cranker: cranker.publicKey,
          config,
          policy,
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent),
          usdcMint: usdcMint.publicKey,
          checkpoint: authorityCheckpointPda(policy)[0],
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([cranker])
        .rpc();
    }

    async function seize(agent: Keypair, agentAta: PublicKey, to: PublicKey) {
      const tx = new Transaction().add(
        createSetAuthorityInstruction(agentAta, agent.publicKey, AuthorityType.AccountOwner, to),
      );
      tx.recentBlockhash = (await banks.getLatestBlockhash())[0];
      tx.feePayer = admin.publicKey;
      tx.sign(admin, agent);
      await banks.processTransaction(tx);
    }

    async function freeze(agentAta: PublicKey) {
      const tx = new Transaction().add(
        createFreezeAccountInstruction(agentAta, usdcMint.publicKey, admin.publicKey),
      );
      tx.recentBlockhash = (await banks.getLatestBlockhash())[0];
      tx.feePayer = admin.publicKey;
      tx.sign(admin);
      await banks.processTransaction(tx);
    }

    async function fileGovernanceClaim(policy: PublicKey, trigger = 4) {
      const [config] = configPda();
      await program.methods
        .oracleSubmitClaim(trigger, Buffer.from(Array.from({ length: 64 }, (_, i) => (i + 11) % 256)))
        .accountsPartial({ oracle: oracle.publicKey, config, policy } as any)
        .signers([oracle])
        .rpc();
    }

    function govPayout(policy: PublicKey, agent: PublicKey, amount: BN) {
      const [config] = configPda();
      const [vault] = vaultPda();
      return program.methods
        .verifyAndPayoutGovernance(amount, { bundleHash: Array.from(Buffer.alloc(32, 4)) })
        .accountsPartial({
          oracle: oracle.publicKey,
          config,
          policy,
          vault,
          vaultTokenAccount: vaultAta,
          holderTokenAccount: holderAta,
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent),
          usdcMint: usdcMint.publicKey,
          baseline: governanceBaselinePda(policy)[0],
          checkpoint: authorityCheckpointPda(policy)[0],
          evidenceRecord: governanceEvidencePda(policy)[0],
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([oracle]);
    }

    it('records who controlled the account, and matures on a delay', async () => {
      const { policy, agent } = await setupGovernedPolicy(usdc(100));
      await declare(policy, agent.publicKey);

      const b: any = await (program.account as any).governanceBaseline.fetch(
        governanceBaselinePda(policy)[0],
      );
      expect(b.tokenOwner.toBase58()).toBe(agent.publicKey.toBase58());
      // The delay is the mechanism: a declaration usable the instant it is
      // written would be exactly what a stolen holder key writes first.
      expect(b.effectiveAt.sub(b.declaredAt).toNumber()).toBe(3_600);
    });

    it('reads the owner the program sees, not one it is handed', async () => {
      const { policy, agent } = await setupGovernedPolicy(usdc(100));
      await authorityCheckpoint(policy, agent.publicKey);

      const cp: any = await (program.account as any).policyAuthorityCheckpoint.fetch(
        authorityCheckpointPda(policy)[0],
      );
      expect(cp.owner.toBase58()).toBe(agent.publicKey.toBase58());
      expect(cp.frozen).toBe(false);
      expect(cp.amount.toString()).toBe(usdc(100).toString());
    });

    it('checkpoints an account whose owner has already changed', async () => {
      // The reason this crank cannot reuse `associated_token::authority`: it
      // has to be able to read the account *after* a seizure, which is
      // exactly the state that constraint rejects.
      const { policy, agent, agentAta } = await setupGovernedPolicy(usdc(100));
      await authorityCheckpoint(policy, agent.publicKey);
      await seize(agent, agentAta, ATTACKER.publicKey);
      await advanceSlots(context, 1);
      await authorityCheckpoint(policy, agent.publicKey);

      const cp: any = await (program.account as any).policyAuthorityCheckpoint.fetch(
        authorityCheckpointPda(policy)[0],
      );
      expect(cp.owner.toBase58()).toBe(ATTACKER.publicKey.toBase58());
      expect(cp.prevOwner.toBase58()).toBe(agent.publicKey.toBase58());
    });

    it('lets anyone write an authority checkpoint, not only the oracle', async () => {
      const { policy, agent } = await setupGovernedPolicy(usdc(100));
      await authorityCheckpoint(policy, agent.publicKey, staker);

      const cp: any = await (program.account as any).policyAuthorityCheckpoint.fetch(
        authorityCheckpointPda(policy)[0],
      );
      expect(cp.owner.toBase58()).toBe(agent.publicKey.toBase58());
    });

    it('pays out a seizure the program observed for itself', async () => {
      const { policy, agent, agentAta } = await setupGovernedPolicy(usdc(100));
      await declare(policy, agent.publicKey);
      await authorityCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601); // baseline matures
      await seize(agent, agentAta, ATTACKER.publicKey);
      await fileGovernanceClaim(policy);
      await advanceClockBySeconds(context, 7_201); // governance lock

      await govPayout(policy, agent.publicKey, usdc(100)).rpc();

      const record: any = await (program.account as any).governanceEvidenceRecord.fetch(
        governanceEvidencePda(policy)[0],
      );
      expect(record.observedOwner.toBase58()).toBe(ATTACKER.publicKey.toBase58());
      expect(record.declaredOwner.toBase58()).toBe(agent.publicKey.toBase58());
      expect(record.departureKind).toBe(1); // DEPARTURE_OWNER
      expect(record.seizedAmount.toString()).toBe(usdc(100).toString());

      const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(pol.state).toBe(2); // ClaimPaid
    });

    it('pays out a freeze, where no value moved at all', async () => {
      // The shape the balance path is structurally blind to: the account is
      // still the agent's and still full, and the agent cannot use it.
      const { policy, agent, agentAta } = await setupGovernedPolicy(usdc(100));
      await declare(policy, agent.publicKey);
      await authorityCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await freeze(agentAta);
      await fileGovernanceClaim(policy);
      await advanceClockBySeconds(context, 7_201);

      await govPayout(policy, agent.publicKey, usdc(100)).rpc();

      const record: any = await (program.account as any).governanceEvidenceRecord.fetch(
        governanceEvidencePda(policy)[0],
      );
      expect(record.departureKind).toBe(2); // DEPARTURE_FROZEN
      expect(record.observedDrop.toString()).toBe('0');
      expect(record.seizedAmount.toString()).toBe(usdc(100).toString());
    });

    it('refuses when control is still inside the declared set', async () => {
      // The clean refusal, and it rests on a positive on-chain fact rather
      // than the absence of evidence.
      const { policy, agent, agentAta } = await setupGovernedPolicy(usdc(100));
      await declare(policy, agent.publicKey, [staker2.publicKey]);
      await authorityCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await seize(agent, agentAta, staker2.publicKey); // a declared operator
      await fileGovernanceClaim(policy);
      await advanceClockBySeconds(context, 7_201);

      await expect(govPayout(policy, agent.publicKey, usdc(100)).rpc()).rejects.toThrow();
    });

    it('refuses when control moved to the holder', async () => {
      const { policy, agent, agentAta } = await setupGovernedPolicy(usdc(100));
      await declare(policy, agent.publicKey);
      await authorityCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await seize(agent, agentAta, holder.publicKey);
      await fileGovernanceClaim(policy);
      await advanceClockBySeconds(context, 7_201);

      await expect(govPayout(policy, agent.publicKey, usdc(100)).rpc()).rejects.toThrow();
    });

    it('refuses a baseline that had not matured when the claim was filed', async () => {
      // Without this, a compromised holder key declares a convenient set and
      // claims against it in the next instruction.
      const { policy, agent, agentAta } = await setupGovernedPolicy(usdc(100));
      await declare(policy, agent.publicKey);
      await authorityCheckpoint(policy, agent.publicKey);
      await seize(agent, agentAta, ATTACKER.publicKey);
      await fileGovernanceClaim(policy); // filed before effective_at
      await advanceClockBySeconds(context, 7_201);

      await expect(govPayout(policy, agent.publicKey, usdc(100)).rpc()).rejects.toThrow();
    });

    it('refuses a payout larger than the value it can see', async () => {
      const { policy, agent, agentAta } = await setupGovernedPolicy(usdc(40));
      await declare(policy, agent.publicKey);
      await authorityCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await seize(agent, agentAta, ATTACKER.publicKey);
      await fileGovernanceClaim(policy);
      await advanceClockBySeconds(context, 7_201);

      // Only 40 USDC is behind the seizure; the coverage is 100.
      await expect(govPayout(policy, agent.publicKey, usdc(100)).rpc()).rejects.toThrow();
      await govPayout(policy, agent.publicKey, usdc(40)).rpc();
    });

    it('refuses before the lock period has elapsed', async () => {
      const { policy, agent, agentAta } = await setupGovernedPolicy(usdc(100));
      await declare(policy, agent.publicKey);
      await authorityCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await seize(agent, agentAta, ATTACKER.publicKey);
      await fileGovernanceClaim(policy);

      await expect(govPayout(policy, agent.publicKey, usdc(100)).rpc()).rejects.toThrow();
    });

    it('refuses to settle a non-governance trigger on this path', async () => {
      const { policy, agent, agentAta } = await setupGovernedPolicy(usdc(100));
      await declare(policy, agent.publicKey);
      await authorityCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await seize(agent, agentAta, ATTACKER.publicKey);
      await fileGovernanceClaim(policy, 1); // exploit
      await advanceClockBySeconds(context, 7_201);

      await expect(govPayout(policy, agent.publicKey, usdc(100)).rpc()).rejects.toThrow();
    });

    it('refuses a checkpoint pointed at an account that is not the agent\'s', async () => {
      const { policy } = await setupGovernedPolicy(usdc(100));
      const [config] = configPda();

      await expect(
        program.methods
          .checkpointAuthority()
          .accountsPartial({
            cranker: admin.publicKey,
            config,
            policy,
            coveredTokenAccount: holderAta, // not the agent's ATA
            usdcMint: usdcMint.publicKey,
            checkpoint: authorityCheckpointPda(policy)[0],
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([admin])
          .rpc(),
      ).rejects.toThrow();
    });

    it('lets only the holder declare the authority set', async () => {
      // Not the oracle, whose discretion this account exists to constrain.
      const { policy, agent } = await setupGovernedPolicy(usdc(100));

      await expect(
        program.methods
          .declareGovernanceBaseline(manifest(agent.publicKey) as any)
          .accountsPartial({
            holder: oracle.publicKey,
            policy,
            baseline: governanceBaselinePda(policy)[0],
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([oracle])
          .rpc(),
      ).rejects.toThrow();
    });

    it('pays a proven governance claim only once', async () => {
      const { policy, agent, agentAta } = await setupGovernedPolicy(usdc(100));
      await declare(policy, agent.publicKey);
      await authorityCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await seize(agent, agentAta, ATTACKER.publicKey);
      await fileGovernanceClaim(policy);
      await advanceClockBySeconds(context, 7_201);

      await govPayout(policy, agent.publicKey, usdc(100)).rpc();
      await expect(govPayout(policy, agent.publicKey, usdc(100)).rpc()).rejects.toThrow();
    });
  });
});

if (!hasIdl) {
  describe('Covantic — Anchor integration', () => {
    it.skip('IDL not found at target/idl/covantic.json; run `anchor build` before testing', () => {});
  });
}
