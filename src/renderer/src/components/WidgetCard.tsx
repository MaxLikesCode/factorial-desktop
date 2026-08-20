import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { CARD, EXPANDED_ROWS, type ExpandDirection } from '@shared/widget-size'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { ProgressBar } from './ProgressBar'
import type { WidgetView } from './WidgetView'



interface Props {
  view: WidgetView
  open: boolean
  onToggle: () => void
  actions: ReactNode
  /** The work-location select. Reachable only while the card is open. */
  location: ReactNode
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
 * The widget. One card, two states.
 *
 * Collapsed it is a dot, the timer and a hairline of the day. Expanded it adds
 * the status, the remaining time, the actions, the work-location select and the
 * day's break total — everything, in one step.
 *
 * That completeness is the point rather than a compromise. The expanded card is
 * not a view you sit in; you open it to press Pause or to clock out, and it goes
 * away again. So it shows everything you might reach for while you are there,
 * instead of making you open it twice. There is no size to choose, nothing to
 * remember, and the collapsed card is what the day is actually spent looking at.
 *
 * Three things make the morph cheap enough to spring:
 *
 * 1. **Every child is absolutely positioned.** The collapsed layout is exact
 *    without having to pull hidden rows out of flow, and nothing reflows
 *    mid-animation.
 * 2. **The day's bar is flush to the bottom edge in both states.** It never
 *    moves; it only gets wider.
 * 3. **The window never resizes.** It is fixed at the expanded size plus the
 *    spring's overshoot and is transparent around the card, so the growing is a
 *    compositor transition rather than `setSize()` across the IPC boundary.
 *
 * This card does its own dragging, and that is forced rather than chosen:
 * `-webkit-app-region: drag` makes an element a title bar as far as the platform
 * is concerned, and the platform then keeps the double click on it — measured,
 * not assumed. The double click is one of the two ways to open, so the region
 * had to go and the drag had to be run by hand.
 */
/**
 * The worked time, with its seconds a step down in contrast.
 *
 * Not in size: they tick once a second in the corner of someone's eye for eight
 * hours, and muting settles that movement while every digit stays readable. The
 * split is on the last colon, so the dash placeholder takes the same path rather
 * than needing a branch.
 */
function Timer({ value, className }: { value: string; className: string }): React.JSX.Element {
  const cut = value.lastIndexOf(':')
  return (
    <span
      data-slot="worked-timer"
      className={`${className} leading-[1.04] font-semibold tabular-nums`}
    >
      {value.slice(0, cut)}
      <span className="text-muted-foreground">{value.slice(cut)}</span>
    </span>
  )
}

export function WidgetCard({
  view,
  open,
  onToggle,
  actions,
  location,
  direction,
}: Props): React.JSX.Element {
  const t = useTranslate()
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

    function at(x: number, y: number): void {
      if (element === null) return
      const box = element.getBoundingClientRect()
      setInteractive(x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
    }

    function onMove(event: MouseEvent): void {
      at(event.clientX, event.clientY)
    }

    // Start click-through: until a mouse move says otherwise, the pointer is not
    // over the card and the desktop behind must stay reachable.
    setInteractive(false)
    window.addEventListener('mousemove', onMove)
    // The same question from the other side. While the window is click-through
    // Windows delivers no forwarded moves at all, so on that platform this is
    // the only thing that ever gets the card clickable again; the main process
    // pushes the pointer in the same coordinates a `mousemove` would carry. See
    // `startCursorLoop` in src/main/windows.ts for the measurement.
    const stopCursor = window.factorial.onCursorMoved(({ x, y }) => {
      at(x, y)
    })
    return () => {
      window.removeEventListener('mousemove', onMove)
      stopCursor()
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

  const size = open ? CARD.expanded : CARD.collapsed

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
        className="morph-late absolute right-9 left-3.5 flex items-center justify-between gap-2.5"
        style={{ top: EXPANDED_ROWS.head.top }}
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
        style={{ top: open ? EXPANDED_ROWS.timer.top : 10 }}
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
        className="morph-late absolute left-3.5 flex gap-2"
        style={{ top: EXPANDED_ROWS.actions.top }}
        data-row="2"
        inert={!open}
        aria-hidden={!open}
      >
        {actions}
      </div>

      {/*
        Everything the larger card used to have, arriving in the one step that
        opens this one. The work location sits where it always did; the day's
        break total takes the corner opposite it — the corner that fell free when
        the running break moved up into the timer.
      */}
      <div
        className="morph-late absolute right-3.5 left-3.5 flex items-center justify-between gap-2 text-xs text-muted-foreground"
        style={{ top: EXPANDED_ROWS.footer.top }}
        data-row="2"
        inert={!open}
        aria-hidden={!open}
      >
        {location}
        {view.breakLine !== null && (
          <span className="shrink-0 tabular-nums">{view.breakLine}</span>
        )}
      </div>

      {/*
        The advisory line, in the gap the composition already leaves between the
        timer and the buttons. It costs no height because that gap exists either
        way, which is the only reason a warning fits on a card this size at all.
      */}
      {view.hints.length > 0 && (
        <p
          className="morph-late absolute right-3.5 left-3.5 m-0 truncate text-[10px] text-muted-foreground"
          style={{ top: EXPANDED_ROWS.hint.top }}
          data-row="1"
          inert={!open}
          aria-hidden={!open}
        >
          {view.hints.join(' · ')}
        </p>
      )}

      {/*
        The one control the card owns. It moves with the card rather than staying
        put: collapsed it sits beside the timer, expanded it sits opposite the
        action buttons, where it reads as "close this" instead of crowding the
        status line.
      */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={open ? t('widget.collapse') : t('widget.expand')}
        aria-expanded={open}
        // Always 10 px from the card's right edge. Growing left that edge does
        // not move, so this stays exactly where it was clicked — the whole point
        // of the direction. Growing right it rides along, and drops to sit
        // opposite the action buttons rather than crowding the status line.
        className="morph-move absolute right-2.5 grid size-5 place-items-center rounded-md text-muted-foreground transition-colors duration-150 ease-(--ease-out) hover:bg-muted hover:text-foreground"
        style={{ top: open && direction === 'right' ? 84 : 12 }}
      >
        <ChevronDownIcon
          className={`size-3.5 transition-transform duration-300 ease-(--ease-out) ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/*
        The day, flush to the bottom edge in both states, breaks and all. Three
        pixels is enough for a colour change to register, and a break the eye can
        see is the whole reason the bar carries the day rather than a fraction.
      */}
      <div className="absolute inset-x-0 bottom-0">
        <ProgressBar parts={view.bar} tone={view.tone} className="h-[3px]" />
      </div>
    </div>
  )
}
