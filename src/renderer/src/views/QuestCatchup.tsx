import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppData } from '../state/AppDataContext'
import {
  clearImpact,
  compareTraders,
  inferPrerequisiteCompletions,
  matchOcrLinesToTasks,
  reconcileWithActiveList
} from '@shared/questEngine'
import type { CompletionConflict } from '@shared/questEngine'
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
  // applyBulkCompletion covers both directions, so it replaces bulkCompleteTasks
  // here — the add-only helper stays for other callers.
  const { tasks, progress, applyBulkCompletion } = useAppData()

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

  // Screenshot reconciliation (Phase 13): only sound when the captures cover
  // the player's *entire* active list, so it's opt-in per session and off by
  // default — a partial capture would propose completing still-active quests.
  const [fullListConfirmed, setFullListConfirmed] = useState(false)
  const [reconcileOverrides, setReconcileOverrides] = useState<Record<string, boolean>>({})

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
    setReconcileOverrides({})
    // Re-confirm every run: the assertion is about *this* set of screenshots,
    // and leaving it ticked would silently carry it over to a set the user has
    // since added to — exactly the partial-capture case it exists to prevent.
    setFullListConfirmed(false)
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

  const confirmedDetectedIds = useMemo(() => {
    const ids = detectedQuests
      .filter((d) => !excludedDetectedIds.has(d.taskId))
      .map((d) => d.taskId)
    for (const taskId of Object.values(ambiguousSelections)) {
      if (taskId) ids.push(taskId)
    }
    return [...new Set(ids)]
  }, [detectedQuests, excludedDetectedIds, ambiguousSelections])

  // Both modes infer upstream the same way — the traversal never marks its
  // seeds, so what distinguishes the modes is purely whether the detected
  // quests themselves get marked (completed tab) or left in progress (active tab).
  const inferred = useMemo(() => {
    if (!tasks || !progress || confirmedDetectedIds.length === 0) {
      return { completed: [] as string[], uncertain: [] as string[] }
    }
    return inferPrerequisiteCompletions(confirmedDetectedIds, tasks, progress.completedTaskIds)
  }, [tasks, progress, confirmedDetectedIds])

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

  // Reconciliation treats a complete active-list capture as ground truth,
  // catching what upstream inference structurally can't: quests finished long
  // ago whose whole chain is done, so nothing active points back at them.
  // Always computed once there's a capture to judge against, even before the
  // completeness box is ticked: the *count* is what tells the user this step
  // exists and is worth doing. Only whether its ids join the apply set depends
  // on the confirmation. (Learned the hard way — a first live run applied 3
  // inferred prereqs while 86 reconciliation candidates sat unticked below a
  // long results list, and looked like the fix simply hadn't worked.)
  const reconciliation = useMemo(() => {
    if (!tasks || !progress || confirmedDetectedIds.length === 0) {
      return {
        toComplete: [] as string[],
        toUncomplete: [] as string[],
        uncompleteConflicts: [] as CompletionConflict[],
        activeButLocked: [] as string[]
      }
    }
    return reconcileWithActiveList(confirmedDetectedIds, tasks, progress)
  }, [confirmedDetectedIds, tasks, progress])

  const reconciliationEnabled = fullListConfirmed
  const reconcilableCount = reconciliation.toComplete.length + reconciliation.toUncomplete.length

  // Both directions default to checked (the capture is asserted complete);
  // every row is individually overridable before applying.
  const isReconcileChecked = useCallback(
    (id: string): boolean => reconcileOverrides[id] ?? true,
    [reconcileOverrides]
  )
  const toggleReconcile = useCallback(
    (id: string) => {
      setReconcileOverrides((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }))
    },
    []
  )

  const reconcileCompleteIds = useMemo(
    () => (reconciliationEnabled ? reconciliation.toComplete.filter(isReconcileChecked) : []),
    [reconciliationEnabled, reconciliation, isReconcileChecked]
  )
  const reconcileUncompleteIds = useMemo(
    () => (reconciliationEnabled ? reconciliation.toUncomplete.filter(isReconcileChecked) : []),
    [reconciliationEnabled, reconciliation, isReconcileChecked]
  )

  // Everything the Apply button will actually write: the inferred prerequisites
  // of the captured active quests, plus whatever reconciliation proposes.
  const willMarkIds = useMemo(
    () => [...new Set([...includedPrereqIds, ...reconcileCompleteIds])],
    [includedPrereqIds, reconcileCompleteIds]
  )

  // Reported below the list, never applied — see clearImpact. Cascading these
  // would have deleted ten completions the game itself logged as finished.
  const impact = useMemo(
    () => clearImpact(reconcileUncompleteIds, tasks ?? [], progress?.completedTaskIds ?? []),
    [reconcileUncompleteIds, tasks, progress]
  )

  // Exactly what the user ticked. A quest they have active must not be marked
  // completed by inference in the same apply that clears it — removals win.
  const willUnmarkIds = reconcileUncompleteIds

  const apply = useCallback(async () => {
    setApplying(true)
    try {
      const unmarkSet = new Set(willUnmarkIds)
      const marks = willMarkIds.filter((id) => !unmarkSet.has(id))
      await applyBulkCompletion(marks, willUnmarkIds)
      setAppliedCount(marks.length + willUnmarkIds.length)
      setRows(null)
      setScreenshots([])
      setFullListConfirmed(false)
    } finally {
      setApplying(false)
    }
  }, [applyBulkCompletion, willMarkIds, willUnmarkIds])

  if (!tasks || !progress) return <div className="settings">Loading…</div>

  return (
    <div className="settings">
      <section className="settings-block">
        <h2>Quest Catchup</h2>
        <p className="hint">
          New setup, already mid-wipe? Capture your in-game quest list and this will let you
          review and bulk-mark completions. It infers which quests must already be done for your
          active quests to be unlocked — the active quests themselves are left untouched (in
          progress, not done) — and, if you confirm the capture covers your whole list,
          reconciles the tracker against it.
        </p>

        <div className="button-row">
          <button className={captureArmed ? 'active' : ''} onClick={toggleCaptureMode}>
            {captureArmed ? `Capture mode ON — press ${captureHotkey}` : 'Turn on capture mode'}
          </button>
          <span className="muted">
            {captureArmed ? (
              <>
                Open the Tasks screen in-game and press{' '}
                <kbd>{captureHotkey}</kbd> — scroll and press again for each screenful. (Requires
                borderless windowed mode.)
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
              No quests recognized in the pasted screenshot(s). Try a clearer screenshot, or zoom
              in on the quest list before capturing.
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

      {rows && confirmedDetectedIds.length > 0 && (
        <section className={`settings-block${reconcilableCount > 0 && !fullListConfirmed ? ' needs-attention' : ''}`}>
          <h2>
            Match my tracker to these screenshots
            {reconcilableCount > 0 && (
              <span className="section-badge">{reconcilableCount} mismatch(es) found</span>
            )}
          </h2>
          {reconcilableCount > 0 && !fullListConfirmed && (
            <p className="callout">
              <strong>
                {reconciliation.toComplete.length} quest(s) look already-completed
                {reconciliation.toUncomplete.length > 0 && (
                  <> and {reconciliation.toUncomplete.length} look wrongly marked done</>
                )}
                .
              </strong>{' '}
              They stay untouched unless you confirm the capture is complete, just below.
            </p>
          )}
          <p className="hint">
            In Tarkov every unlocked quest stays in your task list, so a <em>complete</em> capture
            is the whole truth: anything tracked as available but missing from it must already be
            done, and anything tracked as done but sitting in your list clearly isn&apos;t. This
            catches quests whose entire chain is finished — nothing active points back at them, so
            prerequisite inference alone can never find them.
          </p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={fullListConfirmed}
              onChange={(e) => setFullListConfirmed(e.target.checked)}
            />
            These screenshots cover my <strong>entire</strong> active task list, top to bottom
          </label>
          {!fullListConfirmed ? (
            <p className="muted">
              Leave unticked if you only captured part of the list — a partial capture would look
              like those quests are finished. (This resets each time you re-run Find matches, so
              it always refers to the screenshots you have now.)
            </p>
          ) : (
            <>
              {reconciliation.toComplete.length === 0 && reconciliation.toUncomplete.length === 0 ? (
                <p className="muted">
                  Nothing to reconcile — your tracker already matches the captured list.
                </p>
              ) : (
                <>
                  {reconciliation.toComplete.length > 0 && (
                    <>
                      <h3 className="catchup-subheading">
                        Not in your capture → mark completed ({reconcileCompleteIds.length}/
                        {reconciliation.toComplete.length})
                      </h3>
                      <p className="hint">
                        Unlocked and not level-gated, so Tarkov would be listing them — their
                        absence means they&apos;re already done. <strong>Ticked = mark completed.</strong>{' '}
                        Untick anything you know you haven&apos;t finished.
                      </p>
                      <div className="session-list">
                        {reconciliation.toComplete.map((id) => {
                          const t = tasksById.get(id)
                          if (!t) return null
                          return (
                            <label key={id} className="session-row">
                              <input
                                type="checkbox"
                                checked={isReconcileChecked(id)}
                                onChange={() => toggleReconcile(id)}
                              />
                              <span className="session-name">
                                {t.kappaRequired && <span className="kappa-star">★</span>}
                                {t.name}
                                <span className="muted"> · {t.trader}</span>
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </>
                  )}

                  {reconciliation.toUncomplete.length > 0 && (
                    <>
                      <h3 className="catchup-subheading">
                        In your capture but tracked as done — check these (
                        {reconcileUncompleteIds.length}/{reconciliation.toUncomplete.length})
                      </h3>
                      <p className="callout">
                        These contradict each other: your records say completed, the capture shows
                        them listed. <strong>Ticked = clear the completed mark</strong> (back to
                        active). <strong>Verify each one in game first</strong> — a finished quest
                        can still be listed while it awaits turn-in, and clearing one that later
                        quests were unlocked by leaves those quests marked done with an unfinished
                        prerequisite. If a quest further down its chain is already done, this one
                        really is complete: untick it.
                      </p>
                      <div className="session-list">
                        {reconciliation.toUncomplete.map((id) => {
                          const t = tasksById.get(id)
                          if (!t) return null
                          return (
                            <label key={id} className="session-row">
                              <input
                                type="checkbox"
                                checked={isReconcileChecked(id)}
                                onChange={() => toggleReconcile(id)}
                              />
                              <span className="session-name">
                                {t.kappaRequired && <span className="kappa-star">★</span>}
                                {t.name}
                                <span className="muted"> · {t.trader} · tracked as done, but appeared in your capture</span>
                              </span>
                            </label>
                          )
                        })}
                      </div>
                      {reconciliation.uncompleteConflicts.length > 0 && (
                        <div className="callout">
                          <strong>
                            Heads up: tarkov.dev&apos;s quest tree disagrees with{' '}
                            {reconciliation.uncompleteConflicts.length} of these.
                          </strong>{' '}
                          It claims each one must be finished before quests you&apos;ve already
                          done. Your in-game quest list wins — the catalog&apos;s prerequisites
                          don&apos;t always match the live game — so these are still ticked.
                          Listed only so nothing is hidden from you:
                          <ul className="cascade-list">
                            {reconciliation.uncompleteConflicts.map(({ taskId, contradictedBy }) => {
                              const t = tasksById.get(taskId)
                              const names = contradictedBy
                                .map((id) => tasksById.get(id)?.name ?? id)
                                .slice(0, 3)
                              return (
                                <li key={taskId}>
                                  <strong>{t?.name ?? taskId}</strong> — supposedly required by{' '}
                                  {names.join(', ')}
                                  {contradictedBy.length > names.length &&
                                    ` +${contradictedBy.length - names.length} more`}
                                </li>
                              )
                            })}
                          </ul>
                        </div>
                      )}
                      {impact.orphaned.length > 0 && (
                        <p className="hint">
                          {impact.orphaned.length} quest(s) further down these chains stay marked
                          completed. That&apos;s deliberate — they were finished in game, and
                          nothing here deletes progress you didn&apos;t ask it to.
                        </p>
                      )}
                    </>
                  )}
                </>
              )}

              {reconciliation.activeButLocked.length > 0 && (
                <p className="hint">
                  <strong>{reconciliation.activeButLocked.length} captured quest(s) are tracked as{' '}
                  <em>locked</em></strong> — you have them, so a quest that unlocks them must be
                  done and isn&apos;t recorded. Nothing is changed on these directly; the
                  &quot;mark completed&quot; list above and the inferred prerequisites below are
                  what resolve them. Nothing to do here — it&apos;s a note, not a decision.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {rows && confirmedDetectedIds.length > 0 && (
        <section className="settings-block">
          <h2>
            Will mark {willMarkIds.length} completed
            {willUnmarkIds.length > 0 && <> and clear {willUnmarkIds.length}</>}
          </h2>
          {prereqIds.length === 0 ? (
            <p className="muted">
              Nothing further to infer — either these quests have no prerequisites, or everything
              upstream is already marked completed.
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

          {reconcilableCount > 0 && !reconciliationEnabled && (
            <p className="callout">
              Not including the <strong>{reconcilableCount} mismatch(es)</strong> found against
              your screenshots — tick the confirmation in the section above to fix those too.
            </p>
          )}

          <div className="button-row">
            <button
              onClick={apply}
              disabled={applying || (willMarkIds.length === 0 && willUnmarkIds.length === 0)}
            >
              {applying
                ? 'Applying…'
                : willUnmarkIds.length > 0
                  ? `Apply: ${willMarkIds.length} completed, ${willUnmarkIds.length} cleared`
                  : `Mark ${willMarkIds.length} quest(s) completed`}
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
