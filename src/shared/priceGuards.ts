/**
 * Thin-volume price guard (Phase 10.1): tarkov.dev's `avg24hPrice` and
 * `lastLowPrice` are both honest numbers, but on low-volume items they can
 * diverge wildly (a single lowball listing drags `lastLowPrice`, a single
 * high sale drags the average). When they disagree past a threshold, neither
 * number deserves to be silently trusted — surface the divergence instead.
 */

/** Relative disagreement above which a price is flagged as volatile. */
export const VOLATILE_DIVERGENCE_RATIO = 0.4

export interface PriceDivergence {
  avg24hPrice: number
  lastLowPrice: number
  /** |avg − low| relative to the larger of the two, 0..1. */
  ratio: number
}

/**
 * Returns the divergence between the two flea price signals when it exceeds
 * `VOLATILE_DIVERGENCE_RATIO`, or null when the prices agree well enough (or
 * either is missing/zero — with only one signal there is nothing to compare).
 * The ratio is measured against the larger price so it's symmetric and ≤ 1.
 */
export function priceDivergence(
  avg24hPrice: number | null,
  lastLowPrice: number | null
): PriceDivergence | null {
  if (!avg24hPrice || !lastLowPrice || avg24hPrice <= 0 || lastLowPrice <= 0) return null
  const ratio = Math.abs(avg24hPrice - lastLowPrice) / Math.max(avg24hPrice, lastLowPrice)
  if (ratio <= VOLATILE_DIVERGENCE_RATIO) return null
  return { avg24hPrice, lastLowPrice, ratio }
}
