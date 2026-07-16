import type {
  TaskData,
  ItemData,
  MapZoneData,
  CraftData,
  MapProjection,
  MapFeatureData,
  LogProfile,
  QuestWikiImages,
  AmmoData,
  HideoutStationData
} from '../../shared/types'
import type { GameMode } from './tarkovApi'
import {
  fetchTasks,
  fetchItems,
  fetchMaps,
  fetchCrafts,
  fetchMapFeatures,
  fetchAmmo,
  fetchHideoutStations
} from './tarkovApi'
import { fetchMapProjections, fetchMapSvgText, fetchStaticImageDataUrl } from './mapProjections'
import { fetchQuestWikiImages } from './wikiImages'
import { readCache, writeCache, isStale } from './cache'

const TASKS_TTL_MS = 6 * 60 * 60 * 1000
const ITEMS_TTL_MS = 10 * 60 * 1000
const CRAFTS_TTL_MS = 10 * 60 * 1000
const MAPS_TTL_MS = 24 * 60 * 60 * 1000
const AMMO_TTL_MS = 24 * 60 * 60 * 1000
const MAP_PROJECTIONS_TTL_MS = 24 * 60 * 60 * 1000
const MAP_FEATURES_TTL_MS = 24 * 60 * 60 * 1000
const MAP_SVG_TTL_MS = 7 * 24 * 60 * 60 * 1000
const STATIC_MAP_IMAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const WIKI_IMAGES_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface MemoryEnvelope {
  fetchedAt: number
  data: unknown
}

/**
 * In-memory layer in front of the on-disk cache, keyed by cache name. Without
 * it, every `getOrRefresh` re-reads and re-parses the JSON from disk — `getTasks`
 * alone runs per renderer mount, per watcher seed, and on *every*
 * `getQuestWikiImages` call (each expanded quest row re-parses the multi-MB tasks
 * cache to look up one wikiLink). Invalidated whenever the disk cache is written.
 */
const memoryCache = new Map<string, MemoryEnvelope>()

/** Write through to disk and refresh the in-memory envelope in lockstep. */
function writeThrough<T>(name: string, data: T): void {
  writeCache(name, data)
  memoryCache.set(name, { fetchedAt: Date.now(), data })
}

async function getOrRefresh<T>(
  name: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const mem = memoryCache.get(name)
  if (mem && !isStale(mem.fetchedAt, ttlMs)) {
    return mem.data as T
  }

  const cached = readCache<T>(name)

  if (cached && !isStale(cached.fetchedAt, ttlMs)) {
    memoryCache.set(name, cached)
    return cached.data
  }

  try {
    const fresh = await fetcher()
    writeThrough(name, fresh)
    return fresh
  } catch (err) {
    if (cached) {
      console.error(`[data] refresh of "${name}" failed, serving stale cache:`, err)
      memoryCache.set(name, cached)
      return cached.data
    }
    throw err
  }
}

// Cache keys carry a schema version suffix so a shape change (new/renamed
// fields on TaskData/ItemData/CraftData/MapProjection) always invalidates old
// on-disk cache instead of serving stale data the current code doesn't know
// how to read (see the memory note on this class of bug from Phase 4).
const TASKS_CACHE_KEY = 'tasks_v4'

// Price-sensitive caches are keyed per game mode (PvE and PvP have separate
// economies) so switching profiles never serves the other mode's prices. The
// version suffix was bumped (items v3→v4, crafts v1→v2) when gameMode was added.
const toGameMode = (profile: LogProfile): GameMode => (profile === 'pve' ? 'pve' : 'regular')
const itemsCacheKey = (mode: GameMode): string => `items_v4_${mode}`
const craftsCacheKey = (mode: GameMode): string => `crafts_v2_${mode}`

export function getTasks(): Promise<TaskData[]> {
  return getOrRefresh(TASKS_CACHE_KEY, TASKS_TTL_MS, fetchTasks)
}

export function getItems(profile: LogProfile): Promise<ItemData[]> {
  const mode = toGameMode(profile)
  return getOrRefresh(itemsCacheKey(mode), ITEMS_TTL_MS, () => fetchItems(mode))
}

export function getMaps(): Promise<MapZoneData[]> {
  return getOrRefresh('maps', MAPS_TTL_MS, fetchMaps)
}

// Ballistic stats are patch-stable and not price-sensitive, so a single
// versioned key with a day-long TTL is enough (see schema-drift note).
const AMMO_CACHE_KEY = 'ammo_v2'

export function getAmmo(): Promise<AmmoData[]> {
  return getOrRefresh(AMMO_CACHE_KEY, AMMO_TTL_MS, fetchAmmo)
}

// v3: added tileSize + svgBounds (fixes The Lab tile mis-registration & Reserve SVG offset).
// v4: added per-floor tilePath (swap base raster per selected floor on tile maps).
const MAP_PROJECTIONS_CACHE_KEY = 'mapProjections_v4'

export function getMapProjections(): Promise<MapProjection[]> {
  return getOrRefresh(MAP_PROJECTIONS_CACHE_KEY, MAP_PROJECTIONS_TTL_MS, fetchMapProjections)
}

export function getCrafts(profile: LogProfile): Promise<CraftData[]> {
  const mode = toGameMode(profile)
  return getOrRefresh(craftsCacheKey(mode), CRAFTS_TTL_MS, () => fetchCrafts(mode))
}

const MAP_FEATURES_CACHE_KEY = 'mapFeatures_v5'

export function getMapFeatures(): Promise<MapFeatureData[]> {
  return getOrRefresh(MAP_FEATURES_CACHE_KEY, MAP_FEATURES_TTL_MS, fetchMapFeatures)
}

// Station structure changes only on patches and carries no prices (the
// renderer joins ItemData for those), so a single mode-agnostic day-long key
// is enough — see the hideout query note in tarkovApi.ts.
const HIDEOUT_CACHE_KEY = 'hideoutStations_v1'
const HIDEOUT_TTL_MS = 24 * 60 * 60 * 1000

export function getHideoutStations(): Promise<HideoutStationData[]> {
  return getOrRefresh(HIDEOUT_CACHE_KEY, HIDEOUT_TTL_MS, fetchHideoutStations)
}

/** Raw SVG markup for one map's inline overlay, cached per map (rarely changes). */
export function getMapSvg(normalizedName: string, svgPath: string): Promise<string> {
  return getOrRefresh(`mapSvg_${normalizedName}_v1`, MAP_SVG_TTL_MS, () => fetchMapSvgText(svgPath))
}

/**
 * A static reference-map image (e.g. Icebreaker's community wiki map) as a
 * data URL, fetched server-side to avoid the source CDN's referrer-based
 * hotlink protection blocking a direct renderer `<img>` request.
 */
export function getStaticMapImage(normalizedName: string, url: string): Promise<string> {
  return getOrRefresh(`staticMapImage_${normalizedName}_v1`, STATIC_MAP_IMAGE_TTL_MS, () =>
    fetchStaticImageDataUrl(url)
  )
}

/**
 * A quest's captioned wiki location screenshots (Phase 4.65), fetched lazily on
 * first request and cached per task for ~30 days. Resolves the task's `wikiLink`
 * from the cached task list, so no page is crawled up front — one page parse
 * plus a handful of image downloads per quest, then served from disk. Empty
 * results (no link / no gallery) are cached too, so they aren't refetched.
 */
export async function getQuestWikiImages(taskId: string): Promise<QuestWikiImages> {
  const tasks = await getTasks()
  const task = tasks.find((t) => t.id === taskId) ?? null
  return getOrRefresh(`wikiImages_v1_${taskId}`, WIKI_IMAGES_TTL_MS, () =>
    fetchQuestWikiImages(taskId, task?.wikiLink ?? null)
  )
}

interface PriceRefreshCallbacks {
  /** Current profile, read each tick so a mid-session profile switch is honored. */
  getProfile: () => LogProfile
  onItems: (items: ItemData[]) => void
  onCrafts: (crafts: CraftData[]) => void
}

/**
 * Fetch fresh items + crafts for a given profile's game mode, cache them under
 * that mode's key, and push to the renderer. Shared by the periodic refresh
 * loop and the on-demand refresh triggered by a profile switch.
 */
export async function refreshPrices(
  profile: LogProfile,
  callbacks: Pick<PriceRefreshCallbacks, 'onItems' | 'onCrafts'>
): Promise<void> {
  const mode = toGameMode(profile)
  try {
    const items = await fetchItems(mode)
    writeThrough(itemsCacheKey(mode), items)
    callbacks.onItems(items)
  } catch (err) {
    console.error('[data] item price refresh failed:', err)
  }
  try {
    const crafts = await fetchCrafts(mode)
    writeThrough(craftsCacheKey(mode), crafts)
    callbacks.onCrafts(crafts)
  } catch (err) {
    console.error('[data] craft refresh failed:', err)
  }
}

/**
 * Periodically refresh price-sensitive data (flea items and craft valuations)
 * and push it to the renderer. Crafts embed their own item prices, so they must
 * be refreshed on the same cadence as items to keep profit numbers current.
 */
export function startPriceRefreshLoop(callbacks: PriceRefreshCallbacks): () => void {
  const interval = setInterval(() => {
    void refreshPrices(callbacks.getProfile(), callbacks)
  }, 10 * 60 * 1000)

  return () => clearInterval(interval)
}
