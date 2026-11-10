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
  it('opens the LUMINA player by default, at the display refresh rate', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      version: 2,
      layout: 'player',
      animation: 'medium',
      reducedMotion: false,
      lyricScale: 1,
      frameRateCap: 0
    })
  })

  it('loads a settings file from before LUMINA, keeping every value and adding the new defaults', () => {
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
    const { version: _version, ...values } = old
    expect(s).toMatchObject(values)
    expect(s.version).toBe(2)
    expect(s.layout).toBe(DEFAULT_SETTINGS.layout)
    expect(s.lightingMode).toBe('hybrid')
    expect(s.edgeLighting).toBe(false)
  })

  it('keeps valid choices and repairs invalid ones field by field', () => {
    const ok = sanitizeSettings({
      version: 2,
      layout: 'lyrics',
      animation: 'high',
      reducedMotion: true,
      lyricScale: 1.3,
      frameRateCap: 60
    })
    expect(ok).toMatchObject({ layout: 'lyrics', animation: 'high', reducedMotion: true, lyricScale: 1.3, frameRateCap: 60 })
    const bad = sanitizeSettings({ version: 2, layout: 'grid', animation: 'wild', reducedMotion: 1, lyricScale: 4, frameRateCap: 240 })
    expect(bad).toMatchObject({
      layout: DEFAULT_SETTINGS.layout,
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

describe('LUMINA Lighting settings', () => {
  it('uses the suggested defaults: hybrid, 45% brightness, edge lighting off until enabled', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      lightingMode: 'hybrid',
      fullscreenLighting: true,
      edgeLighting: false,
      lightingBrightness: 0.45,
      audioSensitivity: 0.6,
      bassStrength: 0.55,
      lightingSmoothing: 0.7,
      lightingFps: 60,
      audioSource: 'auto',
      pauseInFullscreen: true,
      edgeDisplays: 'primary'
    })
  })

  it('migrates Phase 1 ambient settings without losing them', () => {
    expect(sanitizeSettings({ version: 1, ambient: false, ambientBrightness: 1 })).toMatchObject({
      fullscreenLighting: false,
      lightingBrightness: 0.65
    })
    expect(sanitizeSettings({ version: 1, ambient: true, ambientBrightness: 0.4 })).toMatchObject({
      fullscreenLighting: true,
      lightingBrightness: 0.3
    })
    // A version-2 file is read as written, never re-migrated.
    expect(sanitizeSettings({ version: 2, ambient: false, fullscreenLighting: true, lightingBrightness: 0.8 })).toMatchObject({
      fullscreenLighting: true,
      lightingBrightness: 0.8
    })
  })

  it('bounds every level and rejects unknown choices', () => {
    const s = sanitizeSettings({
      version: 2,
      lightingMode: 'disco',
      lightingBrightness: 0,
      audioSensitivity: 7,
      bassStrength: -1,
      lightingSmoothing: Number.NaN,
      edgeThickness: 0,
      lightingFps: 75,
      audioSource: 'microphone',
      edgeDisplays: 'left',
      edgeSides: { left: false, top: 'yes' }
    })
    expect(s).toMatchObject({
      lightingMode: 'hybrid',
      lightingBrightness: 0.05,
      audioSensitivity: 1,
      bassStrength: 0,
      lightingSmoothing: DEFAULT_SETTINGS.lightingSmoothing,
      edgeThickness: 0.05,
      lightingFps: 60,
      audioSource: 'auto',
      edgeDisplays: 'primary',
      edgeSides: { left: false, right: true, top: false, bottom: true }
    })
    expect(sanitizeSettings({ version: 2, edgeDisplays: 42, lightingFps: 240, audioSource: 'system' })).toMatchObject({
      edgeDisplays: 42,
      lightingFps: 240,
      audioSource: 'system'
    })
  })

  it('merges partial edge-side updates and persists lighting settings', () => {
    const file = tempFile()
    const store = new SettingsStore(file)
    store.update({ edgeSides: { ...store.get().edgeSides, top: true }, lightingMode: 'bass', edgeLighting: true })
    const reopened = new SettingsStore(file).get()
    expect(reopened.edgeSides).toEqual({ left: true, right: true, top: true, bottom: true })
    expect(reopened).toMatchObject({ lightingMode: 'bass', edgeLighting: true, version: 2 })
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
