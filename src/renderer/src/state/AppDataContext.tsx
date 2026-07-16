import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TaskData, PlayerProgress, Faction } from '@shared/types'

interface AppDataValue {
  tasks: TaskData[] | null
  progress: PlayerProgress | null
  loading: boolean
  error: string | null
  toggleTask: (taskId: string, completed: boolean) => Promise<void>
  bulkCompleteTasks: (taskIds: string[]) => Promise<void>
  updatePlayerLevel: (level: number) => Promise<void>
  updateFaction: (faction: Faction) => Promise<void>
  /** Records one hideout station's built level (Phase 8), keyed by normalizedName. */
  updateStationLevel: (stationNorm: string, level: number) => Promise<void>
  reset: () => Promise<void>
}

const AppDataContext = createContext<AppDataValue | null>(null)

export function AppDataProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskData[] | null>(null)
  const [progress, setProgress] = useState<PlayerProgress | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const [t, p] = await Promise.all([window.api.getTasks(), window.api.getProgress()])
      setTasks(t)
      setProgress(p)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Live progress pushed from the log watcher (Phase 2): the board and planner
  // react to log-derived quest completions without a manual reload.
  useEffect(() => {
    return window.api.onProgressUpdated((updated) => setProgress(updated))
  }, [])

  const toggleTask = useCallback(async (taskId: string, completed: boolean) => {
    const updated = await window.api.setTaskCompleted(taskId, completed)
    setProgress(updated)
  }, [])

  const bulkCompleteTasks = useCallback(async (taskIds: string[]) => {
    if (taskIds.length === 0) return
    const updated = await window.api.setTasksCompleted(taskIds)
    setProgress(updated)
  }, [])

  const updatePlayerLevel = useCallback(async (level: number) => {
    const updated = await window.api.setPlayerLevel(level)
    setProgress(updated)
  }, [])

  const updateFaction = useCallback(async (faction: Faction) => {
    const updated = await window.api.setFaction(faction)
    setProgress(updated)
  }, [])

  const updateStationLevel = useCallback(async (stationNorm: string, level: number) => {
    const updated = await window.api.setStationLevel(stationNorm, level)
    setProgress(updated)
  }, [])

  const reset = useCallback(async () => {
    const updated = await window.api.resetProgress()
    setProgress(updated)
  }, [])

  return (
    <AppDataContext.Provider
      value={{
        tasks,
        progress,
        loading,
        error,
        toggleTask,
        bulkCompleteTasks,
        updatePlayerLevel,
        updateFaction,
        updateStationLevel,
        reset
      }}
    >
      {children}
    </AppDataContext.Provider>
  )
}

export function useAppData(): AppDataValue {
  const ctx = useContext(AppDataContext)
  if (!ctx) throw new Error('useAppData must be used within AppDataProvider')
  return ctx
}
