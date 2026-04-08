import { Connection, Keypair } from '@solana/web3.js';
import fs from 'node:fs';

export function createSolanaConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, 'confirmed');
}

export function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
