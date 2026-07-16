import type {
  TaskData,
  ItemData,
  MapZoneData,
  MapProjection,
  MapFeatureData,
  CraftData,
  AmmoData,
  HideoutStationData,
  PlayerProgress,
  Faction,
  AppSettings,
  WatcherStatus,
  LogSession,
  HistoricalImportSummary,
  QuestEventNotice,
  ScreenshotCapture,
  QuestWikiImages,
  UpdateStatus,
  OverlayStatus
} from './types'

export interface AppApi {
  getAppVersion: () => Promise<string>
  getTasks: () => Promise<TaskData[]>
  getItems: () => Promise<ItemData[]>
  getMaps: () => Promise<MapZoneData[]>
  /** Interactive-map projections (image + coordinate transform) for the map view. */
  getMapProjections: () => Promise<MapProjection[]>
  /** Extracts/locked doors/boss spawns per map, for the map view's toggle layers. */
  getMapFeatures: () => Promise<MapFeatureData[]>
  /** Raw SVG markup for one map, for inline rendering + floor-layer toggling. */
  getMapSvg: (normalizedName: string, svgPath: string) => Promise<string>
  /** A static reference-map image as a data URL (sidesteps source-CDN hotlink blocks). */
  getStaticMapImage: (normalizedName: string, url: string) => Promise<string>
  /**
   * A quest's captioned wiki location screenshots, fetched lazily and cached per
   * task. Returns an empty-with-reason result when the quest has no usable gallery.
   */
  getQuestWikiImages: (taskId: string) => Promise<QuestWikiImages>
  getCrafts: () => Promise<CraftData[]>
  /** Ballistic stats for every round, for the Ammo reference chart (Phase 4.7.1). */
  getAmmo: () => Promise<AmmoData[]>
  /** Hideout station catalog (levels + requirements), for the Hideout view (Phase 8). */
  getHideoutStations: () => Promise<HideoutStationData[]>
  getProgress: () => Promise<PlayerProgress>
  setTaskCompleted: (taskId: string, completed: boolean) => Promise<PlayerProgress>
  /** Bulk-completes many tasks in one write, for the Quest Catchup flow. */
  setTasksCompleted: (taskIds: string[]) => Promise<PlayerProgress>
  setPlayerLevel: (level: number) => Promise<PlayerProgress>
  setFaction: (faction: Faction) => Promise<PlayerProgress>
  /** Sets one hideout station's built level (0 = unbuilt), keyed by normalizedName. */
  setStationLevel: (stationNorm: string, level: number) => Promise<PlayerProgress>
  resetProgress: () => Promise<PlayerProgress>
  /**
   * Reads an image off the OS clipboard and OCRs it in main. Returns null
   * when the clipboard has no image.
   */
  captureAndOcrClipboard: () => Promise<ScreenshotCapture | null>
  /**
   * Arms the global capture hotkey (native screenshot on press). Returns
   * whether the OS accepted the accelerator, and which key it registered.
   */
  armCapture: () => Promise<{ ok: boolean; hotkey: string }>
  /** Unregisters the capture hotkey. */
  disarmCapture: () => Promise<null>
  /** A native hotkey capture landed (OCR'd), for the Quest Catchup list. */
  onCatchupCapture: (callback: (capture: ScreenshotCapture) => void) => () => void
  /** A hotkey capture failed (black frame, no screen source, etc.). */
  onCatchupCaptureError: (callback: (message: string) => void) => () => void
  onPricesUpdated: (callback: (items: ItemData[]) => void) => () => void
  /** Live craft valuations pushed on the price-refresh cadence. */
  onCraftsUpdated: (callback: (crafts: CraftData[]) => void) => () => void
  /** Manually re-fetch flea/craft prices right now (pushed via the usual update channels). */
  refreshPricesNow: () => Promise<void>

  // ── Phase 2: settings + log watcher ──
  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  getWatcherStatus: () => Promise<WatcherStatus | null>
  startWatcher: () => Promise<WatcherStatus | null>
  stopWatcher: () => Promise<WatcherStatus | null>
  pickInstallFolder: () => Promise<WatcherStatus | null>
  listLogSessions: () => Promise<LogSession[]>
  importHistorical: (sessionNames: string[]) => Promise<HistoricalImportSummary>
  /** Live progress pushed from the watcher (log-derived quest state changes). */
  onProgressUpdated: (callback: (progress: PlayerProgress) => void) => () => void
  /** Toast-worthy quest events (started/failed/finished) as they land. */
  onQuestEvents: (callback: (notices: QuestEventNotice[]) => void) => () => void
  /** Watcher status changes (install found, session switched, raid map, etc.). */
  onWatcherStatus: (callback: (status: WatcherStatus) => void) => () => void

  // ── Phase 12: in-game overlay ──
  /** Show/hide the overlay window (the same action the global hotkey performs). */
  toggleOverlay: () => Promise<OverlayStatus | null>
  getOverlayStatus: () => Promise<OverlayStatus | null>
  /** Overlay visibility / hotkey-registration changes. */
  onOverlayStatus: (callback: (status: OverlayStatus) => void) => () => void

  // ── Phase 7.3: in-app updates ──
  /** Ask main to check GitHub Releases for a newer version right now. */
  checkForUpdates: () => Promise<void>
  /** Start downloading an available update (progress arrives via onUpdateStatus). */
  downloadUpdate: () => Promise<void>
  /** Quit and install a downloaded update. No-op unless state is 'ready'. */
  installUpdate: () => Promise<void>
  /** Updater state changes (available / downloading / ready / error). */
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
}

declare global {
  interface Window {
    api: AppApi
  }
}
