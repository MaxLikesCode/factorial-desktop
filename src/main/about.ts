/**
 * What the app says about itself.
 *
 * Split the same way as everything else that has to be looked at rather than
 * guessed: `aboutDetail` is arithmetic on strings and is unit tested, `showAbout`
 * is the Electron dialog around it.
 *
 * The runtime versions are in there on purpose. "It does not update" and "the
 * tray icon is wrong" are both reports that start with *which build, on what* —
 * and asking somebody to find that out afterwards, from an app whose only
 * surface is a tray menu, is asking them to go looking in Finder for an
 * Info.plist. One click is cheaper for everyone.
 */

import { app, dialog } from 'electron'
import type { Translate } from '@shared/i18n'

export interface AboutVersions {
  /** The app's own version — `package.json`, via `app.getVersion()`. */
  app: string
  electron: string
  chromium: string
}

/**
 * The body of the About box.
 *
 * Only the first line is translated. The second is product names and digits,
 * which are the same in every language and would only ever be mistranslated.
 */
export function aboutDetail(t: Translate, versions: AboutVersions): string {
  return [
    t('about.version', { version: versions.app }),
    `Electron ${versions.electron} · Chromium ${versions.chromium}`,
  ].join('\n')
}

export async function showAbout(t: Translate): Promise<void> {
  await dialog.showMessageBox({
    type: 'info',
    buttons: ['OK'],
    // Never translated: it is the product's name, not a word.
    message: 'Factorial Desktop',
    detail: aboutDetail(t, {
      app: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
    }),
  })
}
