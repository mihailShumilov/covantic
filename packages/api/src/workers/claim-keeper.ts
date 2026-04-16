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
import type { Database } from '../config/database.js';
import type { AppConfig } from '../config/env.js';
import { claims, policies } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { HeliusClient } from '../utils/helius.js';
import { PythClient } from '../utils/pyth.js';
import {
  createCovanticProgram,
  type CovanticProgram,
} from '../utils/program.js';
import { verifyClaim, type VerificationResult } from '../services/claim-oracle.js';
import { ALERT_CHANNEL, verifyAlert } from '../services/alert-bus.js';

const PROCESS_QUEUE = 'claim-keeper';
const PAYOUT_QUEUE = 'claim-payout';

/** Monitoring event types the keeper reacts to, mapped to on-chain triggers. */
const EVENT_TO_TRIGGER: Record<string, TriggerType | undefined> = {
  exploit: TriggerType.Exploit,
  oracle_deviation: TriggerType.OracleManipulation,
  agent_error: TriggerType.AgentError,
  governance_attack: TriggerType.GovernanceAttack,
  large_transfer: TriggerType.AgentError,
  failed_tx: TriggerType.AgentError,
};

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

  const helius = new HeliusClient(config.HELIUS_API_KEY);
  const pyth = new PythClient();

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
      await processClaim(job.data.claimId, db, redis, programCtx, helius, pyth, payoutQueue, config);
    },
    { connection: redis, concurrency: 2 },
  );

  const payoutWorker = new Worker<PayoutJobPayload>(
    PAYOUT_QUEUE,
    async (job) => {
      await executePayout(job.data.claimId, db, redis, programCtx);
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
  const simulated = requestedSimulated && config.NODE_ENV !== 'production';

  if (!agentAddress || !eventType) {
    logger.debug({ raw }, 'claim-keeper skipping malformed alert');
    return;
  }

  const trigger = EVENT_TO_TRIGGER[eventType];
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

async function processClaim(
  claimId: string,
  db: Database,
  redis: Redis,
  programCtx: CovanticProgram,
  helius: HeliusClient,
  pyth: PythClient,
  payoutQueue: Queue<PayoutJobPayload>,
  config: AppConfig,
): Promise<void> {
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
    verificationData.simulated === true &&
    isDemoSignature &&
    config.NODE_ENV !== 'production';

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
      pyth,
    );
  }

  if (!result.verified || result.lossAmount <= 0) {
    await rejectClaim(
      claim,
      { reason: 'verification_failed', details: result.details },
      db,
      redis,
    );
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
        confidence: result.confidence,
      }),
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

  try {
    const payoutSig = await verifyAndPayoutOnChain(
      programCtx,
      policy.holderAddress,
      BigInt(claim.policyId),
      BigInt(payoutAmount),
    );

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

    logger.info({ claimId: claim.id, payoutSig }, 'claim-keeper: payout executed');
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

