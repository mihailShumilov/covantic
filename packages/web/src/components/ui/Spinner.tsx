export function Spinner({ size = 24 }: { size?: number }) {
  return (
    <div
      className="animate-spin"
      style={{
        width: size,
        height: size,
        border: '2px solid var(--color-border)',
        borderTopColor: 'var(--color-primary)',
        borderRadius: '50%',
      }}
    />
  );
}
