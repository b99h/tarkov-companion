import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Tracks how many bytes of each tailed log file we've already consumed, keyed by
 * absolute file path, so restarts resume where they left off instead of re-reading
 * (and re-applying) an entire session's notifications.
 */
type Checkpoints = Record<string, number>

function checkpointFile(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'checkpoints.json')
}

function load(): Checkpoints {
  const file = checkpointFile()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Checkpoints
  } catch {
    return {}
  }
}

function save(checkpoints: Checkpoints): void {
  writeFileSync(checkpointFile(), JSON.stringify(checkpoints), 'utf-8')
}

/**
 * Checkpoints are held in memory and only flushed to disk when an offset
 * actually changes. Previously every getOffset/setOffset re-read and re-wrote
 * the whole file synchronously on each `fs.watch` event and 3s poll — continuous
 * pointless main-thread disk I/O during a raid (the folder churns constantly).
 */
let cache: Checkpoints | null = null

function ensureLoaded(): Checkpoints {
  if (cache === null) cache = load()
  return cache
}

export function getOffset(filePath: string): number {
  return ensureLoaded()[filePath] ?? 0
}

export function setOffset(filePath: string, offset: number): void {
  const checkpoints = ensureLoaded()
  if (checkpoints[filePath] === offset) return // no change → no disk write
  checkpoints[filePath] = offset
  save(checkpoints)
}

/** Drop all checkpoints (e.g. on wipe reset) so logs can be re-read from scratch. */
export function clearCheckpoints(): void {
  cache = {}
  save(cache)
}
