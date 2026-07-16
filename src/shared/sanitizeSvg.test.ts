// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { parseAndSanitizeSvg } from './sanitizeSvg'

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`

describe('parseAndSanitizeSvg — strips executable content', () => {
  it('removes <script> elements', () => {
    const svg = parseAndSanitizeSvg(wrap('<script>window.pwned = 1</script><path d="M0 0"/>'))!
    expect(svg.querySelectorAll('script')).toHaveLength(0)
    expect(svg.querySelectorAll('path')).toHaveLength(1)
  })

  it('removes <foreignObject>, which can carry arbitrary HTML', () => {
    const svg = parseAndSanitizeSvg(
      wrap(
        '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="pwn()"/></body></foreignObject>'
      )
    )!
    expect(svg.querySelectorAll('foreignObject')).toHaveLength(0)
    expect(svg.innerHTML).not.toContain('onerror')
  })

  it('strips every on* event handler attribute', () => {
    const svg = parseAndSanitizeSvg(
      wrap('<g onload="pwn()"><circle cx="1" cy="1" r="1" onclick="pwn()" onmouseover="pwn()"/></g>')
    )!
    const withHandlers = Array.from(svg.querySelectorAll('*')).filter((el) =>
      Array.from(el.attributes).some((a) => a.name.toLowerCase().startsWith('on'))
    )
    expect(withHandlers).toHaveLength(0)
    // The elements themselves survive — only the handlers are removed.
    expect(svg.querySelectorAll('circle')).toHaveLength(1)
  })

  it('strips javascript: and external hrefs but keeps fragment refs', () => {
    const svg = parseAndSanitizeSvg(
      wrap(
        '<a href="javascript:pwn()"><path d="M0 0"/></a>' +
          '<use id="ext" href="https://evil.example.com/x.svg#a"/>' +
          '<use id="frag" href="#Ground_Level"/>'
      )
    )!
    expect(svg.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(svg.querySelector('#ext')?.hasAttribute('href')).toBe(false)
    // Same-document refs are how the real map SVGs reuse shapes — these stay.
    expect(svg.querySelector('#frag')?.getAttribute('href')).toBe('#Ground_Level')
  })

  it('removes animation elements that can retarget an attribute to a payload', () => {
    const svg = parseAndSanitizeSvg(
      wrap('<a href="#x"><set attributeName="href" to="javascript:pwn()"/><path d="M0 0"/></a>')
    )!
    expect(svg.querySelectorAll('set, animate')).toHaveLength(0)
  })

  it('is case-insensitive about tag and attribute spelling', () => {
    const svg = parseAndSanitizeSvg(wrap('<g ONLOAD="pwn()"><path d="M0 0"/></g>'))!
    expect(svg.querySelector('g')?.hasAttribute('ONLOAD')).toBe(false)
    expect(svg.querySelector('g')?.hasAttribute('onload')).toBe(false)
  })
})

describe('parseAndSanitizeSvg — preserves legitimate map markup', () => {
  it('keeps the structure the map view depends on', () => {
    // Mirrors the real cached SVGs: floor <g id> groups (toggled per floor),
    // <use> refs (206 of them in Streets alone), <style>, <defs>, paths.
    const svg = parseAndSanitizeSvg(
      wrap(
        '<style>.a{fill:#123}</style><defs><path id="p" d="M0 0"/></defs>' +
          '<g id="Ground_Level"><use href="#p"/><circle cx="1" cy="1" r="1"/></g>' +
          '<g id="Second_Floor"><path d="M1 1" class="a"/></g>'
      )
    )!
    expect(svg.querySelector('g#Ground_Level')).not.toBeNull()
    expect(svg.querySelector('g#Second_Floor')).not.toBeNull()
    expect(svg.querySelectorAll('use')).toHaveLength(1)
    expect(svg.querySelector('style')?.textContent).toContain('fill:#123')
    expect(svg.querySelectorAll('path')).toHaveLength(2)
  })

  it('returns null for markup that is not SVG at all', () => {
    expect(parseAndSanitizeSvg('<html><body>nope</body></html>')).toBeNull()
    expect(parseAndSanitizeSvg('not markup')).toBeNull()
    expect(parseAndSanitizeSvg('')).toBeNull()
  })
})
