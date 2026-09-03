import { calculatePremium, type RiskTier } from '@covantic/shared';
import { deriveEnvelope, maxInsurableCoverageRaw, type DerivedEnvelope } from './envelope-derivation.js';

/**
 * What a quote comes to, given everything already read.
 *
 * Pure, and on the same contract as the four adjudicators: no I/O, no clock,
 * no randomness. The route reads a balance, a habit and a vault snapshot, then
 * hands them here — so the decisions that used to live inside a request
 * handler, where nothing could reach them, can be tested directly.
 *
 * Two of those decisions had already been made once and were only visible as
 * arguments to other functions: that the envelope charge is zero, and that
 * coverage above what the agent holds is refused rather than sold.
 */
export type QuoteDecision =
  | {
      kind: 'refused';
      code: 'COVERAGE_ABOVE_MAX';
      maxCoverageRaw: number;
      bound: 'agent_balance' | 'vault_capacity';
    }
  | {
      kind: 'priced';
      premiumRaw: number;
      /** Always zero. Named rather than implied — see the note below. */
      envelopeFlatPremiumRaw: number;
      mandate: DerivedEnvelope;
      envelopeBasis: 'history' | 'balance';
      ordinaryOutflowRaw: number | null;
      maxCoverageRaw: number;
      maxCoverageBound: 'agent_balance' | 'vault_capacity';
    };

export interface QuoteDecisionInput {
  coverageAmountRaw: number;
  durationSeconds: number;
  tier: RiskTier;
  coveredBalanceRaw: number;
  p95OutflowRaw: number | null;
  transferCount: number;
  totalStakedRaw: number;
  totalCoverageRaw: number;
}

export function decideQuote(input: QuoteDecisionInput): QuoteDecision | null {
  const { maxCoverageRaw, bound } = maxInsurableCoverageRaw({
    coveredBalanceRaw: input.coveredBalanceRaw,
    totalStakedRaw: input.totalStakedRaw,
    totalCoverageRaw: input.totalCoverageRaw,
  });

  // Refused here, where the buyer can still change the number.
  //
  // Cover above what the agent holds is premium paid for a loss that cannot
  // happen; cover above what the vault's stake supports is a signed
  // transaction that fails with `SolvencyTooLow` and no explanation.
  if (input.coverageAmountRaw > maxCoverageRaw) {
    return { kind: 'refused', code: 'COVERAGE_ABOVE_MAX', maxCoverageRaw, bound };
  }

  const derivation = deriveEnvelope({
    coveredBalanceRaw: input.coveredBalanceRaw,
    p95OutflowRaw: input.p95OutflowRaw,
    transferCount: input.transferCount,
  });

  // The tier, and nothing else.
  //
  // The envelope used to carry a flat charge equal to what the holder could
  // move past their own declared cap. That was the only honest price while the
  // holder chose the cap — an envelope drawn tight around the balance is a
  // scheduled claim — and it is what made a policy cost more than the cover it
  // bought. The holder no longer chooses it, and an agent-error payout cannot
  // exceed the premium, so charging for extraction capacity a second time
  // prices a product nobody would buy.
  const envelopeFlatPremiumRaw = 0;
  const premiumRaw = calculatePremium(
    input.coverageAmountRaw,
    input.durationSeconds,
    input.tier,
    10000,
    envelopeFlatPremiumRaw,
  );

  // EXTREME, which has no rate. The caller already rejects it; this is the
  // guard that keeps the type honest rather than a second opinion.
  if (premiumRaw == null) return null;

  return {
    kind: 'priced',
    premiumRaw,
    envelopeFlatPremiumRaw,
    mandate: derivation.envelope,
    envelopeBasis: derivation.basis,
    ordinaryOutflowRaw: derivation.ordinaryOutflowRaw,
    maxCoverageRaw,
    maxCoverageBound: bound,
  };
}
