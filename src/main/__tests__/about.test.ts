import { describe, expect, it } from 'vitest'
import { translatorFor } from '@shared/locales'
import { aboutDetail } from '../about'

/**
 * The About box exists to answer one question — "which build is this?" — and it
 * is the only place in the app that can. Worth asserting rather than eyeballing
 * once: a version line that silently stops updating would look exactly like a
 * version line that works.
 */
describe('aboutDetail', () => {
  const versions = { app: '0.2.4', electron: '43.4.0', chromium: '150.0.7871.224' }

  it('leads with the app version, translated', () => {
    expect(aboutDetail(translatorFor('de'), versions)).toBe(
      'Version 0.2.4\nElectron 43.4.0 · Chromium 150.0.7871.224',
    )
  })

  it('translates only the first line', () => {
    // The runtime line is product names and digits. Every language gets it
    // verbatim, which is also why it is not in the catalogues.
    for (const locale of ['en', 'es', 'fr', 'it', 'nl', 'pt'] as const) {
      const [, runtime] = aboutDetail(translatorFor(locale), versions).split('\n')
      expect(runtime).toBe('Electron 43.4.0 · Chromium 150.0.7871.224')
    }
    expect(aboutDetail(translatorFor('pt'), versions)).toContain('Versão 0.2.4')
  })
})
