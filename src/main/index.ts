import { app, shell, BrowserWindow, ipcMain, dialog, globalShortcut, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  getTasks,
  getItems,
  getMaps,
  getMapProjections,
  getMapFeatures,
  getMapSvg,
  getStaticMapImage,
  getQuestWikiImages,
  getCrafts,
  getAmmo,
  getHideoutStations,
  startPriceRefreshLoop,
  refreshPrices
} from './data'
import {
  loadProgress,
  setTaskCompleted,
  setTasksCompleted,
  setPlayerLevel,
  setFaction,
  setStationLevel,
  resetProgress
} from './store/progressStore'
import { loadSettings, updateSettings } from './store/settingsStore'
import { clearCheckpoints } from './store/checkpointStore'
import { LogWatcher } from './logs/logWatcher'
import { UpdateManager } from './updates'
import { captureAndOcrClipboard, terminateOcrWorker } from './ocr/questOcr'
import { CaptureManager } from './ocr/screenCapture'
import { OverlayManager } from './overlay'
import {
  clampPlayerLevel,
  clampStationLevel,
  isAllowedFetchUrl,
  isExternallyOpenable,
  isFaction,
  isValidAccelerator,
  isValidNormalizedName,
  isValidSessionNames,
  isValidTaskId,
  sanitizeSettingsPatch
} from '../shared/security'
import type { QuestEventNotice, WatcherStatus, PlayerProgress } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let watcher: LogWatcher | null = null
let captureManager: CaptureManager | null = null
let overlayManager: OverlayManager | null = null
let updateManager: UpdateManager | null = null
let tray: Tray | null = null
// Set once the user actually chooses "Quit" (tray menu or OS quit), so the
// window's 'close' handler knows to let it through instead of hiding to tray.
let isQuitting = false

// Broadcast, not mainWindow-only: the overlay window (Phase 12) subscribes to
// the same progress/watcher pushes to stay live during a raid.
function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** App icon path: bundled resources dir when packaged, project resources/ in dev. */
function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../resources/icon.png')
}

function createWindow(startHidden: boolean): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload only uses contextBridge/ipcRenderer, both of which work in a
      // sandboxed preload; everything Node-y (OCR, capture, fs) lives in main.
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!startHidden) mainWindow?.show()
  })

  // Closing the window hides it to the tray (if enabled) instead of quitting,
  // so the log watcher keeps running in the background.
  mainWindow.on('close', (event) => {
    if (!isQuitting && loadSettings().minimizeToTray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  // A really-closed main window must take the overlay with it — otherwise the
  // overlay (frameless, unclosable by the user) keeps 'window-all-closed' from
  // ever firing and the app lingers with no way to quit it.
  mainWindow.on('closed', () => {
    mainWindow = null
    overlayManager?.destroyWindow()
  })

  // Only ever hand https: links to the OS. `shell.openExternal` will happily
  // launch file:, ms-settings:, and friends, so an attacker-controlled href
  // (a wiki link, a hostile SVG) must not reach it unfiltered.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isExternallyOpenable(details.url)) void shell.openExternal(details.url)
    else console.warn('[security] blocked openExternal for non-https URL:', details.url)
    return { action: 'deny' }
  })

  // The app never navigates — it's a single loaded document driven by React.
  // Anything trying to navigate the window is therefore hostile or a bug.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) {
      event.preventDefault()
      console.warn('[security] blocked in-window navigation to:', url)
    }
  })

  // Nothing in the app needs camera/mic/geolocation/etc. (desktopCapturer runs
  // in main and isn't gated by this), so deny every renderer permission request.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow(false)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  if (tray) return
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 32, height: 32 })
  tray = new Tray(image)
  tray.setToolTip('Tarkov Companion')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Tarkov Companion', click: showMainWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showMainWindow)
}

/** Create the watcher and seed it with task data (needed to filter/name events). */
async function initWatcher(): Promise<void> {
  watcher = new LogWatcher({
    onProgress: (progress: PlayerProgress) => send('progress:updated', progress),
    onQuestEvents: (notices: QuestEventNotice[]) => send('log:questEvents', notices),
    onStatus: (status: WatcherStatus) => send('watcher:status', status)
  })

  // Seeds the task catalog, retrying internally if the fetch fails (offline, no
  // cache) so live quest events aren't dropped silently until an app restart.
  await watcher.seedTasks(() => getTasks(loadSettings().profile))

  if (loadSettings().autoWatch) {
    watcher.start()
  }
}

/**
 * Registers (or unregisters) the app as a Windows login item. Only meaningful
 * once packaged — in dev, `process.execPath` is the Electron binary itself, so
 * the setting is still saved but not actually applied to the OS.
 */
function applyLaunchAtStartup(enabled: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? ['--hidden'] : [] })
}

function registerIpcHandlers(): void {
  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('data:getTasks', () => getTasks(loadSettings().profile))
  ipcMain.handle('data:getItems', () => getItems(loadSettings().profile))
  ipcMain.handle('data:getMaps', () => getMaps())
  ipcMain.handle('data:getMapProjections', () => getMapProjections())
  ipcMain.handle('data:getMapFeatures', () => getMapFeatures())
  // The URL is checked here as well as in the fetchers: `getOrRefresh` serves a
  // cache hit without ever calling the fetcher, so a check that only lives down
  // there silently doesn't run for cached maps. Rejecting at the boundary makes
  // the guarantee independent of cache state.
  ipcMain.handle('data:getMapSvg', (_e, normalizedName: unknown, svgPath: unknown) => {
    if (!isValidNormalizedName(normalizedName) || !isAllowedFetchUrl(svgPath)) {
      throw new Error('getMapSvg: invalid arguments')
    }
    return getMapSvg(normalizedName, svgPath)
  })
  ipcMain.handle('data:getStaticMapImage', (_e, normalizedName: unknown, url: unknown) => {
    if (!isValidNormalizedName(normalizedName) || !isAllowedFetchUrl(url)) {
      throw new Error('getStaticMapImage: invalid arguments')
    }
    return getStaticMapImage(normalizedName, url)
  })
  ipcMain.handle('data:getQuestWikiImages', (_e, taskId: unknown) => {
    if (!isValidTaskId(taskId)) throw new Error('getQuestWikiImages: invalid task id')
    return getQuestWikiImages(taskId, loadSettings().profile)
  })
  ipcMain.handle('data:getCrafts', () => getCrafts(loadSettings().profile))
  ipcMain.handle('data:getAmmo', () => getAmmo())
  ipcMain.handle('data:getHideoutStations', () => getHideoutStations())
  ipcMain.handle('data:refreshPricesNow', () =>
    refreshPrices(loadSettings().profile, {
      onItems: (items) => send('data:pricesUpdated', items),
      onCrafts: (crafts) => send('data:craftsUpdated', crafts)
    })
  )

  ipcMain.handle('progress:get', () => loadProgress())
  ipcMain.handle('progress:setTaskCompleted', (_e, taskId: unknown, completed: unknown) => {
    if (!isValidTaskId(taskId) || typeof completed !== 'boolean') {
      throw new Error('setTaskCompleted: invalid arguments')
    }
    return setTaskCompleted(taskId, completed)
  })
  ipcMain.handle('progress:setTasksCompleted', (_e, taskIds: unknown) => {
    if (!Array.isArray(taskIds) || !taskIds.every(isValidTaskId)) {
      throw new Error('setTasksCompleted: invalid task ids')
    }
    return setTasksCompleted(taskIds)
  })
  ipcMain.handle('progress:setPlayerLevel', (_e, level: unknown) =>
    setPlayerLevel(clampPlayerLevel(level))
  )
  ipcMain.handle('progress:setFaction', (_e, faction: unknown) => {
    if (!isFaction(faction)) throw new Error('setFaction: invalid faction')
    return setFaction(faction)
  })
  ipcMain.handle('progress:setStationLevel', (_e, stationNorm: unknown, level: unknown) => {
    // Station keys share the normalized-name grammar used for cache keys.
    if (!isValidNormalizedName(stationNorm)) {
      throw new Error('setStationLevel: invalid station name')
    }
    return setStationLevel(stationNorm, clampStationLevel(level))
  })
  ipcMain.handle('progress:reset', () => {
    // A wipe also clears log checkpoints and import history so past logs can be
    // re-read cleanly against the fresh profile.
    const progress = resetProgress()
    clearCheckpoints()
    updateSettings({ importedSessions: [] })
    // Honor the autoWatch preference: a wipe reset shouldn't force the watcher on
    // if the user has automatic watching turned off. Restart (not just start) so
    // a running watcher re-reads from the freshly cleared checkpoints.
    if (loadSettings().autoWatch) watcher?.start()
    else watcher?.stop()
    return progress
  })

  // ── Phase 2: settings + log watcher ──
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:update', (_e, rawPatch: unknown) => {
    // Only known settings keys with well-shaped values get written — these feed
    // globalShortcut.register, the login-item API, and the log watcher's paths.
    const { patch, rejected } = sanitizeSettingsPatch(rawPatch)
    if (rejected.length > 0) {
      console.warn('[security] settings:update ignored invalid keys:', rejected.join(', '))
    }
    const updated = updateSettings(patch)
    // Install path or profile change → re-resolve and restart the tail.
    if ('installPath' in patch || 'profile' in patch || 'autoWatch' in patch) {
      if (updated.autoWatch) watcher?.start()
      else watcher?.stop()
    }
    // Profile change → PvE and PvP have separate flea/craft economies, so
    // re-fetch prices for the new mode and push them to the renderer.
    if ('profile' in patch) {
      void refreshPrices(updated.profile, {
        onItems: (items) => send('data:pricesUpdated', items),
        onCrafts: (crafts) => send('data:craftsUpdated', crafts)
      })
      // The *task catalog* is also mode-scoped (PvE 506 vs PvP 510 tasks), so
      // re-seed the watcher — otherwise it keeps matching live log events
      // against the previous mode's task ids. The renderer still holds the old
      // list until reload; see the note in PLAN.md Phase 13.
      void watcher?.seedTasks(() => getTasks(updated.profile))
    }
    // Hotkey changed while capture is armed → re-register on the new key.
    if ('captureHotkey' in patch && captureManager?.isArmed()) {
      const ok = captureManager.arm(updated.captureHotkey)
      if (!ok) send('catchup:captureError', `Couldn’t register hotkey “${updated.captureHotkey}”.`)
    }
    // The overlay hotkey is registered for the app's lifetime — rebind on
    // change; registration state reaches the UI via the overlay:status push.
    if ('overlayHotkey' in patch) {
      overlayManager?.registerHotkey(updated.overlayHotkey)
    }
    if ('launchAtStartup' in patch) applyLaunchAtStartup(updated.launchAtStartup)
    return updated
  })

  ipcMain.handle('watcher:getStatus', () => watcher?.getStatus() ?? null)
  ipcMain.handle('watcher:start', () => {
    watcher?.start()
    return watcher?.getStatus() ?? null
  })
  ipcMain.handle('watcher:stop', () => {
    watcher?.stop()
    return watcher?.getStatus() ?? null
  })

  ipcMain.handle('watcher:pickInstallFolder', async () => {
    if (!mainWindow) return watcher?.getStatus() ?? null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select your Escape From Tarkov install folder (the one containing "Logs")',
      properties: ['openDirectory']
    })
    if (!result.canceled && result.filePaths[0]) {
      updateSettings({ installPath: result.filePaths[0] })
      watcher?.start()
    }
    return watcher?.getStatus() ?? null
  })

  ipcMain.handle('logs:listSessions', () => watcher?.listSessions() ?? [])
  ipcMain.handle('logs:import', (_e, sessionNames: unknown) => {
    if (!isValidSessionNames(sessionNames)) throw new Error('logs:import: invalid session names')
    return (
      watcher?.importHistorical(sessionNames) ?? {
        sessionsScanned: 0,
        eventsApplied: 0,
        tasksCompleted: 0,
        tasksFailed: 0
      }
    )
  })

  // ── Quest Catchup: OCR-driven bulk progress inference ──
  ipcMain.handle('ocr:captureClipboard', () => captureAndOcrClipboard())

  // Native hotkey capture: arm registers the configured global shortcut; each
  // press pushes a fresh OCR'd capture (or an error) to the renderer.
  ipcMain.handle('catchup:armCapture', () => {
    // settings:update validates this on the way in, but settings.json is a plain
    // file on disk — a hand-edited one shouldn't reach globalShortcut.register,
    // which throws on a malformed accelerator rather than returning false.
    const hotkey = loadSettings().captureHotkey
    if (!isValidAccelerator(hotkey)) return { ok: false, hotkey }
    const ok = captureManager?.arm(hotkey) ?? false
    return { ok, hotkey }
  })
  ipcMain.handle('catchup:disarmCapture', () => {
    captureManager?.disarm()
    return null
  })

  // ── Phase 12: in-game overlay ──
  ipcMain.handle('overlay:toggle', () => overlayManager?.toggle() ?? null)
  ipcMain.handle('overlay:getStatus', () => overlayManager?.getStatus() ?? null)
}

app.whenReady().then(async () => {
  captureManager = new CaptureManager({
    onCapture: (capture) => send('catchup:capture', capture),
    onError: (message) => send('catchup:captureError', message)
  })
  updateManager = new UpdateManager((status) => send('updates:status', status))
  // isQuitting must be set before quitAndInstall, or the minimize-to-tray
  // close handler would cancel the updater's window close and strand it.
  updateManager.registerIpcHandlers(() => {
    isQuitting = true
  })
  overlayManager = new OverlayManager((status) => send('overlay:status', status))
  {
    // Bind the overlay toggle hotkey for the app's lifetime. Same rationale as
    // catchup:armCapture for validating first: settings.json is a plain file on
    // disk, and globalShortcut.register throws on a malformed accelerator.
    const { overlayHotkey } = loadSettings()
    if (isValidAccelerator(overlayHotkey)) overlayManager.registerHotkey(overlayHotkey)
  }
  registerIpcHandlers()
  // Started via the Windows startup entry (see applyLaunchAtStartup) → open hidden to the tray.
  createWindow(process.argv.includes('--hidden'))
  createTray()
  await initWatcher()

  startPriceRefreshLoop({
    getProfile: () => loadSettings().profile,
    onItems: (items) => send('data:pricesUpdated', items),
    onCrafts: (crafts) => send('data:craftsUpdated', crafts)
  })

  // Startup + 4-hourly update checks (no-op in dev; never downloads on its own).
  updateManager.start()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(false)
    else showMainWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  watcher?.stop()
  captureManager?.disarm()
  terminateOcrWorker()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Belt-and-suspenders: never leave a global shortcut registered after exit.
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
