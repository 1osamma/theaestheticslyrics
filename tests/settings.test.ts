import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore, sanitizeSettings } from '../src/main/settings'

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'tal-settings-')), 'settings.json')

describe('sanitizeSettings', () => {
  it('returns defaults for missing or non-object input', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings('nope')).toEqual(DEFAULT_SETTINGS)
  })

  it('uses precise word timing by default and can turn it off', () => {
    expect(DEFAULT_SETTINGS.wordLevel).toBe(true)
    expect(sanitizeSettings({ wordLevel: false }).wordLevel).toBe(false)
    expect(sanitizeSettings({ wordLevel: 1 }).wordLevel).toBe(true)
  })

  it('does not lock Windows from the lyrics screen unless asked to', () => {
    expect(DEFAULT_SETTINGS.lockOnReturn).toBe(false)
    expect(sanitizeSettings({ lockOnReturn: 'yes' }).lockOnReturn).toBe(false)
  })

  it('repairs each invalid field on its own', () => {
    const s = sanitizeSettings({
      style: 'x',
      offsetMs: 99999,
      colors: { lyric: 'red', highlight: '#00FF00' },
      idleMinutes: 3,
      showOn: 'always'
    })
    expect(s.style).toBe('ship')
    expect(s.offsetMs).toBe(1000)
    expect(s.colors.lyric).toBe(DEFAULT_SETTINGS.colors.lyric)
    expect(s.colors.highlight).toBe('#00ff00')
    expect(s.colors.secondary).toBe(DEFAULT_SETTINGS.colors.secondary)
    expect(s.idleMinutes).toBe(2)
    expect(s.showOn).toBe('always')
  })

  it('keeps valid values and rounds the offset', () => {
    const s = sanitizeSettings({
      style: 'fisheye-visual',
      showOn: 'lock',
      displayId: 42,
      autoSync: true,
      offsetMs: -250.4,
      idleMinutes: 0,
      allPlayers: true,
      launchAtLogin: true,
      welcomed: true,
      lockOnReturn: true
    })
    expect(s).toMatchObject({
      lockOnReturn: true,
      style: 'fisheye-visual',
      displayId: 42,
      autoSync: true,
      offsetMs: -250,
      idleMinutes: 0,
      allPlayers: true,
      launchAtLogin: true,
      welcomed: true
    })
  })
})

describe('LUMINA player settings', () => {
  it('opens the LUMINA player with ambient light by default, at the display refresh rate', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      layout: 'player',
      ambient: true,
      ambientBrightness: 0.7,
      animation: 'medium',
      reducedMotion: false,
      lyricScale: 1,
      frameRateCap: 0
    })
  })

  it('loads a settings file from before LUMINA unchanged, adding only the new defaults', () => {
    const old = {
      version: 1,
      style: 'visual',
      showOn: 'always',
      displayId: 7,
      autoSync: true,
      colors: { lyric: '#112233', highlight: '#445566', secondary: '#778899' },
      offsetMs: 250,
      idleMinutes: 5,
      allPlayers: true,
      launchAtLogin: true,
      welcomed: true,
      lockOnReturn: true,
      wordLevel: false
    }
    const s = sanitizeSettings(old)
    expect(s).toMatchObject(old)
    expect(s.layout).toBe(DEFAULT_SETTINGS.layout)
    expect(s.frameRateCap).toBe(DEFAULT_SETTINGS.frameRateCap)
  })

  it('keeps valid choices and repairs invalid ones field by field', () => {
    const ok = sanitizeSettings({
      layout: 'lyrics',
      ambient: false,
      ambientBrightness: 1,
      animation: 'high',
      reducedMotion: true,
      lyricScale: 1.3,
      frameRateCap: 60
    })
    expect(ok).toMatchObject({
      layout: 'lyrics',
      ambient: false,
      ambientBrightness: 1,
      animation: 'high',
      reducedMotion: true,
      lyricScale: 1.3,
      frameRateCap: 60
    })
    const bad = sanitizeSettings({
      layout: 'grid',
      ambient: 'yes',
      ambientBrightness: 0.55,
      animation: 'wild',
      reducedMotion: 1,
      lyricScale: 4,
      frameRateCap: 240
    })
    expect(bad).toMatchObject({
      layout: DEFAULT_SETTINGS.layout,
      ambient: DEFAULT_SETTINGS.ambient,
      ambientBrightness: DEFAULT_SETTINGS.ambientBrightness,
      animation: DEFAULT_SETTINGS.animation,
      reducedMotion: DEFAULT_SETTINGS.reducedMotion,
      lyricScale: DEFAULT_SETTINGS.lyricScale,
      frameRateCap: DEFAULT_SETTINGS.frameRateCap
    })
  })

  it('persists player settings', () => {
    const file = tempFile()
    new SettingsStore(file).update({ layout: 'lyrics', frameRateCap: 120, lyricScale: 1.15 })
    expect(new SettingsStore(file).get()).toMatchObject({ layout: 'lyrics', frameRateCap: 120, lyricScale: 1.15 })
  })
})

describe('SettingsStore', () => {
  it('persists updates across instances', () => {
    const file = tempFile()
    new SettingsStore(file).update({ style: 'visual', offsetMs: -250 })
    const reopened = new SettingsStore(file)
    expect(reopened.get().style).toBe('visual')
    expect(JSON.parse(readFileSync(file, 'utf8')).offsetMs).toBe(-250)
  })

  it('merges partial colour updates', () => {
    const store = new SettingsStore(tempFile())
    store.update({ colors: { ...store.get().colors, lyric: '#112233' } })
    expect(store.get().colors).toEqual({ ...DEFAULT_SETTINGS.colors, lyric: '#112233' })
  })

  it('notifies listeners and supports unsubscribe', () => {
    const store = new SettingsStore(tempFile())
    const listener = vi.fn()
    const off = store.onChange(listener)
    store.update({ autoSync: true })
    off()
    store.update({ autoSync: false })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0].autoSync).toBe(true)
  })

  it('falls back to defaults when the file is corrupt', () => {
    const file = tempFile()
    writeFileSync(file, '{not json', 'utf8')
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS)
  })
})
