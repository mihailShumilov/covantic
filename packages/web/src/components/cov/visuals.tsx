'use client';

/**
 * Covantic design-system primitives — logo, live background, ring gauge,
 * status badge, reveal transitions, count-up. Ported from the Covantic v2
 * design handoff (Forensic Terminal theme).
 */

import {
  useState,
  useEffect,
  useRef,
  useMemo,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';

/** Risk-status → CSS color variable */
export const STATUS_COLOR: Record<string, string> = {
  LOW: 'var(--c-low)',
  MODERATE: 'var(--c-moderate)',
  MEDIUM: 'var(--c-moderate)',
  ELEVATED: 'var(--c-elevated)',
  HIGH: 'var(--c-high)',
  CRITICAL: 'var(--c-critical)',
  EXTREME: 'var(--c-critical)',
};

export function statusColor(status?: string | null): string {
  return (status && STATUS_COLOR[status.toUpperCase()]) || 'var(--text-dim)';
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ---------- Logo mark (ring + dot) ---------- */
export function CovLogo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="12.5" fill="none" stroke="var(--c-info)" strokeWidth="5" />
      <circle cx="16" cy="16" r="4" fill="var(--text)" />
    </svg>
  );
}

/* ---------- count-up hook ---------- */
export function useCountUp(
  target: number,
  { duration = 1200, decimals = 0, start = true }: { duration?: number; decimals?: number; start?: boolean } = {},
): string {
  const [val, setVal] = useState(start ? 0 : target);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (!start) {
      setVal(target);
      return;
    }
    if (prefersReducedMotion()) {
      setVal(target);
      return;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(target * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
  }, [target, start, duration]);
  return val.toFixed(decimals);
}

/* ---------- live background: forensic grid + scanning sweep ---------- */
export function CovBackground({ animate = true }: { animate?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let w = 0;
    let h = 0;
    let t = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const reduced = prefersReducedMotion();
    const cell = 44;

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(90,140,170,0.055)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0.5; x < w; x += cell) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = 0.5; y < h; y += cell) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
      if (animate && !reduced) {
        const sy = ((t * 40) % (h + 200)) - 100;
        const grad = ctx.createLinearGradient(0, sy - 60, 0, sy + 2);
        grad.addColorStop(0, 'rgba(56,217,169,0)');
        grad.addColorStop(1, 'rgba(56,217,169,0.10)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, sy - 60, w, 62);
        ctx.fillStyle = 'rgba(56,217,169,0.35)';
        ctx.fillRect(0, sy, w, 1);
        const seed = Math.floor(t * 2);
        for (let i = 0; i < 5; i++) {
          const rx = Math.abs(Math.sin(seed * 12.9898 + i * 78.233)) % 1;
          const ry = Math.abs(Math.sin(seed * 39.346 + i * 11.135)) % 1;
          ctx.fillStyle = 'rgba(56,217,169,0.05)';
          ctx.fillRect(Math.floor((rx * w) / cell) * cell, Math.floor((ry * h) / cell) * cell, cell, cell);
        }
        t += 0.016;
        raf = requestAnimationFrame(draw);
      }
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [animate]);

  return <canvas ref={ref} className="cov-bg-canvas" />;
}

/* ---------- ring gauge ---------- */
export function CovRingGauge({
  value,
  label,
  size = 220,
  animateIn = true,
}: {
  value: number;
  label: string;
  size?: number;
  animateIn?: boolean;
}) {
  const [shown, setShown] = useState(animateIn ? 0 : value);
  useEffect(() => {
    if (!animateIn || prefersReducedMotion()) {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const dur = 1600;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      setShown(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, animateIn]);

  const stroke = 10;
  const r = (size - stroke * 2) / 2;
  const C = 2 * Math.PI * r;
  const color = statusColor(label);
  const ticks = useMemo(() => Array.from({ length: 40 }, (_, i) => (i / 40) * Math.PI * 2), []);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block' }}>
      {ticks.map((a, i) => {
        const cx = size / 2;
        const cy = size / 2;
        const r1 = r - 9;
        const r2 = r - 14;
        const lit = i / 40 <= shown;
        // fixed precision keeps SSR and client markup identical
        return (
          <line
            key={i}
            x1={(cx + Math.cos(a - Math.PI / 2) * r1).toFixed(2)}
            y1={(cy + Math.sin(a - Math.PI / 2) * r1).toFixed(2)}
            x2={(cx + Math.cos(a - Math.PI / 2) * r2).toFixed(2)}
            y2={(cy + Math.sin(a - Math.PI / 2) * r2).toFixed(2)}
            stroke={lit ? color : 'var(--border)'}
            strokeWidth="1.5"
          />
        );
      })}
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${C * shown} ${C}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="47%"
        textAnchor="middle"
        dominantBaseline="central"
        fill="var(--text)"
        fontFamily="var(--font-mono)"
        fontWeight="700"
        fontSize={size * 0.21}
        letterSpacing="-0.02em"
      >
        {shown.toFixed(3)}
      </text>
      <text
        x="50%"
        y="62%"
        textAnchor="middle"
        dominantBaseline="central"
        fill={color}
        fontFamily="var(--font-mono)"
        fontWeight="700"
        fontSize={size * 0.058}
        letterSpacing="0.22em"
      >
        {label}
      </text>
    </svg>
  );
}

/* ---------- status badge (1px currentColor, no fill) ---------- */
export function CovStatusBadge({ status }: { status: string }) {
  return (
    <span className="cov-badge" style={{ color: statusColor(status) }}>
      {status}
    </span>
  );
}

/* ---------- reveal: JS-driven entrance after mount ---------- */
export function Reveal({
  delay = 0,
  className = '',
  style = {},
  children,
}: {
  delay?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setOn(true);
      return;
    }
    const t = setTimeout(() => setOn(true), delay + 30);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      className={className}
      style={{
        ...style,
        opacity: on ? (style.opacity !== undefined ? style.opacity : 1) : 0,
        transform: on ? 'none' : 'translateY(14px)',
        transition:
          (style.transition ? `${style.transition}, ` : '') +
          'opacity .55s cubic-bezier(.2,.7,.2,1), transform .55s cubic-bezier(.2,.7,.2,1)',
      }}
    >
      {children}
    </div>
  );
}

/* ---------- in-view detection: IO as progressive enhancement,
   rect-check on mount/scroll/resize as the reliable path ---------- */
export function useInView(ref: RefObject<HTMLElement | null>, onVisible: () => void) {
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    let done = false;
    let io: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(
        (es) => {
          if (es.some((e) => e.isIntersecting)) fire();
        },
        { threshold: 0.05 },
      );
      if (ref.current) io.observe(ref.current);
    }
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    const t = setTimeout(check, 60);
    function cleanup() {
      if (io) io.disconnect();
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
      clearTimeout(t);
    }
    function fire() {
      if (!done) {
        done = true;
        cleanup();
        cb.current();
      }
    }
    function check() {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.92 && r.bottom > 0) fire();
    }
    check();
    return cleanup;
  }, []);
}

/* ---------- reveal when scrolled into view ---------- */
export function RevealOnView({
  delay = 0,
  className = '',
  style = {},
  children,
}: {
  delay?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useInView(ref, () => {
    if (prefersReducedMotion()) {
      setOn(true);
      return;
    }
    setTimeout(() => setOn(true), delay);
  });
  return (
    <div
      ref={ref}
      className={className}
      style={{
        ...style,
        opacity: on ? 1 : 0,
        transform: on ? 'none' : 'translateY(18px)',
        transition: 'opacity .6s cubic-bezier(.2,.7,.2,1), transform .6s cubic-bezier(.2,.7,.2,1)',
      }}
    >
      {children}
    </div>
  );
}

/* ---------- count-up stat that starts when visible ---------- */
export function StatValue({
  value,
  suffix = '',
  prefix = '',
  decimals = 0,
}: {
  value: number;
  suffix?: string;
  prefix?: string;
  decimals?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [start, setStart] = useState(false);
  useInView(ref, () => setStart(true));
  const v = useCountUp(start ? value : 0, { duration: 1500, decimals });
  return (
    <span ref={ref} className="cov-mono" style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-0.02em' }}>
      {prefix}
      {Number(v).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  );
}

/* ---------- flickering hex while a signal is being analyzed ---------- */
export function HexFlicker({ width = 5 }: { width?: number }) {
  const [s, setS] = useState('');
  useEffect(() => {
    if (prefersReducedMotion()) {
      setS('·····'.slice(0, width));
      return;
    }
    const chars = '0123456789abcdef';
    const id = setInterval(() => {
      let out = '';
      for (let i = 0; i < width; i++) out += chars[Math.floor(Math.random() * 16)];
      setS(out);
    }, 60);
    return () => clearInterval(id);
  }, [width]);
  return (
    <span className="cov-mono" style={{ color: 'var(--text-faint)', fontSize: 12 }}>
      {s}
    </span>
  );
}
