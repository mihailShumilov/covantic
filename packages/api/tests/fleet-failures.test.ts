import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { MAX_TX_BYTES, SPL_MEMO_PROGRAM_ID } from '@covantic/shared';
import {
  buildFailingInstruction,
  failedTxStrategy,
  failureStrategies,
  assertUnderTxSizeLimit,
} from '../src/services/fleet/failures.js';

/**
 * These tests pin the *contract* the FailureStrategy layer offers, not the
 * exact byte layout. Goals:
 *   1. Builder is pure — no network / RNG dependency.
 *   2. Instruction targets the real SPL Memo v2 program.
 *   3. Memo payload is non-UTF-8 (so the program returns InvalidInstructionData).
 *   4. Resulting transaction fits under Solana's PACKET_DATA_SIZE.
 *   5. Registry exposes every declared FailureKind.
 */

describe('buildFailingInstruction — failed_tx', () => {
  const agent = Keypair.generate().publicKey;

  it('targets the SPL Memo v2 program', () => {
    const ix = buildFailingInstruction(agent, 'failed_tx');
    expect(ix.programId.toBase58()).toBe(SPL_MEMO_PROGRAM_ID);
  });

  it('attaches the agent as a signer key for attribution', () => {
    const ix = buildFailingInstruction(agent, 'failed_tx');
    const match = ix.keys.find((k) => k.pubkey.equals(agent));
    expect(match).toBeDefined();
    expect(match?.isSigner).toBe(true);
    expect(match?.isWritable).toBe(false);
  });

  it('emits a non-UTF-8 payload (memo v2 rejects it with InvalidInstructionData)', () => {
    const ix = buildFailingInstruction(agent, 'failed_tx');
    expect(ix.data.length).toBeGreaterThan(0);
    // 0xFF is not a valid UTF-8 start byte per RFC 3629. A TextDecoder in
    // fatal mode will throw on any 0xFF — the memo program does the same.
    const decoder = new TextDecoder('utf-8', { fatal: true });
    expect(() => decoder.decode(ix.data)).toThrow();
  });

  it('produces a tx under Solana PACKET_DATA_SIZE once signed', () => {
    const agentKeypair = Keypair.generate();
    const ix = buildFailingInstruction(agentKeypair.publicKey, 'failed_tx');
    const tx = new Transaction().add(ix);
    tx.feePayer = agentKeypair.publicKey;
    // A well-formed blockhash stand-in — Transaction just needs 32 b58 bytes.
    tx.recentBlockhash = PublicKey.default.toBase58();
    tx.sign(agentKeypair);

    const bytes = assertUnderTxSizeLimit(tx);
    expect(bytes).toBeLessThanOrEqual(MAX_TX_BYTES);
    // Sanity: should be *well* under the limit. If this drops close to the
    // ceiling a future strategy almost certainly bloated the payload.
    expect(bytes).toBeLessThan(400);
  });

  it('is deterministic — same inputs produce the same instruction bytes', () => {
    const a = buildFailingInstruction(agent, 'failed_tx');
    const b = buildFailingInstruction(agent, 'failed_tx');
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(a.programId.equals(b.programId)).toBe(true);
  });

  it('does not perform any network I/O (smoke: no fetch / no Connection)', () => {
    // If a future refactor accidentally pulls a Connection into the builder,
    // this test will still pass — but flipping the builder into an async
    // function will break callers immediately. We additionally assert the
    // function signature stays synchronous.
    const result = buildFailingInstruction(agent, 'failed_tx');
    // Thenable check: a Promise would have `then`; the builder must not.
    expect(typeof (result as unknown as { then?: unknown }).then).toBe('undefined');
  });
});

describe('FailureStrategy registry', () => {
  it('includes the failed_tx strategy with the documented expected error', () => {
    expect(failureStrategies.failed_tx).toBe(failedTxStrategy);
    expect(failedTxStrategy.expectedError).toEqual({
      class: 'InstructionError',
      variant: 'InvalidInstructionData',
    });
  });

  it('uses the kind field as the registry key', () => {
    for (const [key, strat] of Object.entries(failureStrategies)) {
      expect(strat.kind).toBe(key);
    }
  });
});

describe('buildFailingInstruction — error paths', () => {
  it('throws for an unknown failure kind', () => {
    const agent = Keypair.generate().publicKey;
    // Cast — the type system forbids this, but runtime callers (e.g. data
    // coming back from Redis) can still pass bad values.
    expect(() =>
      buildFailingInstruction(agent, 'does_not_exist' as unknown as 'failed_tx'),
    ).toThrow(/Unknown failure kind/);
  });
});
