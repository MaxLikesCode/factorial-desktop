/**
 * The catalogues, keyed by locale.
 *
 * Static imports rather than dynamic ones: there are seven of them, they are a
 * few kilobytes each, and both the main bundle and the renderer bundle want them
 * synchronously — the tray builds its menu before any await would have resolved.
 */

import type { Catalogue, Locale, Translate } from '../i18n'
import { createTranslator, en } from '../i18n'
import { de } from './de'
import { es } from './es'
import { fr } from './fr'
import { it } from './it'
import { nl } from './nl'
import { pt } from './pt'

export const CATALOGUES: Record<Locale, Catalogue> = { en, de, es, fr, it, nl, pt }

/** Memoised: the tray rebuilds its menu every fifteen seconds. */
const translators = new Map<Locale, Translate>()

export function translatorFor(locale: Locale): Translate {
  const existing = translators.get(locale)
  if (existing) return existing
  const created = createTranslator(CATALOGUES[locale])
  translators.set(locale, created)
  return created
}
