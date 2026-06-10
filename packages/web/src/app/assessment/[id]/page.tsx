'use client';

import { useState, useEffect, useMemo, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api-client';
import { shortenAddress } from '@covantic/shared';
import type { FactorDetail, CategoryRisk, RiskCategory } from '@covantic/shared';
import { TIER_LABELS } from '@/lib/risk-labels';
import {
  CovRingGauge,
  CovStatusBadge,
  HexFlicker,
  Reveal,
  statusColor,
  useCountUp,
} from '@/components/cov/visuals';

interface StoredAssessment {
  assessmentId: string;
  agentAddress: string;
  score: number;
  tier: number;
  premiumBps: number | null;
  isInsurable?: boolean;
  factors: Record<string, number>;
  factorDetails: FactorDetail[];
  categoryRisks: CategoryRisk[];
  overallConfidence: number;
  summary: string;
  recommendation: string;
  assessedAt: string;
  createdAt: string;
}

/* Flavor lines streamed in the scan log, keyed by category */
const SCAN_LOG: Record<RiskCategory, string[]> = {
  transaction_behavior: ['fetching transaction history…', 'transactions indexed', 'computing failure & cadence metrics'],
  protocol_defi: ['resolving program interactions…', 'cross-referencing audit registry', 'simulating MEV exposure paths'],
  wallet_identity: ['tracing wallet lineage…', 'sampling counterparty graph', 'scoring identity persistence'],
  portfolio: ['snapshotting token accounts…', 'pricing portfolio via oracle feeds', 'stress-testing balance floors'],
  behavioral_patterns: ['building temporal activity model…', 'running anomaly detector', 'fitting risk trend regression'],
};

const rating = (r: string) => r.toUpperCase();

/* ============ SCAN PHASE ============ */

function ScanSignalRow({ sig, state }: { sig: FactorDetail; state: 'pending' | 'active' | 'done' }) {
  const color = statusColor(sig.rating);
  return (
    <div className="cov-signal-row" style={{ opacity: state === 'pending' ? 0.28 : 1, transition: 'opacity .3s' }}>
      <div style={{ paddingTop: 3 }}>
        {state === 'done' ? (
          <svg width="16" height="16" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="7" fill="none" stroke={color} strokeWidth="1.5" />
            <path d="M5 8.2 7.2 10.4 11 5.8" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : state === 'active' ? (
          <div className="cov-pulse" style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--c-info)', margin: 4 }} />
        ) : (
          <div style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--border-strong)', margin: 5 }} />
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 0, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{sig.label}</span>
        {state === 'active' && <HexFlicker />}
        {state === 'done' && (
          <>
            <CovStatusBadge status={rating(sig.rating)} />
            <span className="cov-mono" style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
              {sig.value.toFixed(2)}
            </span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {state === 'active' && (
          <span className="cov-label cov-pulse" style={{ color: 'var(--c-info)' }}>
            analyzing
          </span>
        )}
      </div>
    </div>
  );
}

function ScanPhase({ assessment, onComplete }: { assessment: StoredAssessment; onComplete: () => void }) {
  const categories = assessment.categoryRisks;
  const signals = useMemo(
    () => categories.flatMap((cat) => assessment.factorDetails.filter((f) => f.category === cat.category)),
    [assessment, categories],
  );
  const [step, setStep] = useState(0); // index of signal currently analyzing; signals.length = done
  const [log, setLog] = useState<string[]>(['initializing risk engine v2.4', 'connected to Solana']);
  const doneRef = useRef(false);

  const baseMs = 620;

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onComplete();
      return;
    }
  }, []);

  useEffect(() => {
    if (step >= signals.length) {
      const t = setTimeout(() => {
        if (!doneRef.current) {
          doneRef.current = true;
          onComplete();
        }
      }, 900);
      return () => clearTimeout(t);
    }
    const sig = signals[step]!;
    const lines = SCAN_LOG[sig.category] ?? ['analyzing…'];
    const line = lines[step % lines.length]!;
    setLog((l) => [...l.slice(-5), line]);
    const t = setTimeout(() => setStep((s) => s + 1), baseMs * (0.75 + ((step * 7919) % 10) / 18));
    return () => clearTimeout(t);
  }, [step, signals.length]);

  const progress = signals.length ? Math.min(1, step / signals.length) : 1;
  const conf = Math.round(assessment.overallConfidence * 100 * progress);

  return (
    <div className="cov-page" style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
        <span className="cov-label" style={{ color: 'var(--c-info)' }}>
          Risk assessment
        </span>
        <span className="cov-mono" style={{ fontSize: 12.5, color: 'var(--text-dim)', wordBreak: 'break-all', whiteSpace: 'normal' }}>
          {assessment.agentAddress}
        </span>
      </div>
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 'var(--display-weight)' as never,
          letterSpacing: 'var(--display-tracking)',
          fontSize: 34,
          marginBottom: 26,
        }}
      >
        Scanning agent<span className="cov-pulse">…</span>
      </h1>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 30 }}>
        <div className="cov-track" style={{ flex: 1 }}>
          <div style={{ width: `${progress * 100}%`, background: 'var(--c-info)' }} />
        </div>
        <span className="cov-mono" style={{ fontSize: 12, color: 'var(--text-dim)', minWidth: 110, textAlign: 'right' }}>
          {Math.min(step, signals.length)}/{signals.length} · conf {conf}%
        </span>
        <button
          className="cov-btn-ghost"
          onClick={() => {
            if (!doneRef.current) {
              doneRef.current = true;
              onComplete();
            }
          }}
        >
          Skip
        </button>
      </div>

      <div style={{ display: 'grid', gap: 14 }}>
        {categories.map((cat) => {
          const catSignals = signals.filter((s) => s.category === cat.category);
          const firstIdx = signals.indexOf(catSignals[0]!);
          const lastIdx = signals.indexOf(catSignals[catSignals.length - 1]!);
          const visible = step >= firstIdx;
          const allDone = lastIdx < step;
          return (
            <div key={cat.category} className="cov-card" style={{ padding: '14px 22px', opacity: visible ? 1 : 0.22, transition: 'opacity .4s' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                <span className="cov-label" style={{ color: allDone ? 'var(--text-dim)' : visible ? 'var(--c-info)' : undefined }}>
                  {cat.label}
                </span>
                {allDone && (
                  <span className="cov-mono" style={{ fontSize: 11, color: statusColor(cat.rating) }}>
                    {cat.score.toFixed(2)} {rating(cat.rating)}
                  </span>
                )}
              </div>
              {visible &&
                catSignals.map((sig) => {
                  const i = signals.indexOf(sig);
                  const st = i < step ? 'done' : i === step ? 'active' : 'pending';
                  return <ScanSignalRow key={sig.factor} sig={sig} state={st} />;
                })}
            </div>
          );
        })}
      </div>

      <div className="cov-mono" style={{ marginTop: 26, fontSize: 11.5, color: 'var(--text-faint)', display: 'grid', gap: 4 }}>
        {log.map((l, i) => (
          <div key={`${i}-${l}`} style={{ opacity: 0.35 + (i / log.length) * 0.65 }}>
            <span style={{ color: 'var(--c-info)', marginRight: 8 }}>›</span>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============ REPORT PHASE ============ */

function ReportSignalRow({ sig }: { sig: FactorDetail }) {
  const color = statusColor(sig.rating);
  return (
    <div className="cov-signal-row">
      <div style={{ paddingTop: 4 }}>
        <div style={{ width: 8, height: 8, borderRadius: 99, background: color, margin: 4 }} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{sig.label}</span>
          <CovStatusBadge status={rating(sig.rating)} />
          <span className="cov-mono" style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            {sig.value.toFixed(2)}
          </span>
        </div>
        <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-dim)', marginTop: 4, textWrap: 'pretty' }}>{sig.description}</p>
      </div>
    </div>
  );
}

function CategoryMiniCard({ cat, delay }: { cat: CategoryRisk; delay: number }) {
  const color = statusColor(cat.rating);
  return (
    <Reveal className="cov-card" delay={delay} style={{ padding: '16px 18px', minWidth: 0 }}>
      <div className="cov-label" style={{ marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {cat.label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="cov-mono" style={{ fontSize: 24, fontWeight: 700, color }}>
          {cat.score.toFixed(2)}
        </span>
        <CovStatusBadge status={rating(cat.rating)} />
      </div>
      <div className="cov-track" style={{ marginTop: 12 }}>
        <div style={{ width: `${Math.min(1, cat.score) * 100}%`, background: color }} />
      </div>
    </Reveal>
  );
}

function ReportPhase({
  assessment,
  onReplay,
}: {
  assessment: StoredAssessment;
  onReplay: () => void;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const p = assessment;
  const confidencePct = Math.round(p.overallConfidence * 100);
  const conf = useCountUp(confidencePct, { duration: 1400, decimals: 0 });
  const insurable = p.isInsurable ?? (p.premiumBps != null && p.premiumBps > 0);
  const tierLabel = TIER_LABELS[p.tier] ?? '—';
  const verdictColor = insurable ? 'var(--c-low)' : 'var(--c-critical)';
  const verdict = insurable
    ? `Agent qualifies for ${tierLabel}-tier parametric coverage.`
    : 'Agent exceeds acceptable risk thresholds and is not insurable.';

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const assessedDate = new Date(p.assessedAt);

  return (
    <div className="cov-page">
      {/* header row */}
      <Reveal style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 22, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div className="cov-label" style={{ color: 'var(--c-info)', marginBottom: 6 }}>
            Risk assessment · complete
          </div>
          <div className="cov-mono" style={{ fontSize: 13, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
            {p.agentAddress}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <span className="cov-mono" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
          {p.factorDetails.length} factors · {p.categoryRisks.length} categories ·{' '}
          {assessedDate.toLocaleDateString()} · {shortenAddress(p.assessmentId, 6)}
        </span>
        <button className="cov-btn-ghost" onClick={handleCopyUrl}>
          {copied ? '✓ copied' : 'Share link'}
        </button>
        <button className="cov-btn-ghost" onClick={onReplay}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9" />
            <path d="M2.5 12.5V8.8h3.7" />
          </svg>
          Replay scan
        </button>
      </Reveal>

      {/* hero */}
      <Reveal
        className="cov-card"
        delay={60}
        style={{ padding: 32, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 44, alignItems: 'center' }}
      >
        <div style={{ justifySelf: 'center' }}>
          <CovRingGauge value={p.score} label={tierLabel} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, marginBottom: 22 }}>
            <div>
              <div className="cov-label" style={{ marginBottom: 8 }}>
                Annual premium
              </div>
              {insurable && p.premiumBps != null ? (
                <>
                  <div
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontWeight: 'var(--display-weight)' as never,
                      fontSize: 30,
                      letterSpacing: 'var(--display-tracking)',
                    }}
                  >
                    {(p.premiumBps / 100).toFixed(2)}%
                  </div>
                  <div className="cov-mono" style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                    annualized rate on covered amount
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 'var(--display-weight)' as never,
                    fontSize: 30,
                    letterSpacing: 'var(--display-tracking)',
                    color: 'var(--c-critical)',
                  }}
                >
                  Not insurable
                </div>
              )}
            </div>
            <div>
              <div className="cov-label" style={{ marginBottom: 8 }}>
                {insurable ? 'Coverage tier' : 'Eligibility'}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 'var(--display-weight)' as never,
                  fontSize: 30,
                  letterSpacing: 'var(--display-tracking)',
                }}
              >
                {insurable ? tierLabel : 'Declined'}
              </div>
              <div className="cov-mono" style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                {insurable ? 'deterministic triggers · instant payout' : 'reapply after remediation'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="cov-label">Assessment confidence</span>
            <div className="cov-track" style={{ width: 160 }}>
              <div style={{ width: `${confidencePct}%`, background: confidencePct > 50 ? 'var(--c-low)' : 'var(--c-high)' }} />
            </div>
            <span className="cov-mono" style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
              {conf}%
            </span>
          </div>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-dim)', marginTop: 18, textWrap: 'pretty' }}>{p.summary}</p>
        </div>
      </Reveal>

      {/* category cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: 14, margin: '14px 0' }}>
        {p.categoryRisks.map((cat, i) => (
          <CategoryMiniCard key={cat.category} cat={cat} delay={160 + i * 90} />
        ))}
      </div>

      {/* signals by category */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
        {p.categoryRisks.map((cat, i) => (
          <Reveal key={cat.category} className="cov-card" delay={500 + i * 80} style={{ padding: '18px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
              <span className="cov-label">{cat.label}</span>
              <span className="cov-mono" style={{ fontSize: 11.5, color: statusColor(cat.rating) }}>
                {cat.score.toFixed(2)}
              </span>
            </div>
            {p.factorDetails
              .filter((s) => s.category === cat.category)
              .map((sig) => (
                <ReportSignalRow key={sig.factor} sig={sig} />
              ))}
          </Reveal>
        ))}

        {/* recommendation fills the last grid cell */}
        <Reveal className="cov-card" delay={900} style={{ padding: '18px 24px' }}>
          <div className="cov-label" style={{ marginBottom: 10 }}>
            Underwriter recommendation
          </div>
          <p style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--text-dim)', textWrap: 'pretty' }}>{p.recommendation}</p>
        </Reveal>
      </div>

      {/* verdict */}
      <Reveal
        className="cov-card"
        delay={1000}
        style={{ marginTop: 14, padding: '18px 24px', borderColor: verdictColor, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}
      >
        <div style={{ width: 10, height: 10, borderRadius: 99, background: verdictColor, flexShrink: 0 }} />
        <span style={{ fontSize: 14.5, fontWeight: 600, color: verdictColor }}>{verdict}</span>
        <span style={{ flex: 1 }} />
        {insurable && (
          <button className="cov-btn-primary" onClick={() => router.push('/dashboard')}>
            Purchase coverage
          </button>
        )}
      </Reveal>

      {/* next step */}
      <Reveal className="cov-card" delay={1100} style={{ marginTop: 14, padding: '22px 24px' }}>
        <div className="cov-label" style={{ marginBottom: 14 }}>
          New assessment
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <p style={{ fontSize: 13.5, color: 'var(--text-dim)' }}>
            Score another agent across {p.factorDetails.length} on-chain factors from the dashboard.
          </p>
          <span style={{ flex: 1 }} />
          <button className="cov-btn-primary" onClick={() => router.push('/dashboard')}>
            Assess new agent
          </button>
        </div>
      </Reveal>
    </div>
  );
}

/* ============ PAGE ============ */

export default function AssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [assessment, setAssessment] = useState<StoredAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<'scan' | 'report'>('scan');
  const [scanKey, setScanKey] = useState(0);

  useEffect(() => {
    apiGet<StoredAssessment>(`/api/assessments/${id}`)
      .then(setAssessment)
      .catch(() => setError('Assessment not found'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="cov-page" style={{ maxWidth: 760 }}>
        <div className="cov-label cov-pulse" style={{ color: 'var(--c-info)' }}>
          initializing risk engine…
        </div>
      </div>
    );
  }

  if (error || !assessment) {
    return (
      <div className="cov-page" style={{ maxWidth: 760 }}>
        <div className="cov-label" style={{ color: 'var(--c-critical)', marginBottom: 12 }}>
          Assessment not found
        </div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 'var(--display-weight)' as never,
            letterSpacing: 'var(--display-tracking)',
            fontSize: 34,
            marginBottom: 14,
          }}
        >
          Nothing at this address.
        </h1>
        <p style={{ fontSize: 13.5, color: 'var(--text-dim)', marginBottom: 26 }}>
          This assessment ID does not exist or has been removed.
        </p>
        <button className="cov-btn-primary" onClick={() => router.push('/dashboard')}>
          Go to Dashboard
        </button>
      </div>
    );
  }

  return phase === 'scan' ? (
    <ScanPhase key={scanKey} assessment={assessment} onComplete={() => setPhase('report')} />
  ) : (
    <ReportPhase
      assessment={assessment}
      onReplay={() => {
        setScanKey((k) => k + 1);
        setPhase('scan');
      }}
    />
  );
}
