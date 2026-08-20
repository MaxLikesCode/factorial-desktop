import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from '@shared/ipc-contract'
import { DEFAULT_SETTINGS, buildLoginItemSettings, createSettings } from '../settings'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fd-'))
  file = join(dir, 'settings.json')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function read(): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}

describe('createSettings', () => {
  it('returns defaults when no file exists yet', () => {
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    expect(s.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('persists a change and reloads it', () => {
    const s1 = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    s1.set({ alwaysOnTop: false })
    const s2 = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    expect(s2.get().alwaysOnTop).toBe(false)
  })

  it('merges a patch instead of replacing the whole object', () => {
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    s.set({ lastWorkplaceId: 3333333 })
    expect(s.get().alwaysOnTop).toBe(DEFAULT_SETTINGS.alwaysOnTop)
    expect(s.get().lastWorkplaceId).toBe(3333333)
  })

  it('applies the login-item side effect only when openAtLogin changes', () => {
    const applyLoginItem = vi.fn()
    const s = createSettings({ filePath: file, applyLoginItem, applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    applyLoginItem.mockClear()
    s.set({ alwaysOnTop: false })
    expect(applyLoginItem).not.toHaveBeenCalled()
    s.set({ openAtLogin: false })
    expect(applyLoginItem).toHaveBeenCalledWith(false)
  })

  it('does not touch the login item merely by being constructed', () => {
    // Reconciling the OS with the stored value is the caller's job (index.ts),
    // done once at startup — the store must not fire a side effect on read.
    const applyLoginItem = vi.fn()
    createSettings({ filePath: file, applyLoginItem, applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    expect(applyLoginItem).not.toHaveBeenCalled()
  })

  it('does not re-apply the login item when openAtLogin is set to what it already is', () => {
    const applyLoginItem = vi.fn()
    const s = createSettings({ filePath: file, applyLoginItem, applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    s.set({ openAtLogin: DEFAULT_SETTINGS.openAtLogin })
    expect(applyLoginItem).not.toHaveBeenCalled()
  })

  it('falls back to defaults when the file is corrupt rather than crashing at startup', () => {
    writeFileSync(file, '{ not json')
    expect(createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() }).get()).toEqual(
      DEFAULT_SETTINGS,
    )
  })

  it('falls back to defaults when the file holds something that is not an object', () => {
    writeFileSync(file, '"office"')
    expect(createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() }).get()).toEqual(
      DEFAULT_SETTINGS,
    )
  })

  it('ignores unknown keys from an older or newer version of the file', () => {
    writeFileSync(file, JSON.stringify({ alwaysOnTop: false, ancientFlag: true }))
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    expect(s.get()).toEqual({ ...DEFAULT_SETTINGS, alwaysOnTop: false })
  })

  it('writes every known key, so the file is readable without the defaults at hand', () => {
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    s.set({ openAtLogin: false, lastLocationType: 'work_from_home', lastWorkplaceId: 3333333 })
    expect(read()).toEqual({
      openAtLogin: false,
      alwaysOnTop: DEFAULT_SETTINGS.alwaysOnTop,
      lastLocationType: 'work_from_home',
      lastWorkplaceId: 3333333,
      theme: DEFAULT_SETTINGS.theme,
      expandDirection: DEFAULT_SETTINGS.expandDirection,
    })
  })

  it('creates the directory when it does not exist yet', () => {
    const nested = join(dir, 'deep', 'nested', 'settings.json')
    const s = createSettings({ filePath: nested, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    s.set({ alwaysOnTop: false })
    expect(JSON.parse(readFileSync(nested, 'utf8')) as AppSettings).toMatchObject({
      alwaysOnTop: false,
    })
  })

  it('hands out a copy, so a caller cannot mutate the stored settings', () => {
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    const snapshot = s.get()
    snapshot.alwaysOnTop = !snapshot.alwaysOnTop
    expect(s.get().alwaysOnTop).toBe(DEFAULT_SETTINGS.alwaysOnTop)
  })
})

describe('createSettings and the appearance', () => {
  it('follows the system until the user says otherwise', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system')
  })

  it('applies the theme side effect only when the value changes', () => {
    const applyTheme = vi.fn()
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme, applyExpandDirection: vi.fn() })
    s.set({ alwaysOnTop: false })
    expect(applyTheme).not.toHaveBeenCalled()
    s.set({ theme: 'dark' })
    expect(applyTheme).toHaveBeenCalledWith('dark')
  })

  it('does not touch the theme merely by being constructed', () => {
    // Reconciling `nativeTheme.themeSource` with the stored value is the
    // caller's job (index.ts), done once at startup — a fresh process always
    // starts at 'system', so a launch is not a change the store knows about.
    const applyTheme = vi.fn()
    createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme, applyExpandDirection: vi.fn() })
    expect(applyTheme).not.toHaveBeenCalled()
  })

  it('does not re-apply a theme that is set to what it already is', () => {
    const applyTheme = vi.fn()
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme, applyExpandDirection: vi.fn() })
    s.set({ theme: DEFAULT_SETTINGS.theme })
    expect(applyTheme).not.toHaveBeenCalled()
  })

  /**
   * The value is assigned straight to `nativeTheme.themeSource`, which throws on
   * anything outside the three. A stale or hand-edited settings file must not be
   * able to crash the next start.
   */
  it('keeps an unusable theme out of the store rather than passing it on', () => {
    writeFileSync(file, JSON.stringify({ theme: 'midnight' }))
    const applyTheme = vi.fn()
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme, applyExpandDirection: vi.fn() })
    expect(s.get().theme).toBe(DEFAULT_SETTINGS.theme)

    s.set({ theme: 'solarised' as never })
    expect(s.get().theme).toBe(DEFAULT_SETTINGS.theme)
    expect(applyTheme).not.toHaveBeenCalled()
  })
})

describe('createSettings and the expand direction', () => {
  it('starts at the direction that shipped first', () => {
    expect(DEFAULT_SETTINGS.expandDirection).toBe('right')
  })

  it('reports a direction change, and only a change', () => {
    const applyExpandDirection = vi.fn()
    const s = createSettings({
      filePath: file,
      applyLoginItem: vi.fn(),
      applyTheme: vi.fn(),
      applyExpandDirection,
    })

    s.set({ expandDirection: 'left' })
    expect(applyExpandDirection).toHaveBeenCalledWith('left')

    applyExpandDirection.mockClear()
    s.set({ expandDirection: 'left' })
    expect(applyExpandDirection).not.toHaveBeenCalled()
  })

  it('keeps an unusable direction out of the store', () => {
    writeFileSync(file, JSON.stringify({ expandDirection: 'diagonal' }))
    const s = createSettings({
      filePath: file,
      applyLoginItem: vi.fn(),
      applyTheme: vi.fn(),
      applyExpandDirection: vi.fn(),
    })
    expect(s.get().expandDirection).toBe(DEFAULT_SETTINGS.expandDirection)
  })
})

describe('createSettings sanitising', () => {
  it('rejects a location type the API does not know (LOCATION_TYPES)', () => {
    // The IPC layer deliberately lets any string through; this is the whitelist.
    // A bogus value would fail the clock-in mutation in-band with HTTP 200.
    writeFileSync(file, JSON.stringify({ lastLocationType: 'moon_base' }))
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    expect(s.get().lastLocationType).toBe(DEFAULT_SETTINGS.lastLocationType)
  })

  it('accepts every location type the schema does', () => {
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    for (const type of ['office', 'work_from_home', 'business_trip']) {
      s.set({ lastLocationType: type })
      expect(s.get().lastLocationType).toBe(type)
    }
  })

  it('keeps the current value when a patch carries an unusable one', () => {
    // Not the *default* — a rejected patch must leave the setting untouched.
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    s.set({ lastLocationType: 'business_trip' })
    s.set({ lastLocationType: 'moon_base' })
    expect(s.get().lastLocationType).toBe('business_trip')
  })

  it('drops a non-integer workplace id, because the schema demands Int (K4)', () => {
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    s.set({ lastWorkplaceId: 3333333 })
    s.set({ lastWorkplaceId: 1.5 })
    expect(s.get().lastWorkplaceId).toBe(3333333)
  })

  it('drops a numeric string workplace id from disk', () => {
    writeFileSync(file, JSON.stringify({ lastWorkplaceId: '3333333' }))
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    expect(s.get().lastWorkplaceId).toBeNull()
  })

  it('accepts an explicit null workplace id, which means "no workplace"', () => {
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn(), applyTheme: vi.fn(), applyExpandDirection: vi.fn() })
    s.set({ lastWorkplaceId: 3333333 })
    s.set({ lastWorkplaceId: null })
    expect(s.get().lastWorkplaceId).toBeNull()
  })
})

describe('createSettings when the file cannot be written', () => {
  it('leaves the in-memory settings unchanged rather than diverging from disk', () => {
    // A regular file where a directory belongs: mkdirSync fails with ENOTDIR.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const applyLoginItem = vi.fn()
    const s = createSettings({ filePath: join(blocker, 'settings.json'), applyLoginItem, applyTheme: vi.fn(), applyExpandDirection: vi.fn() })

    expect(() => s.set({ openAtLogin: false })).toThrow()
    expect(s.get()).toEqual(DEFAULT_SETTINGS)
    // The login item must not be flipped for a change that was never stored.
    expect(applyLoginItem).not.toHaveBeenCalled()
  })
})

describe('buildLoginItemSettings', () => {
  it('registers the bundle itself on macOS, without a path', () => {
    expect(
      buildLoginItemSettings({
        openAtLogin: true,
        platform: 'darwin',
        execPath: '/Applications/Factorial Desktop.app/Contents/MacOS/Factorial Desktop',
      }),
    ).toEqual({ openAtLogin: true })
  })

  it('names the executable explicitly on Windows', () => {
    expect(
      buildLoginItemSettings({
        openAtLogin: true,
        platform: 'win32',
        execPath: 'C:\\Users\\max\\AppData\\Local\\factorial-desktop\\Factorial Desktop.exe',
      }),
    ).toEqual({
      openAtLogin: true,
      path: 'C:\\Users\\max\\AppData\\Local\\factorial-desktop\\Factorial Desktop.exe',
      args: [],
    })
  })

  it('carries the off state through on both platforms', () => {
    expect(
      buildLoginItemSettings({ openAtLogin: false, platform: 'win32', execPath: 'x.exe' }),
    ).toMatchObject({ openAtLogin: false })
    expect(
      buildLoginItemSettings({ openAtLogin: false, platform: 'darwin', execPath: 'x' }),
    ).toEqual({ openAtLogin: false })
  })

  it('treats any other platform like macOS instead of writing a Windows Run key', () => {
    expect(buildLoginItemSettings({ openAtLogin: true, platform: 'linux', execPath: 'x' })).toEqual(
      { openAtLogin: true },
    )
  })
})
