import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  deriveTaskStates,
  taskMaps,
  buildDependentsMap,
  countDownstreamKappaTasks,
  compareTraders,
  compareMaps,
  normalizeMapName,
  compareAvailableQuests,
  duplicateTaskNames,
  taskNameQualifier
} from '@shared/questEngine'
import type { QuestSortMode } from '@shared/questEngine'
import type { TaskStatus, TaskWithStatus } from '@shared/types'

import { useAppData } from '../state/AppDataContext'
import { usePersistedState } from '../state/usePersistedState'
import { WikiGallery } from './WikiGallery'

/** A neighbouring quest in the chain, with whether it's on the player's record. */
interface RelatedQuest {
  id: string
  name: string
  completed: boolean
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  completed: 'Completed',
  available: 'Available',
  locked: 'Locked',
  'level-locked': 'Level locked',
  'faction-locked': 'Faction locked'
}

// No 'faction-locked' chip: other-faction quests are filtered out of the board
// entirely (see the `states` memo), so the chip could only ever match nothing.
const STATUS_FILTER_OPTIONS: TaskStatus[] = ['available', 'level-locked', 'locked', 'completed']

const NO_MAP_BUCKET = 'No specific map'

type GroupBy = 'trader' | 'map'

const SORT_LABEL: Record<QuestSortMode, string> = {
  kappa: 'Kappa priority',
  level: 'Player level',
  alphabetical: 'A–Z'
}

const SORT_OPTIONS: QuestSortMode[] = ['kappa', 'level', 'alphabetical']

function groupKeysForTask(task: TaskWithStatus, groupBy: GroupBy): string[] {
  if (groupBy === 'trader') return [task.trader]
  // Collapse condition-specific variants (Ground Zero 21+, Night Factory, The
  // Lab (Dark)) so each real map is a single group, then dedupe.
  const maps = [...new Set(taskMaps(task).map(normalizeMapName))]
  return maps.length > 0 ? maps : [NO_MAP_BUCKET]
}

function buildGroups(
  states: TaskWithStatus[],
  groupBy: GroupBy
): Map<string, TaskWithStatus[]> {
  const groups = new Map<string, TaskWithStatus[]>()
  for (const task of states) {
    for (const key of groupKeysForTask(task, groupBy)) {
      const list = groups.get(key) ?? []
      list.push(task)
      groups.set(key, list)
    }
  }
  return groups
}

function sortGroupKeys(keys: string[], groupBy: GroupBy): string[] {
  // "By Trader" follows the canonical in-game trader order; "By Map" follows the
  // canonical map order with the turn-in-only bucket pinned last.
  if (groupBy === 'trader') return [...keys].sort(compareTraders)
  return [...keys].sort((a, b) => {
    if (a === NO_MAP_BUCKET) return 1
    if (b === NO_MAP_BUCKET) return -1
    return compareMaps(a, b)
  })
}

function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

export function QuestBoard(): React.JSX.Element {
  const { tasks, progress, loading, error, toggleTask } = useAppData()

  const [groupBy, setGroupBy] = usePersistedState<GroupBy>('questBoard.groupBy', 'trader')
  const [sortBy, setSortBy] = usePersistedState<QuestSortMode>('questBoard.sortBy', 'kappa')
  const [collapsedGroups, setCollapsedGroups] = usePersistedState<Record<string, boolean>>(
    `questBoard.collapsed.${groupBy}`,
    {}
  )
  const [completedCollapsed, setCompletedCollapsed] = usePersistedState<Record<string, boolean>>(
    `questBoard.completedCollapsed.${groupBy}`,
    {}
  )
  const [lockedCollapsed, setLockedCollapsed] = usePersistedState<Record<string, boolean>>(
    `questBoard.lockedCollapsed.${groupBy}`,
    {}
  )
  const [expandAllCompleted, setExpandAllCompleted] = useState(false)
  const [expandAllLocked, setExpandAllLocked] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<Set<TaskStatus>>(new Set())
  const [kappaOnly, setKappaOnly] = useState(false)
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set())
  const [flashTaskId, setFlashTaskId] = useState<string | null>(null)

  // Same key MapView reads/writes for its "hide this quest from the map" mute
  // list, so toggling here and toggling there stay in sync (only one of the
  // two views is ever mounted at a time).
  const [mutedTaskIds, setMutedTaskIds] = usePersistedState<string[]>('mapView.mutedTaskIds', [])
  const mutedSet = useMemo(() => new Set(mutedTaskIds), [mutedTaskIds])

  function toggleMapTracking(taskId: string): void {
    setMutedTaskIds(
      mutedSet.has(taskId) ? mutedTaskIds.filter((id) => id !== taskId) : [...mutedTaskIds, taskId]
    )
  }

  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map())

  // Quests belonging to the *other* faction can never be done on this
  // character, so they're dropped entirely rather than shown as "Faction
  // locked". Tarkov ships several quests as BEAR/USEC twins under one name
  // (Drip-Out, Textile), and listing both made the board show the same quest
  // twice — once Available, once locked — which read as a duplicate bug.
  //
  // Filtered on `factionName`, NOT on the derived `faction-locked` status: the
  // status derivation reports a prerequisite lock in preference to a faction
  // mismatch, so an other-faction quest with unmet prereqs surfaces as plain
  // `locked` and a status-based filter would leak it back in.
  const states = useMemo(() => {
    if (!tasks || !progress) return []
    const playable = tasks.filter(
      (t) => t.factionName === 'Any' || t.factionName === progress.faction
    )
    return deriveTaskStates(playable, progress)
  }, [tasks, progress])
  const tasksById = useMemo(() => new Map(states.map((t) => [t.id, t])), [states])

  // Same-name-different-quest disambiguation (e.g. Mechanic's three "Make
  // Amends"). Names resolve against the *full* catalog, not the faction-
  // filtered board list, so a qualifier never comes up blank because the
  // prerequisite happens to be filtered out of view.
  const duplicateNames = useMemo(() => duplicateTaskNames(states), [states])
  const allTaskNameById = useMemo(
    () => new Map((tasks ?? []).map((t) => [t.id, t.name])),
    [tasks]
  )
  const dependents = useMemo(() => (tasks ? buildDependentsMap(tasks) : new Map()), [tasks])

  // Precompute downstream-Kappa counts once per render instead of running a
  // fresh graph DFS per rendered row (each row previously called
  // countDownstreamKappaTasks in three places). Phase 4.7.2's Kappa-priority
  // sort reuses exactly this map.
  const downstreamKappaByTask = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of states) map.set(t.id, countDownstreamKappaTasks(t.id, dependents, tasksById))
    return map
  }, [states, dependents, tasksById])

  // The quest's place in its chain: what came before, what it opens up. Built
  // per rendered row (only expanded rows read it) off the same catalog-wide
  // maps as everything else, so a prerequisite filtered out of the current view
  // still resolves.
  //
  // Completion here is read from progress, NOT from the row's derived status —
  // a quest can be recorded complete while the catalog claims its prerequisite
  // isn't, and that disagreement is exactly what this is for showing. The
  // catalog's chain is display data: it annotates, it never overrules the
  // player's own record. See PLAN.md Phase 14.1.
  const questChain = useCallback(
    (taskId: string): { prerequisites: RelatedQuest[]; unlocks: RelatedQuest[] } => {
      const completed = new Set(progress?.completedTaskIds ?? [])
      const toRelated = (id: string): RelatedQuest => ({
        id,
        name: allTaskNameById.get(id) ?? 'Unknown quest',
        completed: completed.has(id)
      })
      const byName = (a: RelatedQuest, b: RelatedQuest): number => a.name.localeCompare(b.name)
      return {
        prerequisites: (tasksById.get(taskId)?.requiredTaskIds ?? []).map(toRelated).sort(byName),
        unlocks: (dependents.get(taskId) ?? []).map(toRelated).sort(byName)
      }
    },
    [tasksById, dependents, allTaskNameById, progress]
  )

  // Comparator for the available list within each group, per chosen sort mode.
  // Reuses the precomputed downstream-Kappa memo so Kappa sorting is a lookup.
  const availableComparator = useMemo(
    () => compareAvailableQuests(sortBy, downstreamKappaByTask),
    [sortBy, downstreamKappaByTask]
  )

  const fullGroups = useMemo(() => buildGroups(states, groupBy), [states, groupBy])

  const query = search.trim().toLowerCase()

  const filteredStates = useMemo(() => {
    return states.filter((task) => {
      if (kappaOnly && !task.kappaRequired) return false
      if (statusFilter.size > 0 && !statusFilter.has(task.status)) return false
      if (query && !task.name.toLowerCase().includes(query) && !task.trader.toLowerCase().includes(query)) {
        return false
      }
      return true
    })
  }, [states, kappaOnly, statusFilter, query])

  const filteredGroups = useMemo(() => buildGroups(filteredStates, groupBy), [
    filteredStates,
    groupBy
  ])

  const sortedGroupKeys = useMemo(() => sortGroupKeys([...filteredGroups.keys()], groupBy), [
    filteredGroups,
    groupBy
  ])

  function toggleGroupCollapsed(key: string): void {
    setCollapsedGroups({ ...collapsedGroups, [key]: !isGroupCollapsed(key) })
  }

  function isGroupCollapsed(key: string): boolean {
    if (query) return false
    // Default collapsed: a group is open only once explicitly expanded (stored
    // `false`). Keeps the board tidy on first load with every trader/map folded.
    return collapsedGroups[key] !== false
  }

  function toggleFolded(
    map: Record<string, boolean>,
    setMap: (v: Record<string, boolean>) => void,
    key: string
  ): void {
    setMap({ ...map, [key]: !(map[key] !== false) })
  }

  function isFolded(
    map: Record<string, boolean>,
    key: string,
    expandAll: boolean,
    hasMatch: boolean
  ): boolean {
    if (expandAll) return false
    if (query && hasMatch) return false
    return map[key] !== false
  }

  function toggleDetail(taskId: string): void {
    const next = new Set(expandedTaskIds)
    if (next.has(taskId)) next.delete(taskId)
    else next.add(taskId)
    setExpandedTaskIds(next)
  }

  function jumpToTask(taskId: string): void {
    const target = tasksById.get(taskId)
    if (!target) return

    const keys = groupKeysForTask(target, groupBy)
    const groupKey = keys.find((k) => filteredGroups.has(k)) ?? keys[0]

    if (collapsedGroups[groupKey] !== false) {
      setCollapsedGroups({ ...collapsedGroups, [groupKey]: false })
    }
    if (target.status === 'completed' && completedCollapsed[groupKey] !== false) {
      setCompletedCollapsed({ ...completedCollapsed, [groupKey]: false })
    }
    if (
      (target.status === 'locked' ||
        target.status === 'level-locked' ||
        target.status === 'faction-locked') &&
      lockedCollapsed[groupKey] !== false
    ) {
      setLockedCollapsed({ ...lockedCollapsed, [groupKey]: false })
    }
    if (!expandedTaskIds.has(taskId)) {
      setExpandedTaskIds(new Set([...expandedTaskIds, taskId]))
    }

    setFlashTaskId(taskId)
    setTimeout(() => {
      rowRefs.current.get(taskId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)
    setTimeout(() => setFlashTaskId(null), 1500)
  }

  if (loading) return <p>Loading quests…</p>
  if (error) return <p className="error">Failed to load quest data: {error}</p>

  return (
    <div className="quest-board">
      <div className="board-toolbar">
        <input
          type="search"
          className="search-box"
          placeholder="Search by quest or trader…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="group-by-toggle">
          <button
            className={groupBy === 'trader' ? 'active' : ''}
            onClick={() => setGroupBy('trader')}
          >
            By Trader
          </button>
          <button className={groupBy === 'map' ? 'active' : ''} onClick={() => setGroupBy('map')}>
            By Map
          </button>
        </div>

        <label className="sort-by-control">
          <span className="sort-by-label">Sort</span>
          <select
            className="sort-by-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as QuestSortMode)}
          >
            {SORT_OPTIONS.map((mode) => (
              <option key={mode} value={mode}>
                {SORT_LABEL[mode]}
              </option>
            ))}
          </select>
        </label>

        <div className="status-chips">
          {STATUS_FILTER_OPTIONS.map((status) => (
            <button
              key={status}
              className={`chip status-${status}${statusFilter.has(status) ? ' active' : ''}`}
              onClick={() => {
                const next = new Set(statusFilter)
                if (next.has(status)) next.delete(status)
                else next.add(status)
                setStatusFilter(next)
              }}
            >
              {STATUS_LABEL[status]}
            </button>
          ))}
          <button
            className={`chip kappa-chip${kappaOnly ? ' active' : ''}`}
            onClick={() => setKappaOnly(!kappaOnly)}
          >
            ★ Kappa only
          </button>
        </div>

        <label className="toggle-row expand-all-locked">
          <input
            type="checkbox"
            checked={expandAllLocked}
            onChange={(e) => setExpandAllLocked(e.target.checked)}
          />
          Show locked quests
        </label>

        <label className="toggle-row expand-all-completed">
          <input
            type="checkbox"
            checked={expandAllCompleted}
            onChange={(e) => setExpandAllCompleted(e.target.checked)}
          />
          Expand all completed
        </label>
      </div>

      {sortedGroupKeys.length === 0 && <p>No quests match your filters.</p>}

      {sortedGroupKeys.map((groupKey) => {
        const groupTasks = [...filteredGroups.get(groupKey)!].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
        // Available quests reorder by the chosen sort; the collapsed
        // Locked/Completed folders keep their alphabetical order.
        const active = groupTasks
          .filter((t) => t.status === 'available')
          .sort(availableComparator)
        const locked = groupTasks.filter(
          (t) => t.status === 'locked' || t.status === 'level-locked' || t.status === 'faction-locked'
        )
        const completed = groupTasks.filter((t) => t.status === 'completed')
        const hasMatch = query.length > 0
        const collapsed = isGroupCollapsed(groupKey)
        const lockedFolded = isFolded(lockedCollapsed, groupKey, expandAllLocked, hasMatch)
        const completedFolded = isFolded(completedCollapsed, groupKey, expandAllCompleted, hasMatch)

        const fullGroupTasks = fullGroups.get(groupKey) ?? []
        const fullCompletedCount = fullGroupTasks.filter((t) => t.status === 'completed').length
        // Counted off the *unfiltered* group so the badge always states what you
        // have in game, independent of the current search/status filters — which
        // is what makes it checkable against the in-game trader screen.
        const fullActiveCount = fullGroupTasks.filter((t) => t.status === 'available').length

        return (
          <section key={groupKey} className="trader-group">
            <h2 className="group-header" onClick={() => toggleGroupCollapsed(groupKey)}>
              <span className={`caret${collapsed ? ' collapsed' : ''}`}>▾</span>
              {groupKey}
              <span className="group-count">
                {fullCompletedCount}/{fullGroupTasks.length}
              </span>
              {fullActiveCount > 0 && (
                <span
                  className="group-active-count"
                  title={`${fullActiveCount} quest(s) available now — should match what this trader shows in game`}
                >
                  {fullActiveCount} active
                </span>
              )}
            </h2>

            {!collapsed && (
              <>
                <ul>
                  {active.map((task) => (
                    <QuestRow
                      key={task.id}
                      task={task}
                      query={query}
                      expanded={expandedTaskIds.has(task.id)}
                      flashed={flashTaskId === task.id}
                      onToggleComplete={(completed) => toggleTask(task.id, completed)}
                      onToggleDetail={() => toggleDetail(task.id)}
                      onJumpTo={jumpToTask}
                      rowRef={(el) => {
                        if (el) rowRefs.current.set(task.id, el)
                        else rowRefs.current.delete(task.id)
                      }}
                      downstreamKappa={downstreamKappaByTask.get(task.id) ?? 0}
                      nameQualifier={taskNameQualifier(task, duplicateNames, allTaskNameById)}
                      chain={questChain(task.id)}
                      blockedByNames={task.blockedByTaskIds.map(
                        (id) => tasksById.get(id)?.name ?? id
                      )}
                      trackedOnMap={!mutedSet.has(task.id)}
                      onToggleMapTracking={() => toggleMapTracking(task.id)}
                    />
                  ))}
                </ul>

                {locked.length > 0 && (
                  <div className="completed-folder locked-folder">
                    <button
                      className="completed-header"
                      onClick={() => toggleFolded(lockedCollapsed, setLockedCollapsed, groupKey)}
                    >
                      <span className={`caret${lockedFolded ? ' collapsed' : ''}`}>▾</span>
                      Locked ({locked.length})
                    </button>
                    {!lockedFolded && (
                      <ul>
                        {locked.map((task) => (
                          <QuestRow
                            key={task.id}
                            task={task}
                            query={query}
                            expanded={expandedTaskIds.has(task.id)}
                            flashed={flashTaskId === task.id}
                            onToggleComplete={(completed) => toggleTask(task.id, completed)}
                            onToggleDetail={() => toggleDetail(task.id)}
                            onJumpTo={jumpToTask}
                            rowRef={(el) => {
                              if (el) rowRefs.current.set(task.id, el)
                              else rowRefs.current.delete(task.id)
                            }}
                            downstreamKappa={downstreamKappaByTask.get(task.id) ?? 0}
                            nameQualifier={taskNameQualifier(task, duplicateNames, allTaskNameById)}
                            chain={questChain(task.id)}
                      blockedByNames={task.blockedByTaskIds.map(
                              (id) => tasksById.get(id)?.name ?? id
                            )}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {completed.length > 0 && (
                  <div className="completed-folder">
                    <button
                      className="completed-header"
                      onClick={() => toggleFolded(completedCollapsed, setCompletedCollapsed, groupKey)}
                    >
                      <span className={`caret${completedFolded ? ' collapsed' : ''}`}>▾</span>
                      Completed ({completed.length})
                    </button>
                    {!completedFolded && (
                      <ul>
                        {completed.map((task) => (
                          <QuestRow
                            key={task.id}
                            task={task}
                            query={query}
                            expanded={expandedTaskIds.has(task.id)}
                            flashed={flashTaskId === task.id}
                            onToggleComplete={(completed) => toggleTask(task.id, completed)}
                            onToggleDetail={() => toggleDetail(task.id)}
                            onJumpTo={jumpToTask}
                            rowRef={(el) => {
                              if (el) rowRefs.current.set(task.id, el)
                              else rowRefs.current.delete(task.id)
                            }}
                            downstreamKappa={downstreamKappaByTask.get(task.id) ?? 0}
                            nameQualifier={taskNameQualifier(task, duplicateNames, allTaskNameById)}
                            chain={questChain(task.id)}
                            blockedByNames={[]}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        )
      })}
    </div>
  )
}

interface QuestRowProps {
  task: TaskWithStatus
  query: string
  expanded: boolean
  flashed: boolean
  onToggleComplete: (completed: boolean) => void
  onToggleDetail: () => void
  onJumpTo: (taskId: string) => void
  rowRef: (el: HTMLLIElement | null) => void
  downstreamKappa: number
  blockedByNames: string[]
  /** Prerequisites and follow-ups, for the chain section of the detail panel. */
  chain: { prerequisites: RelatedQuest[]; unlocks: RelatedQuest[] }
  /** Distinguishes same-name-different-quest rows (e.g. Mechanic's 3× "Make Amends"). */
  nameQualifier: string | null
  trackedOnMap?: boolean
  onToggleMapTracking?: () => void
}

function QuestRow({
  task,
  query,
  expanded,
  flashed,
  onToggleComplete,
  onToggleDetail,
  onJumpTo,
  rowRef,
  downstreamKappa,
  blockedByNames,
  chain,
  nameQualifier,
  trackedOnMap,
  onToggleMapTracking
}: QuestRowProps): React.JSX.Element {
  const locations = [...new Set(taskMaps(task).map(normalizeMapName))]

  return (
    <li
      ref={rowRef}
      className={`quest-row status-${task.status}${expanded ? ' expanded' : ''}${
        flashed ? ' flashed' : ''
      }`}
    >
      <div className="quest-row-main">
        <input
          type="checkbox"
          checked={task.status === 'completed'}
          onChange={(e) => onToggleComplete(e.target.checked)}
        />
        <span className="quest-name" onClick={onToggleDetail}>
          {task.kappaRequired && <span className="kappa-star" title="Required for Kappa">★</span>}
          <Highlight text={task.name} query={query} />
          {nameQualifier && (
            <span className="quest-name-qualifier" title={`Distinct quest — unlocked ${nameQualifier}`}>
              {nameQualifier}
            </span>
          )}
        </span>
        <span className="quest-level">Lvl {task.minPlayerLevel}</span>
        {onToggleMapTracking && (
          <button
            type="button"
            className={`map-track-toggle${trackedOnMap ? ' active' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggleMapTracking()
            }}
            title={trackedOnMap ? 'Shown on map — click to hide' : 'Hidden from map — click to show'}
          >
            🗺️
          </button>
        )}
        <span className={`status-badge status-${task.status}`}>{STATUS_LABEL[task.status]}</span>
      </div>

      {expanded && (
        <div className="quest-detail">
          {task.objectives.length > 0 && (
            <div className="detail-section">
              <h4>Objectives</h4>
              <ul>
                {task.objectives.map((o) => (
                  <li key={o.id}>
                    {o.optional && <span className="optional-tag">(Optional)</span>}
                    {o.description}
                    {o.items.map((item) => (
                      <span key={item.id} className="objective-item">
                        {' '}
                        {item.name} ×{item.count}
                        {item.foundInRaid && <span className="fir-badge">FIR</span>}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="detail-section">
            <h4>Locations</h4>
            <p>{locations.length > 0 ? locations.join(', ') : 'No specific map'}</p>
          </div>

          <div className="detail-section">
            <h4>Gates</h4>
            <p>
              Level {task.minPlayerLevel}
              {task.factionName !== 'Any' ? ` · ${task.factionName} only` : ''}
            </p>
            {blockedByNames.length > 0 && (
              <div className="prereq-chips">
                {task.blockedByTaskIds.map((id, i) => (
                  <button key={id} className="chip prereq-chip" onClick={() => onJumpTo(id)}>
                    {blockedByNames[i]}
                  </button>
                ))}
              </div>
            )}
          </div>

          {(chain.prerequisites.length > 0 || chain.unlocks.length > 0) && (
            <div className="detail-section">
              <h4>Quest chain</h4>
              <ChainRow
                label="Comes after"
                quests={chain.prerequisites}
                empty="Nothing — this quest starts its chain."
                showState
                onJumpTo={onJumpTo}
              />
              <ChainRow
                label="Leads to"
                quests={chain.unlocks}
                empty="Nothing — this quest ends its chain."
                onJumpTo={onJumpTo}
              />
            </div>
          )}

          {downstreamKappa > 0 && (
            <p className="unlocks-note">
              Unlocks {downstreamKappa} more Kappa quest{downstreamKappa === 1 ? '' : 's'}
            </p>
          )}

          {/* Loaded lazily only when a row is expanded, so the board doesn't
              fetch galleries for quests you never open. */}
          <WikiGallery taskId={task.id} />

          {task.wikiLink && (
            <a className="wiki-link" href={task.wikiLink} target="_blank" rel="noreferrer">
              Open wiki ↗
            </a>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * One direction of a quest's chain. Prerequisites carry their completion state
 * (green = on your record, red = not), which is the point of the section; the
 * follow-ups deliberately don't — a "leads to" quest being incomplete is the
 * normal case and colouring them all red would be noise, not information.
 */
function ChainRow({
  label,
  quests,
  empty,
  showState,
  onJumpTo
}: {
  label: string
  quests: RelatedQuest[]
  empty: string
  showState?: boolean
  onJumpTo: (taskId: string) => void
}): React.JSX.Element {
  return (
    <div className="chain-row">
      <span className="chain-label">{label}</span>
      {quests.length === 0 ? (
        <span className="chain-empty">{empty}</span>
      ) : (
        <div className="prereq-chips">
          {quests.map((q) => (
            <button
              key={q.id}
              className={`chip chain-chip${showState ? (q.completed ? ' done' : ' not-done') : ''}`}
              onClick={() => onJumpTo(q.id)}
              title={
                showState
                  ? q.completed
                    ? `${q.name} — completed`
                    : `${q.name} — not completed on your record`
                  : `Jump to ${q.name}`
              }
            >
              {showState && <span className="chain-mark">{q.completed ? '✓' : '✗'}</span>}
              {q.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
