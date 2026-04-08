/** Solvency status levels */
export enum SolvencyStatus {
  Healthy = 'healthy',
  Caution = 'caution',
  Critical = 'critical',
  Emergency = 'emergency',
}

/** Insurance vault state */
export interface VaultStats {
  totalStaked: number;
  totalCoverage: number;
  totalPremiumsCollected: number;
  totalClaimsPaid: number;
  stakerCount: number;
  solvencyRatio: number;
  solvencyStatus: SolvencyStatus;
  totalStakerRewards: number;
  reserveFund: number;
  protocolTreasury: number;
  activePolicies: number;
}

/** Vault historical snapshot */
export interface VaultSnapshot {
  id: string;
  totalStaked: number;
  totalCoverage: number;
  totalPremiums: number;
  totalClaimsPaid: number;
  stakerCount: number;
  solvencyRatio: number;
  activePolicies: number;
  snapshotAt: Date;
}
