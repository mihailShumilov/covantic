'use client';

import { useState, useEffect } from 'react';
import { VerificationStep, StepStatus, type PipelineStep } from '@agentguard/shared';

interface Props {
  steps?: PipelineStep[];
  autoPlay?: boolean;
  onComplete?: () => void;
}

const STEP_CONFIG = [
  {
    step: VerificationStep.PolicyCheck,
    label: 'Policy Validation',
    icon: '1',
    description: 'Checking policy is active and valid',
  },
  {
    step: VerificationStep.TriggerDetection,
    label: 'Trigger Detection',
    icon: '2',
    description: 'Identifying incident trigger type',
  },
  {
    step: VerificationStep.LossCalculation,
    label: 'Loss Calculation',
    icon: '3',
    description: 'Calculating verified loss amount',
  },
  {
    step: VerificationStep.OracleConfirmation,
    label: 'Oracle Confirmation',
    icon: '4',
    description: 'On-chain oracle verification',
  },
  {
    step: VerificationStep.PayoutExecution,
    label: 'Payout Execution',
    icon: '5',
    description: 'Transferring USDC to holder',
  },
];

/** Animated claim verification pipeline visualization.
 * This is the KEY demo element for the hackathon. */
export function ClaimVerificationPipeline({
  steps: externalSteps,
  autoPlay = false,
  onComplete,
}: Props) {
  const [steps, setSteps] = useState<PipelineStep[]>(
    externalSteps ?? STEP_CONFIG.map((s) => ({ step: s.step, status: StepStatus.Pending })),
  );
  const [, setCurrentStep] = useState(-1);

  useEffect(() => {
    if (externalSteps) {
      setSteps(externalSteps);
    }
  }, [externalSteps]);

  // Auto-play animation for demo
  useEffect(() => {
    if (!autoPlay) return;

    let step = 0;
    const interval = setInterval(() => {
      if (step >= STEP_CONFIG.length) {
        clearInterval(interval);
        onComplete?.();
        return;
      }

      setCurrentStep(step);
      setSteps((prev) =>
        prev.map((s, i) => {
          if (i < step) return { ...s, status: StepStatus.Success };
          if (i === step) return { ...s, status: StepStatus.Processing };
          return s;
        }),
      );

      // After 1.5s, mark current as success and move to next
      setTimeout(() => {
        setSteps((prev) =>
          prev.map((s, i) => {
            if (i <= step) return { ...s, status: StepStatus.Success };
            return s;
          }),
        );
        step++;
      }, 1500);
    }, 2000);

    return () => clearInterval(interval);
  }, [autoPlay, onComplete]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {STEP_CONFIG.map((config, index) => {
        const stepState = steps[index];
        const status = stepState?.status ?? StepStatus.Pending;

        return (
          <div
            key={config.step}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-md)' }}
          >
            {/* Vertical connector + icon */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                minWidth: 40,
              }}
            >
              <StepIcon status={status} number={config.icon} />
              {index < STEP_CONFIG.length - 1 && (
                <div
                  style={{
                    width: 2,
                    height: 40,
                    background:
                      status === StepStatus.Success
                        ? 'var(--color-primary)'
                        : 'var(--color-border)',
                    transition: 'background 0.5s ease',
                  }}
                />
              )}
            </div>

            {/* Content */}
            <div style={{ paddingBottom: 'var(--space-lg)', flex: 1 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  marginBottom: 2,
                }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    color:
                      status === StepStatus.Success ? 'var(--color-primary)' : 'var(--color-text)',
                  }}
                >
                  {config.label}
                </span>
                {status === StepStatus.Processing && (
                  <span
                    className="animate-pulse"
                    style={{ fontSize: '0.75rem', color: 'var(--color-info)' }}
                  >
                    processing...
                  </span>
                )}
              </div>
              <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                {config.description}
              </p>
              {stepState?.message && (
                <p
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--color-primary)',
                    marginTop: 4,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {stepState.message}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StepIcon({ status, number }: { status: StepStatus; number: string }) {
  const getStyle = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      width: 32,
      height: 32,
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '0.8125rem',
      fontWeight: 700,
      transition: 'all 0.5s ease',
    };

    switch (status) {
      case StepStatus.Pending:
        return {
          ...base,
          background: 'var(--color-surface-hover)',
          color: 'var(--color-text-muted)',
          border: '2px solid var(--color-border)',
        };
      case StepStatus.Processing:
        return {
          ...base,
          background: 'oklch(0.62 0.19 250 / 0.2)',
          color: 'var(--color-info)',
          border: '2px solid var(--color-info)',
        };
      case StepStatus.Success:
        return {
          ...base,
          background: 'oklch(0.72 0.19 162 / 0.2)',
          color: 'var(--color-primary)',
          border: '2px solid var(--color-primary)',
        };
      case StepStatus.Failed:
        return {
          ...base,
          background: 'oklch(0.63 0.24 25 / 0.2)',
          color: 'var(--color-danger)',
          border: '2px solid var(--color-danger)',
        };
    }
  };

  const icon =
    status === StepStatus.Success ? '\u2713' : status === StepStatus.Failed ? '\u2717' : number;

  return (
    <div style={getStyle()}>
      {status === StepStatus.Processing ? (
        <span
          className="animate-spin"
          style={{
            width: 16,
            height: 16,
            border: '2px solid transparent',
            borderTopColor: 'currentColor',
            borderRadius: '50%',
            display: 'inline-block',
          }}
        />
      ) : (
        icon
      )}
    </div>
  );
}
