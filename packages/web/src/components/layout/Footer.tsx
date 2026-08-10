import Link from 'next/link';

const LINK_STYLE = { fontSize: 11.5, color: 'var(--text-faint)' } as const;

export function Footer() {
  return (
    <footer
      style={{
        maxWidth: 'var(--page-max)',
        margin: '0 auto',
        padding: '24px var(--page-pad) 40px',
        width: '100%',
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <span className="cov-mono" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
        Covantic Protocol · Colosseum Frontier 2026
      </span>
      <span style={{ flex: 1 }} />
      <Link className="cov-mono" href="/hire" style={LINK_STYLE}>
        Hiring
      </Link>
      {/* Served as a standalone export from public/ — not an app route, so <a>. */}
      <a className="cov-mono" href="/pitch" style={LINK_STYLE}>
        Pitch deck
      </a>
      <a
        className="cov-mono"
        href="https://github.com/mihailShumilov/ai-agent-insurance"
        target="_blank"
        rel="noopener noreferrer"
        style={LINK_STYLE}
      >
        GitHub
      </a>
      <span className="cov-mono" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
        The coverage primitive for autonomous agents.
      </span>
    </footer>
  );
}
