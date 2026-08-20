import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { and, desc, eq } from 'drizzle-orm';
import anchorPkg from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  DEMO_TX_SIGNATURE_PREFIX,
  LOCK_PERIODS,
  PDA_SEEDS,
  PolicyState,
  SYNTHETIC_PAYOUT_RATIO,
  TriggerType,
  generateDemoTxSignature,
  policyIdToBytes,
  type VerificationData,
} from '@covantic/shared';

// Anchor's ESM export of BN tripping up on named imports; pull from default.
const { BN } = anchorPkg;
import type { Connection } from '@solana/web3.js';
import type { Database } from '../config/database.js';
import type { AppConfig } from '../config/env.js';
import { createSolanaConnection } from '../config/solana.js';
import { claimEvidence, claims, policies } from '../db/schema.js';
import { ADJUDICATOR_VERSION } from '../services/oracle/adjudicate.js';
import { EXPLOIT_ADJUDICATOR_VERSION } from '../services/exploit/adjudicate.js';
import { bundleHash, verdictHash } from '../services/oracle/hash.js';
import { logger } from '../utils/logger.js';
import { HeliusClient } from '../utils/helius.js';
import type { ConsensusPricer } from '../services/oracle/consensus.js';
import { buildPriceOracle } from '../services/oracle/factory.js';
import { ProofPoster } from '../services/oracle/proof-poster.js';
import { CheckpointWriter } from '../services/exploit/checkpoint.js';
import { ExploitProofPoster } from '../services/exploit/proof-poster.js';
import { AuthorityCheckpointWriter } from '../services/governance/checkpoint.js';
import { GovernanceProofPoster } from '../services/governance/proof-poster.js';
import { loadBalanceSnapshotAt, readAgentBalances } from '../services/exploit/baseline.js';
import { GOVERNANCE_BASELINE_MAX_LEAD_SEC } from '../services/governance/conjunction.js';
import {
  createCovanticProgram,
  type CovanticProgram,
} from '../utils/program.js';
import {
  verifyClaim,
  type VerificationResult,
  type VerifyClaimOptions,
} from '../services/claim-oracle.js';
import { planProvenSettlement } from '../services/settlement-plan.js';
import { decideLane } from '../services/confidence-lanes.js';
import { recordAutoPayout, checkCircuitBreaker } from '../services/payout-breaker.js';
import { ALERT_CHANNEL, verifyAlert } from '../services/alert-bus.js';
import { triggerForEvent } from '../services/event-vocabulary.js';

const PROCESS_QUEUE = 'claim-keeper';
const PAYOUT_QUEUE = 'claim-payout';

/**
 * How many times an indeterminate verdict is retried before a human is
 * asked. Sources recover in seconds and indexers catch up in minutes, so a
 * claim that is still unresolvable after this many attempts has a problem
 * retrying will not fix.
 */
const MAX_VERIFY_ATTEMPTS = 5;


/** Shared BullMQ job options: retry up to 3 times with exponential backoff,
 *  bound retained history so failed jobs are inspectable without unbounded
 *  Redis growth. */
const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 100 },
} as const;

interface AlertPayload {
  agentAddress?: string;
  data?: { agentAddress?: string; type?: string; txSignature?: string; simulated?: boolean };
  event?: string;
  type?: string;
  txSignature?: string;
  simulated?: boolean;
}

interface ClaimJobPayload {
  claimId: string;
}

interface PayoutJobPayload {
  claimId: string;
}

type ClaimRow = typeof claims.$inferSelect;

function mergeVerificationData(
  existing: unknown,
  patch: VerificationData,
): VerificationData {
  const base: VerificationData =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as VerificationData)
      : {};
  return { ...base, ...patch };
}

/**
 * Auto-claim pipeline. Subscribes to monitoring:alerts, correlates alerts to
 * active on-chain policies, runs the verifier, submits the claim as oracle,
 * and schedules the payout after the trigger's lock period elapses.
 */
export function startClaimKeeper(db: Database, redis: Redis, config: AppConfig) {
  let programCtx: CovanticProgram;
  try {
    programCtx = createCovanticProgram(config, { withOracle: true });
  } catch (err) {
    logger.error({ err }, 'Claim keeper disabled: failed to load program or oracle keypair');
    return null;
  }

  const helius = new HeliusClient(config.HELIUS_API_KEY, config.SOLANA_NETWORK);
  const priceOracle = buildPriceOracle();
  // Used to cross-check the trigger transaction's block time against the
  // indexer. Every retrospective price lookup hangs off that timestamp, so
  // taking a single indexer's word for it is a single point of failure.
  const connection = createSolanaConnection(config.SOLANA_RPC_URL);
  const proofPoster = new ProofPoster(connection, programCtx);
  const exploitProofPoster = new ExploitProofPoster(
    programCtx,
    new CheckpointWriter(connection, programCtx),
  );
  const authorityCheckpoints = new AuthorityCheckpointWriter(programCtx);
  const governanceProofPoster = new GovernanceProofPoster(programCtx, authorityCheckpoints);

  const processQueue = new Queue<ClaimJobPayload>(PROCESS_QUEUE, {
    connection: redis,
    defaultJobOptions: JOB_OPTS,
  });
  const payoutQueue = new Queue<PayoutJobPayload>(PAYOUT_QUEUE, {
    connection: redis,
    defaultJobOptions: JOB_OPTS,
  });

  const processWorker = new Worker<ClaimJobPayload>(
    PROCESS_QUEUE,
    async (job) => {
      await processClaim(job.data.claimId, {
        db,
        redis,
        programCtx,
        helius,
        priceOracle,
        connection,
        processQueue,
        payoutQueue,
        config,
        authorityCheckpoints,
      });
    },
    { connection: redis, concurrency: 2 },
  );

  const payoutWorker = new Worker<PayoutJobPayload>(
    PAYOUT_QUEUE,
    async (job) => {
      await executePayout(
        job.data.claimId,
        db,
        redis,
        programCtx,
        config,
        proofPoster,
        exploitProofPoster,
        governanceProofPoster,
      );
    },
    { connection: redis, concurrency: 1 },
  );

  processWorker.on('failed', (job, err) =>
    logger.error({ job: job?.id, err }, 'claim-keeper process job failed'),
  );
  payoutWorker.on('failed', (job, err) =>
    logger.error({ job: job?.id, err }, 'claim-keeper payout job failed'),
  );

  // Dedicated subscriber connection. Ingesting from a normal client breaks
  // other commands on it, so we duplicate.
  const subscriber = redis.duplicate();
  subscriber.subscribe(ALERT_CHANNEL, (err) => {
    if (err) {
      logger.error({ err }, 'claim-keeper failed to subscribe to monitoring:alerts');
    }
  });

  subscriber.on('message', (channel, raw) => {
    if (channel !== ALERT_CHANNEL) return;
    ingestAlert(raw, db, redis, processQueue, config).catch((err) =>
      logger.error({ err, raw }, 'claim-keeper failed to ingest alert'),
    );
  });

  logger.info('Claim keeper started');
  return { processWorker, payoutWorker };
}

// ---------------------------------------------------------------------------
// Alert ingestion — monitoring:alerts -> claims row + enqueue processing
// ---------------------------------------------------------------------------

async function ingestAlert(
  raw: string,
  db: Database,
  redis: Redis,
  processQueue: Queue<ClaimJobPayload>,
  config: AppConfig,
): Promise<void> {
  const verified = verifyAlert<AlertPayload>(raw, config.ALERT_HMAC_SECRET);
  if (!verified) {
    logger.warn({ raw }, 'claim-keeper: rejecting unsigned or stale alert');
    return;
  }
  const payload = verified.payload;

  const agentAddress = payload.agentAddress ?? payload.data?.agentAddress;
  const eventType = payload.event ?? payload.type ?? payload.data?.type;
  const txSignature = payload.txSignature ?? payload.data?.txSignature ?? null;
  // Only honour the simulated flag in non-production environments. Even on
  // the signed bus, a stray dev payload must never trigger a real payout.
  const requestedSimulated = Boolean(payload.simulated ?? payload.data?.simulated);
  const simulated = requestedSimulated && syntheticAllowed(config);

  if (!agentAddress || !eventType) {
    logger.debug({ raw }, 'claim-keeper skipping malformed alert');
    return;
  }

  const trigger = triggerForEvent(eventType);
  if (trigger === undefined) {
    logger.debug({ eventType }, 'claim-keeper ignoring unhandled event type');
    return;
  }

  const [active] = await db
    .select()
    .from(policies)
    .where(and(eq(policies.agentAddress, agentAddress), eq(policies.state, PolicyState.Active)))
    .orderBy(desc(policies.createdAt))
    .limit(1);

  if (!active) {
    logger.debug({ agentAddress }, 'claim-keeper: no active policy for agent');
    return;
  }

  const effectiveTxSignature =
    txSignature && txSignature.length > 0
      ? txSignature
      : simulated
        ? generateDemoTxSignature()
        : null;

  if (!effectiveTxSignature) {
    logger.warn({ eventType, agentAddress }, 'claim-keeper: alert missing tx signature');
    return;
  }

  // Idempotency is enforced by a partial unique index on the claims table
  // (`claims_open_unique` — see db/custom-constraints.ts). A race between
  // two concurrent alerts resolves here: the second insert raises a unique
  // violation we swallow.
  let claimId: string | undefined;
  try {
    const verificationData: VerificationData = { simulated, eventType, source: 'claim-keeper' };
    const inserted = await db
      .insert(claims)
      .values({
        policyId: active.policyId,
        holderAddress: active.holderAddress,
        agentAddress,
        triggerType: trigger,
        triggerTxSignature: effectiveTxSignature,
        status: 'pending',
        verificationData,
      })
      .returning({ id: claims.id });
    claimId = inserted[0]?.id;
  } catch (err) {
    // Unique-violation = open claim already exists. Anything else re-throws.
    if ((err as { code?: string })?.code === '23505') {
      logger.info(
        { policyId: active.policyId, agentAddress },
        'claim-keeper: open claim already exists for policy (unique constraint)',
      );
      return;
    }
    throw err;
  }

  if (!claimId) {
    logger.error({ agentAddress, policyId: active.policyId }, 'claim-keeper: insert returned no id');
    return;
  }

  const created = await loadClaim(claimId, db);
  if (created) {
    await broadcastClaim(created, redis);
  }
  await processQueue.add('process', { claimId });
  logger.info({ claimId, policyId: active.policyId, trigger }, 'claim-keeper: claim enqueued');
}

/** Synthetic verification for simulated monitoring events. Demo tx
 *  signatures can't be resolved by Helius, so the production verifier
 *  returns verified:false; this keeps the demo UX working end-to-end. */
function syntheticVerification(
  triggerType: number,
  coverageAmount: number,
): VerificationResult {
  const lockByTrigger: Record<number, number> = {
    [TriggerType.Exploit]: LOCK_PERIODS.EXPLOIT,
    [TriggerType.OracleManipulation]: LOCK_PERIODS.ORACLE_MANIPULATION,
    [TriggerType.AgentError]: LOCK_PERIODS.AGENT_ERROR,
    [TriggerType.GovernanceAttack]: LOCK_PERIODS.GOVERNANCE_ATTACK,
  };
  const lockPeriod = lockByTrigger[triggerType] ?? LOCK_PERIODS.EXPLOIT;

  return {
    outcome: 'confirmed',
    verified: true,
    lossAmount: Math.floor(coverageAmount * SYNTHETIC_PAYOUT_RATIO),
    confidence: 1.0,
    details: { method: 'synthetic', simulated: true },
    lockPeriod,
  };
}

/** Mainnet USDC. Its presence means real money regardless of what NODE_ENV
 *  claims. */
const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Whether the synthetic (demo) verifier may run.
 *
 * The synthetic path pays 80% of coverage at confidence 1.0 without looking
 * at anything on-chain, so the gate around it is the only thing standing
 * between a stray demo alert and a real payout. One environment variable is
 * too thin a barrier for that: a misconfigured NODE_ENV on a mainnet
 * deployment would be enough. The cluster and the USDC mint must also both
 * say "not real money".
 */
function syntheticAllowed(config: AppConfig): boolean {
  return (
    config.NODE_ENV !== 'production' &&
    config.SOLANA_NETWORK !== 'mainnet-beta' &&
    config.USDC_MINT !== MAINNET_USDC_MINT
  );
}

// ---------------------------------------------------------------------------
// Verification + submit_claim
// ---------------------------------------------------------------------------

interface ProcessDeps {
  db: Database;
  redis: Redis;
  programCtx: CovanticProgram;
  helius: HeliusClient;
  priceOracle: ConsensusPricer;
  connection: Connection;
  processQueue: Queue<ClaimJobPayload>;
  payoutQueue: Queue<PayoutJobPayload>;
  config: AppConfig;
  authorityCheckpoints: AuthorityCheckpointWriter;
}

/**
 * The chain and database reads the governance verifier needs but must not
 * perform itself.
 *
 * Assembled here because this is the only place that knows both the claim row
 * and the program context. Keeping them out of `claim-oracle` is what lets
 * the verifier be driven by a corpus test with neither a database nor an RPC.
 *
 * **On `claimSubmittedAt`.** The program checks the declaration matured
 * before `policy.claim_submitted_at`, which is set by `oracle_submit_claim` —
 * and that has not happened yet when this runs. So the comparison here uses
 * the claim's own creation time, which is necessarily *earlier*. That makes
 * the off-chain check strictly stricter than the on-chain one, which is the
 * right direction: a baseline this accepts is one the program will accept,
 * never the reverse.
 */
function governanceLookups(
  claim: ClaimRow,
  policy: typeof policies.$inferSelect,
  deps: ProcessDeps,
): NonNullable<VerifyClaimOptions['governance']> {
  const claimSubmittedAt = Math.floor(new Date(claim.createdAt).getTime() / 1000);
  return {
    baseline: () =>
      deps.authorityCheckpoints.readBaseline(
        policy.holderAddress,
        BigInt(claim.policyId),
        claimSubmittedAt,
      ),
    holdingsBefore: (at: number) =>
      loadBalanceSnapshotAt(
        deps.db,
        claim.agentAddress,
        new Date(at * 1000),
        GOVERNANCE_BASELINE_MAX_LEAD_SEC,
      ),
    holdingsNow: async () => {
      const current = await readAgentBalances(deps.connection, claim.agentAddress);
      return {
        holdings: current.readings,
        frozen: current.frozen,
        blockTime: Math.floor(Date.now() / 1000),
      };
    },
  };
}

async function processClaim(claimId: string, deps: ProcessDeps): Promise<void> {
  const {
    db,
    redis,
    programCtx,
    helius,
    priceOracle,
    connection,
    processQueue,
    payoutQueue,
    config,
  } = deps;
  const claim = await loadClaim(claimId, db);
  if (!claim) return;

  await setClaimStatus(claim, 'verifying', db, redis);

  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.policyId, claim.policyId))
    .limit(1);
  if (!policy) {
    await rejectClaim(claim, { reason: 'policy_not_indexed' }, db, redis);
    return;
  }

  // Demo bypass: synthetic tx signatures (demo_*) can't be resolved by
  // Helius, so we use a deterministic stub verifier. Triggered only when
  // the ingest path marked the claim simulated AND we're not in production.
  const verificationData = (claim.verificationData ?? {}) as VerificationData;
  const isDemoSignature = claim.triggerTxSignature.startsWith(DEMO_TX_SIGNATURE_PREFIX);
  const simulated =
    verificationData.simulated === true && isDemoSignature && syntheticAllowed(config);

  let result: VerificationResult;
  if (simulated) {
    result = syntheticVerification(claim.triggerType, policy.coverageAmount);
  } else {
    result = await verifyClaim(
      claim.triggerType as TriggerType,
      claim.triggerTxSignature,
      claim.agentAddress,
      policy.coverageAmount,
      helius,
      priceOracle,
      {
        usdcMint: config.USDC_MINT,
        connection,
        holderAddress: policy.holderAddress,
        governance: governanceLookups(claim, policy, deps),
      },
    );
  }

  const attempt = (claim.verifyAttempts ?? 0) + 1;
  await recordEvidence(claim, attempt, result, db);

  // "We could not check" is not "there was no loss". An unavailable price
  // source, an unindexed transaction, or references that disagree all land
  // here and get retried; only evidence that actually contradicts the claim
  // closes it.
  if (result.outcome === 'indeterminate') {
    await handleIndeterminate(claim, attempt, result, db, redis, processQueue);
    return;
  }

  if (result.outcome === 'rejected' || result.lossAmount <= 0) {
    await rejectClaim(
      claim,
      { reason: 'verification_failed', outcome: result.outcome, details: result.details },
      db,
      redis,
    );
    return;
  }

  // Confidence stops being decorative here. Until this check existed every
  // verifier computed a score and nothing compared it to anything, so a
  // verdict the code itself called 0.6 confident released the same funds as
  // one at 0.95.
  const plan = planProvenSettlement(claim, config);
  const lane = decideLane({
    triggerType: claim.triggerType,
    confidence: result.confidence,
    proofAvailable:
      plan.kind === 'proven_price' ||
      plan.kind === 'proven_balance' ||
      plan.kind === 'proven_authority',
  });
  if (lane.lane === 'review') {
    await escalateToReview(claim, lane.reason, result, db, redis);
    return;
  }

  const lockExpiresAt = new Date(Date.now() + result.lockPeriod * 1000);

  // Persist verification outputs + lock expiry BEFORE any on-chain call so
  // a crash after this point still has the audit trail.
  await db
    .update(claims)
    .set({
      lossAmount: result.lossAmount,
      payoutAmount: result.lossAmount,
      verificationData: mergeVerificationData(claim.verificationData, {
        ...result.details,
        outcome: result.outcome,
        confidence: result.confidence,
        verifyAttempts: attempt,
      }),
      verifyAttempts: attempt,
      reviewReason: null,
      verifiedAt: new Date(),
      lockExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(claims.id, claim.id));

  const submitSig = await submitClaimOnChain(
    programCtx,
    policy.holderAddress,
    BigInt(claim.policyId),
    claim.triggerType,
    claim.triggerTxSignature,
  );

  await db
    .update(claims)
    .set({
      status: 'approved',
      submitTxSignature: submitSig,
      updatedAt: new Date(),
    })
    .where(eq(claims.id, claim.id));
  const approved = await loadClaim(claim.id, db);
  if (approved) await broadcastClaim(approved, redis);

  // Schedule payout relative to the persisted lockExpiresAt so a restart
  // doesn't reset the timer.
  const delayMs = Math.max(0, lockExpiresAt.getTime() - Date.now());
  await payoutQueue.add('payout', { claimId: claim.id }, { delay: delayMs });

  logger.info(
    { claimId: claim.id, submitSig, lockPeriod: result.lockPeriod, delayMs },
    'claim-keeper: on-chain claim submitted',
  );
}

// ---------------------------------------------------------------------------
// Payout — verify_and_payout
// ---------------------------------------------------------------------------

async function executePayout(
  claimId: string,
  db: Database,
  redis: Redis,
  programCtx: CovanticProgram,
  config: AppConfig,
  proofPoster: ProofPoster,
  exploitProofPoster: ExploitProofPoster,
  governanceProofPoster: GovernanceProofPoster,
): Promise<void> {
  const claim = await loadClaim(claimId, db);
  if (!claim) return;
  if (claim.status !== 'approved' && claim.status !== 'paying') {
    logger.warn(
      { claimId, status: claim.status },
      'claim-keeper: payout skipped; not approved/paying',
    );
    return;
  }

  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.policyId, claim.policyId))
    .limit(1);
  if (!policy) {
    await rejectClaim(claim, { reason: 'policy_missing_at_payout' }, db, redis);
    return;
  }

  // Null/zero payouts used to fall back to the full coverage amount. That
  // masked verifier bugs by over-paying; fail loudly instead.
  const payoutAmount = claim.payoutAmount ?? 0;
  if (payoutAmount <= 0) {
    await rejectClaim(
      claim,
      { reason: 'payout_amount_missing' },
      db,
      redis,
    );
    return;
  }

  // Split-brain fix: mark `paying` before the on-chain RPC. If BullMQ
  // retries after an RPC success, a reload here sees status=paying and
  // we skip the second RPC (which would revert anyway due to the on-chain
  // state check, but we'd lose the audit trail on the retry).
  if (claim.status !== 'paying') {
    await db
      .update(claims)
      .set({ status: 'paying', updatedAt: new Date() })
      .where(and(eq(claims.id, claim.id), eq(claims.status, 'approved')));
    const reloaded = await loadClaim(claim.id, db);
    if (reloaded) await broadcastClaim(reloaded, redis);
  }

  // A rolling cap on automatic payouts. Every bound above is a claim about
  // one claim; this is the one that survives a bound turning out to be wrong.
  const breaker = await checkCircuitBreaker(redis, config, payoutAmount);
  if (!breaker.ok) {
    logger.error(
      { claimId: claim.id, reason: breaker.reason, ...breaker.detail },
      'claim-keeper: automatic payouts paused by circuit breaker',
    );
    await escalateToReview(claim, breaker.reason, null, db, redis);
    return;
  }

  const proofPlan = planProvenSettlement(claim, config);
  if (proofPlan.kind === 'unprovable') {
    // Fail closed. Falling back to the unverified instruction here would make
    // the whole proven path decorative: an attacker who can stop a proof from
    // being built would simply get the legacy behaviour back.
    logger.warn(
      { claimId: claim.id, reason: proofPlan.reason },
      'claim-keeper: proof required but unavailable, escalating instead of paying',
    );
    await db
      .update(claims)
      .set({
        status: 'review',
        reviewReason: proofPlan.reason.slice(0, 128),
        verificationData: mergeVerificationData(claim.verificationData, {
          reason: proofPlan.reason,
        }),
        updatedAt: new Date(),
      })
      .where(eq(claims.id, claim.id));
    const escalated = await loadClaim(claim.id, db);
    if (escalated) await broadcastClaim(escalated, redis);
    return;
  }

  try {
    let payoutSig: string;
    switch (proofPlan.kind) {
      case 'proven_price':
        payoutSig = (
          await proofPoster.settle({
            holderAddress: policy.holderAddress,
            policyId: BigInt(claim.policyId),
            payoutAmount: BigInt(payoutAmount),
            triggerBlockTime: proofPlan.triggerBlockTime,
            proof: proofPlan.proof,
            bundleHash: proofPlan.bundleHash,
          })
        ).at(-1)!;
        break;
      case 'proven_balance':
        payoutSig = await exploitProofPoster.settle({
          holderAddress: policy.holderAddress,
          agentAddress: policy.agentAddress,
          policyId: BigInt(claim.policyId),
          payoutAmount: BigInt(payoutAmount),
          bundleHash: proofPlan.bundleHash,
        });
        break;
      case 'proven_authority':
        payoutSig = await governanceProofPoster.settle({
          holderAddress: policy.holderAddress,
          agentAddress: policy.agentAddress,
          policyId: BigInt(claim.policyId),
          payoutAmount: BigInt(payoutAmount),
          bundleHash: proofPlan.bundleHash,
        });
        break;
      default:
        payoutSig = await verifyAndPayoutOnChain(
          programCtx,
          policy.holderAddress,
          BigInt(claim.policyId),
          BigInt(payoutAmount),
        );
    }

    await db
      .update(claims)
      .set({
        status: 'paid',
        payoutTxSignature: payoutSig,
        payoutAmount,
        paidAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(claims.id, claim.id));
    const paid = await loadClaim(claim.id, db);
    if (paid) await broadcastClaim(paid, redis);

    await recordAutoPayout(redis, payoutAmount);

    logger.info(
      { claimId: claim.id, payoutSig, settlement: proofPlan.kind },
      'claim-keeper: payout executed',
    );
  } catch (err) {
    logger.error({ err, claimId: claim.id }, 'claim-keeper: payout failed');
    await db
      .update(claims)
      .set({
        status: 'failed',
        verificationData: mergeVerificationData(claim.verificationData, {
          payoutError: String(err),
        }),
        updatedAt: new Date(),
      })
      .where(eq(claims.id, claim.id));
    const failed = await loadClaim(claim.id, db);
    if (failed) await broadcastClaim(failed, redis);
    throw err; // let BullMQ retry per JOB_OPTS.attempts
  }
}

// ---------------------------------------------------------------------------
// On-chain helpers
// ---------------------------------------------------------------------------

function derivePdas(
  programId: PublicKey,
  holder: PublicKey,
  policyId: bigint,
): { config: PublicKey; vault: PublicKey; policy: PublicKey } {
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.CONFIG)],
    programId,
  );
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.VAULT)], programId);
  const [policy] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(PDA_SEEDS.POLICY),
      holder.toBuffer(),
      Buffer.from(policyIdToBytes(policyId)),
    ],
    programId,
  );
  return { config, vault, policy };
}

async function submitClaimOnChain(
  ctx: CovanticProgram,
  holderAddress: string,
  policyId: bigint,
  triggerType: number,
  triggerTxSignature: string,
): Promise<string> {
  const holder = new PublicKey(holderAddress);
  const { config, policy } = derivePdas(ctx.programId, holder, policyId);

  const sigBytes = Buffer.from(triggerTxSignature, 'utf8');

  return await (ctx.program.methods as any)
    .oracleSubmitClaim(triggerType, sigBytes)
    .accounts({
      oracle: ctx.oracleKeypair!.publicKey,
      config,
      policy,
    })
    .rpc();
}

async function verifyAndPayoutOnChain(
  ctx: CovanticProgram,
  holderAddress: string,
  policyId: bigint,
  payoutAmount: bigint,
): Promise<string> {
  const holder = new PublicKey(holderAddress);
  const { config, vault, policy } = derivePdas(ctx.programId, holder, policyId);

  const cfgAcc: any = await (ctx.program.account as any).protocolConfig.fetch(config);
  const usdcMint = cfgAcc.usdcMint as PublicKey;
  const vaultAta = getAssociatedTokenAddressSync(usdcMint, vault, true);
  const holderAta = getAssociatedTokenAddressSync(usdcMint, holder);

  return await (ctx.program.methods as any)
    .verifyAndPayout(new BN(payoutAmount.toString()))
    .accounts({
      oracle: ctx.oracleKeypair!.publicKey,
      config,
      policy,
      vault,
      vaultTokenAccount: vaultAta,
      holderTokenAccount: holderAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

// ---------------------------------------------------------------------------
// Claim helpers
// ---------------------------------------------------------------------------

async function loadClaim(id: string, db: Database): Promise<ClaimRow | null> {
  const [row] = await db.select().from(claims).where(eq(claims.id, id)).limit(1);
  return row ?? null;
}

async function setClaimStatus(
  claim: ClaimRow,
  status: string,
  db: Database,
  redis: Redis,
): Promise<void> {
  await db.update(claims).set({ status, updatedAt: new Date() }).where(eq(claims.id, claim.id));
  const reloaded = await loadClaim(claim.id, db);
  if (reloaded) await broadcastClaim(reloaded, redis);
}

/**
 * Persist the evidence a verdict was derived from.
 *
 * Written before any state transition and on every attempt, including the
 * ones that resolve nothing: the trail of what each retry saw is how a stuck
 * claim gets diagnosed. Evidence storage must never be able to break the
 * pipeline, so failures here are logged and swallowed.
 */
async function recordEvidence(
  claim: ClaimRow,
  attempt: number,
  result: VerificationResult,
  db: Database,
): Promise<void> {
  if (!result.evidence) return;
  try {
    const bundle = result.evidence as unknown as Record<string, unknown>;
    const hash = bundleHash(bundle);
    const verdict = {
      outcome: result.outcome,
      lossAmount: result.lossAmount,
      confidence: result.confidence,
      lockPeriod: result.lockPeriod,
      details: result.details,
    };
    await db.insert(claimEvidence).values({
      claimId: claim.id,
      attempt,
      bundle,
      bundleHash: hash,
      verdict,
      verdictHash: verdictHash(hash, verdict),
      adjudicatorVersion: adjudicatorVersionFor(claim.triggerType),
    });
  } catch (err) {
    logger.error(
      { err, claimId: claim.id, attempt },
      'claim-keeper: failed to persist claim evidence',
    );
  }
}

/**
 * Park a claim for a human without closing it.
 *
 * Distinct from `rejectClaim` on purpose: rejection is a statement that the
 * evidence contradicts the claim, and neither "not confident enough" nor
 * "payouts are paused" is that statement. The claim stays open and still
 * counts against the policy.
 */
async function escalateToReview(
  claim: ClaimRow,
  reason: string,
  result: VerificationResult | null,
  db: Database,
  redis: Redis,
): Promise<void> {
  await db
    .update(claims)
    .set({
      status: 'review',
      reviewReason: reason.slice(0, 128),
      verificationData: mergeVerificationData(claim.verificationData, {
        ...(result?.details ?? {}),
        reviewReason: reason,
        ...(result ? { outcome: result.outcome, confidence: result.confidence } : {}),
      }),
      ...(result ? { lossAmount: result.lossAmount, verifiedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(claims.id, claim.id));
  const escalated = await loadClaim(claim.id, db);
  if (escalated) await broadcastClaim(escalated, redis);

  logger.warn({ claimId: claim.id, reason }, 'claim-keeper: claim escalated to review');
}

/**
 * Which adjudicator produced this verdict.
 *
 * Recorded per trigger because each has its own pure judgement function and
 * its own version line. Replaying a bundle under the wrong one would compare
 * a verdict against rules that never applied to it.
 */
function adjudicatorVersionFor(triggerType: number): string {
  switch (triggerType) {
    case TriggerType.Exploit:
      return EXPLOIT_ADJUDICATOR_VERSION;
    case TriggerType.OracleManipulation:
      return ADJUDICATOR_VERSION;
    default:
      // Triggers without a pure adjudicator yet. Naming the trigger keeps the
      // row honest instead of attributing the verdict to a version that had
      // nothing to do with it.
      return `verifier-t${triggerType}`;
  }
}

/**
 * Park an unresolvable claim and try again later, or hand it to a human.
 *
 * The retry delay comes from the verifier, which knows what it was waiting
 * on: an indexer catching up needs seconds, a missing price feed needs a
 * code change. Past MAX_VERIFY_ATTEMPTS the claim moves to `review` — still
 * open, still counted against the policy, but no longer spinning.
 */
async function handleIndeterminate(
  claim: ClaimRow,
  attempt: number,
  result: VerificationResult,
  db: Database,
  redis: Redis,
  processQueue: Queue<ClaimJobPayload>,
): Promise<void> {
  const reason = String(result.details.reason ?? 'indeterminate');
  const exhausted = attempt >= MAX_VERIFY_ATTEMPTS;
  const retryAfterSec = Math.max(1, result.retryAfterSec ?? 60);

  await db
    .update(claims)
    .set({
      status: exhausted ? 'review' : 'indeterminate',
      reviewReason: reason.slice(0, 128),
      verifyAttempts: attempt,
      verificationData: mergeVerificationData(claim.verificationData, {
        ...result.details,
        outcome: result.outcome,
        verifyAttempts: attempt,
      }),
      updatedAt: new Date(),
    })
    .where(eq(claims.id, claim.id));

  const reloaded = await loadClaim(claim.id, db);
  if (reloaded) await broadcastClaim(reloaded, redis);

  if (exhausted) {
    logger.warn(
      { claimId: claim.id, reason, attempt },
      'claim-keeper: verification still indeterminate after max attempts, escalating to review',
    );
    return;
  }

  await processQueue.add('process', { claimId: claim.id }, { delay: retryAfterSec * 1000 });
  logger.info(
    { claimId: claim.id, reason, attempt, retryAfterSec },
    'claim-keeper: verification indeterminate, scheduled retry',
  );
}

async function rejectClaim(
  claim: ClaimRow,
  reason: VerificationData,
  db: Database,
  redis: Redis,
): Promise<void> {
  await db
    .update(claims)
    .set({
      status: 'rejected',
      verificationData: mergeVerificationData(claim.verificationData, reason),
      updatedAt: new Date(),
    })
    .where(eq(claims.id, claim.id));
  const reloaded = await loadClaim(claim.id, db);
  if (reloaded) await broadcastClaim(reloaded, redis);
}

async function broadcastClaim(row: ClaimRow, redis: Redis): Promise<void> {
  const msg = JSON.stringify({
    channel: 'claims:feed',
    event: 'claim.update',
    data: row,
    timestamp: Date.now(),
  });
  try {
    await redis.publish('claims:feed', msg);
  } catch (err) {
    logger.warn({ err }, 'claim-keeper: broadcast publish failed');
  }
}

