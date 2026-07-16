import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { neededQuestItems } from '@shared/questEngine'
import { scoreCrafts } from '@shared/craftEngine'
import type { ItemData, CraftData } from '@shared/types'
import { useAppData } from '../state/AppDataContext'
import { usePersistedState } from '../state/usePersistedState'

const TOP_ITEMS_PER_CATEGORY = 15
const TOP_CRAFTS = 15

type ItemCategory = 'barter' | 'keys' | 'other'

const CATEGORY_LABEL: Record<ItemCategory, string> = {
  barter: 'Barter items',
  keys: 'Keys',
  other: 'Everything else'
}

const CATEGORY_ORDER: ItemCategory[] = ['barter', 'keys', 'other']

/**
 * Bucket an item, or null to exclude it. Keys stay (all of them — the Keys
 * section owns durability-blended pricing and labels it as such). Non-key
 * durability gear (weapons/armor) is excluded, since its aggregate flea price
 * understates a pristine item. Cases (`container`) are pushed out of barter.
 */
function itemCategory(item: ItemData): ItemCategory | null {
  if (item.types.includes('keys')) return 'keys'
  if (item.hasVariableDurability) return null
  if (item.types.includes('barter') && !item.types.includes('container')) return 'barter'
  return 'other'
}

/** Flea value we rank/quote by: prefer the 24h average, fall back to last-low. */
function fleaValue(item: ItemData): number | null {
  return item.avg24hPrice ?? item.lastLowPrice
}

function formatRUB(value: number | null): string {
  if (value === null) return '—'
  return `${Math.round(value).toLocaleString('en-US')} ₽`
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function TrendArrow({ percent }: { percent: number | null }): React.JSX.Element | null {
  if (percent === null || percent === 0) return <span className="trend flat">→ 0%</span>
  const up = percent > 0
  return (
    <span className={`trend ${up ? 'up' : 'down'}`}>
      {up ? '▲' : '▼'} {Math.abs(percent).toFixed(1)}%
    </span>
  )
}

function CollapsibleSection({
  title,
  count,
  collapsed,
  onToggle,
  children
}: {
  title: string
  count?: number
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="collapsible-section">
      <h2 className="group-header" onClick={onToggle}>
        <span className={`caret${collapsed ? ' collapsed' : ''}`}>▾</span>
        {title}
        {count !== undefined && <span className="group-count">{count}</span>}
      </h2>
      {!collapsed && children}
    </section>
  )
}

function ItemTable({
  items,
  questItems
}: {
  items: ItemData[]
  questItems: Map<string, string[]>
}): React.JSX.Element {
  return (
    <table className="flea-table">
      <thead>
        <tr>
          <th>Item</th>
          <th className="num">Flea</th>
          <th className="num">48h</th>
          <th className="num">Best trader</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const flea = fleaValue(item)
          const beatsFlea =
            item.bestVendorSellRUB !== null && flea !== null && item.bestVendorSellRUB > flea
          const neededBy = questItems.get(item.id)
          return (
            <tr key={item.id}>
              <td className="flea-item-cell">
                {item.iconLink && (
                  <img src={item.iconLink} alt="" className="flea-icon" loading="lazy" />
                )}
                <span>{item.name}</span>
              </td>
              <td className="num flea-price">{formatRUB(flea)}</td>
              <td className="num">
                <TrendArrow percent={item.changeLast48hPercent} />
              </td>
              <td className={`num${beatsFlea ? ' beats-flea' : ''}`}>
                {formatRUB(item.bestVendorSellRUB)}
                {item.bestVendorName && <span className="vendor-name"> {item.bestVendorName}</span>}
              </td>
              <td>
                {neededBy && (
                  <span className="quest-warn" title={`Needed for: ${neededBy.join(', ')}`}>
                    ⚠ quest
                  </span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function FleaSidebar(): React.JSX.Element {
  const { tasks, progress } = useAppData()

  const [items, setItems] = useState<ItemData[] | null>(null)
  const [crafts, setCrafts] = useState<CraftData[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [hideQuestItems, setHideQuestItems] = useState(false)

  const [sectionsCollapsed, setSectionsCollapsed] = usePersistedState<Record<string, boolean>>(
    'flea.sections.collapsed',
    {}
  )
  const [categoriesCollapsed, setCategoriesCollapsed] = usePersistedState<
    Record<ItemCategory, boolean>
  >('flea.categories.collapsed', { barter: false, keys: true, other: true })

  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.getItems(), window.api.getCrafts()])
      .then(([i, c]) => {
        if (cancelled) return
        setItems(i)
        setCrafts(c)
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [])

  // Live price/craft refresh pushed from main on the 10-minute cadence.
  useEffect(() => window.api.onPricesUpdated(setItems), [])
  useEffect(() => window.api.onCraftsUpdated(setCrafts), [])

  // Item id → names of incomplete quests needing it (the "don't sell" warning).
  const questItems = useMemo(
    () => (tasks && progress ? neededQuestItems(tasks, progress) : new Map<string, string[]>()),
    [tasks, progress]
  )

  const query = search.trim().toLowerCase()

  const categorized = useMemo(() => {
    const buckets: Record<ItemCategory, ItemData[]> = { barter: [], keys: [], other: [] }
    if (!items) return buckets

    for (const item of items) {
      if (item.flaggedNoFlea || fleaValue(item) === null) continue
      if (!query && hideQuestItems && questItems.has(item.id)) continue
      if (query) {
        const hit =
          item.name.toLowerCase().includes(query) || item.shortName.toLowerCase().includes(query)
        if (!hit) continue
      }
      const category = itemCategory(item)
      if (category === null) continue
      buckets[category].push(item)
    }

    for (const category of CATEGORY_ORDER) {
      buckets[category] = buckets[category]
        .sort((a, b) => (fleaValue(b) ?? 0) - (fleaValue(a) ?? 0))
        .slice(0, TOP_ITEMS_PER_CATEGORY)
    }

    return buckets
  }, [items, query, hideQuestItems, questItems])

  const topCrafts = useMemo(
    () => (crafts && progress ? scoreCrafts(crafts, progress, { limit: TOP_CRAFTS }) : []),
    [crafts, progress]
  )

  function toggleSection(key: string): void {
    setSectionsCollapsed({ ...sectionsCollapsed, [key]: !sectionsCollapsed[key] })
  }

  function toggleCategory(category: ItemCategory): void {
    setCategoriesCollapsed({ ...categoriesCollapsed, [category]: !categoriesCollapsed[category] })
  }

  if (error) return <p className="error">Failed to load flea data: {error}</p>
  if (!items || !crafts) return <p>Loading flea &amp; craft data…</p>

  return (
    <div className="flea-view">
      <CollapsibleSection
        title="Flea quick-cash"
        collapsed={sectionsCollapsed['flea'] === true}
        onToggle={() => toggleSection('flea')}
      >
        <p className="hint">
          Top {TOP_ITEMS_PER_CATEGORY} most valuable flea-listable items per category, by 24h
          average.
        </p>

        <div className="flea-toolbar">
          <input
            type="search"
            className="search-box"
            placeholder="Price-check any item…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {!query && (
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={hideQuestItems}
                onChange={(e) => setHideQuestItems(e.target.checked)}
              />
              Hide quest-needed items
            </label>
          )}
        </div>

        {CATEGORY_ORDER.map((category) => {
          const categoryItems = categorized[category]
          const collapsed = query ? false : categoriesCollapsed[category]
          return (
            <div key={category} className="item-category">
              <button
                className="category-header"
                onClick={() => toggleCategory(category)}
                disabled={query.length > 0}
              >
                <span className={`caret${collapsed ? ' collapsed' : ''}`}>▾</span>
                {CATEGORY_LABEL[category]}
                <span className="group-count">{categoryItems.length}</span>
              </button>
              {!collapsed &&
                (categoryItems.length === 0 ? (
                  <p className="muted">No matching items.</p>
                ) : (
                  <>
                    {category === 'keys' && (
                      <p className="caveat">
                        ⚠ Flea price is a 24h average blended across all durabilities — a
                        full-use key sells for more.
                      </p>
                    )}
                    <ItemTable items={categoryItems} questItems={questItems} />
                  </>
                ))}
            </div>
          )
        })}
      </CollapsibleSection>

      <CollapsibleSection
        title="Most profitable hideout crafts"
        collapsed={sectionsCollapsed['crafts'] === true}
        onToggle={() => toggleSection('crafts')}
      >
        <p className="hint">
          Assumes a fully-upgraded hideout. Only shows quest-locked recipes you&apos;ve unlocked.
          Ranked by profit per hour; generator fuel is not included.
        </p>

        {topCrafts.length === 0 ? (
          <p className="muted">No priced crafts available yet.</p>
        ) : (
          <table className="flea-table craft-table">
            <thead>
              <tr>
                <th>Craft</th>
                <th>Station</th>
                <th className="num">Time</th>
                <th className="num">Cost</th>
                <th className="num">Sells for</th>
                <th className="num">Profit</th>
                <th className="num">₽ / hour</th>
              </tr>
            </thead>
            <tbody>
              {topCrafts.map((c) => (
                <tr key={c.craft.id} className={c.profitRUB < 0 ? 'loss' : ''}>
                  <td>
                    {c.rewardName}
                    {c.craft.taskUnlock && (
                      <span className="unlock-note" title={`Unlocked by ${c.craft.taskUnlock.name}`}>
                        🔓 {c.craft.taskUnlock.name}
                      </span>
                    )}
                  </td>
                  <td className="muted">{c.craft.station}</td>
                  <td className="num muted">{formatDuration(c.craft.durationSeconds)}</td>
                  <td className="num">{formatRUB(c.costRUB)}</td>
                  <td className="num">{formatRUB(c.revenueRUB)}</td>
                  <td className={`num ${c.profitRUB < 0 ? 'loss-text' : 'profit-text'}`}>
                    {formatRUB(c.profitRUB)}
                  </td>
                  <td className={`num ${c.profitPerHour < 0 ? 'loss-text' : 'profit-text'}`}>
                    {formatRUB(c.profitPerHour)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CollapsibleSection>
    </div>
  )
}
