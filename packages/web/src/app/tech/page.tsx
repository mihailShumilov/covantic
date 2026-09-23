import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { RevealOnView } from '@/components/cov/visuals';

export const metadata: Metadata = {
  title: 'Tech details — Covantic',
  description:
    'How Covantic works, in plain words: how the risk scorer prices an agent, how payout events are detected, how a payout moves money, and how stakers earn from premiums.',
  openGraph: {
    title: 'Tech details — Covantic',
    description:
      'The risk scorer, payout detection, payouts and staking — explained simply, with the real numbers from the program.',
    url: 'https://covantic.org/tech',
  },
};

/* ------------------------------------------------------------------
 * Every number on this page is a constant in the code. When one changes,
 * change it here too. Sources:
 *   risk scorer   packages/api/src/services/risk-scorer.ts (FACTOR_CONFIGS)
 *   tiers, rates  packages/shared/src/constants.ts, anchor constants.rs
 *   envelope      packages/api/src/services/envelope-derivation.ts
 *   locks, split  packages/anchor/programs/covantic/src/constants.rs
 * ------------------------------------------------------------------ */

const FACTS = [
  { label: 'Risk signals', value: '15, read from chain' },
  { label: 'Payout triggers', value: '4' },
  { label: 'Stakers’ share', value: '70% of every premium' },
  { label: 'Unstake cooldown', value: '48 hours' },
];

const TOC = [
  { id: 'risk', n: '01', title: 'How the risk scorer works' },
  { id: 'detection', n: '02', title: 'How payout events are detected' },
  { id: 'payout', n: '03', title: 'How a payout works' },
  { id: 'staking', n: '04', title: 'How staking works — and how you earn' },
];

type Signal = { name: string; weight: string; meaning: string };

const SIGNAL_GROUPS: { title: string; weight: string; signals: Signal[] }[] = [
  {
    title: 'Transaction behaviour',
    weight: '30%',
    signals: [
      {
        name: 'Failed transactions',
        weight: '10%',
        meaning:
          'What share of the agent’s transactions fail. Recent failures count more than old ones.',
      },
      {
        name: 'Slippage',
        weight: '8%',
        meaning:
          'How much value the agent loses on swaps compared with the expected price. 5% average slippage is the worst score.',
      },
      {
        name: 'Activity spikes',
        weight: '7%',
        meaning:
          'Sudden bursts of transactions compared with the agent’s normal pace, measured in 6-hour buckets.',
      },
      {
        name: 'Sandwich attacks',
        weight: '5%',
        meaning:
          'Swaps where someone else jumped in front of and behind the agent’s trade to take a cut.',
      },
    ],
  },
  {
    title: 'Protocols & DeFi',
    weight: '22%',
    signals: [
      {
        name: 'Protocol concentration',
        weight: '8%',
        meaning:
          'Whether the agent depends on a single program. One program only is the worst score.',
      },
      {
        name: 'Risky protocols',
        weight: '8%',
        meaning:
          'How often the agent touches bridges, flash loans or unknown programs, compared with well-known exchanges.',
      },
      {
        name: 'DeFi complexity',
        weight: '6%',
        meaning:
          'Leverage, bridges, multi-hop routes and very long transactions. More moving parts means more ways to break.',
      },
    ],
  },
  {
    title: 'Wallet & identity',
    weight: '18%',
    signals: [
      {
        name: 'Wallet age',
        weight: '7%',
        meaning:
          'A brand-new wallet is the riskiest. The score falls steadily until the wallet is a year old.',
      },
      {
        name: 'SOL balance',
        weight: '5%',
        meaning:
          'Whether the agent has enough SOL to pay fees. An agent that can’t pay fees can’t get out of a bad position.',
      },
      {
        name: 'Funding sources',
        weight: '6%',
        meaning: 'Whether all the agent’s money comes from one single wallet.',
      },
    ],
  },
  {
    title: 'Portfolio',
    weight: '18%',
    signals: [
      {
        name: 'Token concentration',
        weight: '7%',
        meaning: 'Whether the agent holds everything in one token.',
      },
      {
        name: 'Portfolio size',
        weight: '5%',
        meaning: 'Very small portfolios score as riskier. Under $10 is the worst band.',
      },
      {
        name: 'Stablecoin share',
        weight: '6%',
        meaning:
          'How much of the portfolio is in stablecoins or liquid-staked SOL. More stable holdings mean a lower score.',
      },
    ],
  },
  {
    title: 'Behaviour patterns',
    weight: '12%',
    signals: [
      {
        name: 'Regularity',
        weight: '6%',
        meaning:
          'Whether the agent acts on a steady rhythm or at random. A steady rhythm usually means a healthy loop.',
      },
      {
        name: 'Recent trend',
        weight: '6%',
        meaning:
          'Compares the newest 30% of transactions with the older 70%. Rising failures and complexity push the score up.',
      },
    ],
  },
];

const TIERS = [
  { tier: 'LOW', range: '0.00 – 0.30', rate: '1% a year', color: 'var(--c-low)' },
  { tier: 'MEDIUM', range: '0.31 – 0.60', rate: '2.5% a year', color: 'var(--c-moderate)' },
  { tier: 'HIGH', range: '0.61 – 0.85', rate: '5% a year', color: 'var(--c-elevated)' },
  {
    tier: 'EXTREME',
    range: '0.86 – 1.00',
    rate: 'Not insurable',
    color: 'var(--c-critical)',
  },
];

const TRIGGERS = [
  {
    name: 'Exploit',
    lock: '1 hour',
    body: 'Money left the agent’s wallet without the agent’s permission: a drained account, a stolen key or a malicious approval. On-chain, the program must see the balance fall by at least 50%.',
    pays: 'Up to the amount that left the wallet.',
  },
  {
    name: 'Oracle manipulation',
    lock: '1 hour',
    body: 'The agent traded at a price that was pushed away from the real market. The fill price is compared with the Pyth price for the same moment. It must differ by at least 0.5%.',
    pays: 'The price gap × the quantity traded.',
  },
  {
    name: 'Agent error',
    lock: '6 hours',
    body: 'The agent itself sent out far more than it ever normally does, breaking its spending limits (its “envelope”). This covers bugs, bad prompts and runaway loops.',
    pays: 'The whole overshoot above the limit.',
  },
  {
    name: 'Governance attack',
    lock: '2 hours',
    body: 'Control of the agent’s account moved to someone outside the declared authority set: a new owner, a new delegate or a frozen account.',
    pays: 'Up to what was lost or seized.',
  },
];

const PAYOUT_STEPS = [
  {
    title: 'The event is screened and judged',
    body: 'A watcher flags a suspicious transaction. A separate, strict checker for that trigger type then rebuilds what happened from raw chain data and decides whether it is a covered loss and how large it is. Losses below 0.1 USDC are ignored.',
  },
  {
    title: 'The claim is opened on-chain',
    body: 'The oracle files the claim on the policy. The policy switches to “Claim pending” and the clock for the lock period starts. Only one claim can be open per policy. The policy holder can also file a claim themselves.',
  },
  {
    title: 'The lock period passes',
    body: 'The claim waits 1 to 6 hours depending on the trigger (see the table below). This window lets a mistaken claim be caught before money moves. It is the only delay in the process.',
  },
  {
    title: 'The program checks the proof itself',
    body: 'A proof instruction runs for the trigger type. The program does not take the oracle’s word for the amount: it reads its own balance and authority checkpoints, the policy and, for oracle claims, the signed Pyth price. It then works out the largest amount it is allowed to pay.',
  },
  {
    title: 'USDC moves in the same transaction',
    body: 'If every check passes, the vault sends USDC straight to the policy holder’s USDC account in that same transaction. The policy is marked “Claim paid”, and a proof record is written on-chain, so a policy can only ever be paid once.',
  },
];

const SAFETY = [
  {
    title: 'No trust without proof',
    body: 'Every checker’s confidence is capped below the level needed to pay on its word alone. So every payout must go through an on-chain proof. Anything the program can’t prove goes to human review — never to an automatic yes.',
  },
  {
    title: 'You can’t choose your own price',
    body: 'The risk tier is signed by the oracle and read from chain. The spending limits are worked out from the agent’s history and locked by a hash. The buyer only picks the coverage amount and the duration.',
  },
  {
    title: 'Self-inflicted drains are not “hacks”',
    body: 'If the agent itself approved a delegate that later drained it, that is not an exploit. It is re-checked as agent error against the spending limits.',
  },
  {
    title: 'Hourly circuit breaker',
    body: 'Automatic payouts stop at 100,000 USDC per hour. Anything above that waits for review. An admin pause also stops all payouts in an emergency.',
  },
  {
    title: 'Double-checked reads',
    body: 'Any chain read that would lead to rejecting a claim must be confirmed by a second RPC provider. One flaky node can’t cost a holder their payout.',
  },
  {
    title: 'Fresh checkpoints',
    body: 'Balance and authority checkpoints are refreshed every sweep and must be less than 2 hours old at payout. Anyone can write a balance checkpoint — it is read straight from the agent’s token account.',
  },
];

const SPLIT = [
  { label: 'Stakers', pct: 70, color: 'var(--accent)' },
  { label: 'Reserve fund', pct: 20, color: 'var(--c-info)' },
  { label: 'Protocol treasury', pct: 10, color: 'var(--c-moderate)' },
];

const STAKE_STEPS = [
  {
    title: 'Deposit USDC',
    body: 'Connect a wallet on the Staking page and stake any amount of USDC above zero. The program opens a position account for your wallet that records how much you staked. There is no LP token to manage.',
  },
  {
    title: 'Earn on every policy sold',
    body: 'The moment anyone buys a policy, 70% of the premium is split between all stakers in proportion to their stake at that moment. Your reward is ready right away — there is nothing to wait for.',
  },
  {
    title: 'Claim whenever you want',
    body: 'Rewards pile up as “pending” and you claim them with one click. They are not added to your stake automatically; you choose whether to re-stake them.',
  },
  {
    title: 'Withdraw in two steps',
    body: 'Request an unstake, wait 48 hours, then withdraw. While you wait, your stake still earns premiums and still backs claims. The cooldown stops someone from pulling out just before a known claim pays.',
  },
];

/* ---------------------------------------------------------------- styles */

const displayHeading = {
  fontFamily: 'var(--font-display)',
  fontWeight: 'var(--display-weight)' as never,
  letterSpacing: 'var(--display-tracking)',
} as const;

const bodyText: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: 'var(--text-dim)',
  textWrap: 'pretty',
};

const sectionStyle: CSSProperties = { paddingTop: 0, paddingBottom: 72, scrollMarginTop: 88 };

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '12px 16px',
  borderBottom: '1px solid var(--border-strong)',
};

const tdStyle: CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
  fontSize: 13,
  lineHeight: 1.55,
};

/* ------------------------------------------------------------ components */

function SectionHeading({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <RevealOnView style={{ marginBottom: 28 }}>
      <div className="cov-label" style={{ color: 'var(--c-info)', marginBottom: 10 }}>
        {n} · Tech details
      </div>
      <h2
        style={{
          ...displayHeading,
          fontSize: 'clamp(24px, 3.2vw, 32px)',
          lineHeight: 1.15,
          textWrap: 'balance',
        }}
      >
        {title}
      </h2>
      <p style={{ ...bodyText, fontSize: 15, marginTop: 14, maxWidth: 760 }}>{children}</p>
    </RevealOnView>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 style={{ ...displayHeading, fontSize: 19, margin: '40px 0 14px', textWrap: 'balance' }}>
      {children}
    </h3>
  );
}

function Para({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p style={{ ...bodyText, maxWidth: 780, marginBottom: 14, ...style }}>{children}</p>;
}

function Strong({ children }: { children: ReactNode }) {
  return <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{children}</strong>;
}

/** A worked example with real arithmetic. */
function Example({ title, lines, note }: { title: string; lines: string[]; note?: ReactNode }) {
  return (
    <RevealOnView
      className="cov-card"
      style={{ padding: '22px 26px', marginTop: 18, borderColor: 'var(--border-strong)' }}
    >
      <div className="cov-label" style={{ color: 'var(--accent)', marginBottom: 12 }}>
        Example · {title}
      </div>
      <pre
        className="cov-mono"
        style={{
          margin: 0,
          overflowX: 'auto',
          fontSize: 13,
          lineHeight: 1.8,
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {lines.join('\n')}
      </pre>
      {note && <p style={{ ...bodyText, fontSize: 13, marginTop: 12 }}>{note}</p>}
    </RevealOnView>
  );
}

function NumberedCards({ items }: { items: { title: string; body: string }[] }) {
  return (
    <ol style={{ display: 'grid', gap: 12, listStyle: 'none', padding: 0, margin: 0 }}>
      {items.map((s, i) => (
        <RevealOnView
          key={s.title}
          delay={i * 80}
          className="cov-card"
          style={{
            padding: '20px 24px',
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr)',
            gap: 16,
          }}
        >
          <span
            className="cov-mono"
            style={{ fontSize: 13, color: 'var(--c-info)', paddingTop: 3 }}
          >
            {String(i + 1).padStart(2, '0')}
          </span>
          <div>
            <h4 style={{ ...displayHeading, fontSize: 16, marginBottom: 8 }}>{s.title}</h4>
            <p style={{ ...bodyText, fontSize: 13.5 }}>{s.body}</p>
          </div>
        </RevealOnView>
      ))}
    </ol>
  );
}

function CardGrid({ items }: { items: { title: string; body: string }[] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
        gap: 12,
      }}
    >
      {items.map((c, i) => (
        <RevealOnView
          key={c.title}
          delay={i * 70}
          className="cov-card"
          style={{ padding: '20px 22px' }}
        >
          <h4 style={{ ...displayHeading, fontSize: 15.5, marginBottom: 8 }}>{c.title}</h4>
          <p style={{ ...bodyText, fontSize: 13.5 }}>{c.body}</p>
        </RevealOnView>
      ))}
    </div>
  );
}

function Table({
  label,
  headings,
  rows,
  minWidth = 560,
}: {
  label: string;
  headings: string[];
  rows: ReactNode[][];
  minWidth?: number;
}) {
  return (
    <div className="cov-card" style={{ overflowX: 'auto', padding: 0 }}>
      <table aria-label={label} style={{ width: '100%', minWidth, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {headings.map((h) => (
              <th key={h} scope="col" className="cov-label" style={thStyle}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, r) => (
            <tr key={r}>
              {cells.map((c, i) => (
                <td
                  key={i}
                  style={{ ...tdStyle, color: i === 0 ? 'var(--text)' : 'var(--text-dim)' }}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function TechPage() {
  return (
    <div>
      {/* hero */}
      <section className="cov-page" style={{ paddingTop: 72, paddingBottom: 48 }}>
        <RevealOnView>
          <div className="cov-label" style={{ color: 'var(--c-info)', marginBottom: 18 }}>
            Tech details · Covantic
          </div>
          <h1
            style={{
              ...displayHeading,
              fontSize: 'clamp(32px, 4.6vw, 48px)',
              lineHeight: 1.08,
              textWrap: 'balance',
            }}
          >
            How Covantic works, in plain words
          </h1>
          <p
            style={{
              fontSize: 16.5,
              lineHeight: 1.6,
              color: 'var(--text-dim)',
              marginTop: 22,
              maxWidth: 680,
              textWrap: 'pretty',
            }}
          >
            Covantic insures AI agents that trade on Solana. An agent gets a risk score. Its owner
            buys cover priced from that score. If something covered goes wrong, the protocol proves
            it on-chain and pays out in USDC. The money comes from a pool that anyone can stake
            into, and stakers earn most of the premiums. This page walks through each part, with the
            real numbers from the code.
          </p>
        </RevealOnView>

        <RevealOnView delay={150}>
          <nav
            aria-label="On this page"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
              gap: 10,
              marginTop: 32,
            }}
          >
            {TOC.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                className="cov-card"
                style={{ padding: '14px 18px', textDecoration: 'none', color: 'var(--text)' }}
              >
                <span className="cov-mono" style={{ fontSize: 12, color: 'var(--c-info)' }}>
                  {t.n}
                </span>
                <span style={{ display: 'block', fontSize: 14, marginTop: 6, lineHeight: 1.4 }}>
                  {t.title}
                </span>
              </a>
            ))}
          </nav>
        </RevealOnView>
      </section>

      {/* facts */}
      <section className="cov-page" style={{ paddingTop: 0, paddingBottom: 72 }}>
        <RevealOnView
          className="cov-card"
          style={{
            padding: '26px 32px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 28,
          }}
        >
          {FACTS.map((f) => (
            <div key={f.label} style={{ minWidth: 0 }}>
              <div className="cov-label">{f.label}</div>
              <div
                className="cov-mono"
                style={{ marginTop: 8, fontSize: 15, fontWeight: 600, textWrap: 'pretty' }}
              >
                {f.value}
              </div>
            </div>
          ))}
        </RevealOnView>
      </section>

      {/* 01 — risk scorer */}
      <section id="risk" className="cov-page" style={sectionStyle}>
        <SectionHeading n="01" title="How the risk scorer works">
          Before an agent can be insured, Covantic needs to know how risky it is. The risk scorer
          reads the agent&apos;s real history from the Solana blockchain and turns it into one
          number between 0 (very safe) and 1 (very risky). Nobody fills in a form, and nobody can
          argue for a better score — the chain data decides.
        </SectionHeading>

        <SubHeading>Step 1 — Read the agent&apos;s history</SubHeading>
        <Para>
          When you ask for a quote, the scorer fetches the agent wallet&apos;s{' '}
          <Strong>last 100 transactions</Strong>, its token balances and its account details. It
          uses a pool of Solana RPC providers, with Helius as a backup. If none of them answer, the
          assessment fails with an error — the scorer never makes up a score.
        </Para>
        <Para>
          At the same time it records every outgoing transfer the agent made. That record is used
          later to set the agent&apos;s spending limits (Step 5).
        </Para>

        <SubHeading>Step 2 — Score 15 separate signals</SubHeading>
        <Para>
          Each signal looks at one kind of risk and gives it a score from 0 to 1. The signals fall
          into five groups. The percentage next to each one is its weight — how much it counts in
          the final score. The weights add up to 100%.
        </Para>
        <div style={{ display: 'grid', gap: 12 }}>
          {SIGNAL_GROUPS.map((g, gi) => (
            <RevealOnView
              key={g.title}
              delay={gi * 70}
              className="cov-card"
              style={{ padding: '22px 26px' }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 12,
                  marginBottom: 14,
                  flexWrap: 'wrap',
                }}
              >
                <h4 style={{ ...displayHeading, fontSize: 17 }}>{g.title}</h4>
                <span className="cov-mono" style={{ fontSize: 12.5, color: 'var(--c-info)' }}>
                  {g.weight} of the score
                </span>
              </div>
              <div style={{ display: 'grid', gap: 12 }}>
                {g.signals.map((s) => (
                  <div
                    key={s.name}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '52px minmax(0, 1fr)',
                      gap: 12,
                      borderTop: '1px solid var(--border)',
                      paddingTop: 12,
                    }}
                  >
                    <span className="cov-mono" style={{ fontSize: 13, color: 'var(--text)' }}>
                      {s.weight}
                    </span>
                    <div>
                      <div style={{ fontSize: 13.5, color: 'var(--text)', marginBottom: 4 }}>
                        {s.name}
                      </div>
                      <p style={{ ...bodyText, fontSize: 13 }}>{s.meaning}</p>
                    </div>
                  </div>
                ))}
              </div>
            </RevealOnView>
          ))}
        </div>

        <SubHeading>Step 3 — Combine the signals, trusting thin data less</SubHeading>
        <Para>
          Some signals need a minimum amount of data before they mean anything. For example, the
          failure rate needs at least 10 transactions and the activity-spike check needs 20. If an
          agent has only 5 transactions, the failure-rate signal counts at half its weight. The
          final score is a <Strong>weighted average</Strong> of all 15 signals using these adjusted
          weights. A wallet with no history at all gets a neutral 0.5.
        </Para>
        <Para>
          The scorer also reports a sub-score for each of the five groups and an overall confidence
          level, so you can see <em>why</em> an agent scored the way it did.
        </Para>

        <SubHeading>Step 4 — Put the agent in a tier, and set the price</SubHeading>
        <Table
          label="Risk tiers"
          headings={['Tier', 'Score', 'Price of cover']}
          rows={TIERS.map((t) => [
            <span key="t" className="cov-mono" style={{ color: t.color, fontWeight: 600 }}>
              {t.tier}
            </span>,
            <span key="r" className="cov-mono">
              {t.range}
            </span>,
            t.rate,
          ])}
        />
        <Para style={{ marginTop: 16 }}>
          The price is a yearly rate, charged only for the time you are covered:
        </Para>
        <Example
          title="the premium formula"
          lines={[
            'premium = coverage × tier rate × (days covered ÷ 365)',
            '',
            '1,000 USDC of cover · MEDIUM tier (2.5%) · 7 days',
            '= 1,000 × 0.025 × 7 ÷ 365',
            '= 0.48 USDC',
          ]}
          note={
            <>
              Cover can be 1 to 1,000,000 USDC, for 1 hour up to 30 days. The smallest possible
              premium is 0.001 USDC. EXTREME agents can&apos;t buy cover at all — the quote refuses
              and the oracle won&apos;t sign for them.
            </>
          }
        />

        <SubHeading>Step 5 — Work out the agent&apos;s spending limits (the “envelope”)</SubHeading>
        <Para>
          Agent-error cover needs a line between “normal” and “a mistake”. Covantic draws that line
          from the agent&apos;s own history, not from what the buyer says. It looks at the size of
          the agent&apos;s outgoing transfers and takes the <Strong>95th percentile</Strong> — the
          size that 95% of its transfers stay under. Then:
        </Para>
        <ul style={{ ...bodyText, maxWidth: 780, paddingLeft: 20, display: 'grid', gap: 8 }}>
          <li>
            <Strong>Single-transfer limit</Strong> = 5 × that 95th percentile.
          </li>
          <li>
            <Strong>Hourly limit</Strong> = 3 × the single-transfer limit, over any one hour.
          </li>
          <li>
            The agent needs at least 5 recorded transfers. With less history there is nothing to
            measure “normal” against, so agent-error cover doesn&apos;t apply yet (exploit, oracle
            and governance cover still work).
          </li>
        </ul>
        <Example
          title="an envelope"
          lines={[
            'the agent usually sends up to 200 USDC per transfer (95th percentile)',
            'single-transfer limit = 5 × 200  = 1,000 USDC',
            'hourly limit          = 3 × 1,000 = 3,000 USDC',
          ]}
        />

        <SubHeading>Step 6 — Write the result on-chain</SubHeading>
        <Para>
          The raw score stays off-chain, but the <Strong>tier</Strong> and a fingerprint (hash) of
          the envelope are written into an on-chain “risk attestation” account for the agent. Only
          the Covantic oracle key can sign it, and it expires after at most 1 hour. When you buy,
          the program reads the tier from this account — never from the buyer — and refuses if it is
          missing, expired or doesn&apos;t match the envelope. A quote also needs an assessment less
          than 10 minutes old, so prices always reflect recent behaviour.
        </Para>
        <Para>
          Finally, the pool must be able to afford the cover. You can&apos;t buy more cover than the
          agent actually holds, or more than the pool&apos;s free capacity (two times the staked
          USDC, minus cover already sold). If the pool&apos;s backing falls below 50% of all active
          cover, no new policies can be sold. HIGH-tier agents need at least 100%.
        </Para>
      </section>

      {/* 02 — detection */}
      <section id="detection" className="cov-page" style={sectionStyle}>
        <SectionHeading n="02" title="How payout events are detected">
          Covantic insurance is <em>parametric</em>: it pays when a clearly defined event can be
          seen on the blockchain, not when someone files paperwork. The protocol watches every
          insured agent and looks for four kinds of events.
        </SectionHeading>

        <SubHeading>The four covered events</SubHeading>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
            gap: 12,
          }}
        >
          {TRIGGERS.map((t, i) => (
            <RevealOnView
              key={t.name}
              delay={i * 80}
              className="cov-card"
              style={{ padding: '22px 24px', display: 'grid', gap: 10, alignContent: 'start' }}
            >
              <h4 style={{ ...displayHeading, fontSize: 17 }}>{t.name}</h4>
              <p style={{ ...bodyText, fontSize: 13.5 }}>{t.body}</p>
              <p className="cov-mono" style={{ fontSize: 12.5, color: 'var(--accent)' }}>
                Pays: {t.pays}
              </p>
            </RevealOnView>
          ))}
        </div>
        <Para style={{ marginTop: 16 }}>
          Big transfers, failed transactions or unexplained balance drops are logged, but on their
          own they never open a claim. Only one of the four events above can.
        </Para>

        <SubHeading>How the watchers find them</SubHeading>
        <Para>There are two ways an event reaches the protocol:</Para>
        <ul style={{ ...bodyText, maxWidth: 780, paddingLeft: 20, display: 'grid', gap: 10 }}>
          <li>
            <Strong>The sweep (main path).</Strong> Every 2 minutes a watcher goes through the
            insured agents (up to 50 per pass). For each one it reads the latest transactions from
            the last 15 minutes and screens them for, in this order: governance changes, exploits,
            then spending-limit breaches. A second watcher re-checks swap prices on the same
            2-minute cycle. On every pass the sweep also writes fresh balance and authority
            “checkpoints” to chain — these are the reference readings used later to prove a loss.
          </li>
          <li>
            <Strong>Push alerts (fast path).</Strong> Helius sends a webhook the moment a watched
            wallet makes a transaction, so an event can be picked up in seconds instead of waiting
            for the next sweep.
          </li>
        </ul>
        <Para>
          If one transaction looks like several things at once, the most specific one wins:
          governance attack, then exploit, then oracle manipulation, then agent error.
        </Para>

        <SubHeading>Wide net first, then a strict check</SubHeading>
        <Para>
          The first screen is deliberately loose, so nothing real slips through. For example, it
          flags any drop of 25% or more, any change of account ownership, or any trade more than 1%
          off the market price on at least $50. Being flagged is not the same as being paid.
        </Para>
        <Para>
          Each flag then goes to a strict checker built for that event type. It rebuilds the
          transaction from raw chain data and answers: was this really covered, and how much was
          lost? For oracle claims it needs at least <Strong>3 price sources that agree</Strong>{' '}
          within 2% of each other before it trusts “the real price”.
        </Para>

        <SubHeading>Three possible outcomes</SubHeading>
        <Table
          label="Claim outcomes"
          headings={['Checker result', 'What happens']}
          rows={[
            [
              'Not covered',
              'No claim. Example: the agent itself signed the transfer and stayed within its limits.',
            ],
            [
              'Covered, provable on-chain',
              'A claim is opened and paid through an on-chain proof, as described in the next section.',
            ],
            [
              'Unclear, or cannot be proven on-chain',
              'Goes to human review. It is never rejected just because the automatic path couldn’t prove it.',
            ],
          ]}
        />
        <Para style={{ marginTop: 16 }}>
          Proven on-chain payouts are live today for exploits, agent errors and governance attacks.
          Oracle-manipulation claims are detected and judged, but go to review until the signed Pyth
          price feed is connected in production.
        </Para>
      </section>

      {/* 03 — payout */}
      <section id="payout" className="cov-page" style={sectionStyle}>
        <SectionHeading n="03" title="How a payout works">
          A payout is a single Solana transaction. The program checks the proof and moves the USDC
          in one step. If any check fails, nothing moves. Here is the full path from a detected
          event to money in the holder&apos;s wallet.
        </SectionHeading>

        <NumberedCards items={PAYOUT_STEPS} />

        <SubHeading>Lock periods</SubHeading>
        <Para>
          The lock is a short safety wait between opening a claim and paying it. It is the only
          delay built into the process, and it differs by event type:
        </Para>
        <Table
          label="Lock periods"
          headings={['Event', 'Lock before payout']}
          rows={TRIGGERS.map((t) => [
            t.name,
            <span key="l" className="cov-mono">
              {t.lock}
            </span>,
          ])}
          minWidth={360}
        />
        <Para style={{ marginTop: 16 }}>
          On devnet the locks are shortened to 30 seconds for demos. In a recorded devnet run, a
          policy that cost 0.29 USDC paid out 500 USDC 47 seconds after the event.
        </Para>

        <SubHeading>How much is paid</SubHeading>
        <Para>
          The program works out the largest amount it is allowed to pay from its{' '}
          <Strong>own</Strong> readings, and the payout can never be larger than the policy&apos;s
          coverage:
        </Para>
        <ul style={{ ...bodyText, maxWidth: 780, paddingLeft: 20, display: 'grid', gap: 8 }}>
          <li>
            <Strong>Exploit</Strong> — up to how far the balance actually fell.
          </li>
          <li>
            <Strong>Oracle manipulation</Strong> — up to the gap between the fill price and the Pyth
            price, times the quantity.
          </li>
          <li>
            <Strong>Governance attack</Strong> — up to the balance lost or the funds seized.
          </li>
          <li>
            <Strong>Agent error</Strong> — the <em>whole</em> overshoot above the spending limit.
            The limit works like a deductible: normal spending is the agent&apos;s own business, and
            everything past the line is covered.
          </li>
        </ul>
        <Example
          title="an agent-error payout"
          lines={[
            'single-transfer limit      1,000 USDC   (from the envelope above)',
            'a bug makes the agent send 4,000 USDC in one transfer',
            'overshoot = 4,000 − 1,000  = 3,000 USDC',
            '',
            'with 5,000 USDC of cover  → pays 3,000 USDC',
            'with 2,000 USDC of cover  → pays 2,000 USDC (capped at coverage)',
          ]}
        />

        <SubHeading>Where the money comes from</SubHeading>
        <Para>
          All USDC sits in one vault account controlled by the program. Inside it, the protocol
          keeps three separate balances, and a payout draws on them in this order:
        </Para>
        <ol style={{ ...bodyText, maxWidth: 780, paddingLeft: 20, display: 'grid', gap: 8 }}>
          <li>
            <Strong>The protocol treasury</Strong> (built from 10% of every premium) pays first.
          </li>
          <li>
            <Strong>The reserve fund</Strong> (20% of every premium) pays next.
          </li>
          <li>
            <Strong>Staker deposits</Strong> are used only once both of those are empty. Every
            staker then loses the same percentage of their stake.
          </li>
        </ol>
        <Para>
          The USDC always goes to the <Strong>policy holder&apos;s</Strong> USDC account — the
          wallet that bought the policy — not to the agent. After payment the policy is closed as
          “Claim paid”, its cover is released from the pool, and an on-chain proof record makes a
          second payout on the same policy impossible. If the vault ever held less than the payout,
          the transaction would fail entirely rather than pay a partial amount.
        </Para>

        <SubHeading>Built-in safety rules</SubHeading>
        <CardGrid items={SAFETY} />
      </section>

      {/* 04 — staking */}
      <section id="staking" className="cov-page" style={sectionStyle}>
        <SectionHeading n="04" title="How staking works — and how you earn">
          Every payout needs money behind it. That money comes from stakers: people who deposit USDC
          into the coverage pool. In return they earn most of every premium the protocol collects.
          Anyone with a Solana wallet and USDC can stake.
        </SectionHeading>

        <SubHeading>Where each premium goes</SubHeading>
        <RevealOnView className="cov-card" style={{ padding: '24px 26px' }}>
          <div
            role="img"
            aria-label="Premium split: 70% stakers, 20% reserve fund, 10% protocol treasury"
            style={{
              display: 'flex',
              height: 14,
              borderRadius: 'var(--radius)',
              overflow: 'hidden',
            }}
          >
            {SPLIT.map((s) => (
              <div key={s.label} style={{ width: `${s.pct}%`, background: s.color }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 14 }}>
            {SPLIT.map((s) => (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  aria-hidden
                  style={{ width: 10, height: 10, borderRadius: 2, background: s.color }}
                />
                <span className="cov-mono" style={{ fontSize: 13, color: 'var(--text)' }}>
                  {s.pct}%
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{s.label}</span>
              </div>
            ))}
          </div>
          <p style={{ ...bodyText, fontSize: 13, marginTop: 14 }}>
            The split is fixed in the on-chain program and happens inside the same transaction that
            creates the policy. The reserve and treasury stay in the vault and absorb losses before
            stakers do.
          </p>
        </RevealOnView>

        <SubHeading>Step by step</SubHeading>
        <NumberedCards items={STAKE_STEPS} />

        <SubHeading>How much can you earn?</SubHeading>
        <Para>
          Your earnings depend on how much cover people buy while you are staked, and on your share
          of the pool. There is no fixed interest rate. Roughly:
        </Para>
        <Example
          title="yearly yield"
          lines={[
            'yield ≈ 70% × premiums paid in a year ÷ total USDC staked',
            '',
            'pool: 100,000 USDC staked · you stake 10,000 USDC (10% share)',
            'premiums collected this month: 2,000 USDC',
            '  stakers’ 70%          = 1,400 USDC',
            '  your 10% of that      =   140 USDC',
            '  as a yearly rate      ≈   140 × 12 ÷ 10,000 = 16.8%',
          ]}
          note={
            <>
              Illustrative numbers, not a promise. Real yield rises with policy demand and falls as
              more USDC is staked. You earn only on policies bought while you are staked, and
              rewards are paid in USDC.
            </>
          }
        />

        <SubHeading>The risk you take</SubHeading>
        <Para>
          Staking is underwriting: you are the insurer. If payouts ever exceed everything in the
          treasury and the reserve, the rest comes out of staker deposits. Every staker loses the
          same percentage, so nobody can dodge a loss by being first to leave.
        </Para>
        <Example
          title="a loss reaching stakers"
          lines={[
            'a 5,000 USDC payout · treasury + reserve hold 1,000 USDC',
            '  1,000 USDC comes from the treasury and reserve',
            '  4,000 USDC comes from stakers = 4% of a 100,000 USDC pool',
            '  your 10,000 USDC stake becomes 9,600 USDC',
          ]}
        />

        <SubHeading>Withdrawal rules</SubHeading>
        <ul style={{ ...bodyText, maxWidth: 780, paddingLeft: 20, display: 'grid', gap: 10 }}>
          <li>
            <Strong>48-hour cooldown.</Strong> You request an unstake for your whole position, wait
            48 hours, then withdraw. Your stake keeps earning — and keeps backing claims — during
            the wait.
          </li>
          <li>
            <Strong>The pool must stay solvent.</Strong> Staked USDC must always cover at least 50%
            of all active policies. If your withdrawal would break that line, you get the free part
            now and can take the rest later, as policies expire, without a new cooldown.
          </li>
          <li>
            <Strong>Always reachable.</Strong> An emergency pause blocks new stakes and payouts, but
            never unstaking or claiming rewards.
          </li>
        </ul>

        <RevealOnView className="cov-card" style={{ padding: '36px 40px', marginTop: 40 }}>
          <h2 style={{ ...displayHeading, fontSize: 26, marginBottom: 10, textWrap: 'balance' }}>
            See it running
          </h2>
          <p style={{ ...bodyText, maxWidth: 620 }}>
            Covantic runs on Solana devnet today. Score an agent on the dashboard, watch the four
            exploit simulations in the demo, or stake into the pool.
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
            <Link href="/staking" style={{ textDecoration: 'none' }}>
              <button className="cov-btn-primary" style={{ padding: '13px 24px', fontSize: 14.5 }}>
                Go to staking
              </button>
            </Link>
            <Link href="/dashboard" style={{ textDecoration: 'none' }}>
              <button className="cov-btn-ghost" style={{ padding: '13px 20px', fontSize: 14 }}>
                Score an agent
              </button>
            </Link>
            <Link href="/demo" style={{ textDecoration: 'none' }}>
              <button className="cov-btn-ghost" style={{ padding: '13px 20px', fontSize: 14 }}>
                Live demo
              </button>
            </Link>
          </div>
        </RevealOnView>
      </section>
    </div>
  );
}
