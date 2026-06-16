import type { Metadata } from 'next';
import Script from 'next/script';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { CovBackground } from '@/components/cov/visuals';
import { WalletProvider } from '@/providers/WalletProvider';
import { CovanticProvider } from '@/providers/CovanticProvider';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Covantic — Parametric Insurance for AI Agents',
  description:
    'The first programmable coverage protocol for autonomous agents on Solana. Deterministic triggers, instant payouts, zero paperwork.',
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'Covantic',
    description: 'The coverage primitive for autonomous agents',
    url: 'https://covantic.org',
    siteName: 'Covantic',
    images: [{ url: '/og-image.png', width: 1200, height: 630 }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Covantic',
    description: 'Parametric insurance for AI agents on Solana',
    images: ['/og-image.png'],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="terminal">
      <head>
        {/* Google tag (gtag.js) */}
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-LPNHN4JW55"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());

            gtag('config', 'G-LPNHN4JW55');
          `}
        </Script>
      </head>
      <body>
        <WalletProvider>
          <CovanticProvider>
            <div className="cov-root">
              <CovBackground />
              <div className="cov-content">
                <Header />
                <main style={{ flex: 1 }}>{children}</main>
                <Footer />
              </div>
            </div>
          </CovanticProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
