import { useEffect, useState } from 'react'
import type { QuestWikiImages, WikiGalleryImage } from '@shared/types'

// Shared wiki-screenshot surface (Phase 4.65). The map marker popups drive their
// own imperative thumbnail strip (they live in Leaflet-owned DOM), but everything
// React-rendered — the quest board detail panel and the map's "also active here"
// list — uses <WikiGallery/> here. All of them share one in-memory cache and the
// same <WikiLightbox/>, on top of the per-task disk cache in main.

const cache = new Map<string, QuestWikiImages>()
const inFlight = new Map<string, Promise<QuestWikiImages>>()

/** Cached-or-fetch a task's wiki gallery, deduping concurrent requests per task. */
export function loadWikiImages(taskId: string): Promise<QuestWikiImages> {
  const cached = cache.get(taskId)
  if (cached) return Promise.resolve(cached)
  const existing = inFlight.get(taskId)
  if (existing) return existing
  const promise = window.api
    .getQuestWikiImages(taskId)
    .then((res) => {
      cache.set(taskId, res)
      inFlight.delete(taskId)
      return res
    })
    .catch((err) => {
      inFlight.delete(taskId)
      throw err
    })
  inFlight.set(taskId, promise)
  return promise
}

/** Synchronously read an already-cached gallery, if present. */
export function peekWikiImages(taskId: string): QuestWikiImages | undefined {
  return cache.get(taskId)
}

/** The display label for an image: its caption, or the section heading when the
 * caption is blank (some pages, e.g. Ambulances Again, put the location label in
 * the heading instead), so the location info is never lost. */
export function wikiImageLabel(img: WikiGalleryImage): string {
  return img.caption || img.section || ''
}

/**
 * Fullscreen overlay showing one wiki screenshot at a time with its caption (the
 * location label, doubling as CC-BY-SA attribution). Click-outside or Esc closes;
 * arrows / ←→ step through.
 */
export function WikiLightbox({
  images,
  index,
  onClose,
  onIndex
}: {
  images: WikiGalleryImage[]
  index: number
  onClose: () => void
  onIndex: (i: number) => void
}): React.JSX.Element {
  const current = images[index]
  const many = images.length > 1

  useEffect(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') onClose()
      else if (ev.key === 'ArrowRight') onIndex((index + 1) % images.length)
      else if (ev.key === 'ArrowLeft') onIndex((index - 1 + images.length) % images.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images.length, onClose, onIndex])

  return (
    <div className="wiki-lightbox" onClick={onClose}>
      <button className="wiki-lightbox-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
        ✕
      </button>
      {many && (
        <button
          className="wiki-lightbox-nav prev"
          onClick={(e) => {
            e.stopPropagation()
            onIndex((index - 1 + images.length) % images.length)
          }}
          aria-label="Previous"
        >
          ‹
        </button>
      )}
      <figure className="wiki-lightbox-figure" onClick={(e) => e.stopPropagation()}>
        <img src={current.dataUrl} alt={current.caption} className="wiki-lightbox-img" />
        <figcaption className="wiki-lightbox-caption">
          {wikiImageLabel(current) || 'Escape from Tarkov Wiki'}
          {many && (
            <span className="wiki-lightbox-counter">
              {index + 1} / {images.length}
            </span>
          )}
        </figcaption>
      </figure>
      {many && (
        <button
          className="wiki-lightbox-nav next"
          onClick={(e) => {
            e.stopPropagation()
            onIndex((index + 1) % images.length)
          }}
          aria-label="Next"
        >
          ›
        </button>
      )}
    </div>
  )
}

/**
 * React thumbnail strip + lightbox for a quest's wiki screenshots, fetched lazily
 * on mount. Renders nothing once loaded if the quest has no usable gallery, so it
 * stays out of the way on the many quests that have none — the surrounding
 * "Open wiki ↗" link already covers those.
 */
export function WikiGallery({ taskId }: { taskId: string }): React.JSX.Element | null {
  const [result, setResult] = useState<QuestWikiImages | null>(() => peekWikiImages(taskId) ?? null)
  const [loading, setLoading] = useState(!result)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  useEffect(() => {
    const cached = peekWikiImages(taskId)
    if (cached) {
      setResult(cached)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setResult(null)
    loadWikiImages(taskId)
      .then((res) => {
        if (cancelled) return
        setResult(res)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [taskId])

  if (loading) {
    return (
      <div className="wiki-gallery">
        <div className="wiki-gallery-loading">Loading wiki screenshots…</div>
      </div>
    )
  }
  const images = result?.images ?? []
  if (images.length === 0) return null

  return (
    <div className="wiki-gallery">
      <div className="wiki-gallery-heading">Wiki location photos</div>
      <div className="wiki-gallery-strip">
        {images.map((img, i) => {
          const label = wikiImageLabel(img)
          return (
            <button
              key={i}
              type="button"
              className="wiki-thumb"
              title={label || 'Open screenshot'}
              onClick={() => setLightboxIndex(i)}
            >
              <img src={img.dataUrl} alt={label} loading="lazy" />
              {label && <span className="wiki-thumb-caption">{label}</span>}
            </button>
          )
        })}
      </div>
      {lightboxIndex !== null && (
        <WikiLightbox
          images={images}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndex={setLightboxIndex}
        />
      )}
    </div>
  )
}
