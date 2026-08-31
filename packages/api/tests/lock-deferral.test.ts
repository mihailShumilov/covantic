import { describe, expect, it } from 'vitest';
import { LOCK_PERIODS } from '@covantic/shared';
import { LOCK_DEFERRAL_MS, isLockNotElapsed } from '../src/workers/claim-keeper.js';

/**
 * INV-LOCK-01 — "the lock has not elapsed" is a wait, not a verdict.
 *
 * The off-chain wait and the on-chain lock are two numbers in two languages,
 * and nothing makes them agree. `EXPLOIT_LOCK_SECONDS` sets the off-chain half
 * from `.env`; the on-chain half is a compiled constant that only a program
 * upgrade changes. Deploy the short wait against a program built without
 * `devnet-fast-lock` — a rollback, or a build that skipped the feature — and
 * every payout attempt reverts on `LockPeriodNotElapsed`.
 *
 * `JOB_OPTS` allows three attempts across roughly seventy seconds. A claim
 * whose real lock is an hour away therefore burned all three and settled into
 * `failed`, which is a *closed* status: the vault kept the money and the
 * record said the payout had been tried and lost, on a claim the chain was
 * merely asking us to wait for.
 */

describe('INV-LOCK-01 — a payout deferred by the lock is not a failed payout', () => {
  it('recognises the error in the message Anchor throws', () => {
    expect(
      isLockNotElapsed(new Error('AnchorError caused by account: policy. Error Code: LockPeriodNotElapsed. Error Number: 6014')),
    ).toBe(true);
  });

  it('recognises it in the simulation logs, where a preflight revert puts it', () => {
    const err = Object.assign(new Error('Transaction simulation failed'), {
      logs: [
        'Program CovanticFakeId invoke [1]',
        'Program log: AnchorError occurred. Error Code: LockPeriodNotElapsed. Error Number: 6014.',
        'Program CovanticFakeId failed: custom program error: 0x177e',
      ],
    });

    expect(isLockNotElapsed(err)).toBe(true);
  });

  it('does not match a different revert, which must still be recorded failed', () => {
    // The false positive is the dangerous direction: it would defer a genuine
    // failure through the whole schedule and delay the human by six hours.
    for (const other of [
      new Error('Error Code: InsufficientVaultBalance. Error Number: 6017'),
      new Error('Error Code: PolicyNotClaimPending. Error Number: 6015'),
      new Error('Error Code: ProtocolPaused. Error Number: 6019'),
      new Error('blockhash not found'),
    ]) {
      expect(isLockNotElapsed(other), other.message).toBe(false);
    }
  });

  it('waits past the longest lock the program can impose', () => {
    // The load-bearing number. If the schedule ran out before the on-chain
    // lock elapsed, a correctly-verified claim would still reach review — the
    // same wrong outcome the deferral exists to prevent, arriving later.
    const total = LOCK_DEFERRAL_MS.reduce((sum, ms) => sum + ms, 0);
    const longestLock = Math.max(...Object.values(LOCK_PERIODS)) * 1000;

    expect(total).toBeGreaterThan(longestLock);
  });

  it('is bounded, so a claim the chain never allows still reaches a human', () => {
    expect(LOCK_DEFERRAL_MS.length).toBeGreaterThan(0);
    expect(Number.isFinite(LOCK_DEFERRAL_MS.length)).toBe(true);
  });
});
