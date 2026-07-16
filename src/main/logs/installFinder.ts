import { execFileSync } from 'child_process'
import { readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import type { InstallInfo, InstallSource, LogSession } from '../../shared/types'

/**
 * Discover the Escape From Tarkov install directory and enumerate its log-session
 * folders. Install path comes from the Windows registry uninstall keys (BSG launcher
 * or Steam); we shell out to `reg query` rather than pull in a native `winreg`
 * dependency. A manual folder override always wins.
 */

interface RegTarget {
  hive: string
  key: string
  source: InstallSource
}

const REG_TARGETS: RegTarget[] = [
  {
    hive: 'HKLM',
    key: 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EscapeFromTarkov',
    source: 'registry-bsg'
  },
  {
    hive: 'HKLM',
    key: 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 3932890',
    source: 'registry-steam'
  }
]

function queryInstallLocation(target: RegTarget): string | null {
  try {
    const out = execFileSync(
      'reg',
      ['query', `${target.hive}\\${target.key}`, '/v', 'InstallLocation'],
      { encoding: 'utf-8', windowsHide: true }
    )
    // Line looks like: "    InstallLocation    REG_SZ    C:\\path\\to\\EFT"
    const match = out.match(/InstallLocation\s+REG_SZ\s+(.+)/)
    const path = match?.[1]?.trim()
    return path && path.length > 0 ? path : null
  } catch {
    return null
  }
}

/** True if the path looks like a Tarkov install (has a Logs subfolder). */
function hasLogsDir(installPath: string): boolean {
  return existsSync(join(installPath, 'Logs'))
}

/**
 * Resolve the active install path. A manual override (from settings) takes
 * precedence; otherwise probe the registry keys in order.
 */
export function findInstall(manualOverride: string | null): InstallInfo {
  if (manualOverride) {
    return { installPath: manualOverride, source: 'manual' }
  }

  for (const target of REG_TARGETS) {
    const path = queryInstallLocation(target)
    if (path && existsSync(path)) {
      return { installPath: path, source: target.source }
    }
  }

  return { installPath: null, source: 'not-found' }
}

// Folder names look like: log_2024.01.02_19-24-47_0.14.0.0.12345
const SESSION_NAME_RE = /^log_(\d{4})\.(\d{2})\.(\d{2})_(\d{2})-(\d{2})-(\d{2})/

function parseSessionStart(name: string): number | null {
  const m = name.match(SESSION_NAME_RE)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
  return Number.isNaN(ms) ? null : ms
}

/**
 * List every log-session folder under `<install>\Logs`, newest first. `imported`
 * is filled from the caller's set of already-replayed session names.
 */
export function listLogSessions(
  installPath: string,
  importedSessions: Set<string>
): LogSession[] {
  const logsDir = join(installPath, 'Logs')
  if (!existsSync(logsDir)) return []

  let entries: string[]
  try {
    entries = readdirSync(logsDir)
  } catch {
    return []
  }

  const sessions: LogSession[] = []
  for (const name of entries) {
    const folder = join(logsDir, name)
    try {
      if (!statSync(folder).isDirectory()) continue
    } catch {
      continue
    }
    if (!name.startsWith('log_')) continue

    sessions.push({
      folder,
      name,
      startedAt: parseSessionStart(name),
      imported: importedSessions.has(name)
    })
  }

  return sessions.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

/**
 * Find a file inside a session folder whose name contains the given fragment.
 * Substring match, not suffix: older game versions wrote plain `notifications.log`
 * / `application.log`; current versions (1.0.6.0+) write `push-notifications_000.log`
 * / `application_000.log`. Matching on the stable substring covers both.
 */
export function findLogFile(sessionFolder: string, fragment: string): string | null {
  try {
    const match = readdirSync(sessionFolder).find((f) =>
      f.toLowerCase().includes(fragment.toLowerCase())
    )
    return match ? join(sessionFolder, match) : null
  } catch {
    return null
  }
}

export const NOTIFICATIONS_SUFFIX = 'notification'
export const APPLICATION_SUFFIX = 'application'
