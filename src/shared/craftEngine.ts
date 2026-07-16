import type { CraftData, CraftItemRef, PlayerProgress } from './types'

/**
 * What one unit of a craft input is worth as a *cost*: the cheapest way to
 * acquire it. Prefer the buy price; fall back to sale value (a reasonable proxy
 * for items you can't buy, e.g. craft/quest-only inputs) when nothing sells it.
 */
export function inputUnitCost(ref: CraftItemRef): number | null {
  return ref.buyPriceRUB ?? ref.sellPriceRUB
}

/**
 * What one unit of a craft reward is worth as *revenue*: the best price anyone
 * pays. Prefer the best sale price (already includes the flea market and every
 * trader); fall back to buy price if the item somehow only has a purchase price.
 */
export function rewardUnitValue(ref: CraftItemRef): number | null {
  return ref.sellPriceRUB ?? ref.buyPriceRUB
}

/** A craft is available when it has no quest gate, or that quest is completed. */
export function isCraftUnlocked(craft: CraftData, completedTaskIds: Set<string>): boolean {
  return craft.taskUnlock === null || completedTaskIds.has(craft.taskUnlock.id)
}

export interface CraftProfit {
  craft: CraftData
  /** Total input cost in RUB. */
  costRUB: number
  /** Total reward value in RUB. */
  revenueRUB: number
  /** revenueRUB − costRUB. */
  profitRUB: number
  /** Profit normalized to RUB per hour of craft time. */
  profitPerHour: number
  /** Human-friendly reward summary (e.g. "Physical Bitcoin"). */
  rewardName: string
  /** False when any input or reward lacked a usable price (result is unreliable). */
  fullyPriced: boolean
}

function sumItems(
  items: CraftItemRef[],
  price: (ref: CraftItemRef) => number | null
): { total: number; fullyPriced: boolean } {
  let total = 0
  let fullyPriced = true
  for (const ref of items) {
    const unit = price(ref)
    if (unit === null) {
      fullyPriced = false
      continue
    }
    total += unit * ref.count
  }
  return { total, fullyPriced }
}

/** Compute the profitability of a single craft (ignoring quest gating). */
export function evaluateCraft(craft: CraftData): CraftProfit {
  const inputs = sumItems(craft.requiredItems, inputUnitCost)
  const rewards = sumItems(craft.rewardItems, rewardUnitValue)

  const profitRUB = rewards.total - inputs.total
  const hours = craft.durationSeconds > 0 ? craft.durationSeconds / 3600 : 0
  const profitPerHour = hours > 0 ? profitRUB / hours : 0

  return {
    craft,
    costRUB: inputs.total,
    revenueRUB: rewards.total,
    profitRUB,
    profitPerHour,
    rewardName: craft.rewardItems.map((r) => r.name).join(', ') || 'Unknown',
    fullyPriced: inputs.fullyPriced && rewards.fullyPriced
  }
}

export interface ScoreCraftsOptions {
  /** Cap the result length. Omit for all. */
  limit?: number
  /** Include crafts we couldn't fully price (default false — they'd rank randomly). */
  includeUnpriced?: boolean
}

/**
 * Rank hideout crafts by profit per hour, assuming a maxed hideout (station
 * levels are not filtered), but only including quest-gated crafts whose unlock
 * quest the player has actually completed.
 */
export function scoreCrafts(
  crafts: CraftData[],
  progress: PlayerProgress,
  options: ScoreCraftsOptions = {}
): CraftProfit[] {
  const completed = new Set(progress.completedTaskIds)

  const ranked = crafts
    .filter((craft) => isCraftUnlocked(craft, completed))
    .map(evaluateCraft)
    .filter((p) => (options.includeUnpriced ? true : p.fullyPriced))
    .sort((a, b) => b.profitPerHour - a.profitPerHour)

  return options.limit === undefined ? ranked : ranked.slice(0, options.limit)
}
