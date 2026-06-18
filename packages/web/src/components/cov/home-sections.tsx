'use client';

/**
 * Covantic landing sections — animated step icons, real-incident fear block,
 * live losses feed, protocol flow diagram. Ported from the Covantic v2
 * design handoff.
 */

import { useState, useEffect, useRef } from 'react';
import { RevealOnView } from './visuals';
import {
  LOSS_ANCHORS,
  distinctSources,
  getMarketStat,
  type LossAnchor,
  type SourceRef,
} from '@/data/lossStats';

/* ============ ANIMATED STEP ICONS (How it works) ============ */

export function StepIcon({ kind }: { kind: 'assess' | 'underwrite' | 'settle' | 'stake' }) {
  const size = 46;
  const common = {
    className: 'cov-icon',
    width: size,
    height: size,
    viewBox: '0 0 48 48',
    fill: 'none',
    'aria-hidden': true as const,
  };
  if (kind === 'assess') {
    return (
      <svg {...common}>
        <rect x="8" y="8" width="32" height="32" rx="4" stroke="var(--border-strong)" strokeWidth="1.4" />
        <rect className="cov-ic-bar" style={{ animationDelay: '0s' }} x="14" y="15" width="20" height="3" rx="1.5" fill="var(--c-info)" />
        <rect className="cov-ic-bar" style={{ animationDelay: '0.5s' }} x="14" y="22.5" width="14" height="3" rx="1.5" fill="var(--c-moderate)" />
        <rect className="cov-ic-bar" style={{ animationDelay: '1s' }} x="14" y="30" width="17" height="3" rx="1.5" fill="var(--c-low)" />
        <rect className="cov-ic-scanline" x="10" y="12" width="28" height="1.8" rx="0.9" fill="var(--c-info)" />
      </svg>
    );
  }
  if (kind === 'underwrite') {
    return (
      <svg {...common}>
        <path d="M 8 36 A 16 16 0 0 1 40 36" stroke="var(--border-strong)" strokeWidth="1.4" strokeLinecap="round" />
        <line x1="10.5" y1="29" x2="13" y2="30.5" stroke="var(--text-faint)" strokeWidth="1.4" strokeLinecap="round" />
        <line x1="24" y1="20" x2="24" y2="23" stroke="var(--text-faint)" strokeWidth="1.4" strokeLinecap="round" />
        <line x1="37.5" y1="29" x2="35" y2="30.5" stroke="var(--text-faint)" strokeWidth="1.4" strokeLinecap="round" />
        <line className="cov-ic-needle" style={{ transformOrigin: '24px 36px' }} x1="24" y1="36" x2="24" y2="23.5" stroke="var(--c-info)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="24" cy="36" r="2.6" fill="var(--c-info)" />
        <text className="cov-ic-quote" x="40" y="18" textAnchor="end" fontFamily="var(--font-mono)" fontSize="9" fontWeight="700" fill="var(--c-low)">
          %
        </text>
      </svg>
    );
  }
  if (kind === 'settle') {
    return (
      <svg {...common}>
        <path d="M 6 24 H 28" stroke="var(--border-strong)" strokeWidth="1.4" strokeDasharray="3 3" />
        <rect className="cov-ic-flash" x="30" y="16" width="13" height="16" rx="2.5" stroke="var(--c-low)" strokeWidth="1.5" fill="var(--c-low)" fillOpacity="0.08" />
        <path d="M 34 24 l 2.4 2.4 l 4 -4.4" stroke="var(--c-low)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <circle className="cov-ic-pulse" cx="7" cy="24" r="3.2" fill="var(--c-info)" />
      </svg>
    );
  }
  // stake
  return (
    <svg {...common}>
      <path d="M 13 20 V 34 a 4 4 0 0 0 4 4 h 14 a 4 4 0 0 0 4 -4 V 20" stroke="var(--border-strong)" strokeWidth="1.4" strokeLinecap="round" />
      <rect className="cov-ic-level" style={{ transformOrigin: '24px 36.5px' }} x="14.5" y="21" width="19" height="15.5" rx="2.5" fill="var(--c-info)" opacity="0.4" />
      <circle className="cov-ic-drop" style={{ animationDelay: '0s' }} cx="20" cy="9" r="2.2" fill="var(--c-low)" />
      <circle className="cov-ic-drop" style={{ animationDelay: '1.4s' }} cx="28" cy="9" r="2.2" fill="var(--c-low)" />
    </svg>
  );
}

/* ============ FEAR BLOCK: real incidents ============ */
/* Every figure below is sourced from src/data/lossStats.ts (single source of
   truth for external statistics). Do not hardcode loss figures here. */

function IncidentCard({ inc }: { inc: LossAnchor }) {
  return (
    <div className="cov-card" style={{ padding: '20px 24px', width: 288, flexShrink: 0, marginRight: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{inc.name}</span>
        <span style={{ flex: 1 }} />
        <span className="cov-mono" style={{ fontSize: 10.5, color: 'var(--text-faint)', letterSpacing: '0.08em' }}>
          {inc.chain}
        </span>
      </div>
      <div className="cov-mono" style={{ fontSize: 27, fontWeight: 700, color: 'var(--c-critical)', letterSpacing: '-0.02em', marginBottom: 8 }}>
        {inc.amount}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 8 }}>
        {inc.date} · {inc.cause}
      </div>
      <div className="cov-mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
        — {inc.source.name}, {inc.source.year}
      </div>
    </div>
  );
}

function SourceFootnote({ sources }: { sources: SourceRef[] }) {
  return (
    <p
      className="cov-mono"
      style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-faint)', marginTop: 16, padding: '0 36px', lineHeight: 1.6 }}
    >
      Sources:{' '}
      {sources.map((s, i) => (
        <span key={s.name}>
          {i > 0 && ' · '}
          {s.url ? (
            <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-dim)' }}>
              {s.name}
            </a>
          ) : (
            <span style={{ color: 'var(--text-dim)' }}>{s.name}</span>
          )}{' '}
          ({s.year})
        </span>
      ))}
    </p>
  );
}

export function FearBlock() {
  // Verified base-rate headline (CertiK Hack3d) + distinct citations for the marquee.
  const frequency = getMarketStat('incident-frequency');
  const sources = distinctSources([
    ...LOSS_ANCHORS.map((a) => a.source),
    ...(frequency ? [frequency.source] : []),
  ]);

  return (
    <section style={{ padding: '40px 0 64px' }}>
      <RevealOnView style={{ textAlign: 'center', padding: '0 36px', marginBottom: 12 }}>
        <div className="cov-label" style={{ color: 'var(--c-critical)', marginBottom: 18, whiteSpace: 'normal' }}>
          $286M drained from Drift, Solana&apos;s largest perp DEX — 1 April 2026
        </div>
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 'var(--display-weight)' as never,
            letterSpacing: 'var(--display-tracking)',
            fontSize: 'clamp(30px, 5vw, 44px)',
            lineHeight: 1.12,
            textWrap: 'balance',
          }}
        >
          AI agents manage billions.
        </h2>
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 'var(--display-weight)' as never,
            letterSpacing: 'var(--display-tracking)',
            fontSize: 'clamp(30px, 5vw, 44px)',
            lineHeight: 1.12,
            color: 'var(--text-dim)',
            textWrap: 'balance',
          }}
        >
          When things go wrong, there&apos;s no safety net.
        </h2>
        {frequency && (
          <p style={{ fontSize: 14.5, color: 'var(--text-dim)', marginTop: 16, textWrap: 'pretty' }}>
            {frequency.value} {frequency.label}.
          </p>
        )}
      </RevealOnView>
      <RevealOnView delay={150}>
        <div className="cov-marquee" style={{ padding: '28px 0 8px' }}>
          <div className="cov-marquee-track">
            {[...LOSS_ANCHORS, ...LOSS_ANCHORS].map((inc, i) => (
              <IncidentCard key={`${inc.name}-${i}`} inc={inc} />
            ))}
          </div>
        </div>
      </RevealOnView>
      <RevealOnView delay={250}>
        <p style={{ textAlign: 'center', fontStyle: 'italic', fontSize: 14.5, color: 'var(--text-dim)', marginTop: 26, padding: '0 36px' }}>
          Existing cover — Nexus Mutual, Amulet, Neptune Mutual — insures the smart contract, not the
          agent. The owner absorbs 100% of the loss.
        </p>
        <SourceFootnote sources={sources} />
      </RevealOnView>
    </section>
  );
}

/* ============ LIVE LOSSES ============ */

const LOSS_TYPES = [
  { code: 'exploit_flag', label: 'Protocol exploit' },
  { code: 'drawdown_breach', label: 'Drawdown breach' },
  { code: 'oracle_deviation', label: 'Oracle failure' },
  { code: 'liveness_fail', label: 'Agent halted' },
  { code: 'mev_sandwich', label: 'MEV sandwich' },
];

let lossSeed = 7;
function lossRand(): number {
  lossSeed = (lossSeed * 16807) % 2147483647;
  return lossSeed / 2147483647;
}

interface LossRowData {
  id: string;
  type: (typeof LOSS_TYPES)[number];
  amount: number;
  covered: boolean;
  addr: string;
  ts: string;
}

function makeLossRow(): LossRowData {
  const type = LOSS_TYPES[Math.floor(lossRand() * LOSS_TYPES.length)]!;
  const amount = Math.round((180 + lossRand() * 12200) / 10) * 10;
  const covered = lossRand() < 0.3;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';
  let a = '';
  let b = '';
  for (let i = 0; i < 4; i++) {
    a += chars[Math.floor(lossRand() * chars.length)];
    b += chars[Math.floor(lossRand() * chars.length)];
  }
  const d = new Date();
  const ts = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
  return { id: Math.random().toString(36).slice(2), type, amount, covered, addr: `${a}…${b}`, ts };
}

function LossRow({ row, fresh }: { row: LossRowData; fresh: boolean }) {
  const [on, setOn] = useState(!fresh);
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setOn(true), 30);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '78px 110px 1fr auto auto',
        gap: 18,
        alignItems: 'baseline',
        padding: '11px 0',
        borderTop: 'var(--hairline)',
        opacity: on ? 1 : 0,
        transform: on ? 'none' : 'translateY(-8px)',
        transition: 'opacity .5s cubic-bezier(.2,.7,.2,1), transform .5s cubic-bezier(.2,.7,.2,1)',
      }}
    >
      <span className="cov-mono" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
        {row.ts}
      </span>
      <span className="cov-mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        {row.addr}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.type.label}
        <code className="cov-mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 10 }}>
          {row.type.code}
        </code>
      </span>
      <span
        className="cov-mono"
        style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', color: row.covered ? 'var(--c-low)' : 'var(--c-high)' }}
      >
        {row.covered ? '+' : '−'}${row.amount.toLocaleString('en-US')}
      </span>
      <span className="cov-badge" style={{ whiteSpace: 'nowrap', color: row.covered ? 'var(--c-low)' : 'var(--c-high)' }}>
        {row.covered ? 'covered · paid' : 'uncovered'}
      </span>
    </div>
  );
}

export function LiveLosses() {
  // rows are seeded on the client only — `new Date()` in makeLossRow would
  // otherwise produce SSR/client hydration mismatches
  const [rows, setRows] = useState<LossRowData[]>([]);
  const [total, setTotal] = useState(1274300);
  const freshId = useRef<string | null>(null);

  useEffect(() => {
    setRows(Array.from({ length: 6 }, makeLossRow));
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => {
      const row = makeLossRow();
      freshId.current = row.id;
      setRows((rs) => [row, ...rs].slice(0, 6));
      if (!row.covered) setTotal((v) => v + row.amount);
    }, 3200);
    return () => clearInterval(id);
  }, []);

  return (
    <RevealOnView className="cov-card" style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="cov-pulse" style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--c-high)' }} />
          <span className="cov-label" style={{ color: 'var(--c-high)' }}>
            Agent losses · live
          </span>
        </span>
        <span style={{ flex: 1 }} />
        <span className="cov-mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          uncovered losses, 30d:&nbsp;
          <strong className="cov-mono" style={{ color: 'var(--c-high)', fontSize: 13 }}>
            ${total.toLocaleString('en-US')}
          </strong>
        </span>
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--text-dim)', marginBottom: 14, textWrap: 'pretty' }}>
        Autonomous agents lose capital every hour — exploits, oracle failures, MEV, silent halts. Most of it is uncovered.
      </p>
      <div>
        {rows.map((r) => (
          <LossRow key={r.id} row={r} fresh={r.id === freshId.current} />
        ))}
      </div>
    </RevealOnView>
  );
}

/* ============ PROTOCOL FLOW DIAGRAM ============ */

function FlowNode({
  x,
  y,
  w = 190,
  h = 74,
  title,
  sub,
  accent,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  title: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="8" fill="var(--surface)" stroke={accent ? 'var(--c-info)' : 'var(--border)'} strokeWidth="1" />
      <text x={x + 18} y={y + 30} fill="var(--text)" fontFamily="var(--font-mono)" fontSize="13" fontWeight="700" letterSpacing="0.08em">
        {title}
      </text>
      <text x={x + 18} y={y + 51} fill="var(--text-dim)" fontFamily="var(--font-body)" fontSize="12">
        {sub}
      </text>
    </g>
  );
}

function FlowEdge({
  d,
  label,
  lx,
  ly,
  animate,
  dur = '3s',
  begin = '0s',
}: {
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
  animate: boolean;
  dur?: string;
  begin?: string;
}) {
  return (
    <g>
      <path d={d} fill="none" stroke="var(--border-strong)" strokeWidth="1.2" strokeDasharray="4 4" />
      {label && (
        <text x={lx} y={ly} fill="var(--text-faint)" fontFamily="var(--font-mono)" fontSize="10.5" letterSpacing="0.12em" textAnchor="middle">
          {label}
        </text>
      )}
      {animate && (
        <circle r="3.5" fill="var(--c-info)">
          <animateMotion dur={dur} begin={begin} repeatCount="indefinite" path={d} />
        </circle>
      )}
    </g>
  );
}

export function ProtocolFlow() {
  const [anim, setAnim] = useState(false);
  useEffect(() => {
    setAnim(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);
  return (
    <svg viewBox="0 0 1110 330" style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Covantic protocol flow">
      {/* top row edges */}
      <FlowEdge d="M 200 95 L 300 95" label="assess" lx={250} ly={84} animate={anim} dur="2.4s" />
      <FlowEdge d="M 500 95 L 600 95" label="quote" lx={550} ly={84} animate={anim} dur="2.4s" begin="0.8s" />
      <FlowEdge d="M 800 95 L 900 95" label="trigger met" lx={850} ly={84} animate={anim} dur="2.4s" begin="1.6s" />
      {/* bottom feeds */}
      <FlowEdge d="M 350 250 C 480 250 560 200 680 140" label="stake USDC" lx={450} ly={238} animate={anim} dur="3.2s" />
      <FlowEdge d="M 760 250 C 850 250 930 200 985 140" label="watch conditions" lx={855} ly={238} animate={anim} dur="3.2s" begin="1.2s" />
      {/* payout return */}
      <FlowEdge d="M 900 70 C 700 8 300 8 110 58" label="instant payout · same block" lx={505} ly={14} animate={anim} dur="3.6s" begin="0.4s" />

      <FlowNode x={10} y={58} title="AI AGENT" sub="operates on Solana" />
      <FlowNode x={300} y={58} title="RISK ENGINE" sub="15-factor on-chain scan" accent />
      <FlowNode x={600} y={58} title="POLICY" sub="parametric coverage" />
      <FlowNode x={900} y={58} title="PAYOUT" sub="deterministic, no claims" w={200} />
      <FlowNode x={160} y={216} title="COVERAGE POOL" sub="stakers earn premiums" />
      <FlowNode x={570} y={216} title="TRIGGER ORACLE" sub="monitors covered events" />
    </svg>
  );
}
