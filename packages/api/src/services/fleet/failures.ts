/**
 * Strategies for generating deliberately-failing fleet transactions.
 *
 * The fleet needs to produce real on-chain failures so the AgentError
 * verifier's `failed_tx` branch (see `services/verifiers/agent-error.ts`)
 * has material to score. "Real" means: the tx is accepted by the RPC,
 * lands in a confirmed block, and carries a non-null `meta.err`. A
 * client-side serialization throw (too-large payload, invalid PDA, etc.)
 * does not count — no signature, no on-chain event.
 *
 * This module is intentionally decoupled from `@solana/web3.js` I/O.
 * `buildFailingInstruction` is a pure function so it can be unit-tested
 * without a `Connection`; the caller owns the Transaction lifecycle.
 *
 * Current strategies
 * ------------------
 *   FAILED_TX — SPL Memo v2 with a non-UTF-8 payload.
 *     The memo program rejects non-UTF-8 with
 *     `InstructionError::InvalidInstructionData`. Deterministic, small
 *     (~40 bytes), stable across mainnet-beta / devnet / testnet, and
 *     produces a real on-chain signature the monitor can index.
 *
 * Future strategies (placeholders, not wired yet)
 * -----------------------------------------------
 *   CRITICAL_TRANSFER — near-full balance drain to an unknown program.
 *   RAPID_LOSS        — back-to-back large outflows within a window.
 *   GOVERNANCE_ATTACK — abuse of a governance program, if/when present.
 *
 * Each strategy is expected to declare:
 *   - `kind`: machine-readable tag matching a verifier branch name
 *   - `expectedError`: the on-chain error class we expect to observe
 *   - `buildInstruction`: pure (pubkey → TransactionInstruction)
 *
 * Callers should treat the returned instruction as opaque. The
 * strategy is the contract, not the exact byte layout.
 */

import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { MAX_TX_BYTES, SPL_MEMO_PROGRAM_ID } from '@covantic/shared';

/** Machine-readable failure tag. Matches the `reason` field the AgentError
 *  verifier emits in its `details` output. */
export type FailureKind = 'failed_tx';

/** Structured description of an expected on-chain error class. Kept as a
 *  union so observability code can branch without parsing free-form text. */
export type ExpectedOnChainError =
  | { class: 'InstructionError'; variant: 'InvalidInstructionData' }
  | { class: 'InstructionError'; variant: 'Custom'; code: number };

/** Contract every failure strategy satisfies. */
export interface FailureStrategy {
  kind: FailureKind;
  /** Short human-readable label used in logs / the activity feed. */
  label: string;
  /** The on-chain error class we expect to observe. Used by tests and the
   *  future observability dashboard to assert the strategy is still doing
   *  what it claims after SDK upgrades. */
  expectedError: ExpectedOnChainError;
  /** Pure builder — no network I/O. The agent pubkey is attached to the
   *  instruction as a signer key so monitors can attribute the failure
   *  back to the agent that produced it. */
  buildInstruction(agent: PublicKey): TransactionInstruction;
}

/** Size of the non-UTF-8 payload for the FAILED_TX memo. 32 bytes is:
 *    - large enough that the memo program actually runs the UTF-8 check
 *      (it short-circuits on empty)
 *    - small enough that a single-signer tx stays well under MAX_TX_BYTES
 *    - round-number for readability in tx dumps
 *  Kept module-private — callers depend on the strategy, not this knob. */
const INVALID_UTF8_MEMO_SIZE = 32;

/** Build the invalid-UTF-8 byte pattern. 0xFF is not a valid UTF-8 lead
 *  byte under RFC 3629, so any sequence of 0xFF bytes fails validation
 *  on the first byte regardless of length. Deterministic — no randomness. */
function invalidUtf8Payload(size: number): Buffer {
  return Buffer.alloc(size, 0xff);
}

/** FAILED_TX — fleet agent emits a memo instruction with non-UTF-8 data.
 *  Memo v2 returns InvalidInstructionData, the tx lands as a confirmed
 *  failure, and the AgentError verifier's `failed_tx` branch picks it up. */
export const failedTxStrategy: FailureStrategy = {
  kind: 'failed_tx',
  label: 'memo invalid UTF-8',
  expectedError: { class: 'InstructionError', variant: 'InvalidInstructionData' },
  buildInstruction(agent) {
    return new TransactionInstruction({
      programId: new PublicKey(SPL_MEMO_PROGRAM_ID),
      // Attach the agent as a signer key so Helius-style indexers can
      // attribute the failure back to it. The memo program ignores the
      // accounts array, so this is informational only.
      keys: [{ pubkey: agent, isSigner: true, isWritable: false }],
      data: invalidUtf8Payload(INVALID_UTF8_MEMO_SIZE),
    });
  },
};

/** Registry of strategies keyed by FailureKind. When new strategies land
 *  (CRITICAL_TRANSFER, RAPID_LOSS, …) add them here and expose them via
 *  the BehaviorProfile's `rogueMix`. */
export const failureStrategies: Record<FailureKind, FailureStrategy> = {
  failed_tx: failedTxStrategy,
};

/** Convenience entry point used by `executeFail`. Keeps strategy selection
 *  in one place so the runner doesn't have to know the registry shape. */
export function buildFailingInstruction(
  agent: PublicKey,
  kind: FailureKind = 'failed_tx',
): TransactionInstruction {
  const strategy = failureStrategies[kind];
  if (!strategy) throw new Error(`Unknown failure kind: ${kind}`);
  return strategy.buildInstruction(agent);
}

/**
 * Serialize a pre-built transaction once to verify it fits under
 * `MAX_TX_BYTES`. Useful for tests and as a defensive assertion when
 * future strategies add larger payloads. Returns the serialized size.
 *
 * NOTE: requires the transaction to have a recent blockhash and fee
 * payer set; callers in production use `sendRawTransaction` which does
 * its own serialization, so this helper is primarily for tests.
 */
export function assertUnderTxSizeLimit(tx: Transaction): number {
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  if (bytes > MAX_TX_BYTES) {
    throw new Error(
      `Serialized tx size ${bytes} exceeds Solana PACKET_DATA_SIZE (${MAX_TX_BYTES})`,
    );
  }
  return bytes;
}
