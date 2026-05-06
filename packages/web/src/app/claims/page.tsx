'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ClaimVerificationPipeline } from '@/components/claims/ClaimVerificationPipeline';
import { apiGet } from '@/lib/api-client';
import { SOLANA_NETWORK } from '@/lib/constants';
import { useClaimsFeed } from '@/hooks/useClaimsFeed';
import {
  DEMO_TX_SIGNATURE_PREFIX,
  SOLANA_SIGNATURE_REGEX,
  TriggerType,
  formatUsdc,
  type Claim,
} from '@covantic/shared';

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
  if (sig.startsWith(DEMO_TX_SIGNATURE_PREFIX)) return null;
  // Only link to real Base58 signatures. Anything else is either a stub or
  // malformed server data; don't render a clickable link for it.
  if (!SOLANA_SIGNATURE_REGEX.test(sig)) return null;
  return `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=${encodeURIComponent(SOLANA_NETWORK)}`;
}

function formatRemaining(target: Date | string | null | undefined, nowMs: number): string | null {
  if (!target) return null;
  const t = target instanceof Date ? target.getTime() : new Date(target).getTime();
  if (!Number.isFinite(t)) return null;
  const ms = t - nowMs;
  if (ms <= 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function ClaimsPage() {
  const [initialClaims, setInitialClaims] = useState<Claim[]>([]);
  const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const claims = useClaimsFeed(initialClaims);

  useEffect(() => {
    apiGet<{ claims: Claim[] }>('/api/claims')
      .then((data) => setInitialClaims(data.claims))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const hasPending = claims.some(
      (c) => c.status === 'approved' && c.lockExpiresAt,
    );
    if (!hasPending) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [claims]);

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
                const countdown =
                  claim.status === 'approved'
                    ? formatRemaining(claim.lockExpiresAt, nowMs)
                    : null;
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
                      {countdown && (
                        <span style={{ color: 'var(--color-info)' }}>
                          {' '}&middot; pays out in {countdown}
                        </span>
                      )}
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
          <ClaimVerificationPipeline
            autoPlay={false}
            status={selectedClaim?.status ?? null}
            lockExpiresAt={selectedClaim?.lockExpiresAt ?? null}
          />
        </Card>
      </div>
    </div>
  );
}
