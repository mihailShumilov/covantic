/**
 * Build the backtest corpus from Solana mainnet.
 *
 * Two jobs, both writing cassettes that the offline suite replays:
 *
 *   `incidents`  — fetch the transactions named in `incidents.json`, the
 *                  documented exploits, by signature.
 *   `negatives`  — sample ordinary mainnet transactions from blocks spread
 *                  across the chain's history, keeping the ones shaped like a
 *                  loss: a wallet that ended the transaction holding less than
 *                  it started with. Those are the transactions a detector is
 *                  most likely to be wrong about, and there is no shortage of
 *                  them, so the sample is drawn without looking at what the
 *                  pipeline says. Selecting on the verdict would turn the
 *                  false-positive rate into a statement about the sampler.
 *
 * Archival access: `getTransaction`, `getBlock` and `getBlockTime` all reach
 * long-term storage on the public endpoint, so no paid archival provider is
 * required to rebuild this corpus — only patience with the rate limit.
 *
 *   pnpm --filter api exec tsx scripts/backtest-fetch.ts incidents
 *   pnpm --filter api exec tsx scripts/backtest-fetch.ts negatives --per-block 20
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Cassette, CassettePricePoint, CassetteTx } from '../src/services/backtest/types.js';
import { defaultCexSources } from '../src/services/oracle/price-sources/cex.js';
import { PythHermesSource } from '../src/services/oracle/price-sources/pyth-hermes.js';
import type { PriceSource } from '../src/services/oracle/types.js';

const RPC = process.env.SOLANA_ARCHIVE_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const HERE = fileURLToPath(new URL('../tests/fixtures/incidents/', import.meta.url));
const CASSETTES = `${HERE}cassettes/`;

/** Feeds worth snapshotting: everything the mint registry can price. */
const FEEDS = ['SOL/USD', 'BTC/USD', 'ETH/USD', 'USDC/USD', 'USDT/USD'];

/** Public-endpoint courtesy. The corpus is built once and committed. */
const RPC_DELAY_MS = 400;

const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111';

/** A trimmed transaction over this many bytes is dropped rather than
 *  committed. Multi-hop aggregator routes run to hundreds of kilobytes and
 *  would dominate the corpus by size without adding a distinct shape. */
const MAX_CASSETTE_BYTES = 80_000;

interface IncidentSpec {
  slug: string;
  signature: string;
  /** What happened, and where it is written up. */
  note: string;
  source: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 6) {
      const wait = 2_000 * 2 ** attempt;
      console.error(`  rate limited, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    await sleep(RPC_DELAY_MS);
    return body.result as T;
  }
}

// ---------------------------------------------------------------------------
// Trimming
// ---------------------------------------------------------------------------

/**
 * Keep the evidence, drop the rest.
 *
 * `logMessages`, `rewards`, `returnData` and the compute meter are most of a
 * mainnet transaction's bytes and none of its evidence — nothing in the
 * pipeline reads them. Everything retained is something `toRawTxView` or the
 * enhanced-shape reconstruction actually looks at, so a cassette is a
 * complete input rather than a convenient subset.
 */
function trimTx(raw: Record<string, unknown>): CassetteTx | null {
  const tx = raw.transaction as
    | { signatures?: string[]; message?: { accountKeys?: unknown[]; instructions?: unknown[] } }
    | undefined;
  const meta = raw.meta as Record<string, unknown> | undefined;
  const keys = tx?.message?.accountKeys;
  if (!tx || !meta || !Array.isArray(keys)) return null;

  return {
    slot: Number(raw.slot ?? 0),
    blockTime: raw.blockTime === null || raw.blockTime === undefined ? null : Number(raw.blockTime),
    transaction: {
      signatures: (tx.signatures ?? []).slice(0, 1),
      message: {
        accountKeys: keys as CassetteTx['transaction']['message']['accountKeys'],
        instructions: (tx.message?.instructions ?? []) as unknown[],
      },
    },
    meta: {
      err: meta.err ?? null,
      fee: Number(meta.fee ?? 0),
      preBalances: (meta.preBalances as number[]) ?? [],
      postBalances: (meta.postBalances as number[]) ?? [],
      preTokenBalances: (meta.preTokenBalances as unknown[]) ?? [],
      postTokenBalances: (meta.postTokenBalances as unknown[]) ?? [],
      innerInstructions: (meta.innerInstructions as CassetteTx['meta']['innerInstructions']) ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const sources: PriceSource[] = [new PythHermesSource(), ...defaultCexSources()];
const priceCache = new Map<string, CassettePricePoint[]>();

/**
 * What every reference said at `unixTime`, as it said it.
 *
 * A source that has no data or cannot answer is simply absent from the
 * result. That is the same thing the live consensus sees when a source is
 * missing, so a replay inherits the real coverage of the moment rather than a
 * backfilled ideal of it — including the case where coverage is too thin to
 * decide, which the pipeline is supposed to route to review.
 */
async function pricesAt(unixTime: number): Promise<Record<string, CassettePricePoint[]>> {
  const bucket = Math.floor(unixTime / 60) * 60;
  const out: Record<string, CassettePricePoint[]> = {};

  for (const feed of FEEDS) {
    const key = `${feed}:${bucket}`;
    const cached = priceCache.get(key);
    if (cached) {
      if (cached.length > 0) out[feed] = cached;
      continue;
    }
    const points: CassettePricePoint[] = [];
    for (const source of sources) {
      try {
        const point = await source.priceAt(feed, unixTime);
        if (!point) continue;
        points.push({
          source: point.source,
          value: point.value,
          conf: point.conf,
          publishTime: point.publishTime,
          feedId: point.feedId,
        });
      } catch {
        // Unavailable is not data. Recorded by omission, like the live path.
      }
    }
    priceCache.set(key, points);
    if (points.length > 0) out[feed] = points;
  }
  return out;
}

async function buildCassette(
  signature: string,
  raw: Record<string, unknown>,
): Promise<Cassette | null> {
  const tx = trimTx(raw);
  if (!tx || tx.blockTime === null) return null;
  return {
    schema: 'covantic.backtest.cassette/1',
    signature,
    rpc: RPC,
    fetchedAt: new Date().toISOString(),
    prices: await pricesAt(tx.blockTime),
    tx,
  };
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

async function fetchIncidents(): Promise<void> {
  const specs = JSON.parse(readFileSync(`${HERE}incidents.json`, 'utf8')) as IncidentSpec[];
  mkdirSync(CASSETTES, { recursive: true });

  for (const spec of specs) {
    console.error(`incident ${spec.slug} ${spec.signature.slice(0, 16)}…`);
    const raw = await rpc<Record<string, unknown> | null>('getTransaction', [
      spec.signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
    if (!raw) {
      console.error(`  NOT FOUND — skipping`);
      continue;
    }
    const cassette = await buildCassette(spec.signature, raw);
    if (!cassette) {
      console.error('  unusable shape — skipping');
      continue;
    }
    writeFileSync(`${CASSETTES}${spec.slug}.json`, JSON.stringify(cassette, null, 1));
    const when = new Date((cassette.tx.blockTime ?? 0) * 1000).toISOString();
    console.error(`  ok — ${when}, ${Object.keys(cassette.prices).length} feeds priced`);
  }
}

// ---------------------------------------------------------------------------
// Negatives
// ---------------------------------------------------------------------------

/** First slot at or after `target` that long-term storage actually holds. */
async function slotAtTime(target: number): Promise<number> {
  let lo = 1;
  let hi = await rpc<number>('getSlot', []);

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let time: number | null = null;
    // Skipped slots have no block time; walk forward until one answers.
    for (let probe = mid; probe < mid + 8 && time === null; probe += 1) {
      try {
        time = await rpc<number | null>('getBlockTime', [probe]);
      } catch {
        time = null;
      }
    }
    if (time === null) {
      lo = mid + 8;
      continue;
    }
    if (time < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Did the fee payer end this transaction holding less than it started with? */
function hasOutflow(tx: CassetteTx): boolean {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const payer = keys[0];
  if (!payer) return false;

  const native = Number(tx.meta.postBalances?.[0] ?? 0) - Number(tx.meta.preBalances?.[0] ?? 0);
  // More than the fee: a transaction that only paid to exist is not a loss.
  if (native < -Number(tx.meta.fee ?? 0) * 2) return true;

  const before = new Map<string, number>();
  for (const b of (tx.meta.preTokenBalances ?? []) as Array<{
    accountIndex: number;
    owner?: string;
    mint: string;
    uiTokenAmount?: { amount?: string };
  }>) {
    if (b.owner !== payer) continue;
    before.set(`${b.mint}:${b.accountIndex}`, Number(b.uiTokenAmount?.amount ?? '0'));
  }
  for (const b of (tx.meta.postTokenBalances ?? []) as Array<{
    accountIndex: number;
    owner?: string;
    mint: string;
    uiTokenAmount?: { amount?: string };
  }>) {
    if (b.owner !== payer) continue;
    const key = `${b.mint}:${b.accountIndex}`;
    if (Number(b.uiTokenAmount?.amount ?? '0') < (before.get(key) ?? 0)) return true;
  }
  return false;
}

interface BlockTx {
  transaction?: { signatures?: string[] };
  meta?: Record<string, unknown> | null;
}

interface ParsedIxJson {
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}

const SPL_TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

function allInstructions(tx: CassetteTx): ParsedIxJson[] {
  return [
    ...(tx.transaction.message.instructions as ParsedIxJson[]),
    ...(tx.meta.innerInstructions ?? []).flatMap((g) => (g.instructions ?? []) as ParsedIxJson[]),
  ];
}

/**
 * Did value leave an account whose owner did not sign for it?
 *
 * This is the covered event stated as a property of the chain record alone:
 * a token account's owner is in `preTokenBalances[].owner`, the signers are
 * in `accountKeys[].signer`, and the moving authority is in the parsed
 * instruction. Every term is read off the transaction, so the label does not
 * come from the pipeline's opinion of the transaction.
 *
 * It is not a claim that a theft occurred — a lending protocol moving
 * collateral under a delegation the owner granted last week matches this
 * shape too, and the owner is not present to sign. That is the point: these
 * are the transactions where the authorization question is live, which makes
 * them the honest place to measure whether the pipeline answers it well,
 * rather than a set of cases already known to be crimes.
 *
 * The owner must also end the transaction holding *less* of the mint that
 * moved. Without that condition the rule catches a large amount of noise:
 * routing hops that return what they took, zero-amount authority probes, and
 * sub-dust rounding. Those are all authority mismatches, and none of them is
 * a loss, so `no_net_loss` is the correct verdict on them and including them
 * would only measure how well the pipeline dismisses cases the sampler
 * should not have selected.
 *
 * Returns the victim's owner address, or null when nothing matches.
 */
function unauthorisedOutflowVictim(tx: CassetteTx): string | null {
  const keys = tx.transaction.message.accountKeys;
  const signers = new Set(keys.filter((k) => k.signer).map((k) => k.pubkey));
  const ownerOf = new Map<string, string>();
  const mintOf = new Map<string, string>();
  for (const b of (tx.meta.preTokenBalances ?? []) as Array<{
    accountIndex: number;
    owner?: string;
    mint: string;
  }>) {
    const account = keys[b.accountIndex]?.pubkey;
    if (!account) continue;
    if (b.owner) ownerOf.set(account, b.owner);
    mintOf.set(account, b.mint);
  }

  // Net movement per (owner, mint), so a hop that gives back what it took
  // nets to zero and is not mistaken for a drain.
  const netByOwnerMint = new Map<string, number>();
  const accrue = (side: 'pre' | 'post', list: unknown[]) => {
    for (const b of list as Array<{
      accountIndex: number;
      owner?: string;
      mint: string;
      uiTokenAmount?: { amount?: string };
    }>) {
      if (!b.owner) continue;
      const amount = Number(b.uiTokenAmount?.amount ?? '0');
      if (!Number.isFinite(amount)) continue;
      const key = `${b.owner}:${b.mint}`;
      netByOwnerMint.set(key, (netByOwnerMint.get(key) ?? 0) + (side === 'pre' ? -amount : amount));
    }
  };
  accrue('pre', tx.meta.preTokenBalances ?? []);
  accrue('post', tx.meta.postTokenBalances ?? []);

  const lost = (owner: string, mint: string): boolean =>
    (netByOwnerMint.get(`${owner}:${mint}`) ?? 0) < 0;

  for (const ix of allInstructions(tx)) {
    if (!SPL_TOKEN_PROGRAMS.has(ix.programId ?? '')) continue;
    const type = ix.parsed?.type;
    const info = ix.parsed?.info ?? {};

    if (type === 'transfer' || type === 'transferChecked') {
      const source = String(info.source ?? '');
      const owner = ownerOf.get(source);
      const mint = mintOf.get(source);
      const authority = String(info.authority ?? info.multisigAuthority ?? '');
      if (!owner || !authority || !mint) continue;
      if (authority !== owner && !signers.has(owner) && lost(owner, mint)) return owner;
      continue;
    }

    if (type === 'setAuthority') {
      // A seizure moves no balance, so the loss test does not apply: the
      // owner keeps the tokens and loses the ability to move them.
      const account = String(info.account ?? '');
      const owner = ownerOf.get(account);
      const authority = String(info.authority ?? '');
      if (!owner || !authority) continue;
      if (authority !== owner && !signers.has(owner)) return owner;
    }
  }
  return null;
}

async function sampleNegatives(
  perBlock: number,
  eras: string[],
  blocksPerEra: number,
  maxOrdinary: number,
): Promise<void> {
  const ordinary: string[] = [];
  const unauthorised: string[] = [];

  const slots: Array<{ era: string; slot: number }> = [];
  for (const era of eras) {
    const target = Math.floor(new Date(era).getTime() / 1000);
    console.error(`era ${era} — locating slot…`);
    const first = await slotAtTime(target);
    console.error(`  slot ${first}`);
    // Consecutive slots rather than a wider spread: the point of more blocks
    // is more transactions, and a minute of mainnet is already a different
    // mix of programs than the minute before it.
    for (let i = 0; i < blocksPerEra; i += 1) slots.push({ era, slot: first + i });
  }

  for (const { era, slot } of slots) {
    const block = await rpc<{ transactions?: BlockTx[]; blockTime?: number } | null>('getBlock', [
      slot,
      {
        encoding: 'jsonParsed',
        transactionDetails: 'full',
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ]).catch(() => null);
    if (!block?.transactions) {
      console.error(`  ${era} slot ${slot}: no block — skipping`);
      continue;
    }
    const target = block.blockTime ?? Math.floor(new Date(era).getTime() / 1000);

    let kept = 0;
    for (const entry of block.transactions) {
      if (kept >= perBlock && ordinary.length >= maxOrdinary) break;
      const signature = entry.transaction?.signatures?.[0];
      if (!signature) continue;

      const tx = trimTx({ ...entry, slot, blockTime: block.blockTime });
      if (!tx) continue;

      const programs = new Set(
        (tx.transaction.message.instructions as Array<{ programId?: string }>).map(
          (ix) => ix.programId ?? '',
        ),
      );
      if (programs.has(VOTE_PROGRAM)) continue;

      const victim = unauthorisedOutflowVictim(tx);
      if (!victim && !hasOutflow(tx)) continue;

      const cassette: Cassette = {
        schema: 'covantic.backtest.cassette/1',
        signature,
        rpc: RPC,
        fetchedAt: new Date().toISOString(),
        prices: await pricesAt(tx.blockTime ?? target),
        subject: victim ?? tx.transaction.message.accountKeys[0]?.pubkey,
        shape: victim ? 'unauthorised-outflow' : 'ordinary-outflow',
        tx,
      };
      const line = JSON.stringify(cassette);
      if (line.length > MAX_CASSETTE_BYTES) continue;
      // Unauthorised outflows are scarce and never counted against the
      // per-block cap, or a busy block of ordinary swaps would crowd out the
      // one transaction worth the most.
      if (victim) {
        unauthorised.push(line);
      } else {
        if (kept >= perBlock || ordinary.length >= maxOrdinary) continue;
        ordinary.push(line);
        kept += 1;
      }
    }
    console.error(
      `  ${era} slot ${slot}: +${kept} ordinary (${ordinary.length}), ` +
        `${unauthorised.length} unauthorised`,
    );
  }

  writeFileSync(`${HERE}negatives.ndjson`, `${ordinary.join('\n')}\n`);
  if (unauthorised.length > 0) {
    writeFileSync(`${HERE}unauthorised.ndjson`, `${unauthorised.join('\n')}\n`);
  }
  console.error(
    `wrote ${ordinary.length} ordinary and ${unauthorised.length} unauthorised cassettes`,
  );
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? (rest[i + 1] ?? fallback) : fallback;
};

if (mode === 'incidents') {
  await fetchIncidents();
} else if (mode === 'negatives') {
  const eras = flag(
    'eras',
    [
      '2022-03-23T12:00:00Z',
      '2022-08-02T12:00:00Z',
      '2022-10-11T22:00:00Z',
      '2023-04-18T12:00:00Z',
      '2023-11-09T12:00:00Z',
      '2024-03-14T12:00:00Z',
      '2024-11-20T12:00:00Z',
      '2025-04-26T12:00:00Z',
      '2025-10-08T12:00:00Z',
      '2026-05-12T12:00:00Z',
    ].join(','),
  ).split(',');
  await sampleNegatives(
    Number(flag('per-block', '25')),
    eras,
    Number(flag('blocks-per-era', '3')),
    Number(flag('max-negatives', '300')),
  );
} else {
  console.error('usage: backtest-fetch.ts <incidents|negatives> [--per-block N] [--eras a,b,c]');
  process.exit(1);
}
