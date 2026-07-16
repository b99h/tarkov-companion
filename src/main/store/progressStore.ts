import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { PlayerProgress, TaskLogEvent } from '../../shared/types'

const DEFAULT_PROGRESS: PlayerProgress = {
  completedTaskIds: [],
  failedTaskIds: [],
  playerLevel: 1,
  faction: 'Bear'
}

function progressFile(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'progress.json')
}

export function loadProgress(): PlayerProgress {
  const file = progressFile()
  if (!existsSync(file)) return { ...DEFAULT_PROGRESS }
  try {
    return { ...DEFAULT_PROGRESS, ...JSON.parse(readFileSync(file, 'utf-8')) }
  } catch {
    return { ...DEFAULT_PROGRESS }
  }
}

export function saveProgress(progress: PlayerProgress): void {
  writeFileSync(progressFile(), JSON.stringify(progress, null, 2), 'utf-8')
}

export function setTaskCompleted(taskId: string, completed: boolean): PlayerProgress {
  const progress = loadProgress()
  const set = new Set(progress.completedTaskIds)
  if (completed) {
    set.add(taskId)
  } else {
    set.delete(taskId)
  }
  const updated = { ...progress, completedTaskIds: [...set] }
  saveProgress(updated)
  return updated
}

/**
 * Marks every id in `taskIds` completed in one load/save cycle, for bulk
 * flows like Quest Catchup (mirrors the multi-id batching in
 * `applyTaskEvents` below, rather than looping the single-id setter).
 */
export function setTasksCompleted(taskIds: string[]): PlayerProgress {
  const progress = loadProgress()
  const set = new Set(progress.completedTaskIds)
  for (const id of taskIds) set.add(id)
  const updated = { ...progress, completedTaskIds: [...set] }
  saveProgress(updated)
  return updated
}

export function setPlayerLevel(level: number): PlayerProgress {
  const updated = { ...loadProgress(), playerLevel: level }
  saveProgress(updated)
  return updated
}

export function setFaction(faction: PlayerProgress['faction']): PlayerProgress {
  const updated = { ...loadProgress(), faction }
  saveProgress(updated)
  return updated
}

export function resetProgress(): PlayerProgress {
  saveProgress(DEFAULT_PROGRESS)
  return { ...DEFAULT_PROGRESS }
}

/**
 * Apply parsed log events to progress in one load/save cycle. `finished` marks a
 * task complete (and clears any prior failure); `failed` records the failure;
 * `started` doesn't change completion state (the UI still gets a toast upstream).
 * Only events whose taskId is in `knownTaskIds` are applied, so trader/system
 * messages that happen to share the shape are filtered out.
 *
 * Returns the updated progress plus the taskIds that actually changed state, so
 * callers can drive toasts and avoid redundant renders/saves.
 */
export function applyTaskEvents(
  events: TaskLogEvent[],
  knownTaskIds: Set<string>
): { progress: PlayerProgress; changedTaskIds: string[] } {
  const progress = loadProgress()
  const completed = new Set(progress.completedTaskIds)
  const failed = new Set(progress.failedTaskIds)
  const changed = new Set<string>()

  for (const event of events) {
    if (!knownTaskIds.has(event.taskId)) continue

    if (event.type === 'finished') {
      if (!completed.has(event.taskId)) changed.add(event.taskId)
      completed.add(event.taskId)
      failed.delete(event.taskId)
    } else if (event.type === 'failed') {
      if (!failed.has(event.taskId)) changed.add(event.taskId)
      failed.add(event.taskId)
    }
    // 'started' is informational only — no persisted state change.
  }

  if (changed.size === 0) {
    return { progress, changedTaskIds: [] }
  }

  const updated: PlayerProgress = {
    ...progress,
    completedTaskIds: [...completed],
    failedTaskIds: [...failed]
  }
  saveProgress(updated)
  return { progress: updated, changedTaskIds: [...changed] }
}
