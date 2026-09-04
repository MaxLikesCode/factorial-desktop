import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon } from 'lucide-react'

export interface DropdownItem {
  value: string
  label: string
  leading?: ReactNode
}

interface Props {
  items: DropdownItem[]
  /** The current value, marked in the list; omit for a list of actions. */
  value?: string | undefined
  onSelect: (value: string) => void
  disabled?: boolean
  /** The trigger's classes; the trigger is always a button. */
  className?: string
  children: ReactNode
  /** Which edge of the trigger the list lines up with. */
  align?: 'start' | 'end'
}

/**
 * A list that opens under a button — the window's own, not the platform's.
 *
 * Drawn in the page so it looks like the rest of the window: the same glass
 * as the cards, the current item ticked. Positioned from the trigger's box
 * on open and rendered through a portal so a card's `overflow: hidden`
 * cannot clip it; flips above the trigger when the window's bottom is too
 * close. Closes on a click anywhere else, on Escape, on a pick, and when
 * the window resizes.
 */
export function Dropdown({ items, value, onSelect, disabled = false, className = '', children, align = 'start' }: Props): React.JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const estimated = items.length * 36 + 12
    const up = rect.bottom + estimated + 8 > window.innerHeight && rect.top - estimated - 8 > 0
    setBox({
      top: up ? rect.top - 6 : rect.bottom + 6,
      left: align === 'end' ? rect.right : rect.left,
      width: rect.width,
      up,
    })
  }, [open, items.length, align])

  useEffect(() => {
    if (!open) return
    function onDown(event: PointerEvent): void {
      const target = event.target as Node
      if (list.current?.contains(target) || trigger.current?.contains(target)) return
      setOpen(false)
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    const close = (): void => setOpen(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [open])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`no-drag ${className}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {children}
      </button>
      {open &&
        box !== null &&
        createPortal(
          <div
            ref={list}
            role="listbox"
            className="app-menu"
            style={{
              position: 'fixed',
              top: box.up ? undefined : box.top,
              bottom: box.up ? window.innerHeight - box.top : undefined,
              left: align === 'end' ? undefined : box.left,
              right: align === 'end' ? window.innerWidth - box.left : undefined,
              minWidth: Math.max(box.width, 180),
            }}
          >
            {items.map((item) => {
              const selected = item.value === value
              return (
                <button
                  key={item.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="app-menu-item"
                  onClick={() => {
                    setOpen(false)
                    onSelect(item.value)
                  }}
                >
                  {item.leading}
                  <span className="truncate">{item.label}</span>
                  {value !== undefined && <CheckIcon className="ml-auto size-4" style={{ opacity: selected ? 1 : 0 }} />}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
