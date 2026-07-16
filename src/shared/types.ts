export type Faction = 'Any' | 'Usec' | 'Bear'

export interface TaskObjectiveItem {
  id: string
  name: string
  count: number
  foundInRaid: boolean
}

export interface TaskObjective {
  id: string
  type: string
  description: string
  optional: boolean
  maps: string[]
  items: TaskObjectiveItem[]
  /**
   * Plottable in-game positions tied to this objective (zone centres plus any
   * quest-item pickup spots), each tagged with the map it belongs to. Empty for
   * turn-in / non-spatial objectives. `mapNormalizedName` matches a
   * `MapProjection.normalizedName` for the map view. `top`/`bottom` are the
   * zone's world-height range where known, used to guess which floor a marker
   * belongs to; null when tarkov.dev doesn't report it (quest-item pickup
   * spots never do).
   */
  zones: {
    mapName: string
    mapNormalizedName: string
    x: number
    y: number
    z: number
    top: number | null
    bottom: number | null
  }[]
}

/**
 * Which upstream states unlock a task requirement, straight from tarkov.dev's
 * `taskRequirements[].status`. Most requirements are `['complete']`, but a
 * meaningful minority (58 of 510 tasks, verified live 2026-07-14) accept
 * `failed` and/or `active` too — e.g. a quest that unlocks whether its
 * prerequisite was completed *or* failed, or while it's merely in progress.
 */
export type TaskRequirementStatus = 'complete' | 'failed' | 'active'

/** One prerequisite edge, with the upstream states that satisfy it (any one suffices). */
export interface TaskRequirement {
  taskId: string
  statuses: TaskRequirementStatus[]
}

export interface TaskData {
  id: string
  name: string
  trader: string
  minPlayerLevel: number
  kappaRequired: boolean
  factionName: Faction
  /** Plain prerequisite id list for graph traversal (dependents, downstream Kappa). */
  requiredTaskIds: string[]
  /** Per-requirement accepted statuses, for honest lock/completion derivation. */
  requirements: TaskRequirement[]
  objectives: TaskObjective[]
  wikiLink: string | null
  /** tarkov.dev's own task screenshot (usually shows the objective location). */
  taskImageLink: string | null
}

/**
 * One captioned screenshot pulled from a quest's Fandom wiki page gallery
 * (Phase 4.65). The caption *is* the location label ("Ambulance near the gas
 * station") and doubles as CC-BY-SA attribution, so it's always preserved and
 * shown. `dataUrl` is fetched in main and handed over as base64 to sidestep the
 * wiki CDN's referrer-based hotlink protection.
 */
export interface WikiGalleryImage {
  /** Scaled image bytes as a base64 data URL, ready to drop into an `<img src>`. */
  dataUrl: string
  /** Wiki caption — the human-readable location description + attribution. */
  caption: string
  /** The page section the gallery sat under (e.g. "Guide"), best-effort; null if unknown. */
  section: string | null
}

/**
 * A quest's wiki screenshots, keyed by task, cached in main. `images` is empty
 * (and `reason` explains why) when the task has no `wikiLink`, the page has no
 * usable gallery, or every image was filtered as noise — the UI degrades to the
 * existing "check the wiki" note rather than showing nothing unexplained.
 */
export interface QuestWikiImages {
  taskId: string
  images: WikiGalleryImage[]
  /** Set when `images` is empty, for a precise degraded-state message; null otherwise. */
  reason: string | null
}

export interface ItemData {
  id: string
  name: string
  shortName: string
  iconLink: string | null
  lastLowPrice: number | null
  avg24hPrice: number | null
  changeLast48hPercent: number | null
  flaggedNoFlea: boolean
  /** Best price a trader (not the flea market) will pay, in RUB, or null. */
  bestVendorSellRUB: number | null
  /** Name of the trader offering `bestVendorSellRUB`, or null. */
  bestVendorName: string | null
  /** Raw tarkov.dev item type tags (e.g. "barter", "keys", "wearable"). */
  types: string[]
  /**
   * True when the flea price varies by remaining durability/uses (limited-use
   * keys, weapons, armor), so the single aggregate price understates a pristine
   * item. Used to keep these out of value rankings where a clean price matters.
   */
  hasVariableDurability: boolean
}

// ── Phase 4.7.1: ammo reference chart ───────────────────────────────────────

/**
 * One round of ammunition with its ballistic stats, from tarkov.dev's `ammo`
 * query. Stats are per-projectile: for multi-pellet rounds (buckshot) `damage`
 * and `penetrationPower` describe a single pellet and `projectileCount` is the
 * pellet count, so the UI can show "×N" honestly rather than a misleading
 * single figure.
 */
export interface AmmoData {
  itemId: string
  name: string
  shortName: string
  iconLink: string | null
  /** Raw tarkov.dev caliber enum (e.g. "Caliber556x45NATO"), for grouping/filtering. */
  caliber: string
  /** Human-readable caliber label (e.g. "5.56x45mm"), derived from `caliber`. */
  caliberLabel: string
  /** Round class: bullet, buckshot, grenade, flashbang, etc. */
  ammoType: string
  penetrationPower: number
  damage: number
  armorDamage: number
  /** 0–1 chance a penetrating hit fragments; scaled to a percent for display. */
  fragmentationChance: number
  /** Pellets fired per shot (1 for single-projectile rounds, >1 for buckshot). */
  projectileCount: number
  /** Muzzle velocity in m/s. */
  initialSpeed: number
  /**
   * How this round can be obtained, for the acquisition marker. When all four
   * are false the round is found-in-raid only (no purchase/craft/barter route).
   * `flea` is currently always false — ammo isn't flea-listable in live Tarkov —
   * but kept so the marker stays honest if that ever changes.
   */
  acquisition: {
    flea: boolean
    trader: boolean
    barter: boolean
    craft: boolean
  }
}

// ── Phase 3: hideout crafts ─────────────────────────────────────────────────

/** One input or output of a hideout craft, with its best acquisition/sale price. */
export interface CraftItemRef {
  id: string
  name: string
  shortName: string
  iconLink: string | null
  count: number
  /** Cheapest way to acquire one (min over buyFor), in RUB, or null if unbuyable. */
  buyPriceRUB: number | null
  /** Best sale price for one (max over sellFor, incl. flea), in RUB, or null. */
  sellPriceRUB: number | null
}

/** A hideout production recipe from tarkov.dev, with prices baked in. */
export interface CraftData {
  id: string
  station: string
  stationNormalized: string
  /** Station module level required. Ignored while we assume a maxed hideout. */
  level: number
  /** Craft time in seconds (at base station level; fuel time not modeled). */
  durationSeconds: number
  /** Quest that unlocks this craft, or null when it's always available. */
  taskUnlock: { id: string; name: string } | null
  requiredItems: CraftItemRef[]
  rewardItems: CraftItemRef[]
}

// ── Phase 8: hideout tracking ───────────────────────────────────────────────

/**
 * One item needed to build a hideout station level. Prices are deliberately
 * not embedded — station structure is static while prices are game-mode
 * scoped, so the renderer joins against `ItemData` (already mode-correct)
 * by `itemId` instead.
 */
export interface HideoutItemRequirement {
  itemId: string
  name: string
  iconLink: string | null
  count: number
}

/** A "station X must be level N first" prerequisite edge. */
export interface HideoutStationRequirement {
  stationId: string
  name: string
  normalizedName: string
  level: number
}

export interface HideoutTraderRequirement {
  name: string
  /** Required loyalty level with this trader. */
  loyaltyLevel: number
}

export interface HideoutSkillRequirement {
  name: string
  level: number
}

/** One buildable level of a hideout station, with everything it costs. */
export interface HideoutLevelData {
  level: number
  constructionTimeSeconds: number
  itemRequirements: HideoutItemRequirement[]
  stationLevelRequirements: HideoutStationRequirement[]
  /** Displayed, not gated on — trader loyalty isn't tracked by the app. */
  traderRequirements: HideoutTraderRequirement[]
  /** Displayed, not gated on — skill levels aren't tracked by the app. */
  skillRequirements: HideoutSkillRequirement[]
  /** Craft recipe ids unlocked at this level (joins `CraftData.id`). */
  craftIds: string[]
}

export interface HideoutStationData {
  id: string
  name: string
  /** Matches `CraftData.stationNormalized` and keys `PlayerProgress.stationLevels`. */
  normalizedName: string
  imageLink: string | null
  /** Buildable levels in ascending order. */
  levels: HideoutLevelData[]
}

export interface MapZoneData {
  id: string
  name: string
  normalizedName: string
}

// ── Phase 4: interactive maps ───────────────────────────────────────────────

/**
 * A single interactive-map projection from tarkov.dev's static `maps.json`,
 * carrying everything the renderer needs to place the map image and convert
 * in-game world coordinates into Leaflet coordinates. Ported from tarkov.dev's
 * own Leaflet setup so our markers land where theirs do.
 */
export interface MapProjection {
  /** Matches `TaskObjective.zones[].mapNormalizedName` (e.g. "customs"). */
  normalizedName: string
  /** Alternate zone map names that share this geometry (e.g. "night-factory"). */
  aliases: string[]
  /** SVG map image for an inline SVG overlay, or null when the map uses tiles. */
  svgPath: string | null
  /** XYZ tile template for `L.tileLayer`, or null when the map uses an SVG. */
  tilePath: string | null
  /**
   * Pixel size of the map's raster tiles, or null to use Leaflet's 256 default.
   * tarkov.dev cuts some maps (e.g. The Lab at 175) at a non-standard tile size;
   * passing the wrong size to `L.tileLayer` mis-registers the raster against the
   * coordinate transform (the image ends up scaled ~tileSize/256 off the pins).
   */
  tileSize: number | null
  minZoom: number
  maxZoom: number
  /** [scaleX, marginX, scaleZ, marginZ] world→image transform. */
  transform: [number, number, number, number]
  /** Degrees to rotate coordinates so they align with the image. */
  coordinateRotation: number
  /** [[x, z], [x, z]] world-space corners the image is stretched across. */
  bounds: [[number, number], [number, number]]
  /**
   * Separate world-space corners the *SVG* overlay is stretched across, when it
   * differs from `bounds` (only Reserve, live 2026-07). Null → the SVG uses
   * `bounds`. Using `bounds` for these maps offsets the art from the pins.
   */
  svgBounds: [[number, number], [number, number]] | null
  /**
   * The SVG group id that renders the always-visible ground floor, or null for
   * tile-based maps. Floor toggling shows/hides the *other* groups in `floors`
   * on top of this one.
   */
  groundSvgLayer: string | null
  /** [min, max] world height covered by the ground layer, or null if unknown. */
  groundHeightRange: [number, number] | null
  /** Multi-level maps' extra floors, empty for single-level maps. */
  floors: MapFloor[]
}

/**
 * One toggleable floor/level above or below the ground layer of a multi-level
 * map (e.g. Customs' 2nd Floor, Reserve's Bunkers). Height range is flattened
 * from tarkov.dev's per-region `extents` into one overall min/max, so floor
 * assignment for markers is an approximation, not pixel-perfect.
 */
export interface MapFloor {
  name: string
  /** SVG group id to show/hide, or null when this floor has no distinct art
   * (height data only, used for marker bucketing). */
  svgLayer: string | null
  /**
   * This floor's own raster tile template, for tile-based multi-level maps
   * (e.g. The Lab's `2nd`/`technical` sets). null when the floor has no distinct
   * raster. Selecting the floor swaps the base tile image to this so upper-floor
   * markers sit on the matching floor plan instead of the ground image.
   */
  tilePath: string | null
  minHeight: number
  maxHeight: number
}

/**
 * How an extract is used, for the map view's extract-type facet. Derived from
 * tarkov.dev's `faction` (pmc/scav/shared) plus a name check for co-op exits —
 * the API has no dedicated co-op flag, but co-op extracts are consistently
 * named "… (Co-op)" and always carry faction "shared". `shared` exits (usable
 * by either faction, and not co-op) surface under both the PMC and Scav facets.
 */
export type MapExtractType = 'pmc' | 'scav' | 'shared' | 'coop'

/** A single map extract, for the map view's extract toggle layer. */
export interface MapExtractData {
  name: string
  /** null when usable by both factions (e.g. co-op/shared extracts). */
  faction: string | null
  type: MapExtractType
  x: number
  y: number
  z: number
  top: number | null
  bottom: number | null
}

/**
 * A transit — a ride to another map (a separate tarkov.dev `Map.transits`
 * field, not an extract). Plotted on its own facet alongside the extract types.
 */
export interface MapTransitData {
  /** Friendly name of the destination map. */
  destination: string
  /** Normalized destination map name (for switching to it, if wanted later). */
  destinationNorm: string
  description: string | null
  conditions: string | null
  x: number
  y: number
  z: number
  top: number | null
  bottom: number | null
}

/** A locked door/container, for the map view's locks toggle layer. */
export interface MapLockData {
  lockType: string
  keyName: string | null
  /**
   * True when the key is a keycard (tarkov.dev item category "keycard"), as
   * opposed to a regular mechanical key. The map view renders keycard doors
   * with the keycard's own picture instead of the generic lock icon.
   */
  isKeycard: boolean
  /** The key/keycard's item icon URL, for the marker (keycards) and popups. */
  keyImageLink: string | null
  /**
   * True for one of the 7 "marked room" doors (e.g. Dorm room 314) — every
   * marked key's tarkov.dev item name literally contains "marked key", so this
   * is a live-data check, not a curated list. The map view rings these locks
   * with a star to call out their Intelligence Center relevance.
   */
  isMarkedRoom: boolean
  needsPower: boolean
  x: number
  y: number
  z: number
  top: number | null
  bottom: number | null
}

/** A boss (or boss-tier scav) spawn point, for the map view's bosses toggle layer. */
export interface MapBossSpawnData {
  name: string
  spawnChancePercent: number
  x: number
  y: number
  z: number
  /**
   * Escort/guard count range observed across tarkov.dev's spawn variants for
   * this boss+zone. Not tied to raid squad size — that mapping isn't present
   * in the source data — just the honest min–max actually seen. Equal when
   * only one variant exists.
   */
  escortMin: number
  escortMax: number
}

/** Extracts/transits/locks/boss spawns for one map, keyed to join with `MapProjection`. */
export interface MapFeatureData {
  normalizedName: string
  extracts: MapExtractData[]
  transits: MapTransitData[]
  locks: MapLockData[]
  bosses: MapBossSpawnData[]
}

export type TaskStatus = 'completed' | 'available' | 'locked' | 'level-locked' | 'faction-locked'

export interface PlayerProgress {
  completedTaskIds: string[]
  failedTaskIds: string[]
  playerLevel: number
  faction: Faction
  /**
   * Built hideout station levels, keyed by station `normalizedName` (matches
   * `CraftData.stationNormalized` for craft gating); a missing key means
   * unbuilt (level 0). Manual input — hideout builds never appear in the game
   * logs. Cleared by a wipe reset (the hideout resets on wipe), unlike map
   * notes/markers which deliberately survive.
   */
  stationLevels: Record<string, number>
}

export interface TaskWithStatus extends TaskData {
  status: TaskStatus
  blockedByTaskIds: string[]
}

export interface NextTarget {
  task: TaskWithStatus
  score: number
  reasons: string[]
}

export interface KappaProgress {
  completed: number
  total: number
  percent: number
}

// ── Phase 2: log watcher ────────────────────────────────────────────────────

/** Game mode. Tarkov logs both to the same folder; this is a user preference. */
export type LogProfile = 'pve' | 'pvp'

/** A quest state-change parsed from `notifications.log`. */
export type TaskEventType = 'started' | 'failed' | 'finished'

export interface TaskLogEvent {
  /** BSG quest template id === tarkov.dev task id. */
  taskId: string
  type: TaskEventType
  /** Epoch ms from the message's `dt`, or null if unavailable. */
  timestamp: number | null
}

/** A single map/raid transition parsed from `application.log` (best-effort). */
export type RaidEventType = 'start' | 'end'

export interface RaidLogEvent {
  type: RaidEventType
  /** Friendly map name (e.g. "Customs"), or null if the code was unrecognized. */
  map: string | null
  timestamp: number | null
}

export type InstallSource = 'registry-bsg' | 'registry-steam' | 'manual' | 'not-found'

export interface InstallInfo {
  /** Absolute path to the game install root (parent of `Logs`), or null. */
  installPath: string | null
  source: InstallSource
}

/** One per-session log folder under `<install>\Logs\`. */
export interface LogSession {
  folder: string
  name: string
  /** Parsed from the folder name, epoch ms, or null. */
  startedAt: number | null
  /** Already applied to progress via historical import. */
  imported: boolean
}

export interface AppSettings {
  /** Manual override; when set, takes precedence over registry discovery. */
  installPath: string | null
  profile: LogProfile
  /** Folder names already replayed into progress. */
  importedSessions: string[]
  /** Start tailing the active log automatically on launch. */
  autoWatch: boolean
  /**
   * Global hotkey (Electron accelerator syntax, e.g. "F1") that snaps a native
   * screenshot for Quest Catchup while capture mode is armed. Configurable so a
   * game rebinding the default can be worked around.
   */
  captureHotkey: string
  /**
   * Global hotkey (accelerator syntax) that shows/hides the in-game overlay
   * (Phase 12). Registered for the app's whole lifetime, unlike the capture
   * hotkey which only lives while capture mode is armed.
   */
  overlayHotkey: string
  /** Register the app to start (hidden, via `--hidden`) when Windows logs in. */
  launchAtStartup: boolean
  /** Closing the window hides it to the tray instead of quitting the app. */
  minimizeToTray: boolean
}

/** Overlay window state, pushed whenever visibility or hotkey registration changes. */
export interface OverlayStatus {
  visible: boolean
  hotkey: string
  /** False when the OS refused the accelerator (e.g. another app owns the key). */
  hotkeyRegistered: boolean
}

export interface WatcherStatus {
  installPath: string | null
  installSource: InstallSource
  profile: LogProfile
  watching: boolean
  /** Folder name of the session currently being tailed, or null. */
  activeSession: string | null
  lastEventAt: number | null
  /** Best-effort current raid map from application.log, or null. */
  currentMap: string | null
  /**
   * Whether the task catalog was successfully seeded. When false (e.g. launched
   * offline with no cache), live quest events can't be recognized and are
   * dropped until a seed retry succeeds — surfaced so the UI can say so.
   */
  taskDataAvailable: boolean
}

export interface HistoricalImportSummary {
  sessionsScanned: number
  eventsApplied: number
  tasksCompleted: number
  tasksFailed: number
}

/** Payload pushed to the renderer when a live quest event lands, for toasts. */
export interface QuestEventNotice {
  taskId: string
  taskName: string
  type: TaskEventType
  timestamp: number | null
}

// ── Quest Catchup: OCR-driven bulk progress inference ──────────────────────

/** One screenshot pasted into the Quest Catchup flow, plus its recognized text. */
export interface ScreenshotCapture {
  id: string
  /** PNG data URL, for the review-list thumbnail. */
  dataUrl: string
  lines: string[]
}

/** A candidate task match for one OCR'd line, with a 0-1 similarity score. */
export interface OcrMatchCandidate {
  taskId: string
  taskName: string
  confidence: number
}

/**
 * One OCR'd line matched against the task catalog. `matchedTaskId` is the
 * best candidate (or null if nothing cleared the confidence floor);
 * `candidates` holds the top few alternatives so an ambiguous match can be
 * corrected manually instead of trusting the top score blindly.
 */
export interface OcrMatch {
  line: string
  /**
   * Stable per-occurrence identifier (the line's index in the input), so two
   * identical lines from different screenshots stay distinct — keying UI state
   * (React keys, manual-pick selections) by raw line text collides them.
   */
  key: string
  matchedTaskId: string | null
  candidates: OcrMatchCandidate[]
}

// ── Phase 7.3: in-app updates ───────────────────────────────────────────────

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

/** Pushed from main over `updates:status` whenever the updater's state moves. */
export interface UpdateStatus {
  state: UpdateState
  /** The remote version, once known ('available' onward). */
  version?: string
  /** Download progress 0-100, while 'downloading'. */
  percent?: number
  /** Human-readable failure, when 'error'. */
  message?: string
  /**
   * True when running as the portable exe, which cannot self-update — the
   * renderer shows a download link instead of the update button.
   */
  portable?: boolean
}
