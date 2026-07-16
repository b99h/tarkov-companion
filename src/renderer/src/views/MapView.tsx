import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { deriveTaskStates, taskMaps } from '@shared/questEngine'
import type {
  MapProjection,
  MapFloor,
  MapZoneData,
  MapFeatureData,
  MapExtractData,
  MapTransitData,
  MapLockData,
  MapBossSpawnData,
  TaskWithStatus,
  QuestWikiImages,
  WikiGalleryImage
} from '@shared/types'
import { useAppData } from '../state/AppDataContext'
import { usePersistedState } from '../state/usePersistedState'
import { parseAndSanitizeSvg } from '@shared/sanitizeSvg'
import { WikiGallery, WikiLightbox, loadWikiImages, peekWikiImages, wikiImageLabel } from './WikiGallery'

/**
 * Maps tarkov.dev's own `maps.json` has no image or coordinate transform for at
 * all (checked live 2026-07: Icebreaker's only entry is a bare "2D" projection
 * with no svgPath/tilePath/transform, just an author credit). We can still show
 * a plain reference picture for these — sourced from the community wiki's own
 * static (non-interactive) map image, credited to the same author tarkov.dev
 * recognizes — but with no coordinates, quest objectives can't be pinned; they
 * fall back to the same "no exact location" list used elsewhere.
 */
const STATIC_REFERENCE_MAPS: { normalizedName: string; label: string; imageUrl: string; note: string }[] = [
  {
    normalizedName: 'icebreaker',
    label: 'Icebreaker',
    imageUrl:
      'https://static.wikia.nocookie.net/escapefromtarkov_gamepedia/images/b/bd/Icebreaker_Map_by_re3mr.jpg/revision/latest',
    note:
      "tarkov.dev hasn't published coordinate data for this map yet, so quest objectives can't be pinned. Reference map by re3mr, via the Escape from Tarkov Wiki."
  }
]
const STATIC_BY_NAME = new Map(STATIC_REFERENCE_MAPS.map((m) => [m.normalizedName, m]))

/**
 * Black Division spawn counts on Icebreaker by squad size. Not from
 * tarkov.dev — the API has real spawn coordinates for this but no field
 * tying a given escort count to a squad size, and no calibrated transform
 * exists to plot Icebreaker positions anyway (see STATIC_REFERENCE_MAPS
 * above). Player-reported (2026-07), confirmed by the user's own testing.
 */
const ICEBREAKER_BLACK_DIVISION_SPAWNS: { location: string; solo: number; duo: number; trio: number }[] = [
  { location: 'Engine Room', solo: 4, duo: 6, trio: 8 },
  { location: 'Helipad', solo: 3, duo: 4, trio: 5 },
  { location: 'Under Heli', solo: 6, duo: 8, trio: 10 },
  { location: 'Stairs (Bomb Door)', solo: 3, duo: 3, trio: 3 },
  { location: 'Gym (Boss) — The Wedge + escort', solo: 3, duo: 4, trio: 6 },
  { location: "Officer's Deck (final BD!)", solo: 5, duo: 5, trio: 5 }
]

// ── Coordinate transform (ported from tarkov.dev's Leaflet map setup) ────────
// tarkov.dev renders these maps with L.CRS.Simple plus a per-map linear
// transform and a rotation, so game world coordinates land on the right pixels.
// Reproduced faithfully so our markers sit exactly where theirs do.

function applyRotation(latLng: L.LatLng, rotation: number): L.LatLng {
  if (!latLng.lng && !latLng.lat) return L.latLng(0, 0)
  if (!rotation) return latLng
  const rad = (rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const x = latLng.lng
  const y = latLng.lat
  return L.latLng(x * sin + y * cos, x * cos - y * sin)
}

function getCRS(p: MapProjection): L.CRS {
  const [scaleX, marginX, scaleZ, marginY] = p.transform
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(scaleX, marginX, scaleZ * -1, marginY),
    projection: L.extend({}, L.Projection.LonLat, {
      project: (latLng: L.LatLng) =>
        L.Projection.LonLat.project(applyRotation(latLng, p.coordinateRotation)),
      unproject: (point: L.Point) =>
        applyRotation(L.Projection.LonLat.unproject(point), p.coordinateRotation * -1)
    })
  }) as L.CRS
}

/** A game position (x, z) as a Leaflet [lat, lng]. */
function pos(x: number, z: number): L.LatLngTuple {
  return [z, x]
}

function getBounds(b: MapProjection['bounds']): L.LatLngBounds {
  return L.latLngBounds([b[0][1], b[0][0]], [b[1][1], b[1][0]])
}

/**
 * Leaflet pane for per-floor raster overlays. Must sit above `overlayPane` (400,
 * where an SVG base map lives) so floor tiles draw *on top of* the base art, and
 * below `markerPane` (600) so pins stay clickable above them.
 */
const FLOOR_TILE_PANE = 'floorTiles'
const FLOOR_TILE_PANE_Z = '450'

/**
 * Whether a floor's art has to be drawn as its own raster overlay rather than by
 * toggling a group inside the base SVG. Mirrors tarkov.dev's rule: a floor is
 * drawn as tiles when the base map is tile-based, or when the floor has no
 * `svgLayer` group to toggle (Customs' 4th Floor, Reserve's 2nd–5th, The Lab's
 * Second Level/Technical). These tile sets are alpha-transparent outside the
 * floor's footprint, so they layer over the base instead of replacing it.
 */
function floorNeedsTileOverlay(f: MapFloor, isSvgBase: boolean): boolean {
  if (!f.tilePath) return false
  return !isSvgBase || !f.svgLayer
}

/** Whether world-height range [aLo, aHi] overlaps [bLo, bHi]. */
function heightOverlaps(aLo: number, aHi: number, bLo: number, bHi: number): boolean {
  return aLo <= bHi && bLo <= aHi
}

/**
 * Best-effort floor name(s) a marker's height range falls on, for an
 * informational note in its popup — quests are never hidden by the floor
 * filter (you might still need the objective on a floor you haven't toggled
 * on), so this is how the player learns which floor to switch to. Null when
 * the map has no floors to disambiguate, or the marker carries no height data.
 */
function floorLabelFor(
  top: number | null,
  bottom: number | null,
  projection: MapProjection | null
): string | null {
  if (!projection || projection.floors.length === 0) return null
  if (top === null || bottom === null) return null
  const lo = Math.min(top, bottom)
  const hi = Math.max(top, bottom)
  const matches: string[] = []
  if (
    projection.groundHeightRange &&
    heightOverlaps(lo, hi, projection.groundHeightRange[0], projection.groundHeightRange[1])
  ) {
    matches.push('Ground')
  }
  for (const floor of projection.floors) {
    if (heightOverlaps(lo, hi, floor.minHeight, floor.maxHeight)) matches.push(floor.name)
  }
  return matches.length > 0 ? matches.join(' / ') : null
}

// ── Marker models ────────────────────────────────────────────────────────────

interface QuestMarkerObjective {
  description: string
  optional: boolean
  items: { name: string; count: number; foundInRaid: boolean }[]
  /** How many raw possible-location points were collapsed into this entry. */
  locationCount: number
}

/**
 * One pin, covering every objective of a task that landed close enough
 * together on the same map to read as "the same place" (within
 * `PROXIMITY_MERGE_METERS`) — e.g. "access the office" and "find the hard
 * drive inside it" merge into one pin with two objective entries, while a
 * separate "spot the group in the parking lot" 50m away stays its own pin.
 */
interface QuestMarker {
  taskId: string
  taskName: string
  trader: string
  kappaRequired: boolean
  wikiLink: string | null
  taskImageLink: string | null
  objectives: QuestMarkerObjective[]
  x: number
  z: number
  top: number | null
  bottom: number | null
  color: string
}

interface UnlocatedQuest {
  taskId: string
  taskName: string
  trader: string
  kappaRequired: boolean
  wikiLink: string | null
  taskImageLink: string | null
  /** Same objective shape the map popups use, so the sidebar can show the same detail. */
  objectives: QuestMarkerObjective[]
}

/**
 * A user-placed marker (Phase 4.7.3a) — local personal map knowledge, stored in
 * world (x, z) coords so it survives zoom and floor toggles, per map in
 * localStorage (`mapView.customMarkers.<norm>`). Always shown (never
 * floor-filtered), following Phase 4.1's "no height data → always show" rule.
 */
interface CustomMarker {
  id: string
  label: string
  x: number
  z: number
}

/** A handful per map keeps the layer tidy (TarkovQuestie's cap). */
const CUSTOM_MARKER_CAP = 12

interface ExtractFilter {
  pmc: boolean
  scav: boolean
  coop: boolean
  transit: boolean
}
const EXTRACT_FILTER_OFF: ExtractFilter = { pmc: false, scav: false, coop: false, transit: false }

// Distinct, dark-theme-friendly hues cycled per quest.
const PALETTE = [
  '#e0857f', '#7fb0f0', '#7fd396', '#e0c341', '#c98be0', '#5fd0d0',
  '#e0a95f', '#9db4dd', '#d67fb0', '#8fd06a', '#b48fe0', '#e07f5f'
]

function titleCase(normalized: string): string {
  return normalized
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Loose normalization of a friendly/raw map name to a projection key. */
function normalizeMapName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

/** Resolve a task's friendly map name to a known map, interactive or static-only. */
function resolveFriendlyNorm(friendly: string, projByName: Map<string, MapProjection>): string | null {
  const norm = normalizeMapName(friendly)
  const proj = projByName.get(norm)
  if (proj) return proj.normalizedName
  if (STATIC_BY_NAME.has(norm)) return norm
  return null
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function objectiveBlockHtml(o: QuestMarkerObjective): string {
  const items = o.items
    .map(
      (i) =>
        `<li>${escapeHtml(i.name)} ×${i.count}${i.foundInRaid ? ' <span class="map-fir">FIR</span>' : ''}</li>`
    )
    .join('')
  const multiLocation =
    o.locationCount > 1
      ? `<div class="map-popup-multiloc">📍 ${o.locationCount} possible spots nearby — tarkov.dev doesn't provide per-spot photos; check the wiki for location screenshots.</div>`
      : ''
  return `
    <div class="map-popup-objective">
      <div class="map-popup-obj">${o.optional ? '<span class="map-popup-opt">(Optional)</span> ' : ''}${escapeHtml(o.description)}</div>
      ${items ? `<ul class="map-popup-items">${items}</ul>` : ''}
      ${multiLocation}
    </div>`
}

function questPopupHtml(m: QuestMarker, floorLabel: string | null): string {
  const wiki = m.wikiLink
    ? `<a href="${escapeHtml(m.wikiLink)}" target="_blank" rel="noreferrer" class="map-popup-wiki">Open wiki ↗</a>`
    : ''
  const image = m.taskImageLink
    ? `<img src="${escapeHtml(m.taskImageLink)}" alt="" class="map-popup-img" />`
    : ''
  const floor = floorLabel
    ? `<div class="map-popup-floor">📍 Floor: ${escapeHtml(floorLabel)}</div>`
    : ''
  // The gallery slot is populated imperatively on `popupopen` (its wiki images
  // are fetched lazily on first click), then clicking a thumbnail opens the
  // React lightbox — see the map-build effect's popupopen handler.
  return `
    <div class="map-popup">
      <div class="map-popup-task"><span class="map-popup-swatch" style="background:${m.color}"></span>${escapeHtml(m.taskName)}${m.kappaRequired ? ' <span class="map-popup-kappa">★</span>' : ''}</div>
      <div class="map-popup-trader">${escapeHtml(m.trader)}</div>
      ${image}
      ${floor}
      ${m.objectives.map(objectiveBlockHtml).join('')}
      <div class="wiki-gallery-slot" data-task-id="${escapeHtml(m.taskId)}"></div>
      ${wiki}
    </div>`
}

const EXTRACT_TYPE_LABEL: Record<MapExtractData['type'], string> = {
  pmc: 'PMC exit',
  scav: 'Scav exit',
  shared: 'Shared (PMC or Scav)',
  coop: 'Co-op exit'
}

function extractPopupHtml(e: MapExtractData): string {
  return `<div class="map-popup"><div class="map-popup-task">🚪 ${escapeHtml(e.name)}</div><div class="map-popup-trader">${escapeHtml(EXTRACT_TYPE_LABEL[e.type])}</div></div>`
}

function transitPopupHtml(t: MapTransitData): string {
  return `<div class="map-popup"><div class="map-popup-task">🚌 Transit → ${escapeHtml(t.destination)}</div>${t.conditions ? `<div class="map-popup-obj">${escapeHtml(t.conditions)}</div>` : ''}</div>`
}

function lockPopupHtml(l: MapLockData): string {
  // Keycard doors show the keycard's own picture; regular keys stay text-only.
  const img =
    l.isKeycard && l.keyImageLink
      ? `<img src="${escapeHtml(l.keyImageLink)}" alt="" class="map-popup-keycard" />`
      : ''
  const icon = l.isKeycard ? '💳' : '🔒'
  const markedNote = l.isMarkedRoom
    ? '<div class="map-popup-marked">⭐ Marked room — Intelligence Center</div>'
    : ''
  return `<div class="map-popup"><div class="map-popup-task">${icon} ${escapeHtml(titleCase(l.lockType))}</div>${img}${l.keyName ? `<div class="map-popup-trader">${l.isKeycard ? 'Keycard' : 'Key'}: ${escapeHtml(l.keyName)}</div>` : ''}${markedNote}${l.needsPower ? '<div class="map-popup-obj">Needs power</div>' : ''}</div>`
}

/**
 * Marker icon for a lock: the keycard's picture for keycard doors (else 🔒),
 * ringed with a star badge for one of the 7 "marked room" doors so they stand
 * out from ordinary locked rooms at a glance.
 */
function lockIcon(l: MapLockData): L.DivIcon {
  const markedClass = l.isMarkedRoom ? ' map-marked-room' : ''
  const badge = l.isMarkedRoom ? '<span class="map-marked-badge">⭐</span>' : ''
  if (l.isKeycard && l.keyImageLink) {
    return divIcon(
      `<img src="${escapeHtml(l.keyImageLink)}" alt="" class="map-keycard-marker${markedClass}" />${badge}`,
      26
    )
  }
  return divIcon(`<span class="map-lock-marker${markedClass}">🔒</span>${badge}`, 16)
}

function bossPopupHtml(b: MapBossSpawnData): string {
  const escortText =
    b.escortMin === b.escortMax
      ? `${b.escortMax} guard${b.escortMax === 1 ? '' : 's'}`
      : `${b.escortMin}–${b.escortMax} guards (varies by raid — not necessarily tied to squad size)`
  return `<div class="map-popup">
    <div class="map-popup-task">💀 ${escapeHtml(b.name)}</div>
    <div class="map-popup-trader">${b.spawnChancePercent}% spawn chance — general area, exact spot is random</div>
    <div class="map-popup-obj">Escort: ${escortText}</div>
  </div>`
}

function divIcon(html: string, size: number): L.DivIcon {
  return L.divIcon({
    className: 'map-marker',
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  })
}

/**
 * User-placed marker icon: a teardrop pin whose *tip* is the anchor, so the
 * point sits exactly on the clicked coordinate. The old 📍 emoji was
 * center-anchored, so its visual tip rendered below the click — the marker
 * looked "placed too low". An SVG pin removes all emoji-glyph guesswork.
 */
function customPinIcon(): L.DivIcon {
  return L.divIcon({
    className: 'map-custom-pin',
    html: `<svg width="24" height="32" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0.5C5.6 0.5 0.5 5.6 0.5 12c0 8.6 11.5 19.5 11.5 19.5S23.5 20.6 23.5 12C23.5 5.6 18.4 0.5 12 0.5Z" fill="#5fd0d0" stroke="#14151a" stroke-width="1.5"/>
      <circle cx="12" cy="12" r="4.3" fill="#14151a"/>
    </svg>`,
    iconSize: [24, 32],
    iconAnchor: [12, 32],
    popupAnchor: [0, -30]
  })
}

export function MapView(): React.JSX.Element {
  const { tasks, progress } = useAppData()

  const [projections, setProjections] = useState<MapProjection[] | null>(null)
  const [mapNames, setMapNames] = useState<Record<string, string>>({})
  const [features, setFeatures] = useState<MapFeatureData[]>([])
  const [error, setError] = useState<string | null>(null)

  const [selectedNorm, setSelectedNorm] = usePersistedState<string | null>('mapView.selected', null)
  const [kappaOnly, setKappaOnly] = usePersistedState<boolean>('mapView.kappaOnly', false)
  // Extract/transit facet (Phase 4.7.3b): PMC / Scav / Co-op exits + transits,
  // each independently toggleable. All off by default to avoid clutter,
  // matching the previous single-checkbox default.
  const [extractFilter, setExtractFilter] = usePersistedState<ExtractFilter>(
    'mapView.extractFilter',
    EXTRACT_FILTER_OFF
  )
  const [showLocks, setShowLocks] = usePersistedState<boolean>('mapView.showLocks', false)
  const [showBosses, setShowBosses] = usePersistedState<boolean>('mapView.showBosses', false)
  const [checkedFloorsByMap, setCheckedFloorsByMap] = usePersistedState<Record<string, string[]>>(
    'mapView.checkedFloors',
    {}
  )
  const [stackedFloors, setStackedFloors] = usePersistedState<boolean>('mapView.stackedFloors', false)
  // Quests the user has muted ("hide for now") — global across maps, so muting a
  // quest means "ignore this quest", not "ignore it on Customs only". Persisted
  // as an array (localStorage/JSON has no Set); a Set is derived for lookups.
  const [mutedTaskIds, setMutedTaskIds] = usePersistedState<string[]>('mapView.mutedTaskIds', [])
  const [hiddenCollapsed, setHiddenCollapsed] = useState(true)
  // Which "also active here" quests are expanded to show their detail inline —
  // these have no map pin to click, so the sidebar is where their info lives.
  const [expandedUnlocated, setExpandedUnlocated] = useState<Set<string>>(new Set())
  const [liveMap, setLiveMap] = useState<string | null>(null)

  // Wiki location screenshots (Phase 4.65): the marker popups build their strip
  // imperatively (they live in Leaflet-owned DOM), sharing the cache + lightbox
  // with the React <WikiGallery/> used elsewhere. `openLightboxRef` lets the
  // imperative popup DOM reach the latest React setter.
  const [lightbox, setLightbox] = useState<{ images: WikiGalleryImage[]; index: number } | null>(
    null
  )
  const openLightboxRef = useRef<(images: WikiGalleryImage[], index: number) => void>(() => {})
  openLightboxRef.current = (images, index) => setLightbox({ images, index })

  const [svgText, setSvgText] = useState<string | null>(null)
  const [staticImageUrl, setStaticImageUrl] = useState<string | null>(null)
  const [staticImageSize, setStaticImageSize] = useState<{ width: number; height: number } | null>(
    null
  )

  const mapDivRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const svgElRef = useRef<SVGSVGElement | null>(null)
  const questLayerRef = useRef<L.LayerGroup | null>(null)
  const featureLayerRef = useRef<L.LayerGroup | null>(null)
  // Per-floor raster overlays (floor name → layer), added/removed as floors are
  // toggled. Only for floors whose art isn't a group inside the base SVG.
  const floorTileLayersRef = useRef<Map<string, L.TileLayer>>(new Map())
  // taskId → the first marker's latlng, for "fly to" from the legend.
  const focusRef = useRef<Map<string, L.LatLngTuple>>(new Map())

  // Load projections, friendly names, and extract/lock/boss features once.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.getMapProjections(),
      window.api.getMaps(),
      window.api.getMapFeatures()
    ])
      .then(([projs, maps, feats]: [MapProjection[], MapZoneData[], MapFeatureData[]]) => {
        if (cancelled) return
        setProjections(projs)
        setMapNames(Object.fromEntries(maps.map((m) => [m.normalizedName, m.name])))
        setFeatures(feats)
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [])

  // Track the live raid map so the picker can default to where you are.
  useEffect(() => {
    window.api.getWatcherStatus().then((s) => setLiveMap(s?.currentMap ?? null))
    return window.api.onWatcherStatus((s) => setLiveMap(s.currentMap))
  }, [])

  const states = useMemo<TaskWithStatus[]>(
    () => (tasks && progress ? deriveTaskStates(tasks, progress) : []),
    [tasks, progress]
  )

  const mutedSet = useMemo(() => new Set(mutedTaskIds), [mutedTaskIds])

  // Prune muted IDs that are no longer available (completed/locked since muting)
  // so the set doesn't accumulate stale entries across wipes/progress. Only runs
  // once real task data has loaded, so it never wipes the set while empty.
  useEffect(() => {
    if (states.length === 0) return
    const available = new Set(states.filter((t) => t.status === 'available').map((t) => t.id))
    const pruned = mutedTaskIds.filter((id) => available.has(id))
    if (pruned.length !== mutedTaskIds.length) setMutedTaskIds(pruned)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states])

  function toggleMuted(taskId: string): void {
    setMutedTaskIds(
      mutedSet.has(taskId) ? mutedTaskIds.filter((id) => id !== taskId) : [...mutedTaskIds, taskId]
    )
  }

  function toggleUnlocatedDetail(taskId: string): void {
    setExpandedUnlocated((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  // Fill a popup's (or legend detail's) gallery slot with a thumbnail strip once
  // its wiki images are known. Built imperatively because the strip lives inside
  // Leaflet-owned popup DOM; thumbnails call back into React to open the lightbox.
  const renderWikiGallery = useCallback((slot: HTMLElement, res: QuestWikiImages): void => {
    slot.textContent = ''
    if (res.images.length === 0) {
      const note = document.createElement('div')
      note.className = 'wiki-gallery-empty'
      note.textContent = res.reason ?? 'No wiki screenshots available for this quest.'
      slot.appendChild(note)
      return
    }
    const heading = document.createElement('div')
    heading.className = 'wiki-gallery-heading'
    heading.textContent = 'Wiki location photos'
    slot.appendChild(heading)

    const strip = document.createElement('div')
    strip.className = 'wiki-gallery-strip'
    res.images.forEach((img, i) => {
      // Some pages (e.g. Ambulances Again) leave gallery captions blank and put
      // the location label in the section heading instead — wikiImageLabel falls
      // back to that so the location info the caption normally carries isn't lost.
      const label = wikiImageLabel(img)
      const btn = document.createElement('button')
      btn.className = 'wiki-thumb'
      btn.type = 'button'
      btn.title = label || 'Open screenshot'
      const el = document.createElement('img')
      el.src = img.dataUrl
      el.alt = label
      el.loading = 'lazy'
      btn.appendChild(el)
      if (label) {
        const cap = document.createElement('span')
        cap.className = 'wiki-thumb-caption'
        cap.textContent = label
        btn.appendChild(cap)
      }
      btn.addEventListener('click', () => openLightboxRef.current(res.images, i))
      strip.appendChild(btn)
    })
    slot.appendChild(strip)
  }, [])

  // On popup open, lazily fetch that quest's wiki gallery (cached per task in
  // main *and* in-memory here) and inject a thumbnail strip. `popup.update()`
  // after async content lands so Leaflet re-measures and repositions the popup.
  const handlePopupOpen = useCallback(
    (e: L.PopupEvent): void => {
      const root = e.popup.getElement()
      const slot = root?.querySelector('.wiki-gallery-slot') as HTMLElement | null
      if (!slot || slot.dataset.loaded) return
      const taskId = slot.dataset.taskId
      if (!taskId) return
      slot.dataset.loaded = 'true'

      const cached = peekWikiImages(taskId)
      if (cached) {
        renderWikiGallery(slot, cached)
        e.popup.update()
        return
      }

      slot.textContent = ''
      const loading = document.createElement('div')
      loading.className = 'wiki-gallery-loading'
      loading.textContent = 'Loading wiki screenshots…'
      slot.appendChild(loading)

      loadWikiImages(taskId)
        .then((res) => {
          renderWikiGallery(slot, res)
          e.popup.update()
        })
        .catch(() => {
          slot.textContent = ''
          const err = document.createElement('div')
          err.className = 'wiki-gallery-empty'
          err.textContent = 'Couldn’t load wiki screenshots.'
          slot.appendChild(err)
          e.popup.update()
        })
    },
    [renderWikiGallery]
  )

  // normalizedName (incl. aliases) → projection, for zone lookup.
  const projByName = useMemo(() => {
    const map = new Map<string, MapProjection>()
    for (const p of projections ?? []) {
      map.set(p.normalizedName, p)
      for (const alias of p.aliases) map.set(alias, p)
    }
    return map
  }, [projections])

  const featuresByMap = useMemo(() => {
    const map = new Map<string, MapFeatureData>()
    for (const f of features) map.set(f.normalizedName, f)
    return map
  }, [features])

  // Assign each available task a stable color.
  const colorForTask = useMemo(() => {
    const colors = new Map<string, string>()
    let i = 0
    for (const t of states) {
      if (t.status !== 'available') continue
      if (!colors.has(t.id)) colors.set(t.id, PALETTE[i++ % PALETTE.length])
    }
    return colors
  }, [states])

  // Pins within this many world units of each other, for the same task on
  // the same map, are merged into one pin (see PROXIMITY_MERGE_METERS use
  // below) — chosen well above the ~3m spread of a single multi-spot
  // objective and well below the 50m+ gaps between genuinely different areas
  // (verified against "Saving the Mole": its office+hard-drive objectives are
  // ~2.6m apart and merge; its parking-lot and scientist objectives are
  // 50-76m from that and from each other, and stay separate).
  const PROXIMITY_MERGE_METERS = 15

  // All markers for available tasks, grouped by the projection they land on.
  // Two collapsing passes:
  // 1. Objectives with several possible pickup/interaction spots (e.g.
  //    "Saving the Mole"'s hard drive, findable in any of a few nearby
  //    corners — doubly so since aliased map variants like ground-zero and
  //    ground-zero-21 both contribute their own copies) collapse to one
  //    per-objective centroid.
  // 2. Different objectives of the *same task* that land close together
  //    (e.g. "access the office" then "find the hard drive inside it")
  //    further merge into a single pin covering both, while objectives that
  //    are genuinely elsewhere on the map stay separate pins.
  const markersByMap = useMemo(() => {
    interface ObjectiveGroup {
      objective: QuestMarkerObjective
      x: number
      z: number
      top: number | null
      bottom: number | null
    }
    interface TaskAccumulator {
      taskId: string
      taskName: string
      trader: string
      kappaRequired: boolean
      wikiLink: string | null
      taskImageLink: string | null
      groups: ObjectiveGroup[]
    }

    // Pass 1: per (task, objective, map) centroid. The source objective is
    // stashed alongside its positions so pass 1.5 can read its
    // description/optional/items without re-walking `states` per objective.
    const byTaskMap = new Map<string, TaskAccumulator>() // key: taskId|mapNormalizedName
    const perObjective = new Map<
      string,
      { xs: number[]; zs: number[]; top: number | null; bottom: number | null; obj: TaskWithStatus['objectives'][number] }
    >()
    const objectiveOrder = new Map<string, string[]>() // taskMapKey -> objective group keys, first-seen order

    for (const t of states) {
      if (t.status !== 'available') continue
      if (kappaOnly && !t.kappaRequired) continue
      for (const obj of t.objectives) {
        for (const zone of obj.zones) {
          const proj = projByName.get(zone.mapNormalizedName)
          if (!proj) continue
          const taskMapKey = `${t.id}|${proj.normalizedName}`
          const objKey = `${taskMapKey}|${obj.id}`

          if (!byTaskMap.has(taskMapKey)) {
            byTaskMap.set(taskMapKey, {
              taskId: t.id,
              taskName: t.name,
              trader: t.trader,
              kappaRequired: t.kappaRequired,
              wikiLink: t.wikiLink,
              taskImageLink: t.taskImageLink,
              groups: []
            })
          }

          const existing = perObjective.get(objKey)
          if (existing) {
            existing.xs.push(zone.x)
            existing.zs.push(zone.z)
          } else {
            perObjective.set(objKey, {
              xs: [zone.x],
              zs: [zone.z],
              top: zone.top,
              bottom: zone.bottom,
              obj
            })
            const order = objectiveOrder.get(taskMapKey) ?? []
            order.push(objKey)
            objectiveOrder.set(taskMapKey, order)
          }
        }
      }
    }

    for (const [taskMapKey, objKeys] of objectiveOrder) {
      const acc = byTaskMap.get(taskMapKey)!
      // The source objective (description/optional/items) was stashed alongside
      // its positions in pass 1, so no re-walk of `states` is needed here.
      for (const objKey of objKeys) {
        const p = perObjective.get(objKey)!
        const obj = p.obj
        acc.groups.push({
          objective: {
            description: obj.description,
            optional: obj.optional,
            items: obj.items.map((i) => ({ name: i.name, count: i.count, foundInRaid: i.foundInRaid })),
            locationCount: p.xs.length
          },
          x: p.xs.reduce((s, v) => s + v, 0) / p.xs.length,
          z: p.zs.reduce((s, v) => s + v, 0) / p.zs.length,
          top: p.top,
          bottom: p.bottom
        })
      }
    }

    // Pass 2: greedily cluster each task's per-objective groups by distance.
    const byMap = new Map<string, QuestMarker[]>()
    for (const [taskMapKey, acc] of byTaskMap) {
      const mapNorm = taskMapKey.split('|')[1]
      const clusters: { groups: ObjectiveGroup[]; x: number; z: number }[] = []

      for (const group of acc.groups) {
        let target = clusters.find(
          (c) => Math.hypot(c.x - group.x, c.z - group.z) <= PROXIMITY_MERGE_METERS
        )
        if (!target) {
          target = { groups: [], x: group.x, z: group.z }
          clusters.push(target)
        }
        target.groups.push(group)
        target.x = target.groups.reduce((s, g) => s + g.x, 0) / target.groups.length
        target.z = target.groups.reduce((s, g) => s + g.z, 0) / target.groups.length
      }

      const list = clusters.map((cluster) => {
        const tops = cluster.groups.map((g) => g.top).filter((v): v is number => v !== null)
        const bottoms = cluster.groups.map((g) => g.bottom).filter((v): v is number => v !== null)
        const heightKnown = tops.length === cluster.groups.length && bottoms.length === cluster.groups.length
        return {
          taskId: acc.taskId,
          taskName: acc.taskName,
          trader: acc.trader,
          kappaRequired: acc.kappaRequired,
          wikiLink: acc.wikiLink,
          taskImageLink: acc.taskImageLink,
          objectives: cluster.groups.map((g) => g.objective),
          x: cluster.x,
          z: cluster.z,
          top: heightKnown ? Math.max(...tops) : null,
          bottom: heightKnown ? Math.min(...bottoms) : null,
          color: colorForTask.get(acc.taskId) ?? PALETTE[0]
        }
      })

      const existingList = byMap.get(mapNorm) ?? []
      byMap.set(mapNorm, [...existingList, ...list])
    }
    return byMap
  }, [states, kappaOnly, projByName, colorForTask])

  // Available quests that reference a map (kill/search-anywhere objectives, or
  // maps with no coordinate data at all like Icebreaker) but have no exact zone
  // position there, so they'd otherwise vanish entirely — surfaced instead as
  // an unpinned legend entry.
  const unlocatedByMap = useMemo(() => {
    const byMap = new Map<string, UnlocatedQuest[]>()
    for (const t of states) {
      if (t.status !== 'available') continue
      if (kappaOnly && !t.kappaRequired) continue

      const pinnedMapNorms = new Set<string>()
      for (const obj of t.objectives) {
        for (const zone of obj.zones) {
          const proj = projByName.get(zone.mapNormalizedName)
          if (proj) pinnedMapNorms.add(proj.normalizedName)
        }
      }

      const addedNorms = new Set<string>()
      for (const friendly of taskMaps(t)) {
        const norm = resolveFriendlyNorm(friendly, projByName)
        if (!norm || pinnedMapNorms.has(norm) || addedNorms.has(norm)) continue
        addedNorms.add(norm)

        // Only this map's objectives — a multi-map quest (e.g. "A Shooter Born
        // in Heaven": headshot kills on Woods/Reserve/Shoreline/Streets/…)
        // should show just the current map's line, not every map's. Objectives
        // with no specific map (map-agnostic, e.g. a hand-over) apply anywhere,
        // so they're kept.
        const relevantObjectives = t.objectives.filter(
          (o) =>
            o.maps.length === 0 ||
            o.maps.some((m) => resolveFriendlyNorm(m, projByName) === norm)
        )

        const list = byMap.get(norm) ?? []
        list.push({
          taskId: t.id,
          taskName: t.name,
          trader: t.trader,
          kappaRequired: t.kappaRequired,
          wikiLink: t.wikiLink,
          taskImageLink: t.taskImageLink,
          objectives: relevantObjectives.map((o) => ({
            description: o.description,
            optional: o.optional,
            items: o.items.map((i) => ({
              name: i.name,
              count: i.count,
              foundInRaid: i.foundInRaid
            })),
            // No location merging applies to a quest with no zone data here.
            locationCount: 0
          }))
        })
        byMap.set(norm, list)
      }
    }
    return byMap
  }, [states, kappaOnly, projByName])

  // Resolve the selected map: explicit choice → live raid map → first map with
  // markers → first projection. Honors a static-reference pick (e.g.
  // Icebreaker) just as readily as a full interactive projection.
  const resolvedNorm = useMemo(() => {
    if (!projections) return null
    if (selectedNorm) {
      if (projByName.has(selectedNorm)) return projByName.get(selectedNorm)!.normalizedName
      if (STATIC_BY_NAME.has(selectedNorm)) return selectedNorm
    }
    if (liveMap) {
      const liveNorm = normalizeMapName(liveMap)
      const proj = projByName.get(liveNorm)
      if (proj) return proj.normalizedName
      if (STATIC_BY_NAME.has(liveNorm)) return liveNorm
    }
    const withMarkers = projections.find((p) => (markersByMap.get(p.normalizedName)?.length ?? 0) > 0)
    if (withMarkers) return withMarkers.normalizedName
    return projections[0]?.normalizedName ?? STATIC_REFERENCE_MAPS[0]?.normalizedName ?? null
  }, [projections, selectedNorm, liveMap, projByName, markersByMap])

  // Per-map pin count excluding muted quests, so the picker chips stay honest.
  const visibleCountByMap = useMemo(() => {
    const counts = new Map<string, number>()
    for (const [norm, list] of markersByMap) {
      counts.set(norm, list.filter((m) => !mutedSet.has(m.taskId)).length)
    }
    return counts
  }, [markersByMap, mutedSet])

  const selectedProjection = resolvedNorm ? projByName.get(resolvedNorm) ?? null : null
  const selectedStatic = resolvedNorm && !selectedProjection ? STATIC_BY_NAME.get(resolvedNorm) ?? null : null
  // Full lists for the current map (mute-agnostic) feed the "Hidden" section;
  // the mute-filtered views feed the map pins and the visible legend.
  const allMarkers = useMemo(
    () => (resolvedNorm ? markersByMap.get(resolvedNorm) ?? [] : []),
    [resolvedNorm, markersByMap]
  )
  const markers = useMemo(
    () => allMarkers.filter((m) => !mutedSet.has(m.taskId)),
    [allMarkers, mutedSet]
  )
  const allUnlocated = useMemo(
    () => (resolvedNorm ? unlocatedByMap.get(resolvedNorm) ?? [] : []),
    [resolvedNorm, unlocatedByMap]
  )
  const unlocated = useMemo(
    () => allUnlocated.filter((u) => !mutedSet.has(u.taskId)),
    [allUnlocated, mutedSet]
  )
  const mapFeatures = resolvedNorm ? featuresByMap.get(resolvedNorm) ?? null : null
  const checkedFloors = resolvedNorm ? checkedFloorsByMap[resolvedNorm] ?? [] : []


  // Per-map personal notes & custom markers (Phase 4.7.3a). Keyed by the
  // resolved map so switching maps loads that map's own note/markers
  // (usePersistedState re-reads on key change). A stable fallback key is used
  // before a map resolves so the hooks are always called in the same order.
  const notesKey = resolvedNorm ? `mapView.notes.${resolvedNorm}` : 'mapView.notes.__none'
  const markersKey = resolvedNorm
    ? `mapView.customMarkers.${resolvedNorm}`
    : 'mapView.customMarkers.__none'
  const [mapNote, setMapNote] = usePersistedState<string>(notesKey, '')
  const [customMarkers, setCustomMarkers] = usePersistedState<CustomMarker[]>(markersKey, [])
  // "Add marker" mode: while on, a map click drops a marker at that point.
  const [addMarkerMode, setAddMarkerMode] = useState(false)
  const customMarkerLayerRef = useRef<L.LayerGroup | null>(null)

  function addCustomMarker(x: number, z: number): void {
    if (customMarkers.length >= CUSTOM_MARKER_CAP) return
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setCustomMarkers([...customMarkers, { id, label: 'New marker', x, z }])
  }
  function renameCustomMarker(id: string, label: string): void {
    setCustomMarkers(customMarkers.map((m) => (m.id === id ? { ...m, label } : m)))
  }
  function deleteCustomMarker(id: string): void {
    setCustomMarkers(customMarkers.filter((m) => m.id !== id))
  }

  // Refs so the map's (stable) click handler always sees the latest add-mode
  // and add function without re-binding the listener on every state change.
  const addMarkerModeRef = useRef(addMarkerMode)
  addMarkerModeRef.current = addMarkerMode
  const addCustomMarkerRef = useRef(addCustomMarker)
  addCustomMarkerRef.current = addCustomMarker

  // Leaving a map (or turning the layer implicitly off) shouldn't strand you in
  // add-mode on the next map.
  useEffect(() => {
    setAddMarkerMode(false)
  }, [resolvedNorm])

  // Esc cancels add-mode.
  useEffect(() => {
    if (!addMarkerMode) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAddMarkerMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addMarkerMode])

  // Fetch a static reference map's image through main (as a data URL) rather
  // than hotlinking it directly: the source CDN's referrer-based hotlink
  // protection 404s a direct `<img src>` request from our app's origin.
  useEffect(() => {
    setStaticImageUrl(null)
    if (!selectedStatic) return
    let cancelled = false
    window.api
      .getStaticMapImage(selectedStatic.normalizedName, selectedStatic.imageUrl)
      .then((dataUrl) => !cancelled && setStaticImageUrl(dataUrl))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [selectedStatic])

  // Measure the static image's natural pixel size once loaded, so it can be
  // shown in a pannable/zoomable Leaflet view (L.CRS.Simple over its own
  // pixel space — not a game-world transform, since none exists for these
  // maps; just lets you navigate the picture like the interactive maps).
  useEffect(() => {
    if (!staticImageUrl) {
      setStaticImageSize(null)
      return
    }
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setStaticImageSize({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.src = staticImageUrl
    return () => {
      cancelled = true
    }
  }, [staticImageUrl])

  /** Extracts/locks are still filtered by the selected floor(s) — quests are not. */
  function floorVisible(top: number | null, bottom: number | null): boolean {
    if (stackedFloors) return true
    if (top === null || bottom === null) return true
    const lo = Math.min(top, bottom)
    const hi = Math.max(top, bottom)
    if (
      selectedProjection?.groundHeightRange &&
      heightOverlaps(lo, hi, selectedProjection.groundHeightRange[0], selectedProjection.groundHeightRange[1])
    ) {
      return true
    }
    for (const floorName of checkedFloors) {
      const floor = selectedProjection?.floors.find((f) => f.name === floorName)
      if (floor && heightOverlaps(lo, hi, floor.minHeight, floor.maxHeight)) return true
    }
    return false
  }

  function toggleFloor(name: string): void {
    if (!resolvedNorm) return
    const current = checkedFloorsByMap[resolvedNorm] ?? []
    const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name]
    setCheckedFloorsByMap({ ...checkedFloorsByMap, [resolvedNorm]: next })
  }

  // Fetch the raw SVG for the selected map (only SVG-based maps have one),
  // so its internal <g id="..."> groups can be toggled per floor — an <img>
  // overlay can't be reached into from the DOM. Always reset to null first:
  // otherwise the map-build effect below can briefly rebuild using the
  // *previous* map's leftover SVG markup while the new one is still in
  // flight (mismatched image + transform), and once the real SVG arrives and
  // triggers the "real" rebuild, nothing re-populates the fresh, empty layer
  // group it creates — quest markers silently vanish until some unrelated
  // state change (e.g. toggling Kappa-only) forces a repopulate.
  useEffect(() => {
    setSvgText(null)
    if (!selectedProjection?.svgPath) return
    let cancelled = false
    window.api
      .getMapSvg(selectedProjection.normalizedName, selectedProjection.svgPath)
      .then((text) => !cancelled && setSvgText(text))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [selectedProjection])

  // (Re)build the Leaflet map whenever the selected projection (and, for SVG
  // maps, its fetched markup) changes — or, for a static-reference map with no
  // real coordinate transform (e.g. Icebreaker), build a plain pixel-space
  // viewer over the image itself (`L.CRS.Simple` + its own natural width/
  // height as bounds) so it's still pannable/zoomable like the real maps.
  // No quest/feature markers in that case — there's no transform to place
  // them with, only the image to browse.
  useEffect(() => {
    const div = mapDivRef.current
    if (!div) return

    if (selectedProjection) {
      if (selectedProjection.svgPath && !svgText) return // still loading

      const map = L.map(div, {
        crs: getCRS(selectedProjection),
        zoomControl: true,
        attributionControl: false,
        minZoom: selectedProjection.minZoom - 2,
        maxZoom: selectedProjection.maxZoom + 1
      })

      const bounds = getBounds(selectedProjection.bounds)
      svgElRef.current = null

      // Inlining remote markup as live DOM is what makes floor toggling possible,
      // so it's scrubbed of script/handlers first rather than trusted (see
      // sanitizeSvg.ts). A null here means it didn't parse as SVG at all.
      const svgEl = svgText ? parseAndSanitizeSvg(svgText) : null

      if (selectedProjection.svgPath && svgEl) {
        // Some maps (Reserve) carry a distinct svgBounds — the art is stretched
        // across a slightly different world rectangle than the coordinate bounds;
        // using `bounds` here would offset the SVG from the pins.
        const svgBounds = selectedProjection.svgBounds
          ? getBounds(selectedProjection.svgBounds)
          : bounds
        L.svgOverlay(svgEl, svgBounds).addTo(map)
        svgElRef.current = svgEl
      } else if (selectedProjection.tilePath) {
        // tileSize must match how tarkov.dev cut the tiles (e.g. The Lab at 175,
        // not the 256 default) or Leaflet mis-registers the raster against the
        // CRS — the image scales ~tileSize/256 off the pins, worsening with
        // distance and zoom. maxNativeZoom lets Leaflet upscale past the last
        // real tile level instead of requesting tiles that don't exist.
        L.tileLayer(selectedProjection.tilePath, {
          minZoom: selectedProjection.minZoom - 2,
          maxZoom: selectedProjection.maxZoom + 1,
          maxNativeZoom: selectedProjection.maxZoom,
          tileSize: selectedProjection.tileSize ?? 256,
          noWrap: true
        }).addTo(map)
      }

      // Pane for per-floor raster overlays, above the base art (incl. an SVG
      // base in overlayPane) but below the marker pane.
      map.createPane(FLOOR_TILE_PANE)
      const floorPane = map.getPane(FLOOR_TILE_PANE)
      if (floorPane) floorPane.style.zIndex = FLOOR_TILE_PANE_Z
      floorTileLayersRef.current = new Map()
      map.fitBounds(bounds)

      questLayerRef.current = L.layerGroup().addTo(map)
      featureLayerRef.current = L.layerGroup().addTo(map)
      customMarkerLayerRef.current = L.layerGroup().addTo(map)
      mapRef.current = map

      // Lazily load + inject each quest's wiki screenshots when its popup opens.
      map.on('popupopen', handlePopupOpen)

      // Click-to-place custom markers (only while add-mode is on — read through
      // refs so this listener never needs re-binding).
      const handleMapClick = (e: L.LeafletMouseEvent): void => {
        if (!addMarkerModeRef.current) return
        addCustomMarkerRef.current(e.latlng.lng, e.latlng.lat)
        setAddMarkerMode(false)
      }
      map.on('click', handleMapClick)

      // The container is laid out after mount; make sure Leaflet measures it.
      requestAnimationFrame(() => map.invalidateSize())

      return () => {
        map.off('popupopen', handlePopupOpen)
        map.off('click', handleMapClick)
        map.remove()
        mapRef.current = null
        svgElRef.current = null
        questLayerRef.current = null
        featureLayerRef.current = null
        customMarkerLayerRef.current = null
        floorTileLayersRef.current = new Map()
      }
    }

    if (selectedStatic && staticImageUrl && staticImageSize) {
      const bounds: L.LatLngBoundsExpression = [
        [0, 0],
        [staticImageSize.height, staticImageSize.width]
      ]
      const map = L.map(div, {
        crs: L.CRS.Simple,
        zoomControl: true,
        attributionControl: false,
        minZoom: -5
      })
      L.imageOverlay(staticImageUrl, bounds).addTo(map)
      map.fitBounds(bounds)
      mapRef.current = map

      requestAnimationFrame(() => map.invalidateSize())

      return () => {
        map.remove()
        mapRef.current = null
      }
    }

    return undefined
  }, [selectedProjection, svgText, selectedStatic, staticImageUrl, staticImageSize, handlePopupOpen])

  // Apply floor show/hide + stacked-dimming to the inline SVG's groups.
  useEffect(() => {
    const svgEl = svgElRef.current
    if (!svgEl || !selectedProjection) return
    for (const floor of selectedProjection.floors) {
      if (!floor.svgLayer) continue
      const group = svgEl.querySelector(`[id="${floor.svgLayer}"]`) as SVGElement | null
      if (!group) continue
      if (stackedFloors) {
        group.style.display = ''
        group.style.opacity = '0.4'
      } else if (checkedFloors.includes(floor.name)) {
        group.style.display = ''
        group.style.opacity = '1'
      } else {
        group.style.display = 'none'
      }
    }
  }, [selectedProjection, svgText, checkedFloors, stackedFloors])

  // Raster analogue of the SVG floor effect: floors whose art isn't an SVG group
  // (The Lab's Second Level/Technical, Customs' 4th Floor, Reserve's 2nd–5th)
  // ship their own alpha-transparent tile set, which we layer over the base so
  // that floor's markers sit on the matching floor plan instead of the ground
  // art. Without this those floors' toggles changed nothing but the marker
  // filter, leaving pins over the wrong floor.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedProjection) return
    const isSvgBase = Boolean(selectedProjection.svgPath && svgText)
    const layers = floorTileLayersRef.current
    const bounds = getBounds(selectedProjection.bounds)

    for (const floor of selectedProjection.floors) {
      if (!floorNeedsTileOverlay(floor, isSvgBase)) continue
      const show = stackedFloors || checkedFloors.includes(floor.name)
      let layer = layers.get(floor.name)
      if (show) {
        if (!layer) {
          layer = L.tileLayer(floor.tilePath!, {
            pane: FLOOR_TILE_PANE,
            minZoom: selectedProjection.minZoom - 2,
            maxZoom: selectedProjection.maxZoom + 1,
            maxNativeZoom: selectedProjection.maxZoom,
            tileSize: selectedProjection.tileSize ?? 256,
            bounds,
            noWrap: true
          })
          layers.set(floor.name, layer)
        }
        // Stacked view dims every floor so the base stays readable underneath.
        layer.setOpacity(stackedFloors ? 0.5 : 1)
        if (!map.hasLayer(layer)) layer.addTo(map)
      } else if (layer && map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
    }
  }, [selectedProjection, svgText, checkedFloors, stackedFloors])

  // Repopulate quest markers whenever they change. Quests are never hidden by
  // the floor filter (you may still need to know an objective exists on a
  // floor you haven't toggled on) — each popup instead notes which floor it's
  // likely on, from the zone's height range.
  useEffect(() => {
    const layer = questLayerRef.current
    if (!layer) return
    layer.clearLayers()
    focusRef.current = new Map()

    for (const m of markers) {
      if (!focusRef.current.has(m.taskId)) focusRef.current.set(m.taskId, pos(m.x, m.z))
      L.marker(pos(m.x, m.z), {
        icon: divIcon(`<span class="map-marker-dot" style="background:${m.color}"></span>`, 16)
      })
        .bindPopup(questPopupHtml(m, floorLabelFor(m.top, m.bottom, selectedProjection)), {
          className: 'map-popup-wrap',
          maxWidth: 260
        })
        .addTo(layer)
    }
    // svgText is a dep (unused directly in the body) because the map-build
    // effect only creates the real questLayerRef once the SVG has actually
    // loaded — without it, this effect can fire before that layer exists (a
    // no-op) and never fire again once it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, selectedProjection, svgText])

  // Repopulate extract/lock/boss markers (still floor-filtered, unlike quests).
  useEffect(() => {
    const layer = featureLayerRef.current
    if (!layer) return
    layer.clearLayers()
    if (!mapFeatures) return

    for (const e of mapFeatures.extracts) {
      // `shared` exits surface under both PMC and Scav facets.
      const on =
        (extractFilter.pmc && (e.type === 'pmc' || e.type === 'shared')) ||
        (extractFilter.scav && (e.type === 'scav' || e.type === 'shared')) ||
        (extractFilter.coop && e.type === 'coop')
      if (!on) continue
      if (!floorVisible(e.top, e.bottom)) continue
      L.marker(pos(e.x, e.z), { icon: divIcon('🚪', 20) })
        .bindPopup(extractPopupHtml(e), { className: 'map-popup-wrap' })
        .addTo(layer)
    }
    if (extractFilter.transit) {
      for (const t of mapFeatures.transits) {
        if (!floorVisible(t.top, t.bottom)) continue
        L.marker(pos(t.x, t.z), { icon: divIcon('🚌', 20) })
          .bindPopup(transitPopupHtml(t), { className: 'map-popup-wrap' })
          .addTo(layer)
      }
    }
    if (showLocks) {
      for (const l of mapFeatures.locks) {
        if (!floorVisible(l.top, l.bottom)) continue
        L.marker(pos(l.x, l.z), { icon: lockIcon(l) })
          .bindPopup(lockPopupHtml(l), { className: 'map-popup-wrap' })
          .addTo(layer)
      }
    }
    if (showBosses) {
      for (const b of mapFeatures.bosses) {
        L.marker(pos(b.x, b.z), { icon: divIcon('💀', 20) })
          .bindPopup(bossPopupHtml(b), { className: 'map-popup-wrap' })
          .addTo(layer)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mapFeatures,
    extractFilter,
    showLocks,
    showBosses,
    checkedFloors,
    stackedFloors,
    selectedProjection,
    svgText
  ])

  // Repopulate user-placed custom markers. Never floor-filtered (always-show,
  // per Phase 4.1's rule for markers with no height data) — a note you dropped
  // shouldn't vanish when you toggle floors.
  useEffect(() => {
    const layer = customMarkerLayerRef.current
    if (!layer) return
    layer.clearLayers()
    for (const cm of customMarkers) {
      L.marker(pos(cm.x, cm.z), { icon: customPinIcon() })
        .bindPopup(
          `<div class="map-popup"><div class="map-popup-task">📍 ${escapeHtml(cm.label || 'Marker')}</div><div class="map-popup-trader">Your marker — edit or delete in the sidebar</div></div>`,
          { className: 'map-popup-wrap' }
        )
        .addTo(layer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customMarkers, selectedProjection, svgText])

  // Distinct quests currently pinned, for the legend, each tagged with how many
  // separate pins it's placing on the map — a quest whose objectives didn't all
  // cluster together (distinct locations further than PROXIMITY_MERGE_METERS
  // apart, e.g. Pyramid Scheme's several ATMs) shows up as multiple markers, and
  // that's usually the real source of clutter worth muting rather than any one
  // quest with a single pin.
  const legend = useMemo(() => {
    const seen = new Map<string, QuestMarker & { pinCount: number }>()
    for (const m of markers) {
      const existing = seen.get(m.taskId)
      if (existing) existing.pinCount++
      else seen.set(m.taskId, { ...m, pinCount: 1 })
    }
    return [...seen.values()].sort((a, b) => a.taskName.localeCompare(b.taskName))
  }, [markers])

  // Muted quests that would otherwise appear on this map (pinned or unlocated),
  // for the collapsed "Hidden" legend section. `color` is present only for ones
  // that had a pin, so a swatch can be shown to match the map.
  interface HiddenQuest {
    taskId: string
    taskName: string
    trader: string
    kappaRequired: boolean
    color: string | null
  }
  const hidden = useMemo(() => {
    const seen = new Map<string, HiddenQuest>()
    for (const m of allMarkers) {
      if (mutedSet.has(m.taskId) && !seen.has(m.taskId)) {
        seen.set(m.taskId, {
          taskId: m.taskId,
          taskName: m.taskName,
          trader: m.trader,
          kappaRequired: m.kappaRequired,
          color: m.color
        })
      }
    }
    for (const u of allUnlocated) {
      if (mutedSet.has(u.taskId) && !seen.has(u.taskId)) {
        seen.set(u.taskId, {
          taskId: u.taskId,
          taskName: u.taskName,
          trader: u.trader,
          kappaRequired: u.kappaRequired,
          color: null
        })
      }
    }
    return [...seen.values()].sort((a, b) => a.taskName.localeCompare(b.taskName))
  }, [allMarkers, allUnlocated, mutedSet])

  function flyToTask(taskId: string): void {
    const latlng = focusRef.current.get(taskId)
    if (latlng && mapRef.current) {
      mapRef.current.flyTo(latlng, Math.max(mapRef.current.getZoom(), mapRef.current.getMaxZoom() - 1))
    }
  }

  // (Lightbox keyboard nav — Esc / ←→ — is handled inside <WikiLightbox/> itself.)

  if (error) return <p className="error">Failed to load map data: {error}</p>
  if (!projections || !tasks || !progress) return <p>Loading maps…</p>

  const displayName = (norm: string): string => mapNames[norm] ?? titleCase(norm)
  const currentLabel = selectedProjection
    ? displayName(selectedProjection.normalizedName)
    : selectedStatic?.label ?? ''

  return (
    <div className="map-view">
      <div className="map-toolbar">
        <div className="map-picker">
          {projections.map((p) => {
            const count = visibleCountByMap.get(p.normalizedName) ?? 0
            const isLive = liveMap && normalizeMapName(liveMap) === p.normalizedName
            return (
              <button
                key={p.normalizedName}
                className={`chip${resolvedNorm === p.normalizedName ? ' active' : ''}`}
                onClick={() => setSelectedNorm(p.normalizedName)}
                title={isLive ? 'Your current raid map' : undefined}
              >
                {isLive && <span className="live-dot" />}
                {displayName(p.normalizedName)}
                {count > 0 && <span className="group-count">{count}</span>}
              </button>
            )
          })}
          {STATIC_REFERENCE_MAPS.map((m) => {
            const isLive = liveMap && normalizeMapName(liveMap) === m.normalizedName
            return (
              <button
                key={m.normalizedName}
                className={`chip static-ref${resolvedNorm === m.normalizedName ? ' active' : ''}`}
                onClick={() => setSelectedNorm(m.normalizedName)}
                title={m.note}
              >
                {isLive && <span className="live-dot" />}
                {m.label}
                <span className="static-badge">ref</span>
              </button>
            )
          })}
        </div>
        <div className="map-toolbar-toggles">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={kappaOnly}
              onChange={(e) => setKappaOnly(e.target.checked)}
            />
            Kappa quests only
          </label>
          <div className="extract-facet">
            <span className="extract-facet-label">🚪 Exits:</span>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={extractFilter.pmc}
                onChange={(e) => setExtractFilter({ ...extractFilter, pmc: e.target.checked })}
              />
              PMC
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={extractFilter.scav}
                onChange={(e) => setExtractFilter({ ...extractFilter, scav: e.target.checked })}
              />
              Scav
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={extractFilter.coop}
                onChange={(e) => setExtractFilter({ ...extractFilter, coop: e.target.checked })}
              />
              Co-op
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={extractFilter.transit}
                onChange={(e) => setExtractFilter({ ...extractFilter, transit: e.target.checked })}
              />
              🚌 Transit
            </label>
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={showLocks} onChange={(e) => setShowLocks(e.target.checked)} />
            🔒 Locked rooms
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={showBosses}
              onChange={(e) => setShowBosses(e.target.checked)}
            />
            💀 Boss spawns
          </label>
        </div>
      </div>

      {selectedProjection && selectedProjection.floors.length > 0 && (
        <div className="floor-panel">
          <span className="floor-panel-title">Floors:</span>
          <label className="floor-toggle">
            <input type="checkbox" checked disabled />
            Ground
          </label>
          {selectedProjection.floors.map((f) => (
            <label key={f.name} className="floor-toggle">
              <input
                type="checkbox"
                checked={stackedFloors || checkedFloors.includes(f.name)}
                disabled={stackedFloors}
                onChange={() => toggleFloor(f.name)}
              />
              {f.name}
            </label>
          ))}
          <label className="floor-toggle stacked-toggle">
            <input
              type="checkbox"
              checked={stackedFloors}
              onChange={(e) => setStackedFloors(e.target.checked)}
            />
            Show all floors (stacked, dimmed)
          </label>
        </div>
      )}

      <div className="map-body">
        <div
          className={`map-canvas${addMarkerMode ? ' add-marker-mode' : ''}`}
          ref={mapDivRef}
        >
          {selectedStatic && !staticImageUrl && <p className="muted map-canvas-loading">Loading reference image…</p>}
          {addMarkerMode && (
            <div className="add-marker-hint">Click the map to drop a marker · Esc to cancel</div>
          )}
        </div>
        <aside className="map-legend">
          <h3>
            {currentLabel}
            <span className="group-count">{legend.length} quests</span>
          </h3>

          {selectedStatic && <p className="map-static-note">{selectedStatic.note}</p>}

          {selectedProjection && (
            <div className="map-notes-panel">
              <h4 className="legend-subheading">Notes &amp; markers</h4>
              <textarea
                className="map-notes-input"
                placeholder="Personal notes for this map (auto-saved, local only)…"
                value={mapNote}
                onChange={(e) => setMapNote(e.target.value)}
                rows={3}
              />
              <div className="map-markers-controls">
                <button
                  className={`map-marker-add-btn${addMarkerMode ? ' active' : ''}`}
                  onClick={() => setAddMarkerMode((v) => !v)}
                  disabled={customMarkers.length >= CUSTOM_MARKER_CAP}
                  title={
                    customMarkers.length >= CUSTOM_MARKER_CAP
                      ? `Marker limit reached (${CUSTOM_MARKER_CAP})`
                      : 'Click the map to drop a marker'
                  }
                >
                  {addMarkerMode ? '✕ Cancel' : '📍 Add marker'}
                </button>
                <span className="hint">
                  {customMarkers.length}/{CUSTOM_MARKER_CAP}
                </span>
              </div>
              {customMarkers.length > 0 && (
                <ul className="map-markers-list">
                  {customMarkers.map((cm) => (
                    <li key={cm.id} className="map-marker-row">
                      <button
                        className="map-marker-focus"
                        title="Center on this marker"
                        onClick={() => mapRef.current?.setView(pos(cm.x, cm.z))}
                      >
                        📍
                      </button>
                      <input
                        className="map-marker-label-input"
                        value={cm.label}
                        onChange={(e) => renameCustomMarker(cm.id, e.target.value)}
                      />
                      <button
                        className="map-marker-delete"
                        title="Delete marker"
                        onClick={() => deleteCustomMarker(cm.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {selectedStatic?.normalizedName === 'icebreaker' && (
            <>
              <h4 className="legend-subheading">Black Division spawns (player-reported)</h4>
              <p className="hint">
                Confirmed by the user's own testing, not from tarkov.dev — no coordinates available,
                so these aren't map pins.
              </p>
              <table className="bd-spawn-table">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th className="num">Solo</th>
                    <th className="num">Duo</th>
                    <th className="num">Trio</th>
                  </tr>
                </thead>
                <tbody>
                  {ICEBREAKER_BLACK_DIVISION_SPAWNS.map((s) => (
                    <tr key={s.location}>
                      <td>{s.location}</td>
                      <td className="num">{s.solo}</td>
                      <td className="num">{s.duo}</td>
                      <td className="num">{s.trio}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {legend.length === 0 && unlocated.length === 0 && hidden.length === 0 ? (
            <p className="muted">
              No active quest objectives on this map{kappaOnly ? ' (Kappa only)' : ''}.
            </p>
          ) : (
            <ul>
              {legend.map((m) => (
                <li key={m.taskId} className="legend-row">
                  <input
                    type="checkbox"
                    className="legend-mute"
                    checked
                    title="Hide this quest from the map"
                    onChange={() => toggleMuted(m.taskId)}
                  />
                  <button className="legend-item" onClick={() => flyToTask(m.taskId)}>
                    <span className="legend-swatch" style={{ background: m.color }} />
                    <span className="legend-name">
                      {m.kappaRequired && <span className="kappa-star">★</span>}
                      {m.taskName}
                    </span>
                    {m.pinCount > 1 && (
                      <span
                        className="legend-pin-count"
                        title={`${m.pinCount} separate markers on this map`}
                      >
                        📍{m.pinCount}
                      </span>
                    )}
                    <span className="legend-trader">{m.trader}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {hidden.length > 0 && (
            <div className="legend-hidden">
              <h4 className="legend-subheading legend-hidden-header">
                <button
                  className="legend-hidden-toggle"
                  onClick={() => setHiddenCollapsed(!hiddenCollapsed)}
                >
                  <span className={`caret${hiddenCollapsed ? ' collapsed' : ''}`}>▾</span>
                  Hidden ({hidden.length})
                </button>
                <button className="legend-showall" onClick={() => setMutedTaskIds([])}>
                  Show all
                </button>
              </h4>
              {!hiddenCollapsed && (
                <ul>
                  {hidden.map((h) => (
                    <li key={h.taskId} className="legend-row legend-row-muted">
                      <input
                        type="checkbox"
                        className="legend-mute"
                        checked={false}
                        title="Show this quest on the map again"
                        onChange={() => toggleMuted(h.taskId)}
                      />
                      <div className="legend-item legend-item-static">
                        {h.color && <span className="legend-swatch" style={{ background: h.color }} />}
                        <span className="legend-name">
                          {h.kappaRequired && <span className="kappa-star">★</span>}
                          {h.taskName}
                        </span>
                        <span className="legend-trader">{h.trader}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {unlocated.length > 0 && (
            <>
              <h4 className="legend-subheading">Also active here (no exact location)</h4>
              <ul>
                {unlocated.map((u) => {
                  const isOpen = expandedUnlocated.has(u.taskId)
                  return (
                    <li key={u.taskId} className="legend-row-wrap">
                      <div className="legend-row">
                        <input
                          type="checkbox"
                          className="legend-mute"
                          checked
                          title="Hide this quest from the map"
                          onChange={() => toggleMuted(u.taskId)}
                        />
                        <button
                          className={`legend-item${isOpen ? ' expanded' : ''}`}
                          onClick={() => toggleUnlocatedDetail(u.taskId)}
                          title="Show quest details"
                        >
                          <span className={`caret${isOpen ? '' : ' collapsed'}`}>▾</span>
                          <span className="legend-name">
                            {u.kappaRequired && <span className="kappa-star">★</span>}
                            {u.taskName}
                          </span>
                          <span className="legend-trader">{u.trader}</span>
                        </button>
                      </div>
                      {isOpen && <UnlocatedDetail quest={u} />}
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          <p className="hint">
            Markers show objectives for quests you can do right now, on every floor — click one for
            details, including which floor it's likely on. Some objectives (e.g. "kill anywhere on
            this map") have no exact spot and are listed without a pin.
          </p>
        </aside>
      </div>

      {lightbox && (
        <WikiLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndex={(i) => setLightbox({ images: lightbox.images, index: i })}
        />
      )}
    </div>
  )
}

/**
 * Inline detail for an "also active here" quest — mirrors the map marker popup
 * (task image, objectives with optional/FIR tags, wiki screenshots, wiki link)
 * since these quests have no pin to click. No floor/location line: they carry no
 * zone coordinates.
 */
function UnlocatedDetail({ quest }: { quest: UnlocatedQuest }): React.JSX.Element {
  return (
    <div className="legend-detail">
      {quest.taskImageLink && (
        <img className="legend-detail-img" src={quest.taskImageLink} alt="" />
      )}
      {quest.objectives.length > 0 && (
        <ul className="legend-detail-objectives">
          {quest.objectives.map((o, i) => (
            <li key={i}>
              {o.optional && <span className="optional-tag">(Optional)</span>}
              {o.description}
              {o.items.map((item) => (
                <span key={item.name} className="objective-item">
                  {' '}
                  {item.name} ×{item.count}
                  {item.foundInRaid && <span className="fir-badge">FIR</span>}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
      <WikiGallery taskId={quest.taskId} />
      {quest.wikiLink && (
        <a className="wiki-link" href={quest.wikiLink} target="_blank" rel="noreferrer">
          Open wiki ↗
        </a>
      )}
    </div>
  )
}
