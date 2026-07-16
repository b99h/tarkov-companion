import {
  watch,
  statSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  existsSync
} from 'fs'
import type { FSWatcher } from 'fs'
import { join } from 'path'
import type {
  TaskData,
  WatcherStatus,
  QuestEventNotice,
  HistoricalImportSummary,
  InstallSource,
  PlayerProgress,
  TaskLogEvent
} from '../../shared/types'
import { parseNotificationsLog, parseApplicationLog } from '../../shared/logParser'
import { applyTaskEvents } from '../store/progressStore'
import { getOffset, setOffset } from '../store/checkpointStore'
import { loadSettings, markSessionsImported } from '../store/settingsStore'
import {
  findInstall,
  listLogSessions,
  findLogFile,
  NOTIFICATIONS_SUFFIX,
  APPLICATION_SUFFIX
} from './installFinder'

export interface LogWatcherCallbacks {
  onProgress: (progress: PlayerProgress) => void
  onQuestEvents: (notices: QuestEventNotice[]) => void
  onStatus: (status: WatcherStatus) => void
}

/**
 * Safety-net poll interval. `fs.watch` on the session folder is the primary,
 * low-latency signal, but the folder also holds high-frequency files
 * (output/backend logs write continuously during a raid) — a naive debounce on
 * every folder change can starve indefinitely under that write volume and never
 * fire (confirmed live: a real quest completion sat unread for 10+ minutes).
 * Polling unconditionally on this interval guarantees eventual consistency
 * regardless of what `fs.watch` does or doesn't deliver.
 */
const POLL_MS = 3000

/**
 * Read bytes appended since `offset`, but only up to the last complete line, so we
 * never parse a half-written JSON payload and never split a multi-byte character.
 * Resets to 0 if the file shrank (log rotation / new wipe). Returns the text to
 * parse and the new byte offset to persist.
 */
function readNewText(filePath: string, offset: number): { text: string; newOffset: number } {
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return { text: '', newOffset: offset }
  }

  let from = offset
  if (size < from) from = 0 // truncated or replaced
  if (size === from) return { text: '', newOffset: from }

  const length = size - from
  const buffer = Buffer.alloc(length)
  const fd = openSync(filePath, 'r')
  try {
    readSync(fd, buffer, 0, length, from)
  } finally {
    closeSync(fd)
  }

  const chunk = buffer.toString('utf-8')
  const lastNewline = chunk.lastIndexOf('\n')
  if (lastNewline === -1) return { text: '', newOffset: from } // no complete line yet

  const consumed = chunk.slice(0, lastNewline + 1)
  return { text: consumed, newOffset: from + Buffer.byteLength(consumed, 'utf-8') }
}

/**
 * Owns install discovery, live tailing of the active session's `notifications.log`,
 * raid detection from `application.log`, and historical replay. Emits progress and
 * quest-event notices back to the main process via injected callbacks.
 */
export class LogWatcher {
  private taskById = new Map<string, TaskData>()
  private knownTaskIds = new Set<string>()

  private installPath: string | null = null
  private installSource: InstallSource = 'not-found'

  private logsWatcher: FSWatcher | null = null
  private sessionWatcher: FSWatcher | null = null

  private activeSessionName: string | null = null
  private notificationsFile: string | null = null
  private applicationFile: string | null = null

  private watching = false
  private lastEventAt: number | null = null
  private currentMap: string | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private taskDataAvailable = false
  private seedRetryTimer: NodeJS.Timeout | null = null

  constructor(private readonly cb: LogWatcherCallbacks) {}

  /** How often to retry seeding the task catalog after a failed fetch. */
  private static readonly SEED_RETRY_MS = 10 * 60 * 1000

  /** Provide the fetched task set so events can be filtered and named. */
  setTasks(tasks: TaskData[]): void {
    this.taskById = new Map(tasks.map((t) => [t.id.toLowerCase(), t]))
    this.knownTaskIds = new Set(this.taskById.keys())
    this.taskDataAvailable = this.knownTaskIds.size > 0
  }

  /**
   * Seed the task catalog, retrying on the same cadence as the price refresh if
   * the initial fetch fails (e.g. launched offline with no cache) — otherwise
   * `knownTaskIds` stays empty forever and every live quest event is silently
   * dropped until an app restart. Self-clears the retry once a seed succeeds.
   */
  async seedTasks(fetchTasks: () => Promise<TaskData[]>): Promise<void> {
    try {
      this.setTasks(await fetchTasks())
      if (this.seedRetryTimer) {
        clearInterval(this.seedRetryTimer)
        this.seedRetryTimer = null
      }
    } catch (err) {
      console.error('[watcher] task seed failed, will retry:', err)
      if (!this.seedRetryTimer) {
        this.seedRetryTimer = setInterval(() => {
          void this.seedTasks(fetchTasks)
        }, LogWatcher.SEED_RETRY_MS)
      }
    }
    this.emitStatus()
  }

  getStatus(): WatcherStatus {
    return {
      installPath: this.installPath,
      installSource: this.installSource,
      profile: loadSettings().profile,
      watching: this.watching,
      activeSession: this.activeSessionName,
      lastEventAt: this.lastEventAt,
      currentMap: this.currentMap,
      taskDataAvailable: this.taskDataAvailable
    }
  }

  private emitStatus(): void {
    this.cb.onStatus(this.getStatus())
  }

  private resolveInstall(): void {
    const info = findInstall(loadSettings().installPath)
    this.installPath = info.installPath
    this.installSource = info.source
  }

  /** Begin (or restart) tailing the newest log session. Idempotent. */
  start(): void {
    this.stop()
    this.resolveInstall()

    if (!this.installPath) {
      this.watching = false
      this.emitStatus()
      return
    }

    this.watchLogsDir()
    this.switchToNewestSession()
    this.watching = true
    // Primary signal is fs.watch (near-instant); this interval is a correctness
    // safety net in case events are missed or starved out (see POLL_MS comment).
    this.pollTimer = setInterval(() => {
      this.switchToNewestSession()
      this.processNotifications()
      this.processApplication()
    }, POLL_MS)
    this.emitStatus()
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.logsWatcher?.close()
    this.sessionWatcher?.close()
    this.logsWatcher = null
    this.sessionWatcher = null
    this.watching = false
  }

  /** Watch the Logs directory so a game restart (new session folder) is picked up. */
  private watchLogsDir(): void {
    if (!this.installPath) return
    const logsDir = join(this.installPath, 'Logs')
    if (!existsSync(logsDir)) return

    try {
      this.logsWatcher = watch(logsDir, { persistent: false }, () => {
        this.switchToNewestSession()
      })
    } catch {
      // Directory watching unsupported/unavailable; live-switch simply won't fire.
    }
  }

  private switchToNewestSession(): void {
    if (!this.installPath) return
    const sessions = listLogSessions(this.installPath, new Set())
    const newest = sessions[0]
    if (!newest || newest.name === this.activeSessionName) return

    this.sessionWatcher?.close()
    this.sessionWatcher = null

    this.activeSessionName = newest.name
    this.notificationsFile = findLogFile(newest.folder, NOTIFICATIONS_SUFFIX)
    this.applicationFile = findLogFile(newest.folder, APPLICATION_SUFFIX)

    // Catch up on anything already written to this session, then watch for more.
    this.processNotifications()
    this.processApplication()

    try {
      // No debounce here: readNewText only consumes up to the last complete line
      // and is cheap, so processing on every raw event is safe. Debouncing this
      // callback previously caused missed events — the folder also contains
      // high-frequency files (output/backend logs) that reset a timer-based
      // debounce faster than it could ever fire during an active raid.
      this.sessionWatcher = watch(newest.folder, { persistent: false }, () => {
        this.processNotifications()
        this.processApplication()
      })
    } catch {
      // Fall back to catch-up-only; the poll interval in start() still covers us.
    }
    this.emitStatus()
  }

  private processNotifications(): void {
    if (!this.notificationsFile) return
    const { text, newOffset } = readNewText(
      this.notificationsFile,
      getOffset(this.notificationsFile)
    )
    if (!text) {
      // Still persist a shrink-to-0 reset (log rotation/wipe); a no-op otherwise.
      setOffset(this.notificationsFile, newOffset)
      return
    }

    const events = parseNotificationsLog(text)
    if (events.length === 0) {
      setOffset(this.notificationsFile, newOffset)
      return
    }

    const { progress, changedTaskIds } = applyTaskEvents(events, this.knownTaskIds)
    // Advance the checkpoint only after events are safely applied and progress
    // is persisted, so a crash mid-apply re-reads these events next time rather
    // than skipping them forever.
    setOffset(this.notificationsFile, newOffset)

    // Toasts for every recognized event (started included), newest state wins.
    const notices: QuestEventNotice[] = []
    for (const event of events) {
      const task = this.taskById.get(event.taskId)
      if (!task) continue
      notices.push({
        taskId: task.id,
        taskName: task.name,
        type: event.type,
        timestamp: event.timestamp
      })
    }

    if (notices.length > 0) {
      this.lastEventAt = Date.now()
      this.cb.onQuestEvents(notices)
    }
    if (changedTaskIds.length > 0) {
      this.cb.onProgress(progress)
    }
    if (notices.length > 0) this.emitStatus()
  }

  private processApplication(): void {
    if (!this.applicationFile) return
    const { text, newOffset } = readNewText(
      this.applicationFile,
      getOffset(this.applicationFile)
    )
    if (!text) {
      setOffset(this.applicationFile, newOffset)
      return
    }

    const raidEvents = parseApplicationLog(text)
    setOffset(this.applicationFile, newOffset)
    for (const event of raidEvents) {
      if (event.type === 'start' && event.map) this.currentMap = event.map
      else if (event.type === 'end') this.currentMap = null
    }
    if (raidEvents.length > 0) this.emitStatus()
  }

  /**
   * Replay selected past session folders into progress, reconstructing state from
   * before the app existed. Sessions already imported are skipped. Reads each
   * notifications.log in full (offsets are for live tailing, not import).
   */
  importHistorical(sessionNames: string[]): HistoricalImportSummary {
    this.resolveInstall()
    const summary: HistoricalImportSummary = {
      sessionsScanned: 0,
      eventsApplied: 0,
      tasksCompleted: 0,
      tasksFailed: 0
    }
    if (!this.installPath) return summary

    const alreadyImported = new Set(loadSettings().importedSessions)
    // Oldest first: event order matters (a later "finished" must apply after an
    // earlier "failed" for the same task), and listLogSessions sorts newest-first.
    const sessions = listLogSessions(this.installPath, alreadyImported).reverse()
    const wanted = new Set(sessionNames)

    // Gather every event across the chosen sessions first, then apply once so the
    // progress store is written a single time regardless of how many folders.
    const allEvents: TaskLogEvent[] = []
    const importedNow: string[] = []

    for (const session of sessions) {
      if (!wanted.has(session.name) || session.imported) continue
      const file = findLogFile(session.folder, NOTIFICATIONS_SUFFIX)
      if (!file) continue

      let events
      try {
        events = parseNotificationsLog(readFileSync(file, 'utf-8'))
      } catch {
        continue
      }

      summary.sessionsScanned++
      summary.eventsApplied += events.length
      allEvents.push(...events)
      importedNow.push(session.name)
    }

    if (importedNow.length === 0) return summary

    const { progress, changedTaskIds } = applyTaskEvents(allEvents, this.knownTaskIds)
    const changed = new Set(changedTaskIds)
    // A task counts as completed if its final applied state is complete; failures
    // that were later finished won't be double-counted since finished clears failed.
    const completed = new Set(progress.completedTaskIds)
    for (const id of changed) {
      if (completed.has(id)) summary.tasksCompleted++
      else summary.tasksFailed++
    }

    markSessionsImported(importedNow)
    this.cb.onProgress(progress)
    return summary
  }

  /** Enumerate sessions for the import wizard, marking those already applied. */
  listSessions(): ReturnType<typeof listLogSessions> {
    this.resolveInstall()
    if (!this.installPath) return []
    return listLogSessions(this.installPath, new Set(loadSettings().importedSessions))
  }
}
