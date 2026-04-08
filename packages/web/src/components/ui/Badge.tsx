interface BadgeProps {
  children: React.ReactNode;
  variant?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}

const colors: Record<string, { bg: string; text: string }> = {
  success: { bg: 'oklch(0.72 0.19 162 / 0.15)', text: 'var(--color-primary)' },
  warning: { bg: 'oklch(0.79 0.17 75 / 0.15)', text: 'var(--color-warning)' },
  danger: { bg: 'oklch(0.63 0.24 25 / 0.15)', text: 'var(--color-danger)' },
  info: { bg: 'oklch(0.62 0.19 250 / 0.15)', text: 'var(--color-info)' },
  neutral: { bg: 'var(--color-surface-hover)', text: 'var(--color-text-secondary)' },
};

export function Badge({ children, variant = 'neutral' }: BadgeProps) {
  const c = colors[variant] ?? colors.neutral;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0.125rem 0.5rem',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 600,
        background: c.bg,
        color: c.text,
      }}
    >
      {children}
    </span>
  );
}
