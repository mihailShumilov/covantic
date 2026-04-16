import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { sql, eq } from 'drizzle-orm';
import { PolicyState } from '@covantic/shared';
import { PublicKey } from '@solana/web3.js';
import type { Database } from '../config/database.js';
import type { AppConfig } from '../config/env.js';
import { vaultSnapshots, policies } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { createCovanticProgram, type CovanticProgram } from '../utils/program.js';

const QUEUE_NAME = 'solvency-checker';

function bnToNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') {
    return value > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(value);
  }
  const asAny = value as { toNumber?: () => number; toString?: () => string };
  if (typeof asAny.toNumber === 'function') return asAny.toNumber();
  return Number(asAny.toString?.() ?? 0);
}

/** Start the solvency checker worker.
 * Reads the on-chain InsuranceVault account and writes a snapshot every
 * 5 minutes. Previously this derived `totalStaked` from the last snapshot,
 * which drifted whenever stakes / payouts happened between ticks. */
export function startSolvencyChecker(db: Database, redis: Redis, config: AppConfig) {
  let programCtx: CovanticProgram;
  try {
    programCtx = createCovanticProgram(config, { withOracle: false });
  } catch (err) {
    logger.error({ err }, 'Solvency checker disabled: failed to load program');
    return null;
  }

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('covantic_vault')],
    programCtx.programId,
  );

  const queue = new Queue(QUEUE_NAME, { connection: redis });

  queue.upsertJobScheduler(
    'check-solvency',
    { every: 300_000 },
    {
      name: 'check-vault-solvency',
    },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      logger.debug('Checking vault solvency...');

      // On-chain vault is the source of truth for staking-side numbers.
      let vaultAccount: any;
      try {
        vaultAccount = await (programCtx.program.account as any).insuranceVault.fetch(vaultPda);
      } catch (err) {
        logger.warn({ err }, 'solvency-checker: vault account not yet initialized');
        return;
      }

      const totalStaked = bnToNumber(vaultAccount.totalStaked);
      const totalCoverage = bnToNumber(vaultAccount.totalCoverage);
      const totalPremiums = bnToNumber(vaultAccount.totalPremiumsCollected);
      const totalClaimsPaid = bnToNumber(vaultAccount.totalClaimsPaid);
      const stakerCount = Number(vaultAccount.stakerCount ?? 0);
      const solvencyRatio = Number(vaultAccount.solvencyRatio ?? 0);

      const [activeCountRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(policies)
        .where(eq(policies.state, PolicyState.Active));
      const activePolicies = Number(activeCountRow?.count ?? 0);

      await db.insert(vaultSnapshots).values({
        totalStaked,
        totalCoverage,
        totalPremiums,
        totalClaimsPaid,
        stakerCount,
        solvencyRatio,
        activePolicies,
        snapshotAt: new Date(),
      });

      await redis.publish(
        'vault:stats',
        JSON.stringify({
          channel: 'vault:stats',
          event: 'solvency_check',
          data: {
            totalStaked,
            totalCoverage,
            totalPremiums,
            totalClaimsPaid,
            stakerCount,
            solvencyRatio,
            activePolicies,
            checkedAt: new Date().toISOString(),
          },
          timestamp: Date.now(),
        }),
      );
    },
    { connection: redis },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.name, err }, 'Solvency checker job failed');
  });

  return worker;
}
