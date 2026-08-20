import { ChevronDownIcon } from 'lucide-react'

/**
 * `AttendanceShiftLocationTypeEnum`, in the same order as `LOCATION_TYPES` in
 * `src/main/factorial/types.ts`. That list is the one the main process validates
 * against (K4) — this one only supplies the German words.
 *
 * The words are Factorial's own, not a fresh translation: someone comparing this
 * widget with the web app should not have to work out that two different terms
 * mean the same thing. Factorial's German UI calls `work_from_home` **"Mobiles
 * Arbeiten"** — confirmed on the real account, where the dashboard widget showed
 * exactly that for a running shift.
 *
 * `office` and `work_from_home` are both confirmed against the live API;
 * `business_trip` comes from the schema enum and is still unverified
 * (`docs/WINDOWS.md` §6).
 */
export const LOCATIONS = [
  { value: 'office', label: 'Büro' },
  { value: 'work_from_home', label: 'Mobiles Arbeiten' },
  { value: 'business_trip', label: 'Dienstreise' },
] as const

interface Props {
  value: string
  disabled: boolean
  onChange: (value: string) => void
}

/**
 * K11 — Base UI, not Radix. Two differences from the plan's snippet:
 *
 * - `<Select.Value>` renders the *raw value* unless the root is given `items`.
 *   Without it the footer would read "work_from_home" instead of "Mobiles Arbeiten" —
 *   type-correct and wrong on screen, exactly the class of deviation `tsc`
 *   cannot catch.
 * - `onValueChange` is called with `string | null` plus an event-details second
 *   argument, so the handler cannot be passed straight through.
 */
/**
 * The work-location picker: a button that opens a NATIVE menu.
 *
 * Same reason as `BreakMenu`. A dropdown drawn inside the page is clipped by a
 * window 179 px tall, and this one sits 120 px down it — there was never
 * anywhere for three entries to go.
 *
 * The current value is marked, so the platform renders the entries as a radio
 * group and the menu answers "which one is set" without being read.
 */
export function LocationSelect({ value, disabled, onChange }: Props): React.JSX.Element {
  const current = LOCATIONS.find((location) => location.value === value)

  async function open(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    const box = event.currentTarget.getBoundingClientRect()
    const picked = await window.factorial
      .popupMenu(
        LOCATIONS.map((location) => ({
          id: location.value,
          label: location.label,
          checked: location.value === value,
        })),
        { x: box.left, y: box.bottom },
      )
      .catch(() => null)
    if (picked !== null) onChange(picked)
  }

  return (
    <button
      type="button"
      aria-label="Arbeitsort"
      disabled={disabled}
      onClick={(event) => void open(event)}
      className="flex h-6 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground transition-colors duration-150 ease-(--ease-out) hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      {current?.label ?? value}
      <ChevronDownIcon className="size-4 shrink-0" />
    </button>
  )
}
