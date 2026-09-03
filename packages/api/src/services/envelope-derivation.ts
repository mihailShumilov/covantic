import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

/**
 * The operating envelope, derived from what the agent actually does.
 *
 * ## Why the holder no longer writes this
 *
 * The envelope used to be five fields on the purchase form, and that was the
 * whole extraction vector. A holder who picks the cap picks the breach: set it
 * just under what the agent routinely moves, wait one ordinary payment, and
 * the vault owes the overshoot on a loss nobody suffered. Pricing that away
 * meant charging what the holder could take at will, which made a policy cost
 * as much as it covered — a correct price for a product nobody would buy.
 *
 * Deriving it removes the choice rather than pricing it. The cap is a multiple
 * of what this agent's own history says a payment looks like, so the holder
 * cannot set it anywhere; and a breach means the agent moved several times its
 * ordinary amount, which is the anomaly the trigger claims to detect rather
 * than an arithmetic certainty the holder arranged.
 *
 * What it does *not* do is make the trigger unfakeable. A holder still
 * controls the agent, and can spend months looking ordinary before moving
 * everything at once. That residue is bounded at the payout, where an
 * agent-error settlement may not exceed the premium the policy was bought for.
 * Derivation is what lets the premium go back to being a premium.
 */
export interface DerivedEnvelope {
  maxSingleOutflowRaw: number;
  maxWindowOutflowRaw: number;
  windowSeconds: number;
  minRetainedBalanceRaw: number;
  allowedCounterparties: string[];
  allowedPrograms: string[];
}

export interface EnvelopeDerivationInput {
  /** What the agent holds in the covered mint, raw base units. */
  coveredBalanceRaw: number;
  /** The agent's own 95th-percentile movement, or null with no usable history. */
  p95OutflowRaw: number | null;
  transferCount: number;
}

/**
 * How far above ordinary the cap sits.
 *
 * Five, matching the point at which `envelope-pricing` stopped charging for
 * headroom: an agent that has to behave five times abnormally before the vault
 * owes anything is one whose breach is genuinely an anomaly. Lower, and
 * ordinary business trips the cover; higher, and nothing ever does.
 */
export const CAP_HEADROOM_MULTIPLE = 5;

/** The window the rolling cap is measured over. One hour, matching the mandate
 *  default the program has always used. */
export const DERIVED_WINDOW_SECONDS = 3600;

/** How many single payments the window permits before it is a breach. */
export const WINDOW_MULTIPLE = 3;

/** Below this the history describes an agent, not a habit, and a cap drawn
 *  from it would be an accident. Matches `MIN_OBSERVATIONS_TO_PRICE`. */
export const MIN_OBSERVATIONS_TO_DERIVE = 5;

export interface DerivationResult {
  envelope: DerivedEnvelope;
  /** `history` when the cap came from what the agent does, `balance` when
   *  there was not enough of it and the cap is the balance itself. */
  basis: 'history' | 'balance';
  /** The p95 the cap was drawn from, for display. Null on the balance basis. */
  ordinaryOutflowRaw: number | null;
}

export function deriveEnvelope(input: EnvelopeDerivationInput): DerivationResult {
  const hasHabit =
    input.p95OutflowRaw !== null &&
    input.p95OutflowRaw > 0 &&
    input.transferCount >= MIN_OBSERVATIONS_TO_DERIVE;

  // With no habit to measure, the cap is the balance.
  //
  // Not a guess dressed as a limit: an agent cannot move more than it holds,
  // so a cap at the balance is one nothing can cross, and the policy carries
  // no agent-error exposure at all until the agent has been observed. That is
  // the honest position for an agent nobody has watched yet — and it is why
  // buying cover the moment an agent is created gives cover that cannot pay on
  // this trigger. The other three triggers are unaffected; they do not read
  // the envelope.
  const capRaw = hasHabit
    ? Math.round((input.p95OutflowRaw as number) * CAP_HEADROOM_MULTIPLE)
    : input.coveredBalanceRaw;

  // The program rejects a zero cap — it would make every movement a breach —
  // so an empty, unobserved agent gets the smallest cap that is still a cap.
  const maxSingleOutflowRaw = Math.max(1, capRaw);

  return {
    envelope: {
      maxSingleOutflowRaw,
      maxWindowOutflowRaw: maxSingleOutflowRaw * WINDOW_MULTIPLE,
      windowSeconds: DERIVED_WINDOW_SECONDS,
      // Left at zero deliberately. A retention floor is a promise about how
      // much the agent keeps, and nothing observable says what that should be
      // — a derived one would be this module inventing a deductible. Zero is
      // read as undeclared, and an undeclared floor costs no confidence: the
      // breach report simply skips the dimension rather than reporting it
      // unevaluated.
      minRetainedBalanceRaw: 0,
      // Not derivable, and it costs 0.03 of confidence to say so. The events
      // table records amounts and block times, not destinations, so there is
      // nothing to draw a destination allowlist from. Guessing one would be
      // worse than the penalty: an allowlist that omits a real counterparty
      // turns ordinary business into a breach.
      allowedCounterparties: [],
      // Derivable, and not a guess. The covered asset is an SPL token, so
      // every movement of it goes through the token program by construction.
      allowedPrograms: [TOKEN_PROGRAM_ID.toBase58()],
    },
    basis: hasHabit ? 'history' : 'balance',
    ordinaryOutflowRaw: hasHabit ? input.p95OutflowRaw : null,
  };
}

/**
 * The most cover worth selling on this agent, raw base units.
 *
 * Two bounds, and the tighter one governs.
 *
 * The agent cannot lose more than it holds, so cover above its balance is
 * premium paid for a loss that cannot happen. This is the bound the buyer sees
 * and the one that belongs on the form.
 *
 * The vault cannot underwrite more than its stake supports. `create_policy`
 * refuses below half of coverage staked, and it refuses *at purchase* — a
 * signed transaction that fails with `SolvencyTooLow` and no explanation. The
 * quote knows the same numbers and can say so first.
 */
export function maxInsurableCoverageRaw(input: {
  coveredBalanceRaw: number;
  totalStakedRaw: number;
  totalCoverageRaw: number;
}): { maxCoverageRaw: number; bound: 'agent_balance' | 'vault_capacity' } {
  // Solvency is `staked / coverage`, and the floor is 50%, so the vault can
  // carry `2 * staked` of coverage in total.
  const vaultCapacityRaw = Math.max(0, input.totalStakedRaw * 2 - input.totalCoverageRaw);

  return input.coveredBalanceRaw <= vaultCapacityRaw
    ? { maxCoverageRaw: input.coveredBalanceRaw, bound: 'agent_balance' }
    : { maxCoverageRaw: vaultCapacityRaw, bound: 'vault_capacity' };
}
