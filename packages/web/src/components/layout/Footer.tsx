export function Footer() {
  return (
    <footer
      style={{
        padding: 'var(--space-2xl) var(--space-xl)',
        borderTop: '1px solid var(--color-border-subtle)',
        textAlign: 'center',
        color: 'var(--color-text-muted)',
        fontSize: '0.8125rem',
      }}
    >
      <div style={{ marginBottom: 'var(--space-sm)' }}>
        <span style={{ color: 'var(--color-text-secondary)' }}>Covantic Protocol</span>
        {' \u00B7 '}
        Colosseum Frontier 2026
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-lg)', marginBottom: 'var(--space-md)' }}>
        <a href="https://github.com/mihailShumilov/ai-agent-insurance" target="_blank" rel="noopener noreferrer"
          style={{ color: 'var(--color-text-muted)' }}>
          GitHub
        </a>
      </div>
      <div style={{ fontStyle: 'italic', color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
        The coverage primitive for autonomous agents.
      </div>
    </footer>
  );
}
