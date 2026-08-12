/**
 * The widget window: frameless, always on top, and always somewhere the user can
 * actually see it.
 *
 * This is the Electron half — a real `BrowserWindow`, the real `screen` module,
 * a real file on disk. Every decision it makes is delegated to
 * `window-position.ts`, which has no Electron import and is unit tested; what is
 * left here is wiring and is verified by running the app.
 *
 * Two behaviours are worth knowing before changing anything:
 *
 * 1. **Closing hides.** DESIGN.md ("Tray"): the window's close button must not
 *    end the app; quitting goes through the tray. The `close` event is therefore
 *    cancelled unless the app is genuinely on its way out.
 * 2. **The saved position is re-validated on every start and whenever the
 *    displays change.** A frameless window with `skipTaskbar` that lands on a
 *    monitor which is no longer attached is unreachable by any normal means.
 */

import { BrowserWindow, app, screen } from 'electron'
import { join } from 'node:path'
import {
  clampToVisibleArea,
  readPositionStore,
  recordPosition,
  resolveWidgetPosition,
  writePositionStore,
  type DisplayInfo,
  type Point,
  type PositionStore,
} from './window-position'

/** DESIGN.md says "ca. 320×210"; this is that, with room for the action bar. */
export const WIDGET_SIZE = { width: 340, height: 224 } as const

// Re-exported so consumers (and PLAN.md's stated interface) can keep importing
// the placement logic from `./windows` without pulling in Electron themselves.
export {
  clampToVisibleArea,
  type DisplayBounds,
  type DisplayInfo,
  type Point,
} from './window-position'

/** `moved` can fire per pixel of a drag on some platforms; one write is enough. */
const POSITION_WRITE_DELAY_MS = 250

let widget: BrowserWindow | null = null

/**
 * Set once the app is really quitting, so the `close` handler stops swallowing
 * the event.
 *
 * PLAN.md used a `globalThis.__quitting` flag written by the tray's quit item.
 * `before-quit` fires for *every* route out of the app — the tray item, ⌘Q, a
 * `window-all-closed` quit, an OS shutdown — so listening to it covers cases the
 * flag would have missed, and needs no global.
 */
let quitting = false
let beforeQuitHooked = false

/**
 * Registered from inside `createWidgetWindow` rather than at module scope: a
 * top-level `app.on` would make this module impossible to import anywhere
 * Electron is absent, and would stack up a listener per rebuilt window.
 */
function hookBeforeQuit(): void {
  if (beforeQuitHooked) return
  beforeQuitHooked = true
  app.on('before-quit', () => {
    quitting = true
  })
}

/** Reads the current screen layout, primary display first (see `clampToVisibleArea`). */
function currentDisplays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay()
  const rest = screen.getAllDisplays().filter((d) => d.id !== primary.id)
  // `workArea`, not `bounds`: it excludes the macOS menu bar and Dock and the
  // Windows taskbar, so the widget is never placed underneath them.
  return [primary, ...rest].map((d) => ({ id: String(d.id), bounds: d.workArea }))
}

export function createWidgetWindow(deps: {
  positionFile: string
  alwaysOnTop: boolean
}): BrowserWindow {
  hookBeforeQuit()

  let store: PositionStore = readPositionStore(deps.positionFile)
  const { x, y } = resolveWidgetPosition(store, currentDisplays(), WIDGET_SIZE)

  const win = new BrowserWindow({
    ...WIDGET_SIZE,
    x,
    y,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    // PLATFORM: macOS renders a rounded, shadowed transparent window natively.
    // Windows draws a square shadow around transparent windows and needs a fully
    // transparent background colour to avoid a white rectangle behind the
    // rounded corners; verify on Windows.
    backgroundColor: '#00000000',
    alwaysOnTop: deps.alwaysOnTop,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // electron-vite emits an ESM preload (`.mjs`, because package.json says
      // "type": "module"), and Electron refuses to load one into a sandboxed
      // renderer. The preload still gets nothing but `contextBridge` and
      // `ipcRenderer`; the renderer itself keeps context isolation and no Node.
      sandbox: false,
    },
  })
  widget = win

  // PLATFORM: keeps the widget visible above full-screen spaces on macOS, which
  // is the whole point of a floating time tracker. `visibleOnFullScreen` is a
  // macOS-only option; on Windows the call is a no-op and the always-on-top flag
  // alone has to carry it.
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  let writeTimer: NodeJS.Timeout | null = null
  let pending: Point | null = null

  function flushPosition(): void {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    if (!pending) return
    store = recordPosition(store, currentDisplays(), pending, WIDGET_SIZE)
    pending = null
    writePositionStore(deps.positionFile, store)
  }

  win.on('moved', () => {
    if (win.isDestroyed()) return
    // `getBounds()` rather than `getPosition()`: it is typed as an object, so no
    // index access has to be defaulted away under `noUncheckedIndexedAccess`.
    const { x: nx, y: ny } = win.getBounds()
    pending = { x: nx, y: ny }
    if (writeTimer) clearTimeout(writeTimer)
    writeTimer = setTimeout(flushPosition, POSITION_WRITE_DELAY_MS)
  })

  /**
   * Unplugging a monitor or changing its resolution while the app runs can strand
   * the window off-screen. The same validation that runs at startup runs again
   * here, against the layout that exists now.
   */
  function revalidatePosition(): void {
    if (win.isDestroyed()) return
    const { x: cx, y: cy } = win.getBounds()
    const displays = currentDisplays()
    const next = clampToVisibleArea(
      { x: cx, y: cy },
      displays.map((d) => d.bounds),
      WIDGET_SIZE,
    )
    if (next.x !== cx || next.y !== cy) win.setPosition(next.x, next.y)
  }

  screen.on('display-removed', revalidatePosition)
  screen.on('display-added', revalidatePosition)
  screen.on('display-metrics-changed', revalidatePosition)

  // DESIGN.md, "Tray": closing hides, quitting happens through the tray's
  // "Beenden" (Task 12) or ⌘Q on macOS — `before-quit` covers both, plus an OS
  // shutdown.
  win.on('close', (event) => {
    if (quitting) {
      flushPosition()
      return
    }
    event.preventDefault()
    win.hide()
  })

  win.on('closed', () => {
    screen.removeListener('display-removed', revalidatePosition)
    screen.removeListener('display-added', revalidatePosition)
    screen.removeListener('display-metrics-changed', revalidatePosition)
    if (writeTimer) clearTimeout(writeTimer)
    if (widget === win) widget = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.show())
  return win
}

export function getWidget(): BrowserWindow | null {
  return widget && !widget.isDestroyed() ? widget : null
}

export function showWidget(): void {
  const w = getWidget()
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

export function toggleWidget(): void {
  const w = getWidget()
  if (!w) return
  if (w.isVisible() && !w.isMinimized()) w.hide()
  else showWidget()
}

/**
 * Applies the `alwaysOnTop` setting to the live window. Without this the toggle
 * in the settings only takes effect on the next start (carry-forward from
 * Task 9). A no-op before the window exists — the constructor option covers that
 * case.
 */
export function setWidgetAlwaysOnTop(value: boolean): void {
  getWidget()?.setAlwaysOnTop(value)
}
