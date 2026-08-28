import { vi } from 'vitest';
import type { Connection } from '@solana/web3.js';
import type { HeliusClient } from '../../src/utils/helius.js';
import type { BalanceReading } from '../../src/services/exploit/baseline.js';
import type { GovernanceBaselineView } from '../../src/services/governance/types.js';
import { BPF_LOADER_UPGRADEABLE } from '../../src/services/governance/authority.js';
import { BLOCK_TIME, mkParsedTx, type TokenBal, type TxSpec } from './exploit-corpus.js';
import { AGENT, AGENT_USDC_ATA, ATTACKER, HOLDER, TOKEN_PROGRAM, USDC } from './exploit.js';
import { SQUADS_V4 } from './governance.js';

/**
 * Labelled corpus for the governance pipeline.
 *
 * The negatives are the half that matters. A false positive here is the vault
 * paying out because a holder rotated a key, and once one of those ships the
 * protocol is insuring routine operations. So the gate is asymmetric: zero
 * confirmations on the negatives is a hard CI failure, while recall on the
 * positives is a tracked number with a floor.
 *
 * Every negative is a shape the *previous* verifier confirmed, or would have.
 * That is the point of the list — it is a record of the specific ways
 * "a governance program appeared and some balance moved" gets this wrong,
 * kept so the answers cannot quietly revert.
 *
 * What is here and what is not: these are takeover and operation *shapes*.
 * Real mainnet transactions are replayed in `tests/incident-backtest.test.ts`,
 * but a governance verdict needs a declared baseline and the sampled wallets
 * have none, so every one of them resolves to review on this path. The
 * discrimination this file tests has to be tested here.
 */

export const OPERATOR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
export const AGENT_PROGRAM_DATA = 'FZbgFcC1L9xLpQzXpQyXnTGkKk9y1Y7YZk1CzMhY6q9M';
export const COVERAGE_RAW = 1_000_000 * 10 ** 6;

/** Holdings keyed by canonical mint, in raw base units. */
export type Holdings = Record<string, number>;

export interface GovernanceCase {
  name: string;
  /** `positive` = a takeover the pipeline should confirm.
   *  `negative` = anything it must not confirm, whatever the reason. */
  label: 'positive' | 'negative';
  /** Why this case exists, for whoever reads a failure. */
  why: string;
  tx: TxSpec;
  /** What the agent held before. Defaults to 50,000 USDC. */
  before?: Holdings;
  /** What it holds now. Defaults to nothing — seized or drained. */
  now?: Holdings;
  /** The subset of `now` it owns and cannot move. */
  frozen?: Holdings;
  /** Addresses the holder declared beyond the agent and the holder. */
  declared?: string[];
  /** No declaration exists at all — a policy older than the mechanism. */
  noBaseline?: boolean;
  /** The declaration had not matured when the claim was filed. */
  immatureBaseline?: boolean;
  /** A multisig controller the holder declared for this agent. */
  controller?: string;
}

const DEFAULT_BEFORE: Holdings = { [USDC]: 50_000e6 };

export function usdcBal(account: string, owner: string, amount: number): TokenBal {
  return { account, mint: USDC, owner, amount, decimals: 6 };
}

/** An SPL-Token instruction spec. */
export function tokenIxSpec(type: string, info: Record<string, unknown>) {
  return { programId: TOKEN_PROGRAM, type, info };
}

export function loaderIxSpec(type: string, info: Record<string, unknown>) {
  return { programId: BPF_LOADER_UPGRADEABLE, type, info };
}

export function toReadings(holdings: Holdings): BalanceReading[] {
  return Object.entries(holdings).map(([mint, amountRaw]) => ({
    mint,
    amountRaw,
    decimals: 6,
  }));
}

export function baselineFor(testCase: GovernanceCase): GovernanceBaselineView | null {
  if (testCase.noBaseline) return null;
  return {
    authorities: [AGENT, HOLDER, ...(testCase.declared ?? [])],
    tokenOwner: AGENT,
    expectedDelegate: null,
    expectedCloseAuthority: null,
    programUpgradeAuthority: AGENT,
    controller: testCase.controller ?? null,
    controllerMinThreshold: testCase.controller ? 2 : 0,
    manifestHash: 'b'.repeat(64),
    effectiveAt: BLOCK_TIME - 7_200,
    maturedBeforeClaim: !testCase.immatureBaseline,
  };
}

/**
 * Readings taken five minutes after the takeover — inside the 30-minute
 * window, so the conjunction is provable and the corpus measures the
 * authority logic rather than the window arithmetic.
 */
export const READ_AT = BLOCK_TIME + 300;
/** And the "before" five minutes ahead of it, inside the permitted lead. */
export const BASELINE_AT = BLOCK_TIME - 300;

export function mkHolders(testCase: GovernanceCase) {
  const before = testCase.before ?? DEFAULT_BEFORE;
  const now = testCase.now ?? {};
  const frozen = testCase.frozen ?? {};
  return {
    holdingsBefore: async () => ({
      holdings: new Map(
        Object.entries(before).map(([mint, amountRaw]) => [mint, { amountRaw, decimals: 6 }]),
      ),
      blockTime: BASELINE_AT,
    }),
    holdingsNow: async () => ({
      holdings: toReadings(now),
      frozen: toReadings(frozen),
      blockTime: READ_AT,
    }),
  };
}

/** A connection that serves the chain record and no corroboration. */
export function mkConnection(spec: TxSpec, signature: string): Connection {
  const parsed = mkParsedTx(spec, signature);
  return {
    getParsedTransaction: vi.fn(async () => parsed),
    getTransaction: vi.fn(async () => ({ slot: 200_000, blockTime: BLOCK_TIME })),
    getSignaturesForAddress: vi.fn(async () => []),
    getAccountInfo: vi.fn(async () => null),
  } as unknown as Connection;
}

export function mkHelius(tx: unknown): HeliusClient {
  return { getParsedTransaction: vi.fn(async () => tx) } as unknown as HeliusClient;
}

// ---------------------------------------------------------------------------
// Positives — takeovers the pipeline should confirm
// ---------------------------------------------------------------------------

export const POSITIVES: GovernanceCase[] = [
  {
    name: 'owner seizure via SetAuthority',
    label: 'positive',
    why: 'The account stopped being the agent’s. No transfer is needed to lose it.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, ATTACKER, 50_000e6)],
      instructions: [
        tokenIxSpec('setAuthority', {
          account: AGENT_USDC_ATA,
          authorityType: 'accountOwner',
          authority: ATTACKER,
          newAuthority: ATTACKER,
        }),
      ],
    },
  },
  {
    name: 'freeze-and-ransom',
    label: 'positive',
    why:
      'The balance never moves and the owner never changes. Every value-based ' +
      'measurement in the system reads zero; the agent can no longer act.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      instructions: [
        tokenIxSpec('freezeAccount', {
          account: AGENT_USDC_ATA,
          mint: USDC,
          freezeAuthority: ATTACKER,
        }),
      ],
    },
    now: { [USDC]: 50_000e6 },
    frozen: { [USDC]: 50_000e6 },
  },
  {
    name: 'seizure through an opaque program',
    label: 'positive',
    why:
      'No instruction the RPC could decode. The owner change is still visible ' +
      'in the balance snapshots, which is why they are read separately.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, ATTACKER, 50_000e6)],
      instructions: [
        { programId: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', accounts: [AGENT_USDC_ATA] },
      ],
    },
  },
  {
    name: 'delegate installed by a foreign authority and drawn',
    label: 'positive',
    why: 'The agent never signed. Somebody else granted themselves an allowance and used it.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, AGENT, 0)],
      instructions: [
        tokenIxSpec('approve', {
          source: AGENT_USDC_ATA,
          delegate: ATTACKER,
          authority: ATTACKER,
          amount: '50000000000',
        }),
      ],
    },
  },
  {
    name: 'seizure with the funds already moved on',
    label: 'positive',
    why: 'The account changed hands and was emptied in the same breath.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA, 'CXkwzsgWF2nLBJS5N6HRe9H2MVfKh8HwEtfQbF3fyXpV'],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, ATTACKER, 0)],
      instructions: [
        tokenIxSpec('setAuthority', {
          account: AGENT_USDC_ATA,
          authorityType: 'accountOwner',
          authority: ATTACKER,
          newAuthority: ATTACKER,
        }),
        tokenIxSpec('transfer', {
          source: AGENT_USDC_ATA,
          destination: 'CXkwzsgWF2nLBJS5N6HRe9H2MVfKh8HwEtfQbF3fyXpV',
          authority: ATTACKER,
          amount: '50000000000',
        }),
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Negatives — none of these may ever confirm
// ---------------------------------------------------------------------------

export const NEGATIVES: GovernanceCase[] = [
  {
    name: 'routine Realms vote next to a rent payment',
    label: 'negative',
    why:
      'The exact shape the old verifier confirmed at 50% of coverage: a governance ' +
      'program was invoked and some balance moved. Neither fact says anything about ' +
      'who controls the agent.',
    tx: {
      signers: [AGENT],
      otherKeys: [AGENT_USDC_ATA, 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw'],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, AGENT, 49_900e6)],
      instructions: [
        { programId: 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw', accounts: [AGENT] },
      ],
    },
    now: { [USDC]: 49_900e6 },
  },
  {
    name: 'holder rotates the agent account to a declared operator',
    label: 'negative',
    why: 'Control moved to an address the holder signed for before the incident.',
    tx: {
      signers: [HOLDER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, OPERATOR, 50_000e6)],
      instructions: [
        tokenIxSpec('setAuthority', {
          account: AGENT_USDC_ATA,
          authorityType: 'accountOwner',
          authority: HOLDER,
          newAuthority: OPERATOR,
        }),
      ],
    },
    declared: [OPERATOR],
  },
  {
    name: 'holder rotates the agent account to their own wallet',
    label: 'negative',
    why: 'Control never left the family, whatever the manifest says about that address.',
    tx: {
      signers: [HOLDER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, HOLDER, 50_000e6)],
      instructions: [
        tokenIxSpec('setAuthority', {
          account: AGENT_USDC_ATA,
          authorityType: 'accountOwner',
          authority: HOLDER,
          newAuthority: HOLDER,
        }),
      ],
    },
  },
  {
    name: 'agent delegates to a declared lending protocol',
    label: 'negative',
    why: 'An allowance the agent granted to an address the holder declared is ordinary DeFi.',
    tx: {
      signers: [AGENT],
      otherKeys: [AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      instructions: [
        tokenIxSpec('approve', {
          source: AGENT_USDC_ATA,
          delegate: OPERATOR,
          owner: AGENT,
          amount: '10000000000',
        }),
      ],
    },
    declared: [OPERATOR],
    now: { [USDC]: 50_000e6 },
  },
  {
    name: 'program upgraded by its declared authority',
    label: 'negative',
    why: 'The agent handing its program to an address the holder declared is a deploy, not a theft.',
    tx: {
      signers: [AGENT],
      otherKeys: [AGENT_PROGRAM_DATA, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      instructions: [
        loaderIxSpec('setAuthority', {
          account: AGENT_PROGRAM_DATA,
          authority: AGENT,
          newAuthority: OPERATOR,
        }),
      ],
    },
    declared: [OPERATOR],
    now: { [USDC]: 50_000e6 },
  },
  {
    name: 'reverted seizure',
    label: 'negative',
    why: 'A transaction that failed transferred no authority.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      err: { InstructionError: [0, 'Custom'] },
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      instructions: [
        tokenIxSpec('setAuthority', {
          account: AGENT_USDC_ATA,
          authorityType: 'accountOwner',
          authority: ATTACKER,
          newAuthority: ATTACKER,
        }),
      ],
    },
    now: { [USDC]: 50_000e6 },
  },
  {
    name: 'plain drain with no control change',
    label: 'negative',
    why: 'A drain is the exploit path’s business. Nothing about control moved.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, AGENT, 0)],
      instructions: [
        tokenIxSpec('transfer', {
          source: AGENT_USDC_ATA,
          destination: 'CXkwzsgWF2nLBJS5N6HRe9H2MVfKh8HwEtfQbF3fyXpV',
          authority: ATTACKER,
          amount: '50000000000',
        }),
      ],
    },
  },
  {
    name: 'seizure of an empty account',
    label: 'negative',
    why: 'Control changed hands and there was nothing behind it.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 0)],
      post: [usdcBal(AGENT_USDC_ATA, ATTACKER, 0)],
      instructions: [
        tokenIxSpec('setAuthority', {
          account: AGENT_USDC_ATA,
          authorityType: 'accountOwner',
          authority: ATTACKER,
          newAuthority: ATTACKER,
        }),
      ],
    },
    before: { [USDC]: 0 },
  },
  {
    name: 'takeover on a policy with no declared baseline',
    label: 'negative',
    why:
      'A real takeover, but there is no declaration to have departed from. This must ' +
      'reach a human rather than being paid on an inference — or denied.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, ATTACKER, 50_000e6)],
      instructions: [
        tokenIxSpec('setAuthority', {
          account: AGENT_USDC_ATA,
          authorityType: 'accountOwner',
          authority: ATTACKER,
          newAuthority: ATTACKER,
        }),
      ],
    },
    noBaseline: true,
  },
  {
    name: 'takeover against a baseline declared too recently',
    label: 'negative',
    why:
      'A declaration that had not matured when the claim was filed proves nothing — it ' +
      'is exactly what a stolen holder key would write first.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, ATTACKER, 50_000e6)],
      instructions: [
        tokenIxSpec('setAuthority', {
          account: AGENT_USDC_ATA,
          authorityType: 'accountOwner',
          authority: ATTACKER,
          newAuthority: ATTACKER,
        }),
      ],
    },
    immatureBaseline: true,
  },
  {
    name: 'undeclared rotation the holder signed themselves',
    label: 'negative',
    why:
      'Either a stale manifest or a stolen holder key. A stolen key signs exactly like ' +
      'its owner, so this must not be paid on the signature alone.',
    tx: {
      signers: [HOLDER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, OPERATOR, 50_000e6)],
      instructions: [
        tokenIxSpec('setAuthority', {
          account: AGENT_USDC_ATA,
          authorityType: 'accountOwner',
          authority: HOLDER,
          newAuthority: OPERATOR,
        }),
      ],
    },
  },
  {
    name: 'opaque Squads config change, no declared controller',
    label: 'negative',
    why:
      'The RPC cannot decode it, but this policy declares no multisig controller, so ' +
      'nothing about the covered account is in question.',
    tx: {
      signers: [AGENT],
      otherKeys: [AGENT_USDC_ATA, SQUADS_V4],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      instructions: [{ programId: SQUADS_V4, accounts: [AGENT] }],
    },
    now: { [USDC]: 50_000e6 },
  },
  {
    name: 'opaque Squads config change on a declared controller',
    label: 'negative',
    why:
      'Whether the threshold was weakened cannot be established from an instruction ' +
      'the RPC does not decode. This must escalate, not close — the difference between ' +
      '"we checked" and "we looked at something unreadable".',
    tx: {
      signers: [AGENT],
      otherKeys: [AGENT_USDC_ATA, SQUADS_V4],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      instructions: [{ programId: SQUADS_V4, accounts: [AGENT] }],
    },
    now: { [USDC]: 50_000e6 },
    controller: SQUADS_V4,
  },
  {
    name: 'close authority installed by a stranger',
    label: 'negative',
    why:
      'A capability, not a loss. SPL Token refuses to close a non-empty account, so ' +
      'whoever holds this must drain first — and a drain is measured on its own.',
    tx: {
      signers: [ATTACKER],
      otherKeys: [AGENT, AGENT_USDC_ATA],
      pre: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      post: [usdcBal(AGENT_USDC_ATA, AGENT, 50_000e6)],
      instructions: [
        tokenIxSpec('setAuthority', {
          account: AGENT_USDC_ATA,
          authorityType: 'closeAccount',
          authority: ATTACKER,
          newAuthority: ATTACKER,
        }),
      ],
    },
    now: { [USDC]: 50_000e6 },
  },
];
