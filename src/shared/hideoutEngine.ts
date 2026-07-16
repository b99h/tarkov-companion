import type { CraftData, HideoutLevelData, HideoutStationData } from './types'

/**
 * Phase 8 — pure hideout derivations over the station catalog and the user's
 * recorded station levels (`PlayerProgress.stationLevels`, keyed by station
 * normalizedName; a missing key means unbuilt).
 *
 * Honesty note: only station-level prerequisites are *gated* on — trader
 * loyalty and skill requirements aren't tracked by the app, so they're
 * surfaced for display but never block anything here.
 */

/** Current built level of a station (0 = unbuilt / not recorded). */
export function stationLevel(stationLevels: Record<string, number>, normalizedName: string): number {
  return stationLevels[normalizedName] ?? 0
}

/** A station's maximum buildable level (0 for a station with no levels). */
export function maxStationLevel(station: HideoutStationData): number {
  return station.levels.reduce((max, l) => Math.max(max, l.level), 0)
}

/** The next unbuilt level's data, or null when the station is already maxed. */
export function nextLevel(
  station: HideoutStationData,
  stationLevels: Record<string, number>
): HideoutLevelData | null {
  const current = stationLevel(stationLevels, station.normalizedName)
  return station.levels.find((l) => l.level === current + 1) ?? null
}

export interface StationPrereqStatus {
  name: string
  normalizedName: string
  requiredLevel: number
  currentLevel: number
  met: boolean
}

/** A level's station prerequisites, each marked met/unmet against current levels. */
export function checkStationPrereqs(
  level: HideoutLevelData,
  stationLevels: Record<string, number>
): StationPrereqStatus[] {
  return level.stationLevelRequirements.map((req) => {
    const currentLevel = stationLevel(stationLevels, req.normalizedName)
    return {
      name: req.name,
      normalizedName: req.normalizedName,
      requiredLevel: req.level,
      currentLevel,
      met: currentLevel >= req.level
    }
  })
}

/** True when every station-level prerequisite of `level` is met. */
export function canBuildLevel(
  level: HideoutLevelData,
  stationLevels: Record<string, number>
): boolean {
  return checkStationPrereqs(level, stationLevels).every((p) => p.met)
}

/**
 * True once the user has recorded any station level — the signal that
 * hideout-aware craft filtering means something. A fresh install (nothing
 * recorded) keeps the historical maxed-hideout behavior instead of hiding
 * every craft behind an all-level-0 hideout nobody has entered yet.
 */
export function anyStationConfigured(stationLevels: Record<string, number>): boolean {
  return Object.values(stationLevels).some((level) => level > 0)
}

/** True when the recorded station levels can actually run a craft. */
export function canRunCraft(
  craft: Pick<CraftData, 'stationNormalized' | 'level'>,
  stationLevels: Record<string, number>
): boolean {
  return stationLevel(stationLevels, craft.stationNormalized) >= craft.level
}

/**
 * The currency items hideout levels charge (verified live 2026-07-16 — these
 * three are the only currencies in any `itemRequirements`). Aggregated as cash
 * totals rather than hoard-list rows: "hoard 4.9M roubles" isn't an item to
 * hold onto, it's a price tag.
 */
export const CURRENCY_ITEM_IDS: Record<string, string> = {
  '5449016a4bdc2d6f028b456f': 'Roubles',
  '5696686a4bdc2da3298b456a': 'Dollars',
  '569668774bdc2da2298b4568': 'Euros'
}

export interface HideoutHoardEntry {
  itemId: string
  name: string
  iconLink: string | null
  totalCount: number
  /** Which unbuilt levels want it, for tooltips ("Workbench 2 ×3, Lavatory 3 ×1"). */
  needs: { station: string; level: number; count: number }[]
}

export interface HideoutRemaining {
  /** Non-currency items across every unbuilt level, sorted by name. */
  items: HideoutHoardEntry[]
  /** Cash totals across every unbuilt level, one entry per currency used. */
  cash: { itemId: string; name: string; total: number }[]
}

/**
 * itemId → hoard entry for every non-currency item still needed by unbuilt
 * levels — the flea view's "don't sell this" badge lookup.
 */
export function neededHideoutItems(
  stations: HideoutStationData[],
  stationLevels: Record<string, number>
): Map<string, HideoutHoardEntry> {
  const entries = new Map<string, HideoutHoardEntry>()
  for (const station of stations) {
    const current = stationLevel(stationLevels, station.normalizedName)
    for (const level of station.levels) {
      if (level.level <= current) continue
      for (const req of level.itemRequirements) {
        if (CURRENCY_ITEM_IDS[req.itemId]) continue
        let entry = entries.get(req.itemId)
        if (!entry) {
          entry = {
            itemId: req.itemId,
            name: req.name,
            iconLink: req.iconLink,
            totalCount: 0,
            needs: []
          }
          entries.set(req.itemId, entry)
        }
        entry.totalCount += req.count
        entry.needs.push({ station: station.name, level: level.level, count: req.count })
      }
    }
  }
  return entries
}

/** Aggregate everything still owed across all unbuilt levels: items + cash. */
export function remainingRequirements(
  stations: HideoutStationData[],
  stationLevels: Record<string, number>
): HideoutRemaining {
  const items = [...neededHideoutItems(stations, stationLevels).values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  )

  const cashById = new Map<string, number>()
  for (const station of stations) {
    const current = stationLevel(stationLevels, station.normalizedName)
    for (const level of station.levels) {
      if (level.level <= current) continue
      for (const req of level.itemRequirements) {
        if (!CURRENCY_ITEM_IDS[req.itemId]) continue
        cashById.set(req.itemId, (cashById.get(req.itemId) ?? 0) + req.count)
      }
    }
  }
  const cash = [...cashById.entries()].map(([itemId, total]) => ({
    itemId,
    name: CURRENCY_ITEM_IDS[itemId],
    total
  }))

  return { items, cash }
}
