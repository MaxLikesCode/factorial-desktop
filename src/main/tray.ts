/**
 * The tray icon: the app's only surface while the widget is hidden, and the only
 * way out of the app at all (closing the widget hides it — DESIGN.md, "Tray").
 *
 * This is the Electron half. Every decision about *what* to show — the label,
 * the status line, the tooltip, the menu, the German text of a failed action —
 * lives in `tray-menu.ts`, which has no Electron import and is unit tested. What
 * is left here is wiring, the icons, and the re-render cadence, and it is
 * verified by running the app.
 *
 * The platform split is the point of this file:
 *
 * - **macOS** shows the running time as menubar text next to a monochrome
 *   template icon that the system re-tints for light and dark mode.
 * - **Windows** has no `setTitle`. There the state is carried by a colour-coded
 *   `.ico`, the time by the tooltip, and both by the first, disabled entry of
 *   the context menu. Every one of those branches carries a platform comment
 *   and is explained in `docs/DESIGN.md`.
 */

import { Menu, Tray, app, nativeImage, type NativeImage } from 'electron'
import { join } from 'node:path'
import { describeSettingsWriteFailure } from '@shared/errors'
import { resolveLocale } from '@shared/i18n'
import { translatorFor } from '@shared/locales'
import type { AppSettings } from '@shared/ipc-contract'
import type { AttendanceStore, ClockInInput } from './attendance'
import { showAbout } from './about'
import type { Settings } from './settings'
import type { UpdateStatus } from './update-policy'
import {
  buildTrayMenu,
  trayActionErrorText,
  trayLabel,
  trayTone,
  trayTooltip,
  type TrayTone,
} from './tray-menu'
import { getWidget, showWidget, toggleWidget } from './windows'

/** Exactly what the tray calls. `startPolling` is lifecycle and stays in `index.ts`. */
export type TrayStore = Pick<
  AttendanceStore,
  'getSnapshot' | 'subscribe' | 'refresh' | 'clockIn' | 'startBreak' | 'endBreak' | 'clockOut'
>

export interface TrayDeps {
  store: TrayStore
  /**
   * The persisted settings behind the "Einstellungen" submenu — the app's only
   * surface for them (DESIGN.md, "Einstellungen").
   *
   * `index.ts` passes the same `withWindowEffects`-wrapped store the IPC layer
   * gets, so an Always-on-Top toggled here applies to the live window
   * immediately instead of on the next start.
   */
  settings: Settings
  /**
   * The remembered work location, read at click time. The tray must not keep a
   * second default: hard-coding `office` here would file a shift at the wrong
   * *place* whenever the user's saved preference is something else.
   */
  clockInInput: () => ClockInInput
  /**
   * Drops the session cookie and opens the login window — as the widget does.
   *
   * One callback for both menu entries: "Anmelden" (no session left to keep) and
   * "Abmelden" (a session the user wants gone) differ only in which of the two
   * the wording fits, not in what has to happen.
   */
  onSignIn: () => void
  /** Looks for a new version now and reports either way. See `updater.ts`. */
  onCheckForUpdates: () => void
  /**
   * What the updater is doing, read per render. Pulled rather than pushed so
   * the menu cannot show a percentage that has since moved on; `refreshTray()`
   * is what makes it move at download speed instead of at `RENDER_INTERVAL_MS`.
   */
  getUpdateStatus: () => UpdateStatus
  onQuit: () => void
}

/**
 * The label only ever changes by the minute, so this is fast enough to look
 * live and slow enough to be invisible. Between ticks every store change
 * re-renders anyway.
 */
const RENDER_INTERVAL_MS = 15_000

/**
 * DESIGN.md wants a reload when the tray is opened. Opening cannot be observed
 * directly, so hovering and clicking stand in for it — and both can repeat
 * quickly, hence the floor.
 */
const OPEN_REFRESH_MIN_INTERVAL_MS = 10_000

const ICON_DIR = join(import.meta.dirname, '../../resources')

const iconCache = new Map<string, NativeImage>()

function loadIcon(file: string): NativeImage {
  const cached = iconCache.get(file)
  if (cached) return cached

  const image = nativeImage.createFromPath(join(ICON_DIR, file))
  if (image.isEmpty()) {
    // Not fatal: a tray with an empty image still carries the menu, and on macOS
    // the title alone remains readable. Worth one loud line, because an invisible
    // tray icon looks exactly like a crashed app.
    console.error('[tray] icon missing or unreadable:', join(ICON_DIR, file))
  }
  iconCache.set(file, image)
  return image
}

function iconFor(tone: TrayTone): NativeImage {
  // PLATFORM: macOS wants one monochrome *template* image — the system tints it
  // for light mode, dark mode and the highlighted menubar, so a coloured icon
  // would fight the OS. State is shown next to it as menubar text instead.
  // Windows has no such text, so the state has to be in the icon: a coloured
  // `.ico` per tone, each holding 16/32/48 px for DPI scaling.
  if (process.platform === 'darwin') {
    const image = loadIcon('trayTemplate.png')
    image.setTemplateImage(true)
    return image
  }

  const ico = loadIcon(`tray-${tone}.ico`)
  // PLATFORM: the `.ico` files could not be verified on macOS — Electron there
  // has no ICO decoder at all (measured: every `.ico` comes back as an empty
  // 0×0 image, including one written as plain BMP entries). A tray whose image
  // is empty is an invisible icon, and an invisible icon on Windows means an
  // app that cannot be shown or quit. The PNG is decodable on every platform,
  // so it stands in rather than leaving that outcome to chance.
  return ico.isEmpty() ? loadIcon(`tray-${tone}.png`) : ico
}

let tray: Tray | null = null

/**
 * The live tray's render function, so something outside can ask for a redraw.
 *
 * The updater needs this: a download advances several times a second, and the
 * store — which drives every other render — knows nothing about it.
 */
let renderTray: (() => void) | null = null

/** Redraws the tray now. Does nothing when there is no tray. */
export function refreshTray(): void {
  renderTray?.()
}

/** Whether a tray exists — `index.ts` keeps the app alive only while one does. */
export function hasTray(): boolean {
  return tray !== null && !tray.isDestroyed()
}

export function createTray(deps: TrayDeps): Tray {
  const initialTone = trayTone(deps.store.getSnapshot())
  const created = new Tray(iconFor(initialTone))
  tray = created

  /**
   * The last failed tray action, in German, until the next action starts.
   *
   * The tray can act while the widget is hidden, so the widget's toast is not
   * reachable; the menu itself has to say what went wrong. The text comes from
   * the shared table — the tray must not open
   * a second one.
   */
  let lastActionError: string | null = null

  function render(): void {
    if (created.isDestroyed()) return

    const snapshot = deps.store.getSnapshot()
    const now = new Date()
    // Resolved per render rather than captured: switching the language rebuilds
    // the menu through this same path, and a captured translator would keep
    // producing the old language until something else forced a render.
    const t = translatorFor(resolveLocale(deps.settings.get().language, app.getLocale()))

    // PLATFORM: `setTitle` is macOS-only — it is the live timer in the menubar
    // (DESIGN.md, "Tray"). The leading space separates the text from the icon.
    if (process.platform === 'darwin') {
      const label = trayLabel(t, snapshot, now)
      created.setTitle(label === '' ? '' : ` ${label}`)
    } else {
      // PLATFORM: Windows shows no text next to the icon, so the state is the
      // icon's colour. Re-set on every render because the tone changes with the
      // state.
      created.setImage(iconFor(trayTone(snapshot)))
    }

    created.setToolTip(trayTooltip(t, snapshot, now))

    created.setContextMenu(
      Menu.buildFromTemplate(
        buildTrayMenu({
          t,
          snapshot,
          now,
          windowVisible: getWidget()?.isVisible() ?? false,
          lastActionError,
          // Read per render, not captured once: the widget's IPC path writes to
          // the same store, and a checkbox may not keep showing a value that has
          // since been changed elsewhere.
          settings: deps.settings.get(),
          updateStatus: deps.getUpdateStatus(),
          actions: {
            clockIn: () => run(() => deps.store.clockIn(deps.clockInInput())),
            startBreak: (id) => run(() => deps.store.startBreak(id)),
            endBreak: () => run(() => deps.store.endBreak()),
            clockOut: () => run(() => deps.store.clockOut()),
            about: () => void showAbout(t),
            signIn: () => {
              lastActionError = null
              deps.onSignIn()
            },
            // Same call: see `TrayDeps.onSignIn`.
            signOut: () => {
              lastActionError = null
              deps.onSignIn()
            },
            setOpenAtLogin: (value) => applySetting({ openAtLogin: value }),
            setAlwaysOnTop: (value) => applySetting({ alwaysOnTop: value }),
            setAutoInstallUpdates: (value) => applySetting({ autoInstallUpdates: value }),
            setTheme: (value) => applySetting({ theme: value }),
            setExpandDirection: (value) => applySetting({ expandDirection: value }),
            setLanguage: (value) => applySetting({ language: value }),
            toggleWindow: () => {
              toggleWidget()
              // `isVisible()` decides the menu's wording, so the menu has to be
              // rebuilt after the window changed.
              render()
            },
            refresh: () => {
              lastActionError = null
              void deps.store.refresh()
            },
            checkForUpdates: deps.onCheckForUpdates,
            quit: deps.onQuit,
          },
        }),
      ),
    )
  }

  /**
   * Runs a store action and keeps its outcome visible in the menu.
   *
   * A failure is never swallowed and never retried: this writes to a real time
   * record, and a repeat a minute later files a minute nobody worked
   * (DESIGN.md, "Kein Offline-Queue"). The store has already rolled back and
   * reloaded by the time the rejection arrives here.
   */
  function run(action: () => Promise<void>): void {
    lastActionError = null
    render()
    void action().then(render, (error: unknown) => {
      // Covers the race this task called out: a tray click and a widget click
      // reaching the store together, where the second one is refused as `busy`.
      lastActionError = trayActionErrorText(
        translatorFor(resolveLocale(deps.settings.get().language, app.getLocale())),
        error,
      )
      render()
    })
  }

  /**
   * Writes one setting and rebuilds the menu from what is actually stored.
   *
   * Electron has already flipped the clicked checkbox by the time this runs, so
   * a silent failure would leave a tick standing next to a setting that never
   * changed. `Settings.set` persists before it commits, and the write can fail
   * for real — a virus scanner can block the
   * `rename` with `EBUSY`. The re-render then restores the old tick and the
   * sentence next to it says why.
   */
  function applySetting(patch: Partial<AppSettings>): void {
    lastActionError = null
    try {
      deps.settings.set(patch)
    } catch (error) {
      console.error('[tray] settings write failed:', error)
      lastActionError = describeSettingsWriteFailure(
        translatorFor(resolveLocale(deps.settings.get().language, app.getLocale())),
      )
    }
    render()
  }

  let lastOpenRefresh = 0
  function refreshOnOpen(): void {
    const at = Date.now()
    if (at - lastOpenRefresh < OPEN_REFRESH_MIN_INTERVAL_MS) return
    lastOpenRefresh = at
    // The already-open menu keeps the snapshot it was built from; the answer
    // lands in the next render. That is the honest version of "Tray-Öffnen"
    // (DESIGN.md, "Synchronisation") — Electron reports no menu-opened event.
    void deps.store.refresh()
  }

  created.on('mouse-enter', refreshOnOpen)
  created.on('click', refreshOnOpen)
  created.on('right-click', refreshOnOpen)

  // PLATFORM: on Windows the context menu opens on right click, which leaves the
  // left click free for the platform-conventional "open the app". On macOS a
  // left click opens the menu itself, so binding it there would fight the OS.
  if (process.platform !== 'darwin') {
    created.on('click', () => toggleWidget())
  }

  // A double click is "open it" on both platforms, and unlike `click` it never
  // means "show the menu".
  created.on('double-click', () => showWidget())

  render()
  renderTray = render
  const unsubscribe = deps.store.subscribe(render)
  const timer = setInterval(render, RENDER_INTERVAL_MS)

  // `before-quit` fires for every route out of the app (the menu item, ⌘Q, an OS
  // shutdown), which is why nothing here depends on the quit item being used.
  app.on('before-quit', () => {
    clearInterval(timer)
    unsubscribe()
    if (!created.isDestroyed()) created.destroy()
    if (tray === created) tray = null
    if (renderTray === render) renderTray = null
  })

  return created
}
