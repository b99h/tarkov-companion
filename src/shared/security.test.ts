import { describe, it, expect } from 'vitest'
import {
  clampPlayerLevel,
  isAllowedFetchUrl,
  isExternallyOpenable,
  isFaction,
  isValidAccelerator,
  isValidCacheName,
  isValidNormalizedName,
  isValidSessionName,
  isValidSessionNames,
  isValidTaskId,
  sanitizeSettingsPatch
} from './security'

describe('isAllowedFetchUrl', () => {
  it('accepts the asset/CDN hosts main actually fetches from', () => {
    expect(isAllowedFetchUrl('https://assets.tarkov.dev/maps/svg/Customs.svg')).toBe(true)
    expect(
      isAllowedFetchUrl(
        'https://static.wikia.nocookie.net/escapefromtarkov_gamepedia/images/b/bd/Icebreaker.jpg'
      )
    ).toBe(true)
    expect(
      isAllowedFetchUrl('https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/x.json')
    ).toBe(true)
  })

  it('rejects other hosts, http, and non-http schemes', () => {
    expect(isAllowedFetchUrl('https://evil.example.com/x.svg')).toBe(false)
    expect(isAllowedFetchUrl('http://assets.tarkov.dev/x.svg')).toBe(false)
    expect(isAllowedFetchUrl('file:///C:/Windows/win.ini')).toBe(false)
    expect(isAllowedFetchUrl('not a url')).toBe(false)
  })

  it('is not fooled by a lookalike host that merely contains an allowed one', () => {
    expect(isAllowedFetchUrl('https://assets.tarkov.dev.evil.com/x.svg')).toBe(false)
    expect(isAllowedFetchUrl('https://evil.com/?x=assets.tarkov.dev')).toBe(false)
    // userinfo before the @ is a classic way to disguise the real host
    expect(isAllowedFetchUrl('https://assets.tarkov.dev@evil.com/x.svg')).toBe(false)
  })
})

describe('isExternallyOpenable', () => {
  it('allows https anywhere (outbound links legitimately go off-site)', () => {
    expect(isExternallyOpenable('https://escapefromtarkov.fandom.com/wiki/Shootout_Picnic')).toBe(
      true
    )
  })

  it('refuses schemes shell.openExternal would act on locally', () => {
    expect(isExternallyOpenable('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isExternallyOpenable('ms-settings:privacy')).toBe(false)
    expect(isExternallyOpenable('javascript:alert(1)')).toBe(false)
    expect(isExternallyOpenable('http://example.com')).toBe(false)
  })
})

describe('isValidCacheName', () => {
  it('accepts the real cache keys the app writes', () => {
    for (const name of [
      'tasks_v4',
      'items_v4_pve',
      'mapSvg_streets-of-tarkov_v1',
      'mapSvg_ground-zero_v1',
      'wikiImages_v1_5ae4498786f7744bde357695',
      'staticMapImage_icebreaker_v1'
    ]) {
      expect(isValidCacheName(name), name).toBe(true)
    }
  })

  it('rejects anything that could escape the cache directory', () => {
    expect(isValidCacheName('../../evil')).toBe(false)
    expect(isValidCacheName('..\\..\\evil')).toBe(false)
    expect(isValidCacheName('sub/dir')).toBe(false)
    expect(isValidCacheName('C:\\Windows\\win')).toBe(false)
    expect(isValidCacheName('mapSvg_..')).toBe(false)
    expect(isValidCacheName('')).toBe(false)
  })
})

describe('isValidTaskId', () => {
  it('accepts a real 24-hex tarkov.dev id', () => {
    expect(isValidTaskId('5ae4498786f7744bde357695')).toBe(true)
  })

  it('rejects wrong length, non-hex, and non-strings', () => {
    expect(isValidTaskId('5ae4498786f7744bde35769')).toBe(false)
    expect(isValidTaskId('5ae4498786f7744bde3576955')).toBe(false)
    expect(isValidTaskId('../../../etc/passwd00000')).toBe(false)
    expect(isValidTaskId(null)).toBe(false)
    expect(isValidTaskId(42)).toBe(false)
  })
})

describe('isValidNormalizedName', () => {
  it('accepts real map names', () => {
    expect(isValidNormalizedName('customs')).toBe(true)
    expect(isValidNormalizedName('streets-of-tarkov')).toBe(true)
  })

  it('rejects traversal and empties', () => {
    expect(isValidNormalizedName('../evil')).toBe(false)
    expect(isValidNormalizedName('')).toBe(false)
    expect(isValidNormalizedName(null)).toBe(false)
  })
})

describe('isValidAccelerator', () => {
  it('accepts the default and other plausible bindings', () => {
    expect(isValidAccelerator('F1')).toBe(true)
    expect(isValidAccelerator('F24')).toBe(true)
    expect(isValidAccelerator('CmdOrCtrl+Shift+K')).toBe(true)
    expect(isValidAccelerator('Alt+9')).toBe(true)
    expect(isValidAccelerator('PrintScreen')).toBe(true)
  })

  it('rejects malformed strings that would throw inside globalShortcut.register', () => {
    expect(isValidAccelerator('')).toBe(false)
    expect(isValidAccelerator('F25')).toBe(false)
    expect(isValidAccelerator('Ctrl+')).toBe(false)
    expect(isValidAccelerator('NotAKey')).toBe(false)
    expect(isValidAccelerator('Shift+Ctrl')).toBe(false) // modifier in the key slot
    expect(isValidAccelerator(null)).toBe(false)
  })
})

describe('isValidSessionName', () => {
  it('accepts a real game session folder name', () => {
    expect(isValidSessionName('log_2026.07.13_18-22-04_1.0.6.0')).toBe(true)
  })

  it('rejects traversal and non-log folders', () => {
    expect(isValidSessionName('log_../../../Windows')).toBe(false)
    expect(isValidSessionName('log_..\\..\\evil')).toBe(false)
    expect(isValidSessionName('..')).toBe(false)
    expect(isValidSessionName('some_other_folder')).toBe(false)
  })

  it('validates whole arrays, rejecting one bad entry', () => {
    expect(isValidSessionNames(['log_a', 'log_b'])).toBe(true)
    expect(isValidSessionNames(['log_a', 'log_../evil'])).toBe(false)
    expect(isValidSessionNames('log_a')).toBe(false)
  })
})

describe('clampPlayerLevel', () => {
  it('keeps sane levels and rounds', () => {
    expect(clampPlayerLevel(42)).toBe(42)
    expect(clampPlayerLevel(42.6)).toBe(43)
  })

  it('clamps out-of-range and coerces junk to a safe default', () => {
    expect(clampPlayerLevel(0)).toBe(1)
    expect(clampPlayerLevel(-5)).toBe(1)
    expect(clampPlayerLevel(9999)).toBe(79)
    expect(clampPlayerLevel(Infinity)).toBe(79)
    expect(clampPlayerLevel(NaN)).toBe(1)
    expect(clampPlayerLevel('nonsense')).toBe(1)
    expect(clampPlayerLevel(null)).toBe(1)
  })
})

describe('isFaction', () => {
  it('accepts the three real factions and nothing else', () => {
    expect(isFaction('Bear')).toBe(true)
    expect(isFaction('Usec')).toBe(true)
    expect(isFaction('Any')).toBe(true)
    expect(isFaction('bear')).toBe(false)
    expect(isFaction('__proto__')).toBe(false)
    expect(isFaction(null)).toBe(false)
  })
})

describe('sanitizeSettingsPatch', () => {
  it('passes through a well-formed patch untouched', () => {
    const { patch, rejected } = sanitizeSettingsPatch({ profile: 'pve', autoWatch: false })
    expect(patch).toEqual({ profile: 'pve', autoWatch: false })
    expect(rejected).toEqual([])
  })

  it('drops unknown keys rather than writing them to settings.json', () => {
    const { patch, rejected } = sanitizeSettingsPatch({ autoWatch: true, evilKey: 'x' })
    expect(patch).toEqual({ autoWatch: true })
    expect(rejected).toEqual(['evilKey'])
  })

  it('drops known keys carrying the wrong type', () => {
    const { patch, rejected } = sanitizeSettingsPatch({ autoWatch: 'yes', profile: 'cheat-mode' })
    expect(patch).toEqual({})
    expect(rejected).toEqual(['autoWatch', 'profile'])
  })

  it('refuses a hotkey that globalShortcut.register would choke on', () => {
    expect(sanitizeSettingsPatch({ captureHotkey: 'F1' }).patch).toEqual({ captureHotkey: 'F1' })
    expect(sanitizeSettingsPatch({ captureHotkey: 'Ctrl+' }).patch).toEqual({})
  })

  it('refuses importedSessions entries that escape the Logs directory', () => {
    expect(sanitizeSettingsPatch({ importedSessions: ['log_ok'] }).patch).toEqual({
      importedSessions: ['log_ok']
    })
    expect(sanitizeSettingsPatch({ importedSessions: ['log_../../evil'] }).patch).toEqual({})
  })

  it('allows installPath as a real path or null, but not other types', () => {
    expect(sanitizeSettingsPatch({ installPath: 'D:\\Games\\EFT' }).patch).toEqual({
      installPath: 'D:\\Games\\EFT'
    })
    expect(sanitizeSettingsPatch({ installPath: null }).patch).toEqual({ installPath: null })
    expect(sanitizeSettingsPatch({ installPath: 5 }).patch).toEqual({})
  })

  it('ignores non-object payloads entirely', () => {
    expect(sanitizeSettingsPatch(null).patch).toEqual({})
    expect(sanitizeSettingsPatch('autoWatch').patch).toEqual({})
    expect(sanitizeSettingsPatch([1, 2]).patch).toEqual({})
  })
})
