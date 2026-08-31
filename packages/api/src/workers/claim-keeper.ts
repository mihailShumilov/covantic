import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { and, desc, eq, inArray } from 'drizzle-orm';
import anchorPkg from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  DEMO_TX_SIGNATURE_PREFIX,
  LOCK_PERIODS,
  PARKED_CLAIM_STATUSES,
  PDA_SEEDS,
  PolicyState,
  SYNTHETIC_PAYOUT_RATIO,
  TRIGGER_SPECIFICITY,
  TriggerType,
  canonicalMint,
  generateDemoTxSignature,
  policyIdToBytes,
  type VerificationData,
  isPermanentlyParked,
  isTransientlyParked,
} from '@covantic/shared';

// Anchor's ESM export of BN tripping up on named imports; pull from default.
const { BN } = anchorPkg;
import type { Connection } from '@solana/web3.js';
import type { Database } from '../config/database.js';
import type { AppConfig } from '../config/env.js';
import { createSolanaConnection } from '../config/solana.js';
import { getSolanaReader, type SolanaReader } from '../utils/solana-reader.js';
import { fetchAnchorAccount } from '../utils/anchor-reader.js';
import { claimEvidence, claims, policies } from '../db/schema.js';
import { ADJUDICATOR_VERSION } from '../services/oracle/adjudicate.js';
import { EXPLOIT_ADJUDICATOR_VERSION } from '../services/exploit/adjudicate.js';
import { AGENT_ERROR_ADJUDICATOR_VERSION } from '../services/agent-error/adjudicate.js';
import { GOVERNANCE_ADJUDICATOR_VERSION } from '../services/governance/adjudicate.js';
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
import { MandateReader } from '../services/agent-error/mandate.js';
import { AgentErrorProofPoster } from '../services/agent-error/proof-poster.js';
import { loadOutflowBaseline } from '../services/agent-error/baseline.js';
import { loadBalanceSnapshotAt, readAgentBalances } from '../services/exploit/baseline.js';
import { GOVERNANCE_BASELINE_MAX_LEAD_SEC } from '../services/governance/conjunction.js';
import { createCovanticProgram, type CovanticProgram } from '../utils/program.js';
import {
  verifyClaim,
  type VerificationResult,
  type VerifyClaimOptions,
} from '../services/claim-oracle.js';
import { planProvenSettlement } from '../services/settlement-plan.js';
import { syntheticAllowed } from '../services/synthetic-gate.js';
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

/**
 * How long to wait after the chain says the lock has not elapsed.
 *
 * The off-chain wait and the on-chain lock are two numbers in two languages
 * that have to agree, and nothing makes them. `EXPLOIT_LOCK_SECONDS` lets an
 * operator set the off-chain half from `.env`; the on-chain half is a compiled
 * constant that only a program upgrade changes. Set the first below the
 * second — the ordinary mistake after a rollback, or a deploy that skipped the
 * `devnet-fast-lock` build — and every payout attempt reverts.
 *
 * That was previously terminal. `JOB_OPTS` gives three attempts over about
 * seventy seconds, so a claim whose real lock is an hour away exhausted them
 * all and settled into `failed`: a closed status, on a claim the chain was
 * merely asking us to wait for. The vault kept the money and the record said
 * the payout had been tried and lost.
 *
 * The schedule runs past the longest lock the program defines
 * (`LOCK_AGENT_ERROR`, six hours), so a correct claim survives any lock a
 * misconfiguration can put in front of it, and is bounded so a genuinely
 * stuck claim still reaches a human rather than requeueing forever.
 */
export const LOCK_DEFERRAL_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000] as const;

/**
 * Is this the chain telling us the lock has not elapsed?
 *
 * Matched by name rather than by code: Anchor numbers errors by their position
 * in the enum, so inserting a variant renumbers everything after it, and a
 * hard-coded 6014 would then quietly match a different failure.
 */
export function isLockNotElapsed(err: unknown): boolean {
  return /LockPeriodNotElapsed/.test(
    err instanceof Error ? `${err.message}\n${String((err as { logs?: string[] }).logs ?? '')}` : String(err),
  );
}

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

function mergeVerificationData(existing: unknown, patch: VerificationData): VerificationData {
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
  const reader = getSolanaReader(config);
  const proofPoster = new ProofPoster(connection, programCtx, reader);
  const exploitProofPoster = new ExploitProofPoster(
    programCtx,
    reader,
    new CheckpointWriter(connection, programCtx, reader),
  );
  const authorityCheckpoints = new AuthorityCheckpointWriter(programCtx, reader);
  const governanceProofPoster = new GovernanceProofPoster(programCtx, reader, authorityCheckpoints);
  const mandates = new MandateReader(programCtx, reader);
  const agentErrorProofPoster = new AgentErrorProofPoster(programCtx, reader, mandates);

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
        reader,
        processQueue,
        payoutQueue,
        config,
        authorityCheckpoints,
        mandates,
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
        payoutQueue,
        proofPoster,
        exploitProofPoster,
        governanceProofPoster,
        agentErrorProofPoster,
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
  const verificationData: VerificationData = { simulated, eventType, source: 'claim-keeper' };
  try {
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
      // Not necessarily the end of it. A policy holds one open claim, and
      // `review`/`indeterminate` are open — so a claim parked for a human was
      // enough to make the policy deaf to every later alert, including the
      // genuine exploit it was insured against. That is a denial-of-coverage
      // vector an attacker can arm for the price of one cheap anomaly.
      //
      // Nothing automated is working on a parked claim, so a strictly more
      // specific threat may take the slot: the claim is re-pointed at the new
      // trigger and re-queued rather than a second one being opened, which
      // keeps the one-open-claim rule intact.
      const superseded = await supersedeParkedClaim(
        db,
        redis,
        active.policyId,
        trigger,
        effectiveTxSignature,
        verificationData,
      );
      if (superseded) {
        await processQueue.add('process', { claimId: superseded });
        logger.warn(
          { policyId: active.policyId, agentAddress, trigger, claimId: superseded },
          'claim-keeper: parked claim superseded by a higher-specificity trigger',
        );
        return;
      }
      // The alert had nowhere to go. Worth a warning rather than an info line:
      // for the approve-then-drain sequence both alerts land on the same sweep
      // tick, the governance claim is still `pending` (so not supersedable),
      // and the exploit alert — the only one of the two the protocol can
      // actually prove — is dropped here. The monitoring event is already
      // recorded, so the drain will not be raised again.
      //
      // Making it durable (re-evaluate when the claim next parks) is the real
      // fix and is a queue change; this at least stops it being silent.
      logger.warn(
        {
          policyId: active.policyId,
          agentAddress,
          trigger,
          txSignature: effectiveTxSignature,
        },
        'claim-keeper: alert dropped — policy already holds an open claim that cannot be superseded',
      );
      return;
    }
    throw err;
  }

  if (!claimId) {
    logger.error(
      { agentAddress, policyId: active.policyId },
      'claim-keeper: insert returned no id',
    );
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
  exploitLockSeconds: number,
  agentErrorLockSeconds: number,
): VerificationResult {
  const lockByTrigger: Record<number, number> = {
    [TriggerType.Exploit]: exploitLockSeconds,
    [TriggerType.OracleManipulation]: LOCK_PERIODS.ORACLE_MANIPULATION,
    [TriggerType.AgentError]: agentErrorLockSeconds,
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

// ---------------------------------------------------------------------------
// Verification + submit_claim
// ---------------------------------------------------------------------------

interface ProcessDeps {
  db: Database;
  redis: Redis;
  programCtx: CovanticProgram;
  helius: HeliusClient;
  priceOracle: ConsensusPricer;
  /** Signs and sends. Stays on the primary endpoint — see `rpc-pool.ts`. */
  connection: Connection;
  /** Reads, across every configured endpoint. */
  reader: SolanaReader;
  processQueue: Queue<ClaimJobPayload>;
  payoutQueue: Queue<PayoutJobPayload>;
  config: AppConfig;
  authorityCheckpoints: AuthorityCheckpointWriter;
  mandates: MandateReader;
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
      const current = await readAgentBalances(deps.reader, claim.agentAddress);
      return {
        holdings: current.readings,
        frozen: current.frozen,
        blockTime: Math.floor(Date.now() / 1000),
      };
    },
  };
}

/**
 * The chain and database reads the agent-error verifier needs but must not
 * perform itself.
 *
 * Assembled here for the same reason the governance ones are: this is the only
 * place that knows both the claim row and the program context, and keeping
 * them out of `claim-oracle` is what lets the verifier be driven by a corpus
 * test with neither a database nor an RPC.
 *
 * `claimSubmittedAt` is the claim row's creation time, which is necessarily
 * earlier than the `policy.claim_submitted_at` the program will compare
 * against — so a mandate accepted here is one the program will accept, never
 * the reverse.
 */
function agentErrorLookups(
  claim: ClaimRow,
  policy: typeof policies.$inferSelect,
  deps: ProcessDeps,
): NonNullable<VerifyClaimOptions['agentError']> {
  const claimSubmittedAt = Math.floor(new Date(claim.createdAt).getTime() / 1000);
  const coveredMint = deps.config.USDC_MINT;
  return {
    mandate: () =>
      deps.mandates.readMandate(policy.holderAddress, BigInt(claim.policyId), claimSubmittedAt),
    // With no covered mint configured there is no series to summarise. `null`
    // rather than a throw: history is corroboration, and its absence should
    // cost a little confidence rather than stall the claim.
    outflowBaseline: (windowSeconds: number) =>
      coveredMint
        ? loadOutflowBaseline(
            deps.db,
            claim.agentAddress,
            canonicalMint(coveredMint),
            new Date(claim.createdAt),
            windowSeconds,
            // The trigger is excluded from its own history: the monitor has
            // already recorded it, and the verifier adds it back explicitly.
            claim.triggerTxSignature ?? undefined,
          )
        : Promise.resolve(null),
  };
}

/**
 * Reasons the exploit adjudicator gives that are the agent-error question in
 * disguise.
 *
 * `agent_authorized_movement` is a rejection meaning "the agent moved its own
 * money and nothing structural contradicts that", and
 * `authorized_but_anomalous` escalates the same finding when the surrounding
 * shape looks wrong. Both are precisely the case this other trigger covers,
 * and both used to end the claim — closed or parked — without the agent-error
 * question ever being asked.
 */
const EXPLOIT_REASONS_MEANING_AGENT_ERROR = new Set([
  'agent_authorized_movement',
  'authorized_but_anomalous',
]);

/**
 * Re-file an exploit claim as an agent-error one, when that is what it is.
 *
 * Returns `'reattributed'` when the claim was re-filed and re-queued, so the
 * caller stops processing this pass; `'unreadable'` when the declaration could
 * not be read at all, which must not be allowed to finalise a rejection; and
 * `'no'` when the mandate was read and does not support an agent-error claim.
 *
 * Two constraints keep this from being a loophole rather than a repair:
 *
 * **Before on-chain submission only.** `oracle_submit_claim` writes
 * `policy.trigger_type`, and after that the trigger is fixed — re-attributing
 * then would leave the database and the chain disagreeing about what is being
 * claimed. This runs while the claim is still `verifying`, which is the only
 * window where the two can be kept in step.
 *
 * **One direction only.** Exploit → agent error is a *narrowing*: it moves the
 * claim from a path that pays the full unauthorised loss to one that pays only
 * the overshoot beyond a cap the holder declared. The reverse would let a
 * mandate breach be re-filed as an exploit for a larger payout, and is
 * deliberately not implemented. `reattributedFrom` in the verification data is
 * what makes a second pass a no-op.
 */
async function reattributeToAgentError(
  claim: ClaimRow,
  policy: typeof policies.$inferSelect,
  result: VerificationResult,
  deps: ProcessDeps,
  hasEvidence: boolean,
): Promise<'reattributed' | 'unreadable' | 'no'> {
  if (claim.triggerType !== TriggerType.Exploit) return 'no';
  const reason = typeof result.details.reason === 'string' ? result.details.reason : '';
  if (!EXPLOIT_REASONS_MEANING_AGENT_ERROR.has(reason)) return 'no';

  const data = (claim.verificationData ?? {}) as VerificationData & {
    reattributedFrom?: number;
  };
  if (data.reattributedFrom !== undefined) return 'no';

  // Only worth moving if there is something to measure the movement against.
  // With no matured mandate the agent-error path resolves to review, which is
  // no better than where the exploit verdict already left it — and a rejection
  // carries more information than a second "we cannot tell".
  const claimSubmittedAt = Math.floor(new Date(claim.createdAt).getTime() / 1000);
  let mandate: Awaited<ReturnType<MandateReader['readMandate']>> = null;
  try {
    mandate = await deps.mandates.readMandate(
      policy.holderAddress,
      BigInt(claim.policyId),
      claimSubmittedAt,
    );
  } catch (err) {
    logger.warn(
      { err, claimId: claim.id },
      'claim-keeper: mandate unreadable during re-attribution',
    );
    // Unreadable is not absent, and the difference decides whether a claim
    // closes. A mandate that was *read* and is missing or immature means the
    // agent-error path has nothing to measure against, so the exploit
    // rejection is the more informative answer. A mandate nobody could read
    // means we do not know that — and letting the rejection stand would close
    // a claim on evidence we failed to fetch, which is the one thing the
    // three-valued discipline exists to prevent.
    return 'unreadable';
  }
  if (!mandate?.maturedBeforeClaim) return 'no';

  await deps.db
    .update(claims)
    .set({
      triggerType: TriggerType.AgentError,
      status: 'pending',
      verificationData: mergeVerificationData(claim.verificationData, {
        reattributedFrom: TriggerType.Exploit,
        reattributionReason: reason,
        // The exploit bundle stays in `claim_evidence` under its own attempt,
        // so the trail shows both questions being asked rather than only the
        // one that was answered second.
        reattributionEvidenceRecorded: hasEvidence,
      }),
      updatedAt: new Date(),
    })
    .where(eq(claims.id, claim.id));

  const reloaded = await loadClaim(claim.id, deps.db);
  if (reloaded) await broadcastClaim(reloaded, deps.redis);
  await deps.processQueue.add('process', { claimId: claim.id });

  logger.info(
    { claimId: claim.id, reason },
    'claim-keeper: exploit verdict re-filed as agent error against a matured mandate',
  );
  return 'reattributed';
}

async function processClaim(claimId: string, deps: ProcessDeps): Promise<void> {
  const {
    db,
    redis,
    programCtx,
    helius,
    priceOracle,
    reader,
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
    result = syntheticVerification(
      claim.triggerType,
      policy.coverageAmount,
      config.EXPLOIT_LOCK_SECONDS,
      config.AGENT_ERROR_LOCK_SECONDS,
    );
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
        reader,
        // A devnet build may shorten the program's own LOCK_EXPLOIT so a demo
        // completes in under a minute; the keeper's wait has to move with it.
        exploitLockSeconds: config.EXPLOIT_LOCK_SECONDS,
        agentErrorLockSeconds: config.AGENT_ERROR_LOCK_SECONDS,
        holderAddress: policy.holderAddress,
        governance: governanceLookups(claim, policy, deps),
        agentError: agentErrorLookups(claim, policy, deps),
      },
    );
  }

  const attempt = (claim.verifyAttempts ?? 0) + 1;
  const evidenceHash = await recordEvidence(claim, attempt, result, db);

  // "We could not check" is not "there was no loss". An unavailable price
  // source, an unindexed transaction, or references that disagree all land
  // here and get retried; only evidence that actually contradicts the claim
  // closes it.
  // An exploit verdict that turns on "the agent authorised this" is not a dead
  // end — it is the other trigger's opening statement. See
  // {@link reattributeToAgentError}.
  const reattribution = await reattributeToAgentError(
    claim,
    policy,
    result,
    deps,
    evidenceHash !== null,
  );
  if (reattribution === 'reattributed') return;
  if (reattribution === 'unreadable') {
    // Retry rather than close. The exploit verdict may well be right, but it
    // can only be *final* once we know whether the other trigger had a
    // declaration to settle against.
    await handleIndeterminate(
      claim,
      attempt,
      {
        ...result,
        outcome: 'indeterminate',
        details: {
          ...result.details,
          reason: 'mandate_unreadable_during_reattribution',
          note:
            'The exploit path found the agent authorised this movement, which is the ' +
            'agent-error path’s opening statement — and the holder’s declaration could not ' +
            'be read to check it. Closing here would rest a rejection on evidence we failed ' +
            'to fetch.',
        },
        retryAfterSec: 60,
      },
      db,
      redis,
      processQueue,
    );
    return;
  }

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
  // The hash from *this* pass, not the row's.  produced it a
  // few lines up and it is not persisted until after this decision, so reading
  // it off the claim would find the value from a previous pass — which, for a
  // verdict reached on the first pass, is nothing at all.
  const plan = planProvenSettlement(claim, config, { details: result.details, bundleHash: evidenceHash });
  const lane = decideLane({
    triggerType: claim.triggerType,
    confidence: result.confidence,
    proofAvailable:
      plan.kind === 'proven_price' ||
      plan.kind === 'proven_balance' ||
      plan.kind === 'proven_authority' ||
      plan.kind === 'proven_mandate',
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
        // What every proven settlement path commits to on chain. Written here
        // rather than by each verifier so the four cannot drift.
        ...(evidenceHash ? { bundleHash: evidenceHash } : {}),
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
  payoutQueue: Queue<PayoutJobPayload>,
  proofPoster: ProofPoster,
  exploitProofPoster: ExploitProofPoster,
  governanceProofPoster: GovernanceProofPoster,
  agentErrorProofPoster: AgentErrorProofPoster,
): Promise<void> {
  const reader = getSolanaReader(config);
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
    await rejectClaim(claim, { reason: 'payout_amount_missing' }, db, redis);
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
      case 'proven_mandate':
        payoutSig = await agentErrorProofPoster.settle({
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
          reader,
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
    // Ask the chain before believing the error.
    //
    // The transfer may have landed and only the confirmation or the DB write
    // after it failed — the ordinary "RPC timed out on a transaction that
    // succeeded" case. Recording `failed` there means real USDC left the vault
    // with nothing linking it to the claim, and the retry then reverts against
    // `ClaimPaid` and records `failed` again, permanently. The money is gone
    // and the record says it never moved.
    const settled = await isPolicySettledOnChain(programCtx, claim).catch(() => false);
    if (settled) {
      logger.warn(
        { claimId: claim.id, err: String(err) },
        'claim-keeper: payout reported an error but the policy is ClaimPaid; recording as paid',
      );
      await db
        .update(claims)
        .set({
          status: 'paid',
          paidAt: new Date(),
          verificationData: mergeVerificationData(claim.verificationData, {
            payoutError: String(err),
            reconciledFromChain: true,
            note: 'Settled on chain; the signature was lost with the failed confirmation.',
          }),
          updatedAt: new Date(),
        })
        .where(eq(claims.id, claim.id));
      const reconciled = await loadClaim(claim.id, db);
      if (reconciled) await broadcastClaim(reconciled, redis);
      return;
    }

    // A lock that has not elapsed is a timing answer, not a verdict. Waiting
    // is the whole remedy, so recording `failed` would close a claim the chain
    // was about to allow.
    if (isLockNotElapsed(err)) {
      const deferrals = Number(
        (claim.verificationData as { lockDeferrals?: unknown } | null)?.lockDeferrals ?? 0,
      );
      const delay = LOCK_DEFERRAL_MS[deferrals];
      if (delay !== undefined) {
        await db
          .update(claims)
          .set({
            verificationData: mergeVerificationData(claim.verificationData, {
              lockDeferrals: deferrals + 1,
              lastLockError: String(err),
            }),
            updatedAt: new Date(),
          })
          .where(eq(claims.id, claim.id));
        await payoutQueue.add('payout', { claimId: claim.id }, { delay });
        logger.warn(
          { claimId: claim.id, deferrals: deferrals + 1, delay },
          'claim-keeper: on-chain lock has not elapsed; payout deferred',
        );
        return;
      }
      // Past the longest lock the program defines. Something other than a
      // misconfigured wait is wrong, and a human should see it.
      await db
        .update(claims)
        .set({
          verificationData: mergeVerificationData(claim.verificationData, {
            lockDeferrals: deferrals,
            lastLockError: String(err),
          }),
          updatedAt: new Date(),
        })
        .where(eq(claims.id, claim.id));
      const stuck = (await loadClaim(claim.id, db)) ?? claim;
      await escalateToReview(stuck, 'lock_never_elapsed', null, db, redis);
      return;
    }

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

/**
 * Did the policy actually settle, whatever the client thinks happened?
 *
 * `ClaimPaid` is terminal and only `verify_and_payout*` sets it, so reading it
 * back is a reliable answer to "did the money move?" when the client's own
 * report is untrustworthy.
 */
async function isPolicySettledOnChain(ctx: CovanticProgram, claim: ClaimRow): Promise<boolean> {
  const { policy } = derivePdas(
    ctx.programId,
    new PublicKey(claim.holderAddress),
    BigInt(claim.policyId),
  );
  // Deliberately NOT on the read pool. This asks whether *our own* payout
  // landed, and a fallback endpoint a few slots behind the one we sent to
  // would answer "not settled" about a policy that is — turning a completed
  // payout into a retry. Reads that reconcile a write we just made belong on
  // the endpoint we made it from.
  const onChain: any = await (ctx.program.account as any).insurancePolicy.fetchNullable(policy);
  return onChain !== null && Number(onChain.state) === PolicyState.ClaimPaid;
}

// ---------------------------------------------------------------------------
// On-chain helpers
// ---------------------------------------------------------------------------

function derivePdas(
  programId: PublicKey,
  holder: PublicKey,
  policyId: bigint,
): { config: PublicKey; vault: PublicKey; policy: PublicKey } {
  const [config] = PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.CONFIG)], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.VAULT)], programId);
  const [policy] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.POLICY), holder.toBuffer(), Buffer.from(policyIdToBytes(policyId))],
    programId,
  );
  return { config, vault, policy };
}

/**
 * Hand the policy's open-claim slot to a strictly more specific trigger.
 *
 * Only touches a *parked* claim — `review` or `indeterminate`, where no job
 * and no on-chain transaction is in flight. A claim in `verifying`,
 * `approved` or `paying` is left alone: superseding one would race a
 * transaction that may already have been signed.
 *
 * Returns the claim id when it took the slot, `null` when it did not, so the
 * caller can fall through to the ordinary "already open" path.
 */
async function supersedeParkedClaim(
  db: Database,
  redis: Redis,
  policyId: number,
  trigger: TriggerType,
  triggerTxSignature: string,
  verificationData: VerificationData,
): Promise<string | null> {
  const parked = await db
    .select({
      id: claims.id,
      triggerType: claims.triggerType,
      status: claims.status,
      reviewReason: claims.reviewReason,
      verifyAttempts: claims.verifyAttempts,
      triggerTxSignature: claims.triggerTxSignature,
      verificationData: claims.verificationData,
    })
    .from(claims)
    .where(
      and(
        eq(claims.policyId, policyId),
        inArray(claims.status, PARKED_CLAIM_STATUSES as unknown as string[]),
      ),
    )
    .limit(1);

  const existing = parked[0];
  if (!existing) return null;

  const incoming = TRIGGER_SPECIFICITY[trigger] ?? 0;
  const current = TRIGGER_SPECIFICITY[existing.triggerType as TriggerType] ?? 0;

  // Two ways to earn the slot.
  //
  // Specificity is the ordinary one, and strictly greater: an equally specific
  // repeat of what a human is already looking at is not new information, and
  // swapping on ties would let a stream of identical alerts reset the claim
  // forever.
  //
  // The second exists because specificity alone gets the commonest real theft
  // backwards. A phished `Approve` followed by a drain opens a governance
  // claim first — an approval *is* a change of control — and it parks for want
  // of a baseline the holder never declared. Governance outranks exploit, so
  // the drain's claim could never take the slot, and the protocol would sit on
  // the claim it cannot prove while refusing the one it can. A claim parked on
  // a reason no retry can clear has no purchase on the slot, whatever its
  // trigger outranks.
  //
  // The tie rule survives both routes. `parkedForever` buys a *lower*
  // specificity claim the slot; it does not license an equally specific repeat
  // to take it, because that is exactly the stream-of-identical-alerts case
  // above — and the reasons in `UNRESOLVABLE_PARK_REASONS` are per-policy
  // conditions, so repeats on them are the norm, not the exception.
  const parkedForever = isPermanentlyParked(existing.reviewReason);

  // The tie rule has one exception, and it is narrow on purpose.
  //
  // `trigger_tx_not_found` is the only park reason that describes the
  // transaction rather than the policy, and it is usually infrastructure. A
  // later alert of the same trigger naming a *different* signature is new
  // information — a second, real movement — not the stream of identical
  // alerts the tie rule exists to refuse. Refusing it meant one outage
  // deafened a policy for that trigger permanently: every claim parked here
  // while a vendor's quota was exhausted, and none could be replaced once it
  // recovered.
  //
  // The same signature repeating is still refused. `MAX_SUPERSEDES` bounds the
  // rest.
  const newTransactionOnADeadEnd =
    isTransientlyParked(existing.reviewReason) &&
    existing.triggerTxSignature !== triggerTxSignature;

  if (incoming === current && !newTransactionOnADeadEnd) return null;
  if (incoming < current && !parkedForever) return null;

  // A claim three triggers have failed to explain is what a reviewer is for.
  // Without a cap, an attacker alternating two trigger shapes churns the row
  // between `pending` and `indeterminate` for the life of the policy.
  const supersedeCount = supersedesSoFar(existing.verificationData) + 1;
  if (supersedeCount > MAX_SUPERSEDES) {
    logger.warn(
      { claimId: existing.id, supersedeCount, trigger },
      'claim-keeper: supersede cap reached; escalating to review instead of re-pointing',
    );
    await db
      .update(claims)
      .set({ status: 'review', reviewReason: 'supersede_cap_reached', updatedAt: new Date() })
      .where(eq(claims.id, existing.id));
    return null;
  }

  // Conditional on the status still being parked, so a verifier that picked
  // the claim up between the select and here wins the race rather than having
  // its work silently reset.
  const updated = await db
    .update(claims)
    .set({
      triggerType: trigger,
      triggerTxSignature,
      status: 'pending',
      reviewReason: null,
      // Carried, not reset. `handleIndeterminate` only escalates to review at
      // MAX_VERIFY_ATTEMPTS, so zeroing this on every supersede meant a churned
      // claim could never accumulate enough attempts to reach a human.
      verifyAttempts: existing.verifyAttempts,
      verificationData: {
        ...verificationData,
        supersededTriggerType: existing.triggerType,
        supersededFromStatus: existing.status,
        // Kept so the incident that opened the claim stays recoverable; the
        // pointer used to be overwritten with nothing recording what it was.
        supersededTxSignature: existing.triggerTxSignature,
        supersedeCount,
        supersededReason: parkedForever
          ? `unresolvable:${existing.reviewReason ?? 'unknown'}`
          : 'higher_specificity',
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(claims.id, existing.id),
        inArray(claims.status, PARKED_CLAIM_STATUSES as unknown as string[]),
      ),
    )
    .returning({ id: claims.id });

  const id = updated[0]?.id ?? null;
  if (id) {
    const reloaded = await loadClaim(id, db);
    if (reloaded) await broadcastClaim(reloaded, redis);
  }
  return id;
}

/** Supersedes allowed before the claim goes to a human instead. */
const MAX_SUPERSEDES = 2;

/** How many times this claim has already been re-pointed at another trigger. */
function supersedesSoFar(verificationData: unknown): number {
  if (verificationData === null || typeof verificationData !== 'object') return 0;
  const count = (verificationData as { supersedeCount?: unknown }).supersedeCount;
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
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

  try {
    return await (ctx.program.methods as any)
      .oracleSubmitClaim(triggerType, sigBytes)
      .accounts({
        oracle: ctx.oracleKeypair!.publicKey,
        config,
        policy,
      })
      .rpc();
  } catch (err) {
    // The submit may have landed and only the confirmation failed — an RPC
    // timeout on a transaction that succeeded is the ordinary case, not an
    // exotic one. On retry the instruction reverts with `PolicyNotActive`
    // because the policy is already `ClaimPending`, and letting that throw
    // stranded the claim at `verifying` forever: an OPEN status holding the
    // policy's only claim slot, which nothing else reconciles.
    //
    // So ask the chain what actually happened before believing the error —
    // over the provider's own connection, not the read pool: this is the same
    // "did our write land" question as `isPolicySettledOnChain`, and a lagging
    // endpoint answering it would strand exactly the claim this rescues.
    const onChain: any = await (ctx.program.account as any).insurancePolicy
      .fetchNullable(policy)
      .catch(() => null);
    if (onChain && Number(onChain.state) === PolicyState.ClaimPending) {
      logger.warn(
        { policyId: policyId.toString(), err: (err as Error).message },
        'claim-keeper: submit reported an error but the policy is ClaimPending; treating as submitted',
      );
      return SUBMIT_SIGNATURE_UNKNOWN;
    }
    throw err;
  }
}

/**
 * Recorded when the chain confirms the claim was submitted but the signature
 * was lost with the failed confirmation. Distinguishes "we know it landed,
 * without the receipt" from "it never landed" — the latter must retry.
 */
const SUBMIT_SIGNATURE_UNKNOWN = 'unknown:reconciled-from-chain';

async function verifyAndPayoutOnChain(
  ctx: CovanticProgram,
  reader: SolanaReader,
  holderAddress: string,
  policyId: bigint,
  payoutAmount: bigint,
): Promise<string> {
  const holder = new PublicKey(holderAddress);
  const { config, vault, policy } = derivePdas(ctx.programId, holder, policyId);

  // Config names the covered mint and never changes, so unlike the two
  // write-reconciliation reads above it is safe on the pool.
  const cfgAcc = await fetchAnchorAccount<{ usdcMint: PublicKey }>(
    ctx,
    reader,
    'protocolConfig',
    config.toBase58(),
  );
  if (!cfgAcc) throw new Error('verifyAndPayout: protocol config account not found');
  const usdcMint = cfgAcc.usdcMint;
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
 * Persist the evidence a verdict was derived from, and return its hash.
 *
 * Written before any state transition and on every attempt, including the
 * ones that resolve nothing: the trail of what each retry saw is how a stuck
 * claim gets diagnosed. Evidence storage must never be able to break the
 * pipeline, so failures here are logged and swallowed.
 *
 * **The hash is returned because every proof path needs it and only this
 * function computes it.** `planProvenSettlement` requires `bundleHash` in the
 * claim's `verificationData` before it will route to a proven instruction, and
 * only the price verifier was folding it into its own `details`. So with
 * `EXPLOIT_PROOF_ENABLED` or `GOVERNANCE_PROOF_ENABLED` on, every claim on
 * those triggers would have planned `unprovable: no_bundle_hash` and gone to
 * review — the proven path unreachable, failing closed and therefore silently.
 * Returning it from the one place that derives it means a new trigger cannot
 * reintroduce the gap by forgetting to copy a line.
 */
async function recordEvidence(
  claim: ClaimRow,
  attempt: number,
  result: VerificationResult,
  db: Database,
): Promise<string | null> {
  if (!result.evidence) return null;
  let hashHex: string | null = null;
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
    hashHex = hash;
  } catch (err) {
    logger.error(
      { err, claimId: claim.id, attempt },
      'claim-keeper: failed to persist claim evidence',
    );
  }
  return hashHex;
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
    case TriggerType.GovernanceAttack:
      return GOVERNANCE_ADJUDICATOR_VERSION;
    case TriggerType.AgentError:
      return AGENT_ERROR_ADJUDICATOR_VERSION;
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
