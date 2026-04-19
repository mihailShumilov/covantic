import { USDC_DECIMALS } from '@covantic/shared';
import {
  KNOWN_DEX_PROGRAMS,
  KNOWN_BRIDGE_PROGRAMS,
  FLASH_LOAN_PROGRAMS,
  type EnhancedTransaction,
} from '../../utils/helius.js';

/** Known on-chain governance program IDs. Kept narrow on purpose —
 *  extending the set trades off false-positive risk, so a new program
 *  only earns a place here after a verifier test case proves the detection
 *  holds. */
export const GOVERNANCE_PROGRAM_IDS = new Set([
  // SPL Governance (Realms)
  'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw',
  // Metadao
  'autoQP9RmUNkzzKRXsMkWicDVZ3h29vvyMDcAYjCxxg',
]);

/** Classification of the programs invoked in a transaction. Each flag is
 *  true if ANY instruction (top-level or inner) targeted a program in the
 *  corresponding set. `unknown` captures the leftovers so verifiers can
 *  decide how to weight an unclassified program. */
export interface ProgramClassification {
  dex: boolean;
  bridge: boolean;
  flashLoan: boolean;
  governance: boolean;
  unknown: string[];
}

/** Walk every instruction (including innerInstructions) and bucket each
 *  program id into one of the known categories. */
export function classifyPrograms(tx: EnhancedTransaction): ProgramClassification {
  const seen = new Set<string>();
  for (const ix of tx.instructions ?? []) {
    seen.add(ix.programId);
    for (const inner of ix.innerInstructions ?? []) seen.add(inner.programId);
  }

  const classification: ProgramClassification = {
    dex: false,
    bridge: false,
    flashLoan: false,
    governance: false,
    unknown: [],
  };
  for (const pid of seen) {
    if (KNOWN_DEX_PROGRAMS.has(pid)) {
      classification.dex = true;
    } else if (KNOWN_BRIDGE_PROGRAMS.has(pid)) {
      classification.bridge = true;
    } else if (FLASH_LOAN_PROGRAMS.has(pid)) {
      classification.flashLoan = true;
    } else if (GOVERNANCE_PROGRAM_IDS.has(pid)) {
      classification.governance = true;
    } else if (pid !== '11111111111111111111111111111111' /* system */) {
      classification.unknown.push(pid);
    }
  }
  return classification;
}

/** Total outgoing token transfers (UI units) from `agentAddress`, filtered
 *  by mint when provided. */
export function totalOutgoing(
  tx: EnhancedTransaction,
  agentAddress: string,
  mint?: string,
): number {
  return (tx.tokenTransfers ?? [])
    .filter((t) => t.fromUserAccount === agentAddress)
    .filter((t) => (mint ? t.mint === mint : true))
    .reduce((sum, t) => sum + (t.tokenAmount ?? 0), 0);
}

/** True when every outgoing transfer from the agent in this tx lands in
 *  an account the agent itself owns. Covers the self-ATA and
 *  mint-to-self false-positive patterns. */
export function isSelfTransfer(tx: EnhancedTransaction, agentAddress: string): boolean {
  const outgoing = (tx.tokenTransfers ?? []).filter(
    (t) => t.fromUserAccount === agentAddress,
  );
  if (outgoing.length === 0) return false;
  return outgoing.every((t) => t.toUserAccount === agentAddress);
}

/** Net USDC outflow from the agent in raw lamports (6 decimals) using the
 *  `accountData[].tokenBalanceChanges` pre/post data — cross-checks
 *  tokenTransfers with the authoritative balance diff. Negative if the
 *  agent received net USDC. */
export function netUsdcOutflowRaw(
  tx: EnhancedTransaction,
  agentAddress: string,
  usdcMint: string,
): number {
  let netRaw = 0;
  for (const ad of tx.accountData ?? []) {
    for (const change of ad.tokenBalanceChanges ?? []) {
      if (change.mint !== usdcMint) continue;
      if (change.userAccount !== agentAddress) continue;
      const raw = Number(change.rawTokenAmount.tokenAmount);
      if (!Number.isFinite(raw)) continue;
      // `rawTokenAmount.tokenAmount` is signed (positive = inflow to
      // the agent). Flip sign so positive netRaw = outflow.
      netRaw -= raw;
    }
  }
  return netRaw;
}

/** Convert UI units (human-readable USDC amount) to raw lamports. */
export function uiToRaw(ui: number): number {
  return Math.round(ui * 10 ** USDC_DECIMALS);
}

/** Clamp a loss amount to the policy coverage (raw lamports). A verifier
 *  that exceeds the coverage is always wrong — the chain would reject
 *  verify_and_payout — so we proactively cap and log. */
export function capToCoverage(lossRaw: number, coverageRaw: number): number {
  if (lossRaw <= 0) return 0;
  return Math.min(Math.floor(lossRaw), coverageRaw);
}
