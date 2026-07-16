/**
 * Phase 7.1 — bounded downloads for the bytes main fetches on the renderer's
 * behalf and base64s into the on-disk cache. Unbounded, a hostile or simply
 * broken host could stream gigabytes into memory and then into a cache file;
 * these images are wiki thumbnails and map art measured in tens of KB, so a
 * generous ceiling costs nothing and turns that into a clean error.
 */

/** Ceiling for a single downloaded image/asset. Real payloads are ≪ this. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

/**
 * Fetch a URL into a Buffer, refusing anything over `MAX_DOWNLOAD_BYTES`.
 * Checks the advertised `Content-Length` first (cheap rejection), then enforces
 * the cap while streaming, since the header is a claim, not a guarantee.
 */
export async function fetchBoundedBuffer(url: string, what: string): Promise<{ buffer: Buffer; contentType: string | null }> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`${what} request failed: ${res.status} ${res.statusText}`)
  }

  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${what} too large: ${declared} bytes exceeds the ${MAX_DOWNLOAD_BYTES}-byte cap`)
  }

  const contentType = res.headers.get('content-type')
  const reader = res.body?.getReader()
  if (!reader) {
    // No streaming body (shouldn't happen for a real response) — fall back to
    // buffering whole, then apply the same cap.
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`${what} too large: exceeds the ${MAX_DOWNLOAD_BYTES}-byte cap`)
    }
    return { buffer, contentType }
  }

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel()
      throw new Error(`${what} too large: exceeds the ${MAX_DOWNLOAD_BYTES}-byte cap`)
    }
    chunks.push(value)
  }
  return { buffer: Buffer.concat(chunks), contentType }
}
