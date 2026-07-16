import { describe, it, expect } from 'vitest'
import {
  extractJsonObjects,
  parseNotificationsLog,
  parseApplicationLog,
  mapCodeToName
} from './logParser'

const QUEST_ID = '5936d90786f7742b1420ba5b'

/** Build a realistic notifications.log block with a timestamped header + payload. */
function notification(type: number, questId: string, dt?: number): string {
  const message: Record<string, unknown> = {
    _id: 'abc123',
    uid: questId,
    type,
    templateId: `${questId} successMessage`,
    text: ''
  }
  if (dt !== undefined) message.dt = dt
  const payload = { type: 'new', eventId: 'evt-1', message }
  return `2024-01-02 19:24:47.291 +03:00|0.14.0.0.1|Info|application|Got notification | ChatMessageReceived\n${JSON.stringify(
    payload,
    null,
    2
  )}`
}

describe('extractJsonObjects', () => {
  it('pulls each balanced object out of surrounding log noise', () => {
    const text = `header line\n{"a":1}\nmore noise\n{"b":{"c":2}}`
    expect(extractJsonObjects(text)).toEqual(['{"a":1}', '{"b":{"c":2}}'])
  })

  it('ignores braces inside string literals', () => {
    const text = `{"text":"a } b { c","n":1}`
    expect(extractJsonObjects(text)).toEqual([text])
  })

  it('handles escaped quotes inside strings', () => {
    const text = `{"text":"he said \\"hi }\\"","n":1}`
    expect(extractJsonObjects(text)).toEqual([text])
  })

  it('skips a trailing incomplete object (partial write)', () => {
    const text = `{"done":1}\n{"partial":`
    expect(extractJsonObjects(text)).toEqual(['{"done":1}'])
  })
})

describe('parseNotificationsLog', () => {
  it('maps message types 10/11/12 to started/failed/finished', () => {
    const text = [
      notification(10, QUEST_ID),
      notification(11, QUEST_ID),
      notification(12, QUEST_ID)
    ].join('\n\n')

    expect(parseNotificationsLog(text).map((e) => e.type)).toEqual([
      'started',
      'failed',
      'finished'
    ])
  })

  it('extracts the 24-hex quest id from templateId', () => {
    const events = parseNotificationsLog(notification(12, QUEST_ID))
    expect(events).toHaveLength(1)
    expect(events[0].taskId).toBe(QUEST_ID)
  })

  it('converts the message dt (epoch seconds) to epoch ms', () => {
    const events = parseNotificationsLog(notification(12, QUEST_ID, 1700000000))
    expect(events[0].timestamp).toBe(1700000000 * 1000)
  })

  it('leaves timestamp null when dt is absent', () => {
    const events = parseNotificationsLog(notification(12, QUEST_ID))
    expect(events[0].timestamp).toBeNull()
  })

  it('finds the message even when nested under a data wrapper', () => {
    const payload = {
      type: 'new',
      data: { dialogId: QUEST_ID, message: { type: 12, templateId: `${QUEST_ID} x` } }
    }
    expect(parseNotificationsLog(JSON.stringify(payload))).toEqual([
      { taskId: QUEST_ID, type: 'finished', timestamp: null }
    ])
  })

  it('ignores non-task notification types', () => {
    const payload = { message: { type: 4, templateId: `${QUEST_ID} system` } }
    expect(parseNotificationsLog(JSON.stringify(payload))).toEqual([])
  })

  it('ignores task-typed messages whose templateId has no quest id', () => {
    const payload = { message: { type: 12, templateId: 'no-id-here' } }
    expect(parseNotificationsLog(JSON.stringify(payload))).toEqual([])
  })

  it('returns nothing for an empty or garbage buffer', () => {
    expect(parseNotificationsLog('')).toEqual([])
    expect(parseNotificationsLog('not json at all')).toEqual([])
  })
})

describe('mapCodeToName', () => {
  it('maps known internal codes case-insensitively (legacy log format)', () => {
    expect(mapCodeToName('bigmap')).toBe('Customs')
    expect(mapCodeToName('TarkovStreets')).toBe('Streets of Tarkov')
    expect(mapCodeToName('Sandbox')).toBe('Ground Zero')
  })

  it('falls back to the raw value for unmapped/already-friendly names', () => {
    // Current game versions log the friendly name directly (verified live), so an
    // unrecognized value is passed through rather than discarded.
    expect(mapCodeToName('Icebreaker')).toBe('Icebreaker')
  })

  it('returns null for an empty value', () => {
    expect(mapCodeToName('  ')).toBeNull()
  })
})

describe('parseApplicationLog', () => {
  it('detects a raid start from a TRACE-NetworkGameCreate line (live 1.0.6.0 format)', () => {
    const line =
      "2026-07-12 21:16:16.605|1.0.6.0.46010|Debug|application|TRACE-NetworkGameCreate profileStatus: 'Profileid: abc, Status: Busy, RaidMode: Online, Location: Shoreline, Sid: xyz'"
    const events = parseApplicationLog(line)
    expect(events).toEqual([
      { type: 'start', map: 'Shoreline', timestamp: Date.parse('2026-07-12T21:16:16') }
    ])
  })

  it('detects a raid start with a legacy internal map code', () => {
    const line =
      '2024-01-02 19:24:47.291|0.14|Info|application|GameStarted Location: bigmap'
    const events = parseApplicationLog(line)
    expect(events).toEqual([
      { type: 'start', map: 'Customs', timestamp: Date.parse('2024-01-02T19:24:47') }
    ])
  })

  it('detects a raid end from "Dll released" (live format) and legacy markers', () => {
    const live = parseApplicationLog(
      "2026-07-12 21:48:03.536|1.0.6.0.46010|Debug|application|SUCCESS: Dll released with code '1'"
    )
    expect(live).toHaveLength(1)
    expect(live[0].type).toBe('end')

    const legacy = parseApplicationLog('2024-01-02 20:00:00.000|x|Info|app|GameFinished')
    expect(legacy).toHaveLength(1)
    expect(legacy[0].type).toBe('end')
  })

  it('ignores unrelated lines', () => {
    expect(parseApplicationLog('some unrelated log line\nanother one')).toEqual([])
  })
})
