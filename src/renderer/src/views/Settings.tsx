import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  WatcherStatus,
  LogSession,
  HistoricalImportSummary,
  LogProfile
} from '@shared/types'

const SOURCE_LABEL: Record<WatcherStatus['installSource'], string> = {
  'registry-bsg': 'BSG launcher (registry)',
  'registry-steam': 'Steam (registry)',
  manual: 'manual folder',
  'not-found': 'not found'
}

function formatTime(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

export function Settings(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [status, setStatus] = useState<WatcherStatus | null>(null)
  const [sessions, setSessions] = useState<LogSession[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [summary, setSummary] = useState<HistoricalImportSummary | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)

  const loadSessions = useCallback(async () => {
    const list = await window.api.listLogSessions()
    setSessions(list)
    // Default selection: every session not already imported.
    setSelected(new Set(list.filter((s) => !s.imported).map((s) => s.name)))
  }, [])

  useEffect(() => {
    window.api.getSettings().then(setSettings)
    window.api.getWatcherStatus().then(setStatus)
    loadSessions()
    return window.api.onWatcherStatus(setStatus)
  }, [loadSessions])

  const patchSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const updated = await window.api.updateSettings(patch)
    setSettings(updated)
    setStatus(await window.api.getWatcherStatus())
  }, [])

  const pickFolder = useCallback(async () => {
    const next = await window.api.pickInstallFolder()
    setStatus(next)
    setSettings(await window.api.getSettings())
    loadSessions()
  }, [loadSessions])

  const toggleWatch = useCallback(async () => {
    const next = status?.watching
      ? await window.api.stopWatcher()
      : await window.api.startWatcher()
    setStatus(next)
  }, [status])

  const toggleSession = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const refreshNow = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.api.refreshPricesNow()
      setRefreshedAt(Date.now())
    } finally {
      setRefreshing(false)
    }
  }, [])

  const runImport = useCallback(async () => {
    setImporting(true)
    setSummary(null)
    try {
      const result = await window.api.importHistorical([...selected])
      setSummary(result)
      await loadSessions()
    } finally {
      setImporting(false)
    }
  }, [selected, loadSessions])

  if (!settings) return <div className="settings">Loading…</div>

  const importable = sessions.filter((s) => !s.imported)

  return (
    <div className="settings">
      <section className="settings-block">
        <h2>Log watcher</h2>
        <dl className="status-grid">
          <dt>Install</dt>
          <dd>
            {status?.installPath ?? <span className="muted">not detected</span>}
            {status && <span className="source-tag"> · {SOURCE_LABEL[status.installSource]}</span>}
          </dd>
          <dt>Status</dt>
          <dd>
            <span className={`dot ${status?.watching ? 'dot-on' : 'dot-off'}`} />
            {status?.watching ? 'Watching' : 'Stopped'}
          </dd>
          <dt>Active session</dt>
          <dd>{status?.activeSession ?? <span className="muted">none</span>}</dd>
          <dt>Current map</dt>
          <dd>{status?.currentMap ?? <span className="muted">not in raid</span>}</dd>
          <dt>Last event</dt>
          <dd>{formatTime(status?.lastEventAt ?? null)}</dd>
        </dl>

        {status && !status.taskDataAvailable && (
          <p className="error">
            Quest catalog unavailable (couldn&apos;t reach tarkov.dev and no cache). Live quest
            events can&apos;t be recognized yet — retrying automatically. Reconnect and it&apos;ll
            pick up on its own.
          </p>
        )}

        <div className="button-row">
          <button onClick={toggleWatch}>
            {status?.watching ? 'Stop watching' : 'Start watching'}
          </button>
          <button onClick={pickFolder}>Choose install folder…</button>
        </div>
        {!status?.installPath && (
          <p className="hint">
            Couldn&apos;t find Tarkov automatically. Pick the folder that contains the{' '}
            <code>Logs</code> directory.
          </p>
        )}
      </section>

      <section className="settings-block">
        <h2>Profile</h2>
        <div className="button-row">
          {(['pve', 'pvp'] as LogProfile[]).map((p) => (
            <button
              key={p}
              className={settings.profile === p ? 'active' : ''}
              onClick={() => patchSettings({ profile: p })}
            >
              {p === 'pve' ? 'PvE' : 'PvP'}
            </button>
          ))}
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.autoWatch}
            onChange={(e) => patchSettings({ autoWatch: e.target.checked })}
          />
          Start watching automatically on launch
        </label>
      </section>

      <section className="settings-block">
        <h2>Startup &amp; tray</h2>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.launchAtStartup}
            onChange={(e) => patchSettings({ launchAtStartup: e.target.checked })}
          />
          Launch automatically when Windows starts (opens hidden to the tray)
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.minimizeToTray}
            onChange={(e) => patchSettings({ minimizeToTray: e.target.checked })}
          />
          Minimize to tray instead of closing (keeps the log watcher running)
        </label>
        <p className="hint">
          A tray icon is always available while the app is running — right-click it for
          &quot;Show&quot; and &quot;Quit&quot;.
        </p>
      </section>

      <section className="settings-block">
        <h2>Data</h2>
        <div className="button-row">
          <button onClick={refreshNow} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh flea &amp; craft prices now'}
          </button>
          {refreshedAt && <span className="muted">Refreshed {formatTime(refreshedAt)}</span>}
        </div>
      </section>

      <section className="settings-block">
        <h2>Quest Catchup capture</h2>
        <p className="hint">
          Global hotkey that snaps a screenshot for Quest Catchup while capture mode is armed.
          Use Electron accelerator syntax (e.g. <code>F1</code>, <code>CommandOrControl+F9</code>).
          Pick a key Tarkov doesn&apos;t already use.
        </p>
        <label className="checkbox-row">
          <span>Capture hotkey</span>
          <input
            type="text"
            className="hotkey-input"
            value={settings.captureHotkey}
            onChange={(e) => setSettings({ ...settings, captureHotkey: e.target.value })}
            onBlur={(e) => patchSettings({ captureHotkey: e.target.value.trim() || 'F1' })}
          />
        </label>
      </section>

      <section className="settings-block">
        <h2>Import past logs</h2>
        <p className="hint">
          Replay old raid sessions to reconstruct quest progress from before this app was
          installed. Pick a fresh-wipe session as your starting point and select everything
          after it. Already-imported sessions are disabled.
        </p>

        {sessions.length === 0 ? (
          <p className="muted">No log sessions found.</p>
        ) : (
          <>
            <div className="session-list">
              {sessions.map((s) => (
                <label key={s.name} className={`session-row ${s.imported ? 'imported' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={s.imported}
                    checked={selected.has(s.name)}
                    onChange={() => toggleSession(s.name)}
                  />
                  <span className="session-name">{s.name}</span>
                  <span className="session-date">{formatTime(s.startedAt)}</span>
                  {s.imported && <span className="session-badge">imported</span>}
                </label>
              ))}
            </div>
            <div className="button-row">
              <button
                onClick={runImport}
                disabled={importing || selected.size === 0}
              >
                {importing ? 'Importing…' : `Import ${selected.size} session${selected.size === 1 ? '' : 's'}`}
              </button>
              <span className="muted">{importable.length} not yet imported</span>
            </div>
          </>
        )}

        {summary && (
          <p className="import-summary">
            Scanned {summary.sessionsScanned} session{summary.sessionsScanned === 1 ? '' : 's'},{' '}
            {summary.eventsApplied} events — {summary.tasksCompleted} completed,{' '}
            {summary.tasksFailed} failed.
          </p>
        )}
      </section>
    </div>
  )
}
