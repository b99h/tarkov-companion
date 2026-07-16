import type {
  TaskData,
  TaskRequirement,
  TaskWithStatus,
  PlayerProgress,
  NextTarget,
  KappaProgress,
  TaskStatus,
  OcrMatch,
  OcrMatchCandidate
} from './types'

/**
 * Canonical in-game trader order, used everywhere traders are enumerated so the
 * app never disagrees with itself on ordering (quest board "By Trader", Quest
 * Catchup's prerequisite-by-trader grouping, etc.). Compared case-insensitively;
 * unknown/future traders sort after this list, alphabetically.
 */
export const TRADER_ORDER = [
  'Prapor',
  'Therapist',
  'Skier',
  'Peacekeeper',
  'Mechanic',
  'Ragman',
  'Jaeger',
  'BTR Driver',
  'Lightkeeper',
  'Ref',
  'Fence'
]

const TRADER_RANK = new Map(TRADER_ORDER.map((name, i) => [name.toLowerCase(), i]))

/** Order two trader names by in-game order; unknown traders sort last, alphabetically. */
export function compareTraders(a: string, b: string): number {
  const ra = TRADER_RANK.get(a.toLowerCase())
  const rb = TRADER_RANK.get(b.toLowerCase())
  if (ra !== undefined && rb !== undefined) return ra - rb
  if (ra !== undefined) return -1
  if (rb !== undefined) return 1
  return a.localeCompare(b)
}

/**
 * Condition-specific map variants tarkov.dev lists separately (level-gated,
 * time-of-day, dark) collapsed onto the single real location they belong to, so
 * the quest board shows one entry per map. Anything not listed maps to itself.
 */
const MAP_ALIASES: Record<string, string> = {
  'Ground Zero 21+': 'Ground Zero',
  'Night Factory': 'Factory',
  'The Lab (Dark)': 'The Lab'
}

/** Collapse a map's variant name to its canonical location (e.g. Night Factory → Factory). */
export function normalizeMapName(name: string): string {
  return MAP_ALIASES[name] ?? name
}

/**
 * Canonical top-to-bottom map order for the quest board's "By Map" grouping.
 * Names are the canonical (post-`normalizeMapName`) forms; unlisted maps sort
 * after these, alphabetically.
 */
export const MAP_ORDER = [
  'Ground Zero',
  'Customs',
  'Woods',
  'Interchange',
  'Factory',
  'Streets of Tarkov',
  'Shoreline',
  'The Labyrinth',
  'Reserve',
  'Lighthouse',
  'The Lab',
  'Icebreaker'
]

const MAP_RANK = new Map(MAP_ORDER.map((name, i) => [name.toLowerCase(), i]))

/** Order two canonical map names by the board's map order; unknown maps sort last. */
export function compareMaps(a: string, b: string): number {
  const ra = MAP_RANK.get(a.toLowerCase())
  const rb = MAP_RANK.get(b.toLowerCase())
  if (ra !== undefined && rb !== undefined) return ra - rb
  if (ra !== undefined) return -1
  if (rb !== undefined) return 1
  return a.localeCompare(b)
}

/**
 * Whether a prerequisite edge is satisfied, honoring the accepted statuses:
 * `complete` (prereq is completed), `failed` (prereq is in the failed set,
 * tracked from the logs), or `active` (prereq is currently in progress — which
 * we don't track directly, so approximate with `isSatisfiable`: the prereq is
 * completed or its own hard prerequisites are met, i.e. it's plausibly startable).
 */
function requirementMet(
  req: TaskRequirement,
  completedSet: Set<string>,
  failedSet: Set<string>,
  isSatisfiable: (id: string) => boolean
): boolean {
  return req.statuses.some((s) => {
    if (s === 'complete') return completedSet.has(req.taskId)
    if (s === 'failed') return failedSet.has(req.taskId)
    // 'active': a completed prereq trivially satisfies it; otherwise fall back
    // to the honest "is it plausibly active" approximation.
    return completedSet.has(req.taskId) || isSatisfiable(req.taskId)
  })
}

/**
 * Cheap first-pass "would this task be available or completed" check, judging
 * requirements by `complete`/`failed` acceptance only. Deliberately ignores
 * `active` acceptance to avoid mutual recursion — it exists purely to feed the
 * `active`-requirement approximation in the real derivation below.
 */
function baseSatisfiable(
  task: TaskData,
  completedSet: Set<string>,
  failedSet: Set<string>
): boolean {
  if (completedSet.has(task.id)) return true
  return task.requirements.every((req) =>
    req.statuses.some(
      (s) =>
        (s === 'complete' && completedSet.has(req.taskId)) ||
        (s === 'failed' && failedSet.has(req.taskId)) ||
        (s === 'active' && completedSet.has(req.taskId))
    )
  )
}

function deriveStatus(
  task: TaskData,
  progress: PlayerProgress,
  completedSet: Set<string>,
  failedSet: Set<string>,
  isSatisfiable: (id: string) => boolean
): { status: TaskStatus; blockedByTaskIds: string[] } {
  if (completedSet.has(task.id)) {
    return { status: 'completed', blockedByTaskIds: [] }
  }

  const blockedByTaskIds = task.requirements
    .filter((req) => !requirementMet(req, completedSet, failedSet, isSatisfiable))
    .map((req) => req.taskId)
  if (blockedByTaskIds.length > 0) {
    return { status: 'locked', blockedByTaskIds }
  }

  if (task.factionName !== 'Any' && task.factionName !== progress.faction) {
    return { status: 'faction-locked', blockedByTaskIds: [] }
  }

  if (task.minPlayerLevel > progress.playerLevel) {
    return { status: 'level-locked', blockedByTaskIds: [] }
  }

  return { status: 'available', blockedByTaskIds: [] }
}

export function deriveTaskStates(tasks: TaskData[], progress: PlayerProgress): TaskWithStatus[] {
  const completedSet = new Set(progress.completedTaskIds)
  const failedSet = new Set(progress.failedTaskIds)
  // Precompute the base-pass satisfiability of every task once, so the
  // `active`-requirement approximation is a cheap map lookup, not a re-walk.
  const satisfiableById = new Map<string, boolean>()
  for (const task of tasks) {
    satisfiableById.set(task.id, baseSatisfiable(task, completedSet, failedSet))
  }
  const isSatisfiable = (id: string): boolean => satisfiableById.get(id) ?? false

  return tasks.map((task) => ({
    ...task,
    ...deriveStatus(task, progress, completedSet, failedSet, isSatisfiable)
  }))
}

/** The unique set of map names a task has objectives on. Turn-in-only tasks return []. */
export function taskMaps(task: TaskData): string[] {
  const names = new Set<string>()
  for (const objective of task.objectives) {
    for (const map of objective.maps) names.add(map)
  }
  return [...names]
}

export function getKappaTasks(tasks: TaskData[]): TaskData[] {
  return tasks.filter((t) => t.kappaRequired)
}

export function getKappaProgress(tasks: TaskData[], progress: PlayerProgress): KappaProgress {
  const completedSet = new Set(progress.completedTaskIds)
  const kappaTasks = getKappaTasks(tasks)
  const completed = kappaTasks.filter((t) => completedSet.has(t.id)).length
  const total = kappaTasks.length
  return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) }
}

/** Maps a task id to the ids of tasks that require it, for downstream traversal. */
export function buildDependentsMap(tasks: TaskData[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>()
  for (const task of tasks) {
    for (const reqId of task.requiredTaskIds) {
      const list = dependents.get(reqId) ?? []
      list.push(task.id)
      dependents.set(reqId, list)
    }
  }
  return dependents
}

/**
 * Counts every kappa-required task transitively unlocked by completing `taskId`,
 * so the planner can surface long prerequisite chains (e.g. Punisher, Gunsmith) early.
 */
export function countDownstreamKappaTasks(
  taskId: string,
  dependents: Map<string, string[]>,
  tasksById: Map<string, TaskData>
): number {
  const seen = new Set<string>()
  const stack = [...(dependents.get(taskId) ?? [])]
  let count = 0

  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)

    const task = tasksById.get(id)
    if (task?.kappaRequired) count++

    stack.push(...(dependents.get(id) ?? []))
  }

  return count
}

/**
 * Kappa-priority score for an available quest: weight the number of Kappa quests
 * it transitively unlocks above whether it's Kappa-required itself, so the most
 * *unblocking* quest ranks highest. Shared by the Kappa Planner's
 * `scoreNextTargets` and the quest board's Kappa-priority sort so they never
 * disagree on ordering.
 */
export function kappaPriorityScore(
  task: { kappaRequired: boolean },
  downstreamKappa: number
): number {
  return downstreamKappa * 2 + (task.kappaRequired ? 1 : 0)
}

/** Sort orders offered for the available quests within each board group. */
export type QuestSortMode = 'kappa' | 'level' | 'alphabetical'

/**
 * Comparator for the quest board's *available* list under a chosen sort mode.
 * `downstreamKappaByTask` is the per-board memo (task id → downstream Kappa
 * count) so Kappa sorting is a map lookup, not a per-comparison graph walk.
 * Every mode falls back to alphabetical for a stable, jitter-free order on ties.
 */
export function compareAvailableQuests(
  mode: QuestSortMode,
  downstreamKappaByTask: Map<string, number>
): (a: TaskWithStatus, b: TaskWithStatus) => number {
  return (a, b) => {
    let diff = 0
    if (mode === 'kappa') {
      diff =
        kappaPriorityScore(b, downstreamKappaByTask.get(b.id) ?? 0) -
        kappaPriorityScore(a, downstreamKappaByTask.get(a.id) ?? 0)
    } else if (mode === 'level') {
      diff = a.minPlayerLevel - b.minPlayerLevel
    }
    if (diff === 0) diff = a.name.localeCompare(b.name)
    return diff
  }
}

export function scoreNextTargets(
  tasks: TaskData[],
  progress: PlayerProgress,
  limit = 10
): NextTarget[] {
  const states = deriveTaskStates(tasks, progress)
  const tasksById = new Map(tasks.map((t) => [t.id, t]))
  const dependents = buildDependentsMap(tasks)

  const available = states.filter((t) => t.status === 'available')

  const targets: NextTarget[] = available
    .map((task) => {
      const downstreamKappa = countDownstreamKappaTasks(task.id, dependents, tasksById)
      const score = kappaPriorityScore(task, downstreamKappa)

      const reasons: string[] = []
      if (task.kappaRequired) reasons.push('Required for Kappa')
      if (downstreamKappa > 0) {
        reasons.push(
          `Unlocks ${downstreamKappa} more Kappa quest${downstreamKappa === 1 ? '' : 's'}`
        )
      }

      return { task, score, reasons }
    })
    // Off the Kappa path entirely: neither required itself nor unlocking anything that is.
    .filter((target) => target.score > 0)

  return targets.sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * Every item id required by an objective of a not-yet-completed task, mapped to
 * the names of the tasks that need it. Powers the flea panel's "needed for a
 * quest — don't sell" warning (covers all objective items, FIR or not).
 */
export function neededQuestItems(
  tasks: TaskData[],
  progress: PlayerProgress
): Map<string, string[]> {
  const completedSet = new Set(progress.completedTaskIds)
  const byItemId = new Map<string, Set<string>>()

  for (const task of tasks) {
    if (completedSet.has(task.id)) continue
    for (const objective of task.objectives) {
      for (const item of objective.items) {
        const tasksForItem = byItemId.get(item.id) ?? new Set<string>()
        tasksForItem.add(task.name)
        byItemId.set(item.id, tasksForItem)
      }
    }
  }

  return new Map([...byItemId].map(([id, names]) => [id, [...names]]))
}

export interface HoardItem {
  itemName: string
  neededFor: string[]
  totalCount: number
}

export function itemsToHoard(tasks: TaskData[], progress: PlayerProgress): HoardItem[] {
  const completedSet = new Set(progress.completedTaskIds)
  const byName = new Map<string, { totalCount: number; neededFor: Set<string> }>()

  for (const task of tasks) {
    if (completedSet.has(task.id)) continue

    for (const objective of task.objectives) {
      if (!objective.items.length) continue

      for (const item of objective.items) {
        if (!item.foundInRaid) continue

        const existing = byName.get(item.name)
        if (existing) {
          if (!existing.neededFor.has(task.name)) existing.totalCount += item.count
          existing.neededFor.add(task.name)
        } else {
          byName.set(item.name, { totalCount: item.count, neededFor: new Set([task.name]) })
        }
      }
    }
  }

  return [...byName.entries()]
    .map(([itemName, { totalCount, neededFor }]) => ({
      itemName,
      totalCount,
      neededFor: [...neededFor]
    }))
    .sort((a, b) => b.neededFor.length - a.neededFor.length)
}

// ── Quest Catchup: OCR-driven bulk progress inference ──────────────────────

/**
 * Every task transitively required (directly or indirectly) to unlock
 * `taskId`, walking the upstream `requiredTaskIds` edges. Excludes tasks
 * already in `completedTaskIds`, and excludes `taskId` itself (the active
 * quest is in progress, not done).
 */
export function getAllPrerequisiteIds(
  taskId: string,
  tasksById: Map<string, TaskData>,
  completedTaskIds: Set<string>
): Set<string> {
  const result = new Set<string>()
  const stack = [...(tasksById.get(taskId)?.requiredTaskIds ?? [])]

  while (stack.length > 0) {
    const id = stack.pop()!
    if (result.has(id) || completedTaskIds.has(id)) continue
    result.add(id)
    stack.push(...(tasksById.get(id)?.requiredTaskIds ?? []))
  }

  return result
}

/** Whether a requirement can *only* be satisfied by the prerequisite being completed. */
function demandsCompletion(req: TaskRequirement): boolean {
  return req.statuses.length === 1 && req.statuses[0] === 'complete'
}

export interface InferredPrerequisites {
  /**
   * Upstream tasks that must be completed for the active tasks to be active —
   * every edge on the path to them demands completion. Safe to auto-mark.
   */
  completed: string[]
  /**
   * Upstream tasks reached through a requirement also satisfiable by `failed`
   * or `active` — the prereq could have been failed or merely started, so it
   * can't be assumed done. Surfaced for manual review, unchecked by default.
   * Traversal stops at these (we can't assume anything above them either).
   */
  uncertain: string[]
}

/**
 * Given the quests OCR'd as currently active off the player's task list, infer
 * which upstream quests must already be *completed*. Walks only
 * completion-demanding requirement edges into `completed`; a requirement that a
 * `failed`/`active` prereq could also satisfy yields an `uncertain` entry that
 * isn't traversed past, so a failed prerequisite is never silently marked done
 * (the confirmed data behind stretch-goal S2). Anything already completed is
 * excluded from both lists.
 */
export function inferPrerequisiteCompletions(
  activeTaskIds: string[],
  tasks: TaskData[],
  completedTaskIds: string[]
): InferredPrerequisites {
  const tasksById = new Map(tasks.map((t) => [t.id, t]))
  const completedSet = new Set(completedTaskIds)
  const completed = new Set<string>()
  const uncertain = new Set<string>()

  // Seed with the active tasks themselves so they're never inferred (they're in
  // progress, not done) and only their requirements are explored.
  const visited = new Set<string>(activeTaskIds)
  const stack = [...activeTaskIds]

  while (stack.length > 0) {
    const task = tasksById.get(stack.pop()!)
    if (!task) continue
    for (const req of task.requirements) {
      if (demandsCompletion(req)) {
        if (!completedSet.has(req.taskId)) completed.add(req.taskId)
        if (!visited.has(req.taskId)) {
          visited.add(req.taskId)
          stack.push(req.taskId)
        }
      } else if (!completedSet.has(req.taskId)) {
        uncertain.add(req.taskId)
      }
    }
  }

  // A task reachable by a completion-demanding path is definitely done, even if
  // another path reached it only ambiguously — completed wins over uncertain.
  for (const id of completed) uncertain.delete(id)

  return { completed: [...completed], uncertain: [...uncertain] }
}

/** Case/whitespace/punctuation-insensitive normalization for OCR text matching. */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const dp: number[][] = Array.from({ length: rows }, (_, i) => [
    i,
    ...Array(cols - 1).fill(0)
  ])
  for (let j = 0; j < cols; j++) dp[0][j] = j

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }

  return dp[rows - 1][cols - 1]
}

/** 0 (nothing alike) to 1 (identical) similarity between two normalized strings. */
function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1
  const distance = levenshtein(a, b)
  return 1 - distance / Math.max(a.length, b.length)
}

/**
 * Splits a normalized string into words, dropping single-character alphabetic
 * noise (stray icon glyphs) but **keeping numbers** — the "Part N" number is
 * the only thing distinguishing "Gunsmith - Part 1" from "Part 25", so
 * discarding a lone digit collapses a whole quest series into one ambiguous
 * blob (every part tying at full word-coverage).
 */
function wordTokens(normalized: string): string[] {
  return normalized.split(' ').filter((w) => w.length >= 2 || /^[0-9]$/.test(w))
}

function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true
  // Only allow a fuzzy (1-typo) word match once both words are long enough
  // that a single-character slip can't turn one real word into another.
  if (Math.min(a.length, b.length) < 4) return false
  return levenshtein(a, b) <= 1
}

/**
 * Fraction of a task's name-words found (exactly or with a 1-typo tolerance)
 * anywhere among a line's words, order-independent. This is what lets a
 * quest name embedded inside a noisy table row (icons, trader/level column
 * junk, "active! 0%" status text, etc. — as OCR'd from third-party trackers)
 * still register as a match, where a whole-line similarity check would be
 * swamped by all the surrounding text.
 */
function wordCoverage(taskWords: string[], lineWords: string[]): number {
  if (taskWords.length === 0) return 0
  const matched = taskWords.filter((tw) => lineWords.some((lw) => wordsMatch(tw, lw))).length
  return matched / taskWords.length
}

/**
 * Containment score for a task name inside a line. Multi-word task names use
 * word coverage (specific enough to trust). Single-word task names are too
 * generic for fuzzy word matching — almost any long noisy line could
 * accidentally contain something close to a short common word — so those
 * require an exact, sufficiently long substring instead.
 */
function containmentScore(taskWords: string[], lineWords: string[], lineNormalized: string): number {
  if (taskWords.length >= 2) return wordCoverage(taskWords, lineWords)
  const [word] = taskWords
  if (!word || word.length < 6) return 0
  return lineNormalized.includes(word) ? 1 : 0
}

const MATCH_CONFIDENCE_FLOOR = 0.6

/**
 * Matches OCR'd quest-list lines against the task catalog. Each line is
 * scored against every task by the better of two signals: whole-line
 * similarity (best for a clean one-quest-per-line screenshot straight from
 * the game) and word containment (best for a noisy table row from a
 * third-party tracker, where the quest name is one part of a longer line).
 * `matchedTaskId` is the top candidate only when it clears
 * `MATCH_CONFIDENCE_FLOOR` and isn't ambiguously close to the runner-up, so
 * uncertain lines surface for manual review instead of silently guessing.
 */
export function matchOcrLinesToTasks(lines: string[], tasks: TaskData[]): OcrMatch[] {
  const normalizedTasks = tasks.map((t) => {
    const normalized = normalizeForMatch(t.name)
    return { task: t, normalized, words: wordTokens(normalized) }
  })

  return lines
    .map((line, index) => {
      const normalized = normalizeForMatch(line)
      return { line, index, normalized, words: wordTokens(normalized) }
    })
    .filter(({ normalized }) => normalized.length > 0)
    .map(({ line, index, normalized, words }): OcrMatch => {
      const scored = normalizedTasks
        .map(({ task, normalized: taskNormalized, words: taskWords }) => {
          const containScore = containmentScore(taskWords, words, normalized)
          // Whole-line similarity is only trustworthy on its own when the
          // line is basically just the quest name (a clean native
          // screenshot with maybe a typo). Without that, a short garbled
          // line from a busy table/table-header/nav-bar can coincidentally
          // land a decent edit-distance score against an unrelated short
          // quest name — word containment is the only signal specific
          // enough to trust for noisy multi-column lines, so require it
          // (or a near-exact whole-line match) rather than blending both.
          const simScore = similarity(normalized, taskNormalized)
          const confidence = containScore > 0 ? Math.max(simScore, containScore) : simScore >= 0.85 ? simScore : 0
          return { taskId: task.id, taskName: task.name, confidence }
        })
        .filter((c) => c.confidence > 0)
        .sort((a, b) => b.confidence - a.confidence)

      const candidates: OcrMatchCandidate[] = scored.slice(0, 3)
      const [top, runnerUp] = candidates

      const isConfident =
        top !== undefined &&
        top.confidence >= MATCH_CONFIDENCE_FLOOR &&
        (runnerUp === undefined || top.confidence - runnerUp.confidence >= 0.05)

      return {
        line,
        key: String(index),
        matchedTaskId: isConfident ? top.taskId : null,
        candidates
      }
    })
}
