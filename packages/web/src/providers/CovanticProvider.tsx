'use client';

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { VaultStats } from '@covantic/shared';
import { apiGet } from '@/lib/api-client';

interface CovanticContextType {
  vaultStats: VaultStats | null;
  loading: boolean;
  refreshVault: () => Promise<void>;
}

const CovanticContext = createContext<CovanticContextType>({
  vaultStats: null,
  loading: true,
  refreshVault: async () => {},
});

export function CovanticProvider({ children }: { children: ReactNode }) {
  const [vaultStats, setVaultStats] = useState<VaultStats | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshVault = async () => {
    try {
      const stats = await apiGet<VaultStats>('/api/vault/stats');
      setVaultStats(stats);
    } catch {
      // API may not be available during development
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshVault();
    const interval = setInterval(refreshVault, 30_000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  return (
    <CovanticContext.Provider value={{ vaultStats, loading, refreshVault }}>
      {children}
    </CovanticContext.Provider>
  );
}

export function useCovanticContext() {
  return useContext(CovanticContext);
}
