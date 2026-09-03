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

import { BrowserWindow, Menu, app, screen } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc-contract'
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
 * An earlier draft used a `globalThis.__quitting` flag set by the tray's quit item.
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
    placeWindow(win, next)
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
    // handle every 16 ms for the rest of the session. The cursor loop is the
    // same story and, unlike the drag, is running most of the time.
    stopDragLoop()
    stopCursorLoop()
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

/**
 * Puts the window at `target`, and re-asserts its size while doing so.
 *
 * `setPosition` alone would do on a single display. PLATFORM: on Windows with
 * displays at different scale factors it does not. Electron's `setPosition`
 * re-sends the window's *current* size, read back through the scale factor of
 * whichever display the window overlaps most at that instant, so a window
 * halfway onto a 100 % display next to a 150 % one is placed with a size that
 * belongs to neither — it visibly grew on every crossing. Passing the intended
 * DIP size with every placement keeps the size a constant the platform scales
 * for the display it lands on, instead of a value that drifts with each call.
 *
 * `target` is in DIP. When the window's own display and the display the
 * target lies on disagree about the scale factor, the rect is placed via
 * physical pixels: the point is scaled by its own display and the rect back by
 * the window's, which is exactly the pair of conversions `setBounds` applies in
 * reverse. Elsewhere the two agree and the detour is the identity.
 */
function placeWindow(win: BrowserWindow, target: Point): void {
  const size = windowSize()
  let { x, y } = target
  if (process.platform === 'win32') {
    const physical = screen.dipToScreenPoint(target)
    const local = screen.screenToDipRect(win, { x: physical.x, y: physical.y, ...size })
    x = local.x
    y = local.y
  }
  const bounds = win.getBounds()
  if (
    bounds.x === x &&
    bounds.y === y &&
    bounds.width === size.width &&
    bounds.height === size.height
  ) {
    return
  }
  win.setBounds({ x, y, ...size })
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
 *
 * The window is only placed when the cursor has actually moved since the last
 * tick. PLATFORM: on Windows with display scaling other than 100 % a placement
 * is not idempotent — the DIP-to-pixel rounding depends on which display the
 * window currently overlaps most — so placing a still window at the same
 * coordinates sixty times a second walked it sideways across the screen and
 * off it. A still cursor now means no call at all, and `placeWindow` does the
 * scale-factor bookkeeping for the calls that remain.
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
    placeWindow(widget, next)
    return
  }

  const start = screen.getCursorScreenPoint()
  const bounds = widget.getBounds()
  const offsetX = bounds.x - start.x
  const offsetY = bounds.y - start.y
  let last: Point = start

  dragTimer = setInterval(() => {
    if (!widget || widget.isDestroyed()) {
      stopDragLoop()
      return
    }
    const cursor = screen.getCursorScreenPoint()
    if (cursor.x === last.x && cursor.y === last.y) return
    last = cursor
    placeWindow(widget, { x: cursor.x + offsetX, y: cursor.y + offsetY })
  }, DRAG_INTERVAL_MS)
}

/**
 * How often the pointer is sampled while the window is click-through.
 *
 * Slower than the drag loop on purpose: a drag is a continuous gesture the eye
 * follows frame by frame, whereas this only has to notice the pointer arriving
 * over the card. 32 ms is two frames of lag before the card becomes clickable —
 * below the threshold where a click feels dropped — at a fraction of the wake-ups
 * a 16 ms loop would cost for something that idles all day.
 */
const CURSOR_INTERVAL_MS = 32

let cursorTimer: NodeJS.Timeout | null = null
let lastCursor: Point | null = null

function stopCursorLoop(): void {
  if (cursorTimer === null) return
  clearInterval(cursorTimer)
  cursorTimer = null
  lastCursor = null
}

/**
 * Pushes the pointer's window-relative position to the renderer.
 *
 * PLATFORM: Windows only, and the reason is measured rather than assumed.
 * `setIgnoreMouseEvents(true, { forward: true })` is documented to keep
 * delivering mouse *moves*, and the card's recovery from click-through is built
 * on exactly that. On Windows it delivers none: against a bare transparent
 * window, a moving pointer produced 29 `mousemove` while the window was
 * interactive and 0 while it was forwarding — focused or not. So the card never
 * learned the pointer had arrived, never asked for interactivity back, and the
 * widget stayed click-through for the rest of its life.
 *
 * Sampling the cursor from here is the smallest replacement that keeps the
 * design intact: the renderer still decides — it is the only side that knows
 * where the card is mid-animation — and this only restores the events it decides
 * on. Positions are sent in window coordinates so a push and a real `mousemove`
 * are the same input, and only when the pointer actually moved, so a still
 * pointer costs one `getCursorScreenPoint` per tick and no IPC at all.
 *
 * macOS is left on the documented behaviour, since nobody has measured it there
 * and a second mechanism running alongside a working one is a way to get two.
 */
function startCursorLoop(): void {
  if (cursorTimer !== null) return
  cursorTimer = setInterval(() => {
    if (!widget || widget.isDestroyed()) {
      stopCursorLoop()
      return
    }
    const cursor = screen.getCursorScreenPoint()
    if (lastCursor && lastCursor.x === cursor.x && lastCursor.y === cursor.y) return
    lastCursor = cursor

    const bounds = widget.getBounds()
    widget.webContents.send(IPC.cursorMoved, {
      x: cursor.x - bounds.x,
      y: cursor.y - bounds.y,
    })
  }, CURSOR_INTERVAL_MS)
}

/**
 * Lets clicks through the window's transparent margin, or takes them back.
 *
 * Only a size that expands has such a margin. For every other size the window is
 * exactly the card, so there is nothing to let anything through and the window
 * stays plainly interactive — calling this with `false` there would make the
 * widget itself unclickable.
 *
 * `forward: true` is meant to keep this recoverable: a click-through window
 * still receives mouse *move* events, which is how the renderer notices the
 * pointer has arrived over the card and asks for interactivity back. It is left
 * on because that is what macOS uses; on Windows it delivers nothing, and
 * `startCursorLoop` stands in — see the note there for the measurement.
 *
 * PLATFORM: `setIgnoreMouseEvents` with forwarding is documented for macOS and
 * Windows and behaves differently on Linux, which this app does not target.
 * Windows verified — the forwarding does not arrive; macOS still unverified.
 * See docs/DESIGN.md.
 */
export function setWidgetInteractive(interactive: boolean): void {
  if (!widget || widget.isDestroyed()) return
  // A window that goes click-through mid-drag never receives the `pointerup`
  // that ends the drag, and is then glued to the cursor with no way to put it
  // down. The renderer already refuses to ask for this while the pointer is
  // held; this is the same refusal from the side that actually runs the drag.
  if (!interactive && dragTimer !== null) return
  widget.setIgnoreMouseEvents(!interactive, { forward: true })

  // PLATFORM: the stand-in for forwarding that never arrives. Only while the
  // window is click-through — once it is interactive again Chromium delivers
  // real moves and a second source would just be noise.
  if (process.platform !== 'win32') return
  if (interactive) stopCursorLoop()
  else startCursorLoop()
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
  placeWindow(widget, next)
}

/**
 * Opens a native menu over the widget and resolves what was picked.
 *
 * A menu drawn inside the page is clipped by a window this small — 321 x 179 —
 * and no window size fixes it, because the list of break types is however long
 * an employer made it. A native menu is the platform's own window: it is bounded
 * by the screen, and it flips and scrolls near an edge without being told to.
 *
 * `anchor` arrives in window coordinates, which is what `popup` wants.
 *
 * The promise always settles. `popup`'s callback fires when the menu closes for
 * any reason, so a dismissal resolves `null` rather than leaving the renderer
 * waiting on a click that is never coming.
 */
export function popupWidgetMenu(
  items: { id: string; label: string; checked?: boolean }[],
  anchor: { x: number; y: number },
): Promise<string | null> {
  const win = widget
  if (!win || win.isDestroyed()) return Promise.resolve(null)

  return new Promise((resolve) => {
    let picked: string | null = null
    const menu = Menu.buildFromTemplate(
      items.map((item) => ({
        label: item.label,
        // A row that knows whether it is the current one renders as a radio, and
        // consecutive radios form one group — which is what the work location
        // wants and the break list, having no current value, never asks for.
        type: item.checked === undefined ? undefined : ('radio' as const),
        checked: item.checked,
        click: () => {
          picked = item.id
        },
      })),
    )
    menu.popup({
      window: win,
      x: Math.round(anchor.x),
      y: Math.round(anchor.y),
      // Fires on close, whatever closed it. `click` has already run by then.
      callback: () => resolve(picked),
    })
  })
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
