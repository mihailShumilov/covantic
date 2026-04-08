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
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xl)' }}>
        <Link href="/" style={{ fontWeight: 800, fontSize: '1.25rem', color: 'var(--color-primary)', textDecoration: 'none' }}>
          AgentGuard
        </Link>
        <nav style={{ display: 'flex', gap: 'var(--space-lg)' }}>
          <Link href="/dashboard" style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>Dashboard</Link>
          <Link href="/staking" style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>Staking</Link>
          <Link href="/claims" style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>Claims</Link>
          <Link href="/protocol" style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>Protocol</Link>
          <Link href="/demo" style={{ color: 'var(--color-warning)', fontSize: '0.875rem', fontWeight: 600 }}>Demo</Link>
        </nav>
      </div>
      <WalletButton />
    </header>
  );
}
