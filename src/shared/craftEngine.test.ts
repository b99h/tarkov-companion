import { describe, it, expect } from 'vitest'
import { evaluateCraft, isCraftUnlocked, scoreCrafts } from './craftEngine'
import type { CraftData, CraftItemRef, PlayerProgress } from './types'

function ref(overrides: Partial<CraftItemRef> & { id: string; name: string }): CraftItemRef {
  return {
    shortName: overrides.name,
    iconLink: null,
    count: 1,
    buyPriceRUB: null,
    sellPriceRUB: null,
    ...overrides
  }
}

function craft(overrides: Partial<CraftData> & { id: string }): CraftData {
  return {
    station: 'Workbench',
    stationNormalized: 'workbench',
    level: 1,
    durationSeconds: 3600,
    taskUnlock: null,
    requiredItems: [],
    rewardItems: [],
    ...overrides
  }
}

const progress: PlayerProgress = {
  completedTaskIds: ['quest-done'],
  failedTaskIds: [],
  playerLevel: 20,
  faction: 'Usec',
  stationLevels: {}
}

describe('evaluateCraft', () => {
  it('values inputs at buy price and rewards at best sell price', () => {
    const c = craft({
      id: 'c1',
      durationSeconds: 7200, // 2 hours
      requiredItems: [ref({ id: 'i1', name: 'Input', count: 2, buyPriceRUB: 1000 })],
      rewardItems: [ref({ id: 'r1', name: 'Reward', count: 1, sellPriceRUB: 10000 })]
    })
    const p = evaluateCraft(c)
    expect(p.costRUB).toBe(2000)
    expect(p.revenueRUB).toBe(10000)
    expect(p.profitRUB).toBe(8000)
    expect(p.profitPerHour).toBe(4000) // 8000 over 2h
    expect(p.fullyPriced).toBe(true)
  })

  it('uses the trader sell price for flea-banned rewards (e.g. Physical Bitcoin)', () => {
    const c = craft({
      id: 'btc',
      requiredItems: [],
      // No flea/buy price, only a trader sale price.
      rewardItems: [ref({ id: 'r', name: 'Physical Bitcoin', sellPriceRUB: 507785 })]
    })
    const p = evaluateCraft(c)
    expect(p.revenueRUB).toBe(507785)
    expect(p.profitRUB).toBe(507785)
    expect(p.fullyPriced).toBe(true)
  })

  it('flags a craft as not fully priced when an input has no price', () => {
    const c = craft({
      id: 'c2',
      requiredItems: [ref({ id: 'i', name: 'Unpriced input' })],
      rewardItems: [ref({ id: 'r', name: 'Reward', sellPriceRUB: 5000 })]
    })
    const p = evaluateCraft(c)
    expect(p.fullyPriced).toBe(false)
  })
})

describe('isCraftUnlocked', () => {
  const completed = new Set(progress.completedTaskIds)

  it('treats crafts with no quest gate as always unlocked', () => {
    expect(isCraftUnlocked(craft({ id: 'c' }), completed)).toBe(true)
  })

  it('unlocks a quest-gated craft once its quest is completed', () => {
    const c = craft({ id: 'c', taskUnlock: { id: 'quest-done', name: 'Done' } })
    expect(isCraftUnlocked(c, completed)).toBe(true)
  })

  it('keeps a quest-gated craft locked until its quest is completed', () => {
    const c = craft({ id: 'c', taskUnlock: { id: 'quest-todo', name: 'Not done' } })
    expect(isCraftUnlocked(c, completed)).toBe(false)
  })
})

describe('scoreCrafts', () => {
  const cheap = craft({
    id: 'cheap',
    durationSeconds: 3600,
    rewardItems: [ref({ id: 'r', name: 'Cheap', sellPriceRUB: 1000 })]
  })
  const rich = craft({
    id: 'rich',
    durationSeconds: 3600,
    rewardItems: [ref({ id: 'r', name: 'Rich', sellPriceRUB: 50000 })]
  })
  const lockedRich = craft({
    id: 'locked',
    durationSeconds: 3600,
    taskUnlock: { id: 'quest-todo', name: 'M61 unlock' },
    rewardItems: [ref({ id: 'r', name: 'Locked m61', sellPriceRUB: 99999 })]
  })

  it('ranks by profit per hour, most profitable first', () => {
    const ranked = scoreCrafts([cheap, rich], progress)
    expect(ranked.map((r) => r.craft.id)).toEqual(['rich', 'cheap'])
  })

  it('excludes crafts gated behind an uncompleted quest', () => {
    const ranked = scoreCrafts([cheap, rich, lockedRich], progress)
    expect(ranked.some((r) => r.craft.id === 'locked')).toBe(false)
  })

  it('includes a quest-gated craft once the quest is completed', () => {
    const completedProgress: PlayerProgress = {
      ...progress,
      completedTaskIds: [...progress.completedTaskIds, 'quest-todo']
    }
    const ranked = scoreCrafts([cheap, lockedRich], completedProgress)
    expect(ranked[0].craft.id).toBe('locked') // highest value, now unlocked
  })

  it('drops crafts that could not be fully priced by default', () => {
    const unpriced = craft({
      id: 'unpriced',
      rewardItems: [ref({ id: 'r', name: 'No price' })]
    })
    const ranked = scoreCrafts([cheap, unpriced], progress)
    expect(ranked.some((r) => r.craft.id === 'unpriced')).toBe(false)
  })

  it('honors the limit option', () => {
    const ranked = scoreCrafts([cheap, rich], progress, { limit: 1 })
    expect(ranked).toHaveLength(1)
    expect(ranked[0].craft.id).toBe('rich')
  })
})
