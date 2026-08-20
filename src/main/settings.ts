/**
 * The handful of things the app remembers between runs, as a JSON file under
 * `app.getPath('userData')`.
 *
 * Three properties matter more than the feature itself.
 *
 * 1. **No Electron import.** The store takes its file path and its login-item
 *    side effect as arguments, so the whole thing is unit tested against a real
 *    temp directory instead of a mocked `app`. `index.ts` supplies both.
 * 2. **A settings file never blocks startup.** Missing, truncated, corrupt or
 *    written by a future version — every one of those ends in the defaults, not
 *    in an exception. The alternative is an app that cannot start because of a
 *    file that only holds preferences.
 * 3. **Only values the rest of the app can actually use get stored.** The IPC
 *    layer deliberately performs the cheap checks (is this a string at all?);
 *    the semantic whitelist lives here, at the last point before a value is
 *    written down and read back on the next start. `lastLocationType` is the
 *    sharp one: `AttendanceShiftLocationTypeEnum` accepts exactly three values
 *    (K4/`LOCATION_TYPES`) and the mutation rejects everything else in-band with
 *    HTTP 200 — a bad value persisted today would look like a server fault
 *    tomorrow.
 *
 * A rejected value falls back to what is *currently* stored, not to the default:
 * a nonsense patch must leave a setting alone, not silently reset it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isThemeSetting, type AppSettings, type ThemeSetting } from '@shared/ipc-contract'
import { isLocationType } from './factorial/types'

export const DEFAULT_SETTINGS: AppSettings = {
  // Autostart on by default — DESIGN.md, "Einstellungen". The OS is only told
  // about it when the value changes, plus once at startup by `index.ts`.
  openAtLogin: true,
  alwaysOnTop: true,
  lastLocationType: 'office',
  lastWorkplaceId: null,
  // Follow the OS unless the user says otherwise. A widget that sits on the
  // desktop all day should match what everything around it is doing.
  theme: 'system',
}

export interface SettingsDeps {
  filePath: string
  /** Called with the new value whenever `openAtLogin` actually changes. */
  applyLoginItem: (openAtLogin: boolean) => void
  /** Called with the new value whenever `theme` actually changes. */
  applyTheme: (theme: ThemeSetting) => void
}

/**
 * Structurally identical to `IpcSettings` in `ipc-handlers.ts`, which is what
 * lets this drop into `registerIpc` unchanged.
 */
export interface Settings {
  get(): AppSettings
  set(patch: Partial<AppSettings>): AppSettings
}

/**
 * Keeps only known keys with usable values, so neither a stale file nor a future
 * one injects surprises. `base` is what an unusable value falls back to.
 */
function sanitise(raw: unknown, base: AppSettings): AppSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...base }
  const r = raw as Partial<Record<keyof AppSettings, unknown>>
  return {
    openAtLogin: typeof r.openAtLogin === 'boolean' ? r.openAtLogin : base.openAtLogin,
    alwaysOnTop: typeof r.alwaysOnTop === 'boolean' ? r.alwaysOnTop : base.alwaysOnTop,
    // Whitelisted against the enum, not merely type-checked: see note 3 above.
    lastLocationType:
      typeof r.lastLocationType === 'string' && isLocationType(r.lastLocationType)
        ? r.lastLocationType
        : base.lastLocationType,
    // K4: workplaceId is an Int. A string or a fraction would be rejected by the
    // clock-in mutation, so neither is allowed to reach it. `null` is a real
    // value here — it means "no workplace" — and is kept.
    lastWorkplaceId:
      r.lastWorkplaceId === null
        ? null
        : typeof r.lastWorkplaceId === 'number' && Number.isInteger(r.lastWorkplaceId)
          ? r.lastWorkplaceId
          : base.lastWorkplaceId,
    // Whitelisted rather than merely typed: the value is assigned straight to
    // `nativeTheme.themeSource`, which throws on anything outside the three.
    theme:
      typeof r.theme === 'string' && isThemeSetting(r.theme) ? r.theme : base.theme,
  }
}

export function createSettings({ filePath, applyLoginItem, applyTheme }: SettingsDeps): Settings {
  let current: AppSettings
  try {
    current = sanitise(JSON.parse(readFileSync(filePath, 'utf8')) as unknown, DEFAULT_SETTINGS)
  } catch {
    // Missing or corrupt file must never block startup.
    current = { ...DEFAULT_SETTINGS }
  }

  /** Write-then-rename, so a crash mid-write cannot truncate the live file. */
  function persist(next: AppSettings): void {
    mkdirSync(dirname(filePath), { recursive: true })
    const temp = `${filePath}.tmp`
    writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(temp, filePath)
  }

  return {
    // A copy: `get()` feeds the IPC reply and the tray menu, and neither may be
    // able to change what is stored by writing to the object it was handed.
    get: () => ({ ...current }),

    set(patch: Partial<AppSettings>): AppSettings {
      const next = sanitise({ ...current, ...patch }, current)
      // Persist before committing. If the disk says no, the caller finds out and
      // the in-memory state still matches what is on disk — an unwritable file
      // must not produce settings that disappear on the next start.
      persist(next)
      const loginItemChanged = next.openAtLogin !== current.openAtLogin
      const themeChanged = next.theme !== current.theme
      current = next
      if (loginItemChanged) applyLoginItem(current.openAtLogin)
      if (themeChanged) applyTheme(current.theme)
      return { ...current }
    },
  }
}

/** The subset of Electron's login-item settings this app sets. */
export interface LoginItemSettings {
  openAtLogin: boolean
  path?: string
  args?: string[]
}

export interface LoginItemInput {
  openAtLogin: boolean
  platform: NodeJS.Platform
  /** `process.execPath` at the call site — passed in so both branches are testable. */
  execPath: string
}

/**
 * Builds the argument for `app.setLoginItemSettings`. Pure on purpose: it takes
 * the platform instead of reading `process.platform`, which is the only way the
 * Windows branch can be tested at all from a macOS machine.
 */
export function buildLoginItemSettings({
  openAtLogin,
  platform,
  execPath,
}: LoginItemInput): LoginItemSettings {
  // PLATFORM: Windows autostart is a Run-key entry that names an executable.
  // Without an explicit `path` Electron registers whatever is running — in dev
  // that is `electron.exe`, and for a packaged app the recorded target must be
  // the installed .exe, not the launcher that happened to start it (DESIGN.md,
  // "Windows-Übergabe", row "Autostart"). Untested: no Windows machine here.
  if (platform === 'win32') return { openAtLogin, path: execPath, args: [] }

  // PLATFORM: macOS registers the .app bundle itself via the Service Management
  // API; a `path` here would point at the helper binary inside the bundle and
  // register the wrong thing. Everything that is not Windows takes this branch —
  // on Linux `setLoginItemSettings` is a no-op, which is the safe outcome.
  return { openAtLogin }
}
