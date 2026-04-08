import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@agentguard/shared'],
  webpack: (config) => {
    // Solana wallet adapter compatibility
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
