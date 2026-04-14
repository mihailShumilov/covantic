'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ClaimVerificationPipeline } from '@/components/claims/ClaimVerificationPipeline';
import { apiGet } from '@/lib/api-client';
import { SOLANA_NETWORK } from '@/lib/constants';
import { useClaimsFeed } from '@/hooks/useClaimsFeed';
import { formatUsdc, type Claim, TriggerType } from '@covantic/shared';

const triggerLabels: Record<number, string> = {
  [TriggerType.Exploit]: 'Exploit',
  [TriggerType.OracleManipulation]: 'Oracle Manipulation',
  [TriggerType.AgentError]: 'Agent Error',
  [TriggerType.GovernanceAttack]: 'Governance Attack',
};

const statusVariants: Record<
  string,
  'warning' | 'info' | 'success' | 'danger' | 'neutral'
> = {
  pending: 'warning',
  verifying: 'info',
  approved: 'success',
  paid: 'success',
  rejected: 'danger',
  failed: 'danger',
};

function explorerTxUrl(sig: string | null | undefined): string | null {
  if (!sig || sig.length === 0) return null;
  // Synthetic demo signatures (`demo_…`) are not real on-chain txs; skip the link.
  if (sig.startsWith('demo_')) return null;
  return `https://explorer.solana.com/tx/${sig}?cluster=${SOLANA_NETWORK}`;
}

export default function ClaimsPage() {
  const [initialClaims, setInitialClaims] = useState<Claim[]>([]);
  const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);
  const claims = useClaimsFeed(initialClaims);

  useEffect(() => {
    apiGet<{ claims: Claim[] }>('/api/claims')
      .then((data) => setInitialClaims(data.claims))
      .catch(() => {});
  }, []);

  // Keep the selected claim row in sync with feed updates.
  useEffect(() => {
    if (!selectedClaim) return;
    const live = claims.find((c) => c.id === selectedClaim.id);
    if (live && live !== selectedClaim) setSelectedClaim(live);
  }, [claims, selectedClaim]);

  return (
    <div style={{ padding: 'var(--space-xl)', maxWidth: 1200, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 'var(--space-xl)' }}>
        Claims Feed
      </h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-lg)' }}>
        {/* Claims List */}
        <Card title="Recent Claims">
          {claims.length === 0 ? (
            <p
              style={{
                color: 'var(--color-text-muted)',
                textAlign: 'center',
                padding: 'var(--space-xl)',
              }}
            >
              No claims yet. Trigger one from /demo or wait for a monitored incident.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              {claims.map((claim) => {
                const submitUrl = explorerTxUrl(claim.submitTxSignature);
                const payoutUrl = explorerTxUrl(claim.payoutTxSignature);
                return (
                  <div
                    key={claim.id}
                    onClick={() => setSelectedClaim(claim)}
                    style={{
                      padding: 'var(--space-md)',
                      background:
                        selectedClaim?.id === claim.id
                          ? 'var(--color-surface-hover)'
                          : 'var(--color-bg)',
                      borderRadius: 'var(--radius-md)',
                      cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>Policy #{claim.policyId}</span>
                      <Badge variant={statusVariants[claim.status] ?? 'neutral'}>
                        {claim.status}
                      </Badge>
                    </div>
                    <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                      {triggerLabels[claim.triggerType] ?? 'Unknown'} &middot;
                      {claim.payoutAmount ? ` $${formatUsdc(claim.payoutAmount)}` : ' Pending'}
                    </p>
                    {(submitUrl || payoutUrl) && (
                      <div
                        style={{
                          marginTop: 4,
                          display: 'flex',
                          gap: 'var(--space-md)',
                          fontSize: '0.75rem',
                        }}
                      >
                        {submitUrl && (
                          <a
                            href={submitUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ color: 'var(--color-accent)' }}
                          >
                            Submit tx ↗
                          </a>
                        )}
                        {payoutUrl && (
                          <a
                            href={payoutUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ color: 'var(--color-accent)' }}
                          >
                            Payout tx ↗
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Verification Pipeline */}
        <Card title="Verification Pipeline">
          <ClaimVerificationPipeline autoPlay={false} status={selectedClaim?.status ?? null} />
        </Card>
      </div>
    </div>
  );
}
