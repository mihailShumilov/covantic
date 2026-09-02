import { sha256 } from '@noble/hashes/sha256';

/**
 * The envelope commitment a premium is quoted against.
 *
 * This is the TypeScript half of `AgentMandate::commitment()`. The oracle
 * hashes the envelope it priced into the attestation it signs, and
 * `create_policy` recomputes the hash from the arguments it was handed and
 * refuses a mismatch — so the deductible a holder ends up with is the one the
 * premium was quoted for, rather than one authored afterwards.
 *
 * ## Why the layout is written out rather than delegated to a serialiser
 *
 * The other side of this hash is Rust. A format the two languages merely
 * *happen* to agree on is one an upgrade can quietly split, and the failure is
 * asymmetric: if they diverge, every purchase fails loudly, which is
 * survivable — but if a *stale* implementation keeps matching, a premium goes
 * on being quoted for an envelope nobody is receiving. Explicit little-endian
 * fields and sorted keys are something both sides can implement from the
 * description, and a test compares them against fixed vectors.
 *
 * `manifestHash` is deliberately excluded, on both sides. It commits to
 * off-chain terms the program cannot read and the oracle does not price;
 * folding it in would make the quote depend on a value neither can check.
 *
 * Written against `Uint8Array` and `@noble/hashes` rather than `Buffer` and
 * `node:crypto`, because this package is isomorphic and the browser needs it:
 * the purchase form is where a holder chooses the envelope, so the commitment
 * has to be computable where the choice is made.
 */
export interface MandateEnvelope {
  /** Largest single outflow permitted, raw base units of the covered mint. */
  maxSingleOutflowRaw: bigint | number;
  /** Largest cumulative outflow over `windowSeconds`. */
  maxWindowOutflowRaw: bigint | number;
  windowSeconds: bigint | number;
  /** Balance the agent must never take the covered account below. */
  minRetainedBalanceRaw: bigint | number;
  /** Destinations the holder permits. Order does not matter. */
  allowedCounterparties: Uint8Array[];
  /** Programs the holder permits. Order does not matter. */
  allowedPrograms: Uint8Array[];
}

/** Little-endian, signedness only affects how a negative would be written —
 *  every field here is a count or an amount and the program rejects negatives
 *  before hashing. */
function u64le(v: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(v), true);
  return out;
}

function i64le(v: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(v), true);
  return out;
}

/** Bytewise, matching Rust's `sort_unstable` over `[u8; 32]`. Sorting is what
 *  makes the commitment independent of the order a form happened to collect
 *  the addresses in. */
function sortedKeys(keys: Uint8Array[]): Uint8Array[] {
  return [...keys].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
    }
    return a.length - b.length;
  });
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function agentMandateCommitment(envelope: MandateEnvelope): Uint8Array {
  const counterparties = sortedKeys(envelope.allowedCounterparties);
  const programs = sortedKeys(envelope.allowedPrograms);

  return sha256(
    concat([
      u64le(envelope.maxSingleOutflowRaw),
      u64le(envelope.maxWindowOutflowRaw),
      i64le(envelope.windowSeconds),
      u64le(envelope.minRetainedBalanceRaw),
      Uint8Array.from([counterparties.length]),
      ...counterparties,
      Uint8Array.from([programs.length]),
      ...programs,
    ]),
  );
}
