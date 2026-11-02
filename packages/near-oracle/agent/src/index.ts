import { PublicKey } from '@solana/web3.js';
import { requireEnv } from './config.js';
import { createAgent } from './deps.js';
import { watch } from './watcher.js';

const policies = requireEnv('WATCH_POLICIES')
  .split(',')
  .map((value) => new PublicKey(value.trim()));

await watch(await createAgent(), policies);
