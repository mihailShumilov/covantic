'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import {
  CovRingGauge,
  HexFlicker,
  RevealOnView,
  StatValue,
  statusColor,
} from '@/components/cov/visuals';
import { FearBlock, LiveLosses, ProtocolFlow, StepIcon } from '@/components/cov/home-sections';

/* ---------- hero: looping mini assessment ---------- */
const HERO_SIGNALS = [
  { name: 'Wallet Maturity', s: 'LOW', v: 0.12 },
  { name: 'MEV Exposure', s: 'LOW', v: 0.18 },
  { name: 'Portfolio Size', s: 'MODERATE', v: 0.34 },
  { name: 'Activity Regularity', s: 'LOW', v: 0.16 },
];

function HeroDemo() {
  const [step, setStep] = useState(0); // 0..3 scanning, 4 = verdict, 5 = hold
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStep(5);
      return;
    }
    const ms = step < HERO_SIGNALS.length ? 850 : step === HERO_SIGNALS.length ? 2600 : 2200;
    const t = setTimeout(() => setStep((s) => (s >= 5 ? 0 : s + 1)), ms);
    return () => clearTimeout(t);
  }, [step]);

  const done = step >= HERO_SIGNALS.length;
  return (
    <div className="cov-card" style={{ padding: '22px 26px', width: '100%', maxWidth: 420 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span className="cov-label" style={{ color: done ? undefined : 'var(--c-info)' }}>
          {done ? 'Assessment complete' : 'Live assessment'}
        </span>
        <span style={{ flex: 1 }} />
        <span className="cov-mono" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
          Bq4N…x9Wd
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 22, alignItems: 'center' }}>
        <CovRingGauge value={done ? 0.182 : 0} label={done ? 'LOW' : '—'} size={128} animateIn={false} />
        <div>
          {HERO_SIGNALS.map((sig, i) => {
            const st = i < step ? 'done' : i === step ? 'active' : 'pending';
            return (
              <div
                key={sig.name}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '5px 0',
                  opacity: st === 'pending' ? 0.3 : 1,
                  transition: 'opacity .3s',
                }}
              >
                <span style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{sig.name}</span>
                <span style={{ flex: 1 }} />
                {st === 'active' && <HexFlicker width={4} />}
                {st === 'done' && (
                  <span className="cov-mono" style={{ fontSize: 11.5, color: statusColor(sig.s) }}>
                    {sig.v.toFixed(2)} {sig.s}
                  </span>
                )}
              </div>
            );
          })}
          <div
            style={{
              marginTop: 8,
              paddingTop: 10,
              borderTop: 'var(--hairline)',
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              minHeight: 22,
            }}
          >
            {done ? (
              <>
                <span className="cov-label" style={{ color: 'var(--c-low)' }}>
                  Insurable
                </span>
                <span style={{ flex: 1 }} />
                <span className="cov-mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  342 USDC / yr
                </span>
              </>
            ) : (
              <span className="cov-label cov-pulse" style={{ color: 'var(--c-info)' }}>
                scanning 15 factors…
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- page data ---------- */
const HOME_STEPS = [
  {
    n: '01',
    icon: 'assess' as const,
    title: 'Assess',
    body: 'The risk engine scores an agent across 15 on-chain factors in 5 categories — wallet history, execution quality, portfolio health, protocol exposure, behavioral patterns. No forms, no underwriters.',
  },
  {
    n: '02',
    icon: 'underwrite' as const,
    title: 'Underwrite',
    body: 'Premiums are priced deterministically from the risk surface. Eligible agents receive a quote in the same transaction; extreme-risk agents are declined with a remediation path.',
  },
  {
    n: '03',
    icon: 'settle' as const,
    title: 'Settle',
    body: 'Coverage is parametric. When a trigger condition is met on-chain, the payout executes in the same block — no claims process, no paperwork, no discretion.',
  },
  {
    n: '04',
    icon: 'stake' as const,
    title: 'Stake',
    body: 'Coverage pools are funded by stakers who deposit USDC, earn the premium flow, and absorb trigger payouts. Pool health and exposure are fully visible on-chain.',
  },
];

const HOME_TRIGGERS = [
  { code: 'drawdown > 20%', body: 'Portfolio drawdown breaches the covered threshold within the policy window.' },
  { code: 'exploit_flag == true', body: 'A covered protocol the agent interacts with is flagged as exploited.' },
  { code: 'oracle_deviation > 3σ', body: 'Price feed the agent depends on deviates beyond tolerance.' },
  { code: 'liveness_fail > 6h', body: 'Agent halts unexpectedly and misses its operational heartbeat.' },
];

const HOME_STATS = [
  { v: 1284, label: 'Agents assessed' },
  { v: 2.4, label: 'Coverage in force', prefix: '$', suffix: 'M', decimals: 1 },
  { v: 411, label: 'Median payout time', suffix: 'ms' },
  { v: 15, label: 'On-chain risk factors' },
];

export default function LandingPage() {
  return (
    <div>
      {/* hero */}
      <section className="cov-page" style={{ paddingTop: 84, paddingBottom: 64 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
            gap: 56,
            alignItems: 'center',
          }}
        >
          <div>
            <RevealOnView>
              <div className="cov-label" style={{ color: 'var(--c-info)', marginBottom: 18 }}>
                Parametric insurance · Solana
              </div>
              <h1
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 'var(--display-weight)' as never,
                  letterSpacing: 'var(--display-tracking)',
                  fontSize: 'clamp(34px, 5vw, 52px)',
                  lineHeight: 1.08,
                  textWrap: 'balance',
                }}
              >
                The coverage primitive for autonomous agents.
              </h1>
              <p
                style={{
                  fontSize: 16.5,
                  lineHeight: 1.6,
                  color: 'var(--text-dim)',
                  marginTop: 22,
                  maxWidth: 520,
                  textWrap: 'pretty',
                }}
              >
                Covantic is a programmable coverage protocol on Solana. Deterministic triggers, instant
                payouts, zero paperwork.
              </p>
            </RevealOnView>
            <RevealOnView delay={150}>
              <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap' }}>
                <Link href="/dashboard" style={{ textDecoration: 'none' }}>
                  <button className="cov-btn-primary" style={{ padding: '13px 24px', fontSize: 14.5 }}>
                    Run a risk assessment
                  </button>
                </Link>
                <Link href="/protocol" style={{ textDecoration: 'none' }}>
                  <button className="cov-btn-ghost" style={{ padding: '13px 20px', fontSize: 14 }}>
                    Read the protocol
                  </button>
                </Link>
              </div>
            </RevealOnView>
          </div>
          <RevealOnView delay={250} style={{ justifySelf: 'end', width: '100%', display: 'flex', justifyContent: 'flex-end' }}>
            <HeroDemo />
          </RevealOnView>
        </div>
      </section>

      {/* fear: real incidents */}
      <FearBlock />

      {/* live losses */}
      <section className="cov-page" style={{ paddingTop: 0, paddingBottom: 56 }}>
        <LiveLosses />
      </section>

      {/* stats */}
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
          {HOME_STATS.map((s) => (
            <div key={s.label} style={{ minWidth: 0 }}>
              <StatValue value={s.v} prefix={s.prefix || ''} suffix={s.suffix || ''} decimals={s.decimals || 0} />
              <div className="cov-label" style={{ marginTop: 8 }}>
                {s.label}
              </div>
            </div>
          ))}
        </RevealOnView>
      </section>

      {/* how it works */}
      <section className="cov-page" style={{ paddingTop: 0, paddingBottom: 56 }}>
        <RevealOnView>
          <div className="cov-label" style={{ color: 'var(--c-info)', marginBottom: 22 }}>
            How it works
          </div>
        </RevealOnView>
        <RevealOnView className="cov-card" delay={100} style={{ padding: '30px 28px 22px', marginBottom: 14 }}>
          <ProtocolFlow />
        </RevealOnView>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          {HOME_STEPS.map((s, i) => (
            <RevealOnView key={s.n} delay={i * 120} className="cov-card" style={{ padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
                <StepIcon kind={s.icon} />
                <div className="cov-mono" style={{ fontSize: 13, color: 'var(--c-info)' }}>
                  {s.n}
                </div>
              </div>
              <h3
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 'var(--display-weight)' as never,
                  fontSize: 24,
                  letterSpacing: 'var(--display-tracking)',
                  marginBottom: 10,
                }}
              >
                {s.title}
              </h3>
              <p style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--text-dim)', textWrap: 'pretty' }}>{s.body}</p>
            </RevealOnView>
          ))}
        </div>
      </section>

      {/* triggers */}
      <section className="cov-page" style={{ paddingTop: 0, paddingBottom: 56 }}>
        <RevealOnView>
          <div className="cov-label" style={{ color: 'var(--c-info)', marginBottom: 22 }}>
            Deterministic triggers
          </div>
        </RevealOnView>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 14 }}>
          {HOME_TRIGGERS.map((tr, i) => (
            <RevealOnView key={tr.code} delay={i * 90} className="cov-card" style={{ padding: '20px 22px' }}>
              <code className="cov-mono" style={{ fontSize: 13, color: 'var(--accent)', display: 'block', marginBottom: 10 }}>
                {tr.code}
              </code>
              <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-dim)', textWrap: 'pretty' }}>{tr.body}</p>
            </RevealOnView>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="cov-page" style={{ paddingTop: 0, paddingBottom: 72 }}>
        <RevealOnView className="cov-card" style={{ padding: '40px 44px', display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 'var(--display-weight)' as never,
                fontSize: 30,
                letterSpacing: 'var(--display-tracking)',
                marginBottom: 8,
              }}
            >
              See your agent&apos;s risk surface.
            </h2>
            <p style={{ fontSize: 14, color: 'var(--text-dim)' }}>
              15 factors, 5 categories, one transaction. Try the live demo assessment.
            </p>
          </div>
          <span style={{ flex: 1 }} />
          <Link href="/dashboard" style={{ textDecoration: 'none' }}>
            <button className="cov-btn-primary" style={{ padding: '13px 24px', fontSize: 14.5 }}>
              Run assessment
            </button>
          </Link>
        </RevealOnView>
      </section>
    </div>
  );
}
