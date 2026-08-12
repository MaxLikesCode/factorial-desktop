import { PauseIcon } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import type { BreakOption } from '@shared/ipc-contract'

interface Props {
  /** Comes from `timeSettings.breakConfigurationsConnection` via the store. */
  options: BreakOption[]
  disabled: boolean
  onSelect: (id: string) => void
}

/**
 * K11 — this component is the plan's Radix snippet translated to Base UI, which
 * is what Nova actually generates. Two props changed and both are silent
 * failures rather than type errors:
 *
 * - `<DropdownMenuTrigger asChild>` does not exist. Base UI composes through
 *   `render`, which takes the element instead of wrapping it.
 * - `<DropdownMenuItem onSelect>` does not exist either; the item's handler is
 *   `onClick`. `onSelect` would have compiled as an unknown DOM prop and simply
 *   never fired — a Pause button that opens a menu and then does nothing.
 *
 * Both are recorded in `docs/WINDOWS.md` §6, because a shadcn update can bring
 * the Radix spelling back.
 *
 * The button carries a word, not just the plan's `❙❙` glyph: an icon-only
 * control here would rely on `aria-label` alone for its meaning, and the widget
 * has the room.
 */
export function BreakMenu({ options, disabled, onSelect }: Props): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        // No break types loaded means there is nothing to start: the store only
        // ever fills this from the API, so an empty list is "not known yet",
        // never "breaks are not configured".
        disabled={disabled || options.length === 0}
        render={<Button size="sm" variant="secondary" />}
      >
        <PauseIcon />
        Pause
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((option) => (
          <DropdownMenuItem key={option.id} onClick={() => onSelect(option.id)}>
            {option.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
