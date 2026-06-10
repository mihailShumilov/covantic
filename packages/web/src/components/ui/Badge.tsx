interface BadgeProps {
  children: React.ReactNode;
  variant?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}

/** Variant → status color. Badges are 1px currentColor outlines, no fills. */
const colors: Record<string, string> = {
  success: 'var(--c-low)',
  warning: 'var(--c-moderate)',
  danger: 'var(--c-critical)',
  info: 'var(--c-info)',
  neutral: 'var(--text-dim)',
};

export function Badge({ children, variant = 'neutral' }: BadgeProps) {
  return (
    <span className="cov-badge" style={{ color: colors[variant] ?? colors.neutral }}>
      {children}
    </span>
  );
}
