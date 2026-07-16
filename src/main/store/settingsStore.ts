import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../../shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  installPath: null,
  // PvE is the default profile; PvP is selectable in settings.
  profile: 'pve',
  importedSessions: [],
  autoWatch: true,
  captureHotkey: 'F1',
  // F9: unbound in Tarkov's default keymap, unlike the F1–F4 quick-slot keys.
  overlayHotkey: 'F9',
  launchAtStartup: false,
  minimizeToTray: false
}

function settingsFile(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

export function loadSettings(): AppSettings {
  const file = settingsFile()
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS }
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(file, 'utf-8')) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: AppSettings): AppSettings {
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf-8')
  return settings
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  return saveSettings({ ...loadSettings(), ...patch })
}

/** Record a log session folder as replayed, so it isn't imported twice. */
export function markSessionsImported(folderNames: string[]): AppSettings {
  const settings = loadSettings()
  const merged = new Set([...settings.importedSessions, ...folderNames])
  return saveSettings({ ...settings, importedSessions: [...merged] })
}
