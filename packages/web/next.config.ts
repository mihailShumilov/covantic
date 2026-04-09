import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@agentguard/shared'],
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
