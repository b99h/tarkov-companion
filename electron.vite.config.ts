import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * Phase 7.1 — the renderer's Content-Security-Policy. This is the single
 * biggest mitigation in the hardening pass: it neutralizes script execution
 * even if hostile markup (a tampered map SVG, a wiki caption) reaches the DOM.
 *
 * - `script-src 'self'` and no `unsafe-inline`/`unsafe-eval`: inline script is
 *   the attack, so it is never allowed. Styles do get 'unsafe-inline' because
 *   Leaflet and React set inline `style=` attributes throughout.
 * - `img-src` allows assets.tarkov.dev (Leaflet tile/SVG layers and item icons
 *   load straight from it — verified to be the only remote image host in the
 *   data) plus `data:` (wiki screenshots and OCR capture thumbnails arrive as
 *   base64 data URLs from main).
 * - Everything else is denied by `default-src 'self'`, with `object-src`,
 *   `frame-src`, `base-uri` and `form-action` pinned to 'none' explicitly.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://assets.tarkov.dev",
  "font-src 'self'",
  "connect-src 'self' https://assets.tarkov.dev",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/**
 * Injects the CSP meta into the built index.html. Build-only (`apply: 'build'`)
 * because the dev server serves an inline React-refresh preamble and talks HMR
 * over a websocket, both of which this policy forbids — a CSP that broke
 * `npm run dev` would just get deleted. The dev renderer loads from localhost
 * and ships to nobody; the packaged app is what needs the policy.
 */
function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), cspPlugin()]
  }
})
