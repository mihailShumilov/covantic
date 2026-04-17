import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import {
  PDA_SEEDS,
  SOLANA_ADDRESS_REGEX,
  type StakerPositionResponse,
} from '@covantic/shared';
import { logger } from '../utils/logger.js';

const STAKER_SEED = Buffer.from(PDA_SEEDS.STAKER);
const VAULT_SEED = Buffer.from(PDA_SEEDS.VAULT);

/**
 * Byte offsets of fields in the on-chain StakerPosition account, measured
 * after the 8-byte Anchor discriminator. Keep in sync with
 * `packages/anchor/programs/covantic/src/state/staker_position.rs`.
 */
const STAKER_LAYOUT = {
  version: 0,                 // u8 (1)
  staker: 1,                  // Pubkey (32)
  amountStaked: 33,           // u64 (8)
  shareBps: 41,               // u16 (2)
  rewardsClaimed: 43,         // u64 (8)
  rewardsPending: 51,         // u64 (8)
  rewardPerStakeSnapshot: 59, // u128 (16)
  depositedAt: 75,            // i64 (8)
  unstakeRequestedAt: 83,     // i64 (8)
  bump: 91,                   // u8 (1)
} as const;
const STAKER_LAYOUT_SIZE = 92;

/**
 * Byte offsets of fields in the on-chain InsuranceVault account, measured
 * after the 8-byte Anchor discriminator. Keep in sync with
 * `packages/anchor/programs/covantic/src/state/insurance_vault.rs`.
 * We only read the fields needed to surface live pending rewards.
 */
const VAULT_LAYOUT = {
  rewardPerStakeAcc: 79, // u128 (16)
} as const;
const VAULT_MIN_LAYOUT_SIZE = VAULT_LAYOUT.rewardPerStakeAcc + 16;

/** Must match REWARD_PER_STAKE_SCALE in insurance_vault.rs (1e12). */
const REWARD_PER_STAKE_SCALE = 1_000_000_000_000n;

/** Anchor account discriminator = sha256("account:StakerPosition")[0..8]. */
const STAKER_DISCRIMINATOR = createHash('sha256')
  .update('account:StakerPosition')
  .digest()
  .subarray(0, 8);

/** Anchor account discriminator = sha256("account:InsuranceVault")[0..8]. */
const VAULT_DISCRIMINATOR = createHash('sha256')
  .update('account:InsuranceVault')
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
    const parsed = z
      .object({ address: z.string().regex(SOLANA_ADDRESS_REGEX, 'Invalid Solana address') })
      .safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid Solana address' });
    }
    const { address } = parsed.data;

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
      const [vaultPda] = PublicKey.findProgramAddressSync([VAULT_SEED], programId);

      // Fetch staker + vault together so the live accumulator delta is
      // computed against a consistent snapshot.
      const [stakerInfo, vaultInfo] = await app.solanaConnection.getMultipleAccountsInfo(
        [stakerPda, vaultPda],
      );

      if (!stakerInfo) {
        return reply.send(emptyPosition(address));
      }

      if (stakerInfo.data.length < 8 + STAKER_LAYOUT_SIZE) {
        logger.warn(
          { address, len: stakerInfo.data.length },
          'StakerPosition account too small',
        );
        return reply.send(emptyPosition(address));
      }

      const discriminator = stakerInfo.data.subarray(0, 8);
      if (!discriminator.equals(STAKER_DISCRIMINATOR)) {
        logger.warn(
          { address, pda: stakerPda.toBase58() },
          'Account at staker PDA has wrong discriminator (not a StakerPosition)',
        );
        return reply.send(emptyPosition(address));
      }

      const data = stakerInfo.data.subarray(8);
      const staker = new PublicKey(
        data.subarray(STAKER_LAYOUT.staker, STAKER_LAYOUT.staker + 32),
      ).toBase58();
      const amountStakedBn = data.readBigUInt64LE(STAKER_LAYOUT.amountStaked);
      const amountStaked = toSafeNumber(amountStakedBn, 'amountStaked');
      const shareBps = data.readUInt16LE(STAKER_LAYOUT.shareBps);
      const rewardsClaimed = toSafeNumber(
        data.readBigUInt64LE(STAKER_LAYOUT.rewardsClaimed),
        'rewardsClaimed',
      );
      const crystallizedPending = data.readBigUInt64LE(STAKER_LAYOUT.rewardsPending);
      const rewardPerStakeSnapshot = readU128LE(
        data,
        STAKER_LAYOUT.rewardPerStakeSnapshot,
      );
      const depositedAt = Number(data.readBigInt64LE(STAKER_LAYOUT.depositedAt));
      const unstakeRequestedAt = Number(
        data.readBigInt64LE(STAKER_LAYOUT.unstakeRequestedAt),
      );

      // Rewards from premiums since the last stake/claim/unstake are only
      // recorded in the vault's global `reward_per_stake_acc`; the staker's
      // on-chain `rewards_pending` is stale until they touch their position
      // again. Mirror the on-chain `pending_reward_delta` formula so the UI
      // can show the live total.
      const rewardPerStakeAcc = readVaultRewardPerStakeAcc(vaultInfo ?? null, vaultPda, address);
      let livePending = crystallizedPending;
      if (rewardPerStakeAcc !== null && amountStakedBn > 0n) {
        const accDelta =
          rewardPerStakeAcc >= rewardPerStakeSnapshot
            ? rewardPerStakeAcc - rewardPerStakeSnapshot
            : 0n;
        const earned = (accDelta * amountStakedBn) / REWARD_PER_STAKE_SCALE;
        livePending = crystallizedPending + earned;
      }

      const response: StakerPositionResponse = {
        staker,
        amountStaked,
        shareBps,
        rewardsClaimed,
        rewardsPending: toSafeNumber(livePending, 'rewardsPending'),
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

/** Read a little-endian u128 from `buf` at `offset`. */
function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

/**
 * Decode `reward_per_stake_acc` from an InsuranceVault account, returning
 * null if the account is missing, too small, or has the wrong discriminator.
 */
function readVaultRewardPerStakeAcc(
  vaultInfo: { data: Buffer } | null,
  vaultPda: PublicKey,
  stakerAddress: string,
): bigint | null {
  if (!vaultInfo) {
    logger.warn(
      { staker: stakerAddress, vault: vaultPda.toBase58() },
      'InsuranceVault account not found; pending rewards will omit live accrual',
    );
    return null;
  }
  if (vaultInfo.data.length < 8 + VAULT_MIN_LAYOUT_SIZE) {
    logger.warn(
      { vault: vaultPda.toBase58(), len: vaultInfo.data.length },
      'InsuranceVault account too small for expected layout',
    );
    return null;
  }
  const disc = vaultInfo.data.subarray(0, 8);
  if (!disc.equals(VAULT_DISCRIMINATOR)) {
    logger.warn(
      { vault: vaultPda.toBase58() },
      'Account at vault PDA has wrong discriminator (not an InsuranceVault)',
    );
    return null;
  }
  const body = vaultInfo.data.subarray(8);
  return readU128LE(body, VAULT_LAYOUT.rewardPerStakeAcc);
}
