import { useEffect, useMemo, useState } from 'react'
import { AppDataProvider, useAppData } from '../state/AppDataContext'
import {
  deriveTaskStates,
  normalizeMapName,
  scoreNextTargets,
  taskMaps
} from '@shared/questEngine'
import type { TaskObjective, TaskWithStatus, WatcherStatus } from '@shared/types'

/** The window can't scroll (it's click-through), so everything is hard-capped. */
const MAX_MAP_QUESTS = 10
const MAX_OBJECTIVES_PER_QUEST = 4
const MAX_KAPPA_TARGETS = 4

interface MapQuest {
  task: TaskWithStatus
  objectives: TaskObjective[]
}

/**
 * Phase 12.2 — the in-game overlay's content: the current raid map's active
 * quests with their map-relevant objectives (the map legend's data, text-only),
 * plus the next Kappa targets. Read-only; all data arrives over the same IPC
 * the main window uses, kept live by the broadcast pushes.
 */
function OverlayContent(): React.JSX.Element {
  const { tasks, progress } = useAppData()
  const [status, setStatus] = useState<WatcherStatus | null>(null)

  useEffect(() => {
    window.api.getWatcherStatus().then(setStatus)
    return window.api.onWatcherStatus(setStatus)
  }, [])

  const currentMap = status?.currentMap ? normalizeMapName(status.currentMap) : null

  const available = useMemo(
    () =>
      tasks && progress
        ? deriveTaskStates(tasks, progress).filter((t) => t.status === 'available')
        : [],
    [tasks, progress]
  )

  // Available quests referencing the current map, with objectives narrowed to
  // that map (map-agnostic objectives are kept — they apply anywhere). Mirrors
  // the map view's legend + "also active here" lists, minus the pin geometry.
  const mapQuests = useMemo((): MapQuest[] => {
    if (!currentMap) return []
    return available
      .filter((t) => taskMaps(t).some((m) => normalizeMapName(m) === currentMap))
      .map((t) => ({
        task: t,
        objectives: t.objectives.filter(
          (o) => o.maps.length === 0 || o.maps.some((m) => normalizeMapName(m) === currentMap)
        )
      }))
      .sort(
        (a, b) =>
          Number(b.task.kappaRequired) - Number(a.task.kappaRequired) ||
          a.task.name.localeCompare(b.task.name)
      )
  }, [available, currentMap])

  const nextTargets = useMemo(
    () => (tasks && progress ? scoreNextTargets(tasks, progress, MAX_KAPPA_TARGETS) : []),
    [tasks, progress]
  )

  const shownQuests = mapQuests.slice(0, MAX_MAP_QUESTS)
  const hiddenCount = mapQuests.length - shownQuests.length

  return (
    <div className="overlay-panel">
      <div className="overlay-header">
        <span className="overlay-title">Tarkov Companion</span>
        <span className={`overlay-map${currentMap ? '' : ' muted'}`}>
          {currentMap ?? 'not in raid'}
        </span>
      </div>

      {currentMap && (
        <div className="overlay-section">
          <div className="overlay-section-title">
            Active here ({mapQuests.length})
          </div>
          {shownQuests.length === 0 && (
            <p className="overlay-muted">No active quests on this map.</p>
          )}
          {shownQuests.map(({ task, objectives }) => (
            <div key={task.id} className="overlay-quest">
              <div className="overlay-quest-name">
                {task.kappaRequired && <span className="kappa-star">★</span>}
                {task.name}
                <span className="overlay-trader">{task.trader}</span>
              </div>
              <ul className="overlay-objectives">
                {objectives.slice(0, MAX_OBJECTIVES_PER_QUEST).map((o) => (
                  <li key={o.id}>
                    {o.description}
                    {o.optional && <span className="overlay-muted"> (optional)</span>}
                  </li>
                ))}
                {objectives.length > MAX_OBJECTIVES_PER_QUEST && (
                  <li className="overlay-muted">
                    +{objectives.length - MAX_OBJECTIVES_PER_QUEST} more objective(s)
                  </li>
                )}
              </ul>
            </div>
          ))}
          {hiddenCount > 0 && (
            <p className="overlay-muted">+{hiddenCount} more quest(s) — see the Maps view.</p>
          )}
        </div>
      )}

      <div className="overlay-section">
        <div className="overlay-section-title">Next Kappa targets</div>
        {nextTargets.length === 0 ? (
          <p className="overlay-muted">Nothing on the Kappa path is available right now.</p>
        ) : (
          nextTargets.map(({ task }) => (
            <div key={task.id} className="overlay-target">
              {task.kappaRequired && <span className="kappa-star">★</span>}
              {task.name}
              <span className="overlay-trader">{task.trader}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function Overlay(): React.JSX.Element {
  return (
    <AppDataProvider>
      <OverlayContent />
    </AppDataProvider>
  )
}
