import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  CONFIG_SEED,
  VAULT_SEED,
  derivePda,
  explorerTxUrl,
  setupProgram,
} from './demo-common.js';
import { agents, vaultSnapshots } from '../src/db/schema.js';
import { createDbConnection } from '../src/config/database.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const { cfg, connection, keypair, program, programId } = setupProgram();
  logger.info(`Seeding demo data on ${cfg.SOLANA_NETWORK}`);
  logger.info(`Oracle: ${keypair.publicKey.toBase58()}`);

  const configPda = derivePda([CONFIG_SEED], programId);
  const vaultPda = derivePda([VAULT_SEED], programId);

  const configInfo = await connection.getAccountInfo(configPda);
  if (!configInfo) {
    logger.warn(
      'Protocol not initialized on-chain. Run `anchor deploy` + initialize first.',
    );
  } else {
    const cfgAcc: any = await (program.account as any).protocolConfig.fetch(configPda);
    logger.info(`Protocol initialized. Oracle: ${cfgAcc.oracleAuthority.toBase58()}`);
    logger.info(`USDC mint: ${cfgAcc.usdcMint.toBase58()}`);
  }

  const db = createDbConnection(cfg.DATABASE_URL);

  await db
    .insert(agents)
    .values([
      {
        walletAddress: '7nYBm3hXGDFQGfTXvbVwHJCmKxXJEATBGVK7FvCGVzDr',
        ownerAddress: keypair.publicKey.toBase58(),
        name: 'SafeTrader',
        description: 'Conservative DeFi trading agent',
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
        ownerAddress: keypair.publicKey.toBase58(),
        name: 'RiskyBot',
        description: 'Aggressive DeFi arbitrage agent',
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
  logger.info('Seeded 2 demo agents');

  try {
    const vaultAcc: any = await (program.account as any).insuranceVault.fetch(vaultPda);
    await db.insert(vaultSnapshots).values({
      totalStaked: Number(vaultAcc.totalStaked.toString()),
      totalCoverage: Number(vaultAcc.totalCoverage.toString()),
      totalPremiums: Number(vaultAcc.totalPremiumsCollected.toString()),
      totalClaimsPaid: Number(vaultAcc.totalClaimsPaid.toString()),
      stakerCount: vaultAcc.stakerCount,
      solvencyRatio: vaultAcc.solvencyRatio / 10000,
      activePolicies: 0,
    });
    logger.info('Vault snapshot written');
  } catch (err) {
    logger.warn({ err }, 'Could not fetch vault; skipping snapshot');
  }

  // Airdrop SOL to oracle so it can pay gas for demo actions
  try {
    const sig = await connection.requestAirdrop(keypair.publicKey, LAMPORTS_PER_SOL);
    logger.info(`Oracle airdrop tx: ${explorerTxUrl(sig)}`);
  } catch (err) {
    logger.warn({ err }, 'Oracle airdrop failed (maybe throttled)');
  }

  logger.info('Seed complete');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
