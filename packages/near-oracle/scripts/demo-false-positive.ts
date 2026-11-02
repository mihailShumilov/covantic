/**
 * A real loss with no manipulation: the agent's order was most of the venue's
 * reserve. The verdict is NO_PAY and the contract is never called.
 *
 * With no flags this replays the recorded devnet run, which needs nothing but
 * this repo. `--live` stages a fresh swap on devnet and records it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { loadOrCreateFunder } from '../agent/src/state.js';
import { solanaTxLink } from '../agent/src/config.js';
import { log, step } from '../agent/src/log.js';
import { buildPriceOracle } from '../agent/src/pipeline.js';
import { sha256Canonical } from '../agent/src/predicate/baseline.js';
import type { EvidenceBundle } from '../agent/src/predicate/baseline.js';
import { evaluate } from '../agent/src/predicate/evaluate.js';
import { collectEvidence } from '../agent/src/predicate/evidence.js';
import type { PolicySnapshot } from '../agent/src/predicate/types.js';
import { CovanticProgram } from '../agent/src/solana/program.js';
import { SolanaRpc } from '../agent/src/solana/rpc.js';
import { fundCast, solPrice, stagedSwap, SUBJECT_LAMPORTS, venueAccounts } from './lib/staging.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/false-positive.json', import.meta.url));
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const USDC = 1_000_000n;
const FILL_DISCOUNT = 0.9;
/** A reserve 1.5 times the fill: the order takes two thirds of it. */
const RESERVE_NUMERATOR = 3n;
const RESERVE_DENOMINATOR = 2n;
const RETRY_MS = 20_000;
const MAX_ATTEMPTS = 12;
const REPLAY_DELAY_SEC = 60;

interface Recording {
  bundle: EvidenceBundle;
  policy: PolicySnapshot;
  sha256: string;
}

function show({ bundle, policy }: Recording): void {
  const result = evaluate({
    bundle,
    policy,
    nowSec: (bundle.blockTime as number) + REPLAY_DELAY_SEC,
    waitingWindowSec: 0,
  });
  log(`trigger  ${solanaTxLink(bundle.txSignature)}`);
  log(`verdict  ${result.verdict}: ${result.reason}`);
  if (result.verdict === 'PAY') {
    log('Unexpected: this evidence should not pay.');
    process.exit(1);
  }
  log('The contract was not called, so nothing was signed.');
}

function replay(): void {
  step('Replay the recorded devnet run');
  const recording = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recording;
  const { bundle, policy } = recording;
  if (sha256Canonical({ bundle, policy }) !== recording.sha256) {
    throw new Error('the recording does not match its sha256');
  }
  log(`sha256   ${recording.sha256}`);
  show(recording);
}

async function live(): Promise<void> {
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const program = new CovanticProgram(connection);
  const { usdcMint } = await program.readConfig();
  const oracle = buildPriceOracle();
  const funder = loadOrCreateFunder(process.env.STATE_DIR || '.state');

  const subjectUi = Number(SUBJECT_LAMPORTS) / LAMPORTS_PER_SOL;
  const fillRaw = BigInt(Math.round(subjectUi * (await solPrice(oracle)) * FILL_DISCOUNT * 1e6));

  step('Stage a swap that takes two thirds of the counterparty reserve');
  log(`funder ${funder.publicKey.toBase58()}`);
  const cast = await fundCast(connection, funder, usdcMint, {
    holderUsdcRaw: USDC,
    counterpartyUsdcRaw: (fillRaw * RESERVE_NUMERATOR) / RESERVE_DENOMINATOR,
  });
  const signature = await stagedSwap(connection, cast, usdcMint, fillRaw);
  log(`trigger ${solanaTxLink(signature)}`);

  step('Collect evidence');
  const coverageRaw = 50 * 1_000_000;
  const now = Math.floor(Date.now() / 1000);
  // The verdict turns on the swap, so this run needs no policy on chain.
  const policy: PolicySnapshot = {
    address: 'none, the policy gate is not what refuses this',
    policyId: '0',
    holder: cast.holder.publicKey.toBase58(),
    agent: cast.agent.publicKey.toBase58(),
    coverageRaw,
    state: 0,
    startTime: now - 3_600,
    expiryTime: now + 3_600,
    terms: null,
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const evidence = await collectEvidence(signature, policy.agent, coverageRaw, {
      rpc: new SolanaRpc(SOLANA_RPC_URL),
      oracle,
      coveredMint: usdcMint.toBase58(),
      stagedVenues: new Set(venueAccounts(cast, usdcMint)),
    });
    if (evidence.ok) {
      const body = JSON.parse(JSON.stringify({ bundle: evidence.bundle, policy })) as Recording;
      const recording = { ...body, sha256: sha256Canonical({ bundle: body.bundle, policy: body.policy }) };
      writeFileSync(FIXTURE, `${JSON.stringify(recording, null, 2)}\n`);
      show(recording);
      log(`recorded ${FIXTURE}`);
      return;
    }
    if (!evidence.retryable) throw new Error(`evidence refused: ${evidence.reason}`);
    log(`waiting for evidence: ${evidence.reason}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  throw new Error('evidence never became available');
}

if (process.argv.includes('--live')) await live();
else replay();
