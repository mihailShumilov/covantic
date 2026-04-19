import { LOCK_PERIODS } from '@covantic/shared';
import type { EnhancedTransaction } from '../../utils/helius.js';
import type { VerificationResult } from '../claim-oracle.js';
import { capToCoverage, classifyPrograms } from './common.js';

/** Default payout for a verified governance attack. Losses from a
 *  successful authority takeover are hard to quantify without
 *  protocol-specific accounting, so we pay a fixed fraction of coverage
 *  and leave a clear note for the adjuster. Set to 50% intentionally low
 *  — we'd rather under-pay automatically and let a manual reviewer top up
 *  than auto-approve full coverage on shaky evidence. */
const DEFAULT_GOVERNANCE_PAYOUT_RATIO = 0.5;

/**
 * Verifier for TriggerType.GovernanceAttack.
 *
 * Governance attacks on Solana don't have a single canonical signature —
 * they're a pattern of proposal/vote/execute across SPL Governance or a
 * protocol-specific DAO program. A full verifier would replay the tx
 * against on-chain account state to confirm an authority change, which
 * requires protocol-specific adapters.
 *
 * For now we apply a simple two-of-three evidence rule:
 *   (a) A known governance program was invoked.
 *   (b) The tx succeeded (no transactionError).
 *   (c) At least one account in `accountData` shows a native-balance
 *       delta larger than typical DAO voting (>0.01 SOL) OR a token
 *       balance swing, which is a weak proxy for "something moved".
 *
 * When (a) holds and either (b)+(c) are satisfied, we approve at 50%
 * coverage with low confidence. Pure governance interactions with no
 * balance swings stay unverified.
 */
export function verifyGovernanceAttack(
  tx: EnhancedTransaction,
  _agentAddress: string,
  coverageRaw: number,
): VerificationResult {
  const lockPeriod = LOCK_PERIODS.GOVERNANCE_ATTACK;
  const programs = classifyPrograms(tx);

  if (!programs.governance) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: {
        reason: 'no_governance_program',
        programs,
        note: 'No known governance program in the transaction.',
      },
      lockPeriod,
    };
  }

  if (tx.transactionError) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: {
        reason: 'tx_failed',
        transactionError: tx.transactionError,
      },
      lockPeriod,
    };
  }

  // Look for meaningful balance movement. 0.01 SOL = 10,000,000 lamports.
  const accounts = tx.accountData ?? [];
  let biggestSolDelta = 0;
  let hasTokenSwing = false;
  for (const ad of accounts) {
    biggestSolDelta = Math.max(biggestSolDelta, Math.abs(ad.nativeBalanceChange ?? 0));
    if ((ad.tokenBalanceChanges ?? []).length > 0) hasTokenSwing = true;
  }

  if (biggestSolDelta < 10_000_000 && !hasTokenSwing) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: {
        reason: 'governance_call_no_state_change',
        biggestSolDelta,
        note: 'Governance program invoked but no balance movement observed.',
      },
      lockPeriod,
    };
  }

  const payoutRaw = Math.floor(coverageRaw * DEFAULT_GOVERNANCE_PAYOUT_RATIO);
  const lossAmount = capToCoverage(payoutRaw, coverageRaw);
  return {
    verified: lossAmount > 0,
    lossAmount,
    confidence: lossAmount > 0 ? 0.55 : 0,
    details: {
      reason: 'governance_state_change_detected',
      biggestSolDelta,
      hasTokenSwing,
      programs,
      note: 'Approved at 50% coverage — protocol-specific adjuster review recommended.',
      payoutRatio: DEFAULT_GOVERNANCE_PAYOUT_RATIO,
    },
    lockPeriod,
  };
}
