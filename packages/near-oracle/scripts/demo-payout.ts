/**
 * Devnet end to end: buy cover, stage a loss, judge it, and pay through the
 * contract. Stops with a clear message if the contract does not hold the
 * oracle role yet.
 */
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import { LAMPORTS_PER_SOL, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import { agentMandateCommitment } from '@covantic/shared';
import { solanaAddressLink, solanaTxLink } from '../agent/src/config.js';
import { createAgent } from '../agent/src/deps.js';
import { log, step } from '../agent/src/log.js';
import { publishAttestation, processTrigger } from '../agent/src/pipeline.js';
import { FEED_IDS } from '../agent/src/predicate/baseline.js';
import { fundCast, solPrice, stagedSwap, SUBJECT_LAMPORTS, venueAccounts } from './lib/staging.js';

const USDC = 1_000_000n;
const COVERAGE_RAW = 50n * USDC;
const FLAT_PREMIUM_RAW = 100_000n;
const POLICY_SECONDS = 3_600;
const ATTESTATION_SECONDS = 3_600;
const MEDIUM_TIER = 1;
const MIN_ORACLE_SOL = 0.05;
const FILL_DISCOUNT = 0.9;
/** Reserve many times the order, so the order cannot explain the price. */
const RESERVE_MULTIPLE = 12n;
const RETRY_MS = 20_000;
const MAX_ATTEMPTS = 12;

const MANDATE = {
  maxSingleOutflowRaw: 1_000n * USDC,
  maxWindowOutflowRaw: 1_000n * USDC,
  windowSeconds: 3_600n,
  minRetainedBalanceRaw: 0n,
};

function stop(message: string): never {
  log(`\nStopped: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const deps = await createAgent();
  const { connection, program, oracleAddress, coveredMint } = deps;

  step('Check prerequisites');
  const config = await program.readConfig();
  if (!config.oracleAuthority.equals(oracleAddress)) {
    stop(
      `config.oracle_authority is ${config.oracleAuthority.toBase58()}, not ${oracleAddress.toBase58()}. ` +
        'Run `pnpm derive-address` and have the admin run the printed command.',
    );
  }
  if (!process.env.PYTH_HERMES_API_KEY) {
    stop('PYTH_HERMES_API_KEY is not set. A payout needs a signed Pyth price.');
  }
  const oracleSol = (await connection.getBalance(oracleAddress)) / LAMPORTS_PER_SOL;
  if (oracleSol < MIN_ORACLE_SOL) {
    stop(`the oracle holds ${oracleSol} SOL. Fund ${oracleAddress.toBase58()} with at least 0.1.`);
  }
  const funder = deps.relayer;
  if (!funder) stop('no funder key');

  const reference = await solPrice(deps.priceOracle);
  const subjectUi = Number(SUBJECT_LAMPORTS) / LAMPORTS_PER_SOL;
  const fillRaw = BigInt(Math.round(subjectUi * reference * FILL_DISCOUNT * 1e6));
  log(`SOL/USD reference ${reference}, staged fill ${Number(fillRaw) / 1e6} USDC`);

  step('Fund a holder, an agent and a counterparty');
  log(`funder ${funder.publicKey.toBase58()}`);
  const cast = await fundCast(connection, funder, coveredMint, {
    holderUsdcRaw: 5n * USDC,
    counterpartyUsdcRaw: fillRaw * RESERVE_MULTIPLE,
  });
  deps.config.stagedVenues = new Set(venueAccounts(cast, coveredMint));
  log(`holder ${solanaAddressLink(cast.holder.publicKey.toBase58())}`);
  log(`agent  ${solanaAddressLink(cast.agent.publicKey.toBase58())}`);

  step('Attest the agent through the contract');
  await publishAttestation(
    deps,
    await program.attestation({
      oracle: oracleAddress,
      agent: cast.agent.publicKey,
      tier: MEDIUM_TIER,
      validForSeconds: ATTESTATION_SECONDS,
      mandateHash: agentMandateCommitment({
        ...MANDATE,
        allowedCounterparties: [],
        allowedPrograms: [],
      }),
      envelopeFlatPremium: FLAT_PREMIUM_RAW,
      feedIdHex: FEED_IDS['SOL/USD'] as string,
      subjectMint: NATIVE_MINT,
      subjectDecimals: 9,
      maxSubjectQuantity: SUBJECT_LAMPORTS * 5n,
    }),
  );

  step('Buy cover');
  const { policyCounter } = await program.readConfig();
  const policy = program.policyAddress(cast.holder.publicKey, policyCounter);
  const purchase = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      await program.createPolicy({
        holder: cast.holder.publicKey,
        agent: cast.agent.publicKey,
        usdcMint: coveredMint,
        policyId: policyCounter,
        coverageRaw: COVERAGE_RAW,
        durationSeconds: POLICY_SECONDS,
        mandate: MANDATE,
      }),
    ),
    [cast.holder],
  );
  log(`policy #${policyCounter} ${solanaAddressLink(policy.toBase58())}`);
  log(`create_policy: ${solanaTxLink(purchase)}`);

  step('Stage the loss: sell 0.2 wSOL about 10% below the reference');
  const trigger = await stagedSwap(connection, cast, coveredMint, fillRaw);
  log(`trigger: ${solanaTxLink(trigger)}`);

  step('Judge and settle');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await processTrigger(deps, policy, trigger);
    if (result.verdict === 'PAY') break;
    if (!result.retryable) stop(`verdict NO_PAY: ${result.reason}`);
    if (attempt === MAX_ATTEMPTS) stop(`still NO_PAY after retries: ${result.reason}`);
    log(`waiting for evidence: ${result.reason}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }

  const paid = await program.readPolicy(policy);
  step('Result');
  log(`policy state ${paid.state} (2 is ClaimPaid)`);
  const holderUsdc = getAssociatedTokenAddressSync(coveredMint, cast.holder.publicKey);
  const { value } = await connection.getTokenAccountBalance(holderUsdc);
  log(`holder USDC ${value.uiAmountString}`);
}

await main();
