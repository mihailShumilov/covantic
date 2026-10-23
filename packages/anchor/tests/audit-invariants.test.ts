import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import { agentMandateCommitment } from '@covantic/shared';
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
} from '@solana/spl-token';
import { BankrunProvider } from 'anchor-bankrun';
import { Clock, startAnchor, type ProgramTestContext, type BanksClient } from 'solana-bankrun';

/**
 * Audit invariants — executable, mutation-proved properties over the on-chain
 * program (vitest + solana-bankrun + anchor-bankrun + fast-check).
 *
 * Every test is named after the invariant ID it decides. Each block builds its
 * own bankrun context so the arithmetic it asserts is over a vault whose
 * numbers are known exactly. Nothing here mocks the settlement path: every
 * number asserted was read back from an account the program wrote.
 *
 * Constants below are copied from `programs/covantic/src/constants.rs` at the
 * audited commit. The suite assumes a PRODUCTION build (no `devnet-fast-lock`):
 * LOCK_EXPLOIT = 3600, LOCK_AGENT_ERROR = 21600, LOCK_GOVERNANCE_ATTACK = 7200.
 */

// ---------------------------------------------------------------------------
// Program constants (constants.rs @ audited commit)
// ---------------------------------------------------------------------------

const IDL_PATH = resolve(__dirname, '../target/idl/covantic.json');
const hasIdl = existsSync(IDL_PATH);
const loadIdl = (): Idl => JSON.parse(readFileSync(IDL_PATH, 'utf-8')) as Idl;
const PROGRAM_ID = new PublicKey(
  hasIdl
    ? ((loadIdl() as unknown as { address?: string }).address ??
        '52KrSMg3rsbtRw3FchxJ9jRwRzQmWcDzg1AiiHHHXz1D')
    : '52KrSMg3rsbtRw3FchxJ9jRwRzQmWcDzg1AiiHHHXz1D',
);

const SEED = {
  config: Buffer.from('covantic_config'),
  vault: Buffer.from('covantic_vault'),
  policy: Buffer.from('covantic_policy'),
  staker: Buffer.from('covantic_staker'),
  attestation: Buffer.from('covantic_attestation'),
  checkpoint: Buffer.from('covantic_checkpoint'),
  exploitEvidence: Buffer.from('covantic_exploit_evidence'),
  claimEvidence: Buffer.from('covantic_claim_evidence'),
  govBaseline: Buffer.from('covantic_gov_baseline'),
  authorityCheckpoint: Buffer.from('covantic_authority_checkpoint'),
  govEvidence: Buffer.from('covantic_gov_evidence'),
  mandate: Buffer.from('covantic_agent_mandate'),
  agentErrorEvidence: Buffer.from('covantic_agent_error_evidence'),
};

const USDC = 1_000_000n;
const usdc = (n: number | bigint): bigint => BigInt(n) * USDC;
const bn = (v: bigint | number): BN => new BN(v.toString());

const MIN_COVERAGE = 1_000_000n;
const MAX_COVERAGE = 1_000_000_000_000n;
const MIN_DURATION = 3_600n;
const MAX_DURATION = 30n * 24n * 3_600n;
const SECONDS_PER_YEAR = 365n * 24n * 3_600n;
const PREMIUM_BPS = [100n, 250n, 500n];
const MIN_PREMIUM = 1_000n;
const STAKER_SHARE_BPS = 7_000n;
const RESERVE_SHARE_BPS = 2_000n;
const LOCK: Record<number, number> = { 1: 3_600, 2: 3_600, 3: 21_600, 4: 7_200 };
const MAX_CHECKPOINT_AGE = 7_200;
const UNSTAKE_COOLDOWN = 48 * 3_600;
const MIN_PROVABLE_DROP_BPS = 5_000n;
const MIN_PROVABLE_MANDATE_BREACH = 1_000_000n;
const MANDATE_DECLARATION_DELAY = 3_600;
const GOVERNANCE_BASELINE_DELAY = 3_600;
const TRIGGER = { exploit: 1, oracle: 2, agentError: 3, governance: 4 } as const;
const STATE = { active: 0, claimPending: 1, claimPaid: 2, expired: 3, cancelled: 4 } as const;

/** Pyth receiver program (pyth-solana-receiver-sdk 2.0.0, default features). */
const PYTH_RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const configPda = () => pda([SEED.config]);
const vaultPda = () => pda([SEED.vault]);
const stakerPda = (s: PublicKey) => pda([SEED.staker, s.toBuffer()]);
const attestationPda = (a: PublicKey) => pda([SEED.attestation, a.toBuffer()]);
const checkpointPda = (p: PublicKey) => pda([SEED.checkpoint, p.toBuffer()]);
const exploitEvidencePda = (p: PublicKey) => pda([SEED.exploitEvidence, p.toBuffer()]);
const claimEvidencePda = (p: PublicKey) => pda([SEED.claimEvidence, p.toBuffer()]);
const govBaselinePda = (p: PublicKey) => pda([SEED.govBaseline, p.toBuffer()]);
const authorityCheckpointPda = (p: PublicKey) => pda([SEED.authorityCheckpoint, p.toBuffer()]);
const govEvidencePda = (p: PublicKey) => pda([SEED.govEvidence, p.toBuffer()]);
const mandatePda = (p: PublicKey) => pda([SEED.mandate, p.toBuffer()]);
const agentErrorEvidencePda = (p: PublicKey) => pda([SEED.agentErrorEvidence, p.toBuffer()]);
function policyPda(holder: PublicKey, id: BN): PublicKey {
  const buf = Buffer.alloc(8);
  id.toArrayLike(Buffer, 'le', 8).copy(buf);
  return pda([SEED.policy, holder.toBuffer(), buf]);
}

// ---------------------------------------------------------------------------
// Mandates / manifests
// ---------------------------------------------------------------------------

interface Mandate {
  maxSingleOutflow: BN;
  maxWindowOutflow: BN;
  windowSeconds: BN;
  minRetainedBalance: BN;
  allowedCounterparties: PublicKey[];
  allowedPrograms: PublicKey[];
  manifestHash: number[];
}

/** An envelope with the given single-outflow cap and retention floor. */
function mandate(capRaw: bigint, floorRaw = 0n): Mandate {
  const windowCap = capRaw > usdc(1_000_000) ? capRaw : usdc(1_000_000);
  return {
    maxSingleOutflow: bn(capRaw),
    maxWindowOutflow: bn(windowCap < capRaw ? capRaw : windowCap),
    windowSeconds: new BN(3_600),
    minRetainedBalance: bn(floorRaw),
    allowedCounterparties: [],
    allowedPrograms: [],
    manifestHash: Array.from(new Uint8Array(32)),
  };
}
const WIDE = () => mandate(usdc(1_000_000));

function mandateHash(m: Mandate): number[] {
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

function manifest(agent: PublicKey) {
  return {
    tokenOwner: agent,
    expectedDelegate: null,
    expectedCloseAuthority: null,
    programUpgradeAuthority: null,
    controller: null,
    controllerMinThreshold: 0,
    extraAuthorities: [],
    manifestHash: Array.from(Buffer.alloc(32, 7)),
  };
}

const bundle = (b: number) => ({ bundleHash: Array.from(Buffer.alloc(32, b)) });
const sig = (b: number) => Buffer.from(Array.from({ length: 64 }, (_, i) => (i + b) % 256));

// ---------------------------------------------------------------------------
// Error extraction
// ---------------------------------------------------------------------------

/** The Anchor error name a rejected transaction carried, or a best-effort tag. */
function errorCode(err: unknown): string {
  const e = err as {
    error?: { errorCode?: { code?: string } };
    code?: number;
    message?: string;
    logs?: string[];
  };
  if (e?.error?.errorCode?.code) return e.error.errorCode.code;
  const text = `${e?.message ?? String(err)}\n${(e?.logs ?? []).join('\n')}`;
  const named = text.match(/Error Code: (\w+)/);
  if (named) return named[1];
  if (typeof e?.code === 'number') return `custom:${e.code}`;
  const custom = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
  if (custom) return `custom:${parseInt(custom[1], 16)}`;
  const first = text.split('\n')[0];
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}

/** Await a rejection and return its error code; throw if it succeeded. */
async function rejected(p: Promise<unknown>, label = 'transaction'): Promise<string> {
  try {
    await p;
  } catch (err) {
    return errorCode(err);
  }
  throw new Error(`expected ${label} to be rejected, but it succeeded`);
}

const big = (v: { toString(): string }): bigint => BigInt(v.toString());

// ---------------------------------------------------------------------------
// Fixture — one bankrun context, one protocol instance
// ---------------------------------------------------------------------------

interface PayoutOverrides {
  oracle?: Keypair;
  accounts?: Record<string, PublicKey>;
}

class Fixture {
  context!: ProgramTestContext;
  banks!: BanksClient;
  provider!: BankrunProvider;
  program!: Program<Idl>;
  readonly admin = Keypair.generate();
  readonly oracle = Keypair.generate();
  readonly usdcMint = Keypair.generate();
  vaultAta!: PublicKey;

  static async start(): Promise<Fixture> {
    const fx = new Fixture();
    fx.context = await startAnchor(resolve(__dirname, '..'), [], []);
    fx.banks = fx.context.banksClient;
    fx.provider = new BankrunProvider(fx.context);
    // anchor-bankrun 0.4.1 constructs web3.js 1.95's `SendTransactionError`
    // with the pre-1.93 positional signature, so every rejection surfaces as
    // "Unknown action 'undefined'" and the Anchor error name is lost. Route
    // sends through `tryProcessTransaction` and attach the logs, which is what
    // `translateError` needs to recover `Error Code: <Name>`.
    const banks = fx.banks;
    const payer = fx.context.payer;
    (fx.provider as unknown as { sendAndConfirm: unknown }).sendAndConfirm = async (
      tx: Transaction,
      signers?: Keypair[],
    ): Promise<string> => {
      tx.feePayer = tx.feePayer ?? payer.publicKey;
      tx.recentBlockhash = (await banks.getLatestBlockhash())[0];
      signers?.forEach((s) => tx.partialSign(s));
      tx.partialSign(payer);
      const res = await banks.tryProcessTransaction(tx);
      if (res.result !== null) {
        const logs = res.meta?.logMessages ?? [];
        const err = new Error(`${res.result}\n${logs.join('\n')}`) as Error & { logs: string[] };
        err.logs = logs;
        throw err;
      }
      return Buffer.from(tx.signature ?? Buffer.alloc(64)).toString('hex');
    };
    fx.program = new Program(loadIdl(), fx.provider as unknown as AnchorProvider);
    fx.airdrop(fx.admin.publicKey);
    fx.airdrop(fx.oracle.publicKey);
    await fx.createMint(fx.usdcMint);
    fx.vaultAta = getAssociatedTokenAddressSync(fx.usdcMint.publicKey, vaultPda(), true);
    await fx.program.methods
      .initialize(fx.oracle.publicKey)
      .accountsPartial({
        admin: fx.admin.publicKey,
        config: configPda(),
        vault: vaultPda(),
        usdcMint: fx.usdcMint.publicKey,
        vaultTokenAccount: fx.vaultAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([fx.admin])
      .rpc();
    return fx;
  }

  // -- chain plumbing -------------------------------------------------------

  airdrop(pk: PublicKey, lamports = 100_000_000_000): void {
    this.context.setAccount(pk, {
      lamports,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
    });
  }

  async processTx(ixs: TransactionInstruction[], signers: Keypair[]): Promise<void> {
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = (await this.banks.getLatestBlockhash())[0];
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    await this.banks.processTransaction(tx);
  }

  async createMint(kp: Keypair): Promise<PublicKey> {
    const lamports = await getMinimumBalanceForRentExemptMint(this.provider.connection as any);
    await this.processTx(
      [
        SystemProgram.createAccount({
          fromPubkey: this.admin.publicKey,
          newAccountPubkey: kp.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(
          kp.publicKey,
          6,
          this.admin.publicKey,
          this.admin.publicKey,
          TOKEN_PROGRAM_ID,
        ),
      ],
      [this.admin, kp],
    );
    return kp.publicKey;
  }

  /** Create (idempotently) the ATA of `owner` for `mint` and mint `amount` into it. */
  async fundedAta(owner: PublicKey, amount: bigint, mint = this.usdcMint.publicKey): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, owner, true);
    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(this.admin.publicKey, ata, owner, mint),
    ];
    if (amount > 0n) ixs.push(createMintToInstruction(mint, ata, this.admin.publicKey, amount));
    await this.processTx(ixs, [this.admin]);
    return ata;
  }

  async mintTo(ata: PublicKey, amount: bigint, mint = this.usdcMint.publicKey): Promise<void> {
    await this.processTx([createMintToInstruction(mint, ata, this.admin.publicKey, amount)], [this.admin]);
  }

  /** A raw SPL transfer signed by the token account's owner (the agent moving funds). */
  async transfer(owner: Keypair, from: PublicKey, to: PublicKey, amount: bigint): Promise<void> {
    await this.processTx([createTransferInstruction(from, to, owner.publicKey, amount)], [this.admin, owner]);
  }

  async setOwner(owner: Keypair, ata: PublicKey, newOwner: PublicKey): Promise<void> {
    await this.processTx(
      [createSetAuthorityInstruction(ata, owner.publicKey, AuthorityType.AccountOwner, newOwner)],
      [this.admin, owner],
    );
  }

  async now(): Promise<bigint> {
    return (await this.banks.getClock()).unixTimestamp;
  }

  /** Advance one slot, so a byte-identical transaction gets a fresh blockhash. */
  async tick(): Promise<void> {
    const c = await this.banks.getClock();
    this.context.warpToSlot(c.slot + 1n);
  }

  async warp(seconds: number | bigint): Promise<void> {
    const current = await this.banks.getClock();
    this.context.warpToSlot(current.slot + 1n);
    const warped = await this.banks.getClock();
    this.context.setClock(
      new Clock(
        warped.slot,
        warped.epochStartTimestamp,
        warped.epoch,
        warped.leaderScheduleEpoch,
        current.unixTimestamp + BigInt(seconds),
      ),
    );
  }

  /** Warp so that the clock reads at least `target`. */
  async warpTo(target: bigint): Promise<void> {
    const now = await this.now();
    if (target > now) await this.warp(target - now);
    else await this.tick();
  }

  // -- readers --------------------------------------------------------------

  private acct(name: string) {
    return (this.program.account as any)[name];
  }
  async vault(): Promise<any> {
    return this.acct('insuranceVault').fetch(vaultPda());
  }
  async config(): Promise<any> {
    return this.acct('protocolConfig').fetch(configPda());
  }
  async policy(p: PublicKey): Promise<any> {
    return this.acct('insurancePolicy').fetch(p);
  }
  async checkpoint(p: PublicKey): Promise<any> {
    return this.acct('policyBalanceCheckpoint').fetch(checkpointPda(p));
  }
  async exploitRecord(p: PublicKey): Promise<any> {
    return this.acct('exploitEvidenceRecord').fetch(exploitEvidencePda(p));
  }
  async agentErrorRecord(p: PublicKey): Promise<any> {
    return this.acct('agentErrorEvidenceRecord').fetch(agentErrorEvidencePda(p));
  }
  async govRecord(p: PublicKey): Promise<any> {
    return this.acct('governanceEvidenceRecord').fetch(govEvidencePda(p));
  }
  async claimRecord(p: PublicKey): Promise<any> {
    return this.acct('claimEvidenceRecord').fetch(claimEvidencePda(p));
  }
  async ata(pk: PublicKey): Promise<bigint> {
    return (await getAccount(this.provider.connection as any, pk)).amount;
  }

  /** Recorded obligations: the four buckets that partition the vault's USDC. */
  static obligations(v: any): bigint {
    return big(v.totalStaked) + big(v.totalStakerRewards) + big(v.reserveFund) + big(v.protocolTreasury);
  }

  // -- staking ----------------------------------------------------------------

  stake(staker: Keypair, ata: PublicKey, amount: bigint) {
    return this.program.methods
      .stake(bn(amount))
      .accountsPartial({
        staker: staker.publicKey,
        config: configPda(),
        vault: vaultPda(),
        stakerPosition: stakerPda(staker.publicKey),
        stakerTokenAccount: ata,
        vaultTokenAccount: this.vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([staker])
      .rpc();
  }
  requestUnstake(staker: Keypair) {
    return this.program.methods
      .requestUnstake()
      .accountsPartial({ staker: staker.publicKey, stakerPosition: stakerPda(staker.publicKey) } as any)
      .signers([staker])
      .rpc();
  }
  executeUnstake(staker: Keypair, ata: PublicKey) {
    return this.program.methods
      .executeUnstake()
      .accountsPartial({
        staker: staker.publicKey,
        stakerPosition: stakerPda(staker.publicKey),
        vault: vaultPda(),
        vaultTokenAccount: this.vaultAta,
        stakerTokenAccount: ata,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([staker])
      .rpc();
  }
  claimRewards(staker: Keypair, ata: PublicKey) {
    return this.program.methods
      .claimRewards()
      .accountsPartial({
        staker: staker.publicKey,
        stakerPosition: stakerPda(staker.publicKey),
        vault: vaultPda(),
        vaultTokenAccount: this.vaultAta,
        stakerTokenAccount: ata,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([staker])
      .rpc();
  }

  // -- policies ---------------------------------------------------------------

  attest(agent: PublicKey, tier: number, m: Mandate, flat = 0n, signer = this.oracle, validFor = 3_600) {
    return this.program.methods
      .upsertAttestation(agent, tier, new BN(validFor), mandateHash(m), bn(flat))
      .accountsPartial({
        oracle: signer.publicKey,
        config: configPda(),
        attestation: attestationPda(agent),
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([signer])
      .rpc();
  }

  async nextPolicyPda(holder: PublicKey): Promise<{ policy: PublicKey; policyId: BN }> {
    const cfg = await this.config();
    const policyId = cfg.policyCounter as BN;
    return { policy: policyPda(holder, policyId), policyId };
  }

  createPolicyTx(
    holder: Keypair,
    holderAta: PublicKey,
    agent: PublicKey,
    coverage: bigint,
    duration: bigint | number,
    m: Mandate,
    policy: PublicKey,
  ) {
    return this.program.methods
      .createPolicy(bn(coverage), bn(duration), agent, m as any)
      .accountsPartial({
        holder: holder.publicKey,
        config: configPda(),
        vault: vaultPda(),
        attestation: attestationPda(agent),
        policy,
        mandate: mandatePda(policy),
        checkpoint: checkpointPda(policy),
        coveredTokenAccount: getAssociatedTokenAddressSync(this.usdcMint.publicKey, agent),
        usdcMint: this.usdcMint.publicKey,
        holderTokenAccount: holderAta,
        vaultTokenAccount: this.vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([holder]);
  }

  async createPolicy(
    holder: Keypair,
    holderAta: PublicKey,
    agent: PublicKey,
    coverage: bigint,
    duration: bigint | number,
    m: Mandate,
  ): Promise<{ policy: PublicKey; policyId: BN }> {
    const next = await this.nextPolicyPda(holder.publicKey);
    await this.createPolicyTx(holder, holderAta, agent, coverage, duration, m, next.policy).rpc();
    return next;
  }

  submitClaimOracle(policy: PublicKey, trigger: number, signer = this.oracle, tag = 3) {
    return this.program.methods
      .oracleSubmitClaim(trigger, sig(tag))
      .accountsPartial({ oracle: signer.publicKey, config: configPda(), policy } as any)
      .signers([signer])
      .rpc();
  }
  submitClaimHolder(holder: Keypair, policy: PublicKey, trigger: number) {
    return this.program.methods
      .submitClaim(trigger, sig(5))
      .accountsPartial({ holder: holder.publicKey, policy } as any)
      .signers([holder])
      .rpc();
  }

  checkpointBalance(policy: PublicKey, agent: PublicKey, cranker = this.admin, covered?: PublicKey) {
    return this.program.methods
      .checkpointBalance()
      .accountsPartial({
        cranker: cranker.publicKey,
        config: configPda(),
        policy,
        coveredTokenAccount: covered ?? getAssociatedTokenAddressSync(this.usdcMint.publicKey, agent),
        usdcMint: this.usdcMint.publicKey,
        checkpoint: checkpointPda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([cranker])
      .rpc();
  }
  checkpointAuthority(policy: PublicKey, agent: PublicKey, cranker = this.admin) {
    return this.program.methods
      .checkpointAuthority()
      .accountsPartial({
        cranker: cranker.publicKey,
        config: configPda(),
        policy,
        coveredTokenAccount: getAssociatedTokenAddressSync(this.usdcMint.publicKey, agent),
        usdcMint: this.usdcMint.publicKey,
        checkpoint: authorityCheckpointPda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([cranker])
      .rpc();
  }
  declareMandate(holder: Keypair, policy: PublicKey, agent: PublicKey, m: Mandate) {
    return this.program.methods
      .declareAgentMandate(m as any)
      .accountsPartial({
        holder: holder.publicKey,
        policy,
        mandate: mandatePda(policy),
        config: configPda(),
        coveredTokenAccount: getAssociatedTokenAddressSync(this.usdcMint.publicKey, agent),
        usdcMint: this.usdcMint.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([holder])
      .rpc();
  }
  declareBaseline(holder: Keypair, policy: PublicKey, agent: PublicKey) {
    return this.program.methods
      .declareGovernanceBaseline(manifest(agent) as any)
      .accountsPartial({
        holder: holder.publicKey,
        policy,
        baseline: govBaselinePda(policy),
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([holder])
      .rpc();
  }
  expirePolicy(policy: PublicKey, cranker = this.admin) {
    return this.program.methods
      .expirePolicy()
      .accountsPartial({ cranker: cranker.publicKey, policy, vault: vaultPda() } as any)
      .signers([cranker])
      .rpc();
  }
  cancelPolicy(holder: Keypair, policy: PublicKey, holderAta: PublicKey) {
    return this.program.methods
      .cancelPolicy()
      .accountsPartial({
        holder: holder.publicKey,
        policy,
        vault: vaultPda(),
        config: configPda(),
        vaultTokenAccount: this.vaultAta,
        holderTokenAccount: holderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([holder])
      .rpc();
  }

  // -- settlement paths (return the builder so callers can .rpc() and inspect) --

  private settle(method: string, args: unknown[], defaults: Record<string, PublicKey>, o: PayoutOverrides = {}) {
    const signer = o.oracle ?? this.oracle;
    const accounts = { ...defaults, ...(o.accounts ?? {}), oracle: signer.publicKey };
    return (this.program.methods as any)[method](...args)
      .accountsPartial(accounts)
      .signers([signer]);
  }

  payoutLegacy(policy: PublicKey, holderAta: PublicKey, amount: bigint, o?: PayoutOverrides) {
    return this.settle(
      'verifyAndPayout',
      [bn(amount)],
      {
        config: configPda(),
        policy,
        vault: vaultPda(),
        vaultTokenAccount: this.vaultAta,
        holderTokenAccount: holderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      o,
    );
  }
  payoutExploit(policy: PublicKey, agent: PublicKey, holderAta: PublicKey, amount: bigint, o?: PayoutOverrides) {
    return this.settle(
      'verifyAndPayoutExploit',
      [bn(amount), bundle(9)],
      {
        config: configPda(),
        policy,
        vault: vaultPda(),
        vaultTokenAccount: this.vaultAta,
        holderTokenAccount: holderAta,
        coveredTokenAccount: getAssociatedTokenAddressSync(this.usdcMint.publicKey, agent),
        usdcMint: this.usdcMint.publicKey,
        checkpoint: checkpointPda(policy),
        evidenceRecord: exploitEvidencePda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      },
      o,
    );
  }
  payoutAgentError(policy: PublicKey, agent: PublicKey, holderAta: PublicKey, amount: bigint, o?: PayoutOverrides) {
    return this.settle(
      'verifyAndPayoutAgentError',
      [bn(amount), bundle(6)],
      {
        config: configPda(),
        policy,
        vault: vaultPda(),
        vaultTokenAccount: this.vaultAta,
        holderTokenAccount: holderAta,
        coveredTokenAccount: getAssociatedTokenAddressSync(this.usdcMint.publicKey, agent),
        usdcMint: this.usdcMint.publicKey,
        mandate: mandatePda(policy),
        checkpoint: checkpointPda(policy),
        evidenceRecord: agentErrorEvidencePda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      },
      o,
    );
  }
  payoutGovernance(policy: PublicKey, agent: PublicKey, holderAta: PublicKey, amount: bigint, o?: PayoutOverrides) {
    return this.settle(
      'verifyAndPayoutGovernance',
      [bn(amount), bundle(4)],
      {
        config: configPda(),
        policy,
        vault: vaultPda(),
        vaultTokenAccount: this.vaultAta,
        holderTokenAccount: holderAta,
        coveredTokenAccount: getAssociatedTokenAddressSync(this.usdcMint.publicKey, agent),
        usdcMint: this.usdcMint.publicKey,
        baseline: govBaselinePda(policy),
        checkpoint: authorityCheckpointPda(policy),
        evidenceRecord: govEvidencePda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      },
      o,
    );
  }
  payoutV2(
    policy: PublicKey,
    holderAta: PublicKey,
    amount: bigint,
    priceUpdate: PublicKey,
    evidence: PriceEvidence,
    o?: PayoutOverrides,
  ) {
    return this.settle(
      'verifyAndPayoutV2',
      [
        bn(amount),
        {
          feedId: evidence.feedId,
          triggerBlockTime: bn(evidence.triggerBlockTime),
          executedPrice: bn(evidence.executedPrice),
          subjectQuantity: bn(evidence.subjectQuantity),
          subjectDecimals: evidence.subjectDecimals,
          bundleHash: Array.from(Buffer.alloc(32, 2)),
        },
      ],
      {
        config: configPda(),
        policy,
        vault: vaultPda(),
        vaultTokenAccount: this.vaultAta,
        holderTokenAccount: holderAta,
        priceUpdate,
        evidenceRecord: claimEvidencePda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      },
      o,
    );
  }

  /**
   * Fabricate a `PriceUpdateV2` account exactly as the Pyth receiver would
   * write it (owner = receiver program, Anchor discriminator, Borsh layout,
   * `VerificationLevel::Full`). Bankrun lets a test write any account, which is
   * the only way to drive `verify_and_payout_v2` without Wormhole guardians.
   * What this proves is the program's arithmetic *given* a guardian-verified
   * price; it says nothing about the receiver's signature checks.
   */
  async postPrice(feedId: number[], price: bigint, publishTime: bigint, expo = -8): Promise<PublicKey> {
    const kp = Keypair.generate();
    const disc = createHash('sha256').update('account:PriceUpdateV2').digest().subarray(0, 8);
    const buf = Buffer.alloc(8 + 32 + 1 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8);
    let o = 0;
    disc.copy(buf, o);
    o += 8;
    o += 32; // write_authority (zero)
    buf.writeUInt8(1, o); // VerificationLevel::Full
    o += 1;
    Buffer.from(feedId).copy(buf, o);
    o += 32;
    buf.writeBigInt64LE(price, o);
    o += 8;
    buf.writeBigUInt64LE(1n, o); // conf
    o += 8;
    buf.writeInt32LE(expo, o);
    o += 4;
    buf.writeBigInt64LE(publishTime, o);
    o += 8;
    buf.writeBigInt64LE(publishTime - 1n, o); // prev_publish_time
    o += 8;
    buf.writeBigInt64LE(price, o); // ema_price
    o += 8;
    buf.writeBigUInt64LE(1n, o); // ema_conf
    o += 8;
    buf.writeBigUInt64LE((await this.banks.getClock()).slot, o); // posted_slot
    this.context.setAccount(kp.publicKey, {
      lamports: 10_000_000,
      data: buf,
      owner: PYTH_RECEIVER,
      executable: false,
    });
    return kp.publicKey;
  }
}

interface PriceEvidence {
  feedId: number[];
  triggerBlockTime: bigint;
  executedPrice: bigint;
  subjectQuantity: bigint;
  subjectDecimals: number;
}

/** A funded actor: keypair plus its USDC ATA. */
interface Actor {
  kp: Keypair;
  ata: PublicKey;
}
async function actor(fx: Fixture, amount: bigint, sol = true): Promise<Actor> {
  const kp = Keypair.generate();
  if (sol) fx.airdrop(kp.publicKey);
  const ata = await fx.fundedAta(kp.publicKey, amount);
  return { kp, ata };
}

/** Build a claim-pending, lock-elapsed situation on each proof path. */
interface Scenario {
  holder: Actor;
  agent: Actor;
  policy: PublicKey;
  coverage: bigint;
  /** The program-side bound the payout must respect (drop / breach / seized / provable loss). */
  bound: bigint;
  priceUpdate?: PublicKey;
  evidence?: PriceEvidence;
}

const FEED = Array.from(Buffer.alloc(32, 0xab));

async function scenario(
  fx: Fixture,
  path: 'legacy' | 'exploit' | 'agentError' | 'governance' | 'v2',
  holder: Actor,
  opts: { coverage?: bigint; funding?: bigint; move?: bigint; cap?: bigint; attacker?: PublicKey } = {},
): Promise<Scenario> {
  const coverage = opts.coverage ?? usdc(100);
  const funding = opts.funding ?? usdc(100);
  const agent = await actor(fx, funding);
  const sink = await fx.fundedAta(Keypair.generate().publicKey, 0n);

  if (path === 'agentError') {
    const cap = opts.cap ?? usdc(10);
    const m = mandate(cap);
    await fx.attest(agent.kp.publicKey, 0, m);
    const { policy } = await fx.createPolicy(holder.kp, holder.ata, agent.kp.publicKey, coverage, 86_400, m);
    const move = opts.move ?? usdc(60);
    await fx.transfer(agent.kp, agent.ata, sink, move);
    await fx.submitClaimOracle(policy, TRIGGER.agentError);
    await fx.warp(LOCK[TRIGGER.agentError] + 1);
    return { holder, agent, policy, coverage, bound: move > cap ? move - cap : 0n };
  }

  await fx.attest(agent.kp.publicKey, 0, WIDE());
  const { policy } = await fx.createPolicy(holder.kp, holder.ata, agent.kp.publicKey, coverage, 86_400, WIDE());

  if (path === 'legacy') {
    await fx.submitClaimOracle(policy, TRIGGER.exploit);
    await fx.warp(LOCK[TRIGGER.exploit] + 1);
    return { holder, agent, policy, coverage, bound: coverage };
  }
  if (path === 'exploit') {
    const move = opts.move ?? usdc(90);
    await fx.transfer(agent.kp, agent.ata, sink, move);
    await fx.submitClaimOracle(policy, TRIGGER.exploit);
    await fx.warp(LOCK[TRIGGER.exploit] + 1);
    return { holder, agent, policy, coverage, bound: move };
  }
  if (path === 'governance') {
    await fx.declareBaseline(holder.kp, policy, agent.kp.publicKey);
    await fx.warp(GOVERNANCE_BASELINE_DELAY + 1);
    await fx.checkpointAuthority(policy, agent.kp.publicKey);
    await fx.setOwner(agent.kp, agent.ata, opts.attacker ?? Keypair.generate().publicKey);
    await fx.submitClaimOracle(policy, TRIGGER.governance);
    await fx.warp(LOCK[TRIGGER.governance] + 1);
    return { holder, agent, policy, coverage, bound: funding };
  }
  // v2: reference 100.00000000, executed 90.00000000, 100 tokens @ 6dp → 1,000 USDC provable
  await fx.submitClaimOracle(policy, TRIGGER.oracle);
  const pol = await fx.policy(policy);
  const t = big(pol.claimSubmittedAt);
  const priceUpdate = await fx.postPrice(FEED, 100n * 10n ** 8n, t);
  const evidence: PriceEvidence = {
    feedId: FEED,
    triggerBlockTime: t,
    executedPrice: 90n * 10n ** 8n,
    subjectQuantity: 100n * 10n ** 6n,
    subjectDecimals: 6,
  };
  await fx.warp(LOCK[TRIGGER.oracle] + 1);
  return { holder, agent, policy, coverage, bound: usdc(1_000), priceUpdate, evidence };
}

function payoutFor(fx: Fixture, path: Scenario & { path: string }, amount: bigint, o?: PayoutOverrides) {
  const s = path;
  switch (s.path) {
    case 'legacy':
      return fx.payoutLegacy(s.policy, s.holder.ata, amount, o);
    case 'exploit':
      return fx.payoutExploit(s.policy, s.agent.kp.publicKey, s.holder.ata, amount, o);
    case 'agentError':
      return fx.payoutAgentError(s.policy, s.agent.kp.publicKey, s.holder.ata, amount, o);
    case 'governance':
      return fx.payoutGovernance(s.policy, s.agent.kp.publicKey, s.holder.ata, amount, o);
    default:
      return fx.payoutV2(s.policy, s.holder.ata, amount, s.priceUpdate!, s.evidence!, o);
  }
}

const PATHS = ['legacy', 'exploit', 'agentError', 'governance', 'v2'] as const;
type Path = (typeof PATHS)[number];

// ===========================================================================
// INV-CKPT-02 — a permissionless checkpoint_balance cannot make a valid
// agent-error claim unpayable (lead's priority scenario)
// ===========================================================================

describe.skipIf(!hasIdl)('INV-CKPT-02 — checkpoint crank vs. a valid agent-error claim', () => {
  const CAP = usdc(10);
  const A = usdc(100);
  const MOVE = CAP + usdc(1); // cap + 1 USDC → overshoot exactly MIN_PROVABLE_MANDATE_BREACH

  /**
   * t0: create_policy (writes checkpoint amount A) → agent moves cap+1 (B) →
   * checkpoint_balance at t2 (pins A into prev_*) → oracle_submit_claim
   * (AgentError) at t3 ≈ t0 + 5 min → [arm: warp to t0 + 7201 and run
   * checkpoint_balance again] → warp to t3 + LOCK_AGENT_ERROR → payout.
   */
  async function drive(extraTick: boolean) {
    const fx = await Fixture.start();
    const staker = await actor(fx, usdc(1_000_000));
    await fx.stake(staker.kp, staker.ata, usdc(1_000_000));
    const holder = await actor(fx, usdc(10_000));
    const agent = await actor(fx, A);
    const sink = await fx.fundedAta(Keypair.generate().publicKey, 0n);
    const m = mandate(CAP);
    await fx.attest(agent.kp.publicKey, 0, m);
    const t0 = await fx.now();
    const { policy } = await fx.createPolicy(holder.kp, holder.ata, agent.kp.publicKey, usdc(100), 86_400, m);
    const written = await fx.checkpoint(policy);
    expect(big(written.amount)).toBe(A);

    await fx.warp(60);
    await fx.transfer(agent.kp, agent.ata, sink, MOVE); // balance B = A - (cap + 1)
    await fx.warp(60);
    await fx.checkpointBalance(policy, agent.kp.publicKey); // t2: pins A into prev_*
    const pinned = await fx.checkpoint(policy);
    expect(big(pinned.prevAmount)).toBe(A);
    expect(big(pinned.amount)).toBe(A - MOVE);

    await fx.warp(180);
    await fx.submitClaimOracle(policy, TRIGGER.agentError); // t3 ≈ t0 + 300
    const t3 = big((await fx.policy(policy)).claimSubmittedAt);

    let ckptAfterTick: any = null;
    if (extraTick) {
      await fx.warpTo(t0 + BigInt(MAX_CHECKPOINT_AGE) + 1n);
      await fx.checkpointBalance(policy, agent.kp.publicKey, staker.kp); // any cranker
      ckptAfterTick = await fx.checkpoint(policy);
    }

    await fx.warpTo(t3 + BigInt(LOCK[TRIGGER.agentError]));
    const vaultBefore = await fx.ata(fx.vaultAta);
    const overshoot = MOVE - CAP;
    let result: { ok: true } | { ok: false; code: string };
    try {
      await fx.payoutAgentError(policy, agent.kp.publicKey, holder.ata, overshoot).rpc();
      result = { ok: true };
    } catch (err) {
      result = { ok: false, code: errorCode(err) };
    }
    const vaultAfter = await fx.ata(fx.vaultAta);
    const pol = await fx.policy(policy);
    return { result, moved: vaultBefore - vaultAfter, state: pol.state as number, ckptAfterTick, overshoot };
  }

  it('INV-CKPT-02 control — without the extra crank tick the claim pays the overshoot', async () => {
    const r = await drive(false);
    expect(r.result).toEqual({ ok: true });
    expect(r.moved).toBe(r.overshoot);
    expect(r.state).toBe(STATE.claimPaid);
  }, 120_000);

  it('INV-CKPT-02 — one permissionless checkpoint tick after t0 + MAX_CHECKPOINT_AGE must not make the same claim unpayable', async () => {
    const r = await drive(true);
    // Diagnostic for the report: what the tick left in the checkpoint.
    // eslint-disable-next-line no-console
    console.log(
      `[INV-CKPT-02] after tick: amount=${r.ckptAfterTick.amount} prevAmount=${r.ckptAfterTick.prevAmount} ` +
        `unixTimestamp=${r.ckptAfterTick.unixTimestamp} prevUnixTimestamp=${r.ckptAfterTick.prevUnixTimestamp}; ` +
        `payout result=${JSON.stringify(r.result)} moved=${r.moved} state=${r.state}`,
    );
    expect(r.result).toEqual({ ok: true });
    expect(r.moved).toBe(r.overshoot);
    expect(r.state).toBe(STATE.claimPaid);
  }, 120_000);

  it('INV-CKPT-02 (governance) — two permissionless checkpoint_authority ticks after the claim must not make a valid governance claim unpayable', async () => {
    async function driveGov(ticks: number) {
      const fx = await Fixture.start();
      const staker = await actor(fx, usdc(1_000_000));
      await fx.stake(staker.kp, staker.ata, usdc(1_000_000));
      const holder = await actor(fx, usdc(10_000));
      const s = await scenario(fx, 'governance', holder); // lock already elapsed: t3 + 7201
      // Rewind is impossible; instead the ticks land after the lock, still inside
      // MAX_AUTHORITY_CHECKPOINT_AGE measured from the claim (that bound is
      // measured against claim_submitted_at, so the ticks cannot age it).
      for (let i = 0; i < ticks; i++) {
        await fx.warp(30);
        await fx.checkpointAuthority(s.policy, s.agent.kp.publicKey, staker.kp);
      }
      const before = await fx.ata(fx.vaultAta);
      let result: { ok: true } | { ok: false; code: string };
      try {
        await fx.payoutGovernance(s.policy, s.agent.kp.publicKey, s.holder.ata, s.bound).rpc();
        result = { ok: true };
      } catch (err) {
        result = { ok: false, code: errorCode(err) };
      }
      return { result, moved: before - (await fx.ata(fx.vaultAta)), bound: s.bound };
    }
    const control = await driveGov(0);
    expect(control.result).toEqual({ ok: true });
    expect(control.moved).toBe(control.bound);

    const one = await driveGov(1);
    const two = await driveGov(2);
    // eslint-disable-next-line no-console
    console.log(`[INV-CKPT-02/gov] control=${JSON.stringify(control.result)} oneTick=${JSON.stringify(one.result)} twoTicks=${JSON.stringify(two.result)}`);
    expect(one.result).toEqual({ ok: true });
    expect(two.result).toEqual({ ok: true });
  }, 180_000);

  it('INV-CKPT-02 (exploit) — checkpoint ticks inside the exploit window leave the claim payable', async () => {
    const fx = await Fixture.start();
    const staker = await actor(fx, usdc(1_000_000));
    await fx.stake(staker.kp, staker.ata, usdc(1_000_000));
    const holder = await actor(fx, usdc(10_000));
    const agent = await actor(fx, A);
    const sink = await fx.fundedAta(Keypair.generate().publicKey, 0n);
    await fx.attest(agent.kp.publicKey, 0, WIDE());
    const { policy } = await fx.createPolicy(holder.kp, holder.ata, agent.kp.publicKey, usdc(100), 86_400, WIDE());
    await fx.warp(60);
    await fx.transfer(agent.kp, agent.ata, sink, usdc(90));
    await fx.warp(60);
    await fx.submitClaimOracle(policy, TRIGGER.exploit);
    for (let i = 0; i < 3; i++) {
      await fx.warp(60);
      await fx.checkpointBalance(policy, agent.kp.publicKey, staker.kp);
    }
    await fx.warp(LOCK[TRIGGER.exploit]);
    const before = await fx.ata(fx.vaultAta);
    await fx.payoutExploit(policy, agent.kp.publicKey, holder.ata, usdc(90)).rpc();
    expect(before - (await fx.ata(fx.vaultAta))).toBe(usdc(90));
  }, 120_000);
});

// ===========================================================================
// INV-SOLV-01 — vault balance ≥ recorded obligations after any sequence
// ===========================================================================

/**
 * Obligations = total_staked + total_staker_rewards + reserve_fund +
 * protocol_treasury (state/insurance_vault.rs). Those four buckets are the
 * program's own partition of the vault token account: premiums land in the
 * last three (70/20/10), stakes in the first, and every outflow — payout
 * cascade, unstake, reward claim, cancellation refund — debits one of them.
 * `total_coverage` is exposure, not an obligation, and is deliberately not
 * included; fractional backing is the product.
 */
class SolvencyWorld {
  fx!: Fixture;
  stakers: Actor[] = [];
  holders: Actor[] = [];
  agents: Actor[] = [];
  sink!: PublicKey;
  policies: { pda: PublicKey; holder: number; agent: number; coverage: bigint; cap: bigint }[] = [];
  trace: string[] = [];
  identityBreaks: string[] = [];

  static async start(): Promise<SolvencyWorld> {
    const w = new SolvencyWorld();
    w.fx = await Fixture.start();
    for (let i = 0; i < 2; i++) w.stakers.push(await actor(w.fx, usdc(10_000_000)));
    for (let i = 0; i < 2; i++) w.holders.push(await actor(w.fx, usdc(10_000_000)));
    for (let i = 0; i < 6; i++) w.agents.push(await actor(w.fx, usdc(10_000), false));
    w.sink = await w.fx.fundedAta(Keypair.generate().publicKey, 0n);
    return w;
  }

  async assertSolvent(label: string): Promise<void> {
    const v = await this.fx.vault();
    const balance = await this.fx.ata(this.fx.vaultAta);
    const obligations = Fixture.obligations(v);
    if (balance < obligations) {
      throw new Error(
        `INV-SOLV-01 violated after "${label}": vault balance ${balance} < obligations ${obligations} ` +
          `(staked=${v.totalStaked} rewards=${v.totalStakerRewards} reserve=${v.reserveFund} treasury=${v.protocolTreasury})\n` +
          `trace:\n  ${this.trace.join('\n  ')}`,
      );
    }
    if (balance !== obligations) {
      this.identityBreaks.push(`${label}: balance ${balance} != obligations ${obligations}`);
    }
  }

  /** Run one instruction, swallow a program rejection, assert the invariant either way. */
  async step(label: string, fn: () => Promise<unknown>): Promise<boolean> {
    this.trace.push(label);
    let ok = true;
    try {
      await fn();
    } catch (err) {
      ok = false;
      this.trace.push(`  -> rejected: ${errorCode(err)}`);
    }
    await this.assertSolvent(label);
    return ok;
  }

  pick(idx: number) {
    return this.policies.length ? this.policies[idx % this.policies.length] : undefined;
  }
}

type Cmd = fc.AsyncCommand<Record<string, never>, SolvencyWorld>;

class StakeCmd implements Cmd {
  constructor(readonly s: number, readonly amount: number) {}
  check() {
    return true;
  }
  async run(_m: Record<string, never>, w: SolvencyWorld) {
    const st = w.stakers[this.s];
    await w.step(this.toString(), () => w.fx.stake(st.kp, st.ata, usdc(this.amount)));
  }
  toString() {
    return `stake(s${this.s}, ${this.amount} USDC)`;
  }
}
class RequestUnstakeCmd implements Cmd {
  constructor(readonly s: number) {}
  check() {
    return true;
  }
  async run(_m: Record<string, never>, w: SolvencyWorld) {
    await w.step(this.toString(), () => w.fx.requestUnstake(w.stakers[this.s].kp));
  }
  toString() {
    return `requestUnstake(s${this.s})`;
  }
}
class ExecuteUnstakeCmd implements Cmd {
  constructor(readonly s: number) {}
  check() {
    return true;
  }
  async run(_m: Record<string, never>, w: SolvencyWorld) {
    await w.fx.warp(UNSTAKE_COOLDOWN + 1);
    const st = w.stakers[this.s];
    await w.step(this.toString(), () => w.fx.executeUnstake(st.kp, st.ata));
  }
  toString() {
    return `warp(48h+1); executeUnstake(s${this.s})`;
  }
}
class ClaimRewardsCmd implements Cmd {
  constructor(readonly s: number) {}
  check() {
    return true;
  }
  async run(_m: Record<string, never>, w: SolvencyWorld) {
    const st = w.stakers[this.s];
    await w.step(this.toString(), () => w.fx.claimRewards(st.kp, st.ata));
  }
  toString() {
    return `claimRewards(s${this.s})`;
  }
}
class CreatePolicyCmd implements Cmd {
  constructor(
    readonly h: number,
    readonly coverage: number,
    readonly duration: number,
    readonly tier: number,
    readonly narrow: boolean,
  ) {}
  check() {
    return true;
  }
  async run(_m: Record<string, never>, w: SolvencyWorld) {
    if (w.policies.length >= w.agents.length) return;
    const agentIdx = w.policies.length;
    const agent = w.agents[agentIdx];
    const holder = w.holders[this.h];
    const cap = this.narrow ? usdc(10) : usdc(1_000_000);
    const m = mandate(cap);
    const attested = await w.step(`attest(a${agentIdx}, tier ${this.tier})`, () =>
      w.fx.attest(agent.kp.publicKey, this.tier, m),
    );
    if (!attested) return;
    const next = await w.fx.nextPolicyPda(holder.kp.publicKey);
    const ok = await w.step(this.toString(), () =>
      w.fx
        .createPolicyTx(holder.kp, holder.ata, agent.kp.publicKey, usdc(this.coverage), this.duration, m, next.policy)
        .rpc(),
    );
    if (ok) w.policies.push({ pda: next.policy, holder: this.h, agent: agentIdx, coverage: usdc(this.coverage), cap });
  }
  toString() {
    return `createPolicy(h${this.h}, ${this.coverage} USDC, ${this.duration}s, tier ${this.tier}, cap ${this.narrow ? '10' : 'wide'})`;
  }
}
class ExpirePolicyCmd implements Cmd {
  constructor(readonly i: number) {}
  check() {
    return true;
  }
  async run(_m: Record<string, never>, w: SolvencyWorld) {
    const p = w.pick(this.i);
    if (!p) return;
    const pol = await w.fx.policy(p.pda);
    await w.fx.warpTo(big(pol.expiryTime) + 1n);
    await w.step(this.toString(), () => w.fx.expirePolicy(p.pda));
  }
  toString() {
    return `warpToExpiry; expirePolicy(p${this.i})`;
  }
}
class CancelPolicyCmd implements Cmd {
  constructor(readonly i: number) {}
  check() {
    return true;
  }
  async run(_m: Record<string, never>, w: SolvencyWorld) {
    const p = w.pick(this.i);
    if (!p) return;
    const h = w.holders[p.holder];
    await w.step(this.toString(), () => w.fx.cancelPolicy(h.kp, p.pda, h.ata));
  }
  toString() {
    return `cancelPolicy(p${this.i})`;
  }
}
class SettleLegacyCmd implements Cmd {
  constructor(readonly i: number, readonly trigger: number, readonly bps: number) {}
  check() {
    return true;
  }
  async run(_m: Record<string, never>, w: SolvencyWorld) {
    const p = w.pick(this.i);
    if (!p) return;
    const filed = await w.step(`oracleSubmitClaim(p${this.i}, trigger ${this.trigger})`, () =>
      w.fx.submitClaimOracle(p.pda, this.trigger),
    );
    if (!filed) return;
    await w.fx.warp(LOCK[this.trigger] + 1);
    const ask = (p.coverage * BigInt(this.bps)) / 10_000n || 1n;
    const h = w.holders[p.holder];
    await w.step(this.toString(), () => w.fx.payoutLegacy(p.pda, h.ata, ask).rpc());
  }
  toString() {
    return `settleLegacy(p${this.i}, trigger ${this.trigger}, ${this.bps} bps of coverage)`;
  }
}
class SettleExploitCmd implements Cmd {
  constructor(readonly i: number, readonly drainBps: number, readonly overAsk: boolean) {}
  check() {
    return true;
  }
  async run(_m: Record<string, never>, w: SolvencyWorld) {
    const p = w.pick(this.i);
    if (!p) return;
    const agent = w.agents[p.agent];
    const h = w.holders[p.holder];
    await w.step(`checkpointBalance(p${this.i})`, () => w.fx.checkpointBalance(p.pda, agent.kp.publicKey));
    const bal = await w.fx.ata(agent.ata);
    const drain = (bal * BigInt(this.drainBps)) / 10_000n;
    if (drain > 0n) await w.step(`drain(a${p.agent}, ${drain})`, () => w.fx.transfer(agent.kp, agent.ata, w.sink, drain));
    const filed = await w.step(`oracleSubmitClaim(p${this.i}, exploit)`, () =>
      w.fx.submitClaimOracle(p.pda, TRIGGER.exploit),
    );
    if (!filed) return;
    await w.fx.warp(LOCK[TRIGGER.exploit] + 1);
    let ask = drain < p.coverage ? drain : p.coverage;
    if (ask === 0n) ask = 1n;
    if (this.overAsk) ask += 1n;
    await w.step(this.toString(), () => w.fx.payoutExploit(p.pda, agent.kp.publicKey, h.ata, ask).rpc());
  }
  toString() {
    return `settleExploit(p${this.i}, drain ${this.drainBps} bps${this.overAsk ? ', ask drop+1' : ''})`;
  }
}
class SettleAgentErrorCmd implements Cmd {
  constructor(readonly i: number, readonly spend: number) {}
  check() {
    return true;
  }
  async run(_m: Record<string, never>, w: SolvencyWorld) {
    const p = w.pick(this.i);
    if (!p) return;
    const agent = w.agents[p.agent];
    const h = w.holders[p.holder];
    await w.step(`checkpointBalance(p${this.i})`, () => w.fx.checkpointBalance(p.pda, agent.kp.publicKey));
    const bal = await w.fx.ata(agent.ata);
    const spend = usdc(this.spend) < bal ? usdc(this.spend) : bal;
    if (spend > 0n) await w.step(`spend(a${p.agent}, ${spend})`, () => w.fx.transfer(agent.kp, agent.ata, w.sink, spend));
    const filed = await w.step(`oracleSubmitClaim(p${this.i}, agentError)`, () =>
      w.fx.submitClaimOracle(p.pda, TRIGGER.agentError),
    );
    if (!filed) return;
    await w.fx.warp(LOCK[TRIGGER.agentError] + 1);
    const breach = spend > p.cap ? spend - p.cap : 0n;
    let ask = breach < p.coverage ? breach : p.coverage;
    if (ask === 0n) ask = 1n;
    await w.step(this.toString(), () => w.fx.payoutAgentError(p.pda, agent.kp.publicKey, h.ata, ask).rpc());
  }
  toString() {
    return `settleAgentError(p${this.i}, spend ${this.spend} USDC)`;
  }
}
class WarpCmd implements Cmd {
  constructor(readonly seconds: number) {}
  check() {
    return true;
  }
  async run(_m: Record<string, never>, w: SolvencyWorld) {
    await w.fx.warp(this.seconds);
  }
  toString() {
    return `warp(${this.seconds}s)`;
  }
}

const solvencyCommands = [
  fc.tuple(fc.integer({ min: 0, max: 1 }), fc.integer({ min: 1, max: 50_000 })).map(([s, a]) => new StakeCmd(s, a)),
  fc.integer({ min: 0, max: 1 }).map((s) => new RequestUnstakeCmd(s)),
  fc.integer({ min: 0, max: 1 }).map((s) => new ExecuteUnstakeCmd(s)),
  fc.integer({ min: 0, max: 1 }).map((s) => new ClaimRewardsCmd(s)),
  fc
    .tuple(
      fc.integer({ min: 0, max: 1 }),
      fc.integer({ min: 1, max: 20_000 }),
      fc.constantFrom(3_600, 86_400, 30 * 86_400),
      fc.integer({ min: 0, max: 2 }),
      fc.boolean(),
    )
    .map(([h, c, d, t, n]) => new CreatePolicyCmd(h, c, d, t, n)),
  fc.integer({ min: 0, max: 5 }).map((i) => new ExpirePolicyCmd(i)),
  fc.integer({ min: 0, max: 5 }).map((i) => new CancelPolicyCmd(i)),
  fc
    .tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 10_000 }))
    .map(([i, t, b]) => new SettleLegacyCmd(i, t, b)),
  fc
    .tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 5_000, max: 10_000 }), fc.boolean())
    .map(([i, d, o]) => new SettleExploitCmd(i, d, o)),
  fc.tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 1, max: 10_000 })).map(([i, s]) => new SettleAgentErrorCmd(i, s)),
  fc.constantFrom(60, 1_800, 3_600, 7_200, 86_400).map((s) => new WarpCmd(s)),
];

describe.skipIf(!hasIdl)('INV-SOLV-01 — solvency over generated instruction sequences', () => {
  it('INV-SOLV-01 — vault token balance ≥ total_staked + total_staker_rewards + reserve_fund + protocol_treasury after every step', async () => {
    const identity: string[] = [];
    let steps = 0;
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(fc.commands(solvencyCommands, { maxCommands: 14 }), async (cmds) => {
        let world: SolvencyWorld | undefined;
        await fc.asyncModelRun(async () => {
          world = await SolvencyWorld.start();
          return { model: {} as Record<string, never>, real: world };
        }, cmds);
        // Collect the accounting-identity observations from the world that ran.
        if (world) {
          identity.push(...world.identityBreaks);
          steps += world.trace.length;
          runs++;
        }
      }),
      { numRuns: 20, seed: 20260904, verbose: 1 },
    );
    // eslint-disable-next-line no-console
    console.log(`[INV-SOLV-01] ${runs} sequences, ${steps} steps asserted; identity breaks: ${identity.length}`);
    expect(identity).toEqual([]);
  }, 600_000);

  it('INV-SOLV-01b — the accounting identity is exact (balance == obligations) on a fixed adversarial sequence', async () => {
    // A hand-picked sequence covering every obligation-moving instruction:
    // stake, premium split, legacy + exploit + agent-error payouts through the
    // cascade, cancellation refund, expiry, reward claim, partial + full unstake.
    const w = await SolvencyWorld.start();
    const seq: Cmd[] = [
      new StakeCmd(0, 20_000),
      new StakeCmd(1, 5_000),
      new CreatePolicyCmd(0, 1_000, 86_400, 2, false),
      new CreatePolicyCmd(1, 3_000, 30 * 86_400, 1, true),
      new CreatePolicyCmd(0, 500, 3_600, 0, false),
      new CreatePolicyCmd(1, 7_000, 86_400, 0, false),
      new SettleLegacyCmd(0, 2, 10_000),
      new SettleAgentErrorCmd(1, 2_000),
      new CancelPolicyCmd(3),
      new ClaimRewardsCmd(0),
      new WarpCmd(3_601),
      new ExpirePolicyCmd(2),
      new CreatePolicyCmd(0, 2_000, 86_400, 0, false),
      new SettleExploitCmd(4, 9_000, false),
      new RequestUnstakeCmd(0),
      new RequestUnstakeCmd(1),
      new ExecuteUnstakeCmd(0),
      new ExecuteUnstakeCmd(1),
    ];
    for (const c of seq) await c.run({} as Record<string, never>, w);
    // eslint-disable-next-line no-console
    console.log(`[INV-SOLV-01b] trace:\n  ${w.trace.join('\n  ')}`);
    expect(w.identityBreaks).toEqual([]);
    const v = await w.fx.vault();
    expect(big(v.totalClaimsPaid)).toBeGreaterThan(0n);
  }, 300_000);
});

// ===========================================================================
// INV-CONS-01 — conservation on every settlement path
// ===========================================================================

describe.skipIf(!hasIdl)('INV-CONS-01 — conservation: vault decrease == holder increase == program-computed payout ≤ coverage', () => {
  async function world() {
    const fx = await Fixture.start();
    const staker = await actor(fx, usdc(50_000_000));
    await fx.stake(staker.kp, staker.ata, usdc(50_000_000));
    const holder = await actor(fx, usdc(1_000_000));
    return { fx, holder };
  }

  /** Snapshot balances, run the payout, and return what moved plus the outcome. */
  async function attempt(fx: Fixture, s: Scenario & { path: Path }, ask: bigint) {
    const vaultBefore = await fx.ata(fx.vaultAta);
    const holderBefore = await fx.ata(s.holder.ata);
    const v0 = await fx.vault();
    let code: string | null = null;
    try {
      await payoutFor(fx, s, ask).rpc();
    } catch (err) {
      code = errorCode(err);
    }
    const vaultAfter = await fx.ata(fx.vaultAta);
    const holderAfter = await fx.ata(s.holder.ata);
    const v1 = await fx.vault();
    const pol = await fx.policy(s.policy);
    return {
      code,
      vaultDrop: vaultBefore - vaultAfter,
      holderRise: holderAfter - holderBefore,
      claimsPaidDelta: big(v1.totalClaimsPaid) - big(v0.totalClaimsPaid),
      obligationsDrop: Fixture.obligations(v0) - Fixture.obligations(v1),
      state: pol.state as number,
      policyPayout: big(pol.payoutAmount),
    };
  }

  it('INV-CONS-01 (exploit) — payout == measured drop-bounded request, never above coverage or drop', async () => {
    const { fx, holder } = await world();
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          funding: fc.integer({ min: 2, max: 3_000 }),
          drainBps: fc.integer({ min: 4_990, max: 10_000 }),
          coverage: fc.integer({ min: 1, max: 3_000 }),
          askBps: fc.integer({ min: 1, max: 20_000 }),
        }),
        async ({ funding, drainBps, coverage, askBps }) => {
          const move = (usdc(funding) * BigInt(drainBps)) / 10_000n || 1n;
          const s = { ...(await scenario(fx, 'exploit', holder, { funding: usdc(funding), move, coverage: usdc(coverage) })), path: 'exploit' as Path };
          const ask = (s.coverage * BigInt(askBps)) / 10_000n || 1n;
          const dropBps = (move * 10_000n) / usdc(funding);
          const r = await attempt(fx, s, ask);
          // Program check order: coverage → minimum drop → drop bound.
          if (ask > s.coverage) {
            expect(r.code).toBe('PayoutExceedsCoverage');
          } else if (dropBps < MIN_PROVABLE_DROP_BPS) {
            expect(r.code).toBe('DropBelowMinimum');
          } else if (ask > move) {
            expect(r.code).toBe('PayoutExceedsObservedDrop');
          } else {
            expect(r.code).toBeNull();
            const rec = await fx.exploitRecord(s.policy);
            expect(r.vaultDrop).toBe(ask);
            expect(r.holderRise).toBe(ask);
            expect(big(rec.payoutAmount)).toBe(ask);
            expect(big(rec.observedDrop)).toBe(move); // the program's own subtraction
            expect(big(rec.checkpointAmount) - big(rec.currentAmount)).toBe(move);
            expect(r.policyPayout).toBe(ask);
            expect(r.claimsPaidDelta).toBe(ask);
            expect(r.obligationsDrop).toBe(ask);
            expect(r.state).toBe(STATE.claimPaid);
            expect(ask <= s.coverage).toBe(true);
          }
          if (r.code !== null) {
            expect(r.vaultDrop).toBe(0n);
            expect(r.holderRise).toBe(0n);
            expect(r.state).toBe(STATE.claimPending);
          }
        },
      ),
      { numRuns: 24, seed: 20260904 },
    );
  }, 600_000);

  it('INV-CONS-01 (agent-error) — payout == breach-bounded request; breach == drop − declared cap', async () => {
    const { fx, holder } = await world();
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          funding: fc.integer({ min: 20, max: 3_000 }),
          capUsdc: fc.integer({ min: 1, max: 50 }),
          moveUsdc: fc.integer({ min: 1, max: 3_000 }),
          coverage: fc.integer({ min: 1, max: 3_000 }),
          askBps: fc.integer({ min: 1, max: 20_000 }),
        }),
        async ({ funding, capUsdc, moveUsdc, coverage, askBps }) => {
          const move = usdc(Math.min(moveUsdc, funding));
          const cap = usdc(capUsdc);
          const s = {
            ...(await scenario(fx, 'agentError', holder, { funding: usdc(funding), move, cap, coverage: usdc(coverage) })),
            path: 'agentError' as Path,
          };
          const breach = move > cap ? move - cap : 0n;
          const ask = (s.coverage * BigInt(askBps)) / 10_000n || 1n;
          const r = await attempt(fx, s, ask);
          if (ask > s.coverage) {
            expect(r.code).toBe('PayoutExceedsCoverage');
          } else if (breach === 0n) {
            expect(r.code).toBe('OutflowWithinMandate');
          } else if (breach < MIN_PROVABLE_MANDATE_BREACH) {
            expect(r.code).toBe('BreachBelowMinimum');
          } else if (ask > breach) {
            expect(r.code).toBe('PayoutExceedsProvenBreach');
          } else {
            expect(r.code).toBeNull();
            const rec = await fx.agentErrorRecord(s.policy);
            expect(r.vaultDrop).toBe(ask);
            expect(r.holderRise).toBe(ask);
            expect(big(rec.payoutAmount)).toBe(ask);
            expect(big(rec.observedDrop)).toBe(move);
            expect(big(rec.breachExcess)).toBe(breach);
            expect(big(rec.declaredMaxSingleOutflow)).toBe(cap);
            expect(r.policyPayout).toBe(ask);
            expect(r.obligationsDrop).toBe(ask);
            expect(r.state).toBe(STATE.claimPaid);
          }
          if (r.code !== null) {
            expect(r.vaultDrop).toBe(0n);
            expect(r.holderRise).toBe(0n);
            expect(r.state).toBe(STATE.claimPending);
          }
        },
      ),
      { numRuns: 24, seed: 20260904 },
    );
  }, 600_000);

  it('INV-CONS-01 (legacy) — vault decrease == holder increase == request ≤ coverage; the third clause is unenforceable by design', async () => {
    const { fx, holder } = await world();
    await fc.assert(
      fc.asyncProperty(
        fc.record({ coverage: fc.integer({ min: 1, max: 3_000 }), askBps: fc.integer({ min: 1, max: 20_000 }) }),
        async ({ coverage, askBps }) => {
          const s = { ...(await scenario(fx, 'legacy', holder, { coverage: usdc(coverage) })), path: 'legacy' as Path };
          const ask = (s.coverage * BigInt(askBps)) / 10_000n || 1n;
          const r = await attempt(fx, s, ask);
          if (ask > s.coverage) {
            expect(r.code).toBe('PayoutExceedsCoverage');
            expect(r.vaultDrop).toBe(0n);
            expect(r.state).toBe(STATE.claimPending);
          } else {
            expect(r.code).toBeNull();
            expect(r.vaultDrop).toBe(ask);
            expect(r.holderRise).toBe(ask);
            expect(r.policyPayout).toBe(ask);
            expect(r.obligationsDrop).toBe(ask);
            expect(r.state).toBe(STATE.claimPaid);
          }
        },
      ),
      { numRuns: 16, seed: 20260904 },
    );
  }, 600_000);

  it('INV-CONS-01 (governance) — payout ≤ the seized balance the program read; moved == recorded', async () => {
    const { fx, holder } = await world();
    await fc.assert(
      fc.asyncProperty(
        fc.record({ funding: fc.integer({ min: 1, max: 3_000 }), coverage: fc.integer({ min: 1, max: 3_000 }), askBps: fc.integer({ min: 1, max: 20_000 }) }),
        async ({ funding, coverage, askBps }) => {
          const s = { ...(await scenario(fx, 'governance', holder, { funding: usdc(funding), coverage: usdc(coverage) })), path: 'governance' as Path };
          const ask = (s.coverage * BigInt(askBps)) / 10_000n || 1n;
          const r = await attempt(fx, s, ask);
          if (ask > s.coverage) {
            expect(r.code).toBe('PayoutExceedsCoverage');
          } else if (ask > s.bound) {
            expect(r.code).toBe('PayoutExceedsProvenGovernanceLoss');
          } else {
            expect(r.code).toBeNull();
            const rec = await fx.govRecord(s.policy);
            expect(r.vaultDrop).toBe(ask);
            expect(r.holderRise).toBe(ask);
            expect(big(rec.payoutAmount)).toBe(ask);
            expect(big(rec.seizedAmount)).toBe(s.bound);
            expect(big(rec.maxProvableLoss)).toBe(s.bound);
            expect(r.obligationsDrop).toBe(ask);
            expect(r.state).toBe(STATE.claimPaid);
          }
          if (r.code !== null) {
            expect(r.vaultDrop).toBe(0n);
            expect(r.holderRise).toBe(0n);
            expect(r.state).toBe(STATE.claimPending);
          }
        },
      ),
      { numRuns: 16, seed: 20260904 },
    );
  }, 600_000);

  it('INV-CONS-01 (v2) — payout ≤ the loss the signed price supports (fabricated PriceUpdateV2 in bankrun)', async () => {
    const { fx, holder } = await world();
    await fc.assert(
      fc.asyncProperty(
        fc.record({ coverage: fc.integer({ min: 1, max: 3_000 }), askBps: fc.integer({ min: 1, max: 20_000 }) }),
        async ({ coverage, askBps }) => {
          const s = { ...(await scenario(fx, 'v2', holder, { coverage: usdc(coverage) })), path: 'v2' as Path };
          const ask = (s.coverage * BigInt(askBps)) / 10_000n || 1n;
          const r = await attempt(fx, s, ask);
          // max_provable_loss = |exec - ref| * qty * 1e6 / (1e8 * 10^dec) = 1,000 USDC
          if (ask > s.coverage) {
            expect(r.code).toBe('PayoutExceedsCoverage');
          } else if (ask > s.bound) {
            expect(r.code).toBe('PayoutExceedsProvenLoss');
          } else {
            expect(r.code).toBeNull();
            const rec = await fx.claimRecord(s.policy);
            expect(r.vaultDrop).toBe(ask);
            expect(r.holderRise).toBe(ask);
            expect(big(rec.payoutAmount)).toBe(ask);
            expect(big(rec.maxProvableLoss)).toBe(s.bound);
            expect(rec.deviationBps).toBe(1_000);
            expect(r.obligationsDrop).toBe(ask);
            expect(r.state).toBe(STATE.claimPaid);
          }
          if (r.code !== null) {
            expect(r.vaultDrop).toBe(0n);
            expect(r.holderRise).toBe(0n);
            expect(r.state).toBe(STATE.claimPending);
          }
        },
      ),
      { numRuns: 12, seed: 20260904 },
    );
  }, 600_000);
});

// ===========================================================================
// INV-AUTH-01 / INV-AUTH-02 — authorization and account substitution
// ===========================================================================

describe.skipIf(!hasIdl)('INV-AUTH — oracle authority and account substitution on every settlement path', () => {
  it('INV-AUTH-01 — every settlement instruction rejects a signer that is not the stored oracle authority (and the real oracle then succeeds)', async () => {
    const fx = await Fixture.start();
    const staker = await actor(fx, usdc(1_000_000));
    await fx.stake(staker.kp, staker.ata, usdc(1_000_000));
    const holder = await actor(fx, usdc(100_000));
    const stranger = Keypair.generate();
    fx.airdrop(stranger.publicKey);
    const observed: Record<string, string> = {};

    for (const path of PATHS) {
      const s = { ...(await scenario(fx, path, holder)), path };
      const ask = s.bound < s.coverage ? s.bound : s.coverage;
      const before = await fx.ata(fx.vaultAta);
      observed[path] = await rejected(payoutFor(fx, s, ask, { oracle: stranger }).rpc(), `${path} by stranger`);
      expect(observed[path]).toBe('UnauthorizedOracle');
      expect(await fx.ata(fx.vaultAta)).toBe(before);
      expect((await fx.policy(s.policy)).state).toBe(STATE.claimPending);
      // Control: the identical call signed by the real oracle settles.
      await payoutFor(fx, s, ask).rpc();
      expect((await fx.policy(s.policy)).state).toBe(STATE.claimPaid);
    }

    // oracle_submit_claim
    const agent = await actor(fx, usdc(100));
    await fx.attest(agent.kp.publicKey, 0, WIDE());
    const { policy } = await fx.createPolicy(holder.kp, holder.ata, agent.kp.publicKey, usdc(100), 86_400, WIDE());
    observed.oracleSubmitClaim = await rejected(fx.submitClaimOracle(policy, TRIGGER.exploit, stranger));
    expect(observed.oracleSubmitClaim).toBe('UnauthorizedOracle');
    expect((await fx.policy(policy)).state).toBe(STATE.active);
    await fx.submitClaimOracle(policy, TRIGGER.exploit);

    // upsert_attestation — both a fresh agent (init) and a refresh (existing PDA)
    const fresh = Keypair.generate().publicKey;
    observed.upsertAttestationNew = await rejected(fx.attest(fresh, 0, WIDE(), 0n, stranger));
    observed.upsertAttestationRefresh = await rejected(fx.attest(agent.kp.publicKey, 2, WIDE(), 0n, stranger));
    expect(observed.upsertAttestationNew).toBe('UnauthorizedOracle');
    expect(observed.upsertAttestationRefresh).toBe('UnauthorizedOracle');
    const att: any = await (fx.program.account as any).riskAttestation.fetch(attestationPda(agent.kp.publicKey));
    expect(att.tier).toBe(0);
    // eslint-disable-next-line no-console
    console.log(`[INV-AUTH-01] ${JSON.stringify(observed)}`);
  }, 300_000);

  it('INV-AUTH-02 — substituted accounts are rejected on every settlement path (wrong mint, attacker ATA, wrong policy, foreign checkpoint, wrong vault ATA)', async () => {
    const fx = await Fixture.start();
    const staker = await actor(fx, usdc(1_000_000));
    await fx.stake(staker.kp, staker.ata, usdc(1_000_000));
    const holder = await actor(fx, usdc(100_000));
    const holder2 = await actor(fx, usdc(100_000));
    const attacker = await actor(fx, usdc(1));
    const fakeMint = await fx.createMint(Keypair.generate());
    const holderFakeAta = await fx.fundedAta(holder.kp.publicKey, usdc(1_000), fakeMint);
    const vaultFakeAta = await fx.fundedAta(vaultPda(), usdc(1_000), fakeMint); // owner = vault PDA, wrong mint

    const observed: string[] = [];
    for (const path of PATHS) {
      // Two claim-pending policies on the same path: A is the target; B belongs
      // to another holder, so "settle B but pay A's ATA" is a substitution,
      // not merely a valid settlement of B.
      // B first: the exploit path measures checkpoint age against `now`, and
      // building a second scenario warps the clock past a lock.
      const b = { ...(await scenario(fx, path, holder2)), path };
      const a = { ...(await scenario(fx, path, holder)), path };
      const ask = a.bound < a.coverage ? a.bound : a.coverage;
      const agentAta = getAssociatedTokenAddressSync(fx.usdcMint.publicKey, a.agent.kp.publicKey);

      const subs: Record<string, Record<string, PublicKey>> = {
        holderAtaOwnedByAttacker: { holderTokenAccount: attacker.ata },
        holderAtaWrongMint: { holderTokenAccount: holderFakeAta },
        vaultAtaNotVaultOwned: { vaultTokenAccount: staker.ata },
        vaultAtaWrongMint: { vaultTokenAccount: vaultFakeAta },
        otherPolicyPda: { policy: b.policy },
      };
      if (path === 'exploit' || path === 'agentError' || path === 'governance') {
        subs.coveredAtaIsHolders = { coveredTokenAccount: holder.ata };
        subs.coveredAtaIsAttackers = { coveredTokenAccount: attacker.ata };
        subs.foreignCheckpointPda = {
          checkpoint: path === 'governance' ? authorityCheckpointPda(b.policy) : checkpointPda(b.policy),
        };
        subs.foreignEvidencePda = {
          evidenceRecord:
            path === 'governance'
              ? govEvidencePda(b.policy)
              : path === 'exploit'
                ? exploitEvidencePda(b.policy)
                : agentErrorEvidencePda(b.policy),
        };
        subs.wrongMintAccount = { usdcMint: fakeMint };
      }
      if (path === 'agentError') subs.foreignMandatePda = { mandate: mandatePda(b.policy) };
      if (path === 'governance') subs.foreignBaselinePda = { baseline: govBaselinePda(b.policy) };
      if (path === 'v2') {
        subs.priceUpdateOwnedByTokenProgram = { priceUpdate: agentAta };
        subs.priceUpdateForeignFeed = { priceUpdate: await fx.postPrice(Array.from(Buffer.alloc(32, 0xcd)), 100n * 10n ** 8n, a.evidence!.triggerBlockTime) };
        subs.foreignEvidencePda = { evidenceRecord: claimEvidencePda(b.policy) };
      }

      for (const [name, accounts] of Object.entries(subs)) {
        const vaultBefore = await fx.ata(fx.vaultAta);
        const holderBefore = await fx.ata(holder.ata);
        const attackerBefore = await fx.ata(attacker.ata);
        const code = await rejected(payoutFor(fx, a, ask, { accounts }).rpc(), `${path}/${name}`);
        observed.push(`${path}/${name} -> ${code}`);
        expect(await fx.ata(fx.vaultAta)).toBe(vaultBefore);
        expect(await fx.ata(holder.ata)).toBe(holderBefore);
        expect(await fx.ata(attacker.ata)).toBe(attackerBefore);
        expect((await fx.policy(a.policy)).state).toBe(STATE.claimPending);
        expect((await fx.policy(b.policy)).state).toBe(STATE.claimPending);
      }
      // Control: the un-substituted call settles A.
      await payoutFor(fx, a, ask).rpc();
      expect((await fx.policy(a.policy)).state).toBe(STATE.claimPaid);
    }
    // eslint-disable-next-line no-console
    console.log(`[INV-AUTH-02]\n  ${observed.join('\n  ')}`);
    expect(observed.length).toBeGreaterThanOrEqual(5 * PATHS.length);
  }, 600_000);
});

// ===========================================================================
// INV-STATE-01 — terminal states absorb; no double settlement
// ===========================================================================

describe.skipIf(!hasIdl)('INV-STATE-01 — state machine: replay, double settlement, terminal states, expiry of a pending claim', () => {
  it('INV-STATE-01 — replay and second settlement fail; ClaimPaid/Expired/Cancelled reject every mutating instruction; expire_policy refuses ClaimPending', async () => {
    const fx = await Fixture.start();
    const staker = await actor(fx, usdc(1_000_000));
    await fx.stake(staker.kp, staker.ata, usdc(1_000_000));
    const holder = await actor(fx, usdc(100_000));
    const observed: string[] = [];

    // A bystander policy with large coverage stays Active throughout. Without
    // it, a second settlement of a ClaimPaid policy would be refused by the
    // `total_coverage.checked_sub(coverage_amount)` underflow rather than by the
    // state check — and a mutant with the state check removed stayed green.
    const bystanderAgent = await actor(fx, usdc(1));
    await fx.attest(bystanderAgent.kp.publicKey, 0, WIDE());
    await fx.createPolicy(holder.kp, holder.ata, bystanderAgent.kp.publicKey, usdc(50_000), 30 * 86_400, WIDE());

    // -- replay of a successful exploit settlement --------------------------
    const ex = { ...(await scenario(fx, 'exploit', holder)), path: 'exploit' as Path };
    const builder = payoutFor(fx, ex, ex.bound);
    await builder.rpc();
    await fx.tick(); // fresh blockhash, so this is a genuine re-execution, not a duplicate-tx rejection
    const vaultAfterFirst = await fx.ata(fx.vaultAta);
    observed.push(`replay exploit -> ${await rejected(payoutFor(fx, ex, ex.bound).rpc())}`);
    observed.push(`second settlement via legacy on ClaimPaid -> ${await rejected(fx.payoutLegacy(ex.policy, holder.ata, 1n).rpc())}`);
    observed.push(`second settlement via agent-error on ClaimPaid -> ${await rejected(fx.payoutAgentError(ex.policy, ex.agent.kp.publicKey, holder.ata, 1n).rpc())}`);
    expect(await fx.ata(fx.vaultAta)).toBe(vaultAfterFirst);
    expect((await fx.policy(ex.policy)).state).toBe(STATE.claimPaid);
    expect(big((await fx.policy(ex.policy)).payoutAmount)).toBe(ex.bound);

    // -- terminal states --------------------------------------------------
    const mk = async () => {
      const agent = await actor(fx, usdc(100));
      await fx.attest(agent.kp.publicKey, 0, WIDE());
      const { policy } = await fx.createPolicy(holder.kp, holder.ata, agent.kp.publicKey, usdc(100), 3_600, WIDE());
      return { agent, policy };
    };
    const expired = await mk();
    await fx.warp(3_601);
    await fx.expirePolicy(expired.policy);
    const cancelled = await mk();
    await fx.cancelPolicy(holder.kp, cancelled.policy, holder.ata);
    const terminal = [
      { name: 'ClaimPaid', ...ex },
      { name: 'Expired', ...expired },
      { name: 'Cancelled', ...cancelled },
    ];
    const attempts = (p: PublicKey, agent: PublicKey): [string, () => Promise<unknown>][] => [
      ['submit_claim(holder)', () => fx.submitClaimHolder(holder.kp, p, TRIGGER.exploit)],
      ['oracle_submit_claim', () => fx.submitClaimOracle(p, TRIGGER.exploit)],
      ['verify_and_payout', () => fx.payoutLegacy(p, holder.ata, 1n).rpc()],
      ['verify_and_payout_exploit', () => fx.payoutExploit(p, agent, holder.ata, 1n).rpc()],
      ['verify_and_payout_agent_error', () => fx.payoutAgentError(p, agent, holder.ata, 1n).rpc()],
      ['verify_and_payout_governance', () => fx.payoutGovernance(p, agent, holder.ata, 1n).rpc()],
      ['cancel_policy', () => fx.cancelPolicy(holder.kp, p, holder.ata)],
      ['expire_policy', () => fx.expirePolicy(p)],
      ['checkpoint_balance', () => fx.checkpointBalance(p, agent)],
      ['declare_agent_mandate', () => fx.declareMandate(holder.kp, p, agent, WIDE())],
    ];
    for (const t of terminal) {
      const stateBefore = (await fx.policy(t.policy)).state;
      for (const [name, run] of attempts(t.policy, t.agent.kp.publicKey)) {
        const vaultBefore = await fx.ata(fx.vaultAta);
        const covBefore = big((await fx.vault()).totalCoverage);
        observed.push(`${t.name}/${name} -> ${await rejected(run(), `${t.name}/${name}`)}`);
        expect((await fx.policy(t.policy)).state).toBe(stateBefore);
        expect(await fx.ata(fx.vaultAta)).toBe(vaultBefore);
        expect(big((await fx.vault()).totalCoverage)).toBe(covBefore);
      }
    }

    // -- expire_policy on a ClaimPending policy -------------------------------
    // Intended behaviour (expire_policy.rs: `require!(state == STATE_ACTIVE)`):
    // a pending claim is NOT expirable; the policy stays ClaimPending past
    // expiry_time, its coverage stays in total_coverage, and the claim can
    // still be settled after expiry_time because no settlement path checks it.
    const pending = await mk();
    await fx.submitClaimOracle(pending.policy, TRIGGER.exploit);
    await fx.warp(3_601 + LOCK[TRIGGER.exploit]); // past expiry_time AND past the lock
    const covBefore = big((await fx.vault()).totalCoverage);
    const codeExpire = await rejected(fx.expirePolicy(pending.policy));
    observed.push(`expire_policy on ClaimPending (past expiry_time) -> ${codeExpire}`);
    expect(codeExpire).toBe('PolicyNotActive');
    expect((await fx.policy(pending.policy)).state).toBe(STATE.claimPending);
    expect(big((await fx.vault()).totalCoverage)).toBe(covBefore);
    // …and the pending claim remains settleable after expiry_time.
    await fx.payoutLegacy(pending.policy, holder.ata, usdc(1)).rpc();
    expect((await fx.policy(pending.policy)).state).toBe(STATE.claimPaid);
    expect(big((await fx.vault()).totalCoverage)).toBe(covBefore - usdc(100));

    // eslint-disable-next-line no-console
    console.log(`[INV-STATE-01]\n  ${observed.join('\n  ')}`);
  }, 600_000);
});

// ===========================================================================
// INV-ARITH-01 — premium boundaries, exact split, u64 boundaries on the
// exploit drop and the mandate overshoot
// ===========================================================================

function expectedPremium(coverage: bigint, duration: bigint, tier: number, flat: bigint, mult = 10_000n): bigint {
  const annual = (coverage * PREMIUM_BPS[tier]) / 10_000n;
  const tierPremium = (annual * duration) / SECONDS_PER_YEAR;
  const p = ((tierPremium + flat) * mult) / 10_000n;
  return p < MIN_PREMIUM ? MIN_PREMIUM : p;
}

describe.skipIf(!hasIdl)('INV-ARITH-01 — arithmetic at the boundaries', () => {
  it('INV-ARITH-01 (premium) — never wraps or saturates at MIN/MAX coverage × min/max duration × every tier × flat ∈ {0, coverage}; 70/20/10 sums exactly', async () => {
    const fx = await Fixture.start();
    // 10^15 base units staked so a run of MAX-coverage policies never trips the solvency ladder.
    const staker = await actor(fx, 1_000_000_000_000_000n);
    await fx.stake(staker.kp, staker.ata, 1_000_000_000_000_000n);
    const holder = await actor(fx, 500_000_000_000_000n);
    const agent = await actor(fx, usdc(1));

    const check = async (coverage: bigint, duration: bigint, tier: number, flat: bigint) => {
      await fx.attest(agent.kp.publicKey, tier, WIDE(), flat);
      const v0 = await fx.vault();
      const h0 = await fx.ata(holder.ata);
      const vb0 = await fx.ata(fx.vaultAta);
      const { policy } = await fx.createPolicy(holder.kp, holder.ata, agent.kp.publicKey, coverage, duration, WIDE());
      const pol = await fx.policy(policy);
      const v1 = await fx.vault();
      const premium = big(pol.premiumPaid);
      // Differential: independent BigInt implementation of the documented formula.
      expect(premium).toBe(expectedPremium(coverage, duration, tier, flat));
      expect(premium).toBeGreaterThanOrEqual(MIN_PREMIUM);
      expect(premium).toBeLessThanOrEqual(coverage + coverage / 10n); // sanity: no wrap into a huge number
      // Conservation of the premium.
      expect(h0 - (await fx.ata(holder.ata))).toBe(premium);
      expect((await fx.ata(fx.vaultAta)) - vb0).toBe(premium);
      const stakerShare = big(v1.totalStakerRewards) - big(v0.totalStakerRewards);
      const reserveShare = big(v1.reserveFund) - big(v0.reserveFund);
      const protocolShare = big(v1.protocolTreasury) - big(v0.protocolTreasury);
      // Dust rule: stakers and reserve are floored, the treasury takes the remainder.
      expect(stakerShare).toBe((premium * STAKER_SHARE_BPS) / 10_000n);
      expect(reserveShare).toBe((premium * RESERVE_SHARE_BPS) / 10_000n);
      expect(stakerShare + reserveShare + protocolShare).toBe(premium);
      expect(big(v1.totalPremiumsCollected) - big(v0.totalPremiumsCollected)).toBe(premium);
      expect(big(v1.totalCoverage) - big(v0.totalCoverage)).toBe(coverage);
      expect(big(pol.expiryTime) - big(pol.startTime)).toBe(duration);
      return premium;
    };

    const coverages = [MIN_COVERAGE, MIN_COVERAGE + 1n, MAX_COVERAGE - 1n, MAX_COVERAGE];
    const durations = [MIN_DURATION, MIN_DURATION + 1n, MAX_DURATION - 1n, MAX_DURATION];
    let cases = 0;
    for (const c of coverages)
      for (const d of durations)
        for (const tier of [0, 1, 2])
          for (const flat of [0n, c]) {
            await check(c, d, tier, flat);
            cases++;
          }
    // Random interior points, shrinkable.
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          coverage: fc.bigInt({ min: MIN_COVERAGE, max: MAX_COVERAGE }),
          duration: fc.bigInt({ min: MIN_DURATION, max: MAX_DURATION }),
          tier: fc.integer({ min: 0, max: 2 }),
          flatBps: fc.integer({ min: 0, max: 10_000 }),
        }),
        async ({ coverage, duration, tier, flatBps }) => {
          await check(coverage, duration, tier, (coverage * BigInt(flatBps)) / 10_000n);
          cases++;
        },
      ),
      { numRuns: 30, seed: 20260904 },
    );

    // Off-by-one rejections at every bound.
    await fx.attest(agent.kp.publicKey, 0, WIDE(), 0n);
    const tryCreate = (c: bigint, d: bigint) =>
      fx.nextPolicyPda(holder.kp.publicKey).then((n) =>
        fx.createPolicyTx(holder.kp, holder.ata, agent.kp.publicKey, c, d, WIDE(), n.policy).rpc(),
      );
    expect(await rejected(tryCreate(MIN_COVERAGE - 1n, MIN_DURATION))).toBe('CoverageTooLow');
    expect(await rejected(tryCreate(MAX_COVERAGE + 1n, MIN_DURATION))).toBe('CoverageTooHigh');
    expect(await rejected(tryCreate(MIN_COVERAGE, MIN_DURATION - 1n))).toBe('DurationTooShort');
    expect(await rejected(tryCreate(MIN_COVERAGE, MAX_DURATION + 1n))).toBe('DurationTooLong');
    expect(await rejected(tryCreate(0n, MIN_DURATION))).toBe('CoverageTooLow');
    expect(await rejected(tryCreate(18_446_744_073_709_551_615n, MIN_DURATION))).toBe('CoverageTooHigh');
    // flat premium one above coverage is refused; equal is accepted (checked above).
    await fx.attest(agent.kp.publicKey, 0, WIDE(), MIN_COVERAGE + 1n);
    expect(await rejected(tryCreate(MIN_COVERAGE, MIN_DURATION))).toBe('InvalidRiskTier');
    // eslint-disable-next-line no-console
    console.log(`[INV-ARITH-01/premium] ${cases} accepted cases checked exactly`);
  }, 600_000);

  it('INV-ARITH-01 (exploit drop at u64 boundary) — observed_drop and drop_bps are exact for a 2^64-scale balance', async () => {
    const fx = await Fixture.start();
    const staker = await actor(fx, usdc(1_000_000));
    await fx.stake(staker.kp, staker.ata, usdc(1_000_000));
    const holder = await actor(fx, usdc(100_000));
    const U64_MAX = 18_446_744_073_709_551_615n;
    const funding = U64_MAX - usdc(3_000_000); // leaves room in the mint's u64 supply
    const agent = await actor(fx, funding);
    const sink = await fx.fundedAta(Keypair.generate().publicKey, 0n);
    await fx.attest(agent.kp.publicKey, 0, WIDE());
    const { policy } = await fx.createPolicy(holder.kp, holder.ata, agent.kp.publicKey, MAX_COVERAGE, 86_400, WIDE());
    await fx.transfer(agent.kp, agent.ata, sink, funding - 1n);
    await fx.submitClaimOracle(policy, TRIGGER.exploit);
    await fx.warp(LOCK[TRIGGER.exploit] + 1);
    const before = await fx.ata(fx.vaultAta);
    // Above the drop-bounded coverage: refused; exactly coverage: paid.
    expect(await rejected(fx.payoutExploit(policy, agent.kp.publicKey, holder.ata, MAX_COVERAGE + 1n).rpc())).toBe(
      'PayoutExceedsCoverage',
    );
    await fx.payoutExploit(policy, agent.kp.publicKey, holder.ata, MAX_COVERAGE).rpc();
    const rec = await fx.exploitRecord(policy);
    expect(big(rec.checkpointAmount)).toBe(funding);
    expect(big(rec.currentAmount)).toBe(1n);
    expect(big(rec.observedDrop)).toBe(funding - 1n);
    expect(rec.dropBps).toBe(Number(((funding - 1n) * 10_000n) / funding));
    expect(before - (await fx.ata(fx.vaultAta))).toBe(MAX_COVERAGE);
  }, 300_000);

  it('INV-ARITH-01 (mandate overshoot at u64 boundary) — breach_excess == drop − cap exactly for a 2^64-scale balance', async () => {
    const fx = await Fixture.start();
    const staker = await actor(fx, usdc(1_000_000));
    await fx.stake(staker.kp, staker.ata, usdc(1_000_000));
    const holder = await actor(fx, usdc(100_000));
    const U64_MAX = 18_446_744_073_709_551_615n;
    const funding = U64_MAX - usdc(3_000_000);
    const agent = await actor(fx, funding);
    const sink = await fx.fundedAta(Keypair.generate().publicKey, 0n);
    const cap = usdc(1);
    const m = mandate(cap);
    await fx.attest(agent.kp.publicKey, 0, m);
    const { policy } = await fx.createPolicy(holder.kp, holder.ata, agent.kp.publicKey, MAX_COVERAGE, 86_400, m);
    await fx.transfer(agent.kp, agent.ata, sink, funding - 1n);
    await fx.submitClaimOracle(policy, TRIGGER.agentError);
    await fx.warp(LOCK[TRIGGER.agentError] + 1);
    const before = await fx.ata(fx.vaultAta);
    expect(await rejected(fx.payoutAgentError(policy, agent.kp.publicKey, holder.ata, MAX_COVERAGE + 1n).rpc())).toBe(
      'PayoutExceedsCoverage',
    );
    await fx.payoutAgentError(policy, agent.kp.publicKey, holder.ata, MAX_COVERAGE).rpc();
    const rec = await fx.agentErrorRecord(policy);
    expect(big(rec.observedDrop)).toBe(funding - 1n);
    expect(big(rec.breachExcess)).toBe(funding - 1n - cap);
    expect(rec.breachKind).toBe(1);
    expect(before - (await fx.ata(fx.vaultAta))).toBe(MAX_COVERAGE);
  }, 300_000);
});

// ===========================================================================
// INV-CKPT-01 — a permissionless checkpoint_balance re-run between claim and
// payout cannot INCREASE the payout (exploit and agent-error paths)
// ===========================================================================

describe.skipIf(!hasIdl)('INV-CKPT-01 — checkpoint re-runs and the payout bound', () => {
  type PostAction = { kind: 'rerun' | 'depositRerunWithdraw'; warp: number; deposit: number };

  /**
   * create_policy (checkpoint A) → agent moves `move` → claim at t3 → the
   * attacker's schedule of permissionless re-runs, each optionally wrapped in
   * a deposit/withdraw of `deposit` USDC that nets to zero → lock elapses →
   * payout attempts. `preClaimDeposit` runs the same deposit/checkpoint/
   * withdraw wrap BEFORE the claim instead, for the pre-claim variant.
   */
  async function drive(
    path: 'exploit' | 'agentError',
    funding: bigint,
    move: bigint,
    actions: PostAction[],
    opts: { cap?: bigint; preClaimDeposit?: bigint; quantify?: bigint } = {},
  ) {
    const cap = opts.cap ?? usdc(10);
    const fx = await Fixture.start();
    const staker = await actor(fx, usdc(10_000_000));
    await fx.stake(staker.kp, staker.ata, usdc(10_000_000));
    const holder = await actor(fx, usdc(100_000));
    const agent = await actor(fx, funding);
    const sink = await fx.fundedAta(Keypair.generate().publicKey, 0n);
    const m = path === 'agentError' ? mandate(cap) : WIDE();
    await fx.attest(agent.kp.publicKey, 0, m);
    const coverage = usdc(1_000_000);
    const { policy } = await fx.createPolicy(holder.kp, holder.ata, agent.kp.publicKey, coverage, 86_400, m);
    const preClaimBaseline = big((await fx.checkpoint(policy)).amount); // A, written by create_policy
    await fx.warp(60);
    if (move > 0n) await fx.transfer(agent.kp, agent.ata, sink, move);
    if (opts.preClaimDeposit) {
      await fx.warp(30);
      await fx.mintTo(agent.ata, opts.preClaimDeposit);
      await fx.checkpointBalance(policy, agent.kp.publicKey, staker.kp);
      await fx.transfer(agent.kp, agent.ata, sink, opts.preClaimDeposit);
    }
    await fx.warp(60);
    await fx.submitClaimOracle(policy, path === 'exploit' ? TRIGGER.exploit : TRIGGER.agentError);
    const t3 = big((await fx.policy(policy)).claimSubmittedAt);

    for (const a of actions) {
      await fx.warp(a.warp);
      if (a.kind === 'depositRerunWithdraw') {
        await fx.mintTo(agent.ata, usdc(a.deposit));
        await fx.checkpointBalance(policy, agent.kp.publicKey, staker.kp);
        await fx.transfer(agent.kp, agent.ata, sink, usdc(a.deposit)); // net zero
      } else {
        await fx.checkpointBalance(policy, agent.kp.publicKey, staker.kp);
      }
    }
    await fx.warpTo(t3 + BigInt(LOCK[path === 'exploit' ? TRIGGER.exploit : TRIGGER.agentError]) + 1n);

    const current = await fx.ata(agent.ata);
    const realDrop = preClaimBaseline - current; // what the agent actually lost since cover began
    const bound = path === 'exploit' ? realDrop : realDrop > cap ? realDrop - cap : 0n;
    const pay = (amt: bigint) =>
      path === 'exploit'
        ? fx.payoutExploit(policy, agent.kp.publicKey, holder.ata, amt).rpc()
        : fx.payoutAgentError(policy, agent.kp.publicKey, holder.ata, amt).rpc();

    const vaultBefore = await fx.ata(fx.vaultAta);
    let quantified: bigint | null = null;
    if (opts.quantify !== undefined) {
      // Ask for the inflated amount first; if the program pays it, that is the
      // falsification, quantified.
      try {
        await pay(opts.quantify);
        quantified = vaultBefore - (await fx.ata(fx.vaultAta));
      } catch {
        quantified = null;
      }
    }
    let over: string | null = null;
    if (quantified === null) over = await rejected(pay(bound + 1n), `${path} payout of bound+1`).catch((e) => String(e));
    let legit: string | null = null;
    if (quantified === null) {
      try {
        await pay(bound);
      } catch (err) {
        legit = errorCode(err);
      }
    }
    const moved = vaultBefore - (await fx.ata(fx.vaultAta));
    const record = path === 'exploit' ? await fx.exploitRecord(policy).catch(() => null) : await fx.agentErrorRecord(policy).catch(() => null);
    return { over, legit, moved, bound, realDrop, quantified, record };
  }

  const postActions = (minWarp: number) =>
    fc.array(
      fc.record({
        kind: fc.constantFrom<'rerun' | 'depositRerunWithdraw'>('rerun', 'depositRerunWithdraw'),
        warp: fc.constantFrom(minWarp, 30, 300, 900),
        deposit: fc.integer({ min: 1, max: 20_000 }),
      }),
      { minLength: 1, maxLength: 3 },
    );

  it('INV-CKPT-01 (exploit, re-runs strictly after the claim second) — nothing above the real drop is ever paid', async () => {
    const outcomes: string[] = [];
    let griefed = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({ funding: fc.integer({ min: 2, max: 5_000 }), drainBps: fc.integer({ min: 5_001, max: 10_000 }), actions: postActions(1) }),
        async ({ funding, drainBps, actions }) => {
          const move = (usdc(funding) * BigInt(drainBps)) / 10_000n;
          const r = await drive('exploit', usdc(funding), move, actions);
          outcomes.push(`${JSON.stringify(actions)} over=${r.over} legit=${r.legit ?? 'paid'} bound=${r.bound}`);
          // The invariant: nothing above the real drop is ever paid.
          expect(r.over).not.toBeNull();
          expect(r.moved <= r.bound).toBe(true);
          // Whether the legitimate payout survived is recorded, not asserted —
          // see the pinned "two post-claim drops" example below (INV-F1 shape B).
          if (r.legit !== null) griefed++;
        },
      ),
      { numRuns: 16, seed: 20260904 },
    );
    // eslint-disable-next-line no-console
    console.log(`[INV-CKPT-01/exploit] legit payout made unpayable in ${griefed} of 16 schedules\n  ${outcomes.join('\n  ')}`);
  }, 600_000);

  it('INV-CKPT-01 (exploit, pinned) — deposit 20,000 → re-run 30 s after the claim → withdraw: baseline stays the pre-claim reading', async () => {
    const r = await drive('exploit', usdc(100), usdc(90), [{ kind: 'depositRerunWithdraw', warp: 30, deposit: 20_000 }]);
    expect(r.over).toBe('PayoutExceedsObservedDrop');
    expect(r.legit).toBeNull();
    expect(r.moved).toBe(usdc(90));
  }, 120_000);

  it('INV-CKPT-01 (agent-error, re-runs strictly after the claim second) — nothing above the real breach is ever paid', async () => {
    const outcomes: string[] = [];
    let griefed = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({ funding: fc.integer({ min: 20, max: 5_000 }), moveUsdc: fc.integer({ min: 12, max: 5_000 }), actions: postActions(1) }),
        async ({ funding, moveUsdc, actions }) => {
          const move = usdc(Math.min(moveUsdc, funding));
          const r = await drive('agentError', usdc(funding), move, actions);
          outcomes.push(`${JSON.stringify(actions)} over=${r.over} legit=${r.legit ?? 'paid'} bound=${r.bound}`);
          expect(r.over).not.toBeNull();
          expect(r.moved <= r.bound).toBe(true);
          if (r.legit !== null) griefed++;
        },
      ),
      { numRuns: 12, seed: 20260904 },
    );
    // eslint-disable-next-line no-console
    console.log(`[INV-CKPT-01/agentError] legit payout made unpayable in ${griefed} of 12 schedules\n  ${outcomes.join('\n  ')}`);
  }, 600_000);

  it('INV-CKPT-01/INV-CKPT-02 (exploit, two post-claim drops) — a second drain plus two crank ticks after the claim must not make the claim unpayable', async () => {
    // Shape fast-check shrank to: [depositRerunWithdraw, rerun] one second
    // apart. Rendered as the realistic sequence: the attacker who holds the
    // agent key drains 60, the claim is filed, they drain 30 more, and a
    // permissionless tick lands before and after that second drain.
    const fx = await Fixture.start();
    const staker = await actor(fx, usdc(1_000_000));
    await fx.stake(staker.kp, staker.ata, usdc(1_000_000));
    const holder = await actor(fx, usdc(10_000));
    const agent = await actor(fx, usdc(100));
    const sink = await fx.fundedAta(Keypair.generate().publicKey, 0n);
    await fx.attest(agent.kp.publicKey, 0, WIDE());
    const { policy } = await fx.createPolicy(holder.kp, holder.ata, agent.kp.publicKey, usdc(1_000), 86_400, WIDE());
    await fx.warp(60);
    await fx.transfer(agent.kp, agent.ata, sink, usdc(60));
    await fx.warp(60);
    await fx.submitClaimOracle(policy, TRIGGER.exploit);
    await fx.warp(1);
    await fx.checkpointBalance(policy, agent.kp.publicKey, staker.kp); // pins 100
    await fx.warp(1);
    await fx.transfer(agent.kp, agent.ata, sink, usdc(30)); // attacker keeps draining
    await fx.warp(1);
    await fx.checkpointBalance(policy, agent.kp.publicKey, staker.kp); // "dropped" again → pin replaced by a post-claim reading
    const cp = await fx.checkpoint(policy);
    await fx.warp(LOCK[TRIGGER.exploit]);
    let code: string | null = null;
    try {
      await fx.payoutExploit(policy, agent.kp.publicKey, holder.ata, usdc(60)).rpc();
    } catch (err) {
      code = errorCode(err);
    }
    // eslint-disable-next-line no-console
    console.log(`[INV-CKPT-01/two-drops] checkpoint amount=${cp.amount} prevAmount=${cp.prevAmount} result=${code ?? 'paid'}`);
    expect(code).toBeNull();
  }, 120_000);

  // -------------------------------------------------------------------------
  // The falsifying shapes fast-check found (shrunk to warp = 0): a deposit /
  // checkpoint / withdraw that lands in the SAME unix second as the claim is
  // treated as a pre-claim reading, and the pre-claim variant needs no timing
  // at all. Both raise the baseline above anything the agent ever owned.
  // -------------------------------------------------------------------------

  it('INV-CKPT-01 (exploit, same second as the claim) — payout must not exceed the drop the agent actually suffered', async () => {
    const r = await drive('exploit', usdc(100), usdc(90), [{ kind: 'depositRerunWithdraw', warp: 0, deposit: 20_000 }], {
      quantify: usdc(20_000),
    });
    // eslint-disable-next-line no-console
    console.log(
      `[INV-CKPT-01/same-second] realDrop=${r.realDrop} paid=${r.moved} quantified=${r.quantified} ` +
        `record.checkpointAmount=${r.record?.checkpointAmount} record.observedDrop=${r.record?.observedDrop}`,
    );
    expect(r.moved <= r.realDrop).toBe(true);
  }, 120_000);

  it('INV-CKPT-01 (exploit, pre-claim inflation) — a deposit/checkpoint/withdraw before the claim must not manufacture a drop', async () => {
    // No real movement at all: the agent still holds every token it ever owned.
    const r = await drive('exploit', usdc(100), 0n, [], { preClaimDeposit: usdc(20_000), quantify: usdc(20_000) });
    // eslint-disable-next-line no-console
    console.log(
      `[INV-CKPT-01/pre-claim] realDrop=${r.realDrop} paid=${r.moved} quantified=${r.quantified} ` +
        `record.checkpointAmount=${r.record?.checkpointAmount} record.observedDrop=${r.record?.observedDrop} dropBps=${r.record?.dropBps}`,
    );
    expect(r.moved <= r.realDrop).toBe(true);
  }, 120_000);

  it('INV-CKPT-01 (agent-error, pre-claim inflation) — the overshoot must not exceed the movement the agent actually made', async () => {
    const r = await drive('agentError', usdc(100), 0n, [], { preClaimDeposit: usdc(20_000), quantify: usdc(19_990) });
    // eslint-disable-next-line no-console
    console.log(
      `[INV-CKPT-01/agent-error pre-claim] realDrop=${r.realDrop} paid=${r.moved} quantified=${r.quantified} ` +
        `record.observedDrop=${r.record?.observedDrop} record.breachExcess=${r.record?.breachExcess}`,
    );
    expect(r.moved <= r.bound).toBe(true);
  }, 120_000);
});
