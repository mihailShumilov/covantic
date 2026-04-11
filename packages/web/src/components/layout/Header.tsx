'use client';

import { useState } from 'react';
import Link from 'next/link';
import { WalletButton } from '../wallet/WalletButton';

export function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--space-md) var(--space-xl)',
        borderBottom: '1px solid var(--color-border-subtle)',
        background: 'oklch(0.13 0.02 260 / 0.8)',
        backdropFilter: 'blur(12px)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
        flexWrap: 'wrap',
        gap: 'var(--space-sm)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
        {/* Hamburger button — visible only on mobile via CSS */}
        <button
          className="mobile-menu-btn"
          onClick={() => setMenuOpen((o) => !o)}
          aria-label="Toggle menu"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text)',
            cursor: 'pointer',
            padding: 4,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            {menuOpen ? (
              <>
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </>
            ) : (
              <>
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </>
            )}
          </svg>
        </button>

        <Link
          href="/"
          style={{
            fontWeight: 800,
            fontSize: '1.25rem',
            color: 'var(--color-text)',
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-sm)',
          }}
        >
          <img src="/favicon.svg" alt="" width={24} height={24} />
          Covantic
        </Link>

        {/* Desktop nav — always visible; hidden on mobile unless menu open */}
        <nav
          className={`header-nav${menuOpen ? ' open' : ''}`}
          style={{ display: 'flex', gap: 'var(--space-lg)' }}
        >
          <Link
            href="/dashboard"
            onClick={() => setMenuOpen(false)}
            style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}
          >
            Dashboard
          </Link>
          <Link
            href="/protocol"
            onClick={() => setMenuOpen(false)}
            style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}
          >
            Protocol
          </Link>
          <Link
            href="/demo"
            onClick={() => setMenuOpen(false)}
            style={{ color: 'var(--color-warning)', fontSize: '0.875rem', fontWeight: 600 }}
          >
            Demo
          </Link>
        </nav>
      </div>
      <WalletButton />

      {/* Mobile dropdown nav */}
      {menuOpen && (
        <nav
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-sm)',
            padding: 'var(--space-sm) 0',
            borderTop: '1px solid var(--color-border-subtle)',
          }}
          className="mobile-nav-dropdown"
        >
          <Link
            href="/dashboard"
            onClick={() => setMenuOpen(false)}
            style={{ color: 'var(--color-text-secondary)', fontSize: '0.9375rem', padding: 'var(--space-xs) 0' }}
          >
            Dashboard
          </Link>
          <Link
            href="/protocol"
            onClick={() => setMenuOpen(false)}
            style={{ color: 'var(--color-text-secondary)', fontSize: '0.9375rem', padding: 'var(--space-xs) 0' }}
          >
            Protocol
          </Link>
          <Link
            href="/demo"
            onClick={() => setMenuOpen(false)}
            style={{ color: 'var(--color-warning)', fontSize: '0.9375rem', fontWeight: 600, padding: 'var(--space-xs) 0' }}
          >
            Demo
          </Link>
        </nav>
      )}
    </header>
  );
}
