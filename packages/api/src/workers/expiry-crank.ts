import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { and, asc, eq, lt } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import { PDA_SEEDS, PolicyState } from '@covantic/shared';
import type { Database } from '../config/database.js';
import type { AppConfig } from '../config/env.js';
import { policies } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { createCovanticProgram, type CovanticProgram } from '../utils/program.js';

const QUEUE_NAME = 'expiry-crank';
const EVERY_MS = 60_000;

/** Max policies to crank per tick. Keeps one slow RPC round from starving
 *  the next cycle; excess rolls over to subsequent ticks. */
const BATCH_LIMIT = 20;

/** Above this, something is very wrong (cranker wedged, RPC down, chain
 *  rejecting expire_policy for every row). Emits a WARN so ops can page. */
const STUCK_WARN_THRESHOLD = 10;

/**
 * Policy expiry crank.
 *
 * Runs every minute. For each policy where the DB says `state=Active` but
 * `expiry_time < now`, sends an on-chain `expire_policy` instruction
 * signed by the oracle wallet (any signer works — the instruction is
 * permissionless — but we piggyback on the oracle keypair we already load).
 *
 * Intentionally does NOT touch the DB: the policy-indexer reconciles from
 * chain every 60 s and will pick up the new `Expired` state in its own
 * sweep. Writing both from here would race with the indexer and lose.
 *
 * Self-healing observability: if the backlog grows past
 * {@link STUCK_WARN_THRESHOLD} in a single tick we log a WARN so operators
 * notice in routine log review; the same counter is also reachable via
 * `GET /api/monitoring/metrics` (`policyLag.stuckCount`) for dashboards.
 */
export function startExpiryCrank(db: Database, redis: Redis, config: AppConfig) {
  let ctx: CovanticProgram;
  try {
    ctx = createCovanticProgram(config, { withOracle: true });
  } catch (err) {
    logger.error({ err }, 'Expiry crank disabled: failed to load program');
    return null;
  }
  if (!ctx.oracleKeypair) {
    logger.error('Expiry crank disabled: oracle keypair not loaded');
    return null;
  }

  const queue = new Queue(QUEUE_NAME, { connection: redis });

  queue.upsertJobScheduler(
    'check-expired',
    { every: EVERY_MS },
    {
      name: 'check-expired-policies',
      // Bound retained history — without this, every completed cron run leaks a
      // job hash into Redis forever and eventually trips `noeviction` maxmemory.
      opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
    },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await runOnce(db, ctx);
    },
    { connection: redis },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.name, err }, 'Expiry crank job failed');
  });

  // Run immediately on boot so a restart doesn't wait the first 60 s
  // tick before cleaning up a backlog.
  runOnce(db, ctx).catch((err) => logger.error({ err }, 'Initial expiry sweep failed'));

  logger.info('Expiry crank started (on-chain cranker)');
  return worker;
}

async function runOnce(db: Database, ctx: CovanticProgram): Promise<void> {
  const now = new Date();
  const stuck = await db
    .select({
      policyId: policies.policyId,
      holderAddress: policies.holderAddress,
      expiryTime: policies.expiryTime,
    })
    .from(policies)
    .where(and(eq(policies.state, PolicyState.Active), lt(policies.expiryTime, now)))
    .orderBy(asc(policies.expiryTime))
    .limit(BATCH_LIMIT);

  if (stuck.length === 0) return;
  if (stuck.length >= STUCK_WARN_THRESHOLD) {
    logger.warn(
      { count: stuck.length, oldestExpiry: stuck[0]?.expiryTime },
      'Expiry crank backlog unusually large — check for stuck policies',
    );
  } else {
    logger.info({ count: stuck.length }, 'Expiry crank: cranking stale policies');
  }

  let ok = 0;
  let failed = 0;
  for (const row of stuck) {
    const policyPda = derivePolicyPda(ctx.programId, row.holderAddress, row.policyId);
    try {
      const sig = await (ctx.program.methods as any)
        .expirePolicy()
        .accounts({
          cranker: ctx.oracleKeypair!.publicKey,
          policy: policyPda,
          // `vault` resolves from const VAULT_SEED in the IDL.
        })
        .rpc();
      ok += 1;
      logger.info(
        { policyId: row.policyId, pda: policyPda.toBase58(), signature: sig },
        'Expiry crank: policy expired on-chain',
      );
    } catch (err) {
      failed += 1;
      // Most common non-bug reason: two crank instances raced on the same
      // policy, or the indexer already observed a chain-side state change
      // we haven't mirrored yet. Log at warn so it's visible but doesn't
      // clobber the log stream.
      logger.warn(
        {
          err: err instanceof Error ? err.message : err,
          policyId: row.policyId,
          pda: policyPda.toBase58(),
        },
        'Expiry crank: expire_policy failed (will retry next tick)',
      );
    }
  }

  logger.info({ attempted: stuck.length, ok, failed }, 'Expiry crank: tick complete');
}

function derivePolicyPda(programId: PublicKey, holder: string, policyId: number): PublicKey {
  const holderPk = new PublicKey(holder);
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(policyId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.POLICY), holderPk.toBuffer(), idBuf],
    programId,
  )[0];
}
