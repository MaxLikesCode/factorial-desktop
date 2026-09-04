import { ChevronDownIcon } from 'lucide-react'

interface Props {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  /** Something before the label — the break row's colour dot. */
  leading?: React.ReactNode
}

/**
 * A choice, as a button that opens the platform's own menu.
 *
 * Not a `<select>`: Chromium draws that one with its own light popup that
 * matches nothing in a dark window. The native menu is the same one the
 * break picker uses (`BreakMenu.tsx`), hung from the button that was
 * pressed, with the current value marked.
 */
export function MenuButton({ value, options, onChange, disabled = false, className = '', leading }: Props): React.JSX.Element {
  const current = options.find((o) => o.value === value)

  async function open(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    const box = event.currentTarget.getBoundingClientRect()
    const picked = await window.factorial
      .popupMenu(
        options.map((option) => ({ id: option.value, label: option.label, checked: option.value === value })),
        { x: box.left, y: box.bottom },
      )
      .catch(() => null)
    if (picked !== null && picked !== value) onChange(picked)
  }

  return (
    <button type="button" className={`app-btn app-btn-secondary no-drag ${className}`} disabled={disabled} onClick={(event) => void open(event)}>
      {leading}
      <span className="truncate">{current?.label ?? value}</span>
      <ChevronDownIcon className="app-faint ml-auto" />
    </button>
  )
}
