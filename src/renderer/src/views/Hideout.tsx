import { useEffect, useMemo, useState } from 'react'
import {
  stationLevel,
  maxStationLevel,
  nextLevel,
  checkStationPrereqs,
  remainingRequirements
} from '@shared/hideoutEngine'
import type { HideoutStationData, ItemData } from '@shared/types'
import { useAppData } from '../state/AppDataContext'
import { usePersistedState } from '../state/usePersistedState'
import { CollapsibleSection } from './CollapsibleSection'

function formatRUB(value: number | null): string {
  if (value === null) return '—'
  return `${Math.round(value).toLocaleString('en-US')} ₽`
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'instant'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** Flea value used for cost estimates: 24h average, falling back to last-low. */
function fleaValue(item: ItemData | undefined): number | null {
  if (!item) return null
  return item.avg24hPrice ?? item.lastLowPrice
}

const ROUBLES_ID = '5449016a4bdc2d6f028b456f'

export function Hideout(): React.JSX.Element {
  const { progress, updateStationLevel } = useAppData()

  const [stations, setStations] = useState<HideoutStationData[] | null>(null)
  const [items, setItems] = useState<ItemData[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [hideMaxed, setHideMaxed] = usePersistedState('hideout.hideMaxed', false)
  const [hoardCollapsed, setHoardCollapsed] = usePersistedState('hideout.hoard.collapsed', false)
  const [stationsCollapsed, setStationsCollapsed] = usePersistedState(
    'hideout.stations.collapsed',
    false
  )

  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.getHideoutStations(), window.api.getItems()])
      .then(([s, i]) => {
        if (cancelled) return
        setStations([...s].sort((a, b) => a.name.localeCompare(b.name)))
        setItems(i)
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => window.api.onPricesUpdated(setItems), [])

  const itemById = useMemo(() => {
    const map = new Map<string, ItemData>()
    for (const item of items ?? []) map.set(item.id, item)
    return map
  }, [items])

  const levels = progress?.stationLevels ?? {}

  const remaining = useMemo(
    () => (stations ? remainingRequirements(stations, levels) : { items: [], cash: [] }),
    [stations, levels]
  )

  const builtLevels = useMemo(() => {
    if (!stations) return { built: 0, total: 0 }
    let built = 0
    let total = 0
    for (const s of stations) {
      total += maxStationLevel(s)
      built += Math.min(stationLevel(levels, s.normalizedName), maxStationLevel(s))
    }
    return { built, total }
  }, [stations, levels])

  async function setAllToMax(): Promise<void> {
    if (!stations) return
    for (const s of stations) {
      if (stationLevel(levels, s.normalizedName) < maxStationLevel(s)) {
        await updateStationLevel(s.normalizedName, maxStationLevel(s))
      }
    }
  }

  async function resetAll(): Promise<void> {
    if (!stations) return
    if (!window.confirm('Reset every hideout station to level 0?')) return
    for (const s of stations) {
      if (stationLevel(levels, s.normalizedName) > 0) {
        await updateStationLevel(s.normalizedName, 0)
      }
    }
  }

  if (error) return <p className="error">Failed to load hideout data: {error}</p>
  if (!stations || !progress) return <p>Loading hideout data…</p>

  const visibleStations = hideMaxed
    ? stations.filter((s) => stationLevel(levels, s.normalizedName) < maxStationLevel(s))
    : stations

  return (
    <div className="hideout-view">
      <div className="hideout-toolbar">
        <span className="hideout-progress">
          {builtLevels.built} / {builtLevels.total} station levels built
        </span>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={hideMaxed}
            onChange={(e) => setHideMaxed(e.target.checked)}
          />
          Hide maxed stations
        </label>
        <button className="small-button" onClick={() => void setAllToMax()}>
          Set all to max
        </button>
        <button className="small-button danger" onClick={() => void resetAll()}>
          Reset all levels
        </button>
      </div>
      <p className="hint">
        Station levels are manual — hideout builds don&apos;t appear in the game logs. Trader
        loyalty and skill requirements are shown for reference but not tracked.
      </p>

      <CollapsibleSection
        title="Items to hoard for hideout"
        count={remaining.items.length}
        collapsed={hoardCollapsed}
        onToggle={() => setHoardCollapsed(!hoardCollapsed)}
      >
        {remaining.items.length === 0 && remaining.cash.length === 0 ? (
          <p className="muted">Nothing left — every station is at max level.</p>
        ) : (
          <>
            {remaining.cash.length > 0 && (
              <p className="hint">
                Cash still needed:{' '}
                {remaining.cash
                  .map((c) =>
                    c.itemId === ROUBLES_ID
                      ? formatRUB(c.total)
                      : `${c.total.toLocaleString('en-US')} ${c.name}`
                  )
                  .join(' + ')}
              </p>
            )}
            <table className="flea-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Needed</th>
                  <th className="num">Flea (each)</th>
                  <th>For</th>
                </tr>
              </thead>
              <tbody>
                {remaining.items.map((entry) => (
                  <tr key={entry.itemId}>
                    <td className="flea-item-cell">
                      {entry.iconLink && (
                        <img src={entry.iconLink} alt="" className="flea-icon" loading="lazy" />
                      )}
                      <span>{entry.name}</span>
                    </td>
                    <td className="num">×{entry.totalCount}</td>
                    <td className="num">{formatRUB(fleaValue(itemById.get(entry.itemId)))}</td>
                    <td className="muted hoard-needs">
                      {entry.needs.map((n) => `${n.station} ${n.level} ×${n.count}`).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        title="Stations"
        count={visibleStations.length}
        collapsed={stationsCollapsed}
        onToggle={() => setStationsCollapsed(!stationsCollapsed)}
      >
        <div className="station-grid">
          {visibleStations.map((station) => {
            const current = stationLevel(levels, station.normalizedName)
            const max = maxStationLevel(station)
            const next = nextLevel(station, levels)
            const prereqs = next ? checkStationPrereqs(next, levels) : []
            const blocked = prereqs.filter((p) => !p.met)
            return (
              <div key={station.id} className="station-card">
                <div className="station-card-header">
                  {station.imageLink && (
                    <img src={station.imageLink} alt="" className="station-image" loading="lazy" />
                  )}
                  <div>
                    <h3>{station.name}</h3>
                    <div className="station-level-controls">
                      <button
                        className="small-button"
                        disabled={current <= 0}
                        onClick={() => void updateStationLevel(station.normalizedName, current - 1)}
                      >
                        −
                      </button>
                      <span className="station-level">
                        {current} / {max}
                      </span>
                      <button
                        className="small-button"
                        disabled={current >= max}
                        onClick={() => void updateStationLevel(station.normalizedName, current + 1)}
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {next === null ? (
                  <p className="station-maxed">Maxed ✓</p>
                ) : (
                  <div className="station-next">
                    <div className="station-next-header">
                      <span>Level {next.level} needs:</span>
                      <span className="muted">{formatDuration(next.constructionTimeSeconds)}</span>
                      {blocked.length === 0 ? (
                        <span className="station-ready">ready to build</span>
                      ) : (
                        <span className="station-blocked">
                          blocked by {blocked.map((p) => `${p.name} ${p.requiredLevel}`).join(', ')}
                        </span>
                      )}
                    </div>
                    <ul className="station-reqs">
                      {next.itemRequirements.map((req) => (
                        <li key={req.itemId}>
                          {req.iconLink && (
                            <img src={req.iconLink} alt="" className="flea-icon" loading="lazy" />
                          )}
                          {req.itemId === ROUBLES_ID ? (
                            <span>{formatRUB(req.count)}</span>
                          ) : (
                            <span>
                              {req.name} ×{req.count}
                              <span className="muted req-price">
                                {' '}
                                {formatRUB(fleaValue(itemById.get(req.itemId)))} ea
                              </span>
                            </span>
                          )}
                        </li>
                      ))}
                      {prereqs.map((p) => (
                        <li
                          key={`station-${p.normalizedName}`}
                          className={p.met ? 'req-met' : 'req-unmet'}
                        >
                          {p.name} level {p.requiredLevel} {p.met ? '✓' : `(now ${p.currentLevel})`}
                        </li>
                      ))}
                      {next.traderRequirements.map((t) => (
                        <li key={`trader-${t.name}`} className="muted">
                          {t.name} loyalty {t.loyaltyLevel} (not tracked)
                        </li>
                      ))}
                      {next.skillRequirements.map((s) => (
                        <li key={`skill-${s.name}`} className="muted">
                          {s.name} skill {s.level} (not tracked)
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </CollapsibleSection>
    </div>
  )
}
