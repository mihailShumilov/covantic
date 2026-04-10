'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useFadeIn } from '@/hooks/useFadeIn';
import { ClaimVerificationPipeline } from '@/components/claims/ClaimVerificationPipeline';
import {
  HERO_STATS,
  LOSS_EVENTS,
  HOW_IT_WORKS,
  COVERAGE_TRIGGERS,
  RISK_TIERS,
  SDK_CODE,
  STAKER_STATS,
  TECH_STACK,
} from '@/lib/mock-data';

// ─── Section wrapper with fade-in ───────────────────────────────────────────
function Section({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  const ref = useFadeIn<HTMLElement>();
  return (
    <section ref={ref} className="fade-in" style={{ maxWidth: 1100, margin: '0 auto', padding: 'var(--space-4xl) var(--space-lg)', ...style }}>
      {children}
    </section>
  );
}

// ─── Step icon SVGs (inline, lightweight) ───────────────────────────────────
function StepIcon({ type }: { type: string }) {
  const s = { width: 28, height: 28 };
  switch (type) {
    case 'search':
      return (
        <svg {...s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    case 'eye':
      return (
        <svg {...s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
        </svg>
      );
    case 'zap':
      return (
        <svg {...s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    default:
      return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LANDING PAGE
// ═════════════════════════════════════════════════════════════════════════════

export default function LandingPage() {
  const [demoRunning, setDemoRunning] = useState(false);
  const [demoKey, setDemoKey] = useState(0);

  const runDemo = () => {
    setDemoRunning(true);
    setDemoKey((k) => k + 1);
  };

  return (
    <div>
      {/* ─── HERO ─────────────────────────────────────────────────────── */}
      <section
        className="hero-bg"
        style={{
          textAlign: 'center',
          padding: 'var(--space-4xl) var(--space-lg)',
          minHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <h1
          style={{
            fontSize: 'clamp(2.5rem, 5vw, 4.5rem)',
            fontWeight: 800,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            marginBottom: 'var(--space-lg)',
            maxWidth: 800,
          }}
        >
          Your agent deserves
          <br />a <span className="gradient-text">safety net</span>.
        </h1>

        <p
          style={{
            fontSize: 'clamp(1rem, 2vw, 1.25rem)',
            color: 'var(--color-text-secondary)',
            maxWidth: 600,
            lineHeight: 1.6,
            marginBottom: 'var(--space-xl)',
          }}
        >
          Parametric insurance for AI agents on Solana.
          <br />
          Deterministic triggers. Instant payouts. Zero paperwork.
        </p>

        <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap', justifyContent: 'center', marginBottom: 'var(--space-3xl)' }}>
          <Link href="/dashboard">
            <button className="btn-glow">Get Risk Score</button>
          </Link>
          <Link href="/protocol">
            <button className="btn-outline">Explore Protocol &rarr;</button>
          </Link>
        </div>

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap', justifyContent: 'center' }}>
          {HERO_STATS.map((stat) => (
            <div
              key={stat.label}
              className="card-glow"
              style={{
                padding: 'var(--space-md) var(--space-xl)',
                textAlign: 'center',
                minWidth: 140,
              }}
            >
              <div style={{ fontSize: '1.75rem', fontWeight: 800, fontFamily: 'var(--font-mono)' }}>
                {stat.value}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ─── THE PROBLEM ──────────────────────────────────────────────── */}
      <Section>
        <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.25rem)', fontWeight: 800, textAlign: 'center', marginBottom: 'var(--space-sm)', letterSpacing: '-0.02em' }}>
          AI agents manage billions.
          <br />
          <span style={{ color: 'var(--color-text-secondary)' }}>When things go wrong, there&apos;s no safety net.</span>
        </h2>

        {/* Loss events ticker */}
        <div style={{ overflow: 'hidden', margin: 'var(--space-xl) 0', padding: 'var(--space-md) 0' }}>
          <div className="ticker-track">
            {[...LOSS_EVENTS, ...LOSS_EVENTS].map((ev, i) => (
              <div
                key={i}
                style={{
                  flexShrink: 0,
                  padding: 'var(--space-md) var(--space-lg)',
                  background: 'var(--color-surface)',
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--color-border-subtle)',
                  minWidth: 220,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{ev.name}</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--color-danger)', fontFamily: 'var(--font-mono)' }}>
                  {ev.loss}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
                  {ev.date} &middot; {ev.cause}
                </div>
              </div>
            ))}
          </div>
        </div>

        <p style={{ textAlign: 'center', fontStyle: 'italic', color: 'var(--color-text-muted)', fontSize: '0.9375rem' }}>
          Existing insurance covers smart contracts. Nobody covers the agents.
        </p>
      </Section>

      {/* ─── HOW IT WORKS ─────────────────────────────────────────────── */}
      <Section>
        <h2 style={{ fontSize: '1.75rem', fontWeight: 800, textAlign: 'center', marginBottom: 'var(--space-2xl)', letterSpacing: '-0.02em' }}>
          How Covantic Works
        </h2>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-lg)' }}>
          {HOW_IT_WORKS.map((step) => (
            <div key={step.step} className="card-glow" style={{ padding: 'var(--space-xl)', position: 'relative' }}>
              {/* Step number circle */}
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  border: '2px solid transparent',
                  background: 'linear-gradient(var(--color-surface), var(--color-surface)) padding-box, linear-gradient(135deg, var(--color-primary-light), var(--color-secondary)) border-box',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontSize: '0.875rem',
                  fontFamily: 'var(--font-mono)',
                  marginBottom: 'var(--space-md)',
                }}
              >
                {step.step}
              </div>

              {/* Icon */}
              <div style={{ color: 'var(--color-primary-light)', marginBottom: 'var(--space-sm)' }}>
                <StepIcon type={step.icon} />
              </div>

              <h3 style={{ fontWeight: 700, fontSize: '1.125rem', marginBottom: 'var(--space-xs)' }}>
                {step.title}
              </h3>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', lineHeight: 1.5 }}>
                {step.description}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ─── COVERAGE TRIGGERS ────────────────────────────────────────── */}
      <Section>
        <h2 style={{ fontSize: '1.75rem', fontWeight: 800, textAlign: 'center', marginBottom: 'var(--space-sm)', letterSpacing: '-0.02em' }}>
          Coverage Triggers
        </h2>
        <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-2xl)', maxWidth: 500, margin: '0 auto var(--space-2xl)' }}>
          Four parametric triggers, each verified deterministically on-chain.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--space-md)' }}>
          {COVERAGE_TRIGGERS.map((trigger) => (
            <div
              key={trigger.name}
              style={{
                padding: 'var(--space-lg)',
                borderRadius: 'var(--radius-lg)',
                border: `1px solid var(--color-border-subtle)`,
                background: trigger.bg,
                transition: 'var(--transition-base)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: trigger.color }} />
                <span style={{ fontWeight: 700, color: trigger.color }}>{trigger.name}</span>
              </div>
              <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-sm)', lineHeight: 1.5 }}>
                {trigger.condition}
              </p>
              <div
                style={{
                  fontSize: '0.6875rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--color-text-muted)',
                  padding: '2px 8px',
                  background: 'var(--color-surface)',
                  borderRadius: 'var(--radius-full)',
                  display: 'inline-block',
                }}
              >
                Lock: {trigger.lock}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ─── RISK TIERS & PRICING ─────────────────────────────────────── */}
      <Section>
        <h2 style={{ fontSize: '1.75rem', fontWeight: 800, textAlign: 'center', marginBottom: 'var(--space-sm)', letterSpacing: '-0.02em' }}>
          Risk Tiers & Pricing
        </h2>
        <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-2xl)', maxWidth: 400, margin: '0 auto var(--space-2xl)' }}>
          Premiums reflect real risk.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-md)' }}>
          {RISK_TIERS.map((tier) => (
            <div
              key={tier.name}
              className="card-glow"
              style={{ padding: 'var(--space-lg)', textAlign: 'center' }}
            >
              <div style={{ fontWeight: 800, fontSize: '0.75rem', letterSpacing: '0.1em', color: tier.color, marginBottom: 'var(--space-xs)' }}>
                {tier.name}
              </div>
              <div style={{ fontSize: '1.75rem', fontWeight: 800, fontFamily: 'var(--font-mono)', marginBottom: 'var(--space-sm)' }}>
                {tier.rate}
              </div>
              {/* Progress bar */}
              <div style={{ height: 4, background: 'var(--color-border)', borderRadius: 2, overflow: 'hidden', marginBottom: 'var(--space-xs)' }}>
                <div style={{ height: '100%', width: `${tier.fill}%`, background: tier.color, borderRadius: 2 }} />
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                {tier.range}
              </div>
            </div>
          ))}
        </div>

        <p style={{ textAlign: 'center', fontSize: '0.8125rem', color: 'var(--color-text-muted)', marginTop: 'var(--space-xl)', maxWidth: 600, margin: 'var(--space-xl) auto 0' }}>
          15 on-chain signals: Account age &middot; Transaction patterns &middot; DeFi exposure &middot;
          Protocol diversity &middot; Error rate &middot; Token concentration &middot; Volume history &middot;
          MEV exposure &middot; Funding sources &middot; and more.
        </p>
      </Section>

      {/* ─── LIVE CLAIM DEMO ──────────────────────────────────────────── */}
      <Section>
        <h2 style={{ fontSize: '1.75rem', fontWeight: 800, textAlign: 'center', marginBottom: 'var(--space-sm)', letterSpacing: '-0.02em' }}>
          See it in action.
        </h2>
        <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-xl)' }}>
          Watch a claim go from detection to payout in seconds.
        </p>

        <div style={{ maxWidth: 700, margin: '0 auto' }}>
          {!demoRunning && (
            <div style={{ textAlign: 'center', marginBottom: 'var(--space-lg)' }}>
              <button className="btn-glow" onClick={runDemo}>
                &#9654; Run Demo
              </button>
            </div>
          )}

          {demoRunning && (
            <div
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-lg)',
                padding: 'var(--space-lg)',
              }}
            >
              <ClaimVerificationPipeline key={demoKey} autoPlay onComplete={() => setDemoRunning(false)} />
            </div>
          )}
        </div>
      </Section>

      {/* ─── FOR DEVELOPERS ───────────────────────────────────────────── */}
      <Section>
        <h2 style={{ fontSize: '1.75rem', fontWeight: 800, textAlign: 'center', marginBottom: 'var(--space-sm)', letterSpacing: '-0.02em' }}>
          One line of code. Full coverage.
        </h2>
        <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-2xl)' }}>
          Integrate Covantic into your agent with the SDK.
        </p>

        <div
          style={{
            maxWidth: 600,
            margin: '0 auto',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-lg)',
            padding: 'var(--space-lg)',
            overflow: 'auto',
          }}
        >
          <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '0.875rem', lineHeight: 1.7, color: 'var(--color-text-secondary)' }}>
            <code>
              {SDK_CODE.split('\n').map((line, i) => {
                if (line.startsWith('import') || line.startsWith('const') || line.startsWith('await'))
                  return <div key={i}><span className="code-keyword">{line.split(' ')[0]}</span>{' '}{line.slice(line.indexOf(' ') + 1)}</div>;
                if (line.startsWith('//'))
                  return <div key={i} className="code-comment">{line}</div>;
                return <div key={i}>{line || '\u00A0'}</div>;
              })}
            </code>
          </pre>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-md)', justifyContent: 'center', marginTop: 'var(--space-xl)' }}>
          <a href="https://github.com/mihailShumilov/ai-agent-insurance" target="_blank" rel="noopener noreferrer">
            <button className="btn-outline">GitHub &rarr;</button>
          </a>
        </div>
      </Section>

      {/* ─── FOR STAKERS ──────────────────────────────────────────────── */}
      <Section>
        <h2 style={{ fontSize: '1.75rem', fontWeight: 800, textAlign: 'center', marginBottom: 'var(--space-sm)', letterSpacing: '-0.02em' }}>
          Earn yield by backing AI agent coverage.
        </h2>

        {/* Stats */}
        <div style={{ display: 'flex', gap: 'var(--space-lg)', justifyContent: 'center', marginTop: 'var(--space-xl)', marginBottom: 'var(--space-xl)', flexWrap: 'wrap' }}>
          {STAKER_STATS.map((stat) => (
            <div key={stat.label} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '1.75rem', fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--color-accent)' }}>
                {stat.value}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Steps */}
        <div style={{ maxWidth: 500, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          {[
            'Stake USDC into the insurance pool',
            'Premiums from agents = your yield',
            'Claims reduce pool (capped by solvency rules)',
            'Unstake with 48-hour cooldown',
          ].map((text, i) => (
            <div key={i} style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'flex-start' }}>
              <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--color-primary-light)', fontSize: '0.875rem', flexShrink: 0 }}>
                {i + 1}.
              </span>
              <span style={{ fontSize: '0.9375rem', color: 'var(--color-text-secondary)' }}>{text}</span>
            </div>
          ))}
        </div>

        <div style={{ textAlign: 'center', marginTop: 'var(--space-xl)' }}>
          <Link href="/staking">
            <button className="btn-glow">Start Staking &rarr;</button>
          </Link>
        </div>

        <p style={{ textAlign: 'center', fontSize: '0.6875rem', color: 'var(--color-text-muted)', marginTop: 'var(--space-md)' }}>
          Protocol is in devnet. All values are simulated.
        </p>
      </Section>

      {/* ─── BUILT WITH ───────────────────────────────────────────────── */}
      <Section style={{ padding: 'var(--space-2xl) var(--space-lg)' }}>
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2xl)',
            justifyContent: 'center',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          {TECH_STACK.map((name) => (
            <span
              key={name}
              style={{
                fontSize: '0.875rem',
                fontWeight: 600,
                color: 'var(--color-text-muted)',
                letterSpacing: '0.05em',
                transition: 'var(--transition-base)',
              }}
            >
              {name}
            </span>
          ))}
        </div>
      </Section>
    </div>
  );
}
