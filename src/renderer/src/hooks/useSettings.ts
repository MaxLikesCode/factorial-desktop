import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/ipc-contract'

/**
 * The stored settings, kept current.
 *
 * Reading once on mount was enough while the widget was the only writer and
 * every setting it cared about was its own. Neither is true any more: the tray's
 * "Einstellungen" submenu writes the same store, and one of the settings is the
 * widget's own size — a stale copy would leave the card drawing 340 × 224 inside
 * a window the main process had already shrunk around it.
 *
 * `null` until the first answer, exactly like before, so callers keep their
 * "not known yet" branch rather than being handed invented defaults.
 */
export function useSettings(): AppSettings | null {
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    // Subscribe before awaiting the read, so a change landing between the two is
    // not lost; `active` then keeps a slow initial read from overwriting it.
    let active = true
    const off = window.factorial.onSettings((next) => setSettings(next))
    void window.factorial.getSettings().then(
      (next) => {
        if (active) setSettings(next)
      },
      // A failed read is not worth a toast: the widget stays usable and the
      // controls that need settings simply stay disabled.
      () => {},
    )
    return () => {
      active = false
      off()
    }
  }, [])

  return settings
}
