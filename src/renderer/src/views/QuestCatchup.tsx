import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppData } from '../state/AppDataContext'
import {
  compareTraders,
  inferPrerequisiteCompletions,
  matchOcrLinesToTasks
} from '@shared/questEngine'
import type { OcrMatch, ScreenshotCapture, TaskData } from '@shared/types'

/** Below this, a line's top candidate is treated as noise, not worth a manual pick. */
const AMBIGUOUS_SHOW_FLOOR = 0.4

interface DetectedQuest {
  taskId: string
  taskName: string
  kappaRequired: boolean
  hitCount: number
}

export function QuestCatchup(): React.JSX.Element {
  const { tasks, progress, bulkCompleteTasks } = useAppData()

  const [screenshots, setScreenshots] = useState<ScreenshotCapture[]>([])
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)

  const [captureArmed, setCaptureArmed] = useState(false)
  const [captureHotkey, setCaptureHotkey] = useState<string>('F1')

  const [rows, setRows] = useState<OcrMatch[] | null>(null)
  const [excludedDetectedIds, setExcludedDetectedIds] = useState<Set<string>>(new Set())
  const [ambiguousSelections, setAmbiguousSelections] = useState<Record<string, string | null>>(
    {}
  )
  const [showUnmatchedLines, setShowUnmatchedLines] = useState(false)

  // Explicit include/exclude overrides for inferred prerequisites, keyed by task
  // id so they survive re-inference as the user toggles detected quests. Default
  // (no entry) = checked for completion-certain prereqs, unchecked for uncertain.
  const [prereqOverrides, setPrereqOverrides] = useState<Record<string, boolean>>({})
  const [applying, setApplying] = useState(false)
  const [appliedCount, setAppliedCount] = useState<number | null>(null)

  const addScreenshot = useCallback(async () => {
    setCaptureError(null)
    setCapturing(true)
    try {
      const capture = await window.api.captureAndOcrClipboard()
      if (!capture) {
        setCaptureError(
          'No image found on the clipboard. Copy a screenshot first (e.g. Win+Shift+S), then try again.'
        )
        return
      }
      setScreenshots((prev) => [...prev, capture])
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : String(err))
    } finally {
      setCapturing(false)
    }
  }, [])

  const removeScreenshot = useCallback((id: string) => {
    setScreenshots((prev) => prev.filter((s) => s.id !== id))
  }, [])

  // While capture mode is armed, native hotkey captures and their errors arrive
  // over push channels — append captures to the list just like clipboard ones.
  useEffect(() => {
    if (!captureArmed) return
    const offCapture = window.api.onCatchupCapture((capture) =>
      setScreenshots((prev) => [...prev, capture])
    )
    const offError = window.api.onCatchupCaptureError((message) => setCaptureError(message))
    return () => {
      offCapture()
      offError()
    }
  }, [captureArmed])

  // Never leave the global hotkey registered when the view unmounts.
  useEffect(() => {
    return () => {
      window.api.disarmCapture()
    }
  }, [])

  const toggleCaptureMode = useCallback(async () => {
    setCaptureError(null)
    if (captureArmed) {
      await window.api.disarmCapture()
      setCaptureArmed(false)
      return
    }
    const { ok, hotkey } = await window.api.armCapture()
    setCaptureHotkey(hotkey)
    if (ok) {
      setCaptureArmed(true)
    } else {
      setCaptureError(
        `Couldn’t register the ${hotkey} hotkey — another app may be using it. Change it in Settings.`
      )
    }
  }, [captureArmed])

  const findMatches = useCallback(async () => {
    if (!tasks || !progress) return
    // Capture is only useful up through this point in the flow — turn it off
    // so the hotkey doesn't keep firing captures into a list the user has
    // already moved on from reviewing.
    if (captureArmed) {
      await window.api.disarmCapture()
      setCaptureArmed(false)
    }
    const allLines = screenshots.flatMap((s) => s.lines)
    // Tarkov's own catalog mirrors many quests under an identical name, one
    // per faction (e.g. "The Tarkov Shooter", "Ambulance") with different task
    // ids — scoring against both twins ties them at equal confidence and the
    // matcher correctly refuses to guess between look-alikes. We already know
    // the player's faction, so exclude the impossible twin before scoring.
    const candidateTasks = tasks.filter(
      (t) => t.factionName === 'Any' || t.factionName === progress.faction
    )
    setRows(matchOcrLinesToTasks(allLines, candidateTasks))
    setExcludedDetectedIds(new Set())
    setAmbiguousSelections({})
    setPrereqOverrides({})
    setAppliedCount(null)
  }, [screenshots, tasks, progress, captureArmed])

  const tasksById = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks])

  // Confident line-level matches, deduped to one entry per quest (a quest
  // can legitimately appear on several screenshots/lines).
  const detectedQuests = useMemo((): DetectedQuest[] => {
    if (!rows) return []
    const byTaskId = new Map<string, DetectedQuest>()
    for (const row of rows) {
      if (!row.matchedTaskId) continue
      const task = tasksById.get(row.matchedTaskId)
      if (!task) continue
      const existing = byTaskId.get(task.id)
      if (existing) existing.hitCount++
      else
        byTaskId.set(task.id, {
          taskId: task.id,
          taskName: task.name,
          kappaRequired: task.kappaRequired,
          hitCount: 1
        })
    }
    return [...byTaskId.values()].sort((a, b) => a.taskName.localeCompare(b.taskName))
  }, [rows, tasksById])

  // Lines with no confident match but a plausible top candidate — genuinely
  // worth a manual pick, unlike table-noise lines that scored near zero.
  const ambiguousRows = useMemo(
    () =>
      (rows ?? []).filter(
        (r) => r.matchedTaskId === null && (r.candidates[0]?.confidence ?? 0) >= AMBIGUOUS_SHOW_FLOOR
      ),
    [rows]
  )

  const unmatchedLines = useMemo(
    () =>
      (rows ?? [])
        .filter(
          (r) => r.matchedTaskId === null && (r.candidates[0]?.confidence ?? 0) < AMBIGUOUS_SHOW_FLOOR
        )
        .map((r) => r.line),
    [rows]
  )

  const toggleDetected = useCallback((taskId: string) => {
    setExcludedDetectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])

  const setAmbiguousSelection = useCallback((rowKey: string, taskId: string | null) => {
    setAmbiguousSelections((prev) => ({ ...prev, [rowKey]: taskId }))
  }, [])

  const confirmedActiveTaskIds = useMemo(() => {
    const ids = detectedQuests
      .filter((d) => !excludedDetectedIds.has(d.taskId))
      .map((d) => d.taskId)
    for (const taskId of Object.values(ambiguousSelections)) {
      if (taskId) ids.push(taskId)
    }
    return [...new Set(ids)]
  }, [detectedQuests, excludedDetectedIds, ambiguousSelections])

  const inferred = useMemo(() => {
    if (!tasks || !progress || confirmedActiveTaskIds.length === 0) {
      return { completed: [] as string[], uncertain: [] as string[] }
    }
    return inferPrerequisiteCompletions(confirmedActiveTaskIds, tasks, progress.completedTaskIds)
  }, [tasks, progress, confirmedActiveTaskIds])

  const prereqIds = useMemo(
    () => [...inferred.completed, ...inferred.uncertain],
    [inferred]
  )
  const certainSet = useMemo(() => new Set(inferred.completed), [inferred])
  const uncertainSet = useMemo(() => new Set(inferred.uncertain), [inferred])

  // Completion-certain prereqs default checked; uncertain (failed/active-
  // satisfiable) default unchecked so they aren't silently marked done.
  const isPrereqChecked = useCallback(
    (id: string): boolean => prereqOverrides[id] ?? certainSet.has(id),
    [prereqOverrides, certainSet]
  )

  const prereqsByTrader = useMemo(() => {
    const groups = new Map<string, TaskData[]>()
    for (const id of prereqIds) {
      const task = tasksById.get(id)
      if (!task) continue
      const list = groups.get(task.trader) ?? []
      list.push(task)
      groups.set(task.trader, list)
    }
    for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    return [...groups.entries()].sort(([a], [b]) => compareTraders(a, b))
  }, [prereqIds, tasksById])

  const togglePrereq = useCallback(
    (id: string) => {
      setPrereqOverrides((prev) => ({ ...prev, [id]: !isPrereqChecked(id) }))
    },
    [isPrereqChecked]
  )

  const includedPrereqIds = useMemo(
    () => prereqIds.filter((id) => isPrereqChecked(id)),
    [prereqIds, isPrereqChecked]
  )

  const apply = useCallback(async () => {
    setApplying(true)
    try {
      await bulkCompleteTasks(includedPrereqIds)
      setAppliedCount(includedPrereqIds.length)
      setRows(null)
      setScreenshots([])
    } finally {
      setApplying(false)
    }
  }, [bulkCompleteTasks, includedPrereqIds])

  if (!tasks || !progress) return <div className="settings">Loading…</div>

  return (
    <div className="settings">
      <section className="settings-block">
        <h2>Quest Catchup</h2>
        <p className="hint">
          New setup, already mid-wipe? Capture your in-game active quest list and this will figure
          out which quests must already be done to unlock them, then let you review and bulk-mark
          those as completed. Your active quests themselves are left untouched — they show as
          in-progress, not done.
        </p>

        <div className="button-row">
          <button className={captureArmed ? 'active' : ''} onClick={toggleCaptureMode}>
            {captureArmed ? `Capture mode ON — press ${captureHotkey}` : 'Turn on capture mode'}
          </button>
          <span className="muted">
            {captureArmed ? (
              <>
                Open the Tasks screen in-game and press <kbd>{captureHotkey}</kbd> — scroll and
                press again for each screenful. (Requires borderless windowed mode.)
              </>
            ) : (
              <>Snaps the screen itself on a hotkey, for consistent OCR. Change the key in Settings.</>
            )}
          </span>
        </div>

        <div className="button-row">
          <button onClick={addScreenshot} disabled={capturing}>
            {capturing ? 'Reading clipboard…' : 'Add screenshot from clipboard'}
          </button>
          <span className="muted">Or paste manually: copy a screenshot (Win+Shift+S), then click Add.</span>
        </div>
        {captureError && <p className="error">{captureError}</p>}

        {screenshots.length > 0 && (
          <div className="catchup-screenshot-list">
            {screenshots.map((s) => (
              <div key={s.id} className="catchup-screenshot-card">
                <img src={s.dataUrl} alt="" className="catchup-thumb" />
                <span className="muted">{s.lines.length} line(s) recognized</span>
                <button onClick={() => removeScreenshot(s.id)}>Remove</button>
              </div>
            ))}
          </div>
        )}

        <div className="button-row">
          <button onClick={findMatches} disabled={screenshots.length === 0}>
            Find matches
          </button>
        </div>
      </section>

      {rows && (
        <section className="settings-block">
          <h2>Recognized active quests</h2>

          {detectedQuests.length === 0 && ambiguousRows.length === 0 ? (
            <p className="muted">
              No active quests recognized in the pasted screenshot(s). Try a clearer screenshot,
              or zoom in on the quest list before capturing.
            </p>
          ) : (
            <>
              {detectedQuests.length > 0 && (
                <div className="session-list">
                  {detectedQuests.map((q) => (
                    <label key={q.taskId} className="session-row">
                      <input
                        type="checkbox"
                        checked={!excludedDetectedIds.has(q.taskId)}
                        onChange={() => toggleDetected(q.taskId)}
                      />
                      <span className="session-name">
                        {q.kappaRequired && <span className="kappa-star">★</span>}
                        {q.taskName}
                      </span>
                      {q.hitCount > 1 && <span className="muted">seen {q.hitCount}×</span>}
                    </label>
                  ))}
                </div>
              )}

              {ambiguousRows.length > 0 && (
                <>
                  <h3 className="catchup-subheading">Uncertain — pick the right quest, or skip</h3>
                  <div className="session-list catchup-match-list">
                    {ambiguousRows.map((row) => (
                      <div key={row.key} className="session-row catchup-match-row">
                        <span className="session-name" title={row.line}>
                          {row.line}
                        </span>
                        <select
                          value={ambiguousSelections[row.key] ?? ''}
                          onChange={(e) => setAmbiguousSelection(row.key, e.target.value || null)}
                        >
                          <option value="">— Skip —</option>
                          {row.candidates.map((c) => (
                            <option key={c.taskId} value={c.taskId}>
                              {c.taskName} ({Math.round(c.confidence * 100)}%)
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {unmatchedLines.length > 0 && (
                <div className="catchup-unmatched">
                  <button
                    className="catchup-unmatched-toggle"
                    onClick={() => setShowUnmatchedLines((v) => !v)}
                  >
                    {showUnmatchedLines ? 'Hide' : 'Show'} {unmatchedLines.length} unrecognized
                    line(s)
                  </button>
                  {showUnmatchedLines && (
                    <ul className="catchup-unmatched-list">
                      {unmatchedLines.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {rows && confirmedActiveTaskIds.length > 0 && (
        <section className="settings-block">
          <h2>Will mark {includedPrereqIds.length} quest(s) completed</h2>
          {prereqIds.length === 0 ? (
            <p className="muted">
              Nothing to infer — either these quests have no prerequisites, or everything upstream
              is already marked completed.
            </p>
          ) : (
            <>
              {uncertainSet.size > 0 && (
                <p className="hint">
                  Prerequisites that unlock whether they were <em>completed, failed, or merely
                  started</em> can't be assumed done — they're left unchecked below. Tick any you
                  actually finished.
                </p>
              )}
              <div className="session-list">
                {prereqsByTrader.map(([trader, traderTasks]) => (
                  <div key={trader}>
                    <div className="catchup-trader-heading">{trader}</div>
                    {traderTasks.map((task) => (
                      <label key={task.id} className="session-row">
                        <input
                          type="checkbox"
                          checked={isPrereqChecked(task.id)}
                          onChange={() => togglePrereq(task.id)}
                        />
                        <span className="session-name">
                          {task.kappaRequired && <span className="kappa-star">★</span>}
                          {task.name}
                          {uncertainSet.has(task.id) && (
                            <span className="muted"> · may be failed/started — verify</span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="button-row">
            <button onClick={apply} disabled={applying || includedPrereqIds.length === 0}>
              {applying ? 'Applying…' : `Mark ${includedPrereqIds.length} quest(s) completed`}
            </button>
          </div>
        </section>
      )}

      {appliedCount !== null && (
        <p className="import-summary">
          Marked {appliedCount} quest{appliedCount === 1 ? '' : 's'} completed.
        </p>
      )}
    </div>
  )
}
