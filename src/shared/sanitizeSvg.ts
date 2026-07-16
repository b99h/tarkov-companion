/**
 * Phase 7.1 — scrub a remotely-fetched SVG before it goes into the live DOM.
 *
 * The map views inline tarkov.dev's map SVGs via `L.svgOverlay`, which means
 * the markup becomes real, script-capable DOM rather than an inert `<img>`.
 * That's deliberate (floor toggling needs to reach into the SVG's `<g>` groups
 * by id), but it means a compromised assets.tarkov.dev could ship an `onload=`
 * handler straight into our renderer. The CSP is the backstop that would stop
 * such a handler from executing; this keeps the DOM clean regardless, so
 * neither layer is the only thing standing between us and a bad asset.
 */

/** Attributes carrying a URL that could be a `javascript:` payload or a tracker. */
const URL_ATTRS = ['href', 'xlink:href', 'src', 'from', 'to', 'values', 'begin']

/**
 * Elements that can execute script or embed arbitrary foreign content.
 *
 * `<use>` is deliberately NOT here: 5 of the 9 live map SVGs (Customs, Factory,
 * Ground Zero, Shoreline, Streets) rely on it, so dropping it would blank real
 * map art. Its risk is an external `href`, which the URL-attribute check below
 * already reduces to same-document fragments. The animation elements are here
 * because `<set attributeName="href" to="javascript:…">` is a known way to
 * smuggle a payload past a naive attribute scrub, and no map SVG animates.
 */
const FORBIDDEN_TAGS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
  'set',
  'animate',
  'animatetransform',
  'animatemotion',
  'handler',
  'listener'
])

function isSafeUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase()
  // Fragment refs (`#Second_Floor`) are the only links a map SVG needs. Anything
  // that reaches out — javascript:, data:, http(s):, protocol-relative — goes.
  if (trimmed.startsWith('#')) return true
  return false
}

/**
 * Strip script-capable elements, event handlers, and outbound URL references
 * from an SVG document in place, returning its root element. Mutates `doc`.
 */
export function sanitizeSvgDocument(doc: Document): SVGSVGElement {
  const root = doc.documentElement as unknown as SVGSVGElement

  // Walk a static list: removing nodes mid-live-traversal skips siblings.
  const all = Array.from(doc.querySelectorAll('*'))
  for (const el of all) {
    if (FORBIDDEN_TAGS.has(el.tagName.toLowerCase())) {
      el.remove()
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name)
        continue
      }
      if (URL_ATTRS.includes(name) && !isSafeUrl(attr.value)) {
        el.removeAttribute(attr.name)
      }
    }
  }
  return root
}

/**
 * Parse SVG markup and return a sanitized root element, or null when the markup
 * doesn't parse as SVG at all (the caller then renders no overlay rather than
 * inlining whatever came back).
 */
export function parseAndSanitizeSvg(svgText: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  if (doc.querySelector('parsererror')) return null
  if (doc.documentElement.tagName.toLowerCase() !== 'svg') return null
  return sanitizeSvgDocument(doc)
}
