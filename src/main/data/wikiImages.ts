import type { QuestWikiImages, WikiGalleryImage } from '../../shared/types'
import { fetchBoundedBuffer } from './fetchLimits'

// Phase 4.65 — quest location screenshots, sourced from the Escape from Tarkov
// Fandom wiki via its MediaWiki API (NOT HTML scraping — Phase 4.3 rejected
// scraping because a matching heuristic could silently attach the wrong photo
// to a marker; this design never matches photo→marker, it shows the page's own
// captioned gallery and lets the wiki's captions carry the location info).
const API_BASE = 'https://escapefromtarkov.fandom.com/api.php'

// Thumbnail width we ask the wiki to scale to. Full-res gallery images are
// multi-megabyte (2656×2160 PNGs seen live); 640px is plenty for the in-app
// lightbox and keeps each cached data URL small.
const THUMB_WIDTH = 640

// Noise floors: item icons, trader portraits and banners are tiny and/or
// animated. Skip anything smaller than this on either axis, and skip GIFs.
const MIN_DIMENSION = 200

// Bound the payload — a handful of screenshots is the point; no quest page
// legitimately needs more, and this caps a pathological page's cache size.
const MAX_IMAGES = 12

interface GalleryEntry {
  /** Wiki file title without the `File:`/`Image:` prefix, spaces preserved. */
  file: string
  caption: string
  section: string | null
}

/**
 * Derive the wiki page title from a task's `wikiLink`
 * (e.g. `https://escapefromtarkov.fandom.com/wiki/Saving_the_Mole` → `Saving_the_Mole`).
 * Returns null for a missing/unparseable link so the caller can degrade cleanly.
 */
export function pageTitleFromWikiLink(wikiLink: string | null): string | null {
  if (!wikiLink) return null
  const match = wikiLink.match(/\/wiki\/([^?#]+)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/** Strip the common wiki markup out of a gallery caption, leaving plain text. */
function cleanCaption(raw: string): string {
  return raw
    .replace(/\{\{[^}]*\}\}/g, '') // templates
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1') // [[target|label]] → label
    .replace(/\[\[([^\]]*)\]\]/g, '$1') // [[label]] → label
    .replace(/<br\s*\/?>/gi, ' ') // line breaks
    .replace(/<[^>]+>/g, '') // any other stray HTML
    .replace(/'''?/g, '') // bold/italic
    .replace(/\s+/g, ' ')
    .trim()
}

/** A canonical key for matching a wiki file title regardless of case/underscores. */
function fileKey(title: string): string {
  const stripped = title.replace(/^(File|Image):/i, '').replace(/_/g, ' ').trim()
  // MediaWiki upper-cases the first letter of a title; normalize the whole thing
  // to lower-case for a case-insensitive match either way.
  return stripped.toLowerCase()
}

/**
 * Pull every `<gallery>` block out of the page wikitext, tagging each image with
 * the section heading it appeared under (best-effort scoping — the caller shows
 * all of them, but the section makes a useful sub-label). Parses defensively:
 * galleries vary per page and captions are optional.
 */
export function extractGalleryEntries(wikitext: string): GalleryEntry[] {
  // Section headings and their positions, so each gallery can find the heading
  // immediately above it.
  const headings: { index: number; title: string }[] = []
  const headingRe = /^==+\s*(.+?)\s*==+\s*$/gm
  let hm: RegExpExecArray | null
  while ((hm = headingRe.exec(wikitext))) {
    headings.push({ index: hm.index, title: hm[1].trim() })
  }
  const sectionFor = (index: number): string | null => {
    let title: string | null = null
    for (const h of headings) {
      if (h.index < index) title = h.title
      else break
    }
    return title
  }

  const entries: GalleryEntry[] = []
  const galleryRe = /<gallery[^>]*>([\s\S]*?)<\/gallery>/gi
  let gm: RegExpExecArray | null
  while ((gm = galleryRe.exec(wikitext))) {
    const section = sectionFor(gm.index)
    for (const line of gm[1].split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const pipe = trimmed.indexOf('|')
      const file = (pipe === -1 ? trimmed : trimmed.slice(0, pipe))
        .replace(/^(File|Image):/i, '')
        .trim()
      if (!file) continue
      const caption = pipe === -1 ? '' : cleanCaption(trimmed.slice(pipe + 1))
      entries.push({ file, caption, section })
    }
  }
  return entries
}

interface ImageInfo {
  thumbUrl: string
  width: number
  height: number
  mime: string
}

/** Resolve gallery file titles to scaled thumbnail URLs + dimensions via `imageinfo`. */
async function resolveImageInfo(files: string[]): Promise<Map<string, ImageInfo>> {
  const out = new Map<string, ImageInfo>()
  if (files.length === 0) return out

  const params = new URLSearchParams({
    action: 'query',
    prop: 'imageinfo',
    iiprop: 'url|size|mime',
    iiurlwidth: String(THUMB_WIDTH),
    titles: files.map((f) => `File:${f}`).join('|'),
    format: 'json',
    formatversion: '2'
  })
  const res = await fetch(`${API_BASE}?${params.toString()}`)
  if (!res.ok) throw new Error(`wiki imageinfo request failed: ${res.status} ${res.statusText}`)
  const json = (await res.json()) as {
    query?: {
      pages?: {
        title?: string
        imageinfo?: { thumburl?: string; url?: string; width?: number; height?: number; mime?: string }[]
      }[]
    }
  }

  for (const page of json.query?.pages ?? []) {
    const info = page.imageinfo?.[0]
    if (!page.title || !info) continue
    const src = info.thumburl ?? info.url
    if (!src) continue
    out.set(fileKey(page.title), {
      thumbUrl: src,
      width: info.width ?? 0,
      height: info.height ?? 0,
      mime: info.mime ?? ''
    })
  }
  return out
}

/**
 * Fetch a wiki image and return it as a base64 data URL. Fetched here in main
 * (Node `fetch` sends no `Referer`) so the wiki CDN's referrer-based hotlink
 * protection — already diagnosed and solved for the Icebreaker reference map —
 * doesn't 404 the request the way a direct renderer `<img>` would.
 */
async function fetchAsDataUrl(url: string): Promise<string> {
  const { buffer, contentType } = await fetchBoundedBuffer(url, 'wiki image')
  return `data:${contentType ?? 'image/png'};base64,${buffer.toString('base64')}`
}

/**
 * Build a task's captioned wiki-image gallery. Throws only on hard network/API
 * failure (so the disk cache serves stale rather than caching a transient
 * error); returns `images: []` with a `reason` for the legitimately-empty cases
 * (no wiki link, no gallery, all-noise) so those *are* cached and not refetched.
 */
export async function fetchQuestWikiImages(
  taskId: string,
  wikiLink: string | null
): Promise<QuestWikiImages> {
  const empty = (reason: string): QuestWikiImages => ({ taskId, images: [], reason })

  const title = pageTitleFromWikiLink(wikiLink)
  if (!title) return empty('This quest has no wiki page linked, so no screenshots are available.')

  const params = new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'wikitext',
    format: 'json',
    formatversion: '2'
  })
  const res = await fetch(`${API_BASE}?${params.toString()}`)
  if (!res.ok) throw new Error(`wiki parse request failed: ${res.status} ${res.statusText}`)
  const json = (await res.json()) as { parse?: { wikitext?: string }; error?: { info?: string } }
  if (json.error) {
    // A missing page is a legitimate empty, not a transient failure — cache it.
    return empty('No wiki page was found for this quest, so no screenshots are available.')
  }
  const wikitext = json.parse?.wikitext
  if (!wikitext) return empty('The wiki page for this quest has no readable content.')

  const entries = extractGalleryEntries(wikitext)
  if (entries.length === 0) {
    return empty("The wiki page for this quest doesn't have a location gallery yet.")
  }

  // Dedupe by file (some pages repeat a map image across sections), preserve order.
  const seen = new Set<string>()
  const unique = entries.filter((e) => {
    const key = fileKey(e.file)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const info = await resolveImageInfo(unique.map((e) => e.file))

  const usable: GalleryEntry[] = []
  for (const entry of unique) {
    const meta = info.get(fileKey(entry.file))
    if (!meta) continue
    if (meta.mime === 'image/gif') continue
    if (meta.width < MIN_DIMENSION || meta.height < MIN_DIMENSION) continue
    usable.push(entry)
    if (usable.length >= MAX_IMAGES) break
  }
  if (usable.length === 0) {
    return empty('The wiki page for this quest has no usable location screenshots.')
  }

  const images: WikiGalleryImage[] = []
  for (const entry of usable) {
    const meta = info.get(fileKey(entry.file))!
    try {
      const dataUrl = await fetchAsDataUrl(meta.thumbUrl)
      images.push({ dataUrl, caption: entry.caption, section: entry.section })
    } catch (err) {
      // One bad image shouldn't sink the whole gallery — skip it and continue.
      console.error(`[wikiImages] failed to fetch ${entry.file}:`, err)
    }
  }
  if (images.length === 0) {
    return empty('The wiki screenshots for this quest could not be loaded.')
  }

  return { taskId, images, reason: null }
}
