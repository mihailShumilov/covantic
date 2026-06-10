interface CardProps {
  children: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
}

export function Card({ children, title, style }: CardProps) {
  return (
    <div className="cov-card" style={{ padding: '20px 24px', ...style }}>
      {title && (
        <h3 className="cov-label" style={{ marginBottom: 14 }}>
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}
