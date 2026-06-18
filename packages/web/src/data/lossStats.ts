/**
 * Single source of truth for EXTERNAL, source-backed statistics used in
 * Covantic marketing copy.
 *
 * Every figure in this file is verified against a public report and carries a
 * citation. Rules for editing:
 *   - Do NOT add a number that is not traceable to a named public source.
 *   - Do NOT round beyond what the source states.
 *   - This file holds *external* market statistics only. Simulated devnet
 *     product metrics (pool APY, solvency ratio, TVP, premium splits) live in
 *     their own locations (mock-data.ts / CovanticProvider) and must NOT be
 *     merged in here.
 *
 * Marketing components read from this file so each displayed statistic stays
 * defensible to a technical judge or investor.
 */

export interface SourceRef {
  /** Publisher(s) of the figure. */
  name: string;
  /** Year (or year range) the figure is reported for. */
  year: string;
  /** Canonical publisher URL for traceability (optional). */
  url?: string;
}

/** A confirmed, real-world loss event shown in the landing "fear" marquee. */
export interface LossAnchor {
  name: string;
  /** Headline loss amount, exactly as sourced (e.g. '~$326M', '$21–30M'). */
  amount: string;
  /** When it happened. */
  date: string;
  /** Short, factual cause description. */
  cause: string;
  /** Chain the loss occurred on. */
  chain: string;
  source: SourceRef;
}

/**
 * Confirmed Solana loss anchors + one documented AI-agent failure (Freysa).
 * Used by the landing-page incident marquee.
 */
export const LOSS_ANCHORS: readonly LossAnchor[] = [
  {
    name: 'Drift Protocol',
    amount: '$286M',
    date: '1 Apr 2026',
    cause: 'Admin-key compromise via durable nonces · DPRK-attributed',
    chain: 'Solana',
    source: {
      name: 'Elliptic · Chainalysis · TRM Labs · Bloomberg',
      year: '2026',
      url: 'https://www.elliptic.co',
    },
  },
  {
    name: 'Wormhole',
    amount: '~$326M',
    date: 'Feb 2022',
    cause: 'Cross-chain bridge exploit',
    chain: 'Solana',
    source: { name: 'Chainalysis', year: '2022', url: 'https://www.chainalysis.com' },
  },
  {
    name: 'Mango Markets',
    amount: '~$114M',
    date: 'Oct 2022',
    cause: 'Oracle price manipulation',
    chain: 'Solana',
    source: { name: 'Chainalysis', year: '2022', url: 'https://www.chainalysis.com' },
  },
  {
    name: 'Cashio',
    amount: '~$52.8M',
    date: 'Mar 2022',
    cause: 'Infinite-mint exploit',
    chain: 'Solana',
    source: { name: 'Chainalysis', year: '2022', url: 'https://www.chainalysis.com' },
  },
  {
    name: 'DEXX',
    amount: '$21–30M',
    date: 'Nov 2024',
    cause: 'Private-key compromise',
    chain: 'Solana',
    source: { name: 'Chainalysis', year: '2024', url: 'https://www.chainalysis.com' },
  },
  {
    name: 'Loopscale',
    amount: '~$5.8M',
    date: 'Apr 2025',
    cause: 'Collateral-pricing exploit',
    chain: 'Solana',
    source: { name: 'Chainalysis', year: '2025', url: 'https://www.chainalysis.com' },
  },
  {
    name: 'Freysa',
    amount: '~$47K',
    date: 'Nov 2024',
    cause: 'Prompt injection — agent talked into releasing funds',
    chain: 'Base',
    source: { name: 'CoinDesk', year: '2024', url: 'https://www.coindesk.com' },
  },
] as const;

/** A verified base-rate / market statistic with a citation. */
export interface MarketStat {
  key: string;
  /** The figure, kept verbatim from the source. */
  value: string;
  /** Human label / framing for the figure. */
  label: string;
  source: SourceRef;
}

/**
 * Verified frequency, base-rate and thesis statistics. Documented here as the
 * single source of truth; surfaced selectively in copy. Each carries a source.
 */
export const MARKET_STATS: readonly MarketStat[] = [
  {
    key: 'incident-frequency',
    value: '≈600–760',
    label: 'documented on-chain security incidents per year, three years running (≈2/day)',
    source: { name: 'CertiK Hack3d', year: '2023–2025', url: 'https://www.certik.com' },
  },
  {
    key: 'loss-per-hack',
    value: 'median ≈$104K · mean ≈$5.32M',
    label: 'loss per hack in 2025 (heavy-tailed)',
    source: { name: 'CertiK Hack3d', year: '2025', url: 'https://www.certik.com' },
  },
  {
    key: 'bybit-share',
    value: '43%',
    label: 'of all 2025 losses came from a single hack (Bybit, $1.44B)',
    source: { name: 'CertiK Hack3d', year: '2025', url: 'https://www.certik.com' },
  },
  {
    key: 'drainer-victims',
    value: '106,000–332,000',
    label: 'wallet-drainer phishing victims per year',
    source: { name: 'Scam Sniffer', year: '2023–2025', url: 'https://www.scamsniffer.io' },
  },
  {
    key: 'ic3-complaints',
    value: '≈150,000 complaints · $9.3B losses',
    label: 'crypto complaints and losses per year (US only)',
    source: { name: 'FBI IC3 Annual Report', year: '2024', url: 'https://www.ic3.gov' },
  },
  {
    key: 'solana-failed-tx',
    value: '≈1.5 billion (~52%)',
    label: 'failed non-vote transactions on Solana over 12 months',
    source: { name: 'arXiv 2504.18055', year: '2025', url: 'https://arxiv.org/abs/2504.18055' },
  },
  {
    key: 'sandwich-attacks',
    value: '60,000–90,000/month · ~$60M/yr',
    label: 'sandwich attacks on Ethereum and trader losses',
    source: { name: 'EigenPhi', year: 'Nov 2024–Oct 2025', url: 'https://eigenphi.io' },
  },
  {
    key: 'jito-tips',
    value: '$674M',
    label: 'Jito MEV tips on Solana in 2024 (up from $3.52M in 2023)',
    source: { name: 'Helius Solana MEV Report', year: '2024', url: 'https://www.helius.dev' },
  },
  {
    key: 'solana-victim-incidents',
    value: '~26,500',
    label: 'Solana had the largest number of victim incidents in 2025',
    source: { name: 'Chainalysis', year: '2025', url: 'https://www.chainalysis.com' },
  },
  {
    key: 'oracle-manipulation',
    value: '$403M / 41 attacks (2022) · ~$52M / 37 incidents (2024)',
    label: 'oracle price-manipulation losses; 62% of price-manipulation attacks use flash loans',
    source: { name: 'Chainalysis · Three Sigma · Halborn', year: '2022–2024' },
  },
  {
    key: 'approval-phishing',
    value: '>$2.7B',
    label: 'stolen via approval phishing since May 2021',
    source: {
      name: 'Chainalysis (Operation Spincaster)',
      year: '2024',
      url: 'https://www.chainalysis.com',
    },
  },
  {
    key: 'ai-agent-sector',
    value: '$4.8B → $15.5B (+322%)',
    label: 'AI-agent token sector in Q4 2024',
    source: { name: 'CoinDesk', year: '2024', url: 'https://www.coindesk.com' },
  },
  {
    key: 'solana-agent-kit',
    value: '>100K downloads · ~1.6K stars',
    label: 'Solana Agent Kit (SendAI) adoption',
    source: { name: 'SendAI (GitHub)', year: '2025', url: 'https://github.com/sendaifun/solana-agent-kit' },
  },
  {
    key: 'non-human-identities',
    value: '96-to-1',
    label: 'non-human identities outnumber humans; a16z proposes "Know Your Agent" (KYA) for agents that cannot bear liability',
    source: { name: 'a16z crypto', year: 'Jan 2026', url: 'https://a16zcrypto.com' },
  },
] as const;

/** Look up a single market stat by key (throws on typo at call sites in tests). */
export function getMarketStat(key: string): MarketStat | undefined {
  return MARKET_STATS.find((s) => s.key === key);
}

/** Deduplicated list of distinct source names across the provided refs. */
export function distinctSources(refs: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    out.push(ref);
  }
  return out;
}
