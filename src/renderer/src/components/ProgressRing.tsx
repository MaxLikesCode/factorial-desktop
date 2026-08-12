interface Props {
  /** 0..1. Out of range or non-finite values are clamped — see `arcOffset`. */
  progress: number
  /** Pre-formatted; this component never derives a time of its own. */
  label: string
  tone: 'idle' | 'active' | 'paused'
}

const TONE: Record<Props['tone'], string> = {
  idle: 'stroke-muted-foreground/40',
  active: 'stroke-emerald-500',
  paused: 'stroke-amber-500',
}

const RADIUS = 46
export const RING_CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * How much of the circle stays *undrawn*.
 *
 * `Math.min/max` alone would let a NaN through — every comparison with NaN is
 * false, so it would be returned unchanged and `stroke-dashoffset="NaN"` erases
 * the ring silently. A day target of 0 makes `worked / target` exactly that
 * (`0/0`), and Task 13 wires a real, sometimes-zero target in. An infinity needs
 * no special case: `Math.min/max` clamp it like any other out-of-range value.
 */
function arcOffset(progress: number): number {
  if (Number.isNaN(progress)) return RING_CIRCUMFERENCE
  const clamped = Math.min(1, Math.max(0, progress))
  return RING_CIRCUMFERENCE * (1 - clamped)
}

export function ProgressRing({ progress, label, tone }: Props): React.JSX.Element {
  return (
    <div className="relative grid size-24 shrink-0 place-items-center">
      <svg className="size-24 -rotate-90" viewBox="0 0 112 112" aria-hidden>
        <circle cx="56" cy="56" r={RADIUS} fill="none" strokeWidth="6" className="stroke-muted" />
        <circle
          data-slot="progress-ring-arc"
          cx="56"
          cy="56"
          r={RADIUS}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          className={`${TONE[tone]} transition-[stroke-dashoffset] duration-500`}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={arcOffset(progress)}
        />
      </svg>
      <span className="absolute text-lg font-semibold tabular-nums">{label}</span>
    </div>
  )
}
