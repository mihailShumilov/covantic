'use client';

import { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { RiskAssessmentPipeline } from '@/components/risk/RiskAssessmentPipeline';
import { apiGet, apiPost } from '@/lib/api-client';
import { formatUsdc, type Policy } from '@agentguard/shared';

const tierLabels = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'];
const tierBadgeVariants = ['success', 'warning', 'danger', 'danger'] as const;
const stateLabels = ['Active', 'Claim Pending', 'Approved', 'Paid', 'Expired', 'Cancelled'];
const stateBadgeVariants = ['success', 'warning', 'info', 'success', 'neutral', 'neutral'] as const;

export default function DashboardPage() {
  const { publicKey } = useWallet();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [showBuyModal, setShowBuyModal] = useState(false);
  const [riskResult, setRiskResult] = useState<any>(null);
  const [isAssessing, setIsAssessing] = useState(false);
  const [pipelineKey, setPipelineKey] = useState(0);
  const [agentAddress, setAgentAddress] = useState('');

  useEffect(() => {
    if (publicKey) {
      apiGet<{ policies: Policy[] }>(`/api/policies?holder=${publicKey.toBase58()}`)
        .then((data) => setPolicies(data.policies))
        .catch(() => {});
    }
  }, [publicKey]);

  const handleGetRisk = async () => {
    if (!agentAddress || isAssessing) return;

    // 1. Clear previous results and start pipeline animation
    setRiskResult(null);
    setIsAssessing(true);
    setPipelineKey((k) => k + 1);

    // 2. Fire API call in background — pipeline animation is already running
    try {
      const result = await apiGet(`/api/risk/${agentAddress}`);
      setRiskResult(result);
    } catch {
      setRiskResult(null);
    }
  };

  const handlePipelineComplete = () => {
    setIsAssessing(false);
  };

  return (
    <div style={{ padding: 'var(--space-xl)', maxWidth: 1200, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--space-xl)',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Agent Dashboard</h1>
        <Button onClick={() => setShowBuyModal(true)}>Buy Policy</Button>
      </div>

      {/* Risk Assessment */}
      <Card title="Risk Assessment" style={{ marginBottom: 'var(--space-lg)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label
              style={{
                fontSize: '0.8125rem',
                color: 'var(--color-text-muted)',
                display: 'block',
                marginBottom: 4,
              }}
            >
              Agent Wallet Address
            </label>
            <input
              value={agentAddress}
              onChange={(e) => setAgentAddress(e.target.value)}
              placeholder="Enter agent wallet address..."
              disabled={isAssessing}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-text)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.875rem',
                opacity: isAssessing ? 0.6 : 1,
              }}
            />
          </div>
          <Button onClick={handleGetRisk} size="md" disabled={isAssessing}>
            {isAssessing ? 'Scanning...' : 'Assess Risk'}
          </Button>
        </div>

        {/* Animated pipeline — stays visible after completion */}
        {pipelineKey > 0 && (
          <RiskAssessmentPipeline
            key={pipelineKey}
            result={riskResult}
            onComplete={handlePipelineComplete}
          />
        )}
      </Card>

      {/* Policies List */}
      <Card title="Your Policies">
        {policies.length === 0 ? (
          <p
            style={{
              color: 'var(--color-text-muted)',
              textAlign: 'center',
              padding: 'var(--space-xl)',
            }}
          >
            {publicKey
              ? 'No policies yet. Buy your first policy!'
              : 'Connect wallet to view policies.'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
            {policies.map((policy) => (
              <div
                key={policy.policyId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: 'var(--space-md)',
                  background: 'var(--color-bg)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <div>
                  <div
                    style={{
                      display: 'flex',
                      gap: 'var(--space-sm)',
                      alignItems: 'center',
                      marginBottom: 4,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>Policy #{policy.policyId}</span>
                    <Badge variant={stateBadgeVariants[policy.state]}>
                      {stateLabels[policy.state]}
                    </Badge>
                    <Badge variant={tierBadgeVariants[policy.riskTier]}>
                      {tierLabels[policy.riskTier]}
                    </Badge>
                  </div>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                    Coverage: ${formatUsdc(policy.coverageAmount)} &middot; Premium: $
                    {formatUsdc(policy.premiumPaid)}
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                    Expires: {new Date(policy.expiryTime).toLocaleDateString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Buy Policy Modal */}
      <Modal
        open={showBuyModal}
        onClose={() => setShowBuyModal(false)}
        title="Buy Insurance Policy"
      >
        <BuyPolicyForm onClose={() => setShowBuyModal(false)} />
      </Modal>
    </div>
  );
}

function BuyPolicyForm({ onClose }: { onClose: () => void }) {
  const [coverage, setCoverage] = useState('100');
  const [duration, setDuration] = useState('24');
  const [tier, setTier] = useState(0);
  const [quote, setQuote] = useState<any>(null);

  const getQuote = async () => {
    try {
      const q = await apiPost('/api/policies/quote', {
        coverageAmount: parseFloat(coverage) * 1_000_000,
        durationSeconds: parseFloat(duration) * 3600,
        riskTier: tier,
      });
      setQuote(q);
    } catch {
      // Handle error
    }
  };

  useEffect(() => {
    getQuote();
  }, [coverage, duration, tier]);

  return (
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
          Coverage (USDC)
        </label>
        <input
          type="number"
          value={coverage}
          onChange={(e) => setCoverage(e.target.value)}
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
      <div>
        <label
          style={{
            fontSize: '0.8125rem',
            color: 'var(--color-text-muted)',
            display: 'block',
            marginBottom: 4,
          }}
        >
          Duration (hours)
        </label>
        <input
          type="number"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
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
      <div>
        <label
          style={{
            fontSize: '0.8125rem',
            color: 'var(--color-text-muted)',
            display: 'block',
            marginBottom: 4,
          }}
        >
          Risk Tier
        </label>
        <select
          value={tier}
          onChange={(e) => setTier(Number(e.target.value))}
          style={{
            width: '100%',
            padding: '0.5rem',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-text)',
          }}
        >
          <option value={0}>LOW (1%)</option>
          <option value={1}>MEDIUM (2.5%)</option>
          <option value={2}>HIGH (5%)</option>
        </select>
      </div>
      {quote && (
        <div
          style={{
            background: 'var(--color-bg)',
            padding: 'var(--space-md)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
            Estimated Premium
          </p>
          <p style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-primary)' }}>
            ${formatUsdc(quote.premiumAmount)} USDC
          </p>
        </div>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
        <Button variant="secondary" onClick={onClose} style={{ flex: 1 }}>
          Cancel
        </Button>
        <Button style={{ flex: 1 }}>Buy Policy</Button>
      </div>
    </div>
  );
}
