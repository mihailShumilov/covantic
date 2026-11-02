import { PublicKey } from '@solana/web3.js';
import type { Connection, Keypair, TransactionInstruction } from '@solana/web3.js';
import { solanaTxLink, TRIGGER_ORACLE_MANIPULATION } from './config.js';
import type { AgentConfig } from './config.js';
import { log, step } from './log.js';
import type { SignIntent, WorkerClient } from './near/client.js';
import { ConsensusPricer, defaultCexSources, PythHermesSource } from './predicate/baseline.js';
import type { EvidenceBundle, PriceOracle } from './predicate/baseline.js';
import { evaluate } from './predicate/evaluate.js';
import { collectEvidence } from './predicate/evidence.js';
import type { PredicateResult } from './predicate/types.js';
import { postPriceUpdate } from './solana/pyth.js';
import { CovanticProgram } from './solana/program.js';
import { SolanaRpc } from './solana/rpc.js';
import { broadcast, buildOracleTransaction } from './solana/transaction.js';
import { loadPayDecision, saveEvidence } from './state.js';

/** `LOCK_ORACLE_MANIPULATION` in the deployed `devnet-fast-lock` build. */
export const LOCK_SECONDS = 30;
const LOCK_MARGIN_SECONDS = 5;
const POLICY_STATE_CLAIM_PENDING = 1;
const POLICY_STATE_CLAIM_PAID = 2;

export type PayDecision = Extract<PredicateResult, { verdict: 'PAY' }>;

export interface AgentDeps {
  config: AgentConfig;
  connection: Connection;
  program: CovanticProgram;
  rpc: SolanaRpc;
  priceOracle: PriceOracle;
  worker: WorkerClient;
  oracleAddress: PublicKey;
  coveredMint: PublicKey;
  /** Pays for Pyth posts. Holds no authority over the program. */
  relayer: Keypair | null;
}

export function buildPriceOracle(): ConsensusPricer {
  const pyth = process.env.PYTH_HERMES_API_KEY ? [new PythHermesSource()] : [];
  return new ConsensusPricer([...pyth, ...defaultCexSources()]);
}

export async function judge(
  deps: AgentDeps,
  policyAddress: PublicKey,
  triggerTx: string,
): Promise<{ result: PredicateResult; bundle: EvidenceBundle | null }> {
  const policy = await deps.program.readPolicy(policyAddress);
  const evidence = await collectEvidence(triggerTx, policy.agent, policy.coverageRaw, {
    rpc: deps.rpc,
    oracle: deps.priceOracle,
    coveredMint: deps.coveredMint.toBase58(),
    stagedVenues: deps.config.stagedVenues,
  });
  if (!evidence.ok) {
    return {
      bundle: null,
      result: {
        verdict: 'NO_PAY',
        reason: evidence.reason,
        policy: policy.address,
        trigger_tx: triggerTx,
        evidence_hash: null,
        retryable: evidence.retryable,
        details: evidence.details ?? {},
      },
    };
  }
  const result = evaluate({
    bundle: evidence.bundle,
    policy,
    nowSec: Math.floor(Date.now() / 1000),
    waitingWindowSec: deps.config.waitingWindowSec,
  });
  return { result, bundle: evidence.bundle };
}

/** Sends one instruction through the contract and lands it. */
async function signAndLand(
  deps: AgentDeps,
  instruction: TransactionInstruction,
  intent: SignIntent,
  label: string,
): Promise<string> {
  const unsigned = await buildOracleTransaction(deps.connection, deps.oracleAddress, instruction);
  log(`${label}: requesting a signature (${unsigned.message.length} byte message)`);
  const signature = await deps.worker.requestSignature(unsigned.message, intent);
  const landed = await broadcast(deps.connection, unsigned, deps.oracleAddress, signature);
  log(`${label}: ${solanaTxLink(landed)}`);
  return landed;
}

export async function publishAttestation(
  deps: AgentDeps,
  instruction: TransactionInstruction,
): Promise<string> {
  const intent = { trigger_type: 0, evidence_hash: '00'.repeat(32) };
  return signAndLand(deps, instruction, intent, 'upsert_attestation');
}

/** Files the claim, waits out the lock, posts the signed price and pays. */
export async function settle(deps: AgentDeps, decision: PayDecision): Promise<string | null> {
  const policyAddress = new PublicKey(decision.policy);
  const intent = {
    trigger_type: TRIGGER_ORACLE_MANIPULATION,
    evidence_hash: decision.evidence_hash,
  };

  let policy = await deps.program.readPolicy(policyAddress);
  if (policy.state === POLICY_STATE_CLAIM_PAID) {
    log('policy is already paid, nothing to do');
    return null;
  }
  if (policy.state !== POLICY_STATE_CLAIM_PENDING) {
    step('File the claim through the contract');
    const instruction = await deps.program.submitClaim(
      deps.oracleAddress,
      policyAddress,
      TRIGGER_ORACLE_MANIPULATION,
      decision.trigger_tx,
    );
    await signAndLand(deps, instruction, intent, 'oracle_submit_claim');
    policy = await deps.program.readPolicy(policyAddress);
  }

  step(`Wait out the ${LOCK_SECONDS} second lock`);
  await new Promise((resolve) => setTimeout(resolve, (LOCK_SECONDS + LOCK_MARGIN_SECONDS) * 1000));

  step('Post the signed Pyth price with the unprivileged relayer');
  if (!deps.relayer) throw new Error('settling needs a funded relayer key');
  const { inputs } = decision;
  const posted = await postPriceUpdate(
    deps.connection,
    deps.relayer,
    inputs.signedUpdateHex,
    inputs.feedIdHex,
  );
  posted.signatures.forEach((signature) => log(`pyth post: ${solanaTxLink(signature)}`));

  step('Pay through the contract');
  const instruction = await deps.program.payout({
    oracle: deps.oracleAddress,
    policy: policyAddress,
    holder: new PublicKey(policy.holder),
    usdcMint: deps.coveredMint,
    priceUpdate: posted.priceUpdate,
    payoutAmount: inputs.payoutAmount,
    feedIdHex: inputs.feedIdHex,
    triggerBlockTime: inputs.triggerBlockTime,
    executedPriceScaled: inputs.executedPriceScaled,
    subjectQuantity: inputs.subjectQuantity,
    subjectDecimals: inputs.subjectDecimals,
    bundleHashHex: decision.evidence_hash,
  });
  return signAndLand(deps, instruction, intent, 'verify_and_payout_v2');
}

/**
 * The whole path for one trigger transaction. Returns the verdict, and a PAY
 * decision is kept on disk so a restart settles the same evidence.
 */
export async function processTrigger(
  deps: AgentDeps,
  policyAddress: PublicKey,
  triggerTx: string,
): Promise<PredicateResult> {
  const earlier = loadPayDecision(deps.config.stateDir, triggerTx);
  if (earlier) {
    await settle(deps, earlier);
    return earlier;
  }
  const { result, bundle } = await judge(deps, policyAddress, triggerTx);
  const saved = saveEvidence(deps.config.stateDir, bundle, result);
  log(`verdict ${result.verdict}: ${result.reason}`);
  log(`evidence ${saved.path} sha256 ${saved.sha256}`);
  if (result.verdict === 'PAY') await settle(deps, result);
  return result;
}
