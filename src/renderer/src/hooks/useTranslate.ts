import { useMemo } from 'react'
import { resolveLocale, type Translate } from '@shared/i18n'
import { translatorFor } from '@shared/locales'
import { useSettings } from './useSettings'

/**
 * The translator for whatever language is currently set.
 *
 * It rides on `useSettings`, so a language picked in the tray reaches the widget
 * the same way every other setting does — the main process broadcasts the stored
 * settings and this re-renders. No channel of its own, and no second place where
 * the current language is remembered.
 *
 * `navigator.language` is the system's, as Chromium reports it; Electron sets it
 * from the same source `app.getLocale()` reads in the main process, so the two
 * halves agree on what "system" means without having to pass it across.
 *
 * Before the first settings answer arrives `settings` is null and this falls
 * back to the system language — which is what `system` would have resolved to
 * anyway, so the first paint is not in the wrong language and then corrected.
 */
export function useTranslate(): Translate {
  const settings = useSettings()
  const language = settings?.language ?? 'system'
  return useMemo(() => translatorFor(resolveLocale(language, navigator.language)), [language])
}
