/**
 * Layout-aware filtering of raw OCR words down to just the quest-name column
 * of a Tarkov task screen (native game UI or a third-party tracker).
 *
 * Full-image OCR reads everything — the top nav bar, the trader-icon column,
 * and the Location/Status/Progress columns — so a single row comes out as
 * "Sew it Good - Part 4 Any location active! 58%". This module finds the
 * "Task" column by its header word's bounding box, bounds it with the
 * neighboring "Type"/"Location" headers, and keeps only the words that sit
 * inside that column and below the header row, reconstructing one clean line
 * of text per quest row.
 *
 * Pure and unit-testable: it operates on plain word boxes, not on the OCR
 * engine's own types.
 */

export interface OcrWord {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The column headers a Tarkov task table shows, used to locate the Task column. */
const HEADER_LABELS = ['trader', 'type', 'task', 'location', 'status', 'progress']

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const dp: number[][] = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)])
  for (let j = 0; j < cols; j++) dp[0][j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[rows - 1][cols - 1]
}

/** Whether an OCR word reads as the given header label, tolerating a 1-char OCR slip. */
function matchesLabel(word: string, label: string): boolean {
  const norm = normalize(word)
  if (norm === label) return true
  if (label.length < 4) return false
  return levenshtein(norm, label) <= 1
}

function isAnyHeaderLabel(word: string): boolean {
  return HEADER_LABELS.some((label) => matchesLabel(word, label))
}

function verticalOverlap(a: OcrWord, b: OcrWord): boolean {
  return a.y0 <= b.y1 && b.y0 <= a.y1
}

function centerX(w: OcrWord): number {
  return (w.x0 + w.x1) / 2
}

function centerY(w: OcrWord): number {
  return (w.y0 + w.y1) / 2
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export interface ColumnBounds {
  left: number
  right: number
  headerBottom: number
}

/** Locate the Task column's horizontal bounds and header baseline, or null. */
export function findTaskColumn(words: OcrWord[]): ColumnBounds | null {
  // Every word that reads as "task", topmost first — the header sits above
  // the list, so the topmost valid one is almost always the real header.
  const taskCandidates = words
    .filter((w) => matchesLabel(w.text, 'task'))
    .sort((a, b) => a.y0 - b.y0)

  for (const task of taskCandidates) {
    // The other header cells on the same visual row as this "Task".
    const rowHeaders = words.filter(
      (w) => w !== task && verticalOverlap(w, task) && isAnyHeaderLabel(w.text)
    )
    if (rowHeaders.length === 0) continue // A body quest containing "task", not the header.

    const taskWidth = task.x1 - task.x0
    const leftNeighbor = rowHeaders
      .filter((w) => w.x1 <= task.x0)
      .sort((a, b) => b.x1 - a.x1)[0]
    const rightNeighbor = rowHeaders
      .filter((w) => w.x0 >= task.x1)
      .sort((a, b) => a.x0 - b.x0)[0]

    // Left/right bounds use *different* anchors because the Task column's
    // content is left-aligned within a much wider column:
    //  - LEFT: the quest names hug the left of the column, right after the Type
    //    column, so bound on Type's inner (right) edge. The Type body icon sits
    //    centred under its label, i.e. left of this edge, so it's excluded.
    //  - RIGHT: names are short and left-aligned, leaving a wide empty gap
    //    before the Location column — and the Location cell text ("Any
    //    location") actually starts *left* of the centred "Location" label. So
    //    bounding on the label's left edge leaks the Location column's first
    //    word. Use the midpoint between the Task and Location label centres,
    //    which sits in that empty gap: right of every name, left of every
    //    Location cell.
    const left = leftNeighbor ? leftNeighbor.x1 : Math.max(0, task.x0 - taskWidth)
    const right = rightNeighbor
      ? (centerX(task) + centerX(rightNeighbor)) / 2
      : task.x1 + taskWidth * 4

    const headerBottom = Math.max(task.y1, ...rowHeaders.map((w) => w.y1))
    return { left, right, headerBottom }
  }

  return null
}

/**
 * Reconstruct one text line per quest row from the words that fall inside the
 * Task column and below its header. Returns null when no "Task" header is
 * found, so callers can fall back to naive full-text line splitting.
 */
export function extractTaskColumnLines(words: OcrWord[]): string[] | null {
  const column = findTaskColumn(words)
  if (!column) return null
  return linesWithinColumn(words, column)
}

/**
 * Reconstruct quest-row lines from words already known to belong to the Task
 * column, using the column's own bounds to drop the header and neighbouring
 * columns. Used by the clipboard path (via `extractTaskColumnLines`) and by the
 * native-capture path, which locates the column once then reuses its bounds
 * across every frame of the session.
 */
export function linesWithinColumn(words: OcrWord[], column: ColumnBounds): string[] {
  const contentWords = words.filter(
    (w) => w.y0 > column.headerBottom && centerX(w) >= column.left && centerX(w) <= column.right
  )
  return groupWordsIntoLines(contentWords)
}

/**
 * Group already-filtered words into one entry per quest, by vertical proximity.
 * Words are expected to be pre-narrowed to a single column (e.g. a cropped
 * column strip, where no horizontal filtering is needed).
 *
 * Two passes: first group words into visual text rows, then merge consecutive
 * rows that sit within ~one line-height of each other — a long quest name wraps
 * onto a second line in the game UI ("The Huntsman Path -" / "Administrator"),
 * but it's still one task. Different tasks are separated by a much larger gap
 * (the task rows are tall), so the merge threshold sits comfortably between the
 * wrapped-line spacing and the inter-task spacing.
 */
export function groupWordsIntoLines(words: OcrWord[]): string[] {
  if (words.length === 0) return []

  const medianHeight = median(words.map((w) => w.y1 - w.y0)) || 1
  const rowTolerance = medianHeight * 0.6
  const sorted = [...words].sort((a, b) => a.y0 - b.y0)

  // Pass 1: group words into visual text rows by vertical proximity.
  const rows: OcrWord[][] = []
  let currentCenter = Number.NEGATIVE_INFINITY
  for (const word of sorted) {
    if (rows.length === 0 || Math.abs(centerY(word) - currentCenter) > rowTolerance) {
      rows.push([word])
      currentCenter = centerY(word)
    } else {
      rows[rows.length - 1].push(word)
    }
  }

  const rowRecords = rows
    .map((row) => ({
      center: row.reduce((sum, w) => sum + centerY(w), 0) / row.length,
      text: row
        .sort((a, b) => a.x0 - b.x0)
        .map((w) => w.text.trim())
        .filter((t) => t.length > 0)
        .join(' ')
        .trim()
    }))
    .filter((r) => r.text.length > 0)

  // Pass 2: merge wrapped rows (within one line-height) into a single quest.
  const mergeGap = medianHeight * 1.8
  const lines: string[] = []
  let prevCenter = Number.NEGATIVE_INFINITY
  for (const rec of rowRecords) {
    if (lines.length > 0 && rec.center - prevCenter <= mergeGap) {
      lines[lines.length - 1] += ' ' + rec.text
    } else {
      lines.push(rec.text)
    }
    prevCenter = rec.center
  }
  return lines
}
