'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WalletButton } from '../wallet/WalletButton';
import { CovLogo } from '../cov/visuals';

const NAV = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Fleet', href: '/fleet' },
  { label: 'Staking', href: '/staking' },
  { label: 'Claims', href: '/claims' },
  { label: 'Protocol', href: '/protocol' },
  { label: 'Demo', href: '/demo' },
];

export function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  return (
    <header className="cov-chrome" style={{ flexWrap: 'wrap' }}>
      {/* Hamburger button — visible only on mobile via CSS */}
      <button
        className="mobile-menu-btn"
        onClick={() => setMenuOpen((o) => !o)}
        aria-label="Toggle menu"
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--text)',
          cursor: 'pointer',
          padding: 4,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
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

      <Link href="/" className="cov-logo">
        <CovLogo />
        Covantic
      </Link>

      {/* Desktop nav — hidden on mobile unless menu open */}
      <nav className={`header-nav cov-nav${menuOpen ? ' open' : ''}`}>
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={pathname?.startsWith(n.href) ? 'active' : ''}
            onClick={() => setMenuOpen(false)}
          >
            {n.label}
          </Link>
        ))}
      </nav>

      <WalletButton />

      {/* Mobile dropdown nav */}
      {menuOpen && (
        <nav
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '8px 0 12px',
            borderTop: 'var(--hairline)',
          }}
        >
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              onClick={() => setMenuOpen(false)}
              style={{
                color: pathname?.startsWith(n.href) ? 'var(--text)' : 'var(--text-dim)',
                fontSize: 14,
                padding: '6px 0',
                textDecoration: 'none',
              }}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
