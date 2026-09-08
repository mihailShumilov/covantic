import { and, eq, gte } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import {
  canonicalMint,
  isStableMint,
  lookupMint,
  NATIVE_SOL_PSEUDO_MINT,
  WRAPPED_SOL_MINT,
} from '@covantic/shared';
import type { Database } from '../config/database.js';
import { agentOutflowEvents } from '../db/schema.js';
import { FEED_IDS } from './oracle/price-sources/pyth-hermes.js';
import { CAP_HEADROOM_MULTIPLE } from './envelope-derivation.js';

/**
 * The asset an oracle-manipulation claim on a policy may be priced against,
 * as the oracle attests it and `create_policy` copies it into
 * `PolicyPriceTerms`.
 *
 * Derived, never chosen — by the holder or by the oracle at settlement. The
 * settlement instruction used to take the feed, the decimals and the quantity
 * from the oracle's own evidence and check them only against each other, so
 * a compromised oracle key could pick any genuine feed that had moved,
 * assert a position in it, and produce a loss bound that reached the
 * coverage for an asset the agent never touched. Fixing the terms at
 * purchase, from the agent's own record, is what closes that: the feed has
 * to be one the agent actually trades, and the quantity has to be in
 * proportion to what it actually moves.
 */
export interface AttestedPriceTermsInput {
  /** Pyth feed id, 32 bytes. All zero when the agent has no priced habit. */
  feedId: Uint8Array;
  subjectMint: PublicKey;
  subjectDecimals: number;
  /** Largest subject quantity a claim may assert, raw base units. */
  maxSubjectQuantity: bigint;
}

/** What `upsert_attestation` receives when there is nothing to price. */
export function emptyPriceTerms(): AttestedPriceTermsInput {
  return {
    feedId: new Uint8Array(32),
    subjectMint: PublicKey.default,
    subjectDecimals: 0,
    maxSubjectQuantity: 0n,
  };
}

export function isEmptyPriceTerms(terms: AttestedPriceTermsInput): boolean {
  return terms.feedId.every((b) => b === 0);
}

export interface SubjectObservation {
  mint: string;
  amountRaw: number;
  decimals: number;
}

/**
 * Pick the subject asset from what the agent has moved.
 *
 * Pure. The candidates are the non-stable mints the registry can price; the
 * one the agent moved most often is the habit worth insuring, and the largest
 * single movement in it — with the same headroom the envelope cap gets —
 * bounds what a claim may say was at stake. An agent with no priced habit
 * gets empty terms, and its oracle-manipulation claims go to a reviewer
 * rather than to an instruction that would have to take the asset on the
 * oracle's word.
 */
export function derivePriceTerms(observations: SubjectObservation[]): AttestedPriceTermsInput {
  const byMint = new Map<
    string,
    { count: number; largestRaw: number; decimals: number; feedKey: string }
  >();

  for (const o of observations) {
    if (!(o.amountRaw > 0)) continue;
    const mint = canonicalMint(o.mint);
    if (isStableMint(mint)) continue;
    const meta = lookupMint(mint);
    if (!meta || meta.kind !== 'priced' || !meta.feedKey || !FEED_IDS[meta.feedKey]) continue;
    // Registry decimals are authoritative; a recorded decimals that disagrees
    // is a scaling error waiting to happen, and the registry has been checked
    // against chain.
    const entry = byMint.get(mint) ?? {
      count: 0,
      largestRaw: 0,
      decimals: meta.decimals,
      feedKey: meta.feedKey,
    };
    entry.count += 1;
    entry.largestRaw = Math.max(entry.largestRaw, o.amountRaw);
    byMint.set(mint, entry);
  }

  let chosen: {
    mint: string;
    count: number;
    largestRaw: number;
    decimals: number;
    feedKey: string;
  } | null = null;
  for (const [mint, entry] of byMint) {
    if (
      chosen === null ||
      entry.count > chosen.count ||
      (entry.count === chosen.count && mint < chosen.mint)
    ) {
      chosen = { mint, ...entry };
    }
  }
  if (!chosen) return emptyPriceTerms();

  const feedHex = FEED_IDS[chosen.feedKey]!;
  // The registry folds wrapped SOL onto a pseudo-mint for valuation; the
  // account the program records has to be a real mint.
  const onChainMint = chosen.mint === NATIVE_SOL_PSEUDO_MINT ? WRAPPED_SOL_MINT : chosen.mint;
  return {
    feedId: Uint8Array.from(Buffer.from(feedHex, 'hex')),
    subjectMint: new PublicKey(onChainMint),
    subjectDecimals: chosen.decimals,
    maxSubjectQuantity: BigInt(Math.round(chosen.largestRaw * CAP_HEADROOM_MULTIPLE)),
  };
}

/** Load the agent's recent movements and derive its price terms. */
export async function loadPriceTerms(
  db: Database,
  agentAddress: string,
  now: Date,
  windowSeconds: number,
): Promise<AttestedPriceTermsInput> {
  const since = new Date(now.getTime() - windowSeconds * 1000);
  const rows = await db
    .select({
      mint: agentOutflowEvents.mint,
      amountRaw: agentOutflowEvents.amountRaw,
      decimals: agentOutflowEvents.decimals,
    })
    .from(agentOutflowEvents)
    .where(
      and(
        eq(agentOutflowEvents.agentAddress, agentAddress),
        gte(agentOutflowEvents.blockTime, since),
      ),
    );
  return derivePriceTerms(rows);
}

/** The shape the Anchor client serialises for `AttestedPriceTerms`. */
export function priceTermsToInstructionArg(terms: AttestedPriceTermsInput): {
  feedId: number[];
  subjectMint: PublicKey;
  subjectDecimals: number;
  maxSubjectQuantity: bigint;
} {
  return {
    feedId: Array.from(terms.feedId),
    subjectMint: terms.subjectMint,
    subjectDecimals: terms.subjectDecimals,
    maxSubjectQuantity: terms.maxSubjectQuantity,
  };
}
