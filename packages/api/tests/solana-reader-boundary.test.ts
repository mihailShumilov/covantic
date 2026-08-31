import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { RpcTransport } from '@solana/kit';
import { CovanticRpcPool } from '../src/config/rpc-pool.js';
import { SolanaReader } from '../src/utils/solana-reader.js';
import { toRawTxView } from '../src/services/exploit/raw-tx.js';
import { bundleHash, canonicalize } from '../src/services/oracle/hash.js';
import {
  AGENT,
  AGENT_USDC_ATA,
  ATTACKER,
  HOLDER,
  OTHER_ATA,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  UNKNOWN_PROGRAM,
  USDC,
  WSOL,
} from './fixtures/exploit.js';

/**
 * INV-BOUND — nothing `bigint`-shaped crosses the `SolanaReader` boundary.
 *
 * `CLAUDE.md` and `solana-reader.ts` both assert it and nothing checked it.
 * The cost of it being false is not a type error: `@solana/kit` upgrades every
 * u64 the JSON-RPC emits to `bigint`, `canonicalize` serialises an evidence
 * bundle with `JSON.stringify`, and `JSON.stringify` *throws* on a `bigint`.
 * So one leaked field does not corrupt a hash loudly — it makes `bundleHash`
 * throw inside `recordEvidence`, whose catch swallows it, which makes
 * `planProvenSettlement` answer `unprovable: no_bundle_hash` and park every
 * claim on that trigger in review. Silent denial of coverage.
 *
 * The generator is the adversary here: it takes a kit-shaped payload and
 * promotes *every* integer leaf to `bigint` before the transport hands it
 * over. That is deliberately worse than what kit does today — kit upgrades a
 * fixed set of keypaths — because the invariant is about the boundary, not
 * about which fields this version of kit happens to widen. A reader that only
 * converts the fields someone remembered fails this and should.
 */

/** A reader over a single fake endpoint that answers every method with `result`. */
function readerReturning(result: unknown): SolanaReader {
  const transport = (async () => ({ jsonrpc: '2.0', id: 1, result })) as unknown as RpcTransport;
  return new SolanaReader(
    new CovanticRpcPool({ primaryUrl: 'https://rpc.example.test', transportFactory: () => transport }),
  );
}

/**
 * Every path in `value` holding a `bigint`.
 *
 * Returned as paths rather than a boolean so a counterexample names the field
 * that leaked instead of saying "somewhere in this 400-line object".
 */
function bigintPaths(value: unknown, path = '$', out: string[] = []): string[] {
  if (typeof value === 'bigint') out.push(`${path} = ${value}n`);
  else if (Buffer.isBuffer(value) || value instanceof Uint8Array) return out;
  else if (Array.isArray(value)) value.forEach((v, i) => bigintPaths(v, `${path}[${i}]`, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) bigintPaths(v, `${path}.${k}`, out);
  }
  return out;
}

/** Promote every integer leaf to `bigint`, as an RPC layer widening u64s would. */
function widenIntegers(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(widenIntegers);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = widenIntegers(v);
    return out;
  }
  return value;
}

const ADDRESSES = [AGENT, ATTACKER, HOLDER, AGENT_USDC_ATA, OTHER_ATA, USDC, WSOL];
const PROGRAMS = [TOKEN_PROGRAM, SYSTEM_PROGRAM, UNKNOWN_PROGRAM];
const SIGNATURE =
  '4sozofKWzt8vLXHTWQpYS4PSduqvaC8C8ADVHnE4Sbi26j7QcgYF41Bs2pbRtSVNBbk73KBseSUksHS7XLZXSHw9';

const addr = fc.constantFrom(...ADDRESSES);
const program = fc.constantFrom(...PROGRAMS);

/** u64-shaped, including values past the double's integer ceiling. */
const u64 = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0, max: 2 ** 40 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 1, Number.MAX_SAFE_INTEGER) },
);

/** `meta.err` — free-form by design, and it lands verbatim in a hashed bundle. */
const rpcErr = fc.oneof(
  fc.constant(null),
  fc.constant({ InstructionError: [0, 'InvalidAccountData'] }),
  fc.record({
    InstructionError: fc.tuple(fc.integer({ min: 0, max: 8 }), fc.record({ Custom: u64 })),
  }),
  fc.constant({ InsufficientFundsForRent: { account_index: 1 } }),
);

const parsedIx = fc.record({
  program: fc.constantFrom('spl-token', 'system'),
  programId: program,
  parsed: fc.record({
    type: fc.constantFrom('transfer', 'transferChecked', 'setAuthority', 'closeAccount', 'approve'),
    info: fc.record({
      source: addr,
      destination: addr,
      authority: addr,
      amount: u64.map(String),
      // A nested integer inside a free-form field bag: the shape `plainJson`
      // exists for, and the one a field-by-field converter always misses.
      tokenAmount: fc.record({ amount: u64.map(String), decimals: fc.integer({ min: 0, max: 9 }) }),
    }),
  }),
});

const opaqueIx = fc.record({
  programId: program,
  accounts: fc.array(addr, { minLength: 0, maxLength: 4 }),
  data: fc.constant('3Bxs4h24hBtQy9rw'),
  stackHeight: fc.integer({ min: 1, max: 3 }),
});

const anyIx = fc.oneof(parsedIx, opaqueIx);

const tokenBalance = fc.record({
  accountIndex: fc.integer({ min: 0, max: 5 }),
  mint: fc.constantFrom(USDC, WSOL),
  owner: addr,
  programId: fc.constant(TOKEN_PROGRAM),
  uiTokenAmount: fc.record({
    amount: u64.map(String),
    decimals: fc.integer({ min: 0, max: 9 }),
    uiAmount: fc.double({ min: 0, max: 1e6, noNaN: true }),
    uiAmountString: fc.constant('0'),
  }),
});

/** A `jsonParsed` transaction as the wire carries it. */
const kitTransaction = fc.record({
  slot: u64,
  blockTime: fc.oneof(fc.constant(null), u64),
  version: fc.constantFrom(0, 'legacy'),
  meta: fc.record({
    err: rpcErr,
    status: fc.constant({ Ok: null }),
    fee: u64,
    computeUnitsConsumed: u64,
    preBalances: fc.array(u64, { minLength: 1, maxLength: 6 }),
    postBalances: fc.array(u64, { minLength: 1, maxLength: 6 }),
    preTokenBalances: fc.array(tokenBalance, { maxLength: 4 }),
    postTokenBalances: fc.array(tokenBalance, { maxLength: 4 }),
    innerInstructions: fc.array(
      fc.record({
        index: fc.integer({ min: 0, max: 3 }),
        instructions: fc.array(anyIx, { maxLength: 3 }),
      }),
      { maxLength: 3 },
    ),
    logMessages: fc.array(fc.constantFrom('Program log: ok', 'Program consumed 1 units'), {
      maxLength: 3,
    }),
    loadedAddresses: fc.constant({ readonly: [], writable: [] }),
    rewards: fc.constant([]),
  }),
  transaction: fc.record({
    signatures: fc.constant([SIGNATURE]),
    message: fc.record({
      accountKeys: fc.array(
        fc.record({
          pubkey: addr,
          signer: fc.boolean(),
          writable: fc.boolean(),
          source: fc.constant('transaction'),
        }),
        { minLength: 1, maxLength: 6 },
      ),
      instructions: fc.array(anyIx, { minLength: 1, maxLength: 4 }),
      recentBlockhash: fc.constant('11111111111111111111111111111111'),
    }),
  }),
});

describe('INV-BOUND-01 — getParsedTransaction hands back no bigint', () => {
  it('holds for every generated kit-shaped transaction, however widened', async () => {
    await fc.assert(
      fc.asyncProperty(kitTransaction, async (tx) => {
        const view = await readerReturning(widenIntegers(tx)).getParsedTransaction(SIGNATURE);

        expect(view).not.toBeNull();
        expect(bigintPaths(view)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('produces a RawTxView that canonicalises and hashes', async () => {
    // The consequence, not the type. `canonicalize` is `JSON.stringify`, which
    // throws on a bigint — so a leak turns into a swallowed evidence write and
    // a claim that can never be settled on a proven path.
    await fc.assert(
      fc.asyncProperty(kitTransaction, async (tx) => {
        const view = await readerReturning(widenIntegers(tx)).getParsedTransaction(SIGNATURE);
        const raw = toRawTxView(view!, SIGNATURE);

        expect(bigintPaths(raw)).toEqual([]);
        expect(() => canonicalize(raw)).not.toThrow();
        expect(bundleHash({ view: raw } as unknown as Record<string, unknown>)).toMatch(
          /^[0-9a-f]{64}$/,
        );
      }),
      { numRuns: 200 },
    );
  });

  it('gives toRawTxView the field types it reads without coercion', async () => {
    // `toRawTxView` copies `slot`, `blockTime` and `err` through untouched and
    // only coerces `fee` and the balance arrays. Those three are therefore the
    // fields where a reader-side leak survives all the way into the bundle.
    await fc.assert(
      fc.asyncProperty(kitTransaction, async (tx) => {
        const view = await readerReturning(widenIntegers(tx)).getParsedTransaction(SIGNATURE);
        const raw = toRawTxView(view!, SIGNATURE);

        expect(raw.slot === null || typeof raw.slot === 'number').toBe(true);
        expect(raw.blockTime === null || typeof raw.blockTime === 'number').toBe(true);
        expect(bigintPaths(raw.err)).toEqual([]);
        for (const key of raw.accountKeys) expect(typeof key.pubkey).toBe('string');
        for (const b of [...raw.preBalances, ...raw.postBalances]) expect(typeof b).toBe('number');
        for (const s of [...raw.preTokenBalances, ...raw.postTokenBalances]) {
          expect(typeof s.amountRaw).toBe('number');
          expect(typeof s.decimals).toBe('number');
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('INV-BOUND-02 — every other read method hands back no bigint', () => {
  it('getSlot and getBalanceAndSlot', async () => {
    expect(typeof (await readerReturning(380_000_000n).getSlot())).toBe('number');

    const balance = await readerReturning({
      context: { slot: 380_000_000n },
      value: 2_039_280n,
    }).getBalanceAndSlot(AGENT);

    expect(bigintPaths(balance)).toEqual([]);
    expect(balance).toEqual({ lamports: 2_039_280, slot: 380_000_000 });
  });

  it('getSignaturesForAddress, including a structured err', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            signature: fc.constant(SIGNATURE),
            slot: u64,
            err: rpcErr,
            memo: fc.constant(null),
            blockTime: fc.oneof(fc.constant(null), u64),
            confirmationStatus: fc.constantFrom('processed', 'confirmed', 'finalized'),
          }),
          { maxLength: 5 },
        ),
        async (entries) => {
          const out = await readerReturning(widenIntegers(entries)).getSignaturesForAddress(AGENT, {
            limit: 5,
          });

          expect(bigintPaths(out)).toEqual([]);
          expect(out).toHaveLength(entries.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getAccountInfo and getMultipleAccountsInfo', async () => {
    const value = {
      lamports: 2_039_280n,
      owner: TOKEN_PROGRAM,
      executable: false,
      rentEpoch: 18_446_744_073_709_551_615n,
      space: 165n,
      data: ['AQID', 'base64'],
    };

    const one = await readerReturning({ context: { slot: 1n }, value }).getAccountInfo(AGENT);
    expect(bigintPaths(one)).toEqual([]);
    expect(Buffer.isBuffer(one?.data)).toBe(true);

    const many = await readerReturning({
      context: { slot: 1n },
      value: [value, null],
    }).getMultipleAccountsInfo([AGENT, ATTACKER]);
    expect(bigintPaths(many)).toEqual([]);
    expect(many[1]).toBeNull();
  });

  it('getProgramAccounts', async () => {
    const out = await readerReturning([
      {
        pubkey: AGENT_USDC_ATA,
        account: {
          lamports: 2_039_280n,
          owner: TOKEN_PROGRAM,
          executable: false,
          rentEpoch: 250n,
          space: 165n,
          data: ['AQID', 'base64'],
        },
      },
    ]).getProgramAccounts(TOKEN_PROGRAM, 'ViN9hevUmiF');

    expect(bigintPaths(out)).toEqual([]);
    expect(typeof out.accounts[0]!.account.lamports).toBe('number');
  });

  it('getParsedTokenAccountsByOwner', async () => {
    const out = await readerReturning({
      context: { slot: 1n },
      value: [
        {
          pubkey: AGENT_USDC_ATA,
          account: {
            lamports: 2_039_280n,
            owner: TOKEN_PROGRAM,
            executable: false,
            rentEpoch: 250n,
            space: 165n,
            data: {
              program: 'spl-token',
              space: 165n,
              parsed: {
                type: 'account',
                info: {
                  mint: USDC,
                  owner: AGENT,
                  state: 'frozen',
                  tokenAmount: { amount: '123456789', decimals: 6, uiAmount: 123.456789 },
                },
              },
            },
          },
        },
      ],
    }).getParsedTokenAccountsByOwner(AGENT, { programId: TOKEN_PROGRAM });

    expect(bigintPaths(out)).toEqual([]);
    // `decimals` must stay a number and stay distinguishable from absent: it
    // feeds `readAgentBalances`, which writes it to the snapshot table and
    // into every governance exposure figure.
    expect(out.accounts[0]).toEqual({
      pubkey: AGENT_USDC_ATA,
      mint: USDC,
      owner: AGENT,
      amount: '123456789',
      decimals: 6,
      state: 'frozen',
    });
  });

  it('getBlockAccounts', async () => {
    const out = await readerReturning(
      widenIntegers({
        blockhash: '11111111111111111111111111111111',
        previousBlockhash: '11111111111111111111111111111111',
        parentSlot: 379_999_999,
        blockHeight: 360_000_000,
        blockTime: 1_780_000_000,
        transactions: [
          {
            transaction: {
              signatures: [SIGNATURE],
              accountKeys: [{ pubkey: AGENT, signer: true, writable: true, source: 'transaction' }],
            },
            meta: { err: null, fee: 5000, status: { Ok: null } },
          },
        ],
      }),
    ).getBlockAccounts(380_000_000);

    expect(bigintPaths(out)).toEqual([]);
    expect(out!.transactions[0]!.meta!.fee).toBe(5000);
  });
});

describe('INV-BOUND-03 — a read failure is an error, never an empty answer', () => {
  it('rethrows naming every endpoint rather than answering null', async () => {
    const pool = new CovanticRpcPool({
      primaryUrl: 'https://a.example.test',
      fallbackUrls: 'https://b.example.test',
      transportFactory: (url) =>
        (async () => {
          throw new Error(url.includes('a.') ? 'quota exceeded' : 'timeout');
        }) as unknown as RpcTransport,
    });
    const reader = new SolanaReader(pool);

    // Absence and outage must not collapse: `getAccountInfo` returns null for
    // an account that does not exist, and throws for one it could not read.
    await expect(reader.getAccountInfo(AGENT)).rejects.toThrow(/all RPC endpoints failed/);
    await expect(reader.getParsedTransaction(SIGNATURE)).rejects.toThrow(/quota exceeded/);
    await expect(reader.getSignaturesForAddress(AGENT)).rejects.toThrow(/timeout/);
    await expect(reader.getSlot()).rejects.toThrow(/getSlot:/);
  });

  it('reports a genuinely absent account as null, not as a failure', async () => {
    const reader = readerReturning({ context: { slot: 1n }, value: null });

    expect(await reader.getAccountInfo(AGENT)).toBeNull();
  });

  it('reports an unindexed transaction as null, not as a failure', async () => {
    expect(await readerReturning(null).getParsedTransaction(SIGNATURE)).toBeNull();
  });
});
