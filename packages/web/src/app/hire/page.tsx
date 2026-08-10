import type { Metadata } from 'next';
import Link from 'next/link';
import { RevealOnView } from '@/components/cov/visuals';

export const metadata: Metadata = {
  title: 'Co-founder, Commercial — Covantic',
  description:
    'Covantic is looking for a commercial co-founder to own go-to-market, ecosystem, fundraising, pricing and company-building for parametric insurance on Solana.',
  openGraph: {
    title: 'Co-founder, Commercial — Covantic',
    description: 'Own everything that turns a working protocol into a business.',
    url: 'https://covantic.org/hire',
  },
};

/* ------------------------------------------------------------------
 * Contact — the only place the handles live. Update here.
 * ------------------------------------------------------------------ */
const CONTACT = {
  telegram: 'fibocryptos',
  email: 'mschumilow@gmail.com',
};

const FACTS = [
  { label: 'Role', value: 'Co-founder · equity' },
  { label: 'Stage', value: 'Devnet live, pre-seed' },
  { label: 'Raise', value: '$300K' },
  { label: 'Domain', value: 'Solana · DeFi · AI agents' },
];

const PILLARS = [
  {
    n: '01',
    title: 'Go-to-market & first revenue',
    body: 'Own the journey from zero to first paying customers — finding and winning the agent operators, trading-bot teams and DeFi protocols who need cover, running discovery, closing the first design partners and live policies, and building a repeatable sales motion from a blank page. You’re also the voice of the customer back into the product.',
  },
  {
    n: '02',
    title: 'Ecosystem & partnerships',
    body: 'Build Covantic’s place in the Solana / DeFi world: relationships with protocols, agent frameworks, wallets, funds and communities — and the integration and distribution deals that put Covantic in front of agents where they already operate.',
  },
  {
    n: '03',
    title: 'Fundraising & investor relations',
    body: 'Co-own the story and the raise — building a pipeline of crypto-native VCs and angels, running the process end to end, and carrying investor relationships through to close and beyond.',
  },
  {
    n: '04',
    title: 'Commercial strategy & pricing',
    body: 'Shape the business model itself: pricing, packaging, positioning and the customer-facing narrative — turning what the product can do into a proposition people pay for.',
  },
  {
    n: '05',
    title: 'Company-building',
    body: 'As co-founder, share ownership of strategy, the first commercial hires, and the culture and standards we set. Not a hire executing a plan — a partner building the company with me.',
  },
];

const CONTEXT = [
  {
    title: 'What exists today',
    body: 'A working full loop on devnet: a 15-signal on-chain risk scorer, policies created on-chain in one transaction, parametric payouts verified against Helius and Pyth, and a staker-funded coverage pool. Built solo in a five-week sprint, open source.',
  },
  {
    title: 'Why now',
    body: 'Autonomous agents run real capital on-chain and absorb every cent when it goes wrong — $286M drained from Drift in April 2026, ~600–760 security incidents a year, a median hack around $104K. Under 0.5% of DeFi is insured. Nobody writes first-party parametric cover for an agent’s own trading loss.',
  },
  {
    title: 'What the raise buys',
    body: 'Security audit, mainnet launch, and the first design-partner cohort. The commercial side of that — who those partners are, what they pay, and who funds it — is the half of the company that does not exist yet.',
  },
];

const sectionLabel = { color: 'var(--c-info)', marginBottom: 22 } as const;

const displayHeading = {
  fontFamily: 'var(--font-display)',
  fontWeight: 'var(--display-weight)' as never,
  letterSpacing: 'var(--display-tracking)',
} as const;

export default function HirePage() {
  return (
    <div>
      {/* hero */}
      <section className="cov-page" style={{ paddingTop: 72, paddingBottom: 48 }}>
        <RevealOnView>
          <div className="cov-label" style={{ color: 'var(--c-info)', marginBottom: 18 }}>
            Open role · Covantic
          </div>
          <h1
            style={{
              ...displayHeading,
              fontSize: 'clamp(32px, 4.6vw, 48px)',
              lineHeight: 1.08,
              textWrap: 'balance',
            }}
          >
            Co-founder, Commercial
          </h1>
          <p
            style={{
              fontSize: 16.5,
              lineHeight: 1.6,
              color: 'var(--text-dim)',
              marginTop: 22,
              maxWidth: 620,
              textWrap: 'pretty',
            }}
          >
            You&apos;d own everything that turns a working protocol into a business. The protocol
            works. The company does not exist yet.
          </p>
        </RevealOnView>

        <RevealOnView delay={150}>
          <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap' }}>
            <a
              href={`https://t.me/${CONTACT.telegram}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'none' }}
            >
              <button className="cov-btn-primary" style={{ padding: '13px 24px', fontSize: 14.5 }}>
                Start a conversation
              </button>
            </a>
            <a href="/pitch" style={{ textDecoration: 'none' }}>
              <button className="cov-btn-ghost" style={{ padding: '13px 20px', fontSize: 14 }}>
                Read the pitch deck
              </button>
            </a>
          </div>
        </RevealOnView>
      </section>

      {/* facts */}
      <section className="cov-page" style={{ paddingTop: 0, paddingBottom: 56 }}>
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

      {/* context */}
      <section className="cov-page" style={{ paddingTop: 0, paddingBottom: 56 }}>
        <RevealOnView>
          <div className="cov-label" style={sectionLabel}>
            What you&apos;d be joining
          </div>
        </RevealOnView>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 14,
          }}
        >
          {CONTEXT.map((c, i) => (
            <RevealOnView
              key={c.title}
              delay={i * 110}
              className="cov-card"
              style={{ padding: '24px 26px' }}
            >
              <h3 style={{ ...displayHeading, fontSize: 20, marginBottom: 10 }}>{c.title}</h3>
              <p
                style={{
                  fontSize: 13.5,
                  lineHeight: 1.65,
                  color: 'var(--text-dim)',
                  textWrap: 'pretty',
                }}
              >
                {c.body}
              </p>
            </RevealOnView>
          ))}
        </div>
      </section>

      {/* the role — five pillars */}
      <section className="cov-page" style={{ paddingTop: 0, paddingBottom: 56 }}>
        <RevealOnView>
          <div className="cov-label" style={sectionLabel}>
            The role — five pillars
          </div>
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.6,
              color: 'var(--text-dim)',
              maxWidth: 620,
              marginBottom: 22,
              textWrap: 'pretty',
            }}
          >
            Everything on the commercial side is unowned. These five are yours.
          </p>
        </RevealOnView>

        <div style={{ display: 'grid', gap: 14 }}>
          {PILLARS.map((p, i) => (
            <RevealOnView
              key={p.n}
              delay={i * 90}
              className="cov-card"
              style={{ padding: '26px 28px' }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr)',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
                  <span className="cov-mono" style={{ fontSize: 13, color: 'var(--c-info)' }}>
                    {p.n}
                  </span>
                  <h3 style={{ ...displayHeading, fontSize: 22, textWrap: 'balance' }}>
                    {p.title}
                  </h3>
                </div>
                <p
                  style={{
                    fontSize: 14,
                    lineHeight: 1.7,
                    color: 'var(--text-dim)',
                    maxWidth: 780,
                    textWrap: 'pretty',
                  }}
                >
                  {p.body}
                </p>
              </div>
            </RevealOnView>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="cov-page" style={{ paddingTop: 0, paddingBottom: 72 }}>
        <RevealOnView className="cov-card" style={{ padding: '40px 44px' }}>
          <h2 style={{ ...displayHeading, fontSize: 28, marginBottom: 10, textWrap: 'balance' }}>
            If this is the company you want to build, say so.
          </h2>
          <p
            style={{
              fontSize: 14,
              lineHeight: 1.65,
              color: 'var(--text-dim)',
              maxWidth: 620,
              textWrap: 'pretty',
            }}
          >
            No CV needed. Tell me what you&apos;d go after in the first 90 days and who you&apos;d
            call first. Start with the{' '}
            {/* standalone export from public/, not an app route — plain <a> */}
            <a href="/pitch" style={{ color: 'var(--accent)' }}>
              pitch deck
            </a>{' '}
            and the{' '}
            <Link href="/demo" style={{ color: 'var(--accent)' }}>
              live demo
            </Link>
            .
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 28, flexWrap: 'wrap' }}>
            <a
              href={`https://t.me/${CONTACT.telegram}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'none' }}
            >
              <button className="cov-btn-primary" style={{ padding: '13px 24px', fontSize: 14.5 }}>
                Telegram — @{CONTACT.telegram}
              </button>
            </a>
            <a
              href={`mailto:${CONTACT.email}?subject=${encodeURIComponent('Covantic — commercial co-founder')}`}
              style={{ textDecoration: 'none' }}
            >
              <button className="cov-btn-ghost" style={{ padding: '13px 20px', fontSize: 14 }}>
                {CONTACT.email}
              </button>
            </a>
          </div>
        </RevealOnView>
      </section>
    </div>
  );
}
