import type { MandateView } from '../../src/services/agent-error/types.js';
import {
  AGENT,
  AGENT_USDC_ATA,
  ATTACKER,
  HOLDER,
  JUPITER,
  OTHER_ATA,
  SCAM_MINT,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  UNKNOWN_PROGRAM,
  USDC,
} from './exploit.js';
import { BLOCK_TIME, COVERAGE_RAW, type TxSpec } from './exploit-corpus.js';

/**
 * Labelled corpus for the agent-error pipeline.
 *
 * The negatives are the half that matters, and here they are also a record of
 * specific past behaviour. Every one of them is a shape the *previous*
 * verifier confirmed, or would have: it decided on which programs appeared in
 * a transaction, so it paid for bridge transfers to the holder's own address,
 * for ordinary deposits into unfamiliar protocols, and for every reverted
 * transaction on a flat invented 1 USDC — while rejecting a catastrophic
 * misrouted swap outright because Jupiter was involved.
 *
 * The gate is asymmetric for the same reason it is on the exploit corpus. A
 * false positive means the vault paid because an agent spent its own money the
 * way its owner told it to; once one of those ships the protocol is insuring
 * ordinary operations. So any confirmation on the negatives fails the build,
 * with no allowance, while recall on the positives is a tracked floor.
 *
 * What is here and what is not: these are breach and operation *shapes*, not
 * replays of real incidents. Replaying mainnet history needs archival RPC
 * access this environment does not have; those cases drop into this same
 * structure unchanged when it does.
 */

export { BLOCK_TIME, COVERAGE_RAW };

/** Base units. The declared cap is 1,000 USDC. */
export const DECLARED_CAP_RAW = 1_000 * 10 ** 6;
/** The agent must never take the covered account below 500 USDC. */
export const DECLARED_FLOOR_RAW = 500 * 10 ** 6;
export const DECLARED_WINDOW_CAP_RAW = 5_000 * 10 ** 6;
export const WINDOW_SECONDS = 3_600;

/** A mandate that matured an hour before the claim. The ordinary case. */
export const MATURE_MANDATE: MandateView = {
  maxSingleOutflowRaw: DECLARED_CAP_RAW,
  maxWindowOutflowRaw: DECLARED_WINDOW_CAP_RAW,
  windowSeconds: WINDOW_SECONDS,
  minRetainedBalanceRaw: DECLARED_FLOOR_RAW,
  allowedCounterparties: [OTHER_ATA, HOLDER],
  allowedPrograms: [JUPITER, TOKEN_PROGRAM, SYSTEM_PROGRAM],
  manifestHash: '00'.repeat(32),
  declaredAt: BLOCK_TIME - 7_200,
  effectiveAt: BLOCK_TIME - 3_600,
  maturedBeforeClaim: true,
};

/** Declared after the incident it is being used to justify. */
export const IMMATURE_MANDATE: MandateView = {
  ...MATURE_MANDATE,
  declaredAt: BLOCK_TIME + 60,
  effectiveAt: BLOCK_TIME + 3_660,
  maturedBeforeClaim: false,
};

/**
 * A mandate that names amounts but no allowlists.
 *
 * Silence, not prohibition — the breach evaluator must report those two
 * dimensions as unevaluated rather than treating every destination as
 * undeclared, which would make every transfer a covered event.
 */
export const AMOUNTS_ONLY_MANDATE: MandateView = {
  ...MATURE_MANDATE,
  allowedCounterparties: [],
  allowedPrograms: [],
};

export interface AgentErrorCase {
  name: string;
  /** `positive` = a breach the pipeline should confirm.
   *  `negative` = anything it must not confirm, whatever the reason. */
  label: 'positive' | 'negative';
  /** Why this case exists, for whoever reads a failure. */
  why: string;
  tx: TxSpec;
  /** `undefined` models an outage; `null` models a policy with no
   *  declaration. Both must resolve to review, never to a verdict. */
  mandate?: MandateView | null;
  /** Expected verdict reason, when the case is about a specific one. */
  expectReason?: string;
  /** Expected payable amount in base units, when the case pins the bound. */
  expectLossAmount?: number;
  /** The breach crosses only dimensions the chain cannot re-derive, so it must
   *  confirm off chain and then be refused the proven settlement path. */
  categoricalOnly?: boolean;
}

const bal = (account: string, owner: string, amount: number, mint = USDC) => ({
  account,
  mint,
  owner,
  amount,
  decimals: 6,
});

/** The agent held 10,000 USDC going in, unless a case says otherwise. */
const OPENING_BALANCE = 10_000 * 10 ** 6;

/**
 * An ordinary agent-signed transfer of `amount` to `destination`.
 *
 * The agent signs — which is what makes every one of these an agent-error
 * candidate rather than an exploit — and the balances are absolute, so the
 * retention floor has something to compare against.
 */
function agentTransfer(opts: {
  amount: number;
  destination?: string;
  destinationOwner?: string;
  opening?: number;
  programs?: string[];
  err?: unknown;
}): TxSpec {
  const opening = opts.opening ?? OPENING_BALANCE;
  const destination = opts.destination ?? OTHER_ATA;
  const destinationOwner = opts.destinationOwner ?? ATTACKER;
  return {
    signers: [AGENT],
    otherKeys: [AGENT_USDC_ATA, destination],
    err: opts.err,
    pre: [bal(AGENT_USDC_ATA, AGENT, opening), bal(destination, destinationOwner, 0)],
    post: [
      bal(AGENT_USDC_ATA, AGENT, Math.max(0, opening - opts.amount)),
      bal(destination, destinationOwner, opts.amount),
    ],
    instructions: [
      {
        programId: TOKEN_PROGRAM,
        type: 'transfer',
        info: {
          source: AGENT_USDC_ATA,
          destination,
          authority: AGENT,
          amount: String(opts.amount),
        },
      },
      ...(opts.programs ?? []).map((programId) => ({ programId, accounts: [] })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Negatives — none of these may ever confirm
// ---------------------------------------------------------------------------

export const NEGATIVES: AgentErrorCase[] = [
  {
    name: 'large swap through an allowed venue, inside the cap',
    label: 'negative',
    why: 'The holder declared Jupiter and this size as permitted. Losing money inside your own declared risk appetite is not a covered event.',
    tx: agentTransfer({ amount: 900 * 10 ** 6, programs: [JUPITER] }),
    expectReason: 'within_mandate',
  },
  {
    name: 'bridge transfer to a declared counterparty',
    label: 'negative',
    why: 'The old verifier confirmed any bridge outflow at 0.5 confidence, which paid out for moving your own money to another chain.',
    tx: agentTransfer({ amount: 800 * 10 ** 6, destination: OTHER_ATA }),
    expectReason: 'within_mandate',
  },
  {
    name: 'deposit through an unrecognised program the holder never restricted',
    label: 'negative',
    why: 'The single worst false positive in the retired verifier: any outflow through any program outside a ten-entry DEX list confirmed at 0.6. On devnet that is almost every program there is. An empty allowlist is silence, not prohibition.',
    tx: agentTransfer({ amount: 950 * 10 ** 6, programs: [UNKNOWN_PROGRAM] }),
    mandate: AMOUNTS_ONLY_MANDATE,
    expectReason: 'within_mandate',
  },
  {
    name: 'reverted transaction, fee-only',
    label: 'negative',
    why: 'The old verifier approved a flat, invented 1 USDC for every reverted transaction. Nobody lost 1 USDC; they lost a few thousand lamports of fees.',
    tx: agentTransfer({
      amount: 5_000 * 10 ** 6,
      err: { InstructionError: [0, 'InvalidInstructionData'] },
    }),
    expectReason: 'transaction_reverted_no_loss',
  },
  {
    name: 'treasury sweep back to the holder',
    label: 'negative',
    why: 'Money that came home was never lost, whatever its size or route.',
    tx: agentTransfer({
      amount: 9_000 * 10 ** 6,
      destination: OTHER_ATA,
      destinationOwner: HOLDER,
    }),
    expectReason: 'self_transfer',
  },
  {
    name: 'drain by a foreign transfer authority',
    label: 'negative',
    why: 'The agent did not authorise this. It is an exploit, and routing it here would hand it to a verifier that measures movements against a spending envelope.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA, OTHER_ATA],
      pre: [bal(AGENT_USDC_ATA, AGENT, OPENING_BALANCE), bal(OTHER_ATA, ATTACKER, 0)],
      post: [bal(AGENT_USDC_ATA, AGENT, 0), bal(OTHER_ATA, ATTACKER, OPENING_BALANCE)],
      instructions: [
        {
          programId: TOKEN_PROGRAM,
          type: 'transfer',
          info: {
            source: AGENT_USDC_ATA,
            destination: OTHER_ATA,
            authority: ATTACKER,
            amount: String(OPENING_BALANCE),
          },
        },
      ],
    },
    expectReason: 'not_agent_authorized',
  },
  {
    name: 'over-cap movement that returned in the same transaction',
    label: 'negative',
    why: 'The cap was crossed but nothing was lost. A breach with no net loss is not a claim.',
    tx: {
      signers: [AGENT],
      otherKeys: [AGENT_USDC_ATA, OTHER_ATA],
      pre: [bal(AGENT_USDC_ATA, AGENT, OPENING_BALANCE), bal(OTHER_ATA, ATTACKER, 0)],
      post: [bal(AGENT_USDC_ATA, AGENT, OPENING_BALANCE), bal(OTHER_ATA, ATTACKER, 0)],
      instructions: [
        {
          programId: TOKEN_PROGRAM,
          type: 'transfer',
          info: {
            source: AGENT_USDC_ATA,
            destination: OTHER_ATA,
            authority: AGENT,
            amount: String(5_000 * 10 ** 6),
          },
        },
      ],
    },
    expectReason: 'no_net_loss',
  },
  {
    name: 'no mandate declared',
    label: 'negative',
    why: 'The absence of a declaration is a gap in our records, not the holder’s permission. It goes to a human, never to a rejection and never to a payout.',
    tx: agentTransfer({ amount: 8_000 * 10 ** 6 }),
    mandate: null,
    expectReason: 'no_mandate_declared',
  },
  {
    name: 'mandate declared after the incident',
    label: 'negative',
    why: 'Without the maturity rule a holder could watch an ordinary loss happen and then declare an envelope narrow enough to have been breached by it.',
    tx: agentTransfer({ amount: 8_000 * 10 ** 6 }),
    mandate: IMMATURE_MANDATE,
    expectReason: 'mandate_not_matured',
  },
  {
    name: 'mandate unreadable',
    label: 'negative',
    why: 'An outage is not an absence. A claim must not be decided while the declaration it turns on could not be read.',
    tx: agentTransfer({ amount: 8_000 * 10 ** 6 }),
    mandate: undefined,
    expectReason: 'mandate_lookup_unavailable',
  },
  {
    name: 'swap into an unregistered mint, inside the cap',
    label: 'negative',
    why: 'Treating an unpriceable asset received as worthless is how "agent bought a scam token" becomes a full-coverage payout on a trade the agent chose to make.',
    tx: {
      signers: [AGENT],
      otherKeys: [AGENT_USDC_ATA, OTHER_ATA],
      pre: [
        bal(AGENT_USDC_ATA, AGENT, OPENING_BALANCE),
        bal(OTHER_ATA, AGENT, 0, SCAM_MINT),
      ],
      post: [
        bal(AGENT_USDC_ATA, AGENT, OPENING_BALANCE - 900 * 10 ** 6),
        bal(OTHER_ATA, AGENT, 1_000_000_000, SCAM_MINT),
      ],
      instructions: [
        {
          programId: TOKEN_PROGRAM,
          type: 'transfer',
          info: {
            source: AGENT_USDC_ATA,
            destination: OTHER_ATA,
            authority: AGENT,
            amount: String(900 * 10 ** 6),
          },
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Positives — breaches the pipeline should confirm
// ---------------------------------------------------------------------------

export const POSITIVES: AgentErrorCase[] = [
  {
    name: 'fat-finger: 10x the declared single-transfer cap',
    label: 'positive',
    why: 'The canonical agent error. The holder said 1,000 at a time; the agent sent 10,000 in one go.',
    tx: agentTransfer({ amount: 10_000 * 10 ** 6 }),
    // Bounded by the overshoot, not the loss: the first 1,000 is risk the
    // holder declared they were willing to run.
    expectLossAmount: 10_000 * 10 ** 6 - DECLARED_CAP_RAW,
    expectReason: 'mandate_breach',
  },
  {
    name: 'drain below the declared retention floor',
    label: 'positive',
    why: 'The holder said the agent must always keep 500 USDC on hand. It kept 100.',
    tx: agentTransfer({ amount: 900 * 10 ** 6, opening: 1_000 * 10 ** 6 }),
    expectReason: 'mandate_breach',
  },
  {
    name: 'over-cap movement to an undeclared counterparty',
    label: 'positive',
    why: 'Two dimensions breached at once — the size the chain can check, and the destination it cannot.',
    tx: agentTransfer({ amount: 4_000 * 10 ** 6, destination: OTHER_ATA }),
    expectReason: 'mandate_breach',
  },
  {
    name: 'over-cap movement routed through an undeclared program',
    label: 'positive',
    why: 'The holder named the venues their agent may trade through; this was not one of them.',
    tx: agentTransfer({ amount: 3_000 * 10 ** 6, programs: [UNKNOWN_PROGRAM] }),
    expectReason: 'mandate_breach',
  },
  {
    name: 'in-cap movement through a program the holder did not declare',
    label: 'positive',
    why: 'The right size, the wrong venue. A real breach — but a categorical one, with no overshoot for the program to measure, so it must confirm off chain and then refuse the proven path.',
    tx: agentTransfer({ amount: 950 * 10 ** 6, programs: [UNKNOWN_PROGRAM] }),
    expectReason: 'mandate_breach',
    categoricalOnly: true,
  },
  {
    name: 'over-cap movement under a mandate that declares amounts only',
    label: 'positive',
    why: 'An empty allowlist is silence, not prohibition — but the amounts still bind, and this one broke them.',
    tx: agentTransfer({ amount: 6_000 * 10 ** 6 }),
    mandate: AMOUNTS_ONLY_MANDATE,
    expectReason: 'mandate_breach',
  },
];

export const ALL_CASES = [...NEGATIVES, ...POSITIVES];
