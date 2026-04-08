'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useAgentGuardContext } from '@/providers/AgentGuardProvider';
import { formatUsdc } from '@agentguard/shared';

export default function LandingPage() {
  const { vaultStats } = useAgentGuardContext();

  return (
    <div style={{ padding: 'var(--space-2xl) var(--space-xl)' }}>
      {/* Hero */}
      <section
        style={{
          textAlign: 'center',
          maxWidth: 800,
          margin: '0 auto',
          padding: 'var(--space-2xl) 0',
        }}
      >
        <div style={{ fontSize: '3rem', marginBottom: 'var(--space-md)' }}>
          <span role="img" aria-label="shield">
            &#x1F6E1;
          </span>
        </div>
        <h1
          style={{
            fontSize: '3rem',
            fontWeight: 800,
            lineHeight: 1.1,
            marginBottom: 'var(--space-md)',
          }}
        >
          Insurance for <span style={{ color: 'var(--color-primary)' }}>AI Agents</span> on Solana
        </h1>
        <p
          style={{
            fontSize: '1.25rem',
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--space-xl)',
            maxWidth: 600,
            margin: '0 auto var(--space-xl)',
          }}
        >
          First parametric insurance protocol for AI agents. Automatic verification and payout via
          on-chain oracle. No human intervention.
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-md)', justifyContent: 'center' }}>
          <Link href="/dashboard">
            <Button size="lg">Get Risk Score</Button>
          </Link>
          <Link href="/staking">
            <Button variant="secondary" size="lg">
              Become a Staker
            </Button>
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section style={{ maxWidth: 1000, margin: '0 auto', padding: 'var(--space-2xl) 0' }}>
        <h2
          style={{
            textAlign: 'center',
            fontSize: '1.5rem',
            fontWeight: 700,
            marginBottom: 'var(--space-xl)',
          }}
        >
          How It Works
        </h2>
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-lg)' }}
        >
          <Card>
            <div style={{ fontSize: '2rem', marginBottom: 'var(--space-sm)' }}>1</div>
            <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-xs)' }}>Assess</h3>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
              AI-powered risk scoring analyzes your agent&apos;s on-chain history, transaction
              patterns, and protocol interactions.
            </p>
          </Card>
          <Card>
            <div style={{ fontSize: '2rem', marginBottom: 'var(--space-sm)' }}>2</div>
            <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-xs)' }}>Insure</h3>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
              Buy parametric coverage with USDC. Premium calculated by risk tier. Coverage up to 1M
              USDC, duration up to 30 days.
            </p>
          </Card>
          <Card>
            <div style={{ fontSize: '2rem', marginBottom: 'var(--space-sm)' }}>3</div>
            <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-xs)' }}>Protect</h3>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
              Automatic claim detection, on-chain verification, and instant USDC payout. Exploits,
              oracle attacks, agent errors covered.
            </p>
          </Card>
        </div>
      </section>

      {/* Live Stats */}
      <section style={{ maxWidth: 1000, margin: '0 auto', padding: 'var(--space-2xl) 0' }}>
        <h2
          style={{
            textAlign: 'center',
            fontSize: '1.5rem',
            fontWeight: 700,
            marginBottom: 'var(--space-xl)',
          }}
        >
          Protocol Stats
        </h2>
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-lg)' }}
        >
          <Card style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
              Total Value Protected
            </p>
            <p style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--color-primary)' }}>
              ${vaultStats ? formatUsdc(vaultStats.totalCoverage) : '0.00'}
            </p>
          </Card>
          <Card style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
              Active Policies
            </p>
            <p style={{ fontSize: '2rem', fontWeight: 800 }}>{vaultStats?.activePolicies ?? 0}</p>
          </Card>
          <Card style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>Claims Paid</p>
            <p style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--color-primary)' }}>
              ${vaultStats ? formatUsdc(vaultStats.totalClaimsPaid) : '0.00'}
            </p>
          </Card>
        </div>
      </section>
    </div>
  );
}
