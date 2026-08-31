import { describe, expect, it, vi } from 'vitest';
import { resolveDelegateProvenance } from '../src/services/exploit/delegate-provenance.js';
import { adjudicateExploit } from '../src/services/exploit/adjudicate.js';
import { analyseAuthorization } from '../src/services/exploit/authorization.js';
import { positionFromRawTx } from '../src/services/exploit/position.js';
import { toRawTxView } from '../src/services/exploit/raw-tx.js';
import type { SolanaReader } from '../src/utils/solana-reader.js';

/**
 * The self-dealing delegate drain.
 *
 * A holder signs `Approve` before buying a policy, then drains through that
 * delegate to a wallet they also control. Every fact the verifier reads is
 * true — an authority that is not the agent moved the agent's money — and the
 * chain settles it honestly, because the money really did leave. The consent
 * is real and sits one transaction earlier than the one being adjudicated.
 *
 * These tests are the finding made executable: the drain must not confirm, and
 * an unreadable approval history must not confirm either.
 */

const AGENT = 'AgentAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const HOLDER_SINK = 'SinkWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';
const DELEGATE = 'DelegateDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const AGENT_ATA = 'AgentAtaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SINK_ATA = 'SinkAtaWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DRAIN_SIG = 'DrainSignature11111111111111111111111111111111';
const APPROVE_SIG = 'ApproveSignature111111111111111111111111111111';

/** The drain: a delegate moves the agent's USDC to a wallet the holder owns. */
function drainTx() {
  return {
    slot: 200_000,
    blockTime: 1_700_000_000,
    transaction: {
      message: {
        accountKeys: [
          { pubkey: DELEGATE, signer: true, writable: true },
          { pubkey: AGENT_ATA, signer: false, writable: true },
          { pubkey: SINK_ATA, signer: false, writable: true },
        ],
        instructions: [
          {
            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            program: 'spl-token',
            parsed: {
              type: 'transferChecked',
              info: {
                source: AGENT_ATA,
                destination: SINK_ATA,
                authority: DELEGATE,
                mint: USDC,
                tokenAmount: { amount: '100000000000', decimals: 6 },
              },
            },
          },
        ],
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000, 2_039_280, 2_039_280],
      postBalances: [995_000, 2_039_280, 2_039_280],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC,
          owner: AGENT,
          uiTokenAmount: { amount: '100000000000', decimals: 6 },
        },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: AGENT, uiTokenAmount: { amount: '0', decimals: 6 } },
        {
          accountIndex: 2,
          mint: USDC,
          owner: HOLDER_SINK,
          uiTokenAmount: { amount: '100000000000', decimals: 6 },
        },
      ],
      innerInstructions: [],
      logMessages: [],
    },
  };
}

/** The `Approve` the agent signed weeks earlier. */
function approveTx(owner: string) {
  return {
    slot: 100_000,
    blockTime: 1_699_000_000,
    transaction: {
      message: {
        accountKeys: [{ pubkey: owner, signer: true, writable: true }],
        instructions: [
          {
            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            program: 'spl-token',
            parsed: {
              type: 'approve',
              info: { source: AGENT_ATA, delegate: DELEGATE, owner },
            },
          },
        ],
      },
    },
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [], innerInstructions: [] },
  };
}

function history(signatures: string[]) {
  return signatures.map((signature) => ({
    signature,
    slot: 100_000,
    blockTime: 1_699_000_000,
    err: null,
    memo: null,
    confirmationStatus: 'finalized',
  }));
}

function mkReader(over: Partial<SolanaReader>): SolanaReader {
  return over as unknown as SolanaReader;
}

const view = () => toRawTxView(drainTx() as never, DRAIN_SIG);
const position = () => positionFromRawTx(view(), AGENT);
const report = () =>
  analyseAuthorization({ view: view(), position: position(), agentAddress: AGENT });

describe('resolveDelegateProvenance', () => {
  it('finds the approval the agent signed, so the drain is the agent’s own arrangement', async () => {
    const reader = mkReader({
      getSignaturesForAddress: vi.fn(async () => history([APPROVE_SIG])),
      getParsedTransaction: vi.fn(async () => approveTx(AGENT) as never),
    });

    const provenance = await resolveDelegateProvenance(reader, view(), report(), AGENT);

    expect(provenance.allGrantedByAgent).toBe(true);
    expect(provenance.authorities[0]).toMatchObject({
      authority: DELEGATE,
      origin: 'granted_by_agent',
      grantedBy: APPROVE_SIG,
    });
  });

  it('does not credit an approval signed by someone who is not the agent', async () => {
    // After a `SetAuthority` the new owner can approve too. That is a seizure,
    // and the governance path's business — it must not read as consent here.
    const reader = mkReader({
      getSignaturesForAddress: vi.fn(async () => history([APPROVE_SIG])),
      getParsedTransaction: vi.fn(async () => approveTx(HOLDER_SINK) as never),
    });

    const provenance = await resolveDelegateProvenance(reader, view(), report(), AGENT);

    expect(provenance.allGrantedByAgent).toBe(false);
    expect(provenance.authorities[0]?.origin).toBe('not_granted');
  });

  it('reports unknown when the history cannot be read', async () => {
    const reader = mkReader({
      getSignaturesForAddress: vi.fn(async () => {
        throw new Error('getSignaturesForAddress: all RPC endpoints failed');
      }),
    });

    const provenance = await resolveDelegateProvenance(reader, view(), report(), AGENT);

    expect(provenance.allGrantedByAgent).toBeNull();
  });

  it('treats an empty history as unreadable, not as absence of approval', async () => {
    // The drain came out of this account, so it demonstrably has history. An
    // empty answer means the endpoint does not know it — which cannot
    // establish that no approval exists, and consent absent is what a payout
    // would rest on.
    const reader = mkReader({
      getSignaturesForAddress: vi.fn(async () => []),
      getParsedTransaction: vi.fn(async () => null),
    });

    const provenance = await resolveDelegateProvenance(reader, view(), report(), AGENT);

    expect(provenance.allGrantedByAgent).toBeNull();
  });
});

describe('the same-transaction variant', () => {
  it('reads an approval inside the incident transaction as the agent\u2019s consent', async () => {
    // Otherwise the whole check is a one-line bypass: put the approve and the
    // transfer in one transaction and the prior-history scan finds nothing.
    // The agent signed *this* transaction, so its consent is not in doubt.
    const atomic = drainTx();
    atomic.transaction.message.instructions.unshift({
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      program: 'spl-token',
      parsed: { type: 'approve', info: { source: AGENT_ATA, delegate: DELEGATE, owner: AGENT } },
    } as never);
    atomic.transaction.message.accountKeys.push({
      pubkey: AGENT,
      signer: true,
      writable: true,
    } as never);

    const v = toRawTxView(atomic as never, DRAIN_SIG);
    const rep = analyseAuthorization({ view: v, position: positionFromRawTx(v, AGENT), agentAddress: AGENT });
    // No history is consulted at all — the transaction answers it.
    const reader = mkReader({
      getSignaturesForAddress: vi.fn(async () => {
        throw new Error('history must not be needed');
      }),
    });

    const provenance = await resolveDelegateProvenance(reader, v, rep, AGENT);

    expect(provenance.allGrantedByAgent).toBe(true);
    expect(provenance.authorities[0]).toMatchObject({
      authority: DELEGATE,
      origin: 'granted_by_agent',
      grantedBy: DRAIN_SIG,
    });
  });
});

describe('adjudicateExploit — the delegate drain does not pay', () => {
  function bundleWith(provenance: unknown, signatureScore = 0.75) {
    const v = view();
    return {
      version: '1.0.0',
      stage: 'verify',
      triggerType: 1,
      txSignature: DRAIN_SIG,
      agentAddress: AGENT,
      coverageRaw: 100_000_000_000,
      slot: 200_000,
      blockTime: 1_700_000_000,
      hasRawTx: true,
      programs: {},
      prices: [],
      windows: {},
      collectedAt: Date.now(),
      authorization: analyseAuthorization({ view: v, position: positionFromRawTx(v, AGENT), agentAddress: AGENT }),
      position: positionFromRawTx(v, AGENT),
      loss: {
        netLossUsd: 100_000,
        cappedLossUsd: 100_000,
        drainRatio: 1,
        lost: [],
        gained: [],
        unpriced: [],
        parFallback: [],
      },
      signatures: {
        hasAuthorizationEvidence: true,
        score: signatureScore,
        present: ['unauthorized_movement'],
        unevaluated: [],
        findings: [],
      },
      delegateProvenance: provenance,
    } as never;
  }

  it('escalates an agent-granted delegate when the shape corroborates an attack', () => {
    // A holder self-dealing and a victim phished into approving are the same
    // transaction pair on chain. Neither is paid automatically; the one that
    // looks like an attack goes to a human rather than being denied outright.
    const verdict = adjudicateExploit(
      bundleWith({
        authorities: [{ authority: DELEGATE, origin: 'granted_by_agent', grantedBy: APPROVE_SIG }],
        allGrantedByAgent: true,
      }),
    );

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('delegated_but_anomalous');
  });

  it('rejects an agent-granted delegate when nothing structural contradicts consent', () => {
    const verdict = adjudicateExploit(
      bundleWith(
        {
          authorities: [
            { authority: DELEGATE, origin: 'granted_by_agent', grantedBy: APPROVE_SIG },
          ],
          allGrantedByAgent: true,
        },
        0.1,
      ),
    );

    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('agent_delegated_movement');
  });

  it('escalates rather than paying when the provenance could not be resolved', () => {
    const verdict = adjudicateExploit(
      bundleWith({
        authorities: [{ authority: DELEGATE, origin: 'unknown' }],
        allGrantedByAgent: null,
      }),
    );

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('delegate_provenance_unresolved');
  });

  it('still confirms a genuine foreign authority the agent never approved', () => {
    // The fix must not close the trigger it exists to serve.
    const verdict = adjudicateExploit(
      bundleWith({
        authorities: [{ authority: DELEGATE, origin: 'not_granted' }],
        allGrantedByAgent: false,
      }),
    );

    expect(verdict.outcome).toBe('confirmed');
    expect(verdict.reason).toBe('unauthorized_loss');
  });

  it('confirms on a bundle that predates the check rather than stalling every old claim', () => {
    const verdict = adjudicateExploit(bundleWith(undefined));

    expect(verdict.outcome).toBe('confirmed');
  });
});
