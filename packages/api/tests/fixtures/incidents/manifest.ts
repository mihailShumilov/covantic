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
 *
 * ## Why Mango is here as well
 *
 * Wormhole tests size. Mango tests the thing this product actually claims to
 * detect, because the October 2022 exploit *was* an oracle manipulation: the
 * attacker bought MNGO on the open market until the reported price carried
 * collateral it could not support, then borrowed $116M against it.
 *
 * The replay includes the buying itself — 50,000 USDC through Jupiter for
 * 210,545 MNGO — and what it actually demonstrates is worth stating exactly,
 * because it is not what one would hope. The oracle path does not reach its
 * self-inflicted-slippage discriminator here: it stops at
 * `no_price_feed_for_mint`, because MNGO is not in the mint registry and no
 * exchange the pricer reads quotes it today. The case resolves to review.
 *
 * That is the designed answer to an unpriceable asset and it is the honest
 * limit of this replay: the five transfers around it are dismissed on their
 * evidence, and the manipulation itself is dismissed for want of a price.
 * A detector cannot adjudicate a loss it cannot value, and pretending
 * otherwise — defaulting MNGO to par, say — is how a backtest starts
 * flattering the thing it is testing.
 */

/** The Wormhole attacker's Solana wallet. Public since February 2022. */
export const WORMHOLE_ATTACKER = 'CxegPrfn2ge5dNiQberUrQJkHCcimeR4VXkeawcFBBka';

/** The Mango attack wallet. Read off the chain rather than off a write-up:
 *  it is the signer of the 25M USDC exit, and its whole history begins at
 *  19:36 on the day of the exploit. */
export const MANGO_ATTACKER = 'yUJw9a2PyoqKkH47i4yEGf4WXomSHMiK7Lp29Xs2NqM';

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

const MANGO_SOURCE =
  'https://www.coindesk.com/markets/2022/10/12/how-market-manipulation-led-to-a-100m-exploit-on-solana-defi-exchange-mango';

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
  {
    cassette: 'mango-2022-10-11-fund-attack-wallet.json',
    subject: MANGO_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why:
      '24,838 USDC arrives from an exchange three hours before the manipulation. An ' +
      'inflow to a wallet with no history is the opening move of the largest ' +
      'oracle attack on this chain, and it is still not a loss.',
    source: MANGO_SOURCE,
  },
  {
    cassette: 'mango-2022-10-11-mango-program.json',
    subject: MANGO_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why:
      'A call into the Mango v3 program while the wallet holds 5.5M USDC. An ' +
      'unfamiliar program touching a large balance is the cheapest false positive ' +
      'available, and the transaction moves 100 USDC.',
    source: MANGO_SOURCE,
  },
  {
    cassette: 'mango-2022-10-11-mngo-pump-swap.json',
    subject: MANGO_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why:
      'The manipulation itself: 50,000 USDC for 210,545 MNGO through Jupiter, in a ' +
      'market this wallet is moving on purpose. It resolves to review rather than a ' +
      'verdict — `no_price_feed_for_mint` on the oracle path, `position_not_valued` on ' +
      'the exploit path — because MNGO is outside the mint registry and no exchange ' +
      'the pricer reads still quotes it. Review is the right answer to an unpriceable ' +
      'asset; what it is not is a demonstration that the discriminator works.',
    source: MANGO_SOURCE,
  },
  {
    cassette: 'mango-2022-10-11-otc-inflow.json',
    subject: MANGO_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why: '1,049,584 USDC arrives while the wallet holds 54M of borrowed funds.',
    source: MANGO_SOURCE,
  },
  {
    cassette: 'mango-2022-10-11-usdc-out-20m.json',
    subject: MANGO_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why:
      '20,000,000 USDC leaves in one owner-signed transfer. The balance drop is real, ' +
      'enormous, and authorised — which is the whole distinction the exploit path rests on.',
    source: MANGO_SOURCE,
  },
  {
    cassette: 'mango-2022-10-11-usdc-out-25m.json',
    subject: MANGO_ATTACKER,
    triggers: ALL_TRIGGERS,
    expect: 'never-confirms',
    coverageRaw: COVERAGE_RAW,
    why: '25,000,000 USDC more, two minutes later, leaving the wallet holding 7.5M.',
    source: MANGO_SOURCE,
  },
];
