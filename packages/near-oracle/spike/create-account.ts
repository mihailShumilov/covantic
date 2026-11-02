/**
 * Day-1 spike: create a throwaway NEAR testnet account through the public
 * faucet helper and store its key in packages/near-oracle/.env (gitignored).
 * The key is never printed.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { KeyPair } from 'near-api-js';

const ENV_PATH = resolve(import.meta.dirname, '..', '.env');
const FAUCET_URL = 'https://helper.nearprotocol.com/account';

async function main(): Promise<void> {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  if (/^NEAR_ACCOUNT_ID=.+/m.test(existing)) {
    process.stdout.write('NEAR_ACCOUNT_ID already set in .env, nothing to do\n');
    return;
  }

  const accountId = `covantic-spike-${randomBytes(4).toString('hex')}.testnet`;
  const keyPair = KeyPair.fromRandom('ed25519');

  const response = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      newAccountId: accountId,
      newAccountPublicKey: keyPair.getPublicKey().toString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`faucet answered ${response.status}: ${await response.text()}`);
  }

  const lines = [`NEAR_ACCOUNT_ID=${accountId}`, `NEAR_PRIVATE_KEY=${keyPair.toString()}`];
  writeFileSync(ENV_PATH, `${existing}${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
  process.stdout.write(`created ${accountId}\n`);
  process.stdout.write(`https://testnet.nearblocks.io/address/${accountId}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
