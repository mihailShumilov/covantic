/**
 * Deploys the trigger contract to NEAR testnet in local mode and registers a
 * worker that holds only a function-call key.
 *
 * Reads NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY, and appends the resulting values
 * to .env. No key is printed.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Account, actions, JsonRpcProvider, KeyPair, nearToYocto, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { COVANTIC_PROGRAM_ID, DERIVATION_PATH, MPC_CONTRACT_ID, nearAccountLink, requireEnv } from '../agent/src/config.js';
import { log, step } from '../agent/src/log.js';
import { deriveOracleAddress } from '../agent/src/near/client.js';

const WASM_PATH = fileURLToPath(new URL('../contracts/trigger/res/covantic_trigger.wasm', import.meta.url));
const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));
const NEAR_RPC_URL = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com';

/** Storage for a 770 KB contract is about 7.7 NEAR. */
const CONTRACT_FUNDING_NEAR = '8.6';
const WORKER_FUNDING_NEAR = '0.6';
const REGISTER_DEPOSIT_NEAR = '0.01';
const WORKER_KEY_ALLOWANCE_NEAR = '0.5';
const WORKER_METHODS = ['request_signature'];
const DEFAULT_DAILY_CAP_USDC = 5_000n;
const DEFAULT_DAILY_OPERATIONS = 100;
const ATTESTATION_VALIDITY_MS = 365n * 24n * 3600n * 1000n;

/** What `getAttestation` returns outside a TEE. Local mode admits by whitelist. */
const ZERO_48 = '0'.repeat(96);
const ZERO_32 = '0'.repeat(64);
const LOCAL_ATTESTATION = {
  quote: [],
  collateral: {
    pck_crl_issuer_chain: '',
    root_ca_crl: '',
    pck_crl: '',
    tcb_info_issuer_chain: '',
    tcb_info: '',
    tcb_info_signature: '',
    qe_identity_issuer_chain: '',
    qe_identity: '',
    qe_identity_signature: '',
  },
  tcb_info: {
    mrtd: ZERO_48,
    rtmr0: ZERO_48,
    rtmr1: ZERO_48,
    rtmr2: ZERO_48,
    rtmr3: ZERO_48,
    os_image_hash: '',
    compose_hash: ZERO_32,
    device_id: ZERO_32,
    app_compose: '',
    event_log: [],
  },
};

async function main(): Promise<void> {
  const ownerId = requireEnv('NEAR_ACCOUNT_ID');
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const owner = new Account(ownerId, provider, requireEnv('NEAR_PRIVATE_KEY') as KeyPairString);

  const suffix = Date.now().toString(36);
  const contractId = `trigger-${suffix}.${ownerId}`;
  const workerId = `worker-${suffix}.${ownerId}`;

  step('Read the Solana address the MPC network holds for the contract');
  const oracleAddress = await deriveOracleAddress(NEAR_RPC_URL, contractId, DERIVATION_PATH);
  log(`oracle address ${oracleAddress.toBase58()}`);

  step('Create, fund, deploy and initialise in one atomic transaction');
  // The contract account never receives a key, so its code cannot be changed
  // without deleting it, and a failure here refunds the funding.
  await owner.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.createAccount(),
      actions.transfer(nearToYocto(CONTRACT_FUNDING_NEAR)),
      actions.deployContract(readFileSync(WASM_PATH)),
      actions.functionCall(
        'new',
        {
          requires_tee: false,
          attestation_expiration_time_ms: ATTESTATION_VALIDITY_MS.toString(),
          owner_id: ownerId,
          mpc_contract_id: MPC_CONTRACT_ID,
          derivation_path: DERIVATION_PATH,
          oracle_address: oracleAddress.toBase58(),
          covantic_program: COVANTIC_PROGRAM_ID,
          max_daily_coverage: (DEFAULT_DAILY_CAP_USDC * 1_000_000n).toString(),
          max_daily_operations: DEFAULT_DAILY_OPERATIONS,
        },
        teraToGas(100),
        0n,
      ),
    ],
  });
  log(`contract ${nearAccountLink(contractId)}`);

  step('Create the worker and whitelist it');
  const workerAdminKey = KeyPair.fromRandom('ed25519');
  await owner.createSubAccount({
    accountOrPrefix: workerId,
    publicKey: workerAdminKey.getPublicKey(),
    nearToTransfer: nearToYocto(WORKER_FUNDING_NEAR),
  });
  await owner.callFunction({
    contractId,
    methodName: 'whitelist_agent_for_local',
    args: { account_id: workerId },
    gas: teraToGas(30),
  });

  step('Register the worker, then leave it only a function-call key');
  const worker = new Account(workerId, provider, workerAdminKey.toString() as KeyPairString);
  await worker.callFunction({
    contractId,
    methodName: 'register_agent',
    args: { attestation: LOCAL_ATTESTATION },
    gas: teraToGas(100),
    deposit: nearToYocto(REGISTER_DEPOSIT_NEAR),
  });
  const workerKey = KeyPair.fromRandom('ed25519');
  await worker.signAndSendTransaction({
    receiverId: workerId,
    actions: [
      actions.addFunctionCallAccessKey(
        workerKey.getPublicKey(),
        contractId,
        WORKER_METHODS,
        nearToYocto(WORKER_KEY_ALLOWANCE_NEAR),
      ),
      actions.deleteKey(workerAdminKey.getPublicKey()),
    ],
  });

  appendFileSync(
    ENV_PATH,
    [
      '',
      `TRIGGER_CONTRACT_ID=${contractId}`,
      `ORACLE_ADDRESS=${oracleAddress.toBase58()}`,
      `WORKER_ACCOUNT_ID=${workerId}`,
      `WORKER_PRIVATE_KEY=${workerKey.toString()}`,
      '',
    ].join('\n'),
  );

  step('Done');
  log(`worker ${nearAccountLink(workerId)}`);
  log('Contract, oracle address and worker were added to .env.');
}

await main();
