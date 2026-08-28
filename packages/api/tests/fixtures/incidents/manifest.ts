import { TriggerType } from '@covantic/shared';
import type { BacktestCase } from '../../../src/services/backtest/types.js';

/**
 * Documented incidents, replayed from mainnet.
 *
 * Everything here is a real transaction, fetched by signature from long-term
 * storage and committed verbatim under `cassettes/`. The expectations are
 * hand-written; nothing in this file was produced by running the pipeline,
 * because a corpus that records what the code already does can only ever
 * agree with it.
 *
 * ## What a replay of the Wormhole theft actually tests
 *
 * The covered event is a loss suffered by an *insured agent wallet*. The
 * Wormhole loss was not that shape: the bridge's Solana custody never lost a
 * balance, it gained a liability, because 120,000 wETH was minted against
 * collateral that did not exist on Ethereum. No wallet's balance fell, so no
 * agent-wallet policy could have paid, and no amount of detector tuning
 * changes that. Saying so is the point of including it.
 *
 * What the transactions *are* good for is the harder half of the problem.
 * These are among the largest value movements in Solana's history — a
 * $214M single transfer, an $18M swap — and every one of them was authorised
 * by the wallet that made it. A detector that pays out on size, on an
 * unfamiliar program, or on "a large outflow from a young wallet" confirms
 * all six. So the subject is set to the attacker's own wallet and the
 * expectation is that nothing confirms: this is the adversarial end of the
 * false-positive gate, drawn from real events rather than imagined ones.
 */

/** The Wormhole attacker's Solana wallet. Public since February 2022. */
export const WORMHOLE_ATTACKER = 'CxegPrfn2ge5dNiQberUrQJkHCcimeR4VXkeawcFBBka';

/** Every trigger, so a case cannot pass by being routed somewhere quiet. */
const ALL_TRIGGERS = [
  TriggerType.Exploit,
  TriggerType.OracleManipulation,
  TriggerType.GovernanceAttack,
  TriggerType.AgentError,
];

/** A 1,000,000 USDC policy — larger than any loss these cases could imply,
 *  so nothing is suppressed by hitting the coverage ceiling. */
const COVERAGE_RAW = 1_000_000 * 10 ** 6;

const HELIUS_SOURCE = 'https://www.helius.dev/blog/solana-hacks';

export const INCIDENT_CASES: BacktestCase[] = [
  {
    cassette: 'wormhole-2022-02-02-mint.json',
    subject: WORMHOLE_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why:
      '120,000 wETH appears in a wallet that held nothing. An inflow is not a loss, ' +
      'however inexplicable — a detector that reads "large unexplained movement" as a ' +
      'covered event confirms the single most infamous transaction on Solana.',
    source: HELIUS_SOURCE,
  },
  {
    cassette: 'wormhole-2022-02-02-bridge-out-10k.json',
    subject: WORMHOLE_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why: '10,000 wETH leaves, signed by the wallet that owns it, through the bridge program.',
    source: HELIUS_SOURCE,
  },
  {
    cassette: 'wormhole-2022-02-02-bridge-out-80k.json',
    subject: WORMHOLE_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why:
      "80,000 wETH — roughly $214M at the day's price — leaves in one transfer the owner " +
      'signed. Size is the whole of the signal here, and size is not evidence.',
    source: HELIUS_SOURCE,
  },
  {
    cassette: 'wormhole-2022-02-02-swap-sol.json',
    subject: WORMHOLE_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why:
      '16,879 wETH swapped for 269,356 SOL at close to the exchange references of that ' +
      'minute. A very large trade at a fair price is not oracle manipulation.',
    source: HELIUS_SOURCE,
  },
  {
    cassette: 'wormhole-2022-02-02-swap-usdc.json',
    subject: WORMHOLE_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why: '7,504 wETH swapped for 18,044,852 USDC, again close to the references.',
    source: HELIUS_SOURCE,
  },
  {
    cassette: 'wormhole-2022-02-02-usdc-out.json',
    subject: WORMHOLE_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why: '18,044,852 USDC leaves the wallet, signed by its owner.',
    source: HELIUS_SOURCE,
  },
];
