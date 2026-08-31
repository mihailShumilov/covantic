import { describe, expect, it } from 'vitest';
import { enhancedFromRawTx, type RawTxView } from '../src/services/exploit/raw-tx.js';
import { positionFromEnhanced, positionFromRawTx } from '../src/services/exploit/position.js';

/**
 * INV-VERIFY-01 — a verdict does not need the indexer.
 *
 * `verifyClaim` gated every trigger on `helius.getParsedTransaction`, so a
 * quota failure at that one call meant **no claim of any type could be
 * verified**: each resolved `trigger_tx_not_found` → `indeterminate` → review,
 * with a recorded note reading "indexer lag or wrong cluster". Both of those
 * are transient and neither was true, so the stored evidence actively
 * misdescribed why settlement had stopped.
 *
 * What the enhanced payload adds over the chain's own record is `type` and
 * `source` — the indexer's guess at what a transaction *was*. Nothing reads
 * them, and that is deliberate: "program membership decides nothing" is an
 * invariant this codebase arrived at because the retired verifiers used
 * exactly those fields and were a false-positive engine.
 *
 * So the test worth writing is not "the fallback produces something". It is
 * that the two shapes agree on the only thing a verdict rests on.
 */

const AGENT = 'BfeNqWJkLvb5DBntDaEdUHrFB2dNEi2PHFFdg6kj847c';
const SINK = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = '79yZ9PuqbzzdCp2TriBwL9oxPtdfkhuFAjkSR95oJt1B';
const AGENT_ATA = 'HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL';
const SINK_ATA = '3Bns9PSVvzik6X6ZZfSSjct7kZVpVEsRELbAJTFbCUAx';

function view(movedRaw: number, afterRaw: number): RawTxView {
  return {
    signature: '5EQQCAGq75W7xuAEmaf1GXrcm93xQEmvFLTRZjUwixyR',
    slot: 491_120_000,
    blockTime: 1_788_211_509,
    err: null,
    fee: 5000,
    accountKeys: [
      { pubkey: AGENT, signer: true, writable: true },
      { pubkey: SINK, signer: false, writable: true },
    ],
    instructions: [
      {
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        type: 'transferChecked',
        info: { source: AGENT_ATA, destination: SINK_ATA, authority: AGENT },
        accounts: [],
        inner: false,
        outerIndex: 0,
      },
    ],
    preTokenBalances: [
      { account: AGENT_ATA, mint: MINT, owner: AGENT, amountRaw: afterRaw + movedRaw, decimals: 6 },
      { account: SINK_ATA, mint: MINT, owner: SINK, amountRaw: 0, decimals: 6 },
    ],
    postTokenBalances: [
      { account: AGENT_ATA, mint: MINT, owner: AGENT, amountRaw: afterRaw, decimals: 6 },
      { account: SINK_ATA, mint: MINT, owner: SINK, amountRaw: movedRaw, decimals: 6 },
    ],
    preBalances: [100_000_000, 0],
    postBalances: [99_995_000, 0],
  };
}

describe('INV-VERIFY-01 — the chain carries everything a verdict needs', () => {
  it('agrees with the raw reading on what the agent lost', () => {
    // The load-bearing claim. If these diverged, switching the lookup would
    // change verdicts rather than merely change where the bytes came from.
    const raw = positionFromRawTx(view(600_000_000, 4_350_000_000), AGENT);
    const viaEnhanced = positionFromEnhanced(enhancedFromRawTx(view(600_000_000, 4_350_000_000)), AGENT);

    const lost = (p: typeof raw) =>
      p.legs.filter((l) => l.deltaRaw < 0).map((l) => [l.mint, l.deltaRaw]);

    expect(lost(viaEnhanced)).toEqual(lost(raw));
  });

  it('attributes a balance change to the account owner, not the token account', () => {
    // `positionFromEnhanced` matches on `userAccount`, which is the wallet.
    // Filling it with the token account address would make every movement
    // invisible — the position would come back empty and a real drain would
    // read as `no_net_loss`.
    const enhanced = enhancedFromRawTx(view(600_000_000, 4_350_000_000));
    const agentLeg = enhanced.accountData.find((a) => a.account === AGENT_ATA);

    expect(agentLeg?.tokenBalanceChanges[0]?.userAccount).toBe(AGENT);
    expect(agentLeg?.tokenBalanceChanges[0]?.rawTokenAmount.tokenAmount).toBe('-600000000');
  });

  it('carries the block time, which every retrospective price is anchored to', () => {
    // A missing timestamp must stop verification rather than silently become
    // "now" — comparing a historical fill against a live price measures market
    // drift, which was the single most severe bug in the original verifier.
    expect(enhancedFromRawTx(view(1, 1)).timestamp).toBe(1_788_211_509);
  });

  it('preserves a transaction error, so a revert is still a revert', () => {
    const failed = { ...view(600_000_000, 4_350_000_000), err: { InstructionError: [0, 'X'] } };

    expect(enhancedFromRawTx(failed).transactionError).not.toBeNull();
  });

  it('names its own origin rather than impersonating the indexer', () => {
    // `type`/`source` decide nothing, but a stored evidence bundle should say
    // where its bytes came from.
    expect(enhancedFromRawTx(view(1, 1)).source).toBe('RPC_PARSED');
  });
});
