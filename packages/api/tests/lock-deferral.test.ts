import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

  it('starts short, because the common miss is a second or two', () => {
    // The payout timer is anchored to the chain's `claim_submitted_at`, but a
    // clock that agrees to the second is not a clock that agrees. A first step
    // of a minute made one observed run wait 64 seconds out for a lock with
    // two seconds left on it — most of a demonstration, and on the six-hour
    // agent-error lock in production, a needless hour.
    expect(LOCK_DEFERRAL_MS[0]).toBeLessThanOrEqual(10_000);
  });

  it('grows, so short first steps do not become a long stream of attempts', () => {
    // Strictly increasing, and few. An earlier version of this assertion
    // demanded each step quadruple, which was a number I invented rather than
    // derived — the real schedule grows 6x, 10x, 6x, 4x, 3x, and the 3x at the
    // end is harmless. What matters is that no step repeats or shrinks, and
    // that the whole schedule is a handful of attempts rather than a poll.
    for (let i = 1; i < LOCK_DEFERRAL_MS.length; i += 1) {
      expect(LOCK_DEFERRAL_MS[i]!, `step ${i}`).toBeGreaterThan(LOCK_DEFERRAL_MS[i - 1]!);
    }
    expect(LOCK_DEFERRAL_MS.length).toBeLessThanOrEqual(8);
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

/**
 * INV-LOCK-02 — the payout timer runs on the chain's clock, not ours.
 *
 * `oracle_submit_claim` writes `claim_submitted_at` when the transaction
 * lands, and every lock is measured from it. The keeper used to compute the
 * expiry *before* submitting, so it fired early by the submit latency — not
 * occasionally, but on every claim, by several seconds.
 *
 * Nothing broke, because the deferral above absorbs it. It simply cost a
 * deferral step every time, on a mechanism built for the rare case of a
 * misconfigured wait.
 */
describe('INV-LOCK-02 — the schedule is anchored to claim_submitted_at', () => {
  it('reads the submitted-at back from the chain before scheduling', () => {
    const keeper = readFileSync(
      fileURLToPath(new URL('../src/workers/claim-keeper.ts', import.meta.url)),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');

    expect(keeper).toMatch(/claimSubmittedAtOnChain\(/);
    // And it must be used for the delay, not merely fetched.
    expect(keeper).toMatch(/anchored\.getTime\(\) - Date\.now\(\)/);
  });

  it('reads it off the connection that submitted, not the pool', () => {
    // Same reasoning as `isPolicySettledOnChain`: an endpoint a few slots
    // behind has not seen our own write, and would report no claim at all.
    const keeper = readFileSync(
      fileURLToPath(new URL('../src/workers/claim-keeper.ts', import.meta.url)),
      'utf8',
    );
    const fn = keeper.slice(
      keeper.indexOf('async function claimSubmittedAtOnChain'),
      keeper.indexOf('async function isPolicySettledOnChain'),
    );

    expect(fn).toMatch(/ctx\.program\.account/);
    expect(fn).not.toMatch(/reader\./);
  });
});
