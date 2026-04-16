import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { and, inArray } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import { PolicyState } from '@covantic/shared';
import type { Database } from '../config/database.js';
import type { AppConfig } from '../config/env.js';
import { claims, policies } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { createCovanticProgram, type CovanticProgram } from '../utils/program.js';

const QUEUE_NAME = 'policy-indexer';
const RECONCILE_EVERY_MS = 60_000;

function bnToNumber(v: any): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

function triggerSigBytesToString(
  bytes: Uint8Array | number[] | Buffer | null | undefined,
): string | null {
  if (!bytes || bytes.length === 0) return null;
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Reconcile on-chain InsurancePolicy accounts into the `policies` table.
 *
 * The monorepo's policy purchase flow only writes to chain; without this
 * indexer the off-chain API has no view of user-owned policies, which is
 * exactly what the claim-keeper and public /api/policies endpoint need.
 *
 * Strategy: on boot + every 60s, fetch all program accounts of type
 * InsurancePolicy and upsert by `policyId`. Simple and reliable; can be
 * upgraded to a `connection.onLogs` subscription later if latency matters.
 */
export function startPolicyIndexer(db: Database, redis: Redis, config: AppConfig) {
  let ctx: CovanticProgram;
  try {
    ctx = createCovanticProgram(config, { withOracle: false });
  } catch (err) {
    logger.error({ err }, 'Policy indexer disabled: failed to load program');
    return null;
  }

  const queue = new Queue(QUEUE_NAME, { connection: redis });

  queue.upsertJobScheduler(
    'reconcile-policies',
    { every: RECONCILE_EVERY_MS },
    { name: 'reconcile-policies' },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await reconcilePolicies(db, ctx);
    },
    { connection: redis },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.name, err }, 'Policy indexer job failed');
  });

  // Kick off an immediate reconcile so freshly booted API catches up without
  // waiting the first 60s tick. Fire-and-forget; errors are logged inside.
  reconcilePolicies(db, ctx).catch((err) =>
    logger.error({ err }, 'Initial policy reconcile failed'),
  );

  logger.info('Policy indexer started');
  return worker;
}

async function reconcilePolicies(db: Database, ctx: CovanticProgram): Promise<void> {
  const accounts = await (ctx.program.account as any).insurancePolicy.all();

  if (accounts.length === 0) {
    logger.debug('Policy indexer: no on-chain policies found');
    return;
  }

  const claimPendingPolicyIds: number[] = [];

  for (const { account, publicKey } of accounts as Array<{
    account: any;
    publicKey: PublicKey;
  }>) {
    const policyId = bnToNumber(account.policyId);
    const startTimeSec = bnToNumber(account.startTime);
    const expiryTimeSec = bnToNumber(account.expiryTime);
    const claimSubmittedAtSec = bnToNumber(account.claimSubmittedAt);

    const row = {
      policyId,
      holderAddress: (account.holder as PublicKey).toBase58(),
      agentAddress: (account.agentAddress as PublicKey).toBase58(),
      coverageAmount: bnToNumber(account.coverageAmount),
      premiumPaid: bnToNumber(account.premiumPaid),
      riskTier: account.riskTier as number,
      startTime: new Date(startTimeSec * 1000),
      expiryTime: new Date(expiryTimeSec * 1000),
      claimSubmittedAt: claimSubmittedAtSec > 0 ? new Date(claimSubmittedAtSec * 1000) : null,
      state: account.state as number,
      triggerType: (account.triggerType as number) ?? 0,
      triggerTxSignature: triggerSigBytesToString(account.triggerTxSignature),
      payoutAmount: bnToNumber(account.payoutAmount),
      pdaAddress: publicKey.toBase58(),
      updatedAt: new Date(),
    };

    if (row.state === PolicyState.ClaimPending) {
      claimPendingPolicyIds.push(row.policyId);
    }

    await db
      .insert(policies)
      .values({
        ...row,
        createdAt: new Date(startTimeSec * 1000),
      })
      .onConflictDoUpdate({
        target: policies.policyId,
        set: {
          state: row.state,
          triggerType: row.triggerType,
          triggerTxSignature: row.triggerTxSignature,
          claimSubmittedAt: row.claimSubmittedAt,
          payoutAmount: row.payoutAmount,
          expiryTime: row.expiryTime,
          updatedAt: row.updatedAt,
        },
      });
  }

  // Sync on-chain ClaimPending state back to the claims table. If a holder
  // filed a claim via submit_claim (not oracle_submit_claim), the keeper
  // wouldn't otherwise see it and could attempt a duplicate submission.
  if (claimPendingPolicyIds.length > 0) {
    const existingOpen = await db
      .select({ policyId: claims.policyId })
      .from(claims)
      .where(
        and(
          inArray(claims.policyId, claimPendingPolicyIds),
          inArray(claims.status, ['pending', 'verifying', 'approved', 'paying'] as string[]),
        ),
      );
    const covered = new Set(existingOpen.map((r) => r.policyId));

    const missing = claimPendingPolicyIds.filter((id) => !covered.has(id));
    for (const policyId of missing) {
      const onChain = (accounts as Array<{ account: any; publicKey: PublicKey }>).find(
        ({ account }) => bnToNumber(account.policyId) === policyId,
      );
      if (!onChain) continue;
      const account = onChain.account;
      const sig = triggerSigBytesToString(account.triggerTxSignature) ?? 'onchain';
      await db
        .insert(claims)
        .values({
          policyId,
          holderAddress: (account.holder as PublicKey).toBase58(),
          agentAddress: (account.agentAddress as PublicKey).toBase58(),
          triggerType: (account.triggerType as number) ?? 0,
          triggerTxSignature: sig,
          status: 'approved',
          verificationData: { source: 'policy-indexer', note: 'mirrored from on-chain ClaimPending' },
        })
        .onConflictDoNothing();
      logger.info({ policyId }, 'policy-indexer: mirrored on-chain ClaimPending into claims');
    }

    // Also reconcile ClaimPaid: if the chain says ClaimPaid but the DB claim
    // is still approved/paying, catch up so the UI doesn't block a retry.
  }

  logger.debug({ count: accounts.length }, 'Policy indexer reconcile complete');
}
