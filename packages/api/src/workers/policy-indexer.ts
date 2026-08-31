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
import { fetchAllAnchorAccounts } from '../utils/anchor-reader.js';
import { getSolanaReader, type SolanaReader } from '../utils/solana-reader.js';

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
  const reader = getSolanaReader(config);

  const queue = new Queue(QUEUE_NAME, { connection: redis });

  queue.upsertJobScheduler(
    'reconcile-policies',
    { every: RECONCILE_EVERY_MS },
    {
      name: 'reconcile-policies',
      // Bound retained history — without this, every completed cron run leaks a
      // job hash into Redis forever and eventually trips `noeviction` maxmemory.
      opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
    },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await reconcilePolicies(db, ctx, reader);
    },
    { connection: redis },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.name, err }, 'Policy indexer job failed');
  });

  // Kick off an immediate reconcile so freshly booted API catches up without
  // waiting the first 60s tick. Fire-and-forget; errors are logged inside.
  reconcilePolicies(db, ctx, reader).catch((err) =>
    logger.error({ err }, 'Initial policy reconcile failed'),
  );

  logger.info('Policy indexer started');
  return worker;
}

/**
 * Highest listing slot applied, so a lagging endpoint cannot walk state back.
 * See the note at its use — per-process by design.
 */
let lastIndexedSlot = 0;
/** How many policies the last successful reconcile saw. */
let lastIndexedCount = 0;

async function reconcilePolicies(
  db: Database,
  ctx: CovanticProgram,
  reader: SolanaReader,
): Promise<void> {
  // `getProgramAccounts` is the heaviest call this service makes — providers
  // weight it far above an ordinary read — so it goes over the endpoint pool
  // rather than spending the primary's quota alone.
  const listing = await fetchAllAnchorAccounts(ctx, reader, 'insurancePolicy');
  const accounts = listing.accounts;

  // Reads now fan out, and this one *overwrites* state our own writes produce:
  // `onConflictDoUpdate` copies `state` verbatim, so an endpoint a few slots
  // behind reverts a policy the chain has already moved to `ClaimPending`. The
  // documented carve-out covers "did our write land"; this is the neighbouring
  // case, and the cheap guard is to refuse an answer older than the one
  // already applied.
  //
  // Per-process, deliberately: a column on `policies` would survive a restart
  // and coordinate the api and monitor containers, and is the right shape if
  // this ever needs to be stronger. Within one process it closes the window
  // the failover actually opens.
  if (listing.slot > 0 && listing.slot < lastIndexedSlot) {
    logger.warn(
      { listingSlot: listing.slot, lastIndexedSlot },
      'Policy indexer: skipping a view older than the one already applied',
    );
    return;
  }
  lastIndexedSlot = Math.max(lastIndexedSlot, listing.slot);

  if (accounts.length === 0) {
    // Not `debug`. An empty program is indistinguishable from an endpoint that
    // answered without honouring the filter, and the difference is every
    // policy in the mirror going stale with nothing in the log saying so.
    logger[lastIndexedCount > 0 ? 'warn' : 'debug'](
      { lastIndexedCount },
      'Policy indexer: no on-chain policies found',
    );
    return;
  }
  lastIndexedCount = accounts.length;

  const claimPendingPolicyIds: number[] = [];

  for (const { account, publicKey } of accounts as Array<{
    account: any;
    publicKey: string;
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
      pdaAddress: publicKey,
      updatedAt: new Date(),
    };

    if (row.state === PolicyState.ClaimPending) {
      claimPendingPolicyIds.push(row.policyId);
    }

    // On-chain is authoritative for every field except `createdAt` (first
    // time we saw this policyId — preserved for analytics). Critically,
    // `pdaAddress`, `holderAddress`, `agentAddress` must be refreshed on
    // conflict too: after a program redeploy the PDA changes while the
    // policy_id can repeat, and a stale PDA poisons /why-active, the
    // on-chain expiry-crank, and anything else that reads back by PDA.
    await db
      .insert(policies)
      .values({
        ...row,
        createdAt: new Date(startTimeSec * 1000),
      })
      .onConflictDoUpdate({
        target: policies.policyId,
        set: {
          pdaAddress: row.pdaAddress,
          holderAddress: row.holderAddress,
          agentAddress: row.agentAddress,
          coverageAmount: row.coverageAmount,
          premiumPaid: row.premiumPaid,
          riskTier: row.riskTier,
          startTime: row.startTime,
          expiryTime: row.expiryTime,
          state: row.state,
          triggerType: row.triggerType,
          triggerTxSignature: row.triggerTxSignature,
          claimSubmittedAt: row.claimSubmittedAt,
          payoutAmount: row.payoutAmount,
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
      const onChain = (accounts as Array<{ account: any; publicKey: string }>).find(
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
