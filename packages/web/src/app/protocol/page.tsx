'use client';

import { Card } from '@/components/ui/Card';
import { useCovanticContext } from '@/providers/CovanticProvider';
import { formatUsdc } from '@covantic/shared';

export default function ProtocolPage() {
  const { vaultStats } = useCovanticContext();

  const stats = [
    {
      label: 'Total Value Protected',
      value: vaultStats ? `$${formatUsdc(vaultStats.totalCoverage)}` : '$0.00',
      highlight: true,
    },
    { label: 'Active Policies', value: String(vaultStats?.activePolicies ?? 0), highlight: false },
    {
      label: 'Total Premiums Collected',
      value: vaultStats ? `$${formatUsdc(vaultStats.totalPremiumsCollected)}` : '$0.00',
      highlight: false,
    },
    {
      label: 'Claims Paid',
      value: vaultStats ? `$${formatUsdc(vaultStats.totalClaimsPaid)}` : '$0.00',
      highlight: false,
    },
    {
      label: 'Total Staked',
      value: vaultStats ? `$${formatUsdc(vaultStats.totalStaked)}` : '$0.00',
      highlight: false,
    },
    {
      label: 'Solvency Ratio',
      value: `${vaultStats?.solvencyRatio?.toFixed(2) ?? '0'}x`,
      highlight: false,
    },
  ];

  return (
    <div className="cov-page">
      <div style={{ marginBottom: 24 }}>
        <div className="cov-label" style={{ color: 'var(--c-info)', marginBottom: 8 }}>
          Protocol
        </div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 'var(--display-weight)' as never,
            letterSpacing: 'var(--display-tracking)',
            fontSize: 34,
          }}
        >
          Protocol overview
        </h1>
      </div>

      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-lg)' }}
      >
        {stats.map((stat) => (
          <Card key={stat.label} style={{ textAlign: 'center' }}>
            <p
              style={{
                color: 'var(--color-text-muted)',
                fontSize: '0.875rem',
                marginBottom: 'var(--space-xs)',
              }}
            >
              {stat.label}
            </p>
            <p
              style={{
                fontSize: stat.highlight ? '2.5rem' : '1.5rem',
                fontWeight: 800,
                color: stat.highlight ? 'var(--color-primary)' : 'var(--color-text)',
              }}
            >
              {stat.value}
            </p>
          </Card>
        ))}
      </div>

      {/* Coverage breakdown */}
      <Card title="Coverage Distribution" style={{ marginTop: 'var(--space-lg)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-lg)' }}>
          <div style={{ flex: 1 }}>
            <p
              style={{
                color: 'var(--color-text-muted)',
                fontSize: '0.8125rem',
                marginBottom: 'var(--space-sm)',
              }}
            >
              Premium Distribution
            </p>
            <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden' }}>
              <div
                style={{ width: '70%', background: 'var(--color-primary)' }}
                title="70% Stakers"
              />
              <div style={{ width: '20%', background: 'var(--color-info)' }} title="20% Reserve" />
              <div
                style={{ width: '10%', background: 'var(--color-accent)' }}
                title="10% Protocol"
              />
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: 'var(--space-xs)',
                fontSize: '0.75rem',
                color: 'var(--color-text-muted)',
              }}
            >
              <span>70% Stakers</span>
              <span>20% Reserve</span>
              <span>10% Protocol</span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
