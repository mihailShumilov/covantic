import { LOCK_PERIODS } from '@covantic/shared';
import type { EnhancedTransaction } from '../../utils/helius.js';
import type { VerificationResult } from '../claim-oracle.js';
import {
  capToCoverage,
  classifyPrograms,
  isSelfTransfer,
  netUsdcOutflowRaw,
  uiToRaw,
} from './common.js';

/** Outgoing USDC ≥1,000 is the same threshold the TransactionMonitor uses
 *  to raise a `large_transfer` anomaly. Keeping them in sync means the
 *  verifier never rejects on "threshold not met" for an event that the
 *  monitor already judged anomalous. */
const LARGE_USDC_UI = 1_000;

/** Minimum raw lamports of loss needed for a verified claim. Prevents
 *  approving a 50-cent slippage event. */
const MIN_LOSS_RAW = 100_000; // 0.1 USDC

/**
 * Verifier for TriggerType.AgentError — covers `large_transfer`,
 * `failed_tx`, and `critical_transfer` monitoring events. This is the
 * most common path on devnet where agents misbehave in isolation rather
 * than as part of a coordinated exploit.
 *
 * Decision tree:
 *   1. All outgoing token transfers land back in the agent's wallet →
 *      SELF-TRANSFER false positive. Reject (confidence 0).
 *   2. Tx carries a transactionError → FAILED_TX. Approve with fee-only
 *      loss (capped at coverage, small confidence).
 *   3. Large outgoing USDC → classify destination:
 *        a) Known DEX in instructions → legitimate trade. Reject.
 *        b) Known bridge → possible mistake; approve with 0.5 confidence.
 *        c) Flash-loan / unknown program → approve with 0.85 confidence.
 *   4. Nothing matches → reject with "no_detected_loss".
 *
 * Loss is computed from `accountData[].tokenBalanceChanges` (authoritative
 * pre/post diff) when USDC mint is provided; falls back to the
 * `tokenTransfers[]` sum otherwise.
 */
export function verifyAgentError(
  tx: EnhancedTransaction,
  agentAddress: string,
  coverageRaw: number,
  usdcMint?: string,
): VerificationResult {
  const lockPeriod = LOCK_PERIODS.AGENT_ERROR;
  const programs = classifyPrograms(tx);
  const feeRaw = Number(tx.fee ?? 0); // lamports (9 decimals), NOT USDC

  // 1. Self-transfer guard
  if (isSelfTransfer(tx, agentAddress)) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: {
        reason: 'self_transfer',
        note: 'All outgoing transfers landed back in the agent wallet.',
      },
      lockPeriod,
    };
  }

  // 2. Failed tx → approve fee loss (low magnitude)
  if (tx.transactionError) {
    // tx.fee is in SOL lamports (9 decimals). We can't cleanly convert to
    // USDC without a price read, so we approve a flat 1 USDC for a failed
    // agent call. Enough to cover typical devnet fees + slippage, trivial
    // against any real coverage. Confidence is modest because cause of
    // failure is ambiguous without instruction-level forensics.
    const flatLossRaw = uiToRaw(1);
    const lossAmount = capToCoverage(flatLossRaw, coverageRaw);
    return {
      verified: lossAmount >= MIN_LOSS_RAW,
      lossAmount,
      confidence: lossAmount > 0 ? 0.6 : 0,
      details: {
        reason: 'failed_tx',
        transactionError: tx.transactionError,
        feeLamports: feeRaw,
        programs,
      },
      lockPeriod,
    };
  }

  // 3. Large outgoing USDC classification
  const netOutflowRaw = usdcMint
    ? Math.max(0, netUsdcOutflowRaw(tx, agentAddress, usdcMint))
    : uiToRaw(
        (tx.tokenTransfers ?? [])
          .filter((t) => t.fromUserAccount === agentAddress)
          .reduce((sum, t) => sum + (t.tokenAmount ?? 0), 0),
      );
  const outflowUi = netOutflowRaw / 10 ** 6;

  if (outflowUi >= LARGE_USDC_UI) {
    if (programs.dex && !programs.bridge && !programs.flashLoan) {
      return {
        verified: false,
        lossAmount: 0,
        confidence: 0,
        details: {
          reason: 'dex_trade',
          note: 'Outflow routed through a known DEX — treated as legitimate trading activity.',
          outflowUi,
          programs,
        },
        lockPeriod,
      };
    }

    let confidence = 0.6;
    let reason = 'large_outflow_unknown_destination';
    if (programs.flashLoan) {
      confidence = 0.85;
      reason = 'large_outflow_flash_loan';
    } else if (programs.bridge) {
      confidence = 0.5;
      reason = 'large_outflow_bridge';
    }

    const lossAmount = capToCoverage(netOutflowRaw, coverageRaw);
    return {
      verified: lossAmount >= MIN_LOSS_RAW,
      lossAmount,
      confidence: lossAmount > 0 ? confidence : 0,
      details: {
        reason,
        outflowUi,
        outflowRaw: netOutflowRaw,
        programs,
      },
      lockPeriod,
    };
  }

  // 4. No anomaly detected (monitor fired but verifier disagrees — this
  //    is the key signal the stub was missing: a policy-eating event that
  //    doesn't actually produce loss).
  return {
    verified: false,
    lossAmount: 0,
    confidence: 0,
    details: {
      reason: 'no_detected_loss',
      outflowUi,
      programs,
      note: 'Tx succeeded and total USDC outflow was sub-threshold; nothing to pay out.',
    },
    lockPeriod,
  };
}
