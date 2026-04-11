'use client';

import { useState, useEffect, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { RiskAssessmentPipeline } from '@/components/risk/RiskAssessmentPipeline';
import { apiGet, apiPost } from '@/lib/api-client';
import { formatUsdc, type Policy } from '@covantic/shared';
import {
  TIER_LABELS,
  TIER_BADGE_VARIANTS,
  STATE_LABELS,
  STATE_BADGE_VARIANTS,
} from '@/lib/risk-labels';

interface RiskApiResponse {
  assessmentId: string;
  agentAddress: string;
  score: number;
  tier: number;
  premiumBps: number;
  factors: Record<string, number>;
  factorDetails: any[];
  categoryRisks: any[];
  weightInfo: any[];
  dataAvailability: any;
  overallConfidence: number;
  summary: string;
  recommendation: string;
  assessedAt: string;
}

export default function DashboardPage() {
  const { publicKey } = useWallet();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [showBuyModal, setShowBuyModal] = useState(false);
  const [riskResult, setRiskResult] = useState<RiskApiResponse | null>(null);
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

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const handleGetRisk = async () => {
    if (!agentAddress || isAssessing) return;

    // 1. Clear previous results and start pipeline animation (fetching phase)
    setRiskResult(null);
    setIsAssessing(true);
    setPipelineKey((k) => k + 1);

    // 2. Fire API call — pipeline shows "fetching" animation until result arrives
    try {
      const result = await apiGet<RiskApiResponse>(`/api/risk/${agentAddress}`);
      setRiskResult(result);
      // Update URL to shareable assessment link without navigating away
      if (result.assessmentId && UUID_RE.test(result.assessmentId)) {
        window.history.replaceState(null, '', `/assessment/${result.assessmentId}`);
      }
    } catch {
      setRiskResult(null);
    }
  };

  const handlePipelineComplete = () => {
    setIsAssessing(false);
  };

  return (
    <div style={{ padding: 'var(--space-lg) var(--space-md)', maxWidth: 1200, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--space-xl)',
          flexWrap: 'wrap',
          gap: 'var(--space-sm)',
        }}
      >
        <h1 style={{ fontSize: 'clamp(1.25rem, 3vw, 1.5rem)', fontWeight: 700 }}>Agent Dashboard</h1>
        <Button onClick={() => setShowBuyModal(true)}>Buy Policy</Button>
      </div>

      {/* Risk Assessment */}
      <Card title="Risk Assessment" style={{ marginBottom: 'var(--space-lg)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
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
          <Button onClick={handleGetRisk} size="md" disabled={isAssessing} style={{ flexShrink: 0, width: 'auto' }}>
            {isAssessing ? 'Scanning...' : 'Assess Risk'}
          </Button>
        </div>

        {/* Animated pipeline — stays visible after completion */}
        {pipelineKey > 0 && (
          <RiskAssessmentPipeline
            key={pipelineKey}
            result={riskResult as any}
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
                  flexWrap: 'wrap',
                  gap: 'var(--space-sm)',
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
                    <Badge variant={STATE_BADGE_VARIANTS[policy.state]}>
                      {STATE_LABELS[policy.state]}
                    </Badge>
                    <Badge variant={TIER_BADGE_VARIANTS[policy.riskTier]}>
                      {TIER_LABELS[policy.riskTier]}
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Debounce: wait 400ms after the last change before hitting the API.
    // This prevents hammering /api/policies/quote on every keystroke.
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      const coverageNum = parseFloat(coverage);
      const durationNum = parseFloat(duration);
      // Only fetch if the values are valid positive numbers
      if (!isFinite(coverageNum) || coverageNum <= 0 || !isFinite(durationNum) || durationNum <= 0) {
        return;
      }
      try {
        const q = await apiPost('/api/policies/quote', {
          coverageAmount: coverageNum * 1_000_000,
          durationSeconds: durationNum * 3600,
          riskTier: tier,
        });
        setQuote(q);
      } catch {
        // Handle error
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
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
