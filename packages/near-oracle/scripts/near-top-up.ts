/**
 * Adds testnet NEAR to NEAR_ACCOUNT_ID. The faucet only funds new accounts, so
 * this creates a throwaway account and sends its balance over.
 */
import { randomBytes } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair, nearToYocto } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { requireEnv } from '../agent/src/config.js';
import { log } from '../agent/src/log.js';

const FAUCET_URL = 'https://helper.nearprotocol.com/account';
const NEAR_RPC_URL = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com';
const TRANSFER_NEAR = '9.8';

const key = KeyPair.fromRandom('ed25519');
const donorId = `covantic-donor-${randomBytes(4).toString('hex')}.testnet`;
const response = await fetch(FAUCET_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ newAccountId: donorId, newAccountPublicKey: key.getPublicKey().toString() }),
});
if (!response.ok) throw new Error(`faucet answered ${response.status}`);

await new Promise((resolve) => setTimeout(resolve, 3000));
const donor = new Account(
  donorId,
  new JsonRpcProvider({ url: NEAR_RPC_URL }),
  key.toString() as KeyPairString,
);
await donor.transfer({ receiverId: requireEnv('NEAR_ACCOUNT_ID'), amount: nearToYocto(TRANSFER_NEAR) });
log(`sent ${TRANSFER_NEAR} NEAR from ${donorId}`);
