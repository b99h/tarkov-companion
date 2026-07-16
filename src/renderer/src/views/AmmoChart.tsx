import { useEffect, useMemo, useState } from 'react'
import type { AmmoData } from '@shared/types'
import { usePersistedState } from '../state/usePersistedState'

type SortKey =
  | 'caliber'
  | 'name'
  | 'penetrationPower'
  | 'damage'
  | 'armorDamage'
  | 'fragmentationChance'
  | 'initialSpeed'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

// Numeric columns default to descending (best-first); text columns to ascending.
const DESC_BY_DEFAULT: Set<SortKey> = new Set([
  'penetrationPower',
  'damage',
  'armorDamage',
  'fragmentationChance',
  'initialSpeed'
])

/**
 * Community penetration banding (the standard 6-tier green→red chart). Higher
 * penetration is better for the shooter, so tier 6 (≥60) reads green and tier 1
 * (<20) reads red. Used only for the at-a-glance colour of the pen column.
 */
function penTier(pen: number): number {
  if (pen >= 60) return 6
  if (pen >= 50) return 5
  if (pen >= 40) return 4
  if (pen >= 30) return 3
  if (pen >= 20) return 2
  return 1
}

function comparator(sort: SortState): (a: AmmoData, b: AmmoData) => number {
  const factor = sort.dir === 'asc' ? 1 : -1
  return (a, b) => {
    let diff: number
    switch (sort.key) {
      case 'caliber':
        diff = a.caliberLabel.localeCompare(b.caliberLabel)
        break
      case 'name':
        diff = a.name.localeCompare(b.name)
        break
      default:
        diff = a[sort.key] - b[sort.key]
    }
    // Stable tiebreak by name so equal rows don't jitter between renders.
    if (diff === 0) diff = a.name.localeCompare(b.name)
    return diff * factor
  }
}

const COLUMNS: { key: SortKey; label: string; num: boolean }[] = [
  { key: 'caliber', label: 'Caliber', num: false },
  { key: 'name', label: 'Round', num: false },
  { key: 'penetrationPower', label: 'Pen', num: true },
  { key: 'damage', label: 'Damage', num: true },
  { key: 'armorDamage', label: 'Armor %', num: true },
  { key: 'fragmentationChance', label: 'Frag %', num: true },
  { key: 'initialSpeed', label: 'Velocity', num: true }
]

/** Acquisition badges: how a round can be obtained, or FIR-only when none apply. */
function SourceBadges({ acq }: { acq: AmmoData['acquisition'] }): React.JSX.Element {
  const badges: { cls: string; label: string; title: string }[] = []
  if (acq.flea) badges.push({ cls: 'src-flea', label: 'Flea', title: 'Buyable on the flea market' })
  if (acq.trader) badges.push({ cls: 'src-trader', label: 'Trader', title: 'Buyable from a trader' })
  if (acq.barter) badges.push({ cls: 'src-barter', label: 'Barter', title: 'Available via a trader barter' })
  if (acq.craft) badges.push({ cls: 'src-craft', label: 'Craft', title: 'Craftable in the hideout' })
  if (badges.length === 0) {
    badges.push({ cls: 'src-fir', label: 'FIR only', title: 'Found in raid only — no purchase, barter, or craft' })
  }
  return (
    <span className="src-badges">
      {badges.map((b) => (
        <span key={b.label} className={`src-badge ${b.cls}`} title={b.title}>
          {b.label}
        </span>
      ))}
    </span>
  )
}

export function AmmoChart(): React.JSX.Element {
  const [ammo, setAmmo] = useState<AmmoData[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [caliberFilter, setCaliberFilter] = useState('')
  const [sort, setSort] = usePersistedState<SortState>('ammo.sort', {
    key: 'caliber',
    dir: 'asc'
  })

  useEffect(() => {
    let cancelled = false
    window.api
      .getAmmo()
      .then((a) => !cancelled && setAmmo(a))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [])

  // Distinct calibers (label + raw enum) for the filter dropdown, alphabetized.
  const calibers = useMemo(() => {
    if (!ammo) return []
    const seen = new Map<string, string>()
    for (const a of ammo) seen.set(a.caliber, a.caliberLabel)
    return [...seen.entries()]
      .map(([caliber, label]) => ({ caliber, label }))
      .sort((x, y) => x.label.localeCompare(y.label))
  }, [ammo])

  const query = search.trim().toLowerCase()

  const rows = useMemo(() => {
    if (!ammo) return []
    const filtered = ammo.filter((a) => {
      if (caliberFilter && a.caliber !== caliberFilter) return false
      if (query) {
        return (
          a.name.toLowerCase().includes(query) || a.shortName.toLowerCase().includes(query)
        )
      }
      return true
    })
    return filtered.sort(comparator(sort))
  }, [ammo, caliberFilter, query, sort])

  function toggleSort(key: SortKey): void {
    if (sort.key === key) {
      setSort({ key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })
    } else {
      setSort({ key, dir: DESC_BY_DEFAULT.has(key) ? 'desc' : 'asc' })
    }
  }

  if (error) return <p className="error">Failed to load ammo data: {error}</p>
  if (!ammo) return <p>Loading ammo data…</p>

  return (
    <div className="ammo-view">
      <div className="ammo-toolbar">
        <input
          type="search"
          className="search-box"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="ammo-caliber-select"
          value={caliberFilter}
          onChange={(e) => setCaliberFilter(e.target.value)}
        >
          <option value="">All calibers</option>
          {calibers.map((c) => (
            <option key={c.caliber} value={c.caliber}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="ammo-count">{rows.length} rounds</span>
      </div>

      <p className="hint">
        Penetration is colour-banded green (high) → red (low). Buckshot stats are per pellet;
        the pellet count is shown next to the round.
      </p>

      <table className="flea-table ammo-table">
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className={`sortable${col.num ? ' num' : ''}`}
                onClick={() => toggleSort(col.key)}
              >
                {col.label}
                {sort.key === col.key && (
                  <span className="sort-arrow">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>
                )}
              </th>
            ))}
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.itemId}>
              <td className="muted">{a.caliberLabel}</td>
              <td className="flea-item-cell">
                {a.iconLink && (
                  <img src={a.iconLink} alt="" className="flea-icon" loading="lazy" />
                )}
                <span>{a.name}</span>
                {a.projectileCount > 1 && (
                  <span className="pellet-count" title={`${a.projectileCount} pellets per shot`}>
                    ×{a.projectileCount}
                  </span>
                )}
              </td>
              <td className={`num pen-cell pen-t${penTier(a.penetrationPower)}`}>
                {a.penetrationPower}
              </td>
              <td className="num">{a.damage}</td>
              <td className="num">{a.armorDamage}</td>
              <td className="num">{Math.round(a.fragmentationChance * 100)}%</td>
              <td className="num muted">{a.initialSpeed} m/s</td>
              <td>
                <SourceBadges acq={a.acquisition} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {rows.length === 0 && <p className="muted">No rounds match your filters.</p>}
    </div>
  )
}
