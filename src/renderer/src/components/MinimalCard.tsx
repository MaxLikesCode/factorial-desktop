import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { WIDGET_LAYOUTS, type ExpandDirection } from '@shared/widget-size'
import type { WidgetView } from './WidgetView'
import { Timer } from './StatusCard'

const { card, expanded } = WIDGET_LAYOUTS.minimal

interface Props {
  view: WidgetView
  open: boolean
  onToggle: () => void
  actions: ReactNode
  /**
   * Which way the card grows, and with it whether the expand control travels.
   *
   * `right` grows away from the control, so the control rides the card's far
   * corner and the pointer that just clicked it has to follow. `left` grows the
   * other way: the card's right edge is fixed, the control keeps its place, and
   * the same pointer closes it again without moving. Both grow downwards, which
   * is what lets the control's y stay put in the second case.
   */
  direction: ExpandDirection
}

/**
 * The smallest size, and the only one that changes shape.
 *
 * Collapsed it is a dot, the timer and a hairline of progress. Expanded it is
 * the `kompakt` card. Three things make that morph cheap enough to spring:
 *
 * 1. **Every child is absolutely positioned.** The collapsed layout is then
 *    exact without having to pull hidden rows out of flow, and nothing reflows
 *    mid-animation.
 * 2. **The progress hairline is flush to the bottom edge in both sizes.** It
 *    never moves; it only gets wider.
 * 3. **The window never resizes.** It is fixed at the expanded size plus the
 *    spring's overshoot and is transparent around the card, so the growing is a
 *    compositor transition rather than `setSize()` across the IPC boundary. See
 *    `src/shared/widget-size.ts`.
 *
 * This card does its own dragging, and the other sizes do not.
 *
 * `-webkit-app-region: drag` is the obvious way to move a frameless window and
 * it is what `standard` and `kompakt` still use. It cannot be used here: a
 * draggable region is a title bar as far as the platform is concerned, so the
 * platform keeps the double click on it — measured, not assumed, the gesture
 * never reached this component at all. The double click is this card's second
 * way to open, next to the control beside the timer, so the region had to go and
 * the drag had to be run by hand.
 *
 * What that buys, beyond the double click: the card is draggable everywhere
 * except its controls, in both sizes, with one rule instead of a CSS override
 * fighting `.drag-region button` over specificity.
 *
 * The pointer is captured on the way down so the drag survives the cursor
 * outrunning a window that is chasing it, and the drag only starts after the
 * pointer has actually travelled — otherwise every click would spin up a loop in
 * the main process to move the window nowhere.
 */
export function MinimalCard({
  view,
  open,
  onToggle,
  actions,
  direction,
}: Props): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)

  /**
   * Lets the desktop behind the transparent margin be clicked.
   *
   * The window is bigger than the card and always on top, so without this it
   * would swallow a rectangle of somebody's screen with nothing on screen to
   * explain why. The main process makes the whole window click-through with
   * mouse-move forwarding still on, which is what lets this listener notice the
   * pointer arriving over the card and ask for interactivity back.
   *
   * The pointer's position is compared against the card's live bounding box, so
   * this is correct while the card is mid-animation as well as at either end.
   */
  useEffect(() => {
    const element = cardRef.current
    if (element === null) return

    let interactive: boolean | null = null
    const setInteractive = (next: boolean): void => {
      if (next === interactive) return
      interactive = next
      void window.factorial.setWindowInteractive(next).catch(() => {})
    }

    function onMove(event: MouseEvent): void {
      if (element === null) return
      const box = element.getBoundingClientRect()
      setInteractive(
        event.clientX >= box.left &&
          event.clientX <= box.right &&
          event.clientY >= box.top &&
          event.clientY <= box.bottom,
      )
    }

    // Start click-through: until a mouse move says otherwise, the pointer is not
    // over the card and the desktop behind must stay reachable.
    setInteractive(false)
    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      // Leaving this size must not leave the window click-through: the next size
      // fills its whole window and would be unclickable.
      void window.factorial.setWindowInteractive(true).catch(() => {})
    }
  }, [])

  /**
   * Where the pointer went down, and whether that has become a drag yet.
   *
   * A ref rather than state: nothing here is rendered, and re-rendering the card
   * on every pointer move during a drag would be the one thing guaranteed to
   * make the drag stutter.
   */
  const drag = useRef<{ x: number; y: number; moving: boolean } | null>(null)

  /** Below this the gesture is still a click, not a drag. */
  const DRAG_THRESHOLD_PX = 3

  /**
   * Pointer capture keeps the drag alive when the cursor outruns a window that
   * is chasing it. It is an improvement, not a requirement — the drag has to
   * survive an environment that does not implement it, so failing to take or
   * release the capture is never allowed to abort the handler around it.
   */
  function withCapture(element: HTMLElement, pointerId: number, take: boolean): void {
    try {
      if (take) element.setPointerCapture(pointerId)
      else if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
    } catch {
      // No capture available. The drag still starts, moves and stops.
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    // Controls handle their own clicks; dragging from one would fight them.
    if ((event.target as HTMLElement).closest('button') !== null) return
    if (event.button !== 0) return
    drag.current = { x: event.clientX, y: event.clientY, moving: false }
    withCapture(event.currentTarget, event.pointerId, true)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const started = drag.current
    if (started === null || started.moving) return
    if (
      Math.abs(event.clientX - started.x) < DRAG_THRESHOLD_PX &&
      Math.abs(event.clientY - started.y) < DRAG_THRESHOLD_PX
    ) {
      return
    }
    started.moving = true
    void window.factorial.setWindowDragging(true).catch(() => {})
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const started = drag.current
    drag.current = null
    // Ending the drag comes first. A drag left running in the main process would
    // glue the window to the cursor with no way to put it down, so nothing may
    // come between the pointer going up and that being said.
    if (started?.moving === true) void window.factorial.setWindowDragging(false).catch(() => {})
    withCapture(event.currentTarget, event.pointerId, false)
  }

  const size = open ? expanded : card
  if (size === null) throw new Error('minimal must have an expanded size')

  return (
    <div
      ref={cardRef}
      data-open={open}
      data-slot="minimal-card"
      onDoubleClick={(event) => {
        // A double click that landed on a control has already been dealt with by
        // it: two clicks on the chevron are two toggles, and a third from here
        // would put the card back where it started.
        if ((event.target as HTMLElement).closest('button') !== null) return
        onToggle()
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`morph-card absolute top-0 overflow-hidden rounded-xl border bg-background/95 backdrop-blur ${
        // Pinned against the edge it does not grow into, so the transparent
        // remainder of the window is exactly the room the expansion moves into.
        direction === 'left' ? 'right-0' : 'left-0'
      }`}
      style={{ width: size.width, height: size.height }}
      // Collapsed, the state is carried by a 7 px coloured dot and nothing else
      // in words. The label row right below is inert then, so the card says it.
      aria-label={open ? undefined : `${view.label}, ${view.time}`}
      role={open ? undefined : 'group'}
    >
      {/*
        `inert` and `aria-hidden` while collapsed, and they are not decoration.
        These rows stay in the DOM the whole time — they have to, or there would
        be nothing to fade in — but a row nobody can see must not be reachable
        either. Without this, Tab walks into an invisible "Ausstempeln" and Enter
        files the end of somebody's shift with nothing on screen to show for it.
      */}
      <div
        className="morph-late absolute top-[11px] right-9 left-3.5 flex items-center justify-between gap-2.5"
        data-row="1"
        inert={!open}
        aria-hidden={!open}
      >
        <span className="truncate text-xs font-semibold">{view.label}</span>
        {view.goalLine !== null && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {view.goalLine}
          </span>
        )}
      </div>

      <div
        className="morph-move absolute left-3.5 flex items-center gap-1.5"
        style={{ top: open ? 32 : 10 }}
      >
        <span
          className={`size-[7px] shrink-0 rounded-full transition-colors duration-300 ease-(--ease-out) ${view.dotClass}`}
        />
        <Timer
          value={view.time}
          className={`morph-move ${open ? 'text-[30px]' : 'text-[22px]'} tracking-[-0.03em]`}
        />
      </div>

      <div
        className="morph-late absolute bottom-3.5 left-3.5 flex gap-2"
        data-row="2"
        inert={!open}
        aria-hidden={!open}
      >
        {actions}
      </div>

      {/*
        The one control the card owns. It moves with the card rather than staying
        put: collapsed it sits beside the timer, expanded it sits opposite the
        action buttons, where it reads as "close this" instead of crowding the
        status line.
      */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={open ? 'Widget verkleinern' : 'Aktionen zeigen'}
        aria-expanded={open}
        // Always 10 px from the card's right edge. Growing left that edge does
        // not move, so this stays exactly where it was clicked — the whole point
        // of the direction. Growing right it rides along, and drops to sit
        // opposite the action buttons rather than crowding the status line.
        className="morph-move absolute right-2.5 grid size-5 place-items-center rounded-md text-muted-foreground transition-colors duration-150 ease-(--ease-out) hover:bg-muted hover:text-foreground"
        style={{ top: open && direction === 'right' ? 88 : 12 }}
      >
        <ChevronDownIcon
          className={`size-3.5 transition-transform duration-300 ease-(--ease-out) ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      <div className="absolute inset-x-0 bottom-0 h-[3px] bg-muted">
        {view.progress !== null && (
          <div
            data-slot="progress-bar-fill"
            className={`h-full transition-[width,background-color] duration-500 ease-(--ease-out) ${
              view.tone === 'active'
                ? 'bg-emerald-500'
                : view.tone === 'paused'
                  ? 'bg-amber-500'
                  : 'bg-muted-foreground/40'
            }`}
            style={{ width: `${Math.min(1, Math.max(0, view.progress)) * 100}%` }}
          />
        )}
      </div>
    </div>
  )
}
