interface CardProps {
  children: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
}

export function Card({ children, title, style }: CardProps) {
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--color-border)',
        padding: 'var(--space-lg)',
        ...style,
      }}
    >
      {title && (
        <h3
          style={{
            fontSize: '1rem',
            fontWeight: 600,
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--space-md)',
          }}
        >
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}
