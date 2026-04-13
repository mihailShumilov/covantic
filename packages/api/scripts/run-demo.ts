import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { logger } from '../src/utils/logger.js';

function run(script: string): void {
  const cwd = resolve(process.cwd());
  const result = spawnSync('tsx', [resolve(cwd, 'scripts', script)], {
    stdio: 'inherit',
    cwd,
  });
  if (result.status !== 0) {
    throw new Error(`${script} exited with code ${result.status ?? 'unknown'}`);
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  logger.info('--- Covantic demo sequence ---');

  logger.info('[1/4] Seeding demo data');
  run('seed-demo.ts');

  logger.info('[2/4] Showing SafeTrader risk assessment');
  try {
    const res = await fetch(
      'http://localhost:4099/api/risk/7nYBm3hXGDFQGfTXvbVwHJCmKxXJEATBGVK7FvCGVzDr',
    );
    if (res.ok) {
      const data = await res.json();
      logger.info(
        { tier: data.tier, score: data.score, premiumBps: data.premiumBps },
        'SafeTrader risk',
      );
    } else {
      logger.warn({ status: res.status }, 'Risk API unavailable');
    }
  } catch (err) {
    logger.warn({ err }, 'Could not reach API; is `pnpm --filter api dev` running?');
  }

  logger.info('[3/4] Pausing 2s before triggering exploit');
  await sleep(2000);

  logger.info('[4/4] Simulating exploit + payout');
  run('simulate-exploit.ts');

  logger.info('Demo complete. Check explorer links above.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
