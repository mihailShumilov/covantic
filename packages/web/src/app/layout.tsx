import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { WalletProvider } from '@/providers/WalletProvider';
import { AgentGuardProvider } from '@/providers/AgentGuardProvider';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'AgentGuard — AI Agent Insurance on Solana',
  description:
    'First parametric insurance protocol for AI agents on Solana. Protect your agents against DeFi exploits, oracle manipulation, and more.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>
        <WalletProvider>
          <AgentGuardProvider>
            <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
              <Header />
              <main style={{ flex: 1 }}>{children}</main>
              <Footer />
            </div>
          </AgentGuardProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
