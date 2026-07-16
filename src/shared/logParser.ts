import type { TaskEventType, TaskLogEvent, RaidLogEvent } from './types'

/**
 * Pure parsers for Escape From Tarkov's on-disk logs. No filesystem access here so
 * the logic stays unit-testable (see logParser.test.ts) and reusable for both live
 * tailing and historical replay in the main process.
 *
 * Facts (not code) borrowed from the ecosystem — TarkovMonitor, tarkov.dev:
 * quest state changes arrive in `notifications.log` as `ChatMessageReceived`
 * notifications whose `message.type` is 10 (started), 11 (failed) or 12 (finished),
 * and whose `message.templateId` begins with the 24-hex-char quest id. That quest id
 * is identical to the tarkov.dev task `id`, so no separate mapping table is needed.
 */

const TASK_EVENT_TYPES: Record<number, TaskEventType> = {
  10: 'started',
  11: 'failed',
  12: 'finished'
}

const QUEST_ID_RE = /[a-f0-9]{24}/i

/**
 * Extract every balanced top-level JSON object from a text buffer. Tolerant of the
 * timestamped log-header lines between objects and of pretty-printed (multi-line)
 * payloads, so it works whether Tarkov writes one notification per line or not.
 * A trailing, incomplete object (partial write mid-tail) is skipped.
 */
export function extractJsonObjects(text: string): string[] {
  const objects: string[] = []
  const n = text.length
  let i = 0

  while (i < n) {
    if (text[i] !== '{') {
      i++
      continue
    }

    const start = i
    let depth = 0
    let inString = false
    let escaped = false
    let closed = false

    for (; i < n; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          objects.push(text.slice(start, i + 1))
          i++
          closed = true
          break
        }
      }
    }

    // Ran off the end without closing: incomplete tail, stop scanning.
    if (!closed) break
  }

  return objects
}

/**
 * Depth-first search for the notification's `message` node — an object carrying a
 * numeric `type` (10/11/12) alongside a string `templateId`. Recursion keeps us
 * robust to the exact nesting (`message` may sit at the top level or under `data`).
 */
function findTaskEvent(node: unknown): TaskLogEvent | null {
  if (node === null || typeof node !== 'object') return null

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTaskEvent(child)
      if (found) return found
    }
    return null
  }

  const obj = node as Record<string, unknown>
  const type = obj.type

  if (
    typeof type === 'number' &&
    TASK_EVENT_TYPES[type] &&
    typeof obj.templateId === 'string'
  ) {
    const match = obj.templateId.match(QUEST_ID_RE)
    if (match) {
      const dt = typeof obj.dt === 'number' ? obj.dt : null
      return {
        taskId: match[0].toLowerCase(),
        type: TASK_EVENT_TYPES[type],
        timestamp: dt !== null ? dt * 1000 : null
      }
    }
  }

  for (const key of Object.keys(obj)) {
    const found = findTaskEvent(obj[key])
    if (found) return found
  }
  return null
}

/** Parse all quest state-change events from a chunk of `notifications.log`. */
export function parseNotificationsLog(text: string): TaskLogEvent[] {
  const events: TaskLogEvent[] = []
  for (const raw of extractJsonObjects(text)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const event = findTaskEvent(parsed)
    if (event) events.push(event)
  }
  return events
}

// ── Raid detection (application.log) — best-effort, secondary ────────────────

/** Internal map codes → friendly names. Codes seen in `Location:` log lines. */
const MAP_CODE_TO_NAME: Record<string, string> = {
  bigmap: 'Customs',
  factory4_day: 'Factory',
  factory4_night: 'Factory (Night)',
  interchange: 'Interchange',
  laboratory: 'The Lab',
  rezervbase: 'Reserve',
  shoreline: 'Shoreline',
  woods: 'Woods',
  lighthouse: 'Lighthouse',
  tarkovstreets: 'Streets of Tarkov',
  sandbox: 'Ground Zero',
  sandbox_high: 'Ground Zero'
}

/**
 * Resolve a raw `Location:` value to a friendly display name. Older game versions
 * (verified against 0.14.x logs) wrote internal codes like `bigmap`; current
 * versions (verified against 1.0.6.0 logs) already write the friendly name
 * directly (`Shoreline`, `Icebreaker`, ...). Try the code table first, then fall
 * back to the raw value as-is so newer/unmapped maps still show something sane.
 */
export function mapCodeToName(code: string): string | null {
  const trimmed = code.trim()
  if (!trimmed) return null
  return MAP_CODE_TO_NAME[trimmed.toLowerCase()] ?? trimmed
}

// Captures up to the next comma so multi-word friendly names (e.g. "Streets of
// Tarkov") are kept whole; real lines look like "...Location: Shoreline, Sid: ...".
const LOCATION_RE = /Location:\s*([^,]+)/
// Tarkov log header timestamp, e.g. "2024-01-02 19:24:47.291 +03:00".
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/

function parseHeaderTimestamp(line: string): number | null {
  const match = line.match(TIMESTAMP_RE)
  if (!match) return null
  const ms = Date.parse(match[1].replace(' ', 'T'))
  return Number.isNaN(ms) ? null : ms
}

/**
 * Best-effort raid start/end detection from `application.log`. Feeds the future
 * "you're on Customs, here's what you can do" feature; not on the progress path,
 * so a missed line is harmless. Signals verified against live 1.0.6.0 logs:
 * matchmaking resolving a raid writes a `TRACE-NetworkGameCreate ... Location: X`
 * line, and returning to the menu after a raid writes `Dll released`.
 */
export function parseApplicationLog(text: string): RaidLogEvent[] {
  const events: RaidLogEvent[] = []
  for (const line of text.split(/\r?\n/)) {
    const timestamp = parseHeaderTimestamp(line)

    const loc = line.match(LOCATION_RE)
    if (loc && /TRACE-NetworkGameCreate|GameStarted|GamePreparateAssembly|LocationLoaded/i.test(line)) {
      events.push({ type: 'start', map: mapCodeToName(loc[1]), timestamp })
      continue
    }

    if (/Dll released|GameFinished|match end|UserMatchOver|GroupMatchRaidReady/i.test(line)) {
      events.push({ type: 'end', map: null, timestamp })
    }
  }
  return events
}
