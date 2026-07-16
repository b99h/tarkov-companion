import { describe, it, expect } from 'vitest'
import { priceDivergence, VOLATILE_DIVERGENCE_RATIO } from './priceGuards'

describe('priceDivergence', () => {
  it('returns null when the prices agree', () => {
    expect(priceDivergence(100_000, 95_000)).toBeNull()
  })

  it('returns null exactly at the threshold (strictly-above rule)', () => {
    // low = high * (1 - threshold) → ratio === threshold, not above it.
    const high = 100_000
    const low = high * (1 - VOLATILE_DIVERGENCE_RATIO)
    expect(priceDivergence(high, low)).toBeNull()
  })

  it('flags a wild disagreement, measured against the larger price', () => {
    const result = priceDivergence(100_000, 50_000)
    expect(result).not.toBeNull()
    expect(result!.ratio).toBeCloseTo(0.5)
    expect(result!.avg24hPrice).toBe(100_000)
    expect(result!.lastLowPrice).toBe(50_000)
  })

  it('is symmetric — last-low above the average flags the same way', () => {
    const result = priceDivergence(50_000, 100_000)
    expect(result).not.toBeNull()
    expect(result!.ratio).toBeCloseTo(0.5)
  })

  it('returns null when either signal is missing or zero', () => {
    expect(priceDivergence(null, 100_000)).toBeNull()
    expect(priceDivergence(100_000, null)).toBeNull()
    expect(priceDivergence(0, 100_000)).toBeNull()
    expect(priceDivergence(100_000, 0)).toBeNull()
    expect(priceDivergence(null, null)).toBeNull()
  })
})
