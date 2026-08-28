/**
 * Mint registry for claim verification.
 *
 * Two jobs: map a mint to the reference feed that prices it, and record how
 * many decimals it uses. Every entry here has been checked against chain
 * (existence, owner program, decimals) — a wrong decimals value silently
 * mis-scales a loss by orders of magnitude, and a wrong feed prices one asset
 * against another's market.
 *
 * Extend cautiously and verify on chain first. A mint that is absent produces
 * an `indeterminate` verdict, which routes to review; a mint that is present
 * and wrong produces a confident payout for the wrong amount.
 */

/** Kind of price behaviour, which decides the fallback when a feed is silent. */
export type TokenKind = 'stable' | 'priced';

export interface TokenMeta {
  symbol: string;
  decimals: number;
  kind: TokenKind;
  /** Reference feed key, resolvable by the price sources. */
  feedKey: string | null;
}

/** Native SOL has no mint account. Balance-delta reconstruction uses this
 *  sentinel so native and wrapped SOL can be netted against each other. */
export const NATIVE_SOL_PSEUDO_MINT = 'SOL';

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

export const MINT_REGISTRY: Readonly<Record<string, TokenMeta>> = Object.freeze({
  // --- SOL and liquid staking derivatives ---------------------------------
  [NATIVE_SOL_PSEUDO_MINT]: { symbol: 'SOL', decimals: 9, kind: 'priced', feedKey: 'SOL/USD' },
  [WRAPPED_SOL_MINT]: { symbol: 'wSOL', decimals: 9, kind: 'priced', feedKey: 'SOL/USD' },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: {
    symbol: 'JitoSOL',
    decimals: 9,
    kind: 'priced',
    // LSTs trade above SOL by their accrued yield, so they need their own
    // feed — pricing JitoSOL off SOL/USD understates it by several percent
    // and would read as a permanent execution shortfall.
    feedKey: 'JITOSOL/USD',
  },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: {
    symbol: 'mSOL',
    decimals: 9,
    kind: 'priced',
    feedKey: 'MSOL/USD',
  },

  // --- Wrapped majors (Wormhole Portal) -----------------------------------
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': {
    symbol: 'wBTC',
    decimals: 8,
    kind: 'priced',
    feedKey: 'BTC/USD',
  },
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': {
    symbol: 'wETH',
    decimals: 8,
    kind: 'priced',
    feedKey: 'ETH/USD',
  },

  // --- Stables -------------------------------------------------------------
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    symbol: 'USDC',
    decimals: 6,
    kind: 'stable',
    feedKey: 'USDC/USD',
  },
  // A devnet mock USDC from an earlier deployment, kept because policies were
  // written against it. It is *not* necessarily the mint in use today —
  // `USDC_MINT` is, and `registerCoveredMint` is what makes that one
  // priceable. Same feed either way: a devnet mint has no market of its own,
  // and USDC/USD is the honest reference for what it stands in for.
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': {
    symbol: 'USDC-dev',
    decimals: 6,
    kind: 'stable',
    feedKey: 'USDC/USD',
  },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    symbol: 'USDT',
    decimals: 6,
    kind: 'stable',
    feedKey: 'USDT/USD',
  },
  // Token-2022 mint (owner TokenzQd...), unlike the others here.
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': {
    symbol: 'PYUSD',
    decimals: 6,
    kind: 'stable',
    feedKey: null,
  },
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: {
    symbol: 'USDS',
    decimals: 6,
    kind: 'stable',
    feedKey: null,
  },
});

/**
 * The covered mint this deployment actually uses, when it is not one of the
 * mints above.
 *
 * Every non-mainnet deployment mints its own mock USDC, and the address
 * changes whenever someone mints a fresh one. When the registry does not know
 * it, *nothing can be valued*: `lookupMint` returns null, the loss comes back
 * unpriced, and every exploit and agent-error claim stalls at
 * `position_not_valued` — permanently, because a retry re-reads the same
 * registry. A whole devnet deployment can look like a detection failure when
 * the only thing wrong is a mint nobody registered.
 *
 * Registering the configured mint closes that. It is sound rather than a
 * convenience: the covered mint is the unit the policy is denominated in, so
 * a deployment that treats it as anything other than a dollar stable is
 * already incoherent.
 */
let coveredMintOverride: { mint: string; meta: TokenMeta } | null = null;

/**
 * Declare the mint policies are denominated in, once, at startup.
 *
 * A no-op when the mint is already in {@link MINT_REGISTRY} — a real USDC
 * deployment keeps the registry's entry rather than shadowing it.
 */
export function registerCoveredMint(mint: string | undefined, decimals = 6): void {
  // Unset is a real configuration: a deployment that has not chosen a covered
  // mint has nothing to register, and silently inventing one would be worse
  // than leaving losses unpriceable.
  if (!mint || MINT_REGISTRY[mint]) return;
  coveredMintOverride = {
    mint,
    meta: { symbol: 'USDC-mock', decimals, kind: 'stable', feedKey: 'USDC/USD' },
  };
}

/** Registry lookup. Returns null for anything unregistered — callers must
 *  treat that as "cannot price", never as "worth nothing". */
export function lookupMint(mint: string): TokenMeta | null {
  if (coveredMintOverride?.mint === mint) return coveredMintOverride.meta;
  return MINT_REGISTRY[mint] ?? null;
}

/** True when a mint is a stable we are willing to fall back to par for if
 *  its feed has no sample at the moment in question. */
export function isStableMint(mint: string): boolean {
  return lookupMint(mint)?.kind === 'stable';
}

/** Collapse wrapped SOL onto native SOL so wrap/unwrap inside a route does
 *  not look like a separate leg of the trade. */
export function canonicalMint(mint: string): string {
  return mint === WRAPPED_SOL_MINT ? NATIVE_SOL_PSEUDO_MINT : mint;
}
