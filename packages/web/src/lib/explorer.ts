import {
  DEMO_TX_SIGNATURE_PREFIX,
  SOLANA_ADDRESS_REGEX,
  SOLANA_SIGNATURE_REGEX,
  TriggerType,
} from '@covantic/shared';
import { SOLANA_NETWORK } from './constants';

/** Solana Explorer link for a transaction signature. Returns null for
 *  demo/synthetic signatures or anything that isn't a valid Base58 sig. */
export function explorerTxUrl(sig: string | null | undefined): string | null {
  if (!sig || sig.length === 0) return null;
  if (sig.startsWith(DEMO_TX_SIGNATURE_PREFIX)) return null;
  if (!SOLANA_SIGNATURE_REGEX.test(sig)) return null;
  return `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=${encodeURIComponent(SOLANA_NETWORK)}`;
}

/** Solana Explorer link for an account/address. */
export function explorerAddressUrl(address: string | null | undefined): string | null {
  if (!address || !SOLANA_ADDRESS_REGEX.test(address)) return null;
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=${encodeURIComponent(SOLANA_NETWORK)}`;
}

/** Human label for each on-chain TriggerType enum value. */
export const TRIGGER_LABELS: Record<number, string> = {
  [TriggerType.None]: 'None',
  [TriggerType.Exploit]: 'Exploit',
  [TriggerType.OracleManipulation]: 'Oracle Manipulation',
  [TriggerType.AgentError]: 'Agent Error',
  [TriggerType.GovernanceAttack]: 'Governance Attack',
};

/** Badge colour for each claim.status string persisted in the DB. */
export const CLAIM_STATUS_VARIANTS: Record<
  string,
  'warning' | 'info' | 'success' | 'danger' | 'neutral'
> = {
  pending: 'warning',
  verifying: 'info',
  approved: 'success',
  paying: 'info',
  paid: 'success',
  rejected: 'danger',
  failed: 'danger',
};
