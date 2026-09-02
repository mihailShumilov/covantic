import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import { agentMandateCommitment } from '@covantic/shared';
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
  ? ((JSON.parse(readFileSync(IDL_PATH_EAGER, 'utf-8')) as { address?: string }).address ??
    '52KrSMg3rsbtRw3FchxJ9jRwRzQmWcDzg1AiiHHHXz1D')
  : '52KrSMg3rsbtRw3FchxJ9jRwRzQmWcDzg1AiiHHHXz1D';
const PROGRAM_ID = new PublicKey(_PROGRAM_ID_FROM_IDL);

const CONFIG_SEED = Buffer.from('covantic_config');
const VAULT_SEED = Buffer.from('covantic_vault');
const POLICY_SEED = Buffer.from('covantic_policy');
const STAKER_SEED = Buffer.from('covantic_staker');
const ATTESTATION_SEED = Buffer.from('covantic_attestation');
const PENDING_ADMIN_SEED = Buffer.from('covantic_pending_admin');
const CHECKPOINT_SEED = Buffer.from('covantic_checkpoint');
const EXPLOIT_EVIDENCE_SEED = Buffer.from('covantic_exploit_evidence');
const GOVERNANCE_BASELINE_SEED = Buffer.from('covantic_gov_baseline');
const AUTHORITY_CHECKPOINT_SEED = Buffer.from('covantic_authority_checkpoint');
const GOVERNANCE_EVIDENCE_SEED = Buffer.from('covantic_gov_evidence');
const AGENT_MANDATE_SEED = Buffer.from('covantic_agent_mandate');
const AGENT_ERROR_EVIDENCE_SEED = Buffer.from('covantic_agent_error_evidence');

const USDC_DECIMALS = 6;
const usdc = (amount: number) => new BN(amount * 10 ** USDC_DECIMALS);

const IDL_PATH = resolve(__dirname, '../target/idl/covantic.json');
const hasIdl = existsSync(IDL_PATH);
const loadIdl = (): Idl => JSON.parse(readFileSync(IDL_PATH, 'utf-8')) as Idl;

function u64LeBytes(value: BN): Buffer {
  const buf = Buffer.alloc(8);
  const bytes = value.toArrayLike(Buffer, 'le', 8);
  bytes.copy(buf);
  return buf;
}

function pendingAdminPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PENDING_ADMIN_SEED], PROGRAM_ID);
}

function policyPda(holder: PublicKey, policyId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POLICY_SEED, holder.toBuffer(), u64LeBytes(policyId)],
    PROGRAM_ID,
  );
}

function stakerPda(staker: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([STAKER_SEED, staker.toBuffer()], PROGRAM_ID);
}

function checkpointPda(policy: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CHECKPOINT_SEED, policy.toBuffer()], PROGRAM_ID);
}

function governanceBaselinePda(policy: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [GOVERNANCE_BASELINE_SEED, policy.toBuffer()],
    PROGRAM_ID,
  );
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
  return PublicKey.findProgramAddressSync([EXPLOIT_EVIDENCE_SEED, policy.toBuffer()], PROGRAM_ID);
}

function agentMandatePda(policy: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AGENT_MANDATE_SEED, policy.toBuffer()], PROGRAM_ID);
}

function agentErrorEvidencePda(policy: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [AGENT_ERROR_EVIDENCE_SEED, policy.toBuffer()],
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

async function advanceClockBySeconds(context: ProgramTestContext, seconds: number): Promise<void> {
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
    const lamports = await getMinimumBalanceForRentExemptMint(provider.connection as any);
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
    holderAta = getAssociatedTokenAddressSync(usdcMint.publicKey, holder.publicKey);
    stakerAta = getAssociatedTokenAddressSync(usdcMint.publicKey, staker.publicKey);
    staker2Ata = getAssociatedTokenAddressSync(usdcMint.publicKey, staker2.publicKey);

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
      // The agent's covered account. `create_policy` reads it now: the
      // retention floor a holder declares has to be one they currently
      // satisfy, and that is a balance. An agent with no covered account has
      // nothing to lose and cannot be insured.
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        getAssociatedTokenAddressSync(usdcMint.publicKey, agentWallet.publicKey),
        agentWallet.publicKey,
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
  /**
   * The envelope every test policy is bought against.
   *
   * Wide on purpose: these tests are about the rest of the protocol, and a
   * narrow deductible would have them tripping the mandate rules instead of
   * the behaviour under test. The agent-error tests declare their own.
   */
  function testMandate() {
    return {
      maxSingleOutflow: usdc(1_000_000),
      maxWindowOutflow: usdc(1_000_000),
      windowSeconds: new BN(3600),
      minRetainedBalance: new BN(0),
      allowedCounterparties: [],
      allowedPrograms: [],
      manifestHash: Array.from(new Uint8Array(32)),
    };
  }

  /**
   * The commitment the oracle signs, computed the way the program will.
   *
   * Takes the mandate rather than assuming one: the attestation now prices a
   * specific envelope, so a test that buys a narrow envelope has to publish an
   * attestation for *that* envelope. Getting this wrong is what
   * `AttestationMandateMismatch` is for, and it is the whole point of the
   * change — a premium quoted for one deductible cannot be spent on another.
   */
  function mandateHashOf(m: {
    maxSingleOutflow: BN;
    maxWindowOutflow: BN;
    windowSeconds: BN;
    minRetainedBalance: BN;
    allowedCounterparties: PublicKey[];
    allowedPrograms: PublicKey[];
  }): number[] {
    return Array.from(
      agentMandateCommitment({
        maxSingleOutflowRaw: BigInt(m.maxSingleOutflow.toString()),
        maxWindowOutflowRaw: BigInt(m.maxWindowOutflow.toString()),
        windowSeconds: BigInt(m.windowSeconds.toString()),
        minRetainedBalanceRaw: BigInt(m.minRetainedBalance.toString()),
        allowedCounterparties: m.allowedCounterparties.map((k) => k.toBytes()),
        allowedPrograms: m.allowedPrograms.map((k) => k.toBytes()),
      }),
    );
  }

  function testMandateHash(): number[] {
    return mandateHashOf(testMandate() as any);
  }

  async function ensureAttestation(
    agent: PublicKey,
    tier = 0,
    mandateHash: number[] = testMandateHash(),
  ): Promise<void> {
    const [config] = configPda();
    await program.methods
      .upsertAttestation(agent, tier, new BN(3600), mandateHash, new BN(0))
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

    await program.methods
      .createPolicy(usdc(100), new BN(86400), agentWallet.publicKey, testMandate() as any)
      .accountsPartial({
        usdcMint: usdcMint.publicKey,
        coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agentWallet.publicKey),
        holder: holder.publicKey,
        config,
        vault,
        policy,
        usdcMint: usdcMint.publicKey,
        mandate: agentMandatePda(policy)[0],
        coveredTokenAccount: getAssociatedTokenAddressSync(
          usdcMint.publicKey,
          agentWallet.publicKey,
        ),
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
      BigInt(vaultAfter.reserveFund.toString()) - BigInt(vaultBefore.reserveFund.toString()),
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
    expect(holderAfter.amount - holderBefore.amount).toBe(80n * 10n ** BigInt(USDC_DECIMALS));

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
      .createPolicy(usdc(50), new BN(86400), agentWallet.publicKey, testMandate() as any)
      .accountsPartial({
        usdcMint: usdcMint.publicKey,
        coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agentWallet.publicKey),
        holder: holder.publicKey,
        config,
        vault,
        policy,
        usdcMint: usdcMint.publicKey,
        mandate: agentMandatePda(policy)[0],
        coveredTokenAccount: getAssociatedTokenAddressSync(
          usdcMint.publicKey,
          agentWallet.publicKey,
        ),
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
      BigInt(vaultBefore.totalCoverage.toString()) - BigInt(vaultAfter.totalCoverage.toString()),
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
      .createPolicy(usdc(20), new BN(3600), agentWallet.publicKey, testMandate() as any)
      .accountsPartial({
        usdcMint: usdcMint.publicKey,
        coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agentWallet.publicKey),
        holder: holder.publicKey,
        config,
        vault,
        policy,
        usdcMint: usdcMint.publicKey,
        mandate: agentMandatePda(policy)[0],
        coveredTokenAccount: getAssociatedTokenAddressSync(
          usdcMint.publicKey,
          agentWallet.publicKey,
        ),
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
   * The vault's accounting identity, which two separate defects used to break.
   *
   *   vault token balance  ==  total_staked
   *                          + total_staker_rewards
   *                          + reserve_fund
   *                          + protocol_treasury
   *
   * The first break was ECO-02: the loss cascade decremented `total_staked`
   * while no `StakerPosition` moved, so a socialised loss was not socialised
   * and the first staker out was paid in full. The second was ECO-03:
   * `cancel_policy` transferred a refund out of the vault while reducing no
   * counter at all, having already split that premium 70/20/10 into the three
   * buckets when the policy was written — so cancelling handed part of it back
   * twice, once as tokens and once as an obligation still on the books.
   *
   * Neither surfaced where it was caused. Both surfaced as an opaque SPL
   * `InsufficientFunds` on whichever staker withdrew last, which is why this
   * asserts the identity itself rather than the symptom.
   */
  it('holds the vault accounting identity, and pays the last staker out in full', async () => {
    const [position] = stakerPda(staker.publicKey);
    const [vault] = vaultPda();

    await advanceClockBySeconds(context, 48 * 3600 + 1);

    const v: any = await (program.account as any).insuranceVault.fetch(vault);
    const pos: any = await (program.account as any).stakerPosition.fetch(position);
    const vaultBalance = await getAccount(provider.connection as any, vaultAta);

    // (1) A loss was socialised — the index moved off whole.
    const SCALE = 1_000_000_000_000n;
    const lossIndex = BigInt(v.lossIndex.toString());
    expect(lossIndex).toBeLessThan(SCALE);

    // (2) The position carries its share. Revalued, it no longer claims more
    //     principal than the pool holds — which is what it did before, and why
    //     the first withdrawal used to drain the vault.
    const snapshot = BigInt(pos.lossIndexSnapshot.toString()) || SCALE;
    const revalued = (BigInt(pos.amountStaked.toString()) * lossIndex) / snapshot;
    expect(revalued).toBeLessThanOrEqual(BigInt(v.totalStaked.toString()));

    // (3) The identity, exactly. Every token in the vault is spoken for, and
    //     nothing is spoken for twice.
    const obligations =
      BigInt(v.totalStaked.toString()) +
      BigInt(v.totalStakerRewards.toString()) +
      BigInt(v.reserveFund.toString()) +
      BigInt(v.protocolTreasury.toString());
    expect(obligations).toBe(vaultBalance.amount);

    // (4) And so the withdrawal that used to fail now settles.
    const before = await getAccount(provider.connection as any, stakerAta);
    await program.methods
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
      .rpc();
    const after = await getAccount(provider.connection as any, stakerAta);
    expect(after.amount).toBeGreaterThan(before.amount);
  });

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
      .createPolicy(usdc(100), new BN(86400 * 10), agentWallet.publicKey, testMandate() as any)
      .accountsPartial({
        usdcMint: usdcMint.publicKey,
        coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agentWallet.publicKey),
        holder: holder.publicKey,
        config,
        vault,
        policy,
        usdcMint: usdcMint.publicKey,
        mandate: agentMandatePda(policy)[0],
        coveredTokenAccount: getAssociatedTokenAddressSync(
          usdcMint.publicKey,
          agentWallet.publicKey,
        ),
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
          .createPolicy(new BN(500_000), new BN(86400), agentWallet.publicKey, testMandate() as any)
          .accountsPartial({
            usdcMint: usdcMint.publicKey,
            coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agentWallet.publicKey),
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
          .upsertAttestation(agentWallet.publicKey, 5, new BN(3600), testMandateHash(), new BN(0))
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
        .createPolicy(usdc(50), new BN(86400), agentWallet.publicKey, testMandate() as any)
        .accountsPartial({
          usdcMint: usdcMint.publicKey,
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agentWallet.publicKey),
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
        .createPolicy(usdc(50), new BN(86400), agentWallet.publicKey, testMandate() as any)
        .accountsPartial({
          usdcMint: usdcMint.publicKey,
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agentWallet.publicKey),
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
        .createPolicy(usdc(100), new BN(86_400), agent.publicKey, testMandate() as any)
        .accountsPartial({
          usdcMint: usdcMint.publicKey,
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent.publicKey),
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

    function payout(policy: PublicKey, agent: PublicKey, amount: BN) {
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
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent.publicKey),
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

    it("rejects a checkpoint pointed at an account that is not the agent's", async () => {
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

    it("cannot settle a seizure — the covered account stops being the agent's", async () => {
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
        .createPolicy(usdc(100), new BN(86_400), agent.publicKey, testMandate() as any)
        .accountsPartial({
          usdcMint: usdcMint.publicKey,
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent.publicKey),
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
        .oracleSubmitClaim(
          trigger,
          Buffer.from(Array.from({ length: 64 }, (_, i) => (i + 11) % 256)),
        )
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
      // The *property*, not the number. `devnet-fast-lock` compresses this to a
      // minute so a policy bought in front of an audience can settle in front of
      // them too, and this suite runs against whichever artifact was built. What
      // must hold on every build is that the declaration matures strictly after
      // it was made — zero would let a holder declare an envelope around a loss
      // they had already watched happen. The production value is asserted in
      // Rust, where the cfg is visible: see
      // `a_production_build_keeps_the_full_maturity_delay`.
      expect(b.effectiveAt.sub(b.declaredAt).toNumber()).toBeGreaterThan(0);
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

    it("refuses a checkpoint pointed at an account that is not the agent's", async () => {
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

  describe('agent mandate — declaring an envelope and proving a breach', () => {
    /**
     * The trigger where the chain has the least to work with, and the tests
     * are mostly about what it therefore refuses.
     *
     * An agent error is a loss the agent caused with its *own* authority, so
     * there is no unauthorised signer to point at and no change of control to
     * observe. The only thing that makes it checkable is the holder saying, in
     * advance, what the agent was permitted to do — and the program then
     * comparing that against a balance it reads for itself.
     */

    const CAP = usdc(10);
    const FLOOR = usdc(5);

    // The suite creates a fresh agent per case and the earlier blocks have
    // already spent most of the admin's balance funding theirs. Topping up
    // here keeps a failure in this block mean "the instruction refused",
    // which is what every assertion below is actually about.
    beforeAll(async () => {
      await airdropSol(context, admin.publicKey);
    });

    async function setupMandatedPolicy(agentFunding: BN) {
      const agent = Keypair.generate();
      const agentAta = getAssociatedTokenAddressSync(usdcMint.publicKey, agent.publicKey);

      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: agent.publicKey,
          lamports: 100_000_000,
        }),
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

      await ensureAttestation(agent.publicKey, 0, mandateHashOf(envelope() as any));
      await program.methods
        .createPolicy(
          usdc(100),
          new BN(86_400),
          agent.publicKey,
          // Bought *with* the envelope these tests are about. Buying wide and
          // narrowing afterwards is what `create_policy` now prices and
          // `declare_agent_mandate` now refuses — the deductible has to be the
          // one the premium was quoted for.
          envelope() as any,
        )
        .accountsPartial({
          usdcMint: usdcMint.publicKey,
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent.publicKey),
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

    function envelope(overrides: Record<string, unknown> = {}) {
      return {
        maxSingleOutflow: CAP,
        maxWindowOutflow: usdc(50),
        windowSeconds: new BN(3_600),
        minRetainedBalance: FLOOR,
        allowedCounterparties: [],
        allowedPrograms: [],
        manifestHash: Array.from(Buffer.alloc(32, 9)),
        ...overrides,
      };
    }

    async function declareMandate(
      policy: PublicKey,
      overrides: Record<string, unknown> = {},
      signer: Keypair = holder,
      agent?: PublicKey,
    ) {
      const [config] = configPda();
      // The covered account is derived from the policy's own agent, so read it
      // off chain rather than assuming the suite-wide wallet: this block makes
      // a fresh agent per case.
      const policyAcc: any = await (program.account as any).insurancePolicy.fetch(policy);
      const coveredAgent = agent ?? (policyAcc.agentAddress as PublicKey);
      await program.methods
        .declareAgentMandate(envelope(overrides) as any)
        .accountsPartial({
          holder: signer.publicKey,
          policy,
          mandate: agentMandatePda(policy)[0],
          config,
          // Read only to bound `minRetainedBalance` against a balance the
          // program can see, so a holder cannot declare a floor they already
          // breach and make every outflow a full-loss claim.
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, coveredAgent),
          usdcMint: usdcMint.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([signer])
        .rpc();
    }

    async function balanceCheckpoint(policy: PublicKey, agent: PublicKey) {
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

    async function spend(agent: Keypair, agentAta: PublicKey, amount: BN) {
      const sink = getAssociatedTokenAddressSync(usdcMint.publicKey, staker2.publicKey);
      const tx = new Transaction().add(
        createTransferInstruction(agentAta, sink, agent.publicKey, BigInt(amount.toString())),
      );
      tx.recentBlockhash = (await banks.getLatestBlockhash())[0];
      tx.feePayer = admin.publicKey;
      tx.sign(admin, agent);
      await banks.processTransaction(tx);
    }

    async function fileClaim(policy: PublicKey, trigger = 3) {
      const [config] = configPda();
      await program.methods
        .oracleSubmitClaim(
          trigger,
          Buffer.from(Array.from({ length: 64 }, (_, i) => (i + 23) % 256)),
        )
        .accountsPartial({ oracle: oracle.publicKey, config, policy } as any)
        .signers([oracle])
        .rpc();
    }

    function payout(policy: PublicKey, agent: PublicKey, amount: BN) {
      const [config] = configPda();
      const [vault] = vaultPda();
      return program.methods
        .verifyAndPayoutAgentError(amount, { bundleHash: Array.from(Buffer.alloc(32, 6)) })
        .accountsPartial({
          oracle: oracle.publicKey,
          config,
          policy,
          vault,
          vaultTokenAccount: vaultAta,
          holderTokenAccount: holderAta,
          coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent),
          usdcMint: usdcMint.publicKey,
          mandate: agentMandatePda(policy)[0],
          checkpoint: checkpointPda(policy)[0],
          evidenceRecord: agentErrorEvidencePda(policy)[0],
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([oracle]);
    }

    it('records the declared envelope, and matures on a delay', async () => {
      const { policy } = await setupMandatedPolicy(usdc(100));
      await declareMandate(policy);

      const m: any = await (program.account as any).policyAgentMandate.fetch(
        agentMandatePda(policy)[0],
      );
      expect(m.maxSingleOutflow.toString()).toBe(CAP.toString());
      // The delay is the mechanism: without it a holder could watch an
      // ordinary loss happen and then declare an envelope narrow enough to
      // have been breached by it.
      // See the note on the governance baseline: the property survives every
      // build, the exact delay does not.
      expect(m.effectiveAt.sub(m.declaredAt).toNumber()).toBeGreaterThan(0);
    });

    it('lets only the holder declare what their agent may do', async () => {
      // Not the oracle, whose discretion this account exists to constrain.
      const { policy } = await setupMandatedPolicy(usdc(100));

      await expect(declareMandate(policy, {}, oracle)).rejects.toThrow();
    });

    it('refuses a zero cap, which would make every movement a breach', async () => {
      const { policy } = await setupMandatedPolicy(usdc(100));

      await expect(declareMandate(policy, { maxSingleOutflow: usdc(0) })).rejects.toThrow();
    });

    it('refuses a window cap smaller than a single permitted movement', async () => {
      const { policy } = await setupMandatedPolicy(usdc(100));

      await expect(declareMandate(policy, { maxWindowOutflow: usdc(1) })).rejects.toThrow();
    });

    it('refuses a retention floor the agent does not already satisfy', async () => {
      // The one declared dimension nothing bounded, and the arithmetic bound
      // the whole trigger rests on.
      //
      // `floor_excess` is `min(floor - retained, outflow)`, so a floor
      // declared far above what the account holds makes the excess equal the
      // *entire* movement — turning "we pay the overshoot beyond what you said
      // you would risk" into "we pay the whole loss". A holder may only
      // declare a floor they currently meet.
      const { policy } = await setupMandatedPolicy(usdc(100));

      await expect(declareMandate(policy, { minRetainedBalance: usdc(1_000) })).rejects.toThrow();

      // Lowering it is fine, and raising it no longer is.
      //
      // That second half changed with the premium. The envelope is now priced
      // at purchase, so a floor raised afterwards is a deductible the vault
      // was never paid for — the same manoeuvre as tightening the cap, in the
      // other dimension. Widening is free because it can only reduce what the
      // vault owes.
      await declareMandate(policy, { minRetainedBalance: usdc(1) });
      await expect(declareMandate(policy, { minRetainedBalance: usdc(50) })).rejects.toThrow();
    });

    it('pays only the overshoot beyond the declared cap', async () => {
      // The design decision the whole trigger rests on. The holder said 10 at
      // a time; the agent moved 60. The first 10 is risk they declared they
      // were willing to run, so the vault owes 50 — a deductible the holder
      // authored themselves.
      const { policy, agent, agentAta } = await setupMandatedPolicy(usdc(100));
      await declareMandate(policy);
      await balanceCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601); // mandate matures
      await spend(agent, agentAta, usdc(60));
      await fileClaim(policy);
      await advanceClockBySeconds(context, 21_601); // agent-error lock

      // 51 is one more than the overshoot the program measured.
      await expect(payout(policy, agent.publicKey, usdc(51)).rpc()).rejects.toThrow();
      await payout(policy, agent.publicKey, usdc(50)).rpc();

      const record: any = await (program.account as any).agentErrorEvidenceRecord.fetch(
        agentErrorEvidencePda(policy)[0],
      );
      expect(record.observedDrop.toString()).toBe(usdc(60).toString());
      expect(record.breachExcess.toString()).toBe(usdc(50).toString());
      expect(record.breachKind).toBe(1); // BREACH_OUTFLOW_CAP
      expect(record.declaredMaxSingleOutflow.toString()).toBe(CAP.toString());

      const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(pol.state).toBe(2); // ClaimPaid
    });

    it('measures a breach of the retention floor when the cap was not crossed', async () => {
      // The agent kept every movement under the cap but emptied the account,
      // which is the other quantitative promise the holder made.
      const { policy, agent, agentAta } = await setupMandatedPolicy(usdc(9));
      await declareMandate(policy);
      await balanceCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await spend(agent, agentAta, usdc(9)); // under the 10 cap, floor is 5
      await fileClaim(policy);
      await advanceClockBySeconds(context, 21_601);

      await payout(policy, agent.publicKey, usdc(5)).rpc();

      const record: any = await (program.account as any).agentErrorEvidenceRecord.fetch(
        agentErrorEvidencePda(policy)[0],
      );
      expect(record.breachKind).toBe(2); // BREACH_RETAINED_FLOOR
      expect(record.breachExcess.toString()).toBe(usdc(5).toString());
    });

    it('refuses a movement that stayed inside the declared envelope', async () => {
      // The clean refusal, and it rests on the holder's own statement rather
      // than on which programs happened to appear in the transaction.
      const { policy, agent, agentAta } = await setupMandatedPolicy(usdc(100));
      await declareMandate(policy);
      await balanceCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await spend(agent, agentAta, usdc(8)); // under the cap, above the floor
      await fileClaim(policy);
      await advanceClockBySeconds(context, 21_601);

      await expect(payout(policy, agent.publicKey, usdc(8)).rpc()).rejects.toThrow();
    });

    it('refuses a breach too small to be worth an instruction', async () => {
      const { policy, agent, agentAta } = await setupMandatedPolicy(usdc(100));
      await declareMandate(policy);
      await balanceCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      // 10.5 out against a 10 cap: a real overshoot, below the 1 USDC floor.
      await spend(agent, agentAta, new BN(10_500_000));
      await fileClaim(policy);
      await advanceClockBySeconds(context, 21_601);

      await expect(payout(policy, agent.publicKey, new BN(500_000)).rpc()).rejects.toThrow();
    });

    it('refuses a mandate that had not matured when the claim was filed', async () => {
      // Without this a holder declares a convenient envelope after the fact
      // and claims against it in the next instruction.
      const { policy, agent, agentAta } = await setupMandatedPolicy(usdc(100));
      await declareMandate(policy);
      await balanceCheckpoint(policy, agent.publicKey);
      await spend(agent, agentAta, usdc(60));
      await fileClaim(policy); // filed before effective_at
      await advanceClockBySeconds(context, 21_601);

      await expect(payout(policy, agent.publicKey, usdc(50)).rpc()).rejects.toThrow();
    });

    it('refuses before the lock period has elapsed', async () => {
      const { policy, agent, agentAta } = await setupMandatedPolicy(usdc(100));
      await declareMandate(policy);
      await balanceCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await spend(agent, agentAta, usdc(60));
      await fileClaim(policy);

      await expect(payout(policy, agent.publicKey, usdc(50)).rpc()).rejects.toThrow();
    });

    it('refuses to settle a non-agent-error trigger on this path', async () => {
      const { policy, agent, agentAta } = await setupMandatedPolicy(usdc(100));
      await declareMandate(policy);
      await balanceCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await spend(agent, agentAta, usdc(60));
      await fileClaim(policy, 1); // exploit
      await advanceClockBySeconds(context, 21_601);

      await expect(payout(policy, agent.publicKey, usdc(50)).rpc()).rejects.toThrow();
    });

    it('measures staleness against the claim, not against now', async () => {
      // The trap this trigger would have walked straight into. The lock is six
      // hours and the checkpoint allowance is two, so bounding the checkpoint
      // age against `now` — as the exploit path does, where a one-hour lock
      // leaves an hour of slack — would make every payout here unsatisfiable.
      // This case only settles because the comparison is against
      // `claim_submitted_at`.
      const { policy, agent, agentAta } = await setupMandatedPolicy(usdc(100));
      await declareMandate(policy);
      await balanceCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await spend(agent, agentAta, usdc(60));
      await fileClaim(policy);
      // Well past MAX_MANDATE_CHECKPOINT_AGE measured from `now`.
      await advanceClockBySeconds(context, 21_601);

      await payout(policy, agent.publicKey, usdc(50)).rpc();
    });

    it('pays a proven agent-error claim only once', async () => {
      const { policy, agent, agentAta } = await setupMandatedPolicy(usdc(100));
      await declareMandate(policy);
      await balanceCheckpoint(policy, agent.publicKey);
      await advanceClockBySeconds(context, 3_601);
      await spend(agent, agentAta, usdc(60));
      await fileClaim(policy);
      await advanceClockBySeconds(context, 21_601);

      await payout(policy, agent.publicKey, usdc(50)).rpc();
      await expect(payout(policy, agent.publicKey, usdc(50)).rpc()).rejects.toThrow();
    });
  });
  // -------------------------------------------------------------------------
  // Admin handover — two steps, on purpose
  // -------------------------------------------------------------------------
  //
  // The admin is the only key that can pause the protocol or rotate the oracle
  // authority, and `update_config` used to set it outright. A mistyped pubkey
  // took effect immediately and irreversibly: no pause, no oracle rotation, no
  // recovery path in the program, with the vault still live.
  //
  // These run last and hand the role back at the end, so the shared config is
  // left exactly as the earlier tests set it up.
  describe('admin handover', () => {
    const candidate = Keypair.generate();

    // `propose_admin` makes the proposing admin the rent payer for the pending
    // PDA, so the candidate needs SOL before it can hand the role back.
    beforeAll(async () => {
      await airdropSol(context, candidate.publicKey);
    });

    it('refuses a proposal from someone who is not the admin', async () => {
      const [config] = configPda();
      const [pending] = pendingAdminPda();
      await expect(
        program.methods
          .proposeAdmin(candidate.publicKey)
          .accountsPartial({
            admin: holder.publicKey,
            config,
            pending,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([holder])
          .rpc(),
      ).rejects.toThrow();
    });

    it('refuses the zero key and the incumbent as candidates', async () => {
      const [config] = configPda();
      const [pending] = pendingAdminPda();
      for (const bad of [PublicKey.default, admin.publicKey]) {
        await expect(
          program.methods
            .proposeAdmin(bad)
            .accountsPartial({
              admin: admin.publicKey,
              config,
              pending,
              systemProgram: SystemProgram.programId,
            } as any)
            .signers([admin])
            .rpc(),
        ).rejects.toThrow();
      }
    });

    it('records a proposal without moving the role', async () => {
      const [config] = configPda();
      const [pending] = pendingAdminPda();

      await program.methods
        .proposeAdmin(candidate.publicKey)
        .accountsPartial({
          admin: admin.publicKey,
          config,
          pending,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([admin])
        .rpc();

      const rec: any = await (program.account as any).pendingAdminTransfer.fetch(pending);
      expect(rec.proposedAdmin.toBase58()).toBe(candidate.publicKey.toBase58());
      expect(rec.proposedBy.toBase58()).toBe(admin.publicKey.toBase58());

      // The whole point: proposing changes nothing until it is accepted.
      const cfg: any = await (program.account as any).protocolConfig.fetch(config);
      expect(cfg.admin.toBase58()).toBe(admin.publicKey.toBase58());
    });

    it('refuses acceptance from a key that was not proposed', async () => {
      const [config] = configPda();
      const [pending] = pendingAdminPda();
      await expect(
        program.methods
          .acceptAdmin()
          .accountsPartial({
            newAdmin: holder.publicKey,
            config,
            pending,
            rentRefund: admin.publicKey,
          } as any)
          .signers([holder])
          .rpc(),
      ).rejects.toThrow();
    });

    it('moves the role only when the proposed key signs, and refunds the proposer', async () => {
      const [config] = configPda();
      const [pending] = pendingAdminPda();

      await program.methods
        .acceptAdmin()
        .accountsPartial({
          newAdmin: candidate.publicKey,
          config,
          pending,
          rentRefund: admin.publicKey,
        } as any)
        .signers([candidate])
        .rpc();

      const cfg: any = await (program.account as any).protocolConfig.fetch(config);
      expect(cfg.admin.toBase58()).toBe(candidate.publicKey.toBase58());

      // Closed, so a second acceptance has nothing to replay against.
      const closed = await (program.account as any).pendingAdminTransfer
        .fetchNullable(pending)
        .catch(() => null);
      expect(closed).toBeNull();
    });

    it('locks out the previous admin once the handover completes', async () => {
      const [config] = configPda();
      await expect(
        program.methods
          .updateConfig(null, true, null)
          .accountsPartial({ admin: admin.publicKey, config } as any)
          .signers([admin])
          .rpc(),
      ).rejects.toThrow();
    });

    it('hands the role back, leaving the shared config as it was', async () => {
      const [config] = configPda();
      const [pending] = pendingAdminPda();

      await program.methods
        .proposeAdmin(admin.publicKey)
        .accountsPartial({
          admin: candidate.publicKey,
          config,
          pending,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([candidate])
        .rpc();

      await program.methods
        .acceptAdmin()
        .accountsPartial({
          newAdmin: admin.publicKey,
          config,
          pending,
          rentRefund: candidate.publicKey,
        } as any)
        .signers([admin])
        .rpc();

      const cfg: any = await (program.account as any).protocolConfig.fetch(config);
      expect(cfg.admin.toBase58()).toBe(admin.publicKey.toBase58());
    });
  });
});

if (!hasIdl) {
  describe('Covantic — Anchor integration', () => {
    it.skip('IDL not found at target/idl/covantic.json; run `anchor build` before testing', () => {});
  });
}
