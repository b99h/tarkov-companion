import { app, clipboard, nativeImage } from 'electron'
import type { NativeImage } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createWorker } from 'tesseract.js'
import type { Worker, Page } from 'tesseract.js'
import type { ScreenshotCapture } from '../../shared/types'
import {
  extractTaskColumnLines,
  findTaskColumn,
  linesWithinColumn,
  groupWordsIntoLines
} from '../../shared/ocrLayout'
import type { OcrWord, ColumnBounds } from '../../shared/ocrLayout'

/**
 * Tarkov's task list is thin, light text over a busy 3D scene — Tesseract
 * mangles it on the raw frame (it even misreads the "Task" header, killing
 * column detection). We preprocess before OCR: pixels brighter than a
 * luminance cutoff are treated as text and painted black on a white
 * background (Tesseract's preferred polarity), which both sharpens the text
 * and washes the dark background scene away. Then upscale so glyphs clear
 * Tesseract's ~20px comfort zone.
 */
const OCR_LUMA_THRESHOLD = 150
const OCR_UPSCALE: number = 2
/**
 * Fraction of the frame height to drop off the bottom before OCR. The game's
 * bottom nav bar (MAIN MENU / HIDEOUT / … / EXPANSIONS) is overlaid on top of
 * the task list at the very bottom, so its words fall inside the Task column
 * and leak in as a junk row. It sits over the list rather than below it, so
 * trimming this sliver removes the nav bar without losing any quest row.
 */
const OCR_BOTTOM_CROP = 0.05

function preprocessForOcr(png: Buffer): NativeImage {
  const src = nativeImage.createFromBuffer(png)
  const { width, height } = src.getSize()
  const bmp = src.toBitmap() // BGRA, 4 bytes/pixel
  const out = Buffer.alloc(bmp.length)
  for (let i = 0; i < bmp.length; i += 4) {
    const luma = 0.299 * bmp[i + 2] + 0.587 * bmp[i + 1] + 0.114 * bmp[i]
    const v = luma >= OCR_LUMA_THRESHOLD ? 0 : 255 // bright text → black; scene → white
    out[i] = v
    out[i + 1] = v
    out[i + 2] = v
    out[i + 3] = 255
  }
  const binarized = nativeImage.createFromBitmap(out, { width, height })
  const scaled =
    OCR_UPSCALE === 1
      ? binarized
      : binarized.resize({
          width: width * OCR_UPSCALE,
          height: height * OCR_UPSCALE,
          quality: 'best'
        })

  // Trim the overlaid bottom nav bar off every frame.
  const { width: sw, height: sh } = scaled.getSize()
  const keepHeight = Math.max(1, Math.round(sh * (1 - OCR_BOTTOM_CROP)))
  return keepHeight < sh ? scaled.crop({ x: 0, y: 0, width: sw, height: keepHeight }) : scaled
}

/** Dev-only: dump raw + processed frames and OCR output so preprocessing can be tuned. */
function dumpOcrDebug(raw: Buffer, processed: Buffer, fullText: string, lines: string[], tag: string): void {
  if (app.isPackaged) return
  try {
    const dir = join(app.getPath('userData'), 'catchup-debug')
    mkdirSync(dir, { recursive: true })
    const ts = Date.now()
    writeFileSync(join(dir, `${ts}-${tag}-raw.png`), raw)
    writeFileSync(join(dir, `${ts}-${tag}-processed.png`), processed)
    writeFileSync(
      join(dir, `${ts}-${tag}-ocr.txt`),
      `=== FULL TEXT ===\n${fullText}\n\n=== EXTRACTED LINES ===\n${lines.join('\n')}\n`
    )
    console.log(`[catchup] OCR debug (${tag}) dumped to ${dir}`)
  } catch (err) {
    console.error('[catchup] OCR debug dump failed:', err)
  }
}

let workerPromise: Promise<Worker> | null = null

/**
 * Directory holding the bundled `eng.traineddata`: the resources dir when
 * packaged (electron-builder's extraResources), the project's own resources/
 * in dev. Mirrors how the app icon is resolved in main.
 */
function trainedDataPath(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
}

/**
 * Phase 7.1: point Tesseract at the bundled traineddata instead of letting it
 * reach out to the jsdelivr CDN on first OCR. `langPath` as a local directory
 * makes it read the file straight off disk (no network), and `cacheMethod:
 * 'none'` stops it both reading and writing its own copy — which is what used
 * to drop a 5 MB `eng.traineddata` into the process's working directory (next
 * to the portable exe, for a portable user). `gzip: false` because the bundled
 * file is the uncompressed one.
 */
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng', undefined, {
      langPath: trainedDataPath(),
      cacheMethod: 'none',
      gzip: false
    })
  }
  return workerPromise
}

export async function terminateOcrWorker(): Promise<void> {
  if (!workerPromise) return
  const worker = await workerPromise
  workerPromise = null
  await worker.terminate()
}

/** Flatten Tesseract's block→paragraph→line→word tree into flat word boxes. */
function flattenWords(page: Page): OcrWord[] {
  const words: OcrWord[] = []
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          words.push({
            text: word.text,
            x0: word.bbox.x0,
            y0: word.bbox.y0,
            x1: word.bbox.x1,
            y1: word.bbox.y1
          })
        }
      }
    }
  }
  return words
}

/** Naive fallback: split the full recognized text into non-empty trimmed lines. */
function fallbackLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function makeCapture(png: Buffer, lines: string[]): ScreenshotCapture {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    lines
  }
}

/**
 * OCRs a native-capture screenshot for Quest Catchup, reusing a previously
 * located Task-column when one is supplied.
 *
 * Because hotkey capture produces pixel-identical frames (same game UI, only
 * the scrolled list differs), we find the column once on the first frame and
 * then, on every later frame, **crop to that column strip before OCR** — a
 * clean narrow strip is both faster and markedly more accurate for Tesseract
 * than a busy full frame. Returns the capture plus the column bounds so the
 * caller can cache them for the rest of the session; `bounds` is null when no
 * "Task" header could be located (matching the clipboard path's fallback to
 * full-text lines).
 */
export async function recognizeTaskCapture(
  png: Buffer,
  cachedBounds: ColumnBounds | null
): Promise<{ capture: ScreenshotCapture; bounds: ColumnBounds | null }> {
  const worker = await getWorker()

  // Detection, cropping and OCR all happen in the *processed* image's
  // coordinate space (binarized + upscaled), so cached column bounds line up
  // frame-to-frame. The thumbnail shown to the user stays the raw frame.
  const processed = preprocessForOcr(png)
  const processedPng = processed.toPNG()

  if (cachedBounds) {
    // Reuse the known column: crop the strip below the header and OCR just that.
    const { width, height } = processed.getSize()
    const cropX = Math.max(0, Math.min(width - 1, Math.floor(cachedBounds.left)))
    const cropRight = Math.max(cropX + 1, Math.min(width, Math.ceil(cachedBounds.right)))
    const cropY = Math.max(0, Math.min(height - 1, Math.floor(cachedBounds.headerBottom)))
    const strip = processed.crop({
      x: cropX,
      y: cropY,
      width: cropRight - cropX,
      height: height - cropY
    })
    const { data } = await worker.recognize(strip.toPNG(), {}, { blocks: true, text: true })
    const words = flattenWords(data)
    // The strip is already a single column with the header cropped away, so
    // words just need grouping into rows — no column detection to redo.
    const lines = words.length > 0 ? groupWordsIntoLines(words) : fallbackLines(data.text)
    dumpOcrDebug(png, processedPng, data.text, lines, 'cached')
    return { capture: makeCapture(png, lines), bounds: cachedBounds }
  }

  const { data } = await worker.recognize(processedPng, {}, { blocks: true, text: true })
  const words = flattenWords(data)
  const bounds = findTaskColumn(words)
  const lines = bounds ? linesWithinColumn(words, bounds) : fallbackLines(data.text)
  dumpOcrDebug(png, processedPng, data.text, lines, bounds ? 'column' : 'fallback')
  return { capture: makeCapture(png, lines), bounds }
}

/**
 * Reads whatever image is on the OS clipboard (e.g. a Snipping Tool
 * screenshot of the task screen) and OCRs it, returning only the quest-name
 * column when it can locate it — so a busy multi-column screen doesn't feed
 * nav bars and other columns into matching. Returns null when the clipboard
 * has no image.
 */
export async function captureAndOcrClipboard(): Promise<ScreenshotCapture | null> {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null

  const png = image.toPNG()
  const worker = await getWorker()
  const { data } = await worker.recognize(png, {}, { blocks: true, text: true })

  const columnLines = extractTaskColumnLines(flattenWords(data))
  const lines = columnLines ?? fallbackLines(data.text)

  return makeCapture(png, lines)
}
