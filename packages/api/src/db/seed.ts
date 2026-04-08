import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { logger } from '../utils/logger.js';

async function seed() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  logger.info('Seeding database...');

  // Create test agents
  await db
    .insert(schema.agents)
    .values([
      {
        walletAddress: '7nYBm3hXGDFQGfTXvbVwHJCmKxXJEATBGVK7FvCGVzDr',
        ownerAddress: 'DemoOwner111111111111111111111111111111111',
        name: 'SafeTrader',
        description: 'Conservative DeFi trading agent with low risk profile',
        riskScore: 0.15,
        riskTier: 0,
        riskScoredAt: new Date(),
        totalTransactions: 1250,
        failedTransactions: 12,
        protocolsUsed: 5,
        walletAge: 180,
      },
      {
        walletAddress: '3kTzqDN8uEZwFEhQKvPXDvMkZxvPcFpHgEL9mJQfYWxC',
        ownerAddress: 'DemoOwner111111111111111111111111111111111',
        name: 'RiskyBot',
        description: 'Aggressive DeFi arbitrage agent with high risk tolerance',
        riskScore: 0.72,
        riskTier: 2,
        riskScoredAt: new Date(),
        totalTransactions: 8500,
        failedTransactions: 850,
        protocolsUsed: 12,
        walletAge: 45,
      },
    ])
    .onConflictDoNothing();

  // Create initial vault snapshot
  await db.insert(schema.vaultSnapshots).values({
    totalStaked: 1000_000_000, // 1000 USDC
    totalCoverage: 500_000_000, // 500 USDC
    totalPremiums: 25_000_000, // 25 USDC
    totalClaimsPaid: 0,
    stakerCount: 3,
    solvencyRatio: 2.0,
    activePolicies: 2,
  });

  // Create sample monitoring events
  await db.insert(schema.monitoringEvents).values([
    {
      agentAddress: '7nYBm3hXGDFQGfTXvbVwHJCmKxXJEATBGVK7FvCGVzDr',
      eventType: 'large_transfer',
      severity: 'info',
      txSignature: '5VERv8NMhm5Z3gBFaATa..demo1',
      details: { amount: 50_000_000, destination: 'Raydium AMM' },
    },
    {
      agentAddress: '3kTzqDN8uEZwFEhQKvPXDvMkZxvPcFpHgEL9mJQfYWxC',
      eventType: 'oracle_deviation',
      severity: 'warning',
      txSignature: '5VERv8NMhm5Z3gBFaATa..demo2',
      details: { deviation: 0.065, feed: 'SOL/USD', twap: 148.5, spot: 158.15 },
    },
    {
      agentAddress: '3kTzqDN8uEZwFEhQKvPXDvMkZxvPcFpHgEL9mJQfYWxC',
      eventType: 'failed_tx',
      severity: 'critical',
      txSignature: '5VERv8NMhm5Z3gBFaATa..demo3',
      details: { error: 'SlippageToleranceExceeded', program: 'Jupiter v6' },
    },
  ]);

  logger.info('Seed completed successfully');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
