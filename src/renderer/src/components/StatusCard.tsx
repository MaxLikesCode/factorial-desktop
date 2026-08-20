import type { ReactNode } from 'react'
import { ProgressBar } from './ProgressBar'
import type { WidgetView } from './WidgetView'

/**
 * The two sizes that show everything: `standard` and `kompakt`.
 *
 * Same anatomy, two densities. They are one component rather than two because
 * every difference between them is a number in the table below — the moment a
 * difference stops being a number it belongs in its own component, which is
 * exactly why `minimal` is one.
 */
export type Density = 'standard' | 'kompakt'

const DENSITY = {
  standard: {
    time: 'text-[42px] tracking-[-0.038em]',
    label: 'text-sm',
    trail: 'text-[11.5px]',
    dot: 'size-2',
    barTop: 'mt-1.5',
    bar: 'h-1.5',
  },
  kompakt: {
    time: 'text-[30px] tracking-[-0.03em]',
    label: 'text-xs',
    trail: 'text-[11px]',
    dot: 'size-[7px]',
    barTop: 'mt-1',
    bar: 'h-[5px]',
  },
} as const satisfies Record<Density, Record<string, string>>

interface Props {
  view: WidgetView
  density: Density
  /** True once the first real answer has arrived; drives one fade per launch. */
  ready: boolean
  actions: ReactNode
  /** The work-location select, or null where the size has no room for it. */
  location: ReactNode
}

export function StatusCard({ view, density, ready, actions, location }: Props): React.JSX.Element {
  const d = DENSITY[density]

  return (
    <div className="flex h-full flex-col rounded-xl border bg-background/95 p-2.5 backdrop-blur">
      {/*
        Left-aligned and full-width. The timer is the subject because it is the
        largest thing on the card, which is what frees it to stay legible at
        every reading length.
      */}
      <div
        className={`drag-region flex flex-1 flex-col justify-center gap-1.5 px-1 transition-[opacity,transform] duration-[220ms] ease-(--ease-out) ${
          ready ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              // The dot and the bar carry the state change; both transition
              // their colour rather than cutting to it.
              className={`${d.dot} shrink-0 rounded-full transition-colors duration-300 ease-(--ease-out) ${view.dotClass}`}
            />
            <span className={`truncate ${d.label} font-semibold`}>{view.label}</span>
          </div>
          {view.goalLine !== null && (
            <span className={`shrink-0 ${d.trail} text-muted-foreground tabular-nums`}>
              {view.goalLine}
            </span>
          )}
        </div>

        <Timer value={view.time} className={d.time} />

        {view.bar.length > 0 && (
          <div className={d.barTop}>
            <ProgressBar parts={view.bar} tone={view.tone} className={d.bar} />
          </div>
        )}

        {view.hints.length > 0 && (
          <p className="animate-in fade-in-0 max-w-full truncate text-[10px] text-muted-foreground duration-[140ms] ease-(--ease-out)">
            {view.hints.join(' · ')}
          </p>
        )}
      </div>

      <div className="no-drag flex flex-col items-start gap-2 px-1">
        {actions}
        {/*
          Rendered only when it has something in it.

          An empty footer row was still a row: 16 px of text line plus its 8 px
          gap, in a card whose height is fixed. In `kompakt` that was 24 px more
          than there was, so the content block overflowed and pushed the row
          clean out through the bottom edge — visibly, since nothing here clips.
          It was wrong in every state; a break just happened to put text in it.
        */}
        {/*
          The footer carries the work location on the left and the day's break
          total on the right — the corner that fell free when the break's own
          running time moved up into the timer. Costing no height is what makes a
          second number affordable there, but only where the row already exists:
          `kompakt` has no location select, so putting the break total in it
          would conjure a 24 px row into a card with 10 px to spare, and the
          content would push it out through the bottom edge. Which is the same
          overflow, from the same row, as the one this condition was written for.
        */}
        {location !== null && (
          <div
            data-slot="card-footer"
            className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground"
          >
            {location ?? <span />}
            {view.breakLine !== null && (
              <span className="shrink-0 tabular-nums">{view.breakLine}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The worked time, with its seconds a step down in contrast.
 *
 * Not in size: at 42 px the seconds tick once a second in the corner of
 * someone's eye for eight hours, and muting settles that movement while every
 * digit stays readable. The split is on the last colon, so the dash placeholder
 * takes the same path rather than needing a branch.
 */
export function Timer({ value, className }: { value: string; className: string }): React.JSX.Element {
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
