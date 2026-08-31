import type { Database } from '../config/database.js';
import type { AppConfig } from '../config/env.js';
import type { Connection } from '@solana/web3.js';
import type Redis from 'ioredis';
import type { AttestationPublisher } from '../services/attestation-publisher.js';
import type { SolanaReader } from '../utils/solana-reader.js';

/** Extend Fastify instance with custom decorations */
declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    redis: Redis;
    config: AppConfig;
    /** Signs and sends, on the primary endpoint only. */
    solanaConnection: Connection;
    /** Reads, failing over across every configured endpoint. */
    solanaReader: SolanaReader;
    attestationPublisher: AttestationPublisher;
  }
}
