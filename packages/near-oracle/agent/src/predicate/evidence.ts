import { registerCoveredMint } from '@covantic/shared';
import {
  classifyPrograms,
  collectSignatures,
  DEFAULT_MAX_SKEW_SEC,
  isSourceUnavailable,
  pickSubjectLeg,
  reconstructExecution,
  valueLegs,
  type EvidenceBundle,
  type PriceOracle,
} from './baseline.js';
import { toEnhancedTransaction, type ParsedTx, type SolanaRpc } from '../solana/rpc.js';

export const BUNDLE_VERSION = '1.4.0+near.1';
const TRIGGER_ORACLE_MANIPULATION = 2;

export interface EvidenceDeps {
  rpc: SolanaRpc;
  oracle: PriceOracle;
  coveredMint: string;
  stagedVenues: ReadonlySet<string>;
}

export type EvidenceResult =
  | { ok: true; bundle: EvidenceBundle }
  | { ok: false; reason: string; retryable: boolean; details?: Record<string, unknown> };

function touchesStagedVenue(tx: ParsedTx, venues: ReadonlySet<string>): boolean {
  return tx.transaction.message.accountKeys.some((key) => venues.has(key.pubkey));
}

/**
 * Gathers everything the verdict may look at. All network I/O happens here;
 * `evaluate` reads the result and nothing else.
 *
 * This mirrors the baseline verifier's steps with two differences. Transactions
 * come from RPC rather than an indexer. And a transaction may go through a
 * configured staged venue instead of a known DEX, because no funded devnet pool
 * exists to manipulate. A staged run is marked in the bundle, so its hash
 * commits to that fact. Production configuration leaves `stagedVenues` empty.
 */
export async function collectEvidence(
  signature: string,
  agentAddress: string,
  coverageRaw: number,
  deps: EvidenceDeps,
): Promise<EvidenceResult> {
  registerCoveredMint(deps.coveredMint);

  const parsed = await deps.rpc.getParsedTransaction(signature);
  if (!parsed) return { ok: false, reason: 'trigger_tx_not_found', retryable: true };
  if (parsed.meta?.err) return { ok: false, reason: 'trigger_tx_failed', retryable: false };

  const tx = toEnhancedTransaction(parsed, signature);
  const programs = classifyPrograms(tx);
  const stagedVenue = touchesStagedVenue(parsed, deps.stagedVenues);
  if (!programs.dex && !stagedVenue) {
    return { ok: false, reason: 'no_dex_interaction', retryable: false };
  }

  const signers = parsed.transaction.message.accountKeys.filter((key) => key.signer);
  if (!signers.some((key) => key.pubkey === agentAddress)) {
    return { ok: false, reason: 'agent_did_not_sign_trigger_tx', retryable: false };
  }

  const execution = reconstructExecution(tx, agentAddress);
  if (execution.shape === 'no_position_change') {
    return { ok: false, reason: 'no_position_change', retryable: false };
  }
  if (execution.shape === 'no_swap') {
    return { ok: false, reason: 'incomplete_swap', retryable: false };
  }
  if (execution.shape === 'unsupported_shape') {
    return { ok: false, reason: 'unsupported_swap_shape', retryable: true };
  }
  if (parsed.blockTime === null) return { ok: false, reason: 'no_block_time', retryable: true };

  const bundle: EvidenceBundle & { stagedVenue: boolean } = {
    version: BUNDLE_VERSION,
    stage: 'verify',
    triggerType: TRIGGER_ORACLE_MANIPULATION,
    txSignature: signature,
    agentAddress,
    coverageRaw,
    slot: parsed.slot,
    blockTime: parsed.blockTime,
    prices: [],
    windows: {},
    execution,
    stagedVenue,
    collectedAt: Date.now(),
  };

  const context = {
    oracle: deps.oracle,
    blockTime: parsed.blockTime,
    maxSkewSec: DEFAULT_MAX_SKEW_SEC,
    windows: bundle.windows,
    prices: bundle.prices,
  };

  let sold;
  let bought;
  try {
    sold = await valueLegs(execution.sold, context);
    bought = await valueLegs(execution.bought, context);
  } catch (error) {
    if (isSourceUnavailable(error)) {
      return { ok: false, reason: 'price_source_unavailable', retryable: true };
    }
    throw error;
  }
  bundle.prices.sort((a, b) => a.publishTime - b.publishTime);

  if (!sold.ok) return { ok: false, reason: sold.failure.kind, retryable: true, details: sold.failure };
  if (!bought.ok) {
    return { ok: false, reason: bought.failure.kind, retryable: true, details: bought.failure };
  }
  bundle.valuation = { sold: sold.legs, bought: bought.legs };

  const subject = pickSubjectLeg(sold.legs, bought.legs);
  const soldUsd = sold.legs.reduce((total, leg) => total + leg.valueUsd, 0);
  const boughtUsd = bought.legs.reduce((total, leg) => total + leg.valueUsd, 0);
  if (subject && soldUsd > 0) {
    const otherSideUsd = subject.side === 'bought' ? soldUsd : boughtUsd;
    bundle.signatures = await collectSignatures({
      tx,
      programs,
      blockTime: parsed.blockTime,
      slot: parsed.slot,
      oracle: deps.oracle,
      agentAddress,
      subjectFeedKey: subject.leg.feedKey as string,
      impliedPrice: otherSideUsd / subject.leg.amountUi,
      referencePrice: subject.leg.priceUsd,
      referenceDispersion: subject.leg.dispersion ?? 0,
      referenceConfFraction: subject.leg.confPerUnitUsd / subject.leg.priceUsd,
      reader: deps.rpc.asReader(),
    });
  }

  return { ok: true, bundle };
}
