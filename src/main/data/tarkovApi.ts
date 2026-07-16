import type {
  TaskData,
  TaskRequirementStatus,
  ItemData,
  MapZoneData,
  CraftData,
  CraftItemRef,
  MapFeatureData,
  MapExtractType,
  MapBossSpawnData,
  AmmoData
} from '../../shared/types'

const ENDPOINT = 'https://api.tarkov.dev/graphql'

/**
 * tarkov.dev market/craft game mode. The API defaults to `regular` (PvP); PvE
 * has its own, wildly different economy, so price-sensitive queries (items,
 * crafts) must pass the player's mode explicitly. Confirmed live: the enum is
 * exactly `regular` | `pve`.
 */
export type GameMode = 'regular' | 'pve'

async function graphql<T>(query: string): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  })

  if (!res.ok) {
    throw new Error(`tarkov.dev API request failed: ${res.status} ${res.statusText}`)
  }

  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (json.errors?.length) {
    throw new Error(`tarkov.dev API error: ${json.errors.map((e) => e.message).join('; ')}`)
  }
  if (!json.data) {
    throw new Error('tarkov.dev API returned no data')
  }
  return json.data
}

// `zones` (and `items`/`count`/`foundInRaid`) live on the concrete objective
// subtypes, not the `TaskObjective` interface, so they must be requested through
// inline fragments — querying them on the base type is a schema error that fails
// the whole request. All five subtypes carry `zones`; only the item objective
// carries the item fields; only the quest-item objective carries
// `possibleLocations` (where a plantable/findable quest item can be picked up),
// which we fold into the plottable positions for the map view.
const ZONE_FIELDS = `zones { map { name normalizedName } position { x y z } top bottom }`

const TASKS_QUERY = `{
  tasks(lang: en) {
    id
    name
    minPlayerLevel
    kappaRequired
    factionName
    wikiLink
    taskImageLink
    trader { name }
    taskRequirements { task { id } status }
    objectives {
      id
      type
      description
      optional
      maps { name }
      ... on TaskObjectiveBasic { ${ZONE_FIELDS} }
      ... on TaskObjectiveMark { ${ZONE_FIELDS} }
      ... on TaskObjectiveShoot { ${ZONE_FIELDS} }
      ... on TaskObjectiveQuestItem {
        ${ZONE_FIELDS}
        possibleLocations { map { name normalizedName } positions { x y z } }
      }
      ... on TaskObjectiveItem {
        ${ZONE_FIELDS}
        items { id name }
        count
        foundInRaid
      }
    }
  }
}`

interface RawTask {
  id: string
  name: string
  minPlayerLevel: number | null
  kappaRequired: boolean
  factionName: string | null
  wikiLink: string | null
  taskImageLink: string | null
  trader: { name: string } | null
  taskRequirements: { task: { id: string }; status: string[] | null }[]
  objectives: {
    id: string
    type: string
    description: string
    optional: boolean
    maps: { name: string }[]
    zones?: {
      map: { name: string; normalizedName: string } | null
      position: { x: number; y: number; z: number } | null
      top: number | null
      bottom: number | null
    }[]
    possibleLocations?: {
      map: { name: string; normalizedName: string } | null
      positions: { x: number; y: number; z: number }[]
    }[]
    items?: { id: string; name: string }[]
    count?: number
    foundInRaid?: boolean
  }[]
}

/** Flatten zones + quest-item possible-locations into plottable map positions. */
function mapObjectiveZones(o: RawTask['objectives'][number]): TaskData['objectives'][number]['zones'] {
  const out: TaskData['objectives'][number]['zones'] = []

  for (const z of o.zones ?? []) {
    if (!z.map || !z.position) continue
    out.push({
      mapName: z.map.name,
      mapNormalizedName: z.map.normalizedName,
      x: z.position.x,
      y: z.position.y,
      z: z.position.z,
      top: z.top,
      bottom: z.bottom
    })
  }

  for (const loc of o.possibleLocations ?? []) {
    if (!loc.map) continue
    for (const p of loc.positions) {
      out.push({
        mapName: loc.map.name,
        mapNormalizedName: loc.map.normalizedName,
        x: p.x,
        y: p.y,
        z: p.z,
        top: null,
        bottom: null
      })
    }
  }

  return out
}

function normalizeFaction(raw: string | null): TaskData['factionName'] {
  if (raw === 'Usec' || raw === 'Bear') return raw
  return 'Any'
}

const KNOWN_REQ_STATUSES: TaskRequirementStatus[] = ['complete', 'failed', 'active']

/**
 * Keep only recognized requirement statuses; fall back to `['complete']` if the
 * API sends nothing usable, so an unexpected/empty value degrades to the safe
 * "prerequisite must be completed" assumption rather than an always-satisfied one.
 */
function normalizeReqStatuses(raw: string[] | null): TaskRequirementStatus[] {
  const valid = (raw ?? []).filter((s): s is TaskRequirementStatus =>
    (KNOWN_REQ_STATUSES as string[]).includes(s)
  )
  return valid.length > 0 ? valid : ['complete']
}

export async function fetchTasks(): Promise<TaskData[]> {
  const data = await graphql<{ tasks: RawTask[] }>(TASKS_QUERY)

  return data.tasks.map((t) => ({
    id: t.id,
    name: t.name,
    trader: t.trader?.name ?? 'Unknown',
    minPlayerLevel: t.minPlayerLevel ?? 1,
    kappaRequired: t.kappaRequired,
    factionName: normalizeFaction(t.factionName),
    requiredTaskIds: t.taskRequirements.map((r) => r.task.id),
    requirements: t.taskRequirements.map((r) => ({
      taskId: r.task.id,
      statuses: normalizeReqStatuses(r.status)
    })),
    wikiLink: t.wikiLink,
    taskImageLink: t.taskImageLink,
    objectives: t.objectives.map((o) => ({
      id: o.id,
      type: o.type,
      description: o.description,
      optional: o.optional,
      maps: o.maps.map((m) => m.name),
      zones: mapObjectiveZones(o),
      items:
        o.items?.map((item) => ({
          id: item.id,
          name: item.name,
          count: o.count ?? 1,
          foundInRaid: o.foundInRaid ?? false
        })) ?? []
    }))
  }))
}

interface RawVendorPrice {
  priceRUB: number | null
  source: string
  vendor: { name: string } | null
}

const itemsQuery = (mode: GameMode): string => `{
  items(lang: en, type: any, gameMode: ${mode}) {
    id
    name
    shortName
    iconLink
    lastLowPrice
    avg24hPrice
    changeLast48hPercent
    types
    sellFor { priceRUB source vendor { name } }
    properties {
      __typename
      ... on ItemPropertiesKey { uses }
    }
  }
}`

interface RawItem {
  id: string
  name: string
  shortName: string
  iconLink: string | null
  lastLowPrice: number | null
  avg24hPrice: number | null
  changeLast48hPercent: number | null
  types: string[]
  sellFor: RawVendorPrice[]
  properties: { __typename: string; uses?: number | null } | null
}

/** Item types whose flea price depends on remaining durability. */
const DURABILITY_TYPES = new Set(['gun', 'armor', 'armorPlate', 'helmet'])

/** Whether an item's flea price is dragged around by durability/uses. */
function hasVariableDurability(item: RawItem): boolean {
  const limitedUseKey =
    item.properties?.__typename === 'ItemPropertiesKey' && (item.properties.uses ?? 0) > 0
  const durableGear = item.types.some((t) => DURABILITY_TYPES.has(t))
  return limitedUseKey || durableGear
}

/** Best trader (non-flea) offer for an item, or null when only the flea buys it. */
function bestVendorSell(sellFor: RawVendorPrice[]): { price: number; vendor: string } | null {
  let best: { price: number; vendor: string } | null = null
  for (const offer of sellFor) {
    if (offer.source === 'fleaMarket' || offer.priceRUB === null) continue
    if (!best || offer.priceRUB > best.price) {
      best = { price: offer.priceRUB, vendor: offer.vendor?.name ?? offer.source }
    }
  }
  return best
}

export async function fetchItems(mode: GameMode = 'regular'): Promise<ItemData[]> {
  const data = await graphql<{ items: RawItem[] }>(itemsQuery(mode))

  return data.items.map((i) => {
    const vendor = bestVendorSell(i.sellFor)
    return {
      id: i.id,
      name: i.name,
      shortName: i.shortName,
      iconLink: i.iconLink,
      lastLowPrice: i.lastLowPrice,
      avg24hPrice: i.avg24hPrice,
      changeLast48hPercent: i.changeLast48hPercent,
      flaggedNoFlea: i.types.includes('noFlea'),
      bestVendorSellRUB: vendor?.price ?? null,
      bestVendorName: vendor?.vendor ?? null,
      types: i.types,
      hasVariableDurability: hasVariableDurability(i)
    }
  })
}

const craftsQuery = (mode: GameMode): string => `{
  crafts(lang: en, gameMode: ${mode}) {
    id
    level
    duration
    station { name normalizedName }
    taskUnlock { id name }
    requiredItems {
      count
      item { id name shortName iconLink buyFor { priceRUB } sellFor { priceRUB } }
    }
    rewardItems {
      count
      item { id name shortName iconLink buyFor { priceRUB } sellFor { priceRUB } }
    }
  }
}`

interface RawCraftItem {
  count: number
  item: {
    id: string
    name: string
    shortName: string
    iconLink: string | null
    buyFor: { priceRUB: number | null }[]
    sellFor: { priceRUB: number | null }[]
  }
}

interface RawCraft {
  id: string
  level: number
  duration: number
  station: { name: string; normalizedName: string }
  taskUnlock: { id: string; name: string } | null
  requiredItems: RawCraftItem[]
  rewardItems: RawCraftItem[]
}

function minPrice(offers: { priceRUB: number | null }[]): number | null {
  let best: number | null = null
  for (const o of offers) {
    if (o.priceRUB === null) continue
    if (best === null || o.priceRUB < best) best = o.priceRUB
  }
  return best
}

function maxPrice(offers: { priceRUB: number | null }[]): number | null {
  let best: number | null = null
  for (const o of offers) {
    if (o.priceRUB === null) continue
    if (best === null || o.priceRUB > best) best = o.priceRUB
  }
  return best
}

function mapCraftItem(raw: RawCraftItem): CraftItemRef {
  return {
    id: raw.item.id,
    name: raw.item.name,
    shortName: raw.item.shortName,
    iconLink: raw.item.iconLink,
    count: raw.count,
    buyPriceRUB: minPrice(raw.item.buyFor),
    sellPriceRUB: maxPrice(raw.item.sellFor)
  }
}

export async function fetchCrafts(mode: GameMode = 'regular'): Promise<CraftData[]> {
  const data = await graphql<{ crafts: RawCraft[] }>(craftsQuery(mode))

  return data.crafts.map((c) => ({
    id: c.id,
    station: c.station.name,
    stationNormalized: c.station.normalizedName,
    level: c.level,
    durationSeconds: c.duration,
    taskUnlock: c.taskUnlock,
    requiredItems: c.requiredItems.map(mapCraftItem),
    rewardItems: c.rewardItems.map(mapCraftItem)
  }))
}

// ── Phase 4.7.1: ammo reference chart ───────────────────────────────────────
// Field set confirmed live against the API (2026-07-14): `ammo` returns 195
// rows; every field below resolves. Ballistic stats change only on wipes/patches
// so a modest TTL is fine.
// `buyFor.source` is `fleaMarket` or a trader's normalized name; `craftsFor` /
// `bartersFor` are non-empty when the round is obtainable that way. Together they
// let the view mark each round's acquisition route (or flag it FIR-only).
const AMMO_QUERY = `{
  ammo(lang: en) {
    caliber
    ammoType
    penetrationPower
    damage
    armorDamage
    fragmentationChance
    projectileCount
    initialSpeed
    item {
      id
      name
      shortName
      iconLink
      buyFor { source }
      craftsFor { id }
      bartersFor { id }
    }
  }
}`

interface RawAmmo {
  caliber: string | null
  ammoType: string | null
  penetrationPower: number | null
  damage: number | null
  armorDamage: number | null
  fragmentationChance: number | null
  projectileCount: number | null
  initialSpeed: number | null
  item: {
    id: string
    name: string
    shortName: string
    iconLink: string | null
    buyFor: { source: string }[]
    craftsFor: { id: string }[]
    bartersFor: { id: string }[]
  } | null
}

/**
 * tarkov.dev's `caliber` field is an internal enum ("Caliber556x45NATO"). This
 * maps the full observed set (30 calibers, verified live 2026-07-14) to the
 * names players actually use. Anything unmapped falls back to a generic strip of
 * the "Caliber" prefix so a newly-added caliber still renders legibly.
 */
const CALIBER_LABELS: Record<string, string> = {
  Caliber9x18PM: '9x18mm Makarov',
  Caliber9x19PARA: '9x19mm Parabellum',
  Caliber9x21: '9x21mm Gyurza',
  Caliber9x33R: '.357 Magnum',
  Caliber9x39: '9x39mm',
  Caliber762x25TT: '7.62x25mm Tokarev',
  Caliber762x35: '.300 Blackout',
  Caliber762x39: '7.62x39mm',
  Caliber762x51: '7.62x51mm NATO',
  Caliber762x54R: '7.62x54mmR',
  Caliber545x39: '5.45x39mm',
  Caliber556x45NATO: '5.56x45mm NATO',
  Caliber57x28: '5.7x28mm',
  Caliber68x51: '6.8x51mm SIG',
  Caliber1143x23ACP: '.45 ACP',
  Caliber127x33: '.50 AE',
  Caliber127x55: '12.7x55mm',
  Caliber127x99: '12.7x99mm (.50 BMG)',
  Caliber12g: '12 Gauge',
  Caliber20g: '20 Gauge',
  Caliber20x1mm: '20x1mm',
  Caliber23x75: '23x75mm',
  Caliber26x75: '26x75mm (flare)',
  Caliber366TKM: '.366 TKM',
  Caliber40mmRU: '40mm VOG',
  Caliber40x46: '40x46mm',
  Caliber46x30: '4.6x30mm',
  Caliber784x49: '.308 Winchester',
  Caliber86x70: '.338 Lapua Magnum',
  Caliber93x64: '9.3x64mm'
}

function caliberLabel(raw: string): string {
  return CALIBER_LABELS[raw] ?? raw.replace(/^Caliber/, '')
}

export async function fetchAmmo(): Promise<AmmoData[]> {
  const data = await graphql<{ ammo: RawAmmo[] }>(AMMO_QUERY)

  return data.ammo
    .filter((a) => a.item !== null)
    .map((a) => {
      const item = a.item!
      const caliber = a.caliber ?? 'Unknown'
      const buySources = new Set(item.buyFor.map((b) => b.source))
      return {
        itemId: item.id,
        name: item.name,
        shortName: item.shortName,
        iconLink: item.iconLink,
        caliber,
        caliberLabel: caliberLabel(caliber),
        ammoType: a.ammoType ?? 'bullet',
        penetrationPower: a.penetrationPower ?? 0,
        damage: a.damage ?? 0,
        armorDamage: a.armorDamage ?? 0,
        fragmentationChance: a.fragmentationChance ?? 0,
        projectileCount: a.projectileCount ?? 1,
        initialSpeed: a.initialSpeed ?? 0,
        acquisition: {
          flea: buySources.has('fleaMarket'),
          trader: [...buySources].some((s) => s !== 'fleaMarket'),
          barter: item.bartersFor.length > 0,
          craft: item.craftsFor.length > 0
        }
      }
    })
}

const MAPS_QUERY = `{
  maps(lang: en) {
    id
    name
    normalizedName
  }
}`

export async function fetchMaps(): Promise<MapZoneData[]> {
  const data = await graphql<{ maps: MapZoneData[] }>(MAPS_QUERY)
  return data.maps
}

// ── Phase 4 follow-up: extracts, locked doors, boss spawns ──────────────────
// Boss spawns carry no coordinates of their own — `spawnLocations[].spawnKey`
// is a zone name that has to be cross-referenced against `spawns` (the same
// zone list used for player/scav spawns), filtered to `categories: ["boss"]`,
// to recover a plottable position. Confirmed live: every spawnKey on every
// checked map resolves this way.
const MAP_FEATURES_QUERY = `{
  maps(lang: en) {
    normalizedName
    extracts { name faction position { x y z } top bottom }
    transits { description conditions map { name normalizedName } position { x y z } top bottom }
    locks { lockType needsPower position { x y z } top bottom key { name iconLink categories { normalizedName } } }
    spawns { zoneName categories position { x y z } }
    bosses { name spawnChance spawnLocations { spawnKey } escorts { amount { count } } }
  }
}`

interface RawMapFeatures {
  normalizedName: string
  extracts: {
    name: string
    faction: string | null
    position: { x: number; y: number; z: number } | null
    top: number | null
    bottom: number | null
  }[]
  transits: {
    description: string | null
    conditions: string | null
    map: { name: string; normalizedName: string } | null
    position: { x: number; y: number; z: number } | null
    top: number | null
    bottom: number | null
  }[]
  locks: {
    lockType: string
    needsPower: boolean
    position: { x: number; y: number; z: number } | null
    top: number | null
    bottom: number | null
    key: { name: string; iconLink: string | null; categories: { normalizedName: string }[] } | null
  }[]
  spawns: {
    zoneName: string
    categories: string[]
    position: { x: number; y: number; z: number } | null
  }[]
  bosses: {
    name: string
    spawnChance: number
    spawnLocations: { spawnKey: string }[]
    escorts: { amount: { count: number }[] }[]
  }[]
}

// Co-op extracts have no dedicated field on tarkov.dev; they're consistently
// named "… (Co-op)" (and always faction "shared"). Everything else maps
// straight from `faction`, defaulting an unexpected/missing value to PMC.
function extractType(name: string, faction: string | null): MapExtractType {
  if (/\(co-?op\)/i.test(name)) return 'coop'
  if (faction === 'scav') return 'scav'
  if (faction === 'shared') return 'shared'
  return 'pmc'
}

export async function fetchMapFeatures(): Promise<MapFeatureData[]> {
  const data = await graphql<{ maps: RawMapFeatures[] }>(MAP_FEATURES_QUERY)

  return data.maps.map((m) => {
    // zoneName → positions, restricted to boss-tagged spawn zones (a zone can
    // have multiple randomized spawn points).
    const bossZonePositions = new Map<string, { x: number; y: number; z: number }[]>()
    for (const spawn of m.spawns) {
      if (!spawn.position || !spawn.categories.includes('boss')) continue
      const list = bossZonePositions.get(spawn.zoneName) ?? []
      list.push(spawn.position)
      bossZonePositions.set(spawn.zoneName, list)
    }

    // One marker per (boss, zone), not per individual randomized point within
    // it — a zone can hold a dozen+ scattered spawn points (e.g. Reshala's
    // "New Gas" zone on Customs has 9), which reads as clutter rather than
    // signal. Collapsed to the zone's centroid: "he spawns somewhere around
    // here", not an exact spot anyway since the game picks one at random.
    //
    // Separately, tarkov.dev also lists the *same* (boss, zone) pair as
    // several distinct `BossSpawn` entries with different escort counts (e.g.
    // Icebreaker's "EngineHide" zone has 5 "Black Div. Boss" entries with 2,
    // 2, 3, 3, 4 guards). These read like difficulty/variant tiers, but
    // nothing in the schema ties a given count to a specific squad size
    // (solo/duo/trio) — there's no such field on `BossSpawn` — so rather than
    // fabricate that mapping, they're deduped into one marker per zone with
    // the honest min–max escort range actually observed.
    interface BossAccumulator {
      name: string
      spawnChancePercent: number
      x: number
      y: number
      z: number
      escortCounts: number[]
    }
    const bossByKey = new Map<string, BossAccumulator>()

    for (const boss of m.bosses) {
      const escortCount = boss.escorts.reduce((sum, e) => sum + (e.amount[0]?.count ?? 0), 0)
      for (const loc of boss.spawnLocations) {
        const points = bossZonePositions.get(loc.spawnKey) ?? []
        if (points.length === 0) continue
        const key = `${boss.name}|${loc.spawnKey}`
        const existing = bossByKey.get(key)
        if (existing) {
          existing.escortCounts.push(escortCount)
          existing.spawnChancePercent = Math.max(existing.spawnChancePercent, Math.round(boss.spawnChance * 100))
        } else {
          bossByKey.set(key, {
            name: boss.name,
            spawnChancePercent: Math.round(boss.spawnChance * 100),
            x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
            y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
            z: points.reduce((sum, p) => sum + p.z, 0) / points.length,
            escortCounts: [escortCount]
          })
        }
      }
    }

    const bosses: MapBossSpawnData[] = [...bossByKey.values()].map((b) => ({
      name: b.name,
      spawnChancePercent: b.spawnChancePercent,
      x: b.x,
      y: b.y,
      z: b.z,
      escortMin: Math.min(...b.escortCounts),
      escortMax: Math.max(...b.escortCounts)
    }))

    return {
      normalizedName: m.normalizedName,
      extracts: m.extracts
        .filter((e) => e.position)
        .map((e) => ({
          name: e.name,
          faction: e.faction,
          type: extractType(e.name, e.faction),
          x: e.position!.x,
          y: e.position!.y,
          z: e.position!.z,
          top: e.top,
          bottom: e.bottom
        })),
      transits: m.transits
        .filter((t) => t.position)
        .map((t) => ({
          destination: t.map?.name ?? 'Unknown',
          destinationNorm: t.map?.normalizedName ?? '',
          description: t.description,
          // tarkov.dev often returns an empty string for no conditions — normalize to null.
          conditions: t.conditions?.trim() ? t.conditions : null,
          x: t.position!.x,
          y: t.position!.y,
          z: t.position!.z,
          top: t.top,
          bottom: t.bottom
        })),
      locks: m.locks
        .filter((l) => l.position)
        .map((l) => {
          const isKeycard = l.key?.categories?.some((c) => c.normalizedName === 'keycard') ?? false
          const isMarkedRoom = l.key?.name?.toLowerCase().includes('marked key') ?? false
          return {
            lockType: l.lockType,
            keyName: l.key?.name ?? null,
            isKeycard,
            keyImageLink: l.key?.iconLink ?? null,
            isMarkedRoom,
            needsPower: l.needsPower,
            x: l.position!.x,
            y: l.position!.y,
            z: l.position!.z,
            top: l.top,
            bottom: l.bottom
          }
        }),
      bosses
    }
  })
}
