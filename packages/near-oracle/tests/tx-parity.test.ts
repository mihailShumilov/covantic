import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { CovanticProgram } from '../agent/src/solana/program.js';
import { buildOracleTransaction } from '../agent/src/solana/transaction.js';

/**
 * Pins what the TypeScript builders emit to what the contract accepts. The
 * contract's `typescript_messages_pass_the_guardrails` test reads this file,
 * so a change on either side fails one of the two suites.
 * Regenerate with UPDATE_PARITY=1.
 */
const FIXTURE = fileURLToPath(
  new URL('../contracts/trigger/src/testdata/ts_messages.json', import.meta.url),
);

const key = (seed: number): PublicKey => new PublicKey(Buffer.alloc(32, seed));
const ORACLE = key(1);
const POLICY = key(2);
const AGENT = key(3);
const HASH = 'ab'.repeat(32);
const BLOCKHASH = key(9).toBase58();

const connection = {
  getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
} as unknown as Connection;

async function messages(): Promise<Record<string, string>> {
  const program = new CovanticProgram(new Connection('http://127.0.0.1:1'));
  const instructions = {
    submit_claim: await program.submitClaim(ORACLE, POLICY, 2, '1'.repeat(88)),
    payout: await program.payout({
      oracle: ORACLE,
      policy: POLICY,
      holder: Keypair.fromSeed(Buffer.alloc(32, 4)).publicKey,
      usdcMint: key(5),
      priceUpdate: key(6),
      payoutAmount: 50_000_000n,
      feedIdHex: 'ef'.repeat(32),
      triggerBlockTime: 1_700_000_000,
      executedPriceScaled: 25_000_000_000,
      subjectQuantity: 1_000_000_000n,
      subjectDecimals: 9,
      bundleHashHex: HASH,
    }),
    attestation: await program.attestation({
      oracle: ORACLE,
      agent: AGENT,
      tier: 1,
      validForSeconds: 3_600,
      mandateHash: Buffer.alloc(32, 7),
      envelopeFlatPremium: 1_000_000n,
      feedIdHex: 'ef'.repeat(32),
      subjectMint: key(8),
      subjectDecimals: 9,
      maxSubjectQuantity: 10_000_000_000n,
    }),
  };
  const output: Record<string, string> = {};
  for (const [name, instruction] of Object.entries(instructions)) {
    const { message } = await buildOracleTransaction(connection, ORACLE, instruction);
    output[name] = message.toString('hex');
  }
  return output;
}

describe('transaction parity with the contract', () => {
  it('emits the messages the contract test pins', async () => {
    const built = await messages();
    if (process.env.UPDATE_PARITY) writeFileSync(FIXTURE, `${JSON.stringify(built, null, 2)}\n`);
    expect(built).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  });
});
