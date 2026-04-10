/** Rating-based color helpers shared across risk UI components */

export function ratingColor(rating: string): string {
  switch (rating) {
    case 'low': return 'var(--color-primary, #22c55e)';
    case 'moderate': return 'var(--color-warning, #eab308)';
    case 'elevated': return 'oklch(0.72 0.17 55)';
    case 'high': return 'var(--color-danger, #ef4444)';
    default: return 'var(--color-text-muted)';
  }
}

export function ratingBg(rating: string): string {
  switch (rating) {
    case 'low': return 'oklch(0.72 0.19 162 / 0.08)';
    case 'moderate': return 'oklch(0.79 0.17 75 / 0.08)';
    case 'elevated': return 'oklch(0.72 0.17 55 / 0.08)';
    case 'high': return 'oklch(0.63 0.24 25 / 0.08)';
    default: return 'var(--color-surface-hover)';
  }
}
