import { app, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

/** Re-check cadence while the app stays open (the log watcher keeps it running for hours). */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * Phase 7.3 — in-app updates against GitHub Releases.
 *
 * Nothing here ever downloads or installs without an explicit renderer request
 * (`autoDownload` off, `quitAndInstall` only from the `updates:install`
 * handler): a surprise restart mid-raid is the one unforgivable bug for this
 * app's audience. Main only *checks* on its own — on startup and every 4 h —
 * and pushes what it finds to the renderer's banner.
 *
 * The portable exe cannot self-update (there is no installer to re-run), so it
 * still checks and announces new versions, but with `portable: true` so the
 * renderer offers a GitHub download link instead of an update button.
 */
export class UpdateManager {
  private readonly onStatus: (status: UpdateStatus) => void
  private readonly portable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
  private interval: NodeJS.Timeout | null = null
  private checking = false
  /**
   * True while the in-flight check/download was requested from the renderer.
   * Background failures (offline, no release published yet) only log — an
   * error banner on every launch would train users to ignore it.
   */
  private userInitiated = false

  constructor(onStatus: (status: UpdateStatus) => void) {
    this.onStatus = onStatus

    autoUpdater.autoDownload = false
    // Even a downloaded update waits for the explicit "Restart to install"
    // click — installing behind the user's back on quit is still a surprise.
    autoUpdater.autoInstallOnAppQuit = false
    // Configured in code rather than relying on the app-update.yml
    // electron-builder embeds, so the portable exe (which doesn't get that
    // file) can still check for updates.
    autoUpdater.setFeedURL({ provider: 'github', owner: 'b99h', repo: 'tarkov-companion' })

    autoUpdater.on('checking-for-update', () => this.push({ state: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      this.push({ state: 'available', version: info.version })
    })
    autoUpdater.on('update-not-available', () => this.push({ state: 'idle' }))
    autoUpdater.on('download-progress', (progress) => {
      this.push({ state: 'downloading', percent: Math.round(progress.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.push({ state: 'ready', version: info.version })
    })
    autoUpdater.on('error', (error) => {
      console.warn('[updates] updater error:', error.message)
      if (this.userInitiated) this.push({ state: 'error', message: error.message })
    })
  }

  private push(status: UpdateStatus): void {
    this.onStatus({ ...status, portable: this.portable })
  }

  /**
   * Startup + 4-hourly background checks. No-op in dev: electron-updater
   * can't resolve the current version without a packaged build.
   */
  start(): void {
    if (!app.isPackaged) return
    void this.check(false)
    this.interval = setInterval(() => void this.check(false), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
  }

  async check(fromUser: boolean): Promise<void> {
    if (!app.isPackaged || this.checking) return
    this.checking = true
    this.userInitiated = fromUser
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // Offline or GitHub unreachable — the 'error' event already handled it.
    } finally {
      this.checking = false
    }
  }

  registerIpcHandlers(onBeforeInstall: () => void): void {
    ipcMain.handle('updates:check', () => this.check(true))
    ipcMain.handle('updates:download', async () => {
      // The portable exe has nothing to hand the downloaded installer to.
      if (this.portable || !app.isPackaged) return
      this.userInitiated = true
      try {
        await autoUpdater.downloadUpdate()
      } catch {
        // Reported via the 'error' event.
      }
    })
    ipcMain.handle('updates:install', () => {
      if (this.portable || !app.isPackaged) return
      // Let the caller flip its "really quitting" flag first, or the
      // minimize-to-tray close handler would swallow the updater's quit.
      onBeforeInstall()
      // Silent install + relaunch: without isSilent the assisted (oneClick:
      // false) NSIS installer would pop its full wizard mid-update.
      autoUpdater.quitAndInstall(true, true)
    })
  }
}
