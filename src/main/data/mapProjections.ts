import type { MapProjection, MapFloor } from '../../shared/types'
import { isAllowedFetchUrl } from '../../shared/security'
import { fetchBoundedBuffer } from './fetchLimits'

// tarkov.dev keeps its interactive-map projection data (transforms, bounds, SVG
// URLs) in a static JSON file in its web repo — none of it is exposed through
// the GraphQL API, so we fetch it straight from the repo and cache it. The SVG
// and tile images referenced within are hosted on assets.tarkov.dev and loaded
// directly by the renderer's Leaflet layers.
const MAPS_JSON_URL =
  'https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json'

/**
 * Zone map names in the quest data that don't have their own projection because
 * they share another map's physical geometry (and therefore its coordinate
 * system). We fold their markers onto the base map.
 */
const ALIASES: Record<string, string> = {
  'night-factory': 'factory',
  'ground-zero-21': 'ground-zero'
}

interface RawMapExtent {
  height?: number[]
}

interface RawMapLayer {
  name?: string
  svgLayer?: string
  tilePath?: string
  extents?: RawMapExtent[]
}

interface RawMapVariant {
  key?: string
  projection?: string
  minZoom?: number
  maxZoom?: number
  transform?: number[]
  coordinateRotation?: number
  bounds?: number[][]
  svgBounds?: number[][]
  svgPath?: string
  tilePath?: string
  tileSize?: number
  svgLayer?: string
  layers?: RawMapLayer[]
  heightRange?: number[]
}

interface RawMapGroup {
  normalizedName: string
  maps: RawMapVariant[]
}

function isValidTransform(t: number[] | undefined): t is [number, number, number, number] {
  return Array.isArray(t) && t.length === 4 && t.every((n) => typeof n === 'number')
}

function isValidBounds(b: number[][] | undefined): b is [[number, number], [number, number]] {
  return (
    Array.isArray(b) &&
    b.length === 2 &&
    b.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((n) => typeof n === 'number'))
  )
}

/**
 * Flattens tarkov.dev's per-region `extents` (each with its own height range
 * and sometimes x/z sub-bounds we don't model) into one overall height range
 * per floor. An approximation — good enough for "roughly which level is this
 * marker on", not pixel-perfect multi-region floor geometry.
 */
function flattenFloor(layer: RawMapLayer): MapFloor | null {
  if (!layer.name || !layer.extents?.length) return null
  let min = Infinity
  let max = -Infinity
  for (const extent of layer.extents) {
    if (!extent.height || extent.height.length !== 2) continue
    min = Math.min(min, extent.height[0])
    max = Math.max(max, extent.height[1])
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  return {
    name: layer.name,
    svgLayer: layer.svgLayer ?? null,
    tilePath: layer.tilePath ?? null,
    minHeight: min,
    maxHeight: max
  }
}

export async function fetchMapProjections(): Promise<MapProjection[]> {
  const res = await fetch(MAPS_JSON_URL)
  if (!res.ok) {
    throw new Error(`maps.json request failed: ${res.status} ${res.statusText}`)
  }
  const groups = (await res.json()) as Record<string, RawMapGroup>

  // normalizedName → aliases that resolve to it, so each projection knows its
  // alternate zone names.
  const aliasesFor = new Map<string, string[]>()
  for (const [alias, target] of Object.entries(ALIASES)) {
    const list = aliasesFor.get(target) ?? []
    list.push(alias)
    aliasesFor.set(target, list)
  }

  const projections: MapProjection[] = []

  for (const group of Object.values(groups)) {
    const interactive = group.maps.find((m) => m.projection === 'interactive')
    // Needs a usable image (SVG or tiles) and a valid transform/bounds to plot.
    if (!interactive) continue
    if (!interactive.svgPath && !interactive.tilePath) continue
    if (!isValidTransform(interactive.transform) || !isValidBounds(interactive.bounds)) continue

    projections.push({
      normalizedName: group.normalizedName,
      aliases: aliasesFor.get(group.normalizedName) ?? [],
      svgPath: interactive.svgPath ?? null,
      tilePath: interactive.tilePath ?? null,
      tileSize: interactive.tileSize ?? null,
      minZoom: interactive.minZoom ?? 1,
      maxZoom: interactive.maxZoom ?? 5,
      transform: interactive.transform,
      coordinateRotation: interactive.coordinateRotation ?? 0,
      bounds: interactive.bounds,
      svgBounds: isValidBounds(interactive.svgBounds) ? interactive.svgBounds : null,
      groundSvgLayer: interactive.svgLayer ?? null,
      groundHeightRange:
        interactive.heightRange?.length === 2
          ? [interactive.heightRange[0], interactive.heightRange[1]]
          : null,
      floors: (interactive.layers ?? [])
        .map(flattenFloor)
        .filter((f): f is MapFloor => f !== null)
    })
  }

  return projections
}

/** Fetches the raw SVG markup for an SVG-based map, so the renderer can inline
 * it and toggle floor groups by id (an `<img>`/imageOverlay can't be reached
 * into from the DOM). Cached by the caller, keyed on `normalizedName`. */
export async function fetchMapSvgText(svgPath: string): Promise<string> {
  // The path arrives from the renderer (out of maps.json), so it's only as
  // trustworthy as the renderer is — pin it to the asset CDN before fetching.
  if (!isAllowedFetchUrl(svgPath)) {
    throw new Error(`Refusing to fetch map SVG from a non-allowlisted URL: ${svgPath}`)
  }
  const { buffer } = await fetchBoundedBuffer(svgPath, 'map SVG')
  return buffer.toString('utf-8')
}

/**
 * Fetches a static reference image and returns it as a data URL. Used instead
 * of letting the renderer hotlink it directly: the Fandom wiki's asset CDN
 * has referrer-based hotlink protection that 404s any request carrying a
 * non-fandom.com `Referer` header (confirmed live — a request with *no*
 * referrer, or `curl`'s default of sending none, succeeds; one with our
 * app's origin as referrer doesn't). Node's `fetch` in the main process sends
 * no `Referer` by default, so fetching here and handing the bytes to the
 * renderer as a data URL sidesteps the block entirely. Cached by the caller.
 */
export async function fetchStaticImageDataUrl(url: string): Promise<string> {
  if (!isAllowedFetchUrl(url)) {
    throw new Error(`Refusing to fetch static map image from a non-allowlisted URL: ${url}`)
  }
  const { buffer, contentType } = await fetchBoundedBuffer(url, 'static map image')
  return `data:${contentType ?? 'image/jpeg'};base64,${buffer.toString('base64')}`
}
