import { Connection, Keypair } from '@solana/web3.js';
import fs from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

export function createSolanaConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, 'confirmed');
}

/**
 * Resolve keypair paths from .env against the monorepo root first, falling
 * back to cwd. `.env` lives at the repo root, so paths written there (e.g.
 * `./keys/oracle-keypair.json`) should be interpreted relative to the root
 * regardless of which package invokes `loadKeypair`.
 */
export function loadKeypair(path: string): Keypair {
  const candidates: string[] = [];
  if (isAbsolute(path)) {
    candidates.push(path);
  } else {
    // Monorepo root from packages/api/src/config
    candidates.push(resolve(import.meta.dirname, '../../../../', path));
    candidates.push(resolve(process.cwd(), path));
  }
  for (const p of candidates) {
    try {
      const secret = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return Keypair.fromSecretKey(Uint8Array.from(secret));
    } catch {
      // try next
    }
  }
  throw new Error(
    `Keypair not found. Tried: ${candidates.join(', ')}. Check ORACLE_KEYPAIR_PATH in .env.`,
  );
}
