import { describe, it, expect } from 'vitest'
import {
  deriveTaskStates,
  getKappaProgress,
  scoreNextTargets,
  itemsToHoard,
  neededQuestItems,
  taskMaps,
  inferPrerequisiteCompletions,
  matchOcrLinesToTasks,
  compareTraders,
  compareMaps,
  normalizeFaction,
  duplicateTaskNames,
  taskNameQualifier,
  reconcileWithActiveList,
  cascadeClearedCompletions,
  normalizeMapName,
  compareAvailableQuests,
  kappaPriorityScore,
  MAP_ORDER,
  TRADER_ORDER
} from './questEngine'
import type { TaskData, TaskRequirement, PlayerProgress, TaskWithStatus } from './types'

function task(overrides: Partial<TaskData> & { id: string; name: string }): TaskData {
  const requiredTaskIds = overrides.requiredTaskIds ?? []
  // Default every prerequisite to plain completion-required, matching the common
  // case; tests that exercise failed/active acceptance pass `requirements` explicitly.
  const requirements: TaskRequirement[] =
    overrides.requirements ?? requiredTaskIds.map((id) => ({ taskId: id, statuses: ['complete'] }))
  return {
    trader: 'Prapor',
    minPlayerLevel: 1,
    kappaRequired: false,
    factionName: 'Any',
    objectives: [],
    wikiLink: null,
    taskImageLink: null,
    ...overrides,
    requiredTaskIds,
    requirements
  }
}

function fir(id: string, name: string, count: number) {
  return { id, name, count, foundInRaid: true }
}

const tasks: TaskData[] = [
  task({ id: 'A', name: 'Debut' }),
  task({ id: 'B', name: 'Follow The Guide', kappaRequired: true, requiredTaskIds: ['A'] }),
  task({
    id: 'C',
    name: 'Shortage',
    minPlayerLevel: 10,
    requiredTaskIds: ['A'],
    objectives: [{ id: 'o1', type: 'giveItem', description: '', optional: false, maps: [], zones: [], items: [fir('i1', 'Bolts', 5)] }]
  }),
  task({
    id: 'D',
    name: 'Gunsmith Part 1',
    kappaRequired: true,
    requiredTaskIds: ['B'],
    objectives: [{ id: 'o2', type: 'giveItem', description: '', optional: false, maps: [], zones: [], items: [fir('i2', 'Screws', 2)] }]
  }),
  task({
    id: 'E',
    name: 'The Punisher',
    kappaRequired: true,
    factionName: 'Usec',
    requiredTaskIds: ['C'],
    objectives: [{ id: 'o3', type: 'giveItem', description: '', optional: false, maps: [], zones: [], items: [fir('i3', 'Bolts', 3)] }]
  }),
  task({ id: 'F', name: 'Farming', factionName: 'Usec' })
]

const progress: PlayerProgress = {
  completedTaskIds: ['A'],
  failedTaskIds: [],
  playerLevel: 5,
  faction: 'Bear',
  stationLevels: {}
}

describe('deriveTaskStates', () => {
  it('marks completed tasks as completed', () => {
    const states = deriveTaskStates(tasks, progress)
    expect(states.find((t) => t.id === 'A')?.status).toBe('completed')
  })

  it('marks a task with met prerequisites and level as available', () => {
    const states = deriveTaskStates(tasks, progress)
    expect(states.find((t) => t.id === 'B')?.status).toBe('available')
  })

  it('level-gates a task whose min level exceeds the player level', () => {
    const states = deriveTaskStates(tasks, progress)
    expect(states.find((t) => t.id === 'C')?.status).toBe('level-locked')
  })

  it('locks a task on an incomplete prerequisite, tracking which one', () => {
    const states = deriveTaskStates(tasks, progress)
    const d = states.find((t) => t.id === 'D')
    expect(d?.status).toBe('locked')
    expect(d?.blockedByTaskIds).toEqual(['B'])
  })

  it('prioritizes the prerequisite lock over a faction mismatch', () => {
    const states = deriveTaskStates(tasks, progress)
    expect(states.find((t) => t.id === 'E')?.status).toBe('locked')
  })

  it('faction-locks a task with no other blockers but a faction mismatch', () => {
    const states = deriveTaskStates(tasks, progress)
    expect(states.find((t) => t.id === 'F')?.status).toBe('faction-locked')
  })

  it('unlocks a task whose requirement is satisfied by a failed prerequisite', () => {
    const withFailable: TaskData[] = [
      task({ id: 'P', name: 'Prereq' }),
      task({
        id: 'Q',
        name: 'Unlocks on complete-or-failed',
        requiredTaskIds: ['P'],
        requirements: [{ taskId: 'P', statuses: ['complete', 'failed'] }]
      })
    ]
    const failedProgress: PlayerProgress = {
      completedTaskIds: [],
      failedTaskIds: ['P'],
      playerLevel: 5,
      faction: 'Bear',
      stationLevels: {}
    }
    const states = deriveTaskStates(withFailable, failedProgress)
    expect(states.find((t) => t.id === 'Q')?.status).toBe('available')
  })

  it('locks a complete-or-failed requirement when the prereq is neither', () => {
    const withFailable: TaskData[] = [
      task({ id: 'P', name: 'Prereq' }),
      task({
        id: 'Q',
        name: 'Unlocks on complete-or-failed',
        requiredTaskIds: ['P'],
        requirements: [{ taskId: 'P', statuses: ['complete', 'failed'] }]
      })
    ]
    const states = deriveTaskStates(withFailable, {
      completedTaskIds: [],
      failedTaskIds: [],
      playerLevel: 5,
      faction: 'Bear',
      stationLevels: {}
    })
    const q = states.find((t) => t.id === 'Q')
    expect(q?.status).toBe('locked')
    expect(q?.blockedByTaskIds).toEqual(['P'])
  })

  it('unlocks an active-satisfiable requirement once the prereq is itself available', () => {
    // R2 unlocks while R1 is merely active; R1 is available (no blockers, level
    // met), so we approximate R1 as plausibly-active and let R2 through.
    const chain: TaskData[] = [
      task({ id: 'R1', name: 'In progress' }),
      task({
        id: 'R2',
        name: 'Unlocks while prereq active',
        requiredTaskIds: ['R1'],
        requirements: [{ taskId: 'R1', statuses: ['active'] }]
      })
    ]
    const states = deriveTaskStates(chain, {
      completedTaskIds: [],
      failedTaskIds: [],
      playerLevel: 5,
      faction: 'Bear',
      stationLevels: {}
    })
    expect(states.find((t) => t.id === 'R2')?.status).toBe('available')
  })
})

describe('getKappaProgress', () => {
  it('counts only kappa-required tasks', () => {
    const result = getKappaProgress(tasks, progress)
    expect(result.total).toBe(3)
    expect(result.completed).toBe(0)
    expect(result.percent).toBe(0)
  })
})

describe('scoreNextTargets', () => {
  it('ranks the only available task and credits it for unlocking a downstream kappa quest', () => {
    const targets = scoreNextTargets(tasks, progress)
    expect(targets).toHaveLength(1)
    expect(targets[0].task.id).toBe('B')
    expect(targets[0].reasons).toContain('Required for Kappa')
    expect(targets[0].reasons).toContain('Unlocks 1 more Kappa quest')
  })

  it('excludes available tasks that are off the Kappa path entirely (e.g. fence quests)', () => {
    const tasksWithFenceQuest: TaskData[] = [
      ...tasks,
      task({ id: 'H', name: 'Farm Fresh Meat', trader: 'Fence' })
    ]
    const targets = scoreNextTargets(tasksWithFenceQuest, progress)
    expect(targets.some((t) => t.task.id === 'H')).toBe(false)
  })
})

describe('compareAvailableQuests', () => {
  // Minimal available-quest fixtures; only the fields the comparator reads matter.
  function avail(
    id: string,
    name: string,
    opts: { kappaRequired?: boolean; minPlayerLevel?: number } = {}
  ): TaskWithStatus {
    return {
      ...task({ id, name, kappaRequired: opts.kappaRequired, minPlayerLevel: opts.minPlayerLevel }),
      status: 'available',
      blockedByTaskIds: []
    }
  }

  const alpha = avail('a', 'Alpha', { minPlayerLevel: 20 })
  const bravo = avail('b', 'Bravo', { kappaRequired: true, minPlayerLevel: 5 })
  const charlie = avail('c', 'Charlie', { minPlayerLevel: 10 })
  const downstream = new Map<string, number>([
    ['a', 3], // most unblocking
    ['b', 0],
    ['c', 1]
  ])

  it('kappa mode ranks the most-unblocking quest first, weighting downstream over self', () => {
    const sorted = [charlie, bravo, alpha].sort(compareAvailableQuests('kappa', downstream))
    // a: 3*2=6, c: 1*2=2, b: 0*2+1=1
    expect(sorted.map((t) => t.id)).toEqual(['a', 'c', 'b'])
  })

  it('level mode orders by lowest player-level gate first', () => {
    const sorted = [alpha, charlie, bravo].sort(compareAvailableQuests('level', downstream))
    expect(sorted.map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('alphabetical mode orders by name', () => {
    const sorted = [charlie, alpha, bravo].sort(compareAvailableQuests('alphabetical', downstream))
    expect(sorted.map((t) => t.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('breaks ties alphabetically for a stable order', () => {
    const x = avail('x', 'Zulu', { minPlayerLevel: 10 })
    const y = avail('y', 'Mike', { minPlayerLevel: 10 })
    const sorted = [x, y].sort(compareAvailableQuests('level', new Map()))
    expect(sorted.map((t) => t.name)).toEqual(['Mike', 'Zulu'])
  })

  it('kappaPriorityScore weights downstream unlocks above being Kappa itself', () => {
    expect(kappaPriorityScore({ kappaRequired: true }, 0)).toBe(1)
    expect(kappaPriorityScore({ kappaRequired: false }, 1)).toBe(2)
    expect(kappaPriorityScore({ kappaRequired: true }, 2)).toBe(5)
  })
})

describe('taskMaps', () => {
  it('returns the unique set of map names across a task\'s objectives', () => {
    const t = task({
      id: 'M',
      name: 'Multi-map',
      objectives: [
        { id: 'o1', type: 'visit', description: '', optional: false, maps: ['Customs', 'Woods'], zones: [], items: [] },
        { id: 'o2', type: 'visit', description: '', optional: false, maps: ['Customs'], zones: [], items: [] }
      ]
    })
    expect(taskMaps(t)).toEqual(['Customs', 'Woods'])
  })

  it('returns an empty array for a turn-in-only task with no map objectives', () => {
    const t = task({ id: 'N', name: 'Turn-in only' })
    expect(taskMaps(t)).toEqual([])
  })
})

describe('itemsToHoard', () => {
  it('aggregates found-in-raid items across incomplete tasks and sorts by usage count', () => {
    const hoard = itemsToHoard(tasks, progress)
    const bolts = hoard.find((h) => h.itemName === 'Bolts')
    const screws = hoard.find((h) => h.itemName === 'Screws')

    expect(bolts?.totalCount).toBe(8)
    expect(bolts?.neededFor).toEqual(['Shortage', 'The Punisher'])
    expect(screws?.totalCount).toBe(2)
    expect(hoard[0].itemName).toBe('Bolts')
  })

  it('excludes items from already-completed tasks', () => {
    const progressWithC: PlayerProgress = { ...progress, completedTaskIds: ['A', 'C'] }
    const hoard = itemsToHoard(tasks, progressWithC)
    const bolts = hoard.find((h) => h.itemName === 'Bolts')
    expect(bolts?.totalCount).toBe(3)
    expect(bolts?.neededFor).toEqual(['The Punisher'])
  })

  it('lists a task at most once even if it has multiple FIR objectives for the same item', () => {
    const tasksWithDupeObjective: TaskData[] = [
      ...tasks,
      task({
        id: 'G',
        name: 'Counteraction',
        objectives: [
          { id: 'o4a', type: 'giveItem', description: '', optional: false, maps: [], zones: [], items: [fir('i4', 'Dogtag BEAR', 2)] },
          { id: 'o4b', type: 'giveItem', description: '', optional: false, maps: [], zones: [], items: [fir('i4', 'Dogtag BEAR', 1)] }
        ]
      })
    ]
    const hoard = itemsToHoard(tasksWithDupeObjective, progress)
    const dogtags = hoard.find((h) => h.itemName === 'Dogtag BEAR')
    expect(dogtags?.neededFor).toEqual(['Counteraction'])
    expect(dogtags?.totalCount).toBe(2)
  })
})

describe('neededQuestItems', () => {
  it('maps item ids to the incomplete tasks that need them (FIR or not)', () => {
    const needed = neededQuestItems(tasks, progress)
    // i1 is required by Shortage (task C), which is not completed.
    expect(needed.get('i1')).toEqual(['Shortage'])
  })

  it('excludes items only required by completed tasks', () => {
    const progressWithC: PlayerProgress = { ...progress, completedTaskIds: ['A', 'C'] }
    const needed = neededQuestItems(tasks, progressWithC)
    expect(needed.has('i1')).toBe(false)
  })
})

describe('inferPrerequisiteCompletions', () => {
  // Chain: A <- B <- D, and A <- C <- E (from the shared `tasks` fixture).
  it('walks the full transitive chain upstream of an active task', () => {
    const result = inferPrerequisiteCompletions(['D'], tasks, [])
    expect(new Set(result.completed)).toEqual(new Set(['A', 'B']))
    expect(result.uncertain).toEqual([])
  })

  it('does not include the active task itself', () => {
    const result = inferPrerequisiteCompletions(['D'], tasks, [])
    expect(result.completed).not.toContain('D')
  })

  it('excludes prerequisites already marked completed', () => {
    const result = inferPrerequisiteCompletions(['D'], tasks, ['A'])
    expect(result.completed).toEqual(['B'])
  })

  it('unions and dedupes prerequisites across multiple active tasks sharing an ancestor', () => {
    const result = inferPrerequisiteCompletions(['D', 'E'], tasks, [])
    expect(new Set(result.completed)).toEqual(new Set(['A', 'B', 'C']))
  })

  it('returns nothing for a task with no prerequisites', () => {
    const result = inferPrerequisiteCompletions(['A'], tasks, [])
    expect(result.completed).toEqual([])
    expect(result.uncertain).toEqual([])
  })

  it('marks a prereq uncertain (not completed) when it could also be satisfied by failure', () => {
    // P2 unlocks whether P1 was completed OR failed — so P1 being upstream of an
    // active P2 does not prove P1 was completed.
    const chain: TaskData[] = [
      task({ id: 'P1', name: 'Prereq' }),
      task({
        id: 'P2',
        name: 'Follow-up',
        requiredTaskIds: ['P1'],
        requirements: [{ taskId: 'P1', statuses: ['complete', 'failed'] }]
      })
    ]
    const result = inferPrerequisiteCompletions(['P2'], chain, [])
    expect(result.completed).toEqual([])
    expect(result.uncertain).toEqual(['P1'])
  })

  it('does not traverse upstream past an uncertain prerequisite', () => {
    // G <- P1 (complete-only) <- P2 (complete|active). P2's edge to P1 is
    // uncertain, so we stop there: P1 is surfaced unchecked and G — reachable
    // only through P1 — is never inferred at all.
    const chain: TaskData[] = [
      task({ id: 'G', name: 'Grandparent' }),
      task({ id: 'P1', name: 'Parent', requiredTaskIds: ['G'] }),
      task({
        id: 'P2',
        name: 'Child',
        requiredTaskIds: ['P1'],
        requirements: [{ taskId: 'P1', statuses: ['complete', 'active'] }]
      })
    ]
    const result = inferPrerequisiteCompletions(['P2'], chain, [])
    expect(result.completed).toEqual([])
    expect(result.uncertain).toEqual(['P1'])
  })

  it('descends through a completion-certain prereq to surface its uncertain ancestor', () => {
    // P2 -> P1 is complete-only (certain), P1 -> G is complete|active (uncertain).
    const chain: TaskData[] = [
      task({ id: 'G', name: 'Grandparent' }),
      task({
        id: 'P1',
        name: 'Parent',
        requiredTaskIds: ['G'],
        requirements: [{ taskId: 'G', statuses: ['complete', 'active'] }]
      }),
      task({ id: 'P2', name: 'Child', requiredTaskIds: ['P1'] })
    ]
    const result = inferPrerequisiteCompletions(['P2'], chain, [])
    expect(result.completed).toEqual(['P1'])
    expect(result.uncertain).toEqual(['G'])
  })
})

describe('matchOcrLinesToTasks', () => {
  it('confidently matches an exact task name', () => {
    const matches = matchOcrLinesToTasks(['Gunsmith Part 1'], tasks)
    expect(matches[0].matchedTaskId).toBe('D')
  })

  it('tolerates OCR noise/typos via fuzzy similarity', () => {
    const matches = matchOcrLinesToTasks(['Gunsmlth Part '], tasks)
    expect(matches[0].matchedTaskId).toBe('D')
  })

  it('leaves a garbage line unmatched', () => {
    const matches = matchOcrLinesToTasks(['xzq totally unrelated qwerty'], tasks)
    expect(matches[0].matchedTaskId).toBeNull()
  })

  it('does not coincidentally match short UI-chrome noise against an unrelated short quest name', () => {
    // Real OCR noise from a game screen's nav bar/icon columns bleeding into
    // a line — no genuine word overlap with any quest name, but short
    // enough that naive whole-line edit-distance similarity could spike.
    const matches = matchOcrLinesToTasks(['< sk HEALTH NC orc'], tasks)
    expect(matches[0].matchedTaskId).toBeNull()
    expect(matches[0].candidates).toEqual([])
  })

  it('filters out blank lines', () => {
    const matches = matchOcrLinesToTasks(['', '   ', 'Debut'], tasks)
    expect(matches).toHaveLength(1)
    expect(matches[0].line).toBe('Debut')
  })

  it('matches a quest name embedded in a noisy tracker table row', () => {
    // OCR of a third-party tracker's table row: icons/columns collapse into
    // junk text around the actual quest name, plus a trailing status/percent.
    const matches = matchOcrLinesToTasks(
      ['1 <7 @ Gunsmith Part 1 Any location active! 0%'],
      tasks
    )
    expect(matches[0].matchedTaskId).toBe('D')
  })

  it('disambiguates "Part N" quests by their number instead of tying them', () => {
    // Every part shares the same words apart from the number, so dropping the
    // digit would collapse them into one ambiguous blob. The number must break
    // the tie — and pick the exact part even past single digits.
    const series: TaskData[] = [
      task({ id: 'G1', name: 'Gunsmith - Part 1' }),
      task({ id: 'G2', name: 'Gunsmith - Part 2' }),
      task({ id: 'G25', name: 'Gunsmith - Part 25' })
    ]
    expect(matchOcrLinesToTasks(['Gunsmith - Part 2'], series)[0].matchedTaskId).toBe('G2')
    expect(matchOcrLinesToTasks(['Gunsmith - Part 25'], series)[0].matchedTaskId).toBe('G25')
  })

  it('ties on faction-mirrored quests (same name, different id) until the caller filters by faction', () => {
    // Tarkov's catalog has genuine same-name quests split by faction (e.g.
    // "The Tarkov Shooter", "Ambulance" chains) with different task ids. The
    // matcher alone can't tell them apart — it's the caller's job to narrow
    // the candidate list to the player's faction before calling this, so this
    // test documents (and locks in) that pre-filter responsibility rather than
    // baking faction logic into the matcher itself.
    const mirrored: TaskData[] = [
      task({ id: 'M-usec', name: 'The Tarkov Shooter - Part 5', factionName: 'Usec' }),
      task({ id: 'M-bear', name: 'The Tarkov Shooter - Part 5', factionName: 'Bear' })
    ]
    const matches = matchOcrLinesToTasks(['The Tarkov Shooter - Part 5'], mirrored)
    expect(matches[0].matchedTaskId).toBeNull()

    const usecOnly = matchOcrLinesToTasks(
      ['The Tarkov Shooter - Part 5'],
      mirrored.filter((t) => t.factionName === 'Usec')
    )
    expect(usecOnly[0].matchedTaskId).toBe('M-usec')
  })

  it('leaves an ambiguous line unmatched but reports the close candidates', () => {
    const nearDuplicates: TaskData[] = [
      task({ id: 'X1', name: 'Big Sale' }),
      task({ id: 'X2', name: 'Pig Sale' })
    ]
    // Equidistant (1 edit) from both names, so neither clears the other by
    // the ambiguity margin.
    const matches = matchOcrLinesToTasks(['Wig Sale'], nearDuplicates)
    expect(matches[0].matchedTaskId).toBeNull()
    expect(matches[0].candidates.map((c) => c.taskId)).toEqual(
      expect.arrayContaining(['X1', 'X2'])
    )
  })
})

describe('compareTraders', () => {
  it('sorts known traders in canonical in-game order, not alphabetically', () => {
    const sorted = ['Fence', 'Prapor', 'BTR Driver', 'Therapist'].sort(compareTraders)
    expect(sorted).toEqual(['Prapor', 'Therapist', 'BTR Driver', 'Fence'])
  })

  it('is case-insensitive on trader names', () => {
    expect(compareTraders('prapor', 'THERAPIST')).toBeLessThan(0)
  })

  it('sorts unknown traders after all known ones, alphabetically among themselves', () => {
    const sorted = ['Zephyr', 'Prapor', 'Arbiter'].sort(compareTraders)
    expect(sorted).toEqual(['Prapor', 'Arbiter', 'Zephyr'])
  })

  it('matches the full canonical order end to end', () => {
    const shuffled = [...TRADER_ORDER].reverse()
    expect([...shuffled].sort(compareTraders)).toEqual(TRADER_ORDER)
  })
})

describe('normalizeMapName', () => {
  it('collapses condition-specific variants onto their canonical map', () => {
    expect(normalizeMapName('Ground Zero 21+')).toBe('Ground Zero')
    expect(normalizeMapName('Night Factory')).toBe('Factory')
    expect(normalizeMapName('The Lab (Dark)')).toBe('The Lab')
  })

  it('leaves an already-canonical or unknown map unchanged', () => {
    expect(normalizeMapName('Customs')).toBe('Customs')
    expect(normalizeMapName('Somewhere New')).toBe('Somewhere New')
  })
})

describe('compareMaps', () => {
  it('sorts known maps in canonical board order, not alphabetically', () => {
    const sorted = ['Reserve', 'Ground Zero', 'Woods', 'Customs'].sort(compareMaps)
    expect(sorted).toEqual(['Ground Zero', 'Customs', 'Woods', 'Reserve'])
  })

  it('sorts unknown maps after all known ones, alphabetically among themselves', () => {
    const sorted = ['Terminal', 'Customs', 'Atlas'].sort(compareMaps)
    expect(sorted).toEqual(['Customs', 'Atlas', 'Terminal'])
  })

  it('matches the full canonical order end to end', () => {
    const shuffled = [...MAP_ORDER].reverse()
    expect([...shuffled].sort(compareMaps)).toEqual(MAP_ORDER)
  })
})

describe('normalizeFaction', () => {
  // Regression: tarkov.dev sends UPPERCASE faction names. The original
  // exact-case check ('Usec'/'Bear') mapped every faction-locked task to
  // 'Any', so BEAR and USEC twins of the same quest both rendered on the
  // board (duplicate "Drip-Out - Part 1" under Ragman) and Quest Catchup's
  // faction filter silently matched everything.
  it('accepts the API’s uppercase casing', () => {
    expect(normalizeFaction('USEC')).toBe('Usec')
    expect(normalizeFaction('BEAR')).toBe('Bear')
  })

  it('accepts the internal casing too', () => {
    expect(normalizeFaction('Usec')).toBe('Usec')
    expect(normalizeFaction('Bear')).toBe('Bear')
  })

  it('falls back to Any for null, empty, and unknown factions', () => {
    expect(normalizeFaction(null)).toBe('Any')
    expect(normalizeFaction('')).toBe('Any')
    expect(normalizeFaction('Any')).toBe('Any')
    expect(normalizeFaction('Scav')).toBe('Any')
  })
})

describe('duplicateTaskNames / taskNameQualifier', () => {
  // Real shape from the live catalog: three distinct "Make Amends" quests under
  // Mechanic, each gated behind a different upstream branch.
  const equipment = task({ id: 'eq', name: 'Make Amends - Equipment' })
  const sweep = task({ id: 'sw', name: 'Make Amends - Sweep Up' })
  const amends1 = task({ id: 'm1', name: 'Make Amends', requiredTaskIds: ['eq'] })
  const amends2 = task({ id: 'm2', name: 'Make Amends', requiredTaskIds: ['sw'] })
  const solo = task({ id: 's', name: 'Debut' })
  const all = [equipment, sweep, amends1, amends2, solo]
  const nameById = new Map(all.map((t) => [t.id, t.name]))

  it('reports only names held by more than one task', () => {
    expect(duplicateTaskNames(all)).toEqual(new Set(['Make Amends']))
  })

  it('distinguishes same-name quests by their differing prerequisites', () => {
    const dupes = duplicateTaskNames(all)
    expect(taskNameQualifier(amends1, dupes, nameById)).toBe('after Make Amends - Equipment')
    expect(taskNameQualifier(amends2, dupes, nameById)).toBe('after Make Amends - Sweep Up')
  })

  it('returns null for an unambiguous name, so normal rows are untouched', () => {
    expect(taskNameQualifier(solo, duplicateTaskNames(all), nameById)).toBeNull()
  })

  it('returns null when a duplicated name has no resolvable prerequisite', () => {
    const a = task({ id: 'a1', name: 'Twin' })
    const b = task({ id: 'a2', name: 'Twin' })
    const dupes = duplicateTaskNames([a, b])
    expect(taskNameQualifier(a, dupes, new Map())).toBeNull()
  })
})

describe('reconcileWithActiveList', () => {
  // A: available + unseen -> already done. B: completed + seen -> record wrong.
  // C: seen but locked -> upstream gap. Plus the two exclusion rules.
  const catalog: TaskData[] = [
    task({ id: 'done-invisible', name: 'Finished Side Chain' }),
    task({ id: 'really-active', name: 'Really Active' }),
    task({ id: 'wrongly-done', name: 'Wrongly Marked Done' }),
    task({ id: 'gated', name: 'Level Gated', minPlayerLevel: 40 }),
    task({ id: 'blocked', name: 'Blocked', requiredTaskIds: ['really-active'] }),
    task({ id: 'other-faction', name: 'Bear Only', factionName: 'Bear' })
  ]
  const prog: PlayerProgress = {
    completedTaskIds: ['wrongly-done'],
    failedTaskIds: [],
    playerLevel: 20,
    faction: 'Usec',
    stationLevels: {}
  }

  it('proposes completing available quests absent from a complete list', () => {
    const r = reconcileWithActiveList(['really-active', 'wrongly-done'], catalog, prog)
    expect(r.toComplete).toContain('done-invisible')
    expect(r.toComplete).not.toContain('really-active')
  })

  it('proposes un-completing a tracked-done quest that is actually active', () => {
    const r = reconcileWithActiveList(['really-active', 'wrongly-done'], catalog, prog)
    expect(r.toUncomplete).toEqual(['wrongly-done'])
  })

  it('reports a seen-but-locked quest instead of silently acting on it', () => {
    const r = reconcileWithActiveList(['blocked'], catalog, prog)
    expect(r.activeButLocked).toEqual(['blocked'])
    expect(r.toComplete).not.toContain('blocked')
  })

  it('never proposes completing a level-locked quest (absent due to level, not completion)', () => {
    const r = reconcileWithActiveList([], catalog, prog)
    expect(r.toComplete).not.toContain('gated')
  })

  it('ignores other-faction quests entirely', () => {
    const r = reconcileWithActiveList([], catalog, prog)
    expect(r.toComplete).not.toContain('other-faction')
    expect(r.activeButLocked).not.toContain('other-faction')
  })
})

describe('reconcileWithActiveList — cascade to a fixed point', () => {
  // A -> B -> C chain, none tracked done, none in the capture. Only A is
  // available at the start; completing it unlocks B, then C. A single pass
  // would propose A alone and leave B (then C) surfacing as freshly
  // "available" quests the player had actually finished long ago.
  const chain: TaskData[] = [
    task({ id: 'A', name: 'First' }),
    task({ id: 'B', name: 'Second', requiredTaskIds: ['A'] }),
    task({ id: 'C', name: 'Third', requiredTaskIds: ['B'] })
  ]
  const prog: PlayerProgress = {
    completedTaskIds: [],
    failedTaskIds: [],
    playerLevel: 50,
    faction: 'Usec',
    stationLevels: {}
  }

  it('cascades through the whole unlocked chain, not just the first step', () => {
    const r = reconcileWithActiveList([], chain, prog)
    expect(new Set(r.toComplete)).toEqual(new Set(['A', 'B', 'C']))
  })

  it('stops at a quest that IS in the capture, leaving its dependants alone', () => {
    // B is genuinely active, so B and everything behind it stay untouched.
    const r = reconcileWithActiveList(['B'], chain, prog)
    expect(r.toComplete).toEqual(['A'])
    expect(r.toComplete).not.toContain('B')
    expect(r.toComplete).not.toContain('C')
  })

  it('does not cascade past a level gate', () => {
    const gated: TaskData[] = [
      task({ id: 'A', name: 'First' }),
      task({ id: 'B', name: 'Second', requiredTaskIds: ['A'], minPlayerLevel: 99 })
    ]
    const r = reconcileWithActiveList([], gated, prog)
    expect(r.toComplete).toEqual(['A'])
  })
})

describe('inferPrerequisiteCompletions — active quests are never inferred done', () => {
  // Real shape from the live catalog: House Arrest - Part 1 requires Debtor
  // complete-only, and is itself pulled into the walk from a genuinely active
  // quest further downstream. Debtor is ALSO in the player's active list, so
  // it must never be proposed as completed however the graph reads.
  const catalog: TaskData[] = [
    task({ id: 'debtor', name: 'Debtor' }),
    task({ id: 'ha1', name: 'House Arrest - Part 1', requiredTaskIds: ['debtor'] }),
    task({ id: 'np1', name: 'Network Provider - Part 1', requiredTaskIds: ['ha1'] })
  ]

  it('excludes a quest the player has active, even when required complete-only', () => {
    // np1 and debtor are both active; the walk from np1 reaches debtor via ha1.
    const r = inferPrerequisiteCompletions(['np1', 'debtor'], catalog, [])
    expect(r.completed).toContain('ha1')
    expect(r.completed).not.toContain('debtor')
    expect(r.uncertain).not.toContain('debtor')
  })

  it('still infers it when the player does NOT have it active', () => {
    const r = inferPrerequisiteCompletions(['np1'], catalog, [])
    expect(r.completed).toEqual(expect.arrayContaining(['ha1', 'debtor']))
  })
})

describe('reconcileWithActiveList — corroborated completions are not proposed for clearing', () => {
  // The live Debtor case, reduced. Debtor showed up in the capture (3 clean OCR
  // hits) while tracked complete, so plain reconciliation proposed clearing it —
  // wrongly. Goals and Means was in that same capture, and is only reachable
  // through a complete-only chain running back through Debtor, so Debtor is
  // provably done and the capture is what's misleading (Tarkov keeps a finished
  // quest listed until turn-in).
  const catalog: TaskData[] = [
    task({ id: 'debtor', name: 'Debtor' }),
    task({ id: 'ha1', name: 'House Arrest - Part 1', requiredTaskIds: ['debtor'] }),
    task({ id: 'np1', name: 'Network Provider - Part 1', requiredTaskIds: ['ha1'] }),
    task({ id: 'goals', name: 'Goals and Means', requiredTaskIds: ['np1'] }),
    // No completion-demanding descendant: nothing settles it either way, so it
    // stays a genuine mismatch for the user to judge (live: Hobby Club).
    task({ id: 'hobby', name: 'Hobby Club' })
  ]
  const prog: PlayerProgress = {
    completedTaskIds: ['debtor', 'ha1', 'np1', 'hobby'],
    failedTaskIds: [],
    playerLevel: 50,
    faction: 'Usec',
    stationLevels: {}
  }

  it('does not propose clearing a completion its active descendant proves', () => {
    const r = reconcileWithActiveList(['goals', 'debtor'], catalog, prog)
    expect(r.toUncomplete).not.toContain('debtor')
    expect(r.corroboratedUncomplete.map((c) => c.taskId)).toContain('debtor')
  })

  it('names the evidence rather than silently skipping the mismatch', () => {
    const r = reconcileWithActiveList(['goals', 'debtor'], catalog, prog)
    const entry = r.corroboratedUncomplete.find((c) => c.taskId === 'debtor')
    expect(entry?.corroboratedBy).toEqual(expect.arrayContaining(['goals']))
  })

  it('still proposes clearing a completion nothing downstream corroborates', () => {
    const r = reconcileWithActiveList(['goals', 'hobby'], catalog, prog)
    expect(r.toUncomplete).toContain('hobby')
    expect(r.corroboratedUncomplete.map((c) => c.taskId)).not.toContain('hobby')
  })

  it('accepts an already-completed descendant as corroboration too', () => {
    // Nothing but debtor is in the capture; np1 being tracked done still settles it.
    const r = reconcileWithActiveList(['debtor'], catalog, prog)
    expect(r.toUncomplete).not.toContain('debtor')
  })

  it('ignores descendants reached through an edge that accepts active or failed', () => {
    // A dependant that would take Debtor failed proves nothing about it.
    const loose: TaskData[] = [
      task({ id: 'debtor', name: 'Debtor' }),
      task({
        id: 'either',
        name: 'Either Way',
        requiredTaskIds: ['debtor'],
        requirements: [{ taskId: 'debtor', statuses: ['complete', 'failed'] }]
      })
    ]
    const p: PlayerProgress = { ...prog, completedTaskIds: ['debtor', 'either'] }
    const r = reconcileWithActiveList(['debtor'], loose, p)
    expect(r.toUncomplete).toContain('debtor')
  })
})

describe('cascadeClearedCompletions', () => {
  // Clearing Debtor cannot leave the chain it unlocked still marked done.
  const catalog: TaskData[] = [
    task({ id: 'debtor', name: 'Debtor' }),
    task({ id: 'ha1', name: 'House Arrest - Part 1', requiredTaskIds: ['debtor'] }),
    task({ id: 'np1', name: 'Network Provider - Part 1', requiredTaskIds: ['ha1'] }),
    task({ id: 'unrelated', name: 'Unrelated' })
  ]
  const completed = ['debtor', 'ha1', 'np1', 'unrelated']

  it('clears everything downstream of the cleared completion', () => {
    const r = cascadeClearedCompletions(['debtor'], catalog, completed)
    expect(r.requested).toEqual(['debtor'])
    expect(new Set(r.cascaded)).toEqual(new Set(['ha1', 'np1']))
    expect(new Set(r.all)).toEqual(new Set(['debtor', 'ha1', 'np1']))
  })

  it('leaves quests off the cleared quest’s chain alone', () => {
    const r = cascadeClearedCompletions(['debtor'], catalog, completed)
    expect(r.all).not.toContain('unrelated')
  })

  it('only cascades tracked completions — an unfinished descendant has nothing to clear', () => {
    const r = cascadeClearedCompletions(['debtor'], catalog, ['debtor', 'ha1'])
    expect(new Set(r.all)).toEqual(new Set(['debtor', 'ha1']))
  })

  it('does not double-count a descendant the user already asked to clear', () => {
    const r = cascadeClearedCompletions(['debtor', 'ha1'], catalog, completed)
    expect(new Set(r.requested)).toEqual(new Set(['debtor', 'ha1']))
    expect(r.cascaded).toEqual(['np1'])
    expect(r.all).toHaveLength(3)
  })

  it('ignores ids that are not tracked as completed at all', () => {
    const r = cascadeClearedCompletions(['debtor'], catalog, ['unrelated'])
    expect(r.all).toEqual([])
  })

  it('does not cascade through an edge that accepts a failed prerequisite', () => {
    const loose: TaskData[] = [
      task({ id: 'x', name: 'X' }),
      task({
        id: 'y',
        name: 'Y',
        requiredTaskIds: ['x'],
        requirements: [{ taskId: 'x', statuses: ['complete', 'failed'] }]
      })
    ]
    const r = cascadeClearedCompletions(['x'], loose, ['x', 'y'])
    expect(r.cascaded).toEqual([])
  })

  it('terminates on a cyclic graph instead of hanging', () => {
    const cyclic: TaskData[] = [
      task({ id: 'p', name: 'P', requiredTaskIds: ['q'] }),
      task({ id: 'q', name: 'Q', requiredTaskIds: ['p'] })
    ]
    const r = cascadeClearedCompletions(['p'], cyclic, ['p', 'q'])
    expect(new Set(r.all)).toEqual(new Set(['p', 'q']))
  })
})
