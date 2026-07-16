import { BrowserWindow, globalShortcut, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { isExternallyOpenable } from '../shared/security'
import type { OverlayStatus } from '../shared/types'

const OVERLAY_WIDTH = 380
const OVERLAY_MARGIN = 16

/**
 * Phase 12 — the in-game overlay: a frameless, transparent, always-on-top,
 * fully click-through window showing the current raid's active objectives.
 * Toggled by a global hotkey so it works while the game has focus (which, like
 * screen capture, requires Tarkov to run in borderless windowed mode —
 * exclusive fullscreen draws over every other window).
 *
 * The window is read-only by design: `setIgnoreMouseEvents` makes every pixel
 * click-through and `focusable: false` keeps it from ever stealing focus from
 * the game, so the toggle hotkey is the only interaction it has.
 */
export class OverlayManager {
  private window: BrowserWindow | null = null
  private hotkey: string | null = null
  private hotkeyRegistered = false
  private readonly onStatus: (status: OverlayStatus) => void

  constructor(onStatus: (status: OverlayStatus) => void) {
    this.onStatus = onStatus
  }

  getStatus(): OverlayStatus {
    return {
      visible: this.window !== null && this.window.isVisible(),
      hotkey: this.hotkey ?? '',
      hotkeyRegistered: this.hotkeyRegistered
    }
  }

  private pushStatus(): void {
    this.onStatus(this.getStatus())
  }

  /**
   * (Re)binds the toggle hotkey. Returns false when the OS refuses the
   * accelerator (typically another app — or our own capture hotkey — owns it).
   * The caller validates the accelerator shape; `globalShortcut.register`
   * throws on malformed input rather than returning false.
   */
  registerHotkey(accelerator: string): boolean {
    if (this.hotkey && this.hotkeyRegistered) globalShortcut.unregister(this.hotkey)
    this.hotkey = accelerator
    this.hotkeyRegistered = globalShortcut.register(accelerator, () => this.toggle())
    this.pushStatus()
    return this.hotkeyRegistered
  }

  toggle(): OverlayStatus {
    if (this.window && this.window.isVisible()) {
      this.window.hide()
    } else {
      if (!this.window) this.createWindow()
      // showInactive: never move focus off the game.
      this.window?.showInactive()
    }
    const status = this.getStatus()
    this.pushStatus()
    return status
  }

  /** Closes the overlay window (e.g. when the main window really closes). */
  destroyWindow(): void {
    if (this.window) {
      this.window.destroy()
      this.window = null
    }
  }

  private createWindow(): void {
    const workArea = screen.getPrimaryDisplay().workArea
    const height = Math.min(640, workArea.height - OVERLAY_MARGIN * 2)

    const win = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height,
      x: workArea.x + workArea.width - OVERLAY_WIDTH - OVERLAY_MARGIN,
      y: workArea.y + OVERLAY_MARGIN,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      webPreferences: {
        // Same posture as the main window: sandboxed preload, no Node in the
        // renderer. The overlay loads the same bundle behind a #overlay hash.
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true
      }
    })

    // 'screen-saver' level sits above a borderless-windowed game.
    win.setAlwaysOnTop(true, 'screen-saver')
    // Fully click-through — the overlay is read-only, so no region ever needs
    // the mouse. `forward: true` keeps hover events flowing to the page anyway.
    win.setIgnoreMouseEvents(true, { forward: true })

    // Same window-open / navigation / permission guards as the main window.
    win.webContents.setWindowOpenHandler((details) => {
      if (isExternallyOpenable(details.url)) void shell.openExternal(details.url)
      else console.warn('[security] blocked openExternal for non-https URL:', details.url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== win.webContents.getURL()) {
        event.preventDefault()
        console.warn('[security] blocked overlay navigation to:', url)
      }
    })
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })

    win.on('closed', () => {
      this.window = null
      this.pushStatus()
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#overlay`)
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
    }

    this.window = win
  }
}
