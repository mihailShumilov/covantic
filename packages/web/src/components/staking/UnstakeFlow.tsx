'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { formatUsdc } from '@covantic/shared';

const COOLDOWN_MS = 48 * 60 * 60 * 1000;

interface Props {
  cooldownStartIso: string | null | undefined;
  amountStaked: number;
  hasStake: boolean;
  busy: boolean;
  walletConnected: boolean;
  onRequestUnstake: () => void;
  onExecuteUnstake: () => void;
}

type Phase = 'idle' | 'cooldown' | 'ready';

export function UnstakeFlow({
  cooldownStartIso,
  amountStaked,
  hasStake,
  busy,
  walletConnected,
  onRequestUnstake,
  onExecuteUnstake,
}: Props) {
  const cooldownStartMs = useMemo(
    () => (cooldownStartIso ? Date.parse(cooldownStartIso) : null),
    [cooldownStartIso],
  );
  const cooldownEndMs = cooldownStartMs != null ? cooldownStartMs + COOLDOWN_MS : null;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (cooldownEndMs == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cooldownEndMs]);

  const remainingMs = cooldownEndMs != null ? Math.max(0, cooldownEndMs - now) : 0;
  const phase: Phase =
    cooldownStartMs == null ? 'idle' : remainingMs > 0 ? 'cooldown' : 'ready';

  const progress =
    cooldownStartMs != null
      ? Math.min(1, Math.max(0, (now - cooldownStartMs) / COOLDOWN_MS))
      : 0;

  return (
    <div
      style={{
        marginTop: 'var(--space-lg)',
        padding: 'var(--space-lg)',
        background: 'var(--color-surface-elevated)',
        border: `1px solid ${
          phase === 'ready' ? 'var(--color-accent)' : 'var(--color-border-subtle)'
        }`,
        borderRadius: 'var(--radius-lg)',
        transition: 'border-color 0.4s ease, box-shadow 0.4s ease',
        boxShadow: phase === 'ready' ? 'var(--shadow-glow-accent)' : 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 'var(--space-md)',
          marginBottom: 'var(--space-lg)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 4 }}>Unstake Flow</h3>
          <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
            Two-step withdrawal with a 48-hour security cooldown.
          </p>
        </div>
        <PhaseBadge phase={phase} />
      </div>

      <StepRow phase={phase} />

      {phase === 'idle' && (
        <IdleState
          hasStake={hasStake}
          amountStaked={amountStaked}
          busy={busy}
          walletConnected={walletConnected}
          onRequestUnstake={onRequestUnstake}
        />
      )}

      {phase === 'cooldown' && cooldownStartMs != null && cooldownEndMs != null && (
        <CooldownState
          amountStaked={amountStaked}
          remainingMs={remainingMs}
          progress={progress}
          cooldownStartMs={cooldownStartMs}
          cooldownEndMs={cooldownEndMs}
        />
      )}

      {phase === 'ready' && cooldownEndMs != null && (
        <ReadyState
          amountStaked={amountStaked}
          busy={busy}
          readyAtMs={cooldownEndMs}
          onExecuteUnstake={onExecuteUnstake}
        />
      )}
    </div>
  );
}

function PhaseBadge({ phase }: { phase: Phase }) {
  const config: Record<Phase, { label: string; color: string; bg: string; pulse: boolean }> = {
    idle: {
      label: 'Ready to request',
      color: 'var(--color-text-secondary)',
      bg: 'var(--color-surface-hover)',
      pulse: false,
    },
    cooldown: {
      label: 'Cooldown active',
      color: 'var(--color-info)',
      bg: 'oklch(0.62 0.19 250 / 0.15)',
      pulse: true,
    },
    ready: {
      label: 'Ready to execute',
      color: 'var(--color-accent)',
      bg: 'oklch(0.72 0.19 162 / 0.2)',
      pulse: true,
    },
  };
  const c = config[phase];
  return (
    <span
      className={c.pulse ? 'animate-pulse' : undefined}
      style={{
        fontSize: '0.75rem',
        fontWeight: 600,
        padding: '0.25rem 0.625rem',
        borderRadius: 'var(--radius-full)',
        color: c.color,
        background: c.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {c.label}
    </span>
  );
}

function StepRow({ phase }: { phase: Phase }) {
  const steps: Array<{ label: string; sub: string; state: 'done' | 'active' | 'pending' }> = [
    {
      label: 'Request',
      sub: 'Sign on-chain',
      state: phase === 'idle' ? 'active' : 'done',
    },
    {
      label: 'Cooldown',
      sub: '48 hours',
      state: phase === 'idle' ? 'pending' : phase === 'cooldown' ? 'active' : 'done',
    },
    {
      label: 'Execute',
      sub: 'Withdraw USDC',
      state: phase === 'ready' ? 'active' : 'pending',
    },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto 1fr auto',
        alignItems: 'center',
        gap: 'var(--space-sm)',
        marginBottom: 'var(--space-xl)',
      }}
    >
      {steps.map((s, i) => (
        <Fragment key={i}>
          <StepNode label={s.label} sub={s.sub} state={s.state} index={i + 1} />
          {i < steps.length - 1 && (
            <StepConnector
              filled={s.state === 'done'}
              active={s.state === 'done' && steps[i + 1].state === 'active'}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function StepNode({
  label,
  sub,
  state,
  index,
}: {
  label: string;
  sub: string;
  state: 'done' | 'active' | 'pending';
  index: number;
}) {
  const circle: React.CSSProperties = {
    width: 36,
    height: 36,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.875rem',
    fontWeight: 700,
    transition: 'all 0.4s ease',
    border: '2px solid',
  };
  const styles: Record<string, React.CSSProperties> = {
    done: {
      ...circle,
      background: 'oklch(0.72 0.19 162 / 0.2)',
      borderColor: 'var(--color-accent)',
      color: 'var(--color-accent)',
    },
    active: {
      ...circle,
      background: 'oklch(0.65 0.16 195 / 0.2)',
      borderColor: 'var(--color-primary)',
      color: 'var(--color-primary)',
      boxShadow: 'var(--shadow-glow-sm)',
    },
    pending: {
      ...circle,
      background: 'var(--color-surface-hover)',
      borderColor: 'var(--color-border)',
      color: 'var(--color-text-muted)',
    },
  };
  const icon = state === 'done' ? '\u2713' : index;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={styles[state]}>{icon}</div>
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            fontSize: '0.8125rem',
            fontWeight: 600,
            color:
              state === 'pending' ? 'var(--color-text-muted)' : 'var(--color-text)',
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>{sub}</div>
      </div>
    </div>
  );
}

function StepConnector({ filled, active }: { filled: boolean; active: boolean }) {
  return (
    <div
      style={{
        height: 2,
        background: filled ? 'var(--color-accent)' : 'var(--color-border)',
        marginTop: -28,
        position: 'relative',
        overflow: 'hidden',
        transition: 'background 0.4s ease',
      }}
    >
      {active && (
        <div
          className="animate-pulse"
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(90deg, transparent, var(--color-primary), transparent)',
          }}
        />
      )}
    </div>
  );
}

function IdleState({
  hasStake,
  amountStaked,
  busy,
  walletConnected,
  onRequestUnstake,
}: {
  hasStake: boolean;
  amountStaked: number;
  busy: boolean;
  walletConnected: boolean;
  onRequestUnstake: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-md)',
        flexWrap: 'wrap',
      }}
    >
      <div>
        <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>Available to unstake</p>
        <p style={{ fontSize: '1.5rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
          ${hasStake ? formatUsdc(amountStaked) : '0.00'}
        </p>
      </div>
      <Button
        variant="secondary"
        onClick={onRequestUnstake}
        disabled={busy || !walletConnected || !hasStake}
        loading={busy}
      >
        Request Unstake
      </Button>
    </div>
  );
}

function CooldownState({
  amountStaked,
  remainingMs,
  progress,
  cooldownStartMs,
  cooldownEndMs,
}: {
  amountStaked: number;
  remainingMs: number;
  progress: number;
  cooldownStartMs: number;
  cooldownEndMs: number;
}) {
  const { hours, minutes, seconds } = splitDuration(remainingMs);
  const percent = Math.round(progress * 100);

  return (
    <div className="animate-fadeIn" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: 'var(--space-md)',
          alignItems: 'end',
        }}
      >
        <div>
          <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: 6 }}>
            Time remaining
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 'var(--space-sm)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <TimeUnit value={hours} unit="h" />
            <TimeUnit value={minutes} unit="m" />
            <TimeUnit value={seconds} unit="s" />
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>Unstaking</p>
          <p style={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
            ${formatUsdc(amountStaked)}
          </p>
        </div>
      </div>

      <ProgressBar percent={percent} />

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '0.75rem',
          color: 'var(--color-text-muted)',
        }}
      >
        <span>Started {formatTimestamp(cooldownStartMs)}</span>
        <span>Ready {formatTimestamp(cooldownEndMs)}</span>
      </div>
    </div>
  );
}

function ReadyState({
  amountStaked,
  busy,
  readyAtMs,
  onExecuteUnstake,
}: {
  amountStaked: number;
  busy: boolean;
  readyAtMs: number;
  onExecuteUnstake: () => void;
}) {
  return (
    <div
      className="animate-fadeIn"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-md)',
        flexWrap: 'wrap',
      }}
    >
      <div>
        <p style={{ fontSize: '0.75rem', color: 'var(--color-accent)', fontWeight: 600 }}>
          Cooldown complete
        </p>
        <p style={{ fontSize: '1.5rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
          ${formatUsdc(amountStaked)}
        </p>
        <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
          Ready since {formatTimestamp(readyAtMs)}
        </p>
      </div>
      <Button
        onClick={onExecuteUnstake}
        disabled={busy}
        loading={busy}
        size="lg"
        style={{
          background: 'var(--color-accent)',
          color: '#0b0f14',
          boxShadow: 'var(--shadow-glow-accent)',
        }}
      >
        Execute Unstake
      </Button>
    </div>
  );
}

function TimeUnit({ value, unit }: { value: number; unit: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 2 }}>
      <span
        style={{
          fontSize: '2rem',
          fontWeight: 700,
          color: 'var(--color-primary-light)',
          fontVariantNumeric: 'tabular-nums',
          minWidth: '2.25ch',
          display: 'inline-block',
          textAlign: 'right',
        }}
      >
        {String(value).padStart(2, '0')}
      </span>
      <span style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>{unit}</span>
    </span>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div>
      <div
        style={{
          height: 8,
          borderRadius: 'var(--radius-full)',
          background: 'var(--color-surface-hover)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${percent}%`,
            background:
              'linear-gradient(90deg, var(--color-primary), var(--color-primary-light))',
            borderRadius: 'var(--radius-full)',
            transition: 'width 1s linear',
            boxShadow: '0 0 8px var(--color-primary-glow)',
          }}
        />
      </div>
      <p
        style={{
          fontSize: '0.6875rem',
          color: 'var(--color-text-muted)',
          marginTop: 4,
          textAlign: 'right',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {percent}%
      </p>
    </div>
  );
}

function splitDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return { hours, minutes, seconds };
}

function formatTimestamp(ms: number) {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}
