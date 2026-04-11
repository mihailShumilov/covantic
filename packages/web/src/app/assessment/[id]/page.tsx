'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { apiGet } from '@/lib/api-client';
import { shortenAddress } from '@covantic/shared';
import type { FactorDetail, CategoryRisk } from '@covantic/shared';
import { TIER_LABELS, TIER_BADGE_VARIANTS } from '@/lib/risk-labels';
import { ratingColor, ratingBg } from '@/lib/risk-colors';

interface StoredAssessment {
  assessmentId: string;
  agentAddress: string;
  score: number;
  tier: number;
  premiumBps: number;
  factors: Record<string, number>;
  factorDetails: FactorDetail[];
  categoryRisks: CategoryRisk[];
  overallConfidence: number;
  summary: string;
  recommendation: string;
  assessedAt: string;
  createdAt: string;
}

export default function AssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [assessment, setAssessment] = useState<StoredAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    apiGet<StoredAssessment>(`/api/assessments/${id}`)
      .then(setAssessment)
      .catch(() => setError('Assessment not found'))
      .finally(() => setLoading(false));
  }, [id]);

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-lg) var(--space-md)', maxWidth: 900, margin: '0 auto', textAlign: 'center' }}>
        <Spinner />
        <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-md)' }}>
          Loading assessment...
        </p>
      </div>
    );
  }

  if (error || !assessment) {
    return (
      <div style={{ padding: 'var(--space-lg) var(--space-md)', maxWidth: 900, margin: '0 auto', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 'var(--space-md)' }}>
          Assessment Not Found
        </h1>
        <p style={{ color: 'var(--color-text-muted)' }}>
          This assessment ID does not exist or has been removed.
        </p>
        <Button onClick={() => router.push('/dashboard')} style={{ marginTop: 'var(--space-lg)' }}>
          Go to Dashboard
        </Button>
      </div>
    );
  }

  const assessedDate = new Date(assessment.assessedAt);

  return (
    <div style={{ padding: 'var(--space-lg) var(--space-md)', maxWidth: 900, margin: '0 auto' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 'var(--space-lg)',
          flexWrap: 'wrap',
          gap: 'var(--space-md)',
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 auto' }}>
          <h1 style={{ fontSize: 'clamp(1.25rem, 3vw, 1.5rem)', fontWeight: 700, marginBottom: 4 }}>
            Risk Assessment
          </h1>
          <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)', wordBreak: 'break-all' }}>
            Agent: <span style={{ fontFamily: 'var(--font-mono)' }}>{assessment.agentAddress}</span>
          </p>
          <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
            Assessed on {assessedDate.toLocaleDateString()} at {assessedDate.toLocaleTimeString()}
            {' \u00B7 '}
            ID: <span style={{ fontFamily: 'var(--font-mono)' }}>{shortenAddress(assessment.assessmentId, 6)}</span>
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
          <Button variant="secondary" size="sm" onClick={handleCopyUrl}>
            {copied ? '\u2713 Copied!' : 'Share Link'}
          </Button>
          <Button size="sm" onClick={() => window.location.href = `/dashboard`}>
            New Assessment
          </Button>
        </div>
      </div>

      {/* Score card */}
      <Card style={{ marginBottom: 'var(--space-lg)' }}>
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-lg)',
            alignItems: 'center',
            padding: 'var(--space-sm)',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontSize: '0.6875rem',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'var(--color-text-muted)',
                marginBottom: 2,
              }}
            >
              Risk Score
            </div>
            <div
              style={{
                fontSize: '2.5rem',
                fontWeight: 800,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text)',
              }}
            >
              {assessment.score}
            </div>
          </div>
          <Badge variant={TIER_BADGE_VARIANTS[assessment.tier]}>
            {TIER_LABELS[assessment.tier]}
          </Badge>
          <div>
            <div
              style={{
                fontSize: '0.6875rem',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'var(--color-text-muted)',
                marginBottom: 2,
              }}
            >
              Annual Premium
            </div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>
              {assessment.premiumBps > 0 ? `${assessment.premiumBps / 100}%` : 'Not insurable'}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', minWidth: 'fit-content' }}>
            <div
              style={{
                fontSize: '0.6875rem',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'var(--color-text-muted)',
                marginBottom: 2,
              }}
            >
              Confidence
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
              <div
                style={{
                  width: 60,
                  height: 4,
                  background: 'var(--color-border)',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${assessment.overallConfidence * 100}%`,
                    height: '100%',
                    background:
                      assessment.overallConfidence > 0.7
                        ? 'var(--color-primary, #22c55e)'
                        : assessment.overallConfidence > 0.4
                          ? 'var(--color-warning, #eab308)'
                          : 'var(--color-danger, #ef4444)',
                    borderRadius: 2,
                  }}
                />
              </div>
              <span style={{ fontSize: '0.875rem', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                {Math.round(assessment.overallConfidence * 100)}%
              </span>
            </div>
          </div>
        </div>
      </Card>

      {/* Category breakdown */}
      {assessment.categoryRisks && assessment.categoryRisks.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 'var(--space-sm)',
            marginBottom: 'var(--space-lg)',
          }}
        >
          {assessment.categoryRisks.map((cat: CategoryRisk) => (
            <div
              key={cat.category}
              style={{
                padding: 'var(--space-md)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border)',
                background: ratingBg(cat.rating),
              }}
            >
              <div
                style={{
                  fontSize: '0.6875rem',
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 4,
                }}
              >
                {cat.label}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                <span
                  style={{
                    fontSize: '1.25rem',
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                    color: ratingColor(cat.rating),
                  }}
                >
                  {cat.score.toFixed(2)}
                </span>
                <span
                  style={{
                    fontSize: '0.625rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: ratingColor(cat.rating),
                    background: ratingBg(cat.rating),
                    padding: '1px 6px',
                    borderRadius: '9999px',
                  }}
                >
                  {cat.rating}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Factor details */}
      <Card title="Factor Analysis" style={{ marginBottom: 'var(--space-lg)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {assessment.factorDetails.map((detail: FactorDetail, index: number) => (
            <div
              key={index}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--space-sm)',
                padding: 'var(--space-sm) 0',
                borderBottom:
                  index < assessment.factorDetails.length - 1
                    ? '1px solid var(--color-border)'
                    : undefined,
              }}
            >
              {/* Score circle */}
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: ratingBg(detail.rating),
                  border: `2px solid ${ratingColor(detail.rating)}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.6875rem',
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono)',
                  color: ratingColor(detail.rating),
                  flexShrink: 0,
                }}
              >
                {detail.value.toFixed(1)}
              </div>

              <div style={{ flex: 1 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-sm)',
                    marginBottom: 2,
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: '0.875rem', color: ratingColor(detail.rating) }}>
                    {detail.label}
                  </span>
                  <span
                    style={{
                      fontSize: '0.625rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: ratingColor(detail.rating),
                      background: ratingBg(detail.rating),
                      padding: '1px 6px',
                      borderRadius: '9999px',
                    }}
                  >
                    {detail.rating}
                  </span>
                </div>
                <p
                  style={{
                    fontSize: '0.8125rem',
                    color: 'var(--color-text-muted)',
                    lineHeight: 1.5,
                    margin: 0,
                  }}
                >
                  {detail.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Summary & Recommendation */}
      <Card title="Assessment Summary" style={{ marginBottom: 'var(--space-lg)' }}>
        <p
          style={{
            fontSize: '0.875rem',
            color: 'var(--color-text)',
            lineHeight: 1.6,
            marginBottom: 'var(--space-md)',
          }}
        >
          {assessment.summary}
        </p>
        <p
          style={{
            fontSize: '0.8125rem',
            color: 'var(--color-text-muted)',
            lineHeight: 1.6,
            fontStyle: 'italic',
            padding: 'var(--space-sm) var(--space-md)',
            borderLeft: '3px solid var(--color-primary)',
            background: 'oklch(0.72 0.19 162 / 0.04)',
            borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
          }}
        >
          {assessment.recommendation}
        </p>
      </Card>
    </div>
  );
}
