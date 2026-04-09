'use client';

import { useState, useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/Badge';
import { TIER_LABELS, TIER_BADGE_VARIANTS } from '@/lib/risk-labels';
import type { FactorDetail, RiskAssessment } from '@agentguard/shared';

type RiskResult = RiskAssessment & {
  agentAddress: string;
  cached?: boolean;
};

interface Props {
  result: RiskResult | null;
  onComplete: () => void;
}

const SCAN_STEPS = [
  {
    factorKey: 'failedRatio',
    icon: '\u26A0',
    title: 'Transaction Failure Rate',
    scanPhases: [
      'Fetching on-chain transaction history...',
      'Analyzing error patterns across recent operations...',
      'Calculating failure ratios and severity...',
    ],
  },
  {
    factorKey: 'avgSlippage',
    icon: '\u21C5',
    title: 'Swap Slippage Analysis',
    scanPhases: [
      'Scanning DEX swap records via Helius...',
      'Computing slippage deltas on token transfers...',
      'Benchmarking against pool liquidity depth...',
    ],
  },
  {
    factorKey: 'protocolDiversity',
    icon: '\u2B2A',
    title: 'Protocol Diversity',
    scanPhases: [
      'Mapping all protocol interactions...',
      'Identifying unique program IDs...',
      'Evaluating ecosystem exposure breadth...',
    ],
  },
  {
    factorKey: 'walletAge',
    icon: '\u29D6',
    title: 'Wallet Maturity',
    scanPhases: [
      'Tracing wallet creation timestamp...',
      'Measuring operational history duration...',
      'Scoring maturity against risk baselines...',
    ],
  },
  {
    factorKey: 'registryScore',
    icon: '\u2606',
    title: 'Reputation Registry',
    scanPhases: [
      'Querying known agent registries...',
      'Cross-referencing reputation databases...',
      'Evaluating trust signals and flags...',
    ],
  },
  {
    factorKey: 'tokenConcentration',
    icon: '\u25CE',
    title: 'Token Concentration',
    scanPhases: [
      'Reading SPL token balances...',
      'Computing portfolio distribution metrics...',
      'Measuring single-token exposure risk...',
    ],
  },
  {
    factorKey: 'txVolume',
    icon: '\u2191',
    title: 'Activity Volume',
    scanPhases: [
      'Counting transaction throughput...',
      'Profiling activity frequency patterns...',
      'Assessing volume-driven risk exposure...',
    ],
  },
];


function ratingColor(rating: string): string {
  switch (rating) {
    case 'low': return 'var(--color-primary, #22c55e)';
    case 'moderate': return 'var(--color-warning, #eab308)';
    case 'elevated': return 'oklch(0.72 0.17 55)';
    case 'high': return 'var(--color-danger, #ef4444)';
    default: return 'var(--color-text-muted)';
  }
}

function ratingBg(rating: string): string {
  switch (rating) {
    case 'low': return 'oklch(0.72 0.19 162 / 0.08)';
    case 'moderate': return 'oklch(0.79 0.17 75 / 0.08)';
    case 'elevated': return 'oklch(0.72 0.17 55 / 0.08)';
    case 'high': return 'oklch(0.63 0.24 25 / 0.08)';
    default: return 'var(--color-surface-hover)';
  }
}

type StepState = 'pending' | 'scanning' | 'done';

export function RiskAssessmentPipeline({ result, onComplete }: Props) {
  const [stepStates, setStepStates] = useState<StepState[]>(SCAN_STEPS.map(() => 'pending'));
  const [phaseIndex, setPhaseIndex] = useState<number[]>(SCAN_STEPS.map(() => 0));
  const [showSummary, setShowSummary] = useState(false);
  const [progressBars, setProgressBars] = useState<number[]>(SCAN_STEPS.map(() => 0));
  const animating = useRef(true);

  // Map factorKeys to factorDetail labels (they may differ slightly)
  const factorDetailMap = useRef<Map<string, FactorDetail>>(new Map());
  useEffect(() => {
    if (!result) return;
    // Build mapping from step index to factorDetail by matching order
    const map = new Map<string, FactorDetail>();
    SCAN_STEPS.forEach((step, i) => {
      if (result.factorDetails[i]) {
        map.set(step.factorKey, result.factorDetails[i]);
      }
    });
    factorDetailMap.current = map;
  }, [result]);

  // Main animation loop
  useEffect(() => {
    animating.current = true;
    let step = 0;

    const runStep = () => {
      if (!animating.current || step >= SCAN_STEPS.length) {
        if (step >= SCAN_STEPS.length) {
          setTimeout(() => {
            if (animating.current) setShowSummary(true);
            setTimeout(() => onComplete(), 500);
          }, 600);
        }
        return;
      }

      // Mark step as scanning
      setStepStates((prev) => prev.map((s, i) => (i === step ? 'scanning' : s)));

      const phases = SCAN_STEPS[step].scanPhases;
      const totalDuration = 3000 + Math.random() * 2000; // 3-5s
      const phaseInterval = totalDuration / phases.length;

      // Animate progress bar
      const progressStart = Date.now();
      const progressTimer = setInterval(() => {
        const elapsed = Date.now() - progressStart;
        const progress = Math.min(elapsed / totalDuration, 1);
        const currentStepCapture = step;
        setProgressBars((prev) =>
          prev.map((p, i) => (i === currentStepCapture ? progress : p)),
        );
        if (progress >= 1) clearInterval(progressTimer);
      }, 50);

      // Cycle through scan phases
      let phase = 0;
      const phaseTimer = setInterval(() => {
        phase++;
        if (phase < phases.length) {
          const currentStepCapture = step;
          setPhaseIndex((prev) =>
            prev.map((p, i) => (i === currentStepCapture ? phase : p)),
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
        setTimeout(runStep, 400); // Small pause between steps
      }, totalDuration);
    };

    runStep();

    return () => {
      animating.current = false;
    };
  }, []);

  return (
    <div style={{ marginTop: 'var(--space-md)' }}>
      {/* Pipeline steps */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
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

      {/* Summary section — appears after all steps */}
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
