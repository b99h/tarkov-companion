import { describe, it, expect } from 'vitest'
import {
  stationLevel,
  maxStationLevel,
  nextLevel,
  checkStationPrereqs,
  canBuildLevel,
  anyStationConfigured,
  canRunCraft,
  neededHideoutItems,
  remainingRequirements,
  CURRENCY_ITEM_IDS
} from './hideoutEngine'
import type { HideoutLevelData, HideoutStationData } from './types'

const ROUBLES_ID = '5449016a4bdc2d6f028b456f'

function level(
  overrides: Partial<HideoutLevelData> & { level: number }
): HideoutLevelData {
  return {
    constructionTimeSeconds: 0,
    itemRequirements: [],
    stationLevelRequirements: [],
    traderRequirements: [],
    skillRequirements: [],
    craftIds: [],
    ...overrides
  }
}

function station(
  overrides: Partial<HideoutStationData> & { id: string; name: string; normalizedName: string }
): HideoutStationData {
  return {
    imageLink: null,
    levels: [],
    ...overrides
  }
}

const workbench = station({
  id: 'wb0000000000000000000000',
  name: 'Workbench',
  normalizedName: 'workbench',
  levels: [
    level({
      level: 1,
      itemRequirements: [
        { itemId: ROUBLES_ID, name: 'Roubles', iconLink: null, count: 50000 },
        { itemId: 'bolts', name: 'Bolts', iconLink: null, count: 2 }
      ]
    }),
    level({
      level: 2,
      itemRequirements: [
        { itemId: 'bolts', name: 'Bolts', iconLink: null, count: 3 },
        { itemId: 'wires', name: 'Wires', iconLink: null, count: 4 }
      ],
      stationLevelRequirements: [
        { stationId: 'gen', name: 'Generator', normalizedName: 'generator', level: 2 }
      ]
    })
  ]
})

const generator = station({
  id: 'gen000000000000000000000',
  name: 'Generator',
  normalizedName: 'generator',
  levels: [
    level({
      level: 1,
      itemRequirements: [{ itemId: 'spark', name: 'Spark plug', iconLink: null, count: 1 }]
    }),
    level({ level: 2 })
  ]
})

describe('stationLevel / maxStationLevel / nextLevel', () => {
  it('treats missing keys as level 0', () => {
    expect(stationLevel({}, 'workbench')).toBe(0)
    expect(stationLevel({ workbench: 2 }, 'workbench')).toBe(2)
  })

  it('derives max level from the catalog', () => {
    expect(maxStationLevel(workbench)).toBe(2)
    expect(maxStationLevel(station({ id: 'x', name: 'X', normalizedName: 'x' }))).toBe(0)
  })

  it('returns the next unbuilt level, or null at max', () => {
    expect(nextLevel(workbench, {})?.level).toBe(1)
    expect(nextLevel(workbench, { workbench: 1 })?.level).toBe(2)
    expect(nextLevel(workbench, { workbench: 2 })).toBeNull()
  })
})

describe('checkStationPrereqs / canBuildLevel', () => {
  const wb2 = workbench.levels[1]

  it('marks unmet prerequisites with the current level', () => {
    const prereqs = checkStationPrereqs(wb2, { generator: 1 })
    expect(prereqs).toEqual([
      {
        name: 'Generator',
        normalizedName: 'generator',
        requiredLevel: 2,
        currentLevel: 1,
        met: false
      }
    ])
    expect(canBuildLevel(wb2, { generator: 1 })).toBe(false)
  })

  it('passes when the prerequisite level is met or exceeded', () => {
    expect(canBuildLevel(wb2, { generator: 2 })).toBe(true)
    expect(canBuildLevel(wb2, { generator: 3 })).toBe(true)
  })

  it('a level with no prerequisites is always buildable', () => {
    expect(canBuildLevel(workbench.levels[0], {})).toBe(true)
  })
})

describe('anyStationConfigured / canRunCraft', () => {
  it('only counts levels above 0', () => {
    expect(anyStationConfigured({})).toBe(false)
    expect(anyStationConfigured({ workbench: 0 })).toBe(false)
    expect(anyStationConfigured({ workbench: 1 })).toBe(true)
  })

  it('gates crafts on the recorded station level', () => {
    const craft = { stationNormalized: 'workbench', level: 2 }
    expect(canRunCraft(craft, {})).toBe(false)
    expect(canRunCraft(craft, { workbench: 1 })).toBe(false)
    expect(canRunCraft(craft, { workbench: 2 })).toBe(true)
    expect(canRunCraft(craft, { workbench: 3 })).toBe(true)
  })
})

describe('neededHideoutItems / remainingRequirements', () => {
  const stations = [workbench, generator]

  it('aggregates item counts across every unbuilt level of every station', () => {
    const needed = neededHideoutItems(stations, {})
    // Bolts wanted by Workbench 1 (×2) and Workbench 2 (×3).
    expect(needed.get('bolts')?.totalCount).toBe(5)
    expect(needed.get('bolts')?.needs).toEqual([
      { station: 'Workbench', level: 1, count: 2 },
      { station: 'Workbench', level: 2, count: 3 }
    ])
    expect(needed.get('wires')?.totalCount).toBe(4)
    expect(needed.get('spark')?.totalCount).toBe(1)
  })

  it('drops requirements already covered by built levels', () => {
    const needed = neededHideoutItems(stations, { workbench: 1, generator: 2 })
    expect(needed.get('bolts')?.totalCount).toBe(3) // only Workbench 2 remains
    expect(needed.has('spark')).toBe(false)
  })

  it('separates currency into cash totals instead of hoard rows', () => {
    const { items, cash } = remainingRequirements(stations, {})
    expect(items.some((i) => i.itemId === ROUBLES_ID)).toBe(false)
    expect(cash).toEqual([{ itemId: ROUBLES_ID, name: 'Roubles', total: 50000 }])
    expect(CURRENCY_ITEM_IDS[ROUBLES_ID]).toBe('Roubles')
  })

  it('sorts hoard items by name and returns nothing for a maxed hideout', () => {
    const all = remainingRequirements(stations, {})
    expect(all.items.map((i) => i.name)).toEqual(['Bolts', 'Spark plug', 'Wires'])
    const maxed = remainingRequirements(stations, { workbench: 2, generator: 2 })
    expect(maxed.items).toEqual([])
    expect(maxed.cash).toEqual([])
  })
})
