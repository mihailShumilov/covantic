'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { VaultStats } from '@covantic/shared';
import { apiGet } from '@/lib/api-client';
import { useWsChannel } from '@/hooks/useWsChannel';

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

  const refreshVault = useCallback(async () => {
    try {
      const stats = await apiGet<VaultStats>('/api/vault/stats');
      setVaultStats(stats);
    } catch {
      // API may not be available during development
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch on mount. Live updates come from the WS subscription
  // below so we no longer poll every 30s.
  useEffect(() => {
    refreshVault();
  }, [refreshVault]);

  // Partial payloads from the solvency-checker broadcast may not include
  // every VaultStats field, so we merge into the previous snapshot.
  useWsChannel<Partial<VaultStats>>('vault:stats', (payload) => {
    setVaultStats((prev) => ({ ...(prev ?? ({} as VaultStats)), ...payload }));
    setLoading(false);
  });

  return (
    <CovanticContext.Provider value={{ vaultStats, loading, refreshVault }}>
      {children}
    </CovanticContext.Provider>
  );
}

export function useCovanticContext() {
  return useContext(CovanticContext);
}
