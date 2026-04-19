'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { apiGet } from '@/lib/api-client';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/explorer';
import { TIER_LABELS, formatUsdc, shortenAddress } from '@covantic/shared';

/**
 * /fleet — live panel over the autonomous agent fleet.
 *
 * Left column: one card per fleet agent with coverage + policy metadata.
 * Right column: scrolling activity feed populated from
 * `covantic:fleet:activity` (Redis list) via `GET /api/fleet`.
 *
 * Polls every 6s. When the fleet is idle between ticks, the feed shows a
 * muted placeholder so the user can tell "fetching" apart from "empty".
 */

interface FleetAgentRow {
  name: string;
  pubkey: string;
  holderPubkey: string;
  policyId: number;
  riskTier: number;
  coverageAmountRaw: number;
  durationSeconds: number;
  createdAt: string;
}

interface FleetActivityRow {
  timestamp: number;
  agentName: string;
  agentPubkey: string;
  kind: 'safe' | 'large' | 'fail' | 'skip' | 'error';
  amountUi?: number;
  signature?: string;
  /** Runner-side exception — no on-chain tx landed. Surfaced in red. */
  error?: string;
  /** Structured `meta.err` from a confirmed-failed tx. Expected outcome
   *  of a `fail` action; surfaced in muted tone since it's by design. */
  onChainErr?: unknown;
  /** Which failure strategy produced this row (e.g. `failed_tx`). */
  failureKind?: string;
}

interface FleetResponse {
  agents: FleetAgentRow[];
  activity: FleetActivityRow[];
  note?: string;
  updatedAt?: string;
}

const KIND_VARIANT: Record<FleetActivityRow['kind'], 'success' | 'warning' | 'danger' | 'neutral'> =
  {
    safe: 'success',
    large: 'warning',
    fail: 'danger',
    skip: 'neutral',
    error: 'danger',
  };

const KIND_LABEL: Record<FleetActivityRow['kind'], string> = {
  safe: 'safe transfer',
  large: 'LARGE TRANSFER',
  fail: 'failing tx',
  skip: 'idle',
  error: 'error',
};

const TIER_VARIANT: Record<number, 'success' | 'warning' | 'info' | 'danger' | 'neutral'> = {
  0: 'success',
  1: 'info',
  2: 'warning',
  3: 'danger',
};

/** Render the structured on-chain `meta.err` from a fleet failure row.
 *  Common shapes: `{ InstructionError: [ix_index, "InvalidInstructionData"] }`,
 *  `{ InstructionError: [ix_index, { Custom: code }] }`. Anything we can't
 *  classify falls through to JSON so the operator still sees something. */
function describeOnChainErr(err: unknown, kind?: string): string {
  const prefix = kind ? `${kind}: ` : 'on-chain: ';
  if (err && typeof err === 'object' && 'InstructionError' in err) {
    const ixErr = (err as { InstructionError: unknown }).InstructionError;
    if (Array.isArray(ixErr) && ixErr.length === 2) {
      const [, detail] = ixErr;
      if (typeof detail === 'string') return `${prefix}${detail}`;
      if (detail && typeof detail === 'object' && 'Custom' in detail) {
        return `${prefix}Custom(${(detail as { Custom: number }).Custom})`;
      }
    }
  }
  const json = JSON.stringify(err);
  return `${prefix}${json.length > 120 ? `${json.slice(0, 120)}…` : json}`;
}

function timeAgo(ts: number, now = Date.now()): string {
  const delta = Math.max(0, now - ts);
  const sec = Math.round(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

export default function FleetPage() {
  const [data, setData] = useState<FleetResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await apiGet<FleetResponse>('/api/fleet');
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const interval = setInterval(load, 6_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);

  const loading = data === null && error === null;
  const agents = data?.agents ?? [];
  const activity = data?.activity ?? [];

  return (
    <div style={{ padding: 'var(--space-xl)', maxWidth: 1400, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-lg)',
          gap: 'var(--space-md)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Agent Fleet</h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
            Autonomous on-chain agents running every ~60s. Rogue ticks produce
            real anomalies that flow through monitor → verifier → payout.
          </p>
        </div>
        <div style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
          {loading ? 'loading…' : `polled ${timeAgo(now - 100, now)} · ${agents.length} agents`}
        </div>
      </div>

      {error && (
        <Card style={{ borderColor: 'var(--color-danger)', marginBottom: 'var(--space-lg)' }}>
          <p style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</p>
        </Card>
      )}

      {data?.note && (
        <Card style={{ marginBottom: 'var(--space-lg)' }}>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
            {data.note}
          </p>
          <p
            style={{
              color: 'var(--color-text-muted)',
              fontSize: '0.75rem',
              marginTop: 'var(--space-xs)',
            }}
          >
            Run <code>pnpm fleet:bootstrap</code> and <code>pnpm fleet:start</code> to populate.
          </p>
        </Card>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-2xl) 0' }}>
          <Spinner />
        </div>
      ) : (
        <div className="fleet-grid">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 'var(--space-md)',
            }}
          >
            {agents.map((agent) => (
              <AgentCard key={agent.pubkey} agent={agent} />
            ))}
          </div>

          <Card style={{ height: 'fit-content', position: 'sticky', top: 'var(--space-lg)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                marginBottom: 'var(--space-md)',
              }}
            >
              <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Live activity</h2>
              <span style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
                last {activity.length}
              </span>
            </div>
            {activity.length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
                No ticks recorded yet. Start the runner with{' '}
                <code>pnpm fleet:start</code>.
              </p>
            ) : (
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-xs)',
                  maxHeight: '70vh',
                  overflowY: 'auto',
                }}
              >
                {activity.map((entry) => (
                  <ActivityRow key={`${entry.timestamp}-${entry.agentName}`} entry={entry} now={now} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      <style jsx>{`
        .fleet-grid {
          display: grid;
          grid-template-columns: 1fr 420px;
          gap: var(--space-lg);
          align-items: start;
        }
        @media (max-width: 1024px) {
          .fleet-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}

function AgentCard({ agent }: { agent: FleetAgentRow }) {
  const tierVariant = TIER_VARIANT[agent.riskTier] ?? 'neutral';
  const addrLink = explorerAddressUrl(agent.pubkey);
  return (
    <Card>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-sm)',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{agent.name}</div>
        <Badge variant={tierVariant}>{TIER_LABELS[agent.riskTier] ?? '?'}</Badge>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.75rem' }}>
        <div style={{ color: 'var(--color-text-muted)' }}>
          pubkey{' '}
          {addrLink ? (
            <a href={addrLink} target="_blank" rel="noreferrer" style={{ color: 'var(--color-info)' }}>
              {shortenAddress(agent.pubkey)} ↗
            </a>
          ) : (
            <span>{shortenAddress(agent.pubkey)}</span>
          )}
        </div>
        <div style={{ color: 'var(--color-text-muted)' }}>
          policy <span style={{ color: 'var(--color-text)' }}>#{agent.policyId}</span>
          {' · '}
          coverage{' '}
          <span style={{ color: 'var(--color-text)' }}>
            ${formatUsdc(agent.coverageAmountRaw)}
          </span>
        </div>
        <div style={{ color: 'var(--color-text-muted)' }}>
          duration{' '}
          <span style={{ color: 'var(--color-text)' }}>
            {Math.round(agent.durationSeconds / 3600)}h
          </span>
        </div>
      </div>
    </Card>
  );
}

function ActivityRow({ entry, now }: { entry: FleetActivityRow; now: number }) {
  const txLink = entry.signature ? explorerTxUrl(entry.signature) : null;
  const amount = entry.amountUi != null ? `${entry.amountUi.toFixed(2)} USDC` : null;
  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 'var(--space-sm)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface-hover)',
        fontSize: '0.8125rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
        <Badge variant={KIND_VARIANT[entry.kind]}>{KIND_LABEL[entry.kind]}</Badge>
        <span style={{ fontWeight: 600 }}>{entry.agentName}</span>
        {amount && <span style={{ color: 'var(--color-text-muted)' }}>{amount}</span>}
        <span
          style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', fontSize: '0.75rem' }}
        >
          {timeAgo(entry.timestamp, now)}
        </span>
      </div>
      {(txLink || entry.error || entry.onChainErr != null) && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
          {txLink && (
            <a href={txLink} target="_blank" rel="noreferrer" style={{ color: 'var(--color-info)' }}>
              tx ↗
            </a>
          )}
          {entry.onChainErr != null && !entry.error && (
            <span style={{ color: 'var(--color-text-muted)' }}>
              {txLink ? ' · ' : ''}
              {describeOnChainErr(entry.onChainErr, entry.failureKind)}
            </span>
          )}
          {entry.error && (
            <span style={{ color: 'var(--color-danger)' }}>
              {txLink ? ' · ' : ''}
              {entry.error.length > 120 ? `${entry.error.slice(0, 120)}…` : entry.error}
            </span>
          )}
        </div>
      )}
    </li>
  );
}
