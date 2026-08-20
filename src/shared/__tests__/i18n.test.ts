import { describe, expect, it } from 'vitest'
import {
  LANGUAGE_NAMES,
  LOCALES,
  createTranslator,
  en,
  isLanguageSetting,
  resolveLocale,
  type MessageKey,
} from '../i18n'
import { CATALOGUES, translatorFor } from '../locales'

/**
 * What a translation actually breaks on.
 *
 * Not "does the German say Einstempeln" — the widget and tray tests already run
 * in German and would catch that. What is checked here is the machinery around
 * the words, where a mistake is silent: a language missing a key renders blank,
 * a placeholder spelled differently in one catalogue prints `{time}` at a user,
 * and a locale nobody anticipated resolves to nothing at all.
 */

const KEYS = Object.keys(en) as MessageKey[]

describe('catalogues', () => {
  it('covers every locale that is offered', () => {
    for (const locale of LOCALES) {
      expect(CATALOGUES[locale], locale).toBeDefined()
      expect(LANGUAGE_NAMES[locale], locale).toBeTruthy()
    }
  })

  /**
   * TypeScript already refuses a missing key, but only while the catalogue is
   * typed as `Catalogue` — which is one `as never` away from being untrue. This
   * asserts the same thing about the values that actually ship.
   */
  it('has every key in every language, and none spare', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(CATALOGUES[locale]).sort(), locale).toEqual([...KEYS].sort())
    }
  })

  it('leaves nothing empty', () => {
    for (const locale of LOCALES) {
      for (const key of KEYS) {
        expect(CATALOGUES[locale][key].trim(), `${locale}/${key}`).not.toBe('')
      }
    }
  })

  /**
   * The failure this one catches is invisible in review: a translator writes
   * `{tiempo}` instead of `{time}`, the substitution finds nothing, and the user
   * reads a literal brace. Every catalogue has to use exactly the placeholders
   * English uses.
   */
  it('uses the same placeholders as English in every language', () => {
    const placeholders = (text: string): string[] =>
      (text.match(/\{(\w+)\}/g) ?? []).sort()

    for (const key of KEYS) {
      const expected = placeholders(en[key])
      for (const locale of LOCALES) {
        expect(placeholders(CATALOGUES[locale][key]), `${locale}/${key}`).toEqual(expected)
      }
    }
  })
})

describe('resolveLocale', () => {
  it('follows the system when nothing was chosen', () => {
    expect(resolveLocale('system', 'de-DE')).toBe('de')
    expect(resolveLocale('system', 'fr')).toBe('fr')
  })

  it('ignores the region', () => {
    // Brazilian Portuguese gets the Portuguese catalogue rather than English,
    // which is the better of the two available answers.
    expect(resolveLocale('system', 'pt-BR')).toBe('pt')
    expect(resolveLocale('system', 'en-GB')).toBe('en')
    // Underscores appear in some environments' locale strings.
    expect(resolveLocale('system', 'es_ES')).toBe('es')
    expect(resolveLocale('system', 'DE-de')).toBe('de')
  })

  it('falls back to English for anything unknown', () => {
    expect(resolveLocale('system', 'ja-JP')).toBe('en')
    expect(resolveLocale('system', '')).toBe('en')
    expect(resolveLocale('system', 'nonsense')).toBe('en')
  })

  it('honours an explicit choice regardless of the system', () => {
    expect(resolveLocale('es', 'de-DE')).toBe('es')
    expect(resolveLocale('en', 'de-DE')).toBe('en')
  })
})

describe('isLanguageSetting', () => {
  it('accepts system and every locale, and nothing else', () => {
    expect(isLanguageSetting('system')).toBe(true)
    for (const locale of LOCALES) expect(isLanguageSetting(locale), locale).toBe(true)
    // A hand-edited settings file must not be able to stop the next start.
    expect(isLanguageSetting('klingon')).toBe(false)
    expect(isLanguageSetting('')).toBe(false)
  })
})

describe('createTranslator', () => {
  it('substitutes placeholders', () => {
    const t = translatorFor('en')
    expect(t('update.available', { version: '1.2.0' })).toBe('Version 1.2.0 is available.')
  })

  it('takes numbers as well as strings', () => {
    const t = translatorFor('en')
    expect(t('update.available', { version: 42 })).toContain('42')
  })

  it('leaves an unknown placeholder alone rather than printing undefined', () => {
    const t = createTranslator({ ...en, 'update.available': 'Version {nope} is available.' })
    expect(t('update.available', { version: '1.0.0' })).toBe('Version {nope} is available.')
  })

  /**
   * A catalogue that lost a key at runtime — hand-edited, or a future loader
   * that half-failed — should degrade to English rather than to nothing. Blank
   * is the one outcome nobody notices in a language they do not read.
   */
  it('falls back to English for a missing entry', () => {
    const gappy = { ...en } as Record<string, string>
    delete gappy['tray.quit']
    const t = createTranslator(gappy as typeof en)
    expect(t('tray.quit')).toBe(en['tray.quit'])
  })

  it('returns the same instance for the same locale', () => {
    // The tray rebuilds its menu every fifteen seconds; rebuilding the
    // translator each time would be pure waste.
    expect(translatorFor('de')).toBe(translatorFor('de'))
  })
})

describe('German stays the wording the app shipped with', () => {
  /**
   * The app was German before it was translated, and those words were chosen
   * against Factorial's own interface — "Mobiles Arbeiten" is Factorial's term,
   * not a translation of "remote work". Pinning a few of them keeps a future
   * tidy-up from quietly replacing them with something more literal.
   */
  it('keeps Factorial’s own vocabulary', () => {
    const t = translatorFor('de')
    expect(t('location.work_from_home')).toBe('Mobiles Arbeiten')
    expect(t('state.in')).toBe('Eingestempelt')
    expect(t('state.out')).toBe('Ausgestempelt')
  })
})
