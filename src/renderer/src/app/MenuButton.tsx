import { ChevronDownIcon } from 'lucide-react'
import { Dropdown } from './Dropdown'

interface Props {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  /** Something before the label — the break row's colour dot. */
  leading?: React.ReactNode
  /** Shown when `value` names none of the options — a work block whose location is not known. */
  placeholder?: string
}

/** A choice as a button: the current value, a chevron, and the window's own list on click. */
export function MenuButton({ value, options, onChange, disabled = false, className = '', leading, placeholder }: Props): React.JSX.Element {
  const current = options.find((o) => o.value === value)
  return (
    <Dropdown
      items={options}
      value={value}
      onSelect={(picked) => {
        if (picked !== value) onChange(picked)
      }}
      disabled={disabled}
      className={`app-btn app-btn-secondary ${className}`}
      align="end"
    >
      {leading}
      <span className="truncate">{current?.label ?? placeholder ?? value}</span>
      <ChevronDownIcon className="app-faint ml-auto" />
    </Dropdown>
  )
}
