import { utils } from '@coral-xyz/anchor';
import type { CovanticProgram } from './program.js';
import { logger } from './logger.js';
import type { SolanaReader } from './solana-reader.js';

/**
 * Anchor account reads, over the endpoint pool.
 *
 * `program.account.X.fetch()` and `.all()` are convenient, but every one of
 * them goes through the provider's own `Connection` — a single endpoint, and
 * therefore a single quota. That is the same exposure the read migration
 * removed everywhere else, and it is worst here: `.all()` is a
 * `getProgramAccounts`, which providers weight an order of magnitude above an
 * ordinary read, and the policy indexer issues one every 60 seconds.
 *
 * So the account bytes come from {@link SolanaReader} and only the *decoding*
 * comes from Anchor. The program object is still the source of the layout —
 * nothing here hand-rolls a Borsh reader — but the network hop is the pool's.
 *
 * ## Invariants
 *
 * - **`null` means the account does not exist; an outage throws.** Anchor's
 *   `fetchNullable` draws the same line, and the declaration readers (mandate,
 *   governance baseline) depend on it: a missing declaration resolves a claim
 *   to review, while an unreadable one has to retry. Collapsing the two would
 *   turn an RPC hiccup into a verdict.
 * - **A declaration is read from two endpoints, not one** (`corroborate`).
 *   Absence there is what closes a claim, and reads now fan out across
 *   endpoints an operator listed but does not control. Two answers do not make
 *   a lie impossible; they make a silent wrong rejection into a loud
 *   disagreement that goes to a human.
 * - **A decode failure is not an absence either.** It means the deployed
 *   layout and the loaded IDL disagree — an orphan account from an earlier
 *   program, or a stale IDL — and it throws rather than reading as "no such
 *   account", which is how a redeploy would otherwise silently void every
 *   holder declaration on file.
 * - **Owner is checked before decode, on both paths.** Any account can be made
 *   to start with eight arbitrary bytes; without the check a look-alike
 *   account at a derived address would decode into a policy. On the `.all()`
 *   path `getProgramAccounts` is already owner-scoped, so the per-entry check
 *   is defence against a buggy endpoint rather than a hostile one — a hostile
 *   endpoint supplies the `owner` field in the same response as the data, so
 *   no check at this layer can bind it. That is a property of the transport,
 *   not of this module, and it is why a rejection must never rest on a single
 *   endpoint's answer.
 */

/** The coder surface Anchor exposes per account namespace. */
interface AccountCoder {
  coder: { accounts: { decode: (name: string, data: Buffer) => Record<string, unknown> } };
}

/**
 * The Anchor account namespace, keyed by the camelCase name Anchor generates.
 *
 * Reached through a cast because Anchor types the namespace from a statically
 * known IDL, and covantic loads its IDL from disk at runtime.
 */
function namespaceOf(ctx: CovanticProgram, account: string): AccountCoder {
  const ns = (ctx.program.account as unknown as Record<string, AccountCoder | undefined>)[account];
  if (!ns) {
    throw new Error(`anchor-reader: no account '${account}' in the loaded IDL`);
  }
  return ns;
}

/**
 * The 8-byte discriminator for an account, base58-encoded for a memcmp filter.
 *
 * Read from the IDL rather than recomputed from the account name: Anchor 0.30+
 * writes it there explicitly, and deriving it independently would be a second
 * source of truth that can disagree with the deployed program.
 */
export function accountDiscriminator(ctx: CovanticProgram, account: string): string {
  const idl = ctx.program.idl as unknown as {
    accounts?: Array<{ name: string; discriminator?: number[] }>;
  };
  const entry = idl.accounts?.find((a) => a.name.toLowerCase() === account.toLowerCase());
  if (!entry?.discriminator) {
    throw new Error(`anchor-reader: no discriminator for account '${account}' in the loaded IDL`);
  }
  return utils.bytes.bs58.encode(Buffer.from(entry.discriminator));
}

/**
 * One Anchor account, or `null` when it does not exist.
 *
 * The `fetchNullable` contract: absence is `null`, everything else throws.
 */
export async function fetchAnchorAccount<T = Record<string, unknown>>(
  ctx: CovanticProgram,
  reader: SolanaReader,
  account: string,
  address: string,
  options: { corroborate?: boolean } = {},
): Promise<T | null> {
  // `corroborate` is for accounts whose absence *closes* a claim — a holder's
  // declaration. There, one endpoint's answer is the entire basis for a
  // rejection, so it is read from two and they must agree.
  const info = options.corroborate
    ? await reader.getAccountInfoCorroborated(address)
    : await reader.getAccountInfo(address);
  if (!info) return null;

  const programId = ctx.programId.toBase58();
  if (info.owner !== programId) {
    throw new Error(
      `anchor-reader: ${account} at ${address} is owned by ${info.owner}, not ${programId}`,
    );
  }
  return namespaceOf(ctx, account).coder.accounts.decode(account, info.data) as T;
}

/**
 * Every account of one type the program owns — Anchor's `.all()`.
 *
 * A single account that fails to decode is dropped with a warning rather than
 * failing the sweep: the indexer's job is to mirror what it can read, and one
 * orphan from an earlier deployment must not stop every current policy from
 * being reconciled. An unreadable *RPC* still throws, because that is an
 * outage and reconciling against a partial view would look like accounts
 * disappearing.
 */
export async function fetchAllAnchorAccounts<T = Record<string, unknown>>(
  ctx: CovanticProgram,
  reader: SolanaReader,
  account: string,
): Promise<{ accounts: Array<{ publicKey: string; account: T }>; slot: number }> {
  const listing = await reader.getProgramAccounts(
    ctx.programId.toBase58(),
    accountDiscriminator(ctx, account),
  );

  const ns = namespaceOf(ctx, account);
  const programId = ctx.programId.toBase58();
  const out: Array<{ publicKey: string; account: T }> = [];
  for (const entry of listing.accounts) {
    // `getProgramAccounts` is owner-scoped, so this only fires when an
    // endpoint did not honour the filter it was given. Cheap, and it keeps the
    // two paths saying the same thing.
    if (entry.account.owner !== programId) {
      logger.warn(
        { account, pubkey: entry.pubkey, owner: entry.account.owner },
        'anchor-reader: endpoint returned an account the program does not own',
      );
      continue;
    }
    try {
      out.push({
        publicKey: entry.pubkey,
        account: ns.coder.accounts.decode(account, entry.account.data) as T,
      });
    } catch (err) {
      logger.warn(
        {
          account,
          pubkey: entry.pubkey,
          dataLen: entry.account.data.length,
          err: err instanceof Error ? err.message : String(err),
        },
        'anchor-reader: skipping an account that does not match the loaded IDL',
      );
    }
  }
  // The slot travels with the listing so a consumer mirroring this into a
  // database can refuse to overwrite a newer view with an older one.
  return { accounts: out, slot: listing.slot };
}
