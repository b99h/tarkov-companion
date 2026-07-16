import { contextBridge, ipcRenderer } from 'electron'
import type { AppApi } from '../shared/ipc'
import type {
  ItemData,
  CraftData,
  PlayerProgress,
  QuestEventNotice,
  WatcherStatus,
  ScreenshotCapture,
  UpdateStatus
} from '../shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: AppApi = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getTasks: () => ipcRenderer.invoke('data:getTasks'),
  getItems: () => ipcRenderer.invoke('data:getItems'),
  getMaps: () => ipcRenderer.invoke('data:getMaps'),
  getMapProjections: () => ipcRenderer.invoke('data:getMapProjections'),
  getMapFeatures: () => ipcRenderer.invoke('data:getMapFeatures'),
  getMapSvg: (normalizedName, svgPath) =>
    ipcRenderer.invoke('data:getMapSvg', normalizedName, svgPath),
  getStaticMapImage: (normalizedName, url) =>
    ipcRenderer.invoke('data:getStaticMapImage', normalizedName, url),
  getQuestWikiImages: (taskId) => ipcRenderer.invoke('data:getQuestWikiImages', taskId),
  getCrafts: () => ipcRenderer.invoke('data:getCrafts'),
  getAmmo: () => ipcRenderer.invoke('data:getAmmo'),
  getHideoutStations: () => ipcRenderer.invoke('data:getHideoutStations'),
  getProgress: () => ipcRenderer.invoke('progress:get'),
  setTaskCompleted: (taskId, completed) =>
    ipcRenderer.invoke('progress:setTaskCompleted', taskId, completed),
  setTasksCompleted: (taskIds) => ipcRenderer.invoke('progress:setTasksCompleted', taskIds),
  setPlayerLevel: (level) => ipcRenderer.invoke('progress:setPlayerLevel', level),
  setFaction: (faction) => ipcRenderer.invoke('progress:setFaction', faction),
  setStationLevel: (stationNorm, level) =>
    ipcRenderer.invoke('progress:setStationLevel', stationNorm, level),
  resetProgress: () => ipcRenderer.invoke('progress:reset'),
  captureAndOcrClipboard: () => ipcRenderer.invoke('ocr:captureClipboard'),
  armCapture: () => ipcRenderer.invoke('catchup:armCapture'),
  disarmCapture: () => ipcRenderer.invoke('catchup:disarmCapture'),
  onCatchupCapture: (callback) => subscribe<ScreenshotCapture>('catchup:capture', callback),
  onCatchupCaptureError: (callback) => subscribe<string>('catchup:captureError', callback),
  onPricesUpdated: (callback) => subscribe<ItemData[]>('data:pricesUpdated', callback),
  onCraftsUpdated: (callback) => subscribe<CraftData[]>('data:craftsUpdated', callback),
  refreshPricesNow: () => ipcRenderer.invoke('data:refreshPricesNow'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  getWatcherStatus: () => ipcRenderer.invoke('watcher:getStatus'),
  startWatcher: () => ipcRenderer.invoke('watcher:start'),
  stopWatcher: () => ipcRenderer.invoke('watcher:stop'),
  pickInstallFolder: () => ipcRenderer.invoke('watcher:pickInstallFolder'),
  listLogSessions: () => ipcRenderer.invoke('logs:listSessions'),
  importHistorical: (sessionNames) => ipcRenderer.invoke('logs:import', sessionNames),
  onProgressUpdated: (callback) => subscribe<PlayerProgress>('progress:updated', callback),
  onQuestEvents: (callback) => subscribe<QuestEventNotice[]>('log:questEvents', callback),
  onWatcherStatus: (callback) => subscribe<WatcherStatus>('watcher:status', callback),

  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateStatus: (callback) => subscribe<UpdateStatus>('updates:status', callback)
}

contextBridge.exposeInMainWorld('api', api)
