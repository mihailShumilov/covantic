import { describe, expect, it } from 'vitest';
import { agentMandateCommitment } from '@covantic/shared';

/**
 * INV-COMMIT-01 — both halves of the envelope commitment agree.
 *
 * The premium is quoted against a declared deductible, and `create_policy`
 * enforces that by recomputing the commitment from the arguments it was handed
 * and comparing it to the one the oracle signed. That check is only worth
 * anything while Rust and TypeScript produce the same bytes.
 *
 * They implement the layout independently — explicit little-endian fields and
 * sorted keys — rather than sharing a serialiser, because a format the two
 * merely happen to agree on is one an upgrade can split. So the vector below
 * is what holds them together. It is asserted identically in
 * `declare_agent_mandate.rs::commitment_tests::commits_to_a_known_value`; if
 * one side drifts, exactly one of the two tests fails, which says which side
 * moved.
 *
 * The failure this prevents is not "purchases break" — that is loud and
 * survivable. It is the quiet one: a stale implementation that keeps matching
 * while pricing an envelope nobody receives.
 */

const key = (byte: number) => new Uint8Array(32).fill(byte);

const envelope = (counterparties: Uint8Array[], programs: Uint8Array[]) => ({
  maxSingleOutflowRaw: 100_000_000,
  maxWindowOutflowRaw: 150_000_000,
  windowSeconds: 3_600,
  minRetainedBalanceRaw: 4_600_000_000,
  allowedCounterparties: counterparties,
  allowedPrograms: programs,
});

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('INV-COMMIT-01 — the commitment matches the on-chain vector', () => {
  it('produces the same bytes the program does', () => {
    expect(hex(agentMandateCommitment(envelope([key(1)], [key(2)])))).toBe(
      '121da6db6c63adfbd79263f232f1f109da30043c1cad5dd7708c6af28b4ae515',
    );
  });

  it('does not depend on the order keys arrive in', () => {
    // A purchase form collects addresses in whatever order they were typed. If
    // that changed the commitment, the same envelope would quote differently
    // and `create_policy` would reject a perfectly honest purchase.
    const a = agentMandateCommitment(envelope([key(1), key(9)], [key(2), key(8)]));
    const b = agentMandateCommitment(envelope([key(9), key(1)], [key(8), key(2)]));

    expect(hex(a)).toBe(hex(b));
  });

  it('changes when the deductible changes, which is the whole point', () => {
    const quoted = agentMandateCommitment(envelope([], []));
    const narrowed = agentMandateCommitment({
      ...envelope([], []),
      maxSingleOutflowRaw: 1_000_000,
    });

    expect(hex(quoted)).not.toBe(hex(narrowed));
  });

  it('accepts bigint and number alike, since raw amounts arrive as both', () => {
    const asNumber = agentMandateCommitment(envelope([], []));
    const asBigint = agentMandateCommitment({
      maxSingleOutflowRaw: 100_000_000n,
      maxWindowOutflowRaw: 150_000_000n,
      windowSeconds: 3_600n,
      minRetainedBalanceRaw: 4_600_000_000n,
      allowedCounterparties: [],
      allowedPrograms: [],
    });

    expect(hex(asNumber)).toBe(hex(asBigint));
  });
});
