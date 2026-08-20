import { PauseIcon } from 'lucide-react'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { Button } from '@renderer/components/ui/button'
import type { BreakOption } from '@shared/ipc-contract'

interface Props {
  /** Comes from `timeSettings.breakConfigurationsConnection` via the store. */
  options: BreakOption[]
  disabled: boolean
  onSelect: (id: string) => void
}

/**
 * The break picker: a button that opens a NATIVE menu.
 *
 * It used to be a dropdown drawn inside the page, and in a 321 x 179 window that
 * cannot work — the list was cut off after two entries with the rest behind a
 * scrollbar. No window size fixes it either: the list is however long an
 * employer configured it, and this window's size is fixed by the animation
 * (`src/shared/widget-size.ts`).
 *
 * A native menu is the platform's own window. It is bounded by the screen rather
 * than by ours, and it flips and scrolls near an edge without being told to.
 */
export function BreakMenu({ options, disabled, onSelect }: Props): React.JSX.Element {
  const t = useTranslate()
  async function open(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    const box = event.currentTarget.getBoundingClientRect()
    // The menu hangs from the button's bottom-left, in window coordinates —
    // which is what `getBoundingClientRect` already gives for a page that fills
    // its window. Where it actually lands is the platform's call: near a screen
    // edge it will flip above the button by itself.
    const picked = await window.factorial
      .popupMenu(
        options.map((option) => ({ id: option.id, label: option.name })),
        { x: box.left, y: box.bottom },
      )
      .catch(() => null)
    if (picked !== null) onSelect(picked)
  }

  return (
    <Button
      size="sm"
      variant="secondary"
      // No break types loaded means there is nothing to start: the store only
      // ever fills this from the API, so an empty list is "not known yet", never
      // "breaks are not configured".
      disabled={disabled || options.length === 0}
      onClick={(event) => void open(event)}
    >
      <PauseIcon />
      {t('tray.break')}
    </Button>
  )
}
