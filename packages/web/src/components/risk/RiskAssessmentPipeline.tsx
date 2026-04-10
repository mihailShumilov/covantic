'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Badge } from '@/components/ui/Badge';
import { TIER_LABELS, TIER_BADGE_VARIANTS } from '@/lib/risk-labels';
import type { FactorDetail, RiskAssessment, CategoryRisk } from '@covantic/shared';

type RiskResult = RiskAssessment & {
  agentAddress: string;
  cached?: boolean;
};

interface Props {
  result: RiskResult | null;
  onComplete: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCAN STEPS — 15 factors across 5 categories
// ═══════════════════════════════════════════════════════════════════════════════

const SCAN_STEPS = [
  // ── Transaction Behavior ──────────────────────────────
  {
    factorKey: 'failedTxRatio',
    icon: '\u26A0',
    title: 'Transaction Failure Rate',
    category: 'Transaction Behavior',
    scanPhases: [
      'Applying time-weighted decay to recent failures...',
      'Computing exponential failure ratio...',
      'Scoring transaction reliability...',
    ],
  },
  {
    factorKey: 'avgSlippage',
    icon: '\u21C5',
    title: 'Swap Slippage Analysis',
    category: 'Transaction Behavior',
    scanPhases: [
      'Isolating DEX swap records from Jupiter, Orca, Raydium...',
      'Computing trimmed-mean slippage with outlier removal...',
      'Benchmarking against pool liquidity depth...',
    ],
  },
  {
    factorKey: 'txVelocityAnomaly',
    icon: '\u26A1',
    title: 'Transaction Velocity',
    category: 'Transaction Behavior',
    scanPhases: [
      'Building 6-hour activity buckets from tx history...',
      'Computing statistical z-scores for velocity spikes...',
      'Analyzing coefficient of variation vs baseline...',
    ],
  },
  {
    factorKey: 'sandwichVictim',
    icon: '\uD83E\uDD69',
    title: 'MEV Sandwich Exposure',
    category: 'Transaction Behavior',
    scanPhases: [
      'Scanning swap transactions for sandwich attack patterns...',
      'Detecting frontrun/backrun indicators in token transfers...',
      'Measuring MEV extraction vulnerability score...',
    ],
  },
  // ── Protocol & DeFi Risk ──────────────────────────────
  {
    factorKey: 'protocolConcentration',
    icon: '\u2B2A',
    title: 'Protocol Concentration',
    category: 'Protocol & DeFi',
    scanPhases: [
      'Mapping all program ID interactions...',
      'Computing Herfindahl-Hirschman Index (HHI)...',
      'Evaluating single-protocol dependency risk...',
    ],
  },
  {
    factorKey: 'riskyProtocolExposure',
    icon: '\uD83D\uDEE1',
    title: 'Risky Protocol Exposure',
    category: 'Protocol & DeFi',
    scanPhases: [
      'Cross-referencing interactions with verified program registry...',
      'Flagging bridge, flash loan, and unverified contracts...',
      'Scoring exposure to high-risk program categories...',
    ],
  },
  {
    factorKey: 'defiComplexity',
    icon: '\u2699',
    title: 'DeFi Complexity',
    category: 'Protocol & DeFi',
    scanPhases: [
      'Classifying operation types (swap, bridge, leverage, multi-hop)...',
      'Counting inner instruction depth and composability layers...',
      'Rating overall DeFi complexity and composability risk...',
    ],
  },
  // ── Wallet & Identity ─────────────────────────────────
  {
    factorKey: 'walletAge',
    icon: '\u29D6',
    title: 'Wallet Maturity',
    category: 'Wallet & Identity',
    scanPhases: [
      'Tracing wallet creation via account info API...',
      'Applying non-linear maturity curve scoring...',
      'Factoring earliest transaction timestamp...',
    ],
  },
  {
    factorKey: 'solBalanceHealth',
    icon: '\u25C9',
    title: 'SOL Balance Health',
    category: 'Wallet & Identity',
    scanPhases: [
      'Estimating gas fee runway from historical avg fee...',
      'Computing transaction sustainability projection...',
      'Scoring operational sustainability...',
    ],
  },
  {
    factorKey: 'fundingSourceConcentration',
    icon: '\u2B95',
    title: 'Funding Source Analysis',
    category: 'Wallet & Identity',
    scanPhases: [
      'Tracing incoming transfers (SOL + tokens)...',
      'Mapping unique funding source addresses...',
      'Computing funding HHI concentration index...',
    ],
  },
  // ── Portfolio Risk ────────────────────────────────────
  {
    factorKey: 'tokenConcentration',
    icon: '\u25CE',
    title: 'Token Concentration',
    category: 'Portfolio',
    scanPhases: [
      'Enumerating SPL token balances + native SOL...',
      'Computing Herfindahl-Hirschman portfolio index...',
      'Measuring single-asset exposure risk...',
    ],
  },
  {
    factorKey: 'portfolioValueRisk',
    icon: '\uD83D\uDCB0',
    title: 'Portfolio Size',
    category: 'Portfolio',
    scanPhases: [
      'Estimating total portfolio value in USDC terms...',
      'Factoring stablecoin holdings + SOL balance...',
      'Scoring capital adequacy against operation scale...',
    ],
  },
  {
    factorKey: 'stablecoinRatio',
    icon: '\uD83D\uDFE2',
    title: 'Stablecoin Allocation',
    category: 'Portfolio',
    scanPhases: [
      'Identifying stablecoin mints (USDC, USDT, USDS)...',
      'Computing stable vs volatile asset ratio...',
      'Assessing portfolio volatility exposure...',
    ],
  },
  // ── Behavioral Patterns ───────────────────────────────
  {
    factorKey: 'activityRegularity',
    icon: '\uD83D\uDCC8',
    title: 'Activity Regularity',
    category: 'Behavioral Patterns',
    scanPhases: [
      'Computing inter-transaction time intervals...',
      'Calculating coefficient of variation (CV)...',
      'Scoring scheduling consistency and stability...',
    ],
  },
  {
    factorKey: 'recentRiskTrend',
    icon: '\uD83D\uDD0D',
    title: 'Risk Trend Analysis',
    category: 'Behavioral Patterns',
    scanPhases: [
      'Splitting history into recent (30%) vs baseline (70%)...',
      'Comparing failure rates and complexity trends...',
      'Projecting risk trajectory from behavioral shift...',
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// DATA FETCHING ANIMATION — shown while waiting for API
// ═══════════════════════════════════════════════════════════════════════════════

const FETCH_PHASES = [
  { text: 'Connecting to Solana devnet RPC...', icon: '\uD83C\uDF10' },
  { text: 'Fetching transaction signatures...', icon: '\uD83D\uDD17' },
  { text: 'Parsing on-chain transaction details...', icon: '\uD83D\uDCE6' },
  { text: 'Reading SPL token balances...', icon: '\uD83E\uDE99' },
  { text: 'Querying native SOL balance...', icon: '\u25C7' },
  { text: 'Resolving account creation history...', icon: '\uD83D\uDD52' },
  { text: 'Indexing program interactions...', icon: '\u2699' },
  { text: 'Mapping token transfer flows...', icon: '\u2B95' },
  { text: 'Building wallet activity profile...', icon: '\uD83D\uDCCA' },
  { text: 'Preparing data for risk analysis...', icon: '\u2713' },
];

function DataFetchingAnimation() {
  const [currentPhase, setCurrentPhase] = useState(0);
  const [progress, setProgress] = useState(0);
  const [dots, setDots] = useState('');

  useEffect(() => {
    // Cycle through phases
    const phaseTimer = setInterval(() => {
      setCurrentPhase((p) => (p + 1) % FETCH_PHASES.length);
    }, 2200);

    // Animate progress bar (indeterminate but with forward motion)
    const progressTimer = setInterval(() => {
      setProgress((p) => {
        // Asymptotic approach — gets slower as it approaches 90%
        const remaining = 0.92 - p;
        return p + remaining * 0.008;
      });
    }, 50);

    // Animate dots
    const dotTimer = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : d + '.'));
    }, 400);

    return () => {
      clearInterval(phaseTimer);
      clearInterval(progressTimer);
      clearInterval(dotTimer);
    };
  }, []);

  const phase = FETCH_PHASES[currentPhase]!;

  return (
    <div
      style={{
        marginTop: 'var(--space-lg)',
        padding: 'var(--space-lg)',
        background: 'var(--color-surface-hover)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--color-border)',
        animation: 'fadeIn 0.4s ease-out',
      }}
    >
      {/* Main animation area */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
        {/* Spinning orb */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, oklch(0.62 0.19 250 / 0.2), oklch(0.72 0.19 162 / 0.2))',
            border: '2px solid var(--color-info)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.25rem',
            animation: 'spin 3s linear infinite',
            flexShrink: 0,
          }}
        >
          <span style={{ animation: 'spin 3s linear infinite reverse' }}>{phase.icon}</span>
        </div>

        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: '0.9375rem',
              fontWeight: 600,
              color: 'var(--color-text)',
              marginBottom: 4,
            }}
          >
            Collecting On-Chain Data{dots}
          </div>
          <div
            style={{
              fontSize: '0.8125rem',
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-info)',
              minHeight: 20,
            }}
            className="animate-pulse"
          >
            {phase.text}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div
        style={{
          width: '100%',
          height: 4,
          background: 'var(--color-border)',
          borderRadius: 2,
          overflow: 'hidden',
          marginBottom: 'var(--space-sm)',
        }}
      >
        <div
          style={{
            width: `${progress * 100}%`,
            height: '100%',
            background: 'linear-gradient(90deg, var(--color-info), var(--color-primary, #22c55e))',
            borderRadius: 2,
            transition: 'width 0.1s linear',
          }}
        />
      </div>

      {/* Data stream visualization */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-xs)',
          flexWrap: 'wrap',
          opacity: 0.5,
        }}
      >
        {['Signatures', 'Balances', 'Tokens', 'Programs', 'Transfers'].map((label, i) => (
          <span
            key={label}
            style={{
              fontSize: '0.6875rem',
              fontFamily: 'var(--font-mono)',
              color: progress > (i + 1) * 0.15 ? 'var(--color-primary, #22c55e)' : 'var(--color-text-muted)',
              padding: '2px 8px',
              borderRadius: 'var(--radius-sm)',
              background: progress > (i + 1) * 0.15
                ? 'oklch(0.72 0.19 162 / 0.1)'
                : 'var(--color-surface-hover)',
              border: '1px solid',
              borderColor: progress > (i + 1) * 0.15 ? 'oklch(0.72 0.19 162 / 0.2)' : 'var(--color-border)',
              transition: 'all 0.5s ease',
            }}
          >
            {progress > (i + 1) * 0.15 ? '\u2713 ' : ''}{label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

import { ratingColor, ratingBg } from '@/lib/risk-colors';

type StepState = 'pending' | 'scanning' | 'done';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT — 3 phases: Fetching → Analyzing → Complete
// ═══════════════════════════════════════════════════════════════════════════════

export function RiskAssessmentPipeline({ result, onComplete }: Props) {
  const [phase, setPhase] = useState<'fetching' | 'analyzing' | 'complete'>('fetching');
  const [stepStates, setStepStates] = useState<StepState[]>(SCAN_STEPS.map(() => 'pending'));
  const [phaseIndex, setPhaseIndex] = useState<number[]>(SCAN_STEPS.map(() => 0));
  const [showSummary, setShowSummary] = useState(false);
  const [progressBars, setProgressBars] = useState<number[]>(SCAN_STEPS.map(() => 0));
  const animating = useRef(true);
  const analysisStarted = useRef(false);

  // Map factorKeys to factorDetail results
  const factorDetailMap = useRef<Map<string, FactorDetail>>(new Map());

  // When result arrives, build factor map and transition from fetching → analyzing
  useEffect(() => {
    if (!result) return;

    // Build mapping from factorKey to factorDetail (key-based, order-independent)
    const map = new Map<string, FactorDetail>();
    for (const detail of result.factorDetails) {
      if (detail.factor) {
        map.set(detail.factor, detail);
      }
    }
    factorDetailMap.current = map;

    // Transition to analysis phase (only once)
    if (!analysisStarted.current) {
      analysisStarted.current = true;
      // Small delay for the "data received" transition
      const tid = setTimeout(() => {
        setPhase('analyzing');
      }, 600);
      return () => clearTimeout(tid);
    }
  }, [result]);

  // Run analysis animation only when phase becomes 'analyzing'
  const runAnalysis = useCallback(() => {
    let step = 0;

    const runStep = () => {
      if (!animating.current || step >= SCAN_STEPS.length) {
        if (step >= SCAN_STEPS.length) {
          setTimeout(() => {
            if (animating.current) {
              setShowSummary(true);
              setPhase('complete');
            }
            setTimeout(() => onComplete(), 500);
          }, 600);
        }
        return;
      }

      // Mark step as scanning
      setStepStates((prev) => prev.map((s, i) => (i === step ? 'scanning' : s)));

      const phases = SCAN_STEPS[step]!.scanPhases;
      const totalDuration = 1200 + Math.random() * 1300; // 1.2-2.5s per factor
      const phaseInterval = totalDuration / phases.length;

      // Animate progress bar
      const progressStart = Date.now();
      const progressTimer = setInterval(() => {
        const elapsed = Date.now() - progressStart;
        const prog = Math.min(elapsed / totalDuration, 1);
        const currentStepCapture = step;
        setProgressBars((prev) =>
          prev.map((p, i) => (i === currentStepCapture ? prog : p)),
        );
        if (prog >= 1) clearInterval(progressTimer);
      }, 50);

      // Cycle through scan phases
      let phaseIdx = 0;
      const phaseTimer = setInterval(() => {
        phaseIdx++;
        if (phaseIdx < phases.length) {
          const currentStepCapture = step;
          setPhaseIndex((prev) =>
            prev.map((p, i) => (i === currentStepCapture ? phaseIdx : p)),
          );
        }
      }, phaseInterval);

      // Complete this step
      setTimeout(() => {
        clearInterval(phaseTimer);
        clearInterval(progressTimer);
        const currentStepCapture = step;
        setProgressBars((prev) =>
          prev.map((p, i) => (i === currentStepCapture ? 1 : p)),
        );
        setStepStates((prev) =>
          prev.map((s, i) => (i === currentStepCapture ? 'done' : s)),
        );
        step++;
        setTimeout(runStep, 300);
      }, totalDuration);
    };

    runStep();
  }, [onComplete]);

  useEffect(() => {
    if (phase === 'analyzing') {
      runAnalysis();
    }
  }, [phase, runAnalysis]);

  // Cleanup on unmount
  useEffect(() => {
    animating.current = true;
    return () => {
      animating.current = false;
    };
  }, []);

  return (
    <div style={{ marginTop: 'var(--space-md)' }}>
      {/* ── Phase 1: Fetching data from chain ── */}
      {phase === 'fetching' && <DataFetchingAnimation />}

      {/* ── Phase transition: data received ── */}
      {phase === 'analyzing' && (
        <div
          style={{
            marginBottom: 'var(--space-md)',
            padding: 'var(--space-sm) var(--space-md)',
            background: 'oklch(0.72 0.19 162 / 0.06)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid oklch(0.72 0.19 162 / 0.15)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-sm)',
            animation: 'fadeIn 0.4s ease-out',
          }}
        >
          <span style={{ color: 'var(--color-primary, #22c55e)', fontSize: '1rem' }}>{'\u2713'}</span>
          <span style={{ fontSize: '0.8125rem', color: 'var(--color-primary, #22c55e)', fontWeight: 600 }}>
            On-chain data collected
          </span>
          {result && (
            <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
              {result.dataAvailability?.transactionCount ?? 0} transactions
              {' \u00B7 '}
              {result.dataAvailability?.tokenCount ?? 0} tokens
            </span>
          )}
        </div>
      )}

      {/* ── Phase 2: Analysis pipeline ── */}
      {(phase === 'analyzing' || phase === 'complete') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, animation: 'fadeIn 0.4s ease-out' }}>
          {SCAN_STEPS.map((config, index) => {
            const state = stepStates[index];
            const detail = factorDetailMap.current.get(config.factorKey);
            const progress = progressBars[index];

            return (
              <div
                key={config.factorKey}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--space-md)',
                  animation: state !== 'pending' ? 'fadeIn 0.3s ease-out' : undefined,
                  opacity: state === 'pending' ? 0.35 : 1,
                  transition: 'opacity 0.4s ease',
                }}
              >
                {/* Vertical connector + icon */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    minWidth: 44,
                  }}
                >
                  <StepIcon state={state} icon={config.icon} rating={detail?.rating} />
                  {index < SCAN_STEPS.length - 1 && (
                    <div
                      style={{
                        width: 2,
                        height: state === 'done' ? 20 : 40,
                        background:
                          state === 'done'
                            ? detail
                              ? ratingColor(detail.rating)
                              : 'var(--color-primary)'
                            : state === 'scanning'
                              ? 'var(--color-info)'
                              : 'var(--color-border)',
                        transition: 'all 0.5s ease',
                      }}
                    />
                  )}
                </div>

                {/* Content */}
                <div
                  style={{
                    flex: 1,
                    paddingBottom: index < SCAN_STEPS.length - 1 ? 'var(--space-sm)' : 0,
                    minHeight: state === 'done' && detail ? undefined : 60,
                  }}
                >
                  {/* Title row */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-sm)',
                      marginBottom: 4,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: '0.875rem',
                        color:
                          state === 'done' && detail
                            ? ratingColor(detail.rating)
                            : state === 'scanning'
                              ? 'var(--color-text)'
                              : 'var(--color-text-muted)',
                        transition: 'color 0.4s ease',
                      }}
                    >
                      {config.title}
                    </span>
                    {state === 'done' && detail && (
                      <span
                        style={{
                          fontSize: '0.6875rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          color: ratingColor(detail.rating),
                          background: ratingBg(detail.rating),
                          padding: '1px 8px',
                          borderRadius: '9999px',
                          animation: 'fadeIn 0.3s ease-out',
                        }}
                      >
                        {detail.rating}
                      </span>
                    )}
                    {state === 'done' && detail && (
                      <span
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--color-text-muted)',
                          fontFamily: 'var(--font-mono)',
                          animation: 'fadeIn 0.3s ease-out',
                        }}
                      >
                        {detail.value.toFixed(2)}
                      </span>
                    )}
                  </div>

                  {/* Scanning phase text */}
                  {state === 'scanning' && (
                    <div style={{ animation: 'fadeIn 0.2s ease-out' }}>
                      <p
                        style={{
                          fontSize: '0.8125rem',
                          color: 'var(--color-info)',
                          fontFamily: 'var(--font-mono)',
                          marginBottom: 6,
                        }}
                      >
                        <span className="animate-pulse">
                          {config.scanPhases[phaseIndex[index]]}
                        </span>
                      </p>
                      {/* Progress bar */}
                      <div
                        style={{
                          width: '100%',
                          height: 3,
                          background: 'var(--color-border)',
                          borderRadius: 2,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${progress * 100}%`,
                            height: '100%',
                            background: 'var(--color-info)',
                            borderRadius: 2,
                            transition: 'width 0.1s linear',
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Completed — show description */}
                  {state === 'done' && detail && (
                    <p
                      style={{
                        fontSize: '0.8125rem',
                        color: 'var(--color-text-muted)',
                        lineHeight: 1.5,
                        margin: 0,
                        animation: 'fadeIn 0.4s ease-out',
                      }}
                    >
                      {detail.description}
                    </p>
                  )}

                  {/* Pending placeholder */}
                  {state === 'pending' && (
                    <p
                      style={{
                        fontSize: '0.8125rem',
                        color: 'var(--color-text-muted)',
                        opacity: 0.4,
                      }}
                    >
                      Waiting...
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Phase 3: Summary — only after ALL analysis steps finish ── */}
      {showSummary && result && (
        <div
          style={{
            marginTop: 'var(--space-lg)',
            animation: 'fadeIn 0.5s ease-out',
          }}
        >
          {/* Divider */}
          <div
            style={{
              height: 1,
              background: 'linear-gradient(to right, transparent, var(--color-border), transparent)',
              marginBottom: 'var(--space-lg)',
            }}
          />

          {/* Score summary row */}
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-lg)',
              alignItems: 'center',
              marginBottom: 'var(--space-md)',
              padding: 'var(--space-md)',
              background: 'var(--color-surface-hover)',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--color-border)',
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
                  fontSize: '2rem',
                  fontWeight: 800,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text)',
                }}
              >
                {result.score}
              </div>
            </div>
            <Badge variant={TIER_BADGE_VARIANTS[result.tier]}>
              {TIER_LABELS[result.tier]}
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
              <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>
                {result.premiumBps > 0
                  ? `${result.premiumBps / 100}%`
                  : 'Not insurable'}
              </div>
            </div>
          </div>

          {/* Category breakdown */}
          {result.categoryRisks && result.categoryRisks.length > 0 && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 'var(--space-sm)',
                marginBottom: 'var(--space-md)',
              }}
            >
              {result.categoryRisks.map((cat: CategoryRisk) => (
                <div
                  key={cat.category}
                  style={{
                    padding: 'var(--space-sm)',
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
                      marginBottom: 2,
                    }}
                  >
                    {cat.label}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                    <span
                      style={{
                        fontSize: '1.125rem',
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

          {/* Confidence indicator */}
          {result.overallConfidence != null && (
            <div
              style={{
                fontSize: '0.75rem',
                color: 'var(--color-text-muted)',
                marginBottom: 'var(--space-sm)',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-xs)',
              }}
            >
              <span>Assessment confidence:</span>
              <div
                style={{
                  width: 80,
                  height: 4,
                  background: 'var(--color-border)',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${result.overallConfidence * 100}%`,
                    height: '100%',
                    background:
                      result.overallConfidence > 0.7
                        ? 'var(--color-primary, #22c55e)'
                        : result.overallConfidence > 0.4
                          ? 'var(--color-warning, #eab308)'
                          : 'var(--color-danger, #ef4444)',
                    borderRadius: 2,
                  }}
                />
              </div>
              <span style={{ fontFamily: 'var(--font-mono)' }}>
                {Math.round(result.overallConfidence * 100)}%
              </span>
            </div>
          )}

          {/* Summary text */}
          <p
            style={{
              fontSize: '0.875rem',
              color: 'var(--color-text)',
              lineHeight: 1.6,
              marginBottom: 'var(--space-sm)',
            }}
          >
            {result.summary}
          </p>

          {/* Recommendation */}
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
            {result.recommendation}
          </p>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP ICON
// ═══════════════════════════════════════════════════════════════════════════════

function StepIcon({
  state,
  icon,
  rating,
}: {
  state: StepState;
  icon: string;
  rating?: string;
}) {
  const base: React.CSSProperties = {
    width: 36,
    height: 36,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1rem',
    fontWeight: 700,
    transition: 'all 0.4s ease',
  };

  if (state === 'pending') {
    return (
      <div
        style={{
          ...base,
          background: 'var(--color-surface-hover)',
          color: 'var(--color-text-muted)',
          border: '2px solid var(--color-border)',
          opacity: 0.4,
        }}
      >
        {icon}
      </div>
    );
  }

  if (state === 'scanning') {
    return (
      <div
        style={{
          ...base,
          background: 'oklch(0.62 0.19 250 / 0.15)',
          color: 'var(--color-info)',
          border: '2px solid var(--color-info)',
        }}
      >
        <span
          className="animate-spin"
          style={{
            width: 16,
            height: 16,
            border: '2px solid transparent',
            borderTopColor: 'currentColor',
            borderRightColor: 'currentColor',
            borderRadius: '50%',
            display: 'inline-block',
          }}
        />
      </div>
    );
  }

  // Done
  const color = rating ? ratingColor(rating) : 'var(--color-primary)';
  const bg = rating ? ratingBg(rating) : 'oklch(0.72 0.19 162 / 0.15)';
  return (
    <div
      style={{
        ...base,
        background: bg,
        color,
        border: `2px solid ${color}`,
      }}
    >
      {'\u2713'}
    </div>
  );
}
