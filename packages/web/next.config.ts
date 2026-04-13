import type { NextConfig } from 'next';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

// Load .env from monorepo root so NEXT_PUBLIC_* vars are available during
// `next dev` / `next build`. Next.js only auto-loads .env files from the app
// directory, but this monorepo keeps a single source of truth at the root.
loadDotenv({ path: resolve(import.meta.dirname, '../../.env') });

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@covantic/shared'],
  turbopack: {
    // Solana wallet adapter compatibility — stub out Node.js built-ins
    resolveAlias: {
      fs: { browser: './empty-module.js' },
      net: { browser: './empty-module.js' },
      tls: { browser: './empty-module.js' },
    },
  },
  webpack: (config) => {
    // Fallback for webpack builds (next build --webpack)
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};

export default nextConfig;
