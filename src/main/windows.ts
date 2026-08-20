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
  keepCardInPlace,
  windowSize,
  type ExpandDirection,
} from '@shared/widget-size'
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

/** `moved` can fire per pixel of a drag on some platforms; one write is enough. */
const POSITION_WRITE_DELAY_MS = 250

/**
 * Which way the card grows, kept here because the window's own placement depends
 * on it: the card sits against the edge it does not grow into, so the direction
 * decides where inside this window the visible thing actually is.
 *
 * The window itself never changes size. It is always the expanded card plus the
 * room the opening spring overshoots into — see `src/shared/widget-size.ts` for
 * why growing the real window is not an option.
 */
let currentDirection: ExpandDirection = 'right'

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
  expandDirection: ExpandDirection
}): BrowserWindow {
  hookBeforeQuit()

  currentDirection = deps.expandDirection

  let store: PositionStore = readPositionStore(deps.positionFile)
  const { x, y } = resolveWidgetPosition(store, currentDisplays(), windowSize())

  const win = new BrowserWindow({
    ...windowSize(),
    x,
    y,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    // PLATFORM: a double click on a draggable region is a title-bar double click
    // as far as the platform is concerned, and both platforms have a window
    // action bound to it — macOS whatever "Double-click a window's title bar to"
    // is set to, Windows maximise/restore. For a `skipTaskbar` widget with no
    // frame, being minimised means being gone: there is no taskbar button and no
    // Dock tile to bring it back, only the tray's "Fenster zeigen". Refusing
    // both actions closes that trap and is what leaves the gesture free for the
    // card's own expand/collapse. Verified on neither platform.
    minimizable: false,
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
    store = recordPosition(store, currentDisplays(), pending, windowSize())
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
      windowSize(),
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
    // A drag loop that outlived its window would keep firing against a destroyed
    // handle every 16 ms for the rest of the session.
    stopDragLoop()
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

/** Roughly one frame; the cursor is sampled this often while a drag runs. */
const DRAG_INTERVAL_MS = 16

let dragTimer: NodeJS.Timeout | null = null

function stopDragLoop(): void {
  if (dragTimer === null) return
  clearInterval(dragTimer)
  dragTimer = null
}

/**
 * Moves the window with the pointer, for as long as the renderer says so.
 *
 * The Minimal card cannot be a `-webkit-app-region: drag` region. A draggable
 * region is a title bar as far as the platform is concerned, and the platform
 * then keeps the double click on it for itself — which is the card's second way
 * to open, and was reported as simply not working. So the drag is run here
 * instead, and the card is an ordinary element that receives its own events.
 *
 * The cursor is read from the SCREEN rather than taken from the renderer, and
 * that is the part worth not changing. Pointer coordinates in the renderer are
 * relative to a window that this loop is moving underneath them, so a drag built
 * on those feeds its own output back into its input and either drifts or
 * oscillates. The screen's cursor is the one frame of reference that stands
 * still. The grab offset is taken once, at the start, and the window is simply
 * placed at cursor plus offset every tick — no deltas to accumulate, so nothing
 * to accumulate error in either.
 *
 * The position is not clamped per tick: fighting the cursor mid-drag feels
 * broken. It is clamped once when the drag ends, which is also when the position
 * is written down.
 */
export function setWidgetDragging(dragging: boolean): void {
  stopDragLoop()
  if (!widget || widget.isDestroyed()) return

  if (!dragging) {
    const { x, y } = widget.getBounds()
    const next = clampToVisibleArea(
      { x, y },
      currentDisplays().map((d) => d.bounds),
      windowSize(),
    )
    if (next.x !== x || next.y !== y) widget.setPosition(next.x, next.y)
    return
  }

  const start = screen.getCursorScreenPoint()
  const bounds = widget.getBounds()
  const offsetX = bounds.x - start.x
  const offsetY = bounds.y - start.y

  dragTimer = setInterval(() => {
    if (!widget || widget.isDestroyed()) {
      stopDragLoop()
      return
    }
    const cursor = screen.getCursorScreenPoint()
    widget.setPosition(cursor.x + offsetX, cursor.y + offsetY)
  }, DRAG_INTERVAL_MS)
}

/**
 * Lets clicks through the window's transparent margin, or takes them back.
 *
 * Only a size that expands has such a margin. For every other size the window is
 * exactly the card, so there is nothing to let anything through and the window
 * stays plainly interactive — calling this with `false` there would make the
 * widget itself unclickable.
 *
 * `forward: true` is what keeps this recoverable: a click-through window still
 * receives mouse *move* events, which is how the renderer notices the pointer
 * has arrived over the card and asks for interactivity back. Without it the
 * window would go through and never come back.
 *
 * PLATFORM: `setIgnoreMouseEvents` with forwarding is documented for macOS and
 * Windows and behaves differently on Linux, which this app does not target.
 * Verified on neither — see docs/WINDOWS.md.
 */
export function setWidgetInteractive(interactive: boolean): void {
  if (!widget || widget.isDestroyed()) return
  widget.setIgnoreMouseEvents(!interactive, { forward: true })
}

/**
 * Points the card at the other edge of its window.
 *
 * The window keeps its size — it never changes — so all that happens is a move,
 * chosen so the visible card stays exactly where it was, and a clamp in case
 * that move pushed it off a display.
 *
 * The renderer is told nothing here. It reads the direction from its settings
 * subscription like any other preference, and the card inside re-anchors itself.
 */
export function setWidgetExpandDirection(direction: ExpandDirection): void {
  const before = currentDirection
  currentDirection = direction
  if (!widget || widget.isDestroyed()) return

  // The user is looking at the CARD, not at the invisible rectangle around it.
  // Flipping the direction moves the card to the other end of that rectangle, so
  // without this the visible widget would slide the full width of its growth
  // room sideways — 163 px — for a setting that is supposed to change nothing
  // but which way it opens.
  const bounds = widget.getBounds()
  const kept = keepCardInPlace({ x: bounds.x, y: bounds.y }, before, direction)
  const next = clampToVisibleArea(
    kept,
    currentDisplays().map((d) => d.bounds),
    windowSize(),
  )
  if (next.x !== bounds.x || next.y !== bounds.y) widget.setPosition(next.x, next.y)
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
