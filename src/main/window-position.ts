/**
 * Where the widget goes, decided without Electron.
 *
 * This module is deliberately free of any Electron import — like `auth-flow.ts`
 * next to `auth.ts` and `ipc-handlers.ts` next to `ipc.ts`. `windows.ts` reads
 * the real `screen` module and hands the plain numbers in here, which is what
 * makes multi-monitor behaviour testable on a single-screen machine.
 *
 * The one rule that matters: **a saved position is a suggestion, never an
 * instruction.** It was written on a machine whose monitors may since have been
 * unplugged, rearranged, or set to a different resolution. Restoring it blindly
 * puts a frameless, taskbar-less window somewhere the user cannot reach it and
 * cannot drag it back from, and the only cure would be deleting a JSON file the
 * user does not know exists. Everything below exists to make that impossible.
 *
 * DESIGN.md ("UI") asks for the position to be remembered *per monitor*, which
 * is why the file holds a map keyed by display id rather than a single point.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** A display reduced to what the placement logic needs: an identity and an area. */
export interface DisplayInfo {
  /**
   * `Electron.Display.id` as a string. Ids are not guaranteed stable across
   * reboots or re-plugging a monitor; a changed id only means the position for
   * that screen is forgotten and the widget is centred, which is the safe
   * outcome this module is built around.
   */
  id: string
  bounds: DisplayBounds
}

/** The persisted form: one remembered point per display, plus the one in use. */
export interface PositionStore {
  byDisplay: Record<string, Point>
  lastDisplayId: string | null
}

export const EMPTY_POSITION_STORE: PositionStore = { byDisplay: {}, lastDisplayId: null }

function isUsablePoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<Record<'x' | 'y', unknown>>
  return (
    typeof p.x === 'number' &&
    Number.isFinite(p.x) &&
    typeof p.y === 'number' &&
    Number.isFinite(p.y)
  )
}

/** How many pixels of the window would land on this display. */
function overlapArea(topLeft: Point, size: Size, d: DisplayBounds): number {
  const w = Math.min(topLeft.x + size.width, d.x + d.width) - Math.max(topLeft.x, d.x)
  const h = Math.min(topLeft.y + size.height, d.y + d.height) - Math.max(topLeft.y, d.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * The display the window belongs to: the one it covers most of.
 *
 * Containment of the top-left corner would be simpler but is wrong at exactly
 * the moment it matters. A window dragged past the left edge of the primary
 * screen has a negative `x` and is inside no display, yet it is plainly still on
 * that screen and only needs nudging back — which is what the original test
 * "pulls a window back from negative coordinates" asserts. It is also the rule
 * the window managers themselves use to decide which screen a window is on.
 *
 * Ties go to the earlier display, so the primary screen wins when the areas are
 * equal (`windows.ts` passes the primary display first).
 */
function displayFor<T extends { bounds: DisplayBounds }>(
  topLeft: Point,
  size: Size,
  displays: T[],
): T | null {
  let best: T | null = null
  let bestArea = 0
  for (const d of displays) {
    const area = overlapArea(topLeft, size, d.bounds)
    if (area > bestArea) {
      best = d
      bestArea = area
    }
  }
  return best
}

/**
 * A saved position can point at a monitor that is no longer attached, or at
 * coordinates that are now off-screen. Either way the window would be
 * invisible with no way to get it back, so validate before using it.
 *
 * A position that still touches a display is pulled fully onto that display; one
 * that touches nothing is discarded and the window is centred. `displays[0]` is
 * treated as the primary display — `windows.ts` puts `screen.getPrimaryDisplay()`
 * first, because the order of `screen.getAllDisplays()` is not documented to
 * start with it.
 */
export function clampToVisibleArea(
  saved: Point | null,
  displays: DisplayBounds[],
  size: Size,
): Point {
  const primary = displays[0]
  if (!primary) return { x: 0, y: 0 }

  const centreOnPrimary = (): Point => ({
    x: Math.round(primary.x + (primary.width - size.width) / 2),
    y: Math.round(primary.y + (primary.height - size.height) / 2),
  })

  if (!saved || !isUsablePoint(saved)) return centreOnPrimary()

  const host = displayFor(
    saved,
    size,
    displays.map((bounds) => ({ bounds })),
  )?.bounds
  if (!host) return centreOnPrimary()

  // The outer `Math.max(…, host.x)` is not redundant. On a display narrower or
  // shorter than the widget the upper bound falls below the display origin, and
  // clamping to it would push the window off the top or left edge — the corner
  // that carries the drag region. Better to lose the bottom-right of the widget.
  return {
    x: Math.max(Math.min(Math.max(saved.x, host.x), host.x + host.width - size.width), host.x),
    y: Math.max(Math.min(Math.max(saved.y, host.y), host.y + host.height - size.height), host.y),
  }
}

/**
 * Picks the point to open at: the display the widget was last on if it is still
 * attached, otherwise any other display that has a remembered position,
 * otherwise the centre of the primary display.
 *
 * A restored point is clamped against the display it was saved for, not against
 * the whole desktop — that display is where the user put it, and letting it drift
 * onto a neighbour because of an overlap would move the widget behind the user's
 * back.
 */
export function resolveWidgetPosition(
  store: PositionStore,
  displays: DisplayInfo[],
  size: Size,
): Point {
  const candidates: (string | null)[] = [store.lastDisplayId, ...displays.map((d) => d.id)]
  for (const id of candidates) {
    if (id === null) continue
    const saved = store.byDisplay[id]
    const display = displays.find((d) => d.id === id)
    // The id must name a currently attached display *and* have a saved point;
    // a stale entry for an unplugged monitor is exactly what must not be used.
    if (!saved || !display) continue
    return clampToVisibleArea(saved, [display.bounds], size)
  }

  return clampToVisibleArea(
    null,
    displays.map((d) => d.bounds),
    size,
  )
}

/**
 * Files a new position under the display it landed on. A point on no attached
 * display is dropped rather than stored: it could only come from a race with a
 * monitor being unplugged, and writing it down would make the next start worse,
 * not better.
 */
export function recordPosition(
  store: PositionStore,
  displays: DisplayInfo[],
  point: Point,
  size: Size,
): PositionStore {
  if (!isUsablePoint(point)) return store
  const host = displayFor(point, size, displays)
  if (!host) return store
  return {
    byDisplay: { ...store.byDisplay, [host.id]: { x: point.x, y: point.y } },
    lastDisplayId: host.id,
  }
}

/** Keeps only entries that could actually be used again. */
function sanitise(raw: unknown): PositionStore {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...EMPTY_POSITION_STORE }
  }
  const r = raw as Partial<Record<keyof PositionStore, unknown>>

  const byDisplay: Record<string, Point> = {}
  if (typeof r.byDisplay === 'object' && r.byDisplay !== null && !Array.isArray(r.byDisplay)) {
    for (const [id, value] of Object.entries(r.byDisplay as Record<string, unknown>)) {
      if (isUsablePoint(value)) byDisplay[id] = { x: value.x, y: value.y }
    }
  }

  return {
    byDisplay,
    lastDisplayId: typeof r.lastDisplayId === 'string' ? r.lastDisplayId : null,
  }
}

/** Never throws: a missing or unreadable file just means "no memory yet". */
export function readPositionStore(file: string): PositionStore {
  try {
    return sanitise(JSON.parse(readFileSync(file, 'utf8')) as unknown)
  } catch {
    return { ...EMPTY_POSITION_STORE }
  }
}

/**
 * Never throws either. This runs from a window `moved` handler, where an
 * exception would end the main process over a preference. Losing the position
 * is the acceptable failure; losing the app is not.
 */
export function writePositionStore(file: string, store: PositionStore): void {
  const temp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    // Write-then-rename, same reason as in `settings.ts`: a crash mid-write must
    // not leave a half-written file that reads as corrupt on the next start.
    writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8')
    renameSync(temp, file)
  } catch {
    /* best effort — see the note above */
  }
}
