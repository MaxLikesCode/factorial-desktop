import { useEffect, useRef, type ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { WIDGET_LAYOUTS } from '@shared/widget-size'
import type { WidgetView } from './WidgetView'
import { Timer } from './StatusCard'

const { card, expanded } = WIDGET_LAYOUTS.minimal

interface Props {
  view: WidgetView
  open: boolean
  onToggle: () => void
  actions: ReactNode
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
 * The expand control is a real button rather than the card itself, and that is
 * forced rather than chosen: `-webkit-app-region: drag` swallows mouse events
 * whole, so a card that is draggable cannot also be clickable. The card stays
 * draggable — it is a floating window and moving it matters more — and the
 * 20 px control next to the timer is what the size setting pays 8 px of width
 * for.
 */
export function MinimalCard({ view, open, onToggle, actions }: Props): React.JSX.Element {
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

  const size = open ? expanded : card
  if (size === null) throw new Error('minimal must have an expanded size')

  return (
    <div
      ref={cardRef}
      data-open={open}
      data-slot="minimal-card"
      className="morph-card drag-region relative overflow-hidden rounded-xl border bg-background/95 backdrop-blur"
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
        className="morph-late no-drag absolute bottom-3.5 left-3.5 flex gap-2"
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
        className="morph-move no-drag absolute right-2.5 grid size-5 place-items-center rounded-md text-muted-foreground transition-colors duration-150 ease-(--ease-out) hover:bg-muted hover:text-foreground"
        style={{ top: open ? 88 : 12 }}
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
