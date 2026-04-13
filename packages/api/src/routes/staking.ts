import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { PDA_SEEDS, type StakerPositionResponse } from '@covantic/shared';
import { logger } from '../utils/logger.js';

const STAKER_SEED = Buffer.from(PDA_SEEDS.STAKER);

/**
 * Byte offsets of fields in the on-chain StakerPosition account, measured
 * after the 8-byte Anchor discriminator. Keep this in sync with
 * `packages/anchor/programs/covantic/src/state/staker_position.rs`.
 */
const STAKER_LAYOUT = {
  staker: 0,                 // Pubkey (32)
  amountStaked: 32,          // u64 (8)
  shareBps: 40,              // u16 (2)
  rewardsClaimed: 42,        // u64 (8)
  rewardsPending: 50,        // u64 (8)
  depositedAt: 58,           // i64 (8)
  unstakeRequestedAt: 66,    // i64 (8)
  bump: 74,                  // u8 (1)
} as const;
const STAKER_LAYOUT_SIZE = 75;

/** Anchor account discriminator = sha256("account:StakerPosition")[0..8]. */
const STAKER_DISCRIMINATOR = createHash('sha256')
  .update('account:StakerPosition')
  .digest()
  .subarray(0, 8);

function emptyPosition(address: string): StakerPositionResponse {
  return {
    staker: address,
    amountStaked: 0,
    shareBps: 0,
    rewardsClaimed: 0,
    rewardsPending: 0,
    depositedAt: null,
    unstakeRequestedAt: null,
  };
}

/** Convert a bigint amount to a Number, preserving precision up to 2^53. */
function toSafeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    logger.warn({ field, value: value.toString() }, 'u64 exceeds MAX_SAFE_INTEGER; clamping');
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(value);
}

export async function stakingRoutes(app: FastifyInstance) {
  const programId = new PublicKey(app.config.PROGRAM_ID);

  /** GET /api/staking/:address — Get staker position from chain */
  app.get('/api/staking/:address', async (request, reply) => {
    const { address } = z.object({ address: z.string().min(32) }).parse(request.params);

    let stakerPubkey: PublicKey;
    try {
      stakerPubkey = new PublicKey(address);
    } catch {
      return reply.send(emptyPosition(address));
    }

    try {
      const [stakerPda] = PublicKey.findProgramAddressSync(
        [STAKER_SEED, stakerPubkey.toBuffer()],
        programId,
      );

      const accountInfo = await app.solanaConnection.getAccountInfo(stakerPda);
      if (!accountInfo) {
        return reply.send(emptyPosition(address));
      }

      if (accountInfo.data.length < 8 + STAKER_LAYOUT_SIZE) {
        logger.warn(
          { address, len: accountInfo.data.length },
          'StakerPosition account too small',
        );
        return reply.send(emptyPosition(address));
      }

      const discriminator = accountInfo.data.subarray(0, 8);
      if (!discriminator.equals(STAKER_DISCRIMINATOR)) {
        logger.warn(
          { address, pda: stakerPda.toBase58() },
          'Account at staker PDA has wrong discriminator (not a StakerPosition)',
        );
        return reply.send(emptyPosition(address));
      }

      const data = accountInfo.data.subarray(8);
      const staker = new PublicKey(
        data.subarray(STAKER_LAYOUT.staker, STAKER_LAYOUT.staker + 32),
      ).toBase58();
      const amountStaked = toSafeNumber(
        data.readBigUInt64LE(STAKER_LAYOUT.amountStaked),
        'amountStaked',
      );
      const shareBps = data.readUInt16LE(STAKER_LAYOUT.shareBps);
      const rewardsClaimed = toSafeNumber(
        data.readBigUInt64LE(STAKER_LAYOUT.rewardsClaimed),
        'rewardsClaimed',
      );
      const rewardsPending = toSafeNumber(
        data.readBigUInt64LE(STAKER_LAYOUT.rewardsPending),
        'rewardsPending',
      );
      const depositedAt = Number(data.readBigInt64LE(STAKER_LAYOUT.depositedAt));
      const unstakeRequestedAt = Number(
        data.readBigInt64LE(STAKER_LAYOUT.unstakeRequestedAt),
      );

      const response: StakerPositionResponse = {
        staker,
        amountStaked,
        shareBps,
        rewardsClaimed,
        rewardsPending,
        depositedAt:
          depositedAt > 0 ? new Date(depositedAt * 1000).toISOString() : null,
        unstakeRequestedAt:
          unstakeRequestedAt > 0
            ? new Date(unstakeRequestedAt * 1000).toISOString()
            : null,
      };
      return reply.send(response);
    } catch (error) {
      logger.error({ error, address }, 'Failed to read staker position');
      return reply.send(emptyPosition(address));
    }
  });
}
