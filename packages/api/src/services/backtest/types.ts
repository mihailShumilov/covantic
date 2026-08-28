/**
 * Cassettes: real mainnet transactions, frozen so a verdict can be replayed
 * without a network.
 *
 * The corpora under `tests/fixtures/*-corpus.ts` are hand-built shapes. They
 * are good at one thing — pinning the specific ways the old verifiers were
 * wrong — and structurally bad at another: every field in them was written by
 * the same person who wrote the detector, so they cannot say anything about
 * transactions nobody imagined. A cassette is the opposite. It is a verbatim
 * `getTransaction` response from Solana mainnet, fetched by signature, and
 * nothing in it was chosen to make the pipeline look good.
 *
 * The file is deliberately close to the RPC's own shape rather than a
 * digested one. `toRawTxView` already reads plain JSON (it stringifies every
 * key instead of assuming web3.js objects), so the bytes that go into the
 * pipeline during a replay are the bytes the RPC returned, and anyone can
 * re-fetch the same signature and diff it.
 */

/** Only the fields the pipeline reads. See `trimTx` in `scripts/backtest-fetch.ts`
 *  for why the rest is dropped — logs and rewards are most of a mainnet
 *  transaction's bytes and none of its evidence. */
export interface CassetteTx {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean }>;
      instructions: unknown[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: unknown[];
    postTokenBalances?: unknown[];
    innerInstructions?: Array<{ index: number; instructions: unknown[] }>;
  };
}

/** One price observation as a source reported it, frozen at fetch time. */
export interface CassettePricePoint {
  source: string;
  value: number;
  conf: number;
  publishTime: number;
  feedId: string;
}

/**
 * A single frozen transaction plus the reference prices that were true when
 * it executed.
 *
 * The prices matter as much as the transaction. Valuing a 2022 drain at
 * today's SOL price is the same mistake the original verifier made in the
 * other direction, and it would quietly turn every historical case into
 * nonsense. So the fetcher pulls minute candles from the exchanges for the
 * transaction's own block time and stores them here.
 */
export interface Cassette {
  schema: 'covantic.backtest.cassette/1';
  signature: string;
  /** Where the transaction came from, so a re-fetch can be compared. */
  rpc: string;
  fetchedAt: string;
  /** Feed key -> observations from independent sources at `blockTime`. */
  prices: Record<string, CassettePricePoint[]>;
  /** The wallet the sampler selected to stand in for the insured agent.
   *  Absent on incident cassettes, where the manifest names the subject. */
  subject?: string;
  /**
   * What the sampler saw in the chain record, not what the pipeline concluded.
   *
   *  - `ordinary-outflow`: the fee payer ended up holding less. Nothing about
   *    it suggests anything other than someone spending their own money.
   *  - `unauthorised-outflow`: value left a token account whose owner is not
   *    among the signers and is not the moving authority.
   *
   * Both are read off `accountKeys[].signer`, `preTokenBalances[].owner` and
   * the parsed instruction, so either can be re-derived from the cassette and
   * neither depends on a verdict.
   */
  shape?: 'ordinary-outflow' | 'unauthorised-outflow';
  tx: CassetteTx;
}

/** What a replay is expected to produce, and why. Written by hand; never
 *  derived from a run, or the test would only ever confirm itself. */
export type CassetteExpectation =
  /** Must not confirm, whatever else it does. The hard gate. */
  | 'never-confirms'
  /** A documented incident whose loss the pipeline should see. */
  | 'detects'
  /** A documented incident outside the covered event definition. Recorded so
   *  the gap is a published number rather than an omission. */
  | 'out-of-scope';

export interface BacktestCase {
  /** Cassette file, relative to the incidents fixture directory. */
  cassette: string;
  /** The wallet replayed as if it held the policy. */
  subject: string;
  /** Trigger types to run this transaction through. */
  triggers: number[];
  expect: CassetteExpectation;
  /** Coverage the modelled policy carries, in USDC base units. */
  coverageRaw: number;
  /** Human note: for an incident, what happened and where it is documented. */
  why: string;
  /** Public write-up this case is drawn from, when there is one. */
  source?: string;
}
