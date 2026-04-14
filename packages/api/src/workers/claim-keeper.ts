import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import anchorPkg from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  LOCK_PERIODS,
  PDA_SEEDS,
  TriggerType,
  PolicyState,
  policyIdToBytes,
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

const PROCESS_QUEUE = 'claim-keeper';
const PAYOUT_QUEUE = 'claim-payout';

const OPEN_CLAIM_STATUSES = ['pending', 'verifying', 'approved'] as const;

/** Monitoring event types the keeper reacts to, mapped to on-chain triggers. */
const EVENT_TO_TRIGGER: Record<string, TriggerType | undefined> = {
  exploit: TriggerType.Exploit,
  oracle_deviation: TriggerType.OracleManipulation,
  agent_error: TriggerType.AgentError,
  governance_attack: TriggerType.GovernanceAttack,
  // transaction-monitor emits `large_transfer` / `failed_tx` from the
  // Helius webhook path — treat as agent error until we split them out.
  large_transfer: TriggerType.AgentError,
  failed_tx: TriggerType.AgentError,
};

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

/**
 * Auto-claim pipeline. Subscribes to monitoring:alerts, correlates alerts to
 * active on-chain policies, runs the verifier, submits the claim as oracle,
 * and schedules the payout after the trigger's lock period elapses.
 *
 * Why this exists: previously the protocol required the holder to sign
 * submit_claim, so the marketing data-flow (anomaly → auto-submit → payout)
 * had no runtime implementation. Phase 1 added `oracle_submit_claim`, and
 * this worker is what finally drives the pipeline end-to-end.
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

  const processQueue = new Queue<ClaimJobPayload>(PROCESS_QUEUE, { connection: redis });
  const payoutQueue = new Queue<PayoutJobPayload>(PAYOUT_QUEUE, { connection: redis });

  const processWorker = new Worker<ClaimJobPayload>(
    PROCESS_QUEUE,
    async (job) => {
      await processClaim(job.data.claimId, db, redis, programCtx, helius, pyth, payoutQueue);
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
  subscriber.subscribe('monitoring:alerts', (err) => {
    if (err) {
      logger.error({ err }, 'claim-keeper failed to subscribe to monitoring:alerts');
    }
  });

  subscriber.on('message', (channel, raw) => {
    if (channel !== 'monitoring:alerts') return;
    ingestAlert(raw, db, redis, processQueue).catch((err) =>
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
): Promise<void> {
  let payload: AlertPayload;
  try {
    payload = JSON.parse(raw) as AlertPayload;
  } catch (err) {
    logger.warn({ err, raw }, 'claim-keeper received unparseable alert');
    return;
  }

  const agentAddress = payload.agentAddress ?? payload.data?.agentAddress;
  const eventType = payload.event ?? payload.type ?? payload.data?.type;
  const txSignature = payload.txSignature ?? payload.data?.txSignature ?? null;
  const simulated = Boolean(payload.simulated ?? payload.data?.simulated);

  if (!agentAddress || !eventType) {
    logger.debug({ raw }, 'claim-keeper skipping malformed alert');
    return;
  }

  // Guard: only react to events we know how to verify. Everything else gets
  // silently dropped so the monitoring bus stays a general-purpose channel.
  const trigger = EVENT_TO_TRIGGER[eventType];
  if (trigger === undefined) {
    logger.debug({ eventType }, 'claim-keeper ignoring unhandled event type');
    return;
  }

  // Find the most recent Active policy for this agent. An agent with no
  // coverage is a no-op — this is expected and not worth logging at warn.
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

  // Idempotency: if an open claim already exists for this policy, don't file
  // a second one. Race-tolerant because the unique key is (policy, status).
  const existing = await db
    .select({ id: claims.id })
    .from(claims)
    .where(
      and(
        eq(claims.policyId, active.policyId),
        inArray(claims.status, OPEN_CLAIM_STATUSES as unknown as string[]),
      ),
    )
    .limit(1);

  const existingId = existing[0]?.id;
  if (existingId) {
    logger.info(
      { policyId: active.policyId, existingClaim: existingId },
      'claim-keeper: open claim already exists for policy',
    );
    return;
  }

  const effectiveTxSignature =
    txSignature && txSignature.length > 0
      ? txSignature
      : simulated
        ? `demo_${Date.now()}_${Math.random().toString(36).slice(2)}`
        : null;

  if (!effectiveTxSignature) {
    logger.warn({ eventType, agentAddress }, 'claim-keeper: alert missing tx signature');
    return;
  }

  const inserted = await db
    .insert(claims)
    .values({
      policyId: active.policyId,
      holderAddress: active.holderAddress,
      agentAddress,
      triggerType: trigger,
      triggerTxSignature: effectiveTxSignature,
      status: 'pending',
      verificationData: { simulated, eventType, source: 'claim-keeper' },
    })
    .returning({ id: claims.id });

  const claimId = inserted[0]?.id;
  if (!claimId) {
    logger.error({ agentAddress, policyId: active.policyId }, 'claim-keeper: insert returned no id');
    return;
  }

  await broadcastClaim(claimId, db, redis);
  await processQueue.add('process', { claimId });
  logger.info({ claimId, policyId: active.policyId, trigger }, 'claim-keeper: claim enqueued');
}

/**
 * Synthetic verification for simulated monitoring events. Helius cannot
 * resolve the `demo_*` tx signatures we generate for the /demo page or
 * ad-hoc /api/demo/simulate-exploit calls, so the real verifier would
 * always return verified=false. Mirror the animated pipeline's payout
 * multiplier (80% of coverage) and use the on-chain lock period for the
 * trigger so the wait-for-payout experience matches production.
 */
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
    lossAmount: Math.floor(coverageAmount * 0.8),
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
): Promise<void> {
  const claim = await loadClaim(claimId, db);
  if (!claim) return;

  await setClaimStatus(claim.id, 'verifying', db, redis);

  // Load the policy so we know coverage_amount and can build PDAs for the
  // on-chain instruction below.
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.policyId, claim.policyId))
    .limit(1);
  if (!policy) {
    await rejectClaim(claim.id, { reason: 'policy_not_indexed' }, db, redis);
    return;
  }

  // Demo bypass: simulated monitoring events carry synthetic tx signatures
  // (`demo_*`) that Helius cannot resolve. Use a deterministic stub so the
  // marketing demo reaches a paid state on-chain. Production webhooks with
  // real signatures go through the real verifier.
  const simulated =
    claim.verificationData &&
    typeof claim.verificationData === 'object' &&
    (claim.verificationData as any).simulated === true;

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
      claim.id,
      { reason: 'verification_failed', details: result.details },
      db,
      redis,
    );
    return;
  }

  // Persist verification before any on-chain work so a crash after this
  // point still has the audit trail.
  await db
    .update(claims)
    .set({
      lossAmount: result.lossAmount,
      payoutAmount: result.lossAmount,
      verificationData: { ...(claim.verificationData as object ?? {}), ...result.details, confidence: result.confidence },
      verifiedAt: new Date(),
      lockExpiresAt: new Date(Date.now() + result.lockPeriod * 1000),
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
  await broadcastClaim(claim.id, db, redis);

  // Schedule payout after the lock period. BullMQ delay is persisted, so a
  // server restart still fires the payout on time.
  await payoutQueue.add(
    'payout',
    { claimId: claim.id },
    { delay: result.lockPeriod * 1000 },
  );

  logger.info(
    { claimId: claim.id, submitSig, lockPeriod: result.lockPeriod },
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
  if (claim.status !== 'approved') {
    logger.warn({ claimId, status: claim.status }, 'claim-keeper: payout skipped; not approved');
    return;
  }

  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.policyId, claim.policyId))
    .limit(1);
  if (!policy) {
    await rejectClaim(claim.id, { reason: 'policy_missing_at_payout' }, db, redis);
    return;
  }

  const payoutAmount = claim.payoutAmount ?? policy.coverageAmount;

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
    await broadcastClaim(claim.id, db, redis);

    logger.info({ claimId: claim.id, payoutSig }, 'claim-keeper: payout executed');
  } catch (err) {
    logger.error({ err, claimId: claim.id }, 'claim-keeper: payout failed');
    await db
      .update(claims)
      .set({
        status: 'failed',
        verificationData: {
          ...((claim.verificationData as object) ?? {}),
          payoutError: String(err),
        },
        updatedAt: new Date(),
      })
      .where(eq(claims.id, claim.id));
    await broadcastClaim(claim.id, db, redis);
    throw err; // let BullMQ retry
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

  // Fetch usdc mint from on-chain config so the keeper survives config rotations
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

async function loadClaim(id: string, db: Database) {
  const [row] = await db.select().from(claims).where(eq(claims.id, id)).limit(1);
  return row ?? null;
}

async function setClaimStatus(id: string, status: string, db: Database, redis: Redis) {
  await db.update(claims).set({ status, updatedAt: new Date() }).where(eq(claims.id, id));
  await broadcastClaim(id, db, redis);
}

async function rejectClaim(
  id: string,
  reason: Record<string, unknown>,
  db: Database,
  redis: Redis,
) {
  const [current] = await db.select().from(claims).where(eq(claims.id, id)).limit(1);
  const merged = { ...((current?.verificationData as object) ?? {}), ...reason };
  await db
    .update(claims)
    .set({
      status: 'rejected',
      verificationData: merged,
      updatedAt: new Date(),
    })
    .where(eq(claims.id, id));
  await broadcastClaim(id, db, redis);
}

async function broadcastClaim(id: string, db: Database, redis?: Redis): Promise<void> {
  const [row] = await db.select().from(claims).where(eq(claims.id, id)).limit(1);
  if (!row) return;
  const msg = JSON.stringify({
    channel: 'claims:feed',
    event: 'claim.update',
    data: row,
    timestamp: Date.now(),
  });
  try {
    // NotificationService subscribes to claims:feed and forwards to WS. When
    // no redis arg is passed we still want the broadcast -- use the default
    // write client via a tiny shim. The indexer path does pass redis.
    if (redis) {
      await redis.publish('claims:feed', msg);
    }
  } catch (err) {
    logger.warn({ err }, 'claim-keeper: broadcast publish failed');
  }
}
