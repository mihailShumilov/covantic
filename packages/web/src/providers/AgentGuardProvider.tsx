'use client';

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { VaultStats } from '@agentguard/shared';
import { apiGet } from '@/lib/api-client';

interface AgentGuardContextType {
  vaultStats: VaultStats | null;
  loading: boolean;
  refreshVault: () => Promise<void>;
}

const AgentGuardContext = createContext<AgentGuardContextType>({
  vaultStats: null,
  loading: true,
  refreshVault: async () => {},
});

export function AgentGuardProvider({ children }: { children: ReactNode }) {
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
    <AgentGuardContext.Provider value={{ vaultStats, loading, refreshVault }}>
      {children}
    </AgentGuardContext.Provider>
  );
}

export function useAgentGuardContext() {
  return useContext(AgentGuardContext);
}
