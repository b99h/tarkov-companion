import { describe, it, expect } from 'vitest'
import {
  extractTaskColumnLines,
  findTaskColumn,
  linesWithinColumn,
  groupWordsIntoLines
} from './ocrLayout'
import type { OcrWord } from './ocrLayout'

function w(text: string, x0: number, y0: number, x1: number, y1: number): OcrWord {
  return { text, x0, y0, x1, y1 }
}

// A miniature Tarkov task screen laid out in pixel space:
//   - a top nav bar row (above the header) whose words sit inside the Task
//     column's x-range, so they'd leak in if we didn't exclude by header baseline
//   - the column header row: Trader | Type | Task | Location | Status | Progress
//   - two body rows, each with the quest name in the Task column plus
//     Location/Status/Progress text off to the right
//
// Task column x-bounds: left = type.x1 = 90 (names hug the Type column's right
// edge), right = midpoint of the Task & Location label centres = (160+550)/2 =
// 355 (well right of the left-aligned names, left of the Location cell).
function screen(): OcrWord[] {
  return [
    // Nav bar (y 0-10) — "OVERALL" sits at x 140-210, i.e. inside the Task column.
    w('OVERALL', 140, 0, 210, 10),
    w('TASKS', 400, 0, 460, 10),

    // Header row (y 30-42).
    w('Trader', 0, 30, 30, 42),
    w('Type', 60, 30, 90, 42),
    w('Task', 140, 30, 180, 42),
    w('Location', 520, 30, 580, 42),
    w('Status', 640, 30, 690, 42),
    w('Progress', 760, 30, 830, 42),

    // Body row 1 (y 60-75).
    w('Friend', 140, 60, 200, 75),
    w('Among', 205, 60, 260, 75),
    w('Strangers', 265, 60, 340, 75),
    w('Any', 520, 60, 550, 75),
    w('location', 555, 60, 600, 75),
    w('active!', 640, 60, 690, 75),
    w('0%', 780, 60, 810, 75),

    // Body row 2 (y 100-115).
    w('Swift', 150, 100, 200, 115),
    w('One', 210, 100, 250, 115),
    w('Woods', 520, 100, 570, 115),
    w('active!', 640, 100, 690, 115),
    w('0%', 780, 100, 810, 115)
  ]
}

describe('extractTaskColumnLines', () => {
  it('keeps only the Task column, dropping other columns, the nav bar and the header', () => {
    const lines = extractTaskColumnLines(screen())
    expect(lines).toEqual(['Friend Among Strangers', 'Swift One'])
  })

  it('excludes a nav-bar word even when it overlaps the Task column horizontally', () => {
    const lines = extractTaskColumnLines(screen())
    expect(lines?.some((l) => l.includes('OVERALL'))).toBe(false)
  })

  it('tolerates a 1-character OCR slip in the "Task" header', () => {
    const words = screen().map((word) =>
      word.text === 'Task' ? { ...word, text: 'Tesk' } : word
    )
    const lines = extractTaskColumnLines(words)
    expect(lines).toEqual(['Friend Among Strangers', 'Swift One'])
  })

  it('returns null when there is no Task header to anchor on', () => {
    const words = screen().filter((word) => word.text !== 'Task')
    expect(extractTaskColumnLines(words)).toBeNull()
  })

  it('exposes column bounds that can be reused to re-extract another frame', () => {
    // The native-capture path finds the column once, then reuses those bounds
    // on later frames (same UI, different scrolled rows). Simulate frame 2.
    const bounds = findTaskColumn(screen())
    expect(bounds).not.toBeNull()

    const frame2: OcrWord[] = [
      // Same header row still visible on the next screenful.
      w('Trader', 0, 30, 30, 42),
      w('Type', 60, 30, 90, 42),
      w('Task', 140, 30, 180, 42),
      w('Location', 520, 30, 580, 42),
      // A different quest scrolled into view, with off-column noise.
      w('Gunsmith', 150, 60, 230, 75),
      w('Woods', 520, 60, 570, 75),
      w('active!', 640, 60, 690, 75)
    ]
    expect(linesWithinColumn(frame2, bounds!)).toEqual(['Gunsmith'])
  })
})

describe('groupWordsIntoLines', () => {
  it('joins words on the same row and splits distinct rows, ignoring x-column', () => {
    // Words already narrowed to a cropped column strip: no header, no other
    // columns — just group by vertical proximity.
    const words: OcrWord[] = [
      w('The', 10, 10, 40, 24),
      w('Punisher', 45, 10, 120, 24),
      w('Setup', 12, 40, 70, 54)
    ]
    expect(groupWordsIntoLines(words)).toEqual(['The Punisher', 'Setup'])
  })

  it('returns an empty array for no words', () => {
    expect(groupWordsIntoLines([])).toEqual([])
  })

  it('merges a wrapped quest name (two close rows) into one entry', () => {
    // "The Huntsman Path -" wraps onto "Administrator" ~1 line-height below,
    // while the next task sits a full tall row away and stays separate.
    const words: OcrWord[] = [
      w('The', 10, 10, 40, 26),
      w('Huntsman', 45, 10, 140, 26),
      w('Path', 145, 10, 190, 26),
      w('-', 195, 10, 205, 26),
      w('Administrator', 10, 34, 150, 50), // ~1 line-height below the row above
      w('Claustrophobia', 10, 120, 150, 136) // a full task-row gap below
    ]
    expect(groupWordsIntoLines(words)).toEqual([
      'The Huntsman Path - Administrator',
      'Claustrophobia'
    ])
  })
})

describe('extractTaskColumnLines (body-word edge case)', () => {
  it('does not treat a body quest containing the word "task" as the header', () => {
    // "Task" appears in a body row with no other header labels on its row, so
    // it must not be mistaken for the column header.
    const words: OcrWord[] = [
      w('Trader', 0, 30, 30, 42),
      w('Type', 60, 30, 90, 42),
      w('Task', 140, 30, 180, 42),
      w('Location', 520, 30, 580, 42),
      w('Special', 140, 60, 200, 75),
      w('task', 205, 60, 245, 75),
      w('Force', 250, 60, 300, 75)
    ]
    const lines = extractTaskColumnLines(words)
    expect(lines).toEqual(['Special task Force'])
  })
})
