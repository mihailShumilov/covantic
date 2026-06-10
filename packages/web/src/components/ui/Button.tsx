'use client';

import { type ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  children,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    borderRadius: 'var(--radius)',
    fontWeight: 600,
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled || loading ? 0.5 : 1,
    border: 'none',
    transition: 'all 0.15s',
    fontFamily: 'var(--font-body)',
    whiteSpace: 'nowrap',
  };

  const variants: Record<string, React.CSSProperties> = {
    primary: { background: 'var(--accent)', color: 'var(--accent-ink)' },
    secondary: {
      background: 'transparent',
      color: 'var(--text)',
      border: '1px solid var(--border-strong)',
      fontWeight: 500,
    },
    danger: { background: 'var(--c-critical)', color: '#fff' },
    ghost: { background: 'transparent', color: 'var(--text-dim)' },
  };

  const sizes: Record<string, React.CSSProperties> = {
    sm: { padding: '6px 13px', fontSize: 12.5 },
    md: { padding: '10px 18px', fontSize: 13.5 },
    lg: { padding: '13px 24px', fontSize: 14.5 },
  };

  return (
    <button
      style={{ ...baseStyle, ...variants[variant], ...sizes[size], ...style }}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
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
      )}
      {children}
    </button>
  );
}
