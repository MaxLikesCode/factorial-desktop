import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'

/**
 * `AttendanceShiftLocationTypeEnum`, in the same order as `LOCATION_TYPES` in
 * `src/main/factorial/types.ts`. That list is the one the main process validates
 * against (K4) — this one only supplies the German words.
 *
 * Only `office` was observed on the live API; the other two come from the schema
 * enum and are noted as unverified in `docs/WINDOWS.md` §6.
 */
export const LOCATIONS = [
  { value: 'office', label: 'Büro' },
  { value: 'work_from_home', label: 'Homeoffice' },
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
 *   Without it the footer would read "work_from_home" instead of "Homeoffice" —
 *   type-correct and wrong on screen, exactly the class of deviation `tsc`
 *   cannot catch.
 * - `onValueChange` is called with `string | null` plus an event-details second
 *   argument, so the handler cannot be passed straight through.
 */
export function LocationSelect({ value, disabled, onChange }: Props): React.JSX.Element {
  return (
    <Select
      items={LOCATIONS}
      value={value}
      disabled={disabled}
      // `null` arrives only when a selection is cleared, which this select has
      // no control for; ignoring it keeps a location always set.
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Arbeitsort"
        className="h-6 border-none bg-transparent px-1 text-xs shadow-none dark:bg-transparent dark:hover:bg-transparent"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LOCATIONS.map((location) => (
          <SelectItem key={location.value} value={location.value}>
            {location.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
