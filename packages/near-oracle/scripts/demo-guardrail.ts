/**
 * Sends attack messages to the deployed contract and shows each refusal.
 *
 * Needs NEAR testnet only. Messages use a made-up blockhash and made-up
 * policies, so even the one that gets signed could never land on Solana.
 */
import { createTransferInstruction } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
} from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';
import { Account, JsonRpcProvider, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import {
  loadConfig,
  nearAccountLink,
  requireEnv,
  TRIGGER_ORACLE_MANIPULATION,
} from '../agent/src/config.js';
import { log, step } from '../agent/src/log.js';
import { GuardrailRefusal, LocalWorker, toRefusal } from '../agent/src/near/client.js';
import type { SignIntent } from '../agent/src/near/client.js';
import { CovanticProgram } from '../agent/src/solana/program.js';
import type { PayoutArgs } from '../agent/src/solana/program.js';

const USDC = 1_000_000n;
const UPDATE_CONFIG_DISCRIMINATOR = '1d9efcbf0a53db63';
const FAKE_BLOCKHASH = Keypair.generate().publicKey.toBase58();

const config = loadConfig();
const contractId = config.triggerContractId;
const oracle = new PublicKey(requireEnv('ORACLE_ADDRESS'));
const worker = new LocalWorker(requireEnv('WORKER_ACCOUNT_ID'), requireEnv('WORKER_PRIVATE_KEY'), config);
const provider = new JsonRpcProvider({ url: config.nearRpcUrl });
const owner = new Account(
  requireEnv('NEAR_ACCOUNT_ID'),
  provider,
  requireEnv('NEAR_PRIVATE_KEY') as KeyPairString,
);
// Used only to encode instructions. Nothing here touches Solana.
const covantic = new CovanticProgram(new Connection(config.solanaRpcUrl));

const key = (): PublicKey => Keypair.generate().publicKey;
const claimIntent = (hash: string): SignIntent => ({
  trigger_type: TRIGGER_ORACLE_MANIPULATION,
  evidence_hash: hash,
});

function legacyMessage(instruction: TransactionInstruction, feePayer = oracle): Buffer {
  return new Transaction({ feePayer, recentBlockhash: FAKE_BLOCKHASH })
    .add(instruction)
    .serializeMessage();
}

function payoutArgs(policy: PublicKey, amountUsdc: bigint, hash: string): PayoutArgs {
  return {
    oracle,
    policy,
    holder: key(),
    usdcMint: key(),
    priceUpdate: key(),
    payoutAmount: amountUsdc * USDC,
    feedIdHex: 'ef'.repeat(32),
    triggerBlockTime: 1_800_000_000,
    executedPriceScaled: 15_000_000_000,
    subjectQuantity: 1_000_000_000n,
    subjectDecimals: 9,
    bundleHashHex: hash,
  };
}

let failures = 0;

async function refused(
  label: string,
  expected: string,
  attempt: () => Promise<unknown>,
): Promise<void> {
  try {
    await attempt();
    failures += 1;
    log(`FAIL     ${label}: expected ${expected}, the contract signed`);
  } catch (error) {
    const refusal = toRefusal(error);
    if (refusal instanceof GuardrailRefusal && refusal.code === expected) {
      log(`refused  ${label}: ${refusal.message}`);
      return;
    }
    failures += 1;
    log(`FAIL     ${label}: expected ${expected}, got ${String(refusal)}`);
  }
}

async function main(): Promise<void> {
  const hash = 'ab'.repeat(32);
  const intent = claimIntent(hash);
  const send = (message: Buffer, sendIntent = intent) =>
    worker.requestSignature(message, sendIntent);

  log(`contract ${nearAccountLink(contractId)}`);
  log(`oracle   ${oracle.toBase58()}`);

  step('Instructions that are not Covantic');
  await refused('drain the oracle SOL', 'G3_PROGRAM_NOT_ALLOWED', () =>
    send(
      legacyMessage(
        SystemProgram.transfer({ fromPubkey: oracle, toPubkey: key(), lamports: 1_000_000_000 }),
      ),
    ),
  );
  await refused('move vault USDC directly', 'G3_PROGRAM_NOT_ALLOWED', () =>
    send(legacyMessage(createTransferInstruction(key(), key(), oracle, 1_000n * USDC))),
  );

  step('Covantic instructions outside the allowlist');
  const covanticIx = await covantic.submitClaim(oracle, key(), 2, 'x');
  await refused('update_config, to take the admin role', 'G4_INSTRUCTION_NOT_ALLOWED', () =>
    send(
      legacyMessage({
        ...covanticIx,
        data: Buffer.from(UPDATE_CONFIG_DISCRIMINATOR, 'hex'),
      } as TransactionInstruction),
    ),
  );
  await refused('claim with the exploit trigger', 'G4_TRIGGER_TYPE_NOT_ALLOWED', async () =>
    send(legacyMessage(await covantic.submitClaim(oracle, key(), 1, 'x'.repeat(88))), {
      ...intent,
      trigger_type: 1,
    }),
  );

  step('Messages that try to change who signs or how they parse');
  await refused('fee payer is another key', 'G2_FEE_PAYER_NOT_ORACLE', async () =>
    send(legacyMessage(await covantic.submitClaim(oracle, key(), 2, 'x'.repeat(88)), key())),
  );
  await refused('versioned message', 'MESSAGE_MALFORMED', () =>
    send(
      Buffer.from(
        new TransactionMessage({
          payerKey: oracle,
          recentBlockhash: FAKE_BLOCKHASH,
          instructions: [covanticIx],
        })
          .compileToV0Message()
          .serialize(),
      ),
    ),
  );

  step('Payout limits');
  const overCap = await covantic.payout(payoutArgs(key(), 6_000n, hash));
  await refused('payout above the 24 hour cap', 'G6_DAILY_CAP_EXCEEDED', () =>
    send(legacyMessage(overCap)),
  );

  const policy = key();
  const first = await covantic.payout(payoutArgs(policy, 10n, hash));
  const signature = await send(legacyMessage(first));
  log(`signed   a valid payout for a made-up policy: ${signature.toString('hex').slice(0, 24)}…`);
  const second = await covantic.payout(payoutArgs(policy, 11n, hash));
  await refused('second payout for the same policy', 'G5_POLICY_ALREADY_PAID', () =>
    send(legacyMessage(second)),
  );
  await refused('bundle hash differs from the intent', 'INTENT_MISMATCH', async () =>
    send(legacyMessage(await covantic.payout(payoutArgs(key(), 1n, hash))), claimIntent('cd'.repeat(32))),
  );

  step('Callers');
  const claim = legacyMessage(await covantic.submitClaim(oracle, key(), 2, 'x'.repeat(88)));
  await refused('caller is not a registered worker', 'G1_WORKER_NOT_REGISTERED', () =>
    owner.callFunction({
      contractId,
      methodName: 'request_signature',
      args: { payload: claim.toString('base64'), intent },
      gas: teraToGas(150),
    }),
  );

  step('Pause');
  await owner.callFunction({
    contractId,
    methodName: 'set_paused',
    args: { paused: true },
    gas: teraToGas(30),
  });
  try {
    await refused('signing while paused', 'G7_CONTRACT_PAUSED', () => send(claim));
  } finally {
    await owner.callFunction({
      contractId,
      methodName: 'set_paused',
      args: { paused: false },
      gas: teraToGas(30),
    });
  }

  step('Result');
  if (failures > 0) {
    log(`${failures} attempts did not behave as expected`);
    process.exit(1);
  }
  log('Every attack was refused by the contract, before any request reached the MPC network.');
}

await main();
