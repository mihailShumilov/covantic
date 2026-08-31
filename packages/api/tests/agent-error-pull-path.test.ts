import { describe, expect, it } from 'vitest';
import type { RawTxView } from '../src/services/exploit/raw-tx.js';
import type { MandateView } from '../src/services/agent-error/types.js';
import { screenRawTxForMandateBreach } from '../src/services/agent-error/prefilter.js';

/**
 * INV-DETECT-01 — the agent-error screen runs without a third party.
 *
 * Detection for this trigger existed on the webhook path alone: nothing but
 * `POST /api/monitoring/webhook` ever reached `screenForMandateBreach`. So the
 * one trigger a policyholder can legitimately stage — because it is measured
 * against their own declaration — was the one that stopped being detected the
 * moment a vendor's delivery stopped.
 *
 * That is not hypothetical. The Helius key covering this deployment reached
 * `max usage reached`, and the production API logged **zero** webhook
 * deliveries over six hours while every health check stayed green. The sweep
 * could not cover for it, because the sweep listed transactions through the
 * same vendor and simply reported nothing to examine — indistinguishable from
 * agents that did nothing.
 *
 * For a protocol whose claim is that it operates without people, a detection
 * path with one vendor in it is the whole claim.
 */

const AGENT = 'BfeNqWJkLvb5DBntDaEdUHrFB2dNEi2PHFFdg6kj847c';
const SINK = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = '79yZ9PuqbzzdCp2TriBwL9oxPtdfkhuFAjkSR95oJt1B';
const AGENT_ATA = 'HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL';

/** A transfer of `movedRaw` out of the agent, leaving `afterRaw` behind. */
function transferOut(movedRaw: number, afterRaw: number, err: unknown = null): RawTxView {
  return {
    signature: 'sig',
    slot: 1,
    blockTime: 1_788_200_000,
    err,
    fee: 5000,
    accountKeys: [],
    instructions: [],
    preTokenBalances: [
      { account: AGENT_ATA, mint: MINT, owner: AGENT, amountRaw: afterRaw + movedRaw, decimals: 6 },
      { account: SINK, mint: MINT, owner: SINK, amountRaw: 0, decimals: 6 },
    ],
    postTokenBalances: [
      { account: AGENT_ATA, mint: MINT, owner: AGENT, amountRaw: afterRaw, decimals: 6 },
      { account: SINK, mint: MINT, owner: SINK, amountRaw: movedRaw, decimals: 6 },
    ],
    preBalances: [],
    postBalances: [],
  };
}

const mandate = (over: Partial<MandateView> = {}): MandateView => ({
  maxSingleOutflowRaw: 100_000_000, // 100 USDC
  maxWindowOutflowRaw: 100_000_000,
  windowSeconds: 3600,
  minRetainedBalanceRaw: 0,
  allowedCounterparties: [],
  allowedPrograms: [],
  manifestHash: 'hash',
  declaredAt: 1_788_100_000,
  effectiveAt: 1_788_103_600,
  maturedBeforeClaim: true,
  ...over,
});

describe('INV-DETECT-01 — a mandate breach is visible from the chain alone', () => {
  it('flags a movement past the declared single-outflow cap', () => {
    const screen = screenRawTxForMandateBreach(transferOut(600_000_000, 4_400_000_000), AGENT, {
      mandate: mandate(),
      coveredMint: MINT,
    });

    expect(screen.flagged).toBe(true);
    expect(screen.reason).toBe('mandate_envelope_exceeded');
    expect(screen.detail?.dimensions).toContain('single_outflow');
  });

  it('reads the retained balance, which the enhanced shape cannot supply', () => {
    // `outflowsByMint` reports `retainedRaw: null` whenever it falls back to
    // `tokenTransfers`, so the retention floor goes unevaluated on that path.
    // The chain's own record always carries both sides.
    const screen = screenRawTxForMandateBreach(transferOut(50_000_000, 10_000_000), AGENT, {
      mandate: mandate({ minRetainedBalanceRaw: 500_000_000 }),
      coveredMint: MINT,
    });

    expect(screen.reason).toBe('mandate_envelope_exceeded');
    expect(screen.detail?.dimensions).toContain('retained_balance');
  });

  it('does not call a movement inside the envelope a breach', () => {
    // The whole point of a declared cap: the first slice is risk the holder
    // said they would run. The screen may still note the size — that is what
    // `large_valued_outflow` is for, and it maps to `LargeTransfer`, which
    // opens no claim — but the envelope must not read as exceeded.
    const screen = screenRawTxForMandateBreach(transferOut(50_000_000, 4_950_000_000), AGENT, {
      mandate: mandate(),
      coveredMint: MINT,
    });

    expect(screen.reason).not.toBe('mandate_envelope_exceeded');
  });

  it('separates the two so only one of them can open a claim', () => {
    // The distinction the watcher routes on, stated once: a breach names a
    // covered event, a large outflow names a size. Collapsing them is how
    // `large_transfer` used to fill a policy's single open-claim slot with a
    // claim that resolved to review and blocked every genuine alert.
    const inside = screenRawTxForMandateBreach(transferOut(50_000_000, 4_950_000_000), AGENT, {
      mandate: mandate(),
      coveredMint: MINT,
    });
    const outside = screenRawTxForMandateBreach(transferOut(600_000_000, 4_400_000_000), AGENT, {
      mandate: mandate(),
      coveredMint: MINT,
    });

    // Only the breach names a covered event. Everything else the screen can
    // say about the same movement — its size, or that the mint is not in the
    // registry and so fails open — routes to `LargeTransfer`.
    const opensClaim = (reason: string | undefined) => reason === 'mandate_envelope_exceeded';

    expect(opensClaim(inside.reason)).toBe(false);
    expect(inside.reason).toBeDefined();
    expect(opensClaim(outside.reason)).toBe(true);
  });

  it('does not call a large movement a breach when nothing was declared', () => {
    // Without a declaration there is no envelope to exceed. The screen may
    // still flag on size — `large_valued_outflow` — but that reason must not
    // reach `AgentError`, or it fills the policy's single open-claim slot with
    // a claim that resolves to review and blocks every genuine alert.
    const screen = screenRawTxForMandateBreach(transferOut(600_000_000, 4_400_000_000), AGENT, {
      coveredMint: MINT,
    });

    expect(screen.reason).not.toBe('mandate_envelope_exceeded');
  });

  it('treats a reverted transaction as having moved nothing', () => {
    // Fee burn is an operational signal, not a covered event.
    const screen = screenRawTxForMandateBreach(
      transferOut(600_000_000, 4_400_000_000, { InstructionError: [0, 'Custom'] }),
      AGENT,
      { mandate: mandate(), coveredMint: MINT },
    );

    expect(screen.flagged).toBe(false);
  });

  it('ignores a mint the policy does not cover', () => {
    const screen = screenRawTxForMandateBreach(transferOut(600_000_000, 4_400_000_000), AGENT, {
      mandate: mandate(),
      coveredMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });

    expect(screen.reason).not.toBe('mandate_envelope_exceeded');
  });
});
