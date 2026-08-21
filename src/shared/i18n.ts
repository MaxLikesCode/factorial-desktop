/**
 * Every word the app says, in every language it says it in.
 *
 * It lives in `shared` because both halves need it: the tray menu, the update
 * dialogs and the error table run in the main process, the widget in the
 * renderer, and a string that appears in both — "Eingestempelt" did — must not
 * be able to disagree with itself.
 *
 * **No i18n library.** The whole surface is one function that looks a key up in
 * a record and substitutes `{placeholders}`. A library would bring a loader, a
 * plural engine and a React context for that, and the plural engine is the only
 * part with real value — which this app does not need, because it counts hours
 * and prints them as digits.
 *
 * English is the source. The other catalogues are typed as `Catalogue`, so
 * TypeScript refuses a language that is missing a key or invents one — the
 * failure mode of hand-maintained translations, caught at compile time rather
 * than by somebody noticing a blank menu entry in a language they do not read.
 */

/**
 * The languages this ships with: Factorial's own markets, English first.
 *
 * Adding one is a file next to `en` and a line in this list; the type checker
 * then names every key that is missing.
 */
export const LOCALES = ['en', 'de', 'es', 'fr', 'it', 'pt', 'nl'] as const

export type Locale = (typeof LOCALES)[number]

/** What the user picked. `system` follows the OS and is the default. */
export type LanguageSetting = 'system' | Locale

export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['system', ...LOCALES]

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value)
}

export function isLanguageSetting(value: string): value is LanguageSetting {
  return value === 'system' || isLocale(value)
}

/** What each language calls itself. Never translated — a menu of languages is
 * read by people who do not speak the one currently active. */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  pt: 'Português',
  nl: 'Nederlands',
}

/**
 * Turns whatever the OS reports into one of ours.
 *
 * `app.getLocale()` returns things like `de-DE`, `pt-BR` or `en-GB`, so only the
 * part before the dash is considered — a Brazilian and a Portuguese user get the
 * same catalogue, which is better than falling back to English for one of them.
 * Anything unknown becomes English rather than nothing: a language nobody
 * configured is still better than empty menus.
 */
export function resolveLocale(setting: LanguageSetting, systemLocale: string): Locale {
  if (setting !== 'system') return setting
  const base = systemLocale.toLowerCase().split(/[-_]/)[0] ?? ''
  return isLocale(base) ? base : 'en'
}

/**
 * The English catalogue, and by construction the shape of all the others.
 *
 * Keys are grouped by where they appear rather than by meaning, because that is
 * how they get changed: somebody edits the tray menu and needs every string the
 * tray menu says.
 */
export const en = {
  // The five states. Used by the widget and the tray, from here, once.
  'state.unknown': 'Loading …',
  'state.unauthenticated': 'Not signed in',
  'state.out': 'Clocked out',
  'state.in': 'Clocked in',
  'state.break': 'On a break',

  // Tray menu — actions.
  'tray.clockIn': 'Clock in',
  'tray.clockOut': 'Clock out',
  'tray.break': 'Break',
  'tray.resume': 'Resume',
  'tray.signIn': 'Sign in',
  'tray.signOut': 'Sign out',
  'tray.showWindow': 'Show window',
  'tray.hideWindow': 'Hide window',
  'tray.refresh': 'Refresh',
  'tray.settings': 'Settings',
  'tray.quit': 'Quit',

  // Tray menu — settings submenu.
  'settings.startAtLogin': 'Start at login',
  'settings.alwaysOnTop': 'Always on top',
  'settings.expand': 'Expand',
  'settings.expandRight': 'To the right',
  'settings.expandLeft': 'To the left',
  'settings.appearance': 'Appearance',
  'settings.appearanceSystem': 'System',
  'settings.appearanceLight': 'Light',
  'settings.appearanceDark': 'Dark',
  'settings.language': 'Language',
  'settings.languageSystem': 'System',
  'settings.checkForUpdates': 'Check for updates …',

  // Tray status line and tooltip. `{time}` is already formatted as H:MM.
  'tray.breakWithTime': 'Break {time}',
  'tray.today': 'today {time}',
  'tray.breakToday': 'Breaks today {time}',
  'tray.incomplete': 'incomplete',
  'tray.tooltip': 'Factorial · {status}',

  // Widget.
  'widget.worked': 'Worked {time}',
  'widget.breakTotal': 'Break {time}',
  'widget.remaining': 'Remaining {time}',
  'widget.targetMet': 'Target met · {overtime}',
  'widget.incomplete': 'Day total incomplete',

  // Work locations. Factorial's own wording where it is known — see the note in
  // the German catalogue.
  'widget.collapse': 'Collapse widget',
  'widget.expand': 'Show actions',
  'widget.pleaseWait': 'Please wait',
  'widget.workLocation': 'Work location',
  'location.office': 'Office',
  'location.work_from_home': 'Remote work',
  'location.business_trip': 'Business trip',

  // Failures of an action the user started. One table for tray and widget.
  'error.unauthenticated': 'Your session has expired. Please sign in again.',
  'error.graphql': 'Factorial rejected the action.',
  'error.network': 'No connection to Factorial. Nothing was saved.',
  'error.malformed': 'Unexpected answer from Factorial. Nothing was saved.',
  'error.unknown': 'The action failed.',
  'error.busy': 'Another action is still running. Please wait a moment.',
  'error.graphqlDetail': 'Factorial rejected the action: {detail}',
  'stale.generic': 'out of date',
  'error.settingsWrite': 'The setting could not be saved.',

  // Why what is on screen may be out of date. Deliberately shorter than the
  // messages above: this sits next to the status, not in a dialog.
  'stale.unauthenticated': 'Session expired',
  'stale.graphql': 'Factorial reports an error',
  'stale.network': 'No connection',
  'stale.malformed': 'Unexpected answer',
  'stale.unknown': 'Refresh failed',

  // Sign-in failure at startup, shown as a system dialog.
  'auth.failedTitle': 'Factorial Desktop',
  'auth.failed': 'Cannot sign in: {reason}',

  // Updates.
  'update.availableTitle': 'Update available',
  'update.available': 'Version {version} is available.',
  'update.availableDetail':
    'You have {current}. The update will be downloaded now; it is only installed once you agree.',
  'update.availablePortableDetail':
    'You have {current}. This copy runs without being installed and cannot replace itself — download the new file and swap it out.',
  'update.download': 'Download',
  'update.openDownloads': 'Open downloads page',
  'update.later': 'Later',
  'update.readyTitle': 'Update ready',
  'update.ready': 'Version {version} has been downloaded.',
  'update.readyDetail': 'Restarting takes a moment. You stay signed in.',
  'update.restartNow': 'Restart now',
  'update.downloading': 'Downloading update … {percent}%',
  'update.preparing': 'Preparing update …',
  'update.restartToInstall': 'Restart to install {version}',
  'update.onNextQuit': 'When I next quit',
  'update.noneTitle': 'No update',
  'update.none': 'You are on the latest version.',
  'update.noneDetail': 'You have {current}.',
  'update.disabledTitle': 'Updates unavailable',
  'update.disabled': 'This build does not check for updates.',
  'update.disabledDetail': 'Update checks are switched off in development mode.',
  'update.failedTitle': 'Update check failed',
  'update.failed': 'Could not check for updates.',
} as const

/** The shape every other language has to match, key for key. */
export type Catalogue = Record<keyof typeof en, string>

export type MessageKey = keyof typeof en

/** Values substituted into `{placeholders}`. */
export type Params = Record<string, string | number>

export type Translate = (key: MessageKey, params?: Params) => string

/**
 * Builds the lookup for one catalogue.
 *
 * A missing key falls back to English and then to the key itself, so a gap
 * shows up as a visible key rather than as a blank — silent emptiness is the
 * one failure mode that survives a review.
 */
export function createTranslator(catalogue: Catalogue): Translate {
  return (key, params) => {
    const template = catalogue[key] ?? en[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    )
  }
}
