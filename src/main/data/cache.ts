import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { isValidCacheName } from '../../shared/security'

interface CacheEnvelope<T> {
  fetchedAt: number
  data: T
}

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Cache names are interpolated into a filename, and several are built from
 * renderer-supplied strings (a map's normalizedName, a taskId), so a name like
 * `..\..\evil` would escape the cache directory. This is the one chokepoint
 * every read and write goes through, so validate here rather than at each of
 * the call sites in `data/index.ts`.
 */
function cacheFile(name: string): string {
  if (!isValidCacheName(name)) {
    throw new Error(`Refusing unsafe cache name: ${JSON.stringify(name)}`)
  }
  return join(cacheDir(), `${name}.json`)
}

export function readCache<T>(name: string): CacheEnvelope<T> | null {
  const file = cacheFile(name)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as CacheEnvelope<T>
  } catch {
    return null
  }
}

export function writeCache<T>(name: string, data: T): void {
  const envelope: CacheEnvelope<T> = { fetchedAt: Date.now(), data }
  writeFileSync(cacheFile(name), JSON.stringify(envelope), 'utf-8')
}

export function isStale(fetchedAt: number, ttlMs: number): boolean {
  return Date.now() - fetchedAt > ttlMs
}
