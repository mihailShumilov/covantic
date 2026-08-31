import { address, signature, type Rpc, type SolanaRpcApi } from '@solana/kit';
import { CovanticRpcPool, describeRpcFailure, type RpcPoolStatus } from '../config/rpc-pool.js';
import { logger } from './logger.js';

/**
 * The read side of the chain, as this service actually uses it.
 *
 * Every RPC read used to take a web3.js-v1 `Connection` threaded through the
 * detection code. That made the endpoint a parameter of the *evidence* paths
 * and left the whole system behind one provider's quota. This is the seam:
 * detection asks a reader for facts, and the reader decides which of several
 * endpoints answers.
 *
 * ## Invariants
 *
 * - **Nothing web3.js-shaped crosses this boundary.** Callers get plain
 *   numbers, strings and `Buffer`s. `@solana/kit` returns `bigint` for every
 *   u64 the JSON-RPC emits; letting those reach the verifiers would change the
 *   canonical JSON that evidence bundles are hashed over, and silently break
 *   `pnpm claim:replay` against stored verdicts.
 * - **The shapes reproduce v1 exactly**, down to `err` carrying plain numbers
 *   and `data` arriving as a `Buffer`. This layer is a swap of transport, not
 *   a change of what detection sees.
 * - **A read failure is an error, never an empty answer.** "The RPC did not
 *   answer" and "the chain says nothing happened" are different facts, and the
 *   verifiers rely on the difference: the first retries, the second closes a
 *   claim. Callers keep their own try/catch and their own `null` semantics.
 * - **Writes do not belong here.** Sending and confirming stay on the v1
 *   `Connection` against the primary endpoint. Failing a send over to a second
 *   endpoint risks a transaction landing twice.
 */

/** Both SPL token programs, as the balance readers need them. */
export const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ADDRESS = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface AccountInfoView {
  lamports: number;
  owner: string;
  executable: boolean;
  data: Buffer;
}

export interface SignatureView {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  memo: string | null;
  confirmationStatus: string | null;
}

export interface ParsedTokenAccountView {
  pubkey: string;
  mint: string;
  owner: string;
  /** Raw base-unit amount as the RPC reports it — a string, so never lossy. */
  amount: string;
  /**
   * Null only when the RPC omitted it. Zero is a legitimate value — a
   * 0-decimals mint — so the two must stay distinguishable or every such
   * balance would silently take a registry default instead.
   */
  decimals: number | null;
  /** `initialized`, `frozen`, … as reported by the token program. */
  state: string | null;
}

/** One side's reading of a token account, as `meta.pre/postTokenBalances`. */
export interface ParsedTokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}

/**
 * A `jsonParsed` transaction with every u64 brought down to `number`.
 *
 * Structurally what web3.js v1's `ParsedTransactionWithMeta` was, described
 * loosely on purpose: `toRawTxView` is the only consumer and it already reads
 * every field defensively.
 */
export interface ParsedTransactionView {
  slot: number | null;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: ParsedTokenBalanceEntry[];
    postTokenBalances?: ParsedTokenBalanceEntry[];
    innerInstructions?: Array<{ index: number; instructions?: unknown[] }>;
    logMessages?: string[];
  } | null;
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string; signer?: boolean; writable?: boolean }>;
      instructions: unknown[];
    };
  } | null;
}

/**
 * One transaction of a block fetched with `transactionDetails: 'accounts'`.
 *
 * `accountKeys` entries are plain strings under some encodings and
 * `{ pubkey }` objects under others, so both are admitted rather than assumed.
 */
export interface AccountsOnlyBlockTx {
  transaction?: {
    signatures?: string[];
    accountKeys?: Array<string | { pubkey?: unknown }>;
  };
  meta?: { err?: unknown; fee?: number } | null;
}

export interface SignaturesOptions {
  limit?: number;
  /** Walk backwards from this signature (exclusive). */
  before?: string;
  /** Stop when this signature is reached (exclusive). */
  until?: string;
}

/**
 * Bring a JSON-RPC integer down to `number`, the way web3.js v1 did.
 *
 * v1 parsed responses with `JSON.parse`, so every u64 already arrived as a
 * double and the same precision ceiling has always applied. Keeping the
 * behaviour identical matters more than widening it here — a slot or lamport
 * value that changed type would ripple into stored evidence. The warning
 * exists so the ceiling is observable rather than silent.
 */
function toNumber(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
    logger.warn({ value: value.toString() }, 'solana-reader: integer exceeds safe range');
  }
  return Number(value);
}

function toNullableNumber(value: bigint | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return toNumber(value);
}

/**
 * Recursively replace `bigint` with `number` inside an RPC payload.
 *
 * Used where the payload is passed on wholesale rather than field by field —
 * `err` objects and parsed instruction data, which are free-form by design and
 * whose exact shape ends up in a hashed evidence bundle.
 */
function plainJson<T>(value: T): T {
  if (typeof value === 'bigint') return toNumber(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => plainJson(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = plainJson(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Re-throw a pool failure as one error that names every endpoint tried.
 *
 * The kit's `AllEndpointsFailedError` carries the per-endpoint causes on a
 * field, not in its message, and callers log `err.message`. Without this the
 * logs say "all endpoints failed" and nothing about why any of them did.
 */
function rethrow(op: string, err: unknown): never {
  const error = new Error(`${op}: ${describeRpcFailure(err)}`);
  (error as { cause?: unknown }).cause = err;
  throw error;
}

/** Decode one `getAccountInfo` value. Shared, so the two paths cannot drift. */
function toAccountInfoView(value: unknown): AccountInfoView | null {
  if (!value) return null;
  const account = value as {
    data: [string, string];
    lamports: bigint;
    owner: string;
    executable: boolean;
  };
  const [encoded] = account.data;
  return {
    lamports: toNumber(account.lamports),
    owner: String(account.owner),
    executable: Boolean(account.executable),
    data: Buffer.from(encoded, 'base64'),
  };
}

/**
 * Do two endpoints describe the same account?
 *
 * `data` is compared byte-for-byte because that is what gets decoded into a
 * holder's declaration. `lamports` is deliberately **not** compared: it moves
 * with rent-exemption top-ups and is not read by anything that decides a
 * claim, so including it would manufacture disagreements.
 */
function sameAccount(a: AccountInfoView | null, b: AccountInfoView | null): boolean {
  if (a === null || b === null) return a === b;
  return a.owner === b.owner && a.executable === b.executable && a.data.equals(b.data);
}

export class SolanaReader {
  private readonly rpc: Rpc<SolanaRpcApi>;

  constructor(private readonly pool: CovanticRpcPool) {
    this.rpc = pool.rpc;
  }

  /** Per-endpoint health, for `/api/health/rpc`. */
  status(): RpcPoolStatus {
    return this.pool.status();
  }

  async getSlot(): Promise<number> {
    try {
      return toNumber(await this.rpc.getSlot({ commitment: 'confirmed' }).send());
    } catch (err) {
      rethrow('getSlot', err);
    }
  }

  /**
   * An address's lamports together with the slot the reading is true at.
   *
   * The pair is the point: a balance without the slot it was read at cannot
   * anchor a "before", and the exploit checkpoint is exactly a before.
   */
  async getBalanceAndSlot(addr: string): Promise<{ lamports: number; slot: number }> {
    try {
      const res = await this.rpc.getBalance(address(addr), { commitment: 'confirmed' }).send();
      return { lamports: toNumber(res.value), slot: toNumber(res.context.slot) };
    } catch (err) {
      rethrow('getBalance', err);
    }
  }

  async getBalance(addr: string): Promise<number> {
    return (await this.getBalanceAndSlot(addr)).lamports;
  }

  /**
   * Every token account an owner holds under one token program, or of one mint.
   *
   * Returned flat: the caller wants mint, amount and freeze state, and making
   * it dig through `account.data.parsed.info` was only ever an artefact of the
   * RPC's envelope.
   */
  async getParsedTokenAccountsByOwner(
    owner: string,
    filter: { programId?: string; mint?: string },
  ): Promise<{ accounts: ParsedTokenAccountView[]; slot: number }> {
    const scope = filter.programId
      ? { programId: address(filter.programId) }
      : { mint: address(filter.mint as string) };
    try {
      const res = await this.rpc
        .getTokenAccountsByOwner(address(owner), scope, {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
        })
        .send();

      const out: ParsedTokenAccountView[] = [];
      for (const entry of res.value) {
        const info = (
          entry.account.data as unknown as {
            parsed?: {
              info?: {
                mint?: string;
                owner?: string;
                state?: string;
                tokenAmount?: { amount?: string; decimals?: number };
              };
            };
          }
        ).parsed?.info;
        if (!info?.mint || !info.tokenAmount?.amount) continue;
        out.push({
          pubkey: String(entry.pubkey),
          mint: info.mint,
          owner: info.owner ?? owner,
          amount: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals ?? null,
          state: info.state ?? null,
        });
      }
      // The context slot travels with the accounts. Three separately-routed
      // reads assembled into one "snapshot" and stamped with the first one's
      // slot is a reading that was never true at any single slot — and the
      // exploit checkpoint is exactly a claim about one slot.
      return { accounts: out, slot: toNumber(res.context.slot) };
    } catch (err) {
      rethrow('getTokenAccountsByOwner', err);
    }
  }

  async getSignaturesForAddress(
    addr: string,
    options: SignaturesOptions = {},
  ): Promise<SignatureView[]> {
    try {
      const res = await this.rpc
        .getSignaturesForAddress(address(addr), {
          commitment: 'confirmed',
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          ...(options.before === undefined ? {} : { before: signature(options.before) }),
          ...(options.until === undefined ? {} : { until: signature(options.until) }),
        })
        .send();

      return res.map((entry) => ({
        signature: String(entry.signature),
        slot: toNumber(entry.slot),
        blockTime: toNullableNumber(entry.blockTime),
        err: plainJson(entry.err ?? null),
        memo: entry.memo ?? null,
        confirmationStatus: entry.confirmationStatus ?? null,
      }));
    } catch (err) {
      rethrow('getSignaturesForAddress', err);
    }
  }

  /**
   * The same account read from two endpoints, required to agree.
   *
   * For most reads a single answer is fine: the four proof instructions
   * re-derive a payout from state the *program* reads, so no endpoint can
   * cause an overpayment. Rejection is the asymmetry. It is computed entirely
   * off chain, it is terminal, and its whole basis can be one endpoint's
   * answer — so a hostile or merely broken endpoint cannot take the vault's
   * money but can deny a holder theirs, which for an insurance protocol is the
   * loss the product exists to prevent.
   *
   * Two answers do not make a lie impossible; they make it cost two endpoints
   * instead of one, and turn a silent wrong verdict into a loud disagreement
   * that resolves to review. That is the whole claim being made here.
   *
   * Degrades honestly: with one usable endpoint there is nothing to compare
   * against, so the single answer is returned rather than the read failing.
   * The trust assumption then is what it was before the pool existed.
   */
  async getAccountInfoCorroborated(addr: string): Promise<AccountInfoView | null> {
    const endpoints = this.pool.corroboratingEndpoints().slice(0, 2);
    if (endpoints.length < 2) return this.getAccountInfo(addr);

    const [a, b] = await Promise.all(
      endpoints.map(async (endpoint) => {
        try {
          const res = await endpoint.rpc
            .getAccountInfo(address(addr), { encoding: 'base64', commitment: 'confirmed' })
            .send();
          return { name: endpoint.name, value: toAccountInfoView(res.value) };
        } catch (err) {
          // One endpoint failing is not a disagreement. Fall back to the
          // pool's own failover for the answer, and say so.
          logger.debug(
            { endpoint: endpoint.name, err: err instanceof Error ? err.message : err },
            'solana-reader: corroborating endpoint unavailable',
          );
          return { name: endpoint.name, value: undefined };
        }
      }),
    );

    if (a?.value === undefined || b?.value === undefined) return this.getAccountInfo(addr);

    if (!sameAccount(a.value, b.value)) {
      // Not `null`, and not one of the two answers. A disagreement about an
      // account that decides a claim is exactly the case the three-valued
      // contract exists for: it retries, then goes to a human.
      throw new Error(
        `getAccountInfo: endpoints disagree about ${addr} (${a.name} vs ${b.name}) — ` +
          'refusing to decide a claim on a contested read',
      );
    }
    return a.value;
  }

  /** Raw account bytes. `null` means the account does not exist, not an outage. */
  async getAccountInfo(addr: string): Promise<AccountInfoView | null> {
    try {
      const res = await this.rpc
        .getAccountInfo(address(addr), { encoding: 'base64', commitment: 'confirmed' })
        .send();
      return toAccountInfoView(res.value);
    } catch (err) {
      rethrow('getAccountInfo', err);
    }
  }

  /**
   * Several accounts in one call, in the order asked for.
   *
   * One request rather than N is the point: the staking view derives a live
   * accumulator delta from the staker and the vault, and reading them
   * separately can straddle a slot boundary and report a position that never
   * existed.
   */
  async getMultipleAccountsInfo(addrs: string[]): Promise<Array<AccountInfoView | null>> {
    if (addrs.length === 0) return [];
    try {
      const res = await this.rpc
        .getMultipleAccounts(
          addrs.map((a) => address(a)),
          { encoding: 'base64', commitment: 'confirmed' },
        )
        .send();
      return res.value.map((account) => {
        if (!account) return null;
        const [encoded] = account.data as unknown as [string, string];
        return {
          lamports: toNumber(account.lamports),
          owner: String(account.owner),
          executable: Boolean(account.executable),
          data: Buffer.from(encoded, 'base64'),
        };
      });
    } catch (err) {
      rethrow('getMultipleAccounts', err);
    }
  }

  /**
   * Every account a program owns whose data starts with `discriminatorBase58`.
   *
   * This is the shape Anchor's `.all()` takes, and it is by far the most
   * expensive call this service makes — providers weight `getProgramAccounts`
   * an order of magnitude above a `getBalance`. That is exactly why it belongs
   * on the pool rather than on one endpoint's quota.
   */
  async getProgramAccounts(
    programId: string,
    discriminatorBase58: string,
  ): Promise<{ accounts: Array<{ pubkey: string; account: AccountInfoView }>; slot: number }> {
    try {
      // The memcmp filter's `bytes` is a branded base58 string in kit's types
      // and a plain string on the wire; the cast is at the call, not spread
      // through the shape.
      const options = {
        encoding: 'base64',
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: 0n, bytes: discriminatorBase58, encoding: 'base58' } }],
      };
      const res = await this.rpc
        .getProgramAccounts(
          address(programId),
          options as unknown as Parameters<typeof this.rpc.getProgramAccounts>[1],
        )
        .send();

      const context = (res as unknown as { context?: { slot?: bigint } }).context;
      const accounts = (
        res as unknown as Array<{ pubkey: string; account: Record<string, unknown> }>
      ).map(
        (entry) => {
          const [encoded] = entry.account.data as unknown as [string, string];
          return {
            pubkey: String(entry.pubkey),
            account: {
              lamports: toNumber(entry.account.lamports as bigint),
              owner: String(entry.account.owner),
              executable: Boolean(entry.account.executable),
              data: Buffer.from(encoded, 'base64'),
            },
          };
        },
      );
      // The slot the whole listing was read at, so a consumer that mirrors
      // on-chain state into a database can refuse an answer older than the one
      // it already has. Without it a lagging endpoint silently reverts a
      // policy the chain has already moved on.
      return { accounts, slot: toNumber(context?.slot) };
    } catch (err) {
      rethrow('getProgramAccounts', err);
    }
  }

  /**
   * A parsed transaction, or `null` when the RPC does not have it.
   *
   * `null` is genuinely ambiguous here — an unindexed transaction and a
   * pruned one look identical — which is why every caller treats it as "could
   * not check" rather than "nothing happened".
   */
  async getParsedTransaction(sig: string): Promise<ParsedTransactionView | null> {
    try {
      const tx = await this.rpc
        .getTransaction(signature(sig), {
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        })
        .send();
      if (!tx) return null;
      return plainJson(tx) as unknown as ParsedTransactionView;
    } catch (err) {
      rethrow('getTransaction', err);
    }
  }

  /**
   * A block reduced to per-transaction account keys.
   *
   * `transactionDetails: 'accounts'` is a fraction of the payload of a full
   * block and carries everything the sandwich check reads. Historical blocks
   * fall out of standard RPC retention, so `null` here is routinely "too old",
   * not "no such block".
   */
  async getBlockAccounts(slot: number): Promise<{ transactions: AccountsOnlyBlockTx[] } | null> {
    try {
      const block = await this.rpc
        .getBlock(BigInt(slot) as Parameters<SolanaRpcApi['getBlock']>[0], {
          maxSupportedTransactionVersion: 0,
          transactionDetails: 'accounts',
          rewards: false,
          commitment: 'confirmed',
        })
        .send();
      if (!block) return null;
      return {
        transactions: plainJson(
          (block as unknown as { transactions?: unknown[] }).transactions ?? [],
        ) as AccountsOnlyBlockTx[],
      };
    } catch (err) {
      rethrow('getBlock', err);
    }
  }
}

/** Build the reader every service and worker shares. */
export function createSolanaReader(pool: CovanticRpcPool): SolanaReader {
  return new SolanaReader(pool);
}

let sharedReader: SolanaReader | null = null;
let sharedPool: CovanticRpcPool | null = null;

/**
 * The process-wide reader.
 *
 * One pool per process, not one per caller: the circuit breakers and the
 * health record only mean anything if every read shares them. A second pool
 * would keep hammering an endpoint the first one has already taken out of
 * rotation, which is most of the value gone.
 */
export function getSolanaReader(config: {
  SOLANA_RPC_URL: string;
  SOLANA_RPC_FALLBACK_URLS?: string;
  SOLANA_RPC_FRESHNESS_AWARE?: boolean;
}): SolanaReader {
  if (sharedReader) return sharedReader;
  sharedPool = new CovanticRpcPool({
    primaryUrl: config.SOLANA_RPC_URL,
    fallbackUrls: config.SOLANA_RPC_FALLBACK_URLS,
    freshnessAware: config.SOLANA_RPC_FRESHNESS_AWARE,
    // The one long-lived pool per process is where measuring freshness pays.
    probeSlots: true,
  });
  sharedReader = new SolanaReader(sharedPool);
  return sharedReader;
}

/**
 * Check every configured endpoint is on the cluster this deployment expects.
 *
 * Called once at boot, before anything reads. Separate from `getSolanaReader`
 * because it is asynchronous and because a process should fail to start on a
 * misconfigured primary rather than fail its first claim — see the note on
 * `CovanticRpcPool.verifyCluster`.
 */
export async function verifyReaderCluster(config: {
  SOLANA_RPC_URL: string;
  SOLANA_RPC_FALLBACK_URLS?: string;
  SOLANA_RPC_FRESHNESS_AWARE?: boolean;
  SOLANA_NETWORK: string;
}): Promise<void> {
  getSolanaReader(config);
  // `localnet` has a fresh genesis hash on every validator start, so there is
  // nothing to compare against.
  if (config.SOLANA_NETWORK === 'localnet') return;
  await sharedPool?.verifyCluster(config.SOLANA_NETWORK);
}
