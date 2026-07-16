/**
 * Phase 7.1 — input validation for everything the renderer can reach.
 *
 * The renderer is the only untrusted surface in this app (it inlines remote SVG
 * and remote images), and main happily fetches URLs and writes files on its
 * behalf. These are the chokepoint predicates that keep a compromised renderer
 * from steering those privileges. Pure functions with no Electron/fs imports,
 * so they're unit-testable alongside the rest of `shared/`.
 */

import type { AppSettings, Faction, LogProfile } from './types'

/**
 * Hosts main is willing to fetch bytes from on the renderer's say-so:
 * tarkov.dev's asset CDN (map SVGs and tiles), the Fandom image CDN (the
 * Icebreaker reference map), and the tarkov-dev repo (maps.json). Anything
 * else is rejected before the request goes out.
 */
export const ALLOWED_FETCH_HOSTS: readonly string[] = [
  'assets.tarkov.dev',
  'static.wikia.nocookie.net',
  'raw.githubusercontent.com'
]

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** https: and on the fetch allowlist — the gate for renderer-supplied fetch URLs. */
export function isAllowedFetchUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  const parsed = parseUrl(url)
  if (!parsed) return false
  if (parsed.protocol !== 'https:') return false
  return ALLOWED_FETCH_HOSTS.includes(parsed.hostname.toLowerCase())
}

/**
 * Whether a URL may be handed to `shell.openExternal`. https: only — the OS
 * would otherwise happily act on `file:`, `ms-settings:`, and similar from any
 * href that reaches the window-open handler. Not host-restricted: outbound
 * links (wiki pages, releases) legitimately go anywhere on the web.
 */
export function isExternallyOpenable(url: string): boolean {
  return parseUrl(url)?.protocol === 'https:'
}

/**
 * Cache names are interpolated straight into a filename, so anything with a
 * path separator or `..` escapes the cache directory. Names are built from
 * renderer-supplied strings (map normalizedName, taskId), so validate at the
 * `cacheFile()` chokepoint rather than trusting each call site.
 */
export function isValidCacheName(name: string): boolean {
  return /^[a-z0-9_-]+$/i.test(name)
}

/** A tarkov.dev task id: a 24-character hex string (BSG's Mongo-style ids). */
export function isValidTaskId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)
}

/** Map/normalized names, used to build cache keys — same grammar as cache names. */
export function isValidNormalizedName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && isValidCacheName(name)
}

const ACCELERATOR_MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta'
])

const ACCELERATOR_KEYS = new Set([
  'plus',
  'space',
  'tab',
  'capslock',
  'numlock',
  'scrolllock',
  'backspace',
  'delete',
  'insert',
  'return',
  'enter',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'escape',
  'esc',
  'printscreen'
])

function isAcceleratorKey(key: string): boolean {
  const k = key.toLowerCase()
  if (/^[a-z0-9]$/.test(k)) return true
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k)) return true
  if (/^num[0-9]$/.test(k)) return true
  return ACCELERATOR_KEYS.has(k)
}

/**
 * An Electron accelerator we're willing to hand to `globalShortcut.register`:
 * zero or more known modifiers then exactly one known key, e.g. `F1`,
 * `CmdOrCtrl+Shift+K`. Deliberately a whitelist — `register` takes a string
 * from settings.json, and a malformed one throws rather than returning false.
 */
export function isValidAccelerator(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false
  const parts = value.split('+')
  const key = parts.pop()
  if (!key || !isAcceleratorKey(key)) return false
  return parts.every((part) => ACCELERATOR_MODIFIERS.has(part.toLowerCase()))
}

/**
 * A log session folder name, as produced by the game (`log_<timestamp>_…`).
 * Rejects path separators and traversal so an import request can't be pointed
 * outside the Logs directory.
 */
export function isValidSessionName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value.startsWith('log_') &&
    !/[/\\]/.test(value) &&
    !value.includes('..')
  )
}

export function isValidSessionNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isValidSessionName)
}

/** Tarkov's max PMC level; also the ceiling the level input is clamped to. */
export const MAX_PLAYER_LEVEL = 79

/**
 * Coerce any renderer-supplied level into an integer within 1–79. Only NaN
 * (from unparseable junk) needs the early return — the min/max below clamps
 * ±Infinity to the right end on its own, whereas NaN would propagate through it.
 */
export function clampPlayerLevel(level: unknown): number {
  const n = typeof level === 'number' ? level : Number(level)
  if (Number.isNaN(n)) return 1
  return Math.min(MAX_PLAYER_LEVEL, Math.max(1, Math.round(n)))
}

/**
 * Ceiling for hideout station levels (Phase 8). No live station exceeds 4
 * today (Stash); 10 leaves headroom for future stations without letting a
 * hostile renderer write absurd numbers into progress.json.
 */
export const MAX_STATION_LEVEL = 10

/** Coerce a renderer-supplied station level into an integer within 0–10. */
export function clampStationLevel(level: unknown): number {
  const n = typeof level === 'number' ? level : Number(level)
  if (Number.isNaN(n)) return 0
  return Math.min(MAX_STATION_LEVEL, Math.max(0, Math.round(n)))
}

const FACTIONS: readonly Faction[] = ['Any', 'Usec', 'Bear']

export function isFaction(value: unknown): value is Faction {
  return typeof value === 'string' && (FACTIONS as readonly string[]).includes(value)
}

const PROFILES: readonly LogProfile[] = ['pve', 'pvp']

function isProfile(value: unknown): value is LogProfile {
  return typeof value === 'string' && (PROFILES as readonly string[]).includes(value)
}

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'

/**
 * Per-key validators for `settings:update`. Only these keys are writable, and
 * only with a value of the right shape — without this, the handler spreads
 * whatever the renderer sends straight into settings.json, which then gets fed
 * back to `globalShortcut.register`, the login-item API, and the log watcher.
 */
const SETTINGS_VALIDATORS: { [K in keyof AppSettings]: (value: unknown) => boolean } = {
  installPath: (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 4096),
  profile: isProfile,
  importedSessions: isValidSessionNames,
  autoWatch: isBoolean,
  captureHotkey: isValidAccelerator,
  overlayHotkey: isValidAccelerator,
  launchAtStartup: isBoolean,
  minimizeToTray: isBoolean
}

/**
 * Drop every key that isn't a known setting or whose value fails its check.
 * Returns the accepted patch plus the rejected key names, so main can log what
 * it threw away instead of failing silently.
 */
export function sanitizeSettingsPatch(patch: unknown): {
  patch: Partial<AppSettings>
  rejected: string[]
} {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { patch: {}, rejected: [] }
  }
  const accepted: Record<string, unknown> = {}
  const rejected: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    const validator = (SETTINGS_VALIDATORS as Record<string, ((v: unknown) => boolean) | undefined>)[
      key
    ]
    if (validator && validator(value)) accepted[key] = value
    else rejected.push(key)
  }
  return { patch: accepted as Partial<AppSettings>, rejected }
}
