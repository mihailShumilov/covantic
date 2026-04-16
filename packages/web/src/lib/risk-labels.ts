/** Risk tier display labels — re-exported from shared for single source of truth */
export { TIER_LABELS } from '@covantic/shared';

/** Badge variant for each risk tier */
export const TIER_BADGE_VARIANTS = ['success', 'warning', 'danger', 'danger'] as const;

/** Policy state display labels — indexed by PolicyState enum */
export const STATE_LABELS = ['Active', 'Claim Pending', 'Paid', 'Expired', 'Cancelled'] as const;

/** Badge variant for each policy state — indexed by PolicyState enum */
export const STATE_BADGE_VARIANTS = ['success', 'warning', 'success', 'neutral', 'neutral'] as const;

/** Shared input field style for forms */
export const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--color-text)',
  fontSize: '0.875rem',
};

/** Shared form label style */
export const LABEL_STYLE: React.CSSProperties = {
  fontSize: '0.8125rem',
  color: 'var(--color-text-muted)',
  display: 'block',
  marginBottom: 4,
};
