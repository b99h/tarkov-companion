import { desktopCapturer, globalShortcut, screen } from 'electron'
import type { NativeImage } from 'electron'
import type { ScreenshotCapture } from '../../shared/types'
import type { ColumnBounds } from '../../shared/ocrLayout'
import { recognizeTaskCapture } from './questOcr'

/**
 * Native screenshot capture for Quest Catchup. Instead of the user hand-snipping
 * screenshots (which vary in crop/scale and wreck OCR), the app grabs the whole
 * primary display itself via a global hotkey — every frame is pixel-identical,
 * so the Task-column can be located once and reused, and OCR runs on a clean,
 * consistent image.
 *
 * Caveat baked into the flow: `desktopCapturer` needs the game in borderless
 * windowed mode. Exclusive fullscreen can hand back an all-black frame, which we
 * detect and surface rather than feeding to OCR.
 */

/** Fraction of sampled pixels that must be near-black to call a frame "black". */
const BLACK_PIXEL_RATIO = 0.995
/** Per-channel value at/below which a pixel counts as black. */
const BLACK_CHANNEL_MAX = 8

/** Heuristic: is this frame almost entirely black (exclusive-fullscreen capture)? */
function isMostlyBlack(image: NativeImage): boolean {
  const bitmap = image.toBitmap() // BGRA, 4 bytes/pixel
  if (bitmap.length < 4) return true
  const pixelCount = bitmap.length / 4
  // Sample up to ~2000 pixels evenly rather than scanning a 4K frame.
  const step = Math.max(1, Math.floor(pixelCount / 2000))
  let sampled = 0
  let dark = 0
  for (let p = 0; p < pixelCount; p += step) {
    const i = p * 4
    sampled++
    if (
      bitmap[i] <= BLACK_CHANNEL_MAX &&
      bitmap[i + 1] <= BLACK_CHANNEL_MAX &&
      bitmap[i + 2] <= BLACK_CHANNEL_MAX
    ) {
      dark++
    }
  }
  return sampled > 0 && dark / sampled >= BLACK_PIXEL_RATIO
}

/** Grab the primary display at native resolution as a PNG buffer. */
async function capturePrimaryDisplay(): Promise<NativeImage> {
  const primary = screen.getPrimaryDisplay()
  const { width, height } = primary.size
  const scale = primary.scaleFactor || 1
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
  })
  if (sources.length === 0) throw new Error('No screen sources available to capture.')
  const source =
    sources.find((s) => s.display_id === String(primary.id)) ?? sources[0]
  return source.thumbnail
}

interface CaptureManagerCallbacks {
  onCapture: (capture: ScreenshotCapture) => void
  onError: (message: string) => void
}

/**
 * Owns the armed/disarmed state of the capture hotkey and the per-session Task-
 * column bounds. Arming registers the global shortcut; each press captures,
 * OCRs (reusing the column once found), and pushes the result to the renderer.
 */
export class CaptureManager {
  private hotkey: string | null = null
  private columnBounds: ColumnBounds | null = null
  private busy = false

  constructor(private readonly callbacks: CaptureManagerCallbacks) {}

  isArmed(): boolean {
    return this.hotkey !== null
  }

  /**
   * Register the hotkey and start a fresh capture session (column bounds are
   * re-detected on the next first frame). Returns false if the OS refused the
   * accelerator (e.g. another app owns it).
   */
  arm(hotkey: string): boolean {
    this.disarm()
    this.columnBounds = null
    let registered = false
    try {
      registered = globalShortcut.register(hotkey, () => {
        void this.trigger()
      })
    } catch {
      registered = false
    }
    if (registered) this.hotkey = hotkey
    return registered
  }

  disarm(): void {
    if (this.hotkey) {
      globalShortcut.unregister(this.hotkey)
      this.hotkey = null
    }
  }

  private async trigger(): Promise<void> {
    // Ignore re-fires while a capture+OCR is still in flight.
    if (this.busy) return
    this.busy = true
    try {
      const image = await capturePrimaryDisplay()
      if (isMostlyBlack(image)) {
        this.callbacks.onError(
          'Captured a black frame. Switch Tarkov to borderless windowed mode — exclusive fullscreen can’t be captured.'
        )
        return
      }
      const png = image.toPNG()
      const { capture, bounds } = await recognizeTaskCapture(png, this.columnBounds)
      // Cache the column the first time it's found, for the rest of the session.
      if (bounds && !this.columnBounds) this.columnBounds = bounds
      this.callbacks.onCapture(capture)
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err.message : String(err))
    } finally {
      this.busy = false
    }
  }
}
