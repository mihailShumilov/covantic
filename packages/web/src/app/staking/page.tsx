'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useAgentGuardContext } from '@/providers/AgentGuardProvider';
import { formatUsdc, solvencyStatus, SolvencyStatus } from '@agentguard/shared';

const solvencyColors: Record<SolvencyStatus, string> = {
  [SolvencyStatus.Healthy]: 'success',
  [SolvencyStatus.Caution]: 'warning',
  [SolvencyStatus.Critical]: 'danger',
  [SolvencyStatus.Emergency]: 'danger',
};

export default function StakingPage() {
  const { vaultStats } = useAgentGuardContext();
  const [stakeAmount, setStakeAmount] = useState('');

  const status = vaultStats
    ? solvencyStatus(vaultStats.solvencyRatio * 10000)
    : SolvencyStatus.Healthy;

  return (
    <div style={{ padding: 'var(--space-xl)', maxWidth: 1200, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 'var(--space-xl)' }}>
        Staking Pool
      </h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-lg)' }}>
        {/* Pool Health */}
        <Card title="Pool Health">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-lg)' }}>
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                Total Staked
              </p>
              <p style={{ fontSize: '1.5rem', fontWeight: 700 }}>
                ${vaultStats ? formatUsdc(vaultStats.totalStaked) : '0.00'}
              </p>
            </div>
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                Total Coverage
              </p>
              <p style={{ fontSize: '1.5rem', fontWeight: 700 }}>
                ${vaultStats ? formatUsdc(vaultStats.totalCoverage) : '0.00'}
              </p>
            </div>
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                Solvency Ratio
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                <p style={{ fontSize: '1.5rem', fontWeight: 700 }}>
                  {vaultStats?.solvencyRatio?.toFixed(2) ?? '0'}x
                </p>
                <Badge variant={solvencyColors[status] as any}>{status.toUpperCase()}</Badge>
              </div>
            </div>
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>Stakers</p>
              <p style={{ fontSize: '1.5rem', fontWeight: 700 }}>{vaultStats?.stakerCount ?? 0}</p>
            </div>
          </div>
        </Card>

        {/* Stake Form */}
        <Card title="Stake USDC">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
            <div>
              <label
                style={{
                  fontSize: '0.8125rem',
                  color: 'var(--color-text-muted)',
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                Amount (USDC)
              </label>
              <input
                type="number"
                value={stakeAmount}
                onChange={(e) => setStakeAmount(e.target.value)}
                placeholder="Enter amount..."
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--color-text)',
                }}
              />
            </div>
            <Button size="lg">Stake</Button>
            <p
              style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', textAlign: 'center' }}
            >
              48-hour cooldown for unstaking. Rewards from 70% of premiums collected.
            </p>
          </div>
        </Card>
      </div>

      {/* My Position */}
      <Card title="My Position" style={{ marginTop: 'var(--space-lg)' }}>
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-lg)' }}
        >
          <div>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>Staked</p>
            <p style={{ fontSize: '1.25rem', fontWeight: 700 }}>$0.00</p>
          </div>
          <div>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>Pool Share</p>
            <p style={{ fontSize: '1.25rem', fontWeight: 700 }}>0%</p>
          </div>
          <div>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
              Pending Rewards
            </p>
            <p style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--color-primary)' }}>
              $0.00
            </p>
          </div>
          <div>
            <Button variant="secondary">Claim Rewards</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
