'use client';

import Link from 'next/link';
import { WalletButton } from '../wallet/WalletButton';

export function Header() {
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
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xl)' }}>
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
        <nav style={{ display: 'flex', gap: 'var(--space-lg)' }}>
          <Link
            href="/dashboard"
            style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}
          >
            Dashboard
          </Link>
          <Link
            href="/protocol"
            style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}
          >
            Protocol
          </Link>
          <Link
            href="/demo"
            style={{ color: 'var(--color-warning)', fontSize: '0.875rem', fontWeight: 600 }}
          >
            Demo
          </Link>
        </nav>
      </div>
      <WalletButton />
    </header>
  );
}
