/**
 * A look at the update window without a release to show in it.
 *
 * A development run never checks for updates (`installKind` says so), and a
 * change to the updater only takes effect one release *after* the one that
 * ships it — see "Traps" in docs/RELEASING.md. Between those two facts there
 * is no honest way to see the window before it reaches users, other than this:
 * start with `FACTORIAL_PREVIEW_UPDATE=<state>` and it opens with a made-up
 * release, and the buttons walk it through a pretend download.
 *
 * `npm run dev:update [state]` is the same thing without the shell-specific
 * way of setting the variable; see `scripts/preview-update.mjs`.
 *
 * The value names the state to open in, so that every card the window can show
 * can be looked at directly rather than only the ones the offer leads to. `1`
 * and `offer` both mean the offer, which is what the flag used to do when it
 * was a plain on/off.
 *
 * Nothing here runs in a packaged build, whatever the environment says.
 */

import { app } from 'electron'
import type { Locale } from '@shared/i18n'
import { translatorFor } from '@shared/locales'
import type { UpdateWindowAction, UpdateWindowState } from '@shared/update-window'
import { aboutDetail } from './about'
import { closeUpdateWindow, pushUpdateView, showUpdateWindow } from './update-window'

const FAKE_NOTES = `
<h2>Improvements</h2>
<ul>
<li>The widget can be dragged between displays with different scaling without changing size</li>
<li>Updates are offered in a window of their own, with the release notes</li>
</ul>
<h2>Fixes</h2>
<ul>
<li>The widget no longer sticks to the cursor after a quick drag on Windows</li>
</ul>
<p><strong>Full changelog</strong>: <a href="https://github.com/MaxLikesCode/factorial-desktop/releases">releases</a></p>
`

const TOTAL = 59_000_000
const VERSION = '9.9.9'

/** What the flag may say, and which card it opens. */
type PreviewStart =
  | 'offer'
  | 'downloading'
  | 'preparing'
  | 'ready'
  | 'failed'
  | 'upToDate'
  | 'notice'

/**
 * Reads the flag. Names are matched without case or punctuation, so
 * `uptodate`, `upToDate` and `up-to-date` are the same word, and `about` is
 * spelled the way one would ask for it rather than by its state's name.
 */
function previewStart(): PreviewStart | null {
  if (app.isPackaged) return null
  const raw = process.env.FACTORIAL_PREVIEW_UPDATE
  if (raw === undefined || raw === '' || raw === '0') return null
  const word = raw.toLowerCase().replace(/[^a-z]/g, '')
  switch (word) {
    case '':
    case 'offer':
    case 'available':
      return 'offer'
    case 'downloading':
    case 'download':
      return 'downloading'
    case 'preparing':
      return 'preparing'
    case 'ready':
      return 'ready'
    case 'failed':
    case 'error':
      return 'failed'
    case 'uptodate':
      return 'upToDate'
    case 'notice':
    case 'about':
      return 'notice'
    default:
      // `1`, and anything else, keeps the flag's original meaning.
      return 'offer'
  }
}

/** Opens the preview at start, so the window is on screen without a click. */
export function maybePreviewUpdateWindow(getLocale: () => Locale): void {
  previewUpdateOffer(getLocale)
}

/**
 * Shows the made-up offer if the preview is on. Returns whether it did, so
 * the updater's manual check can hand over to it instead of saying "this
 * build does not check for updates".
 */
export function previewUpdateOffer(getLocale: () => Locale): boolean {
  const start = previewStart()
  if (start === null) return false

  let ticker: NodeJS.Timeout | null = null
  let autoInstall = false

  const view = (state: UpdateWindowState): { locale: Locale; state: UpdateWindowState } => ({
    locale: getLocale(),
    state,
  })

  const offer = (): UpdateWindowState => ({
    kind: 'available',
    version: VERSION,
    current: app.getVersion(),
    notes: FAKE_NOTES,
    autoInstall,
  })

  function initial(): UpdateWindowState {
    switch (start) {
      case 'downloading':
        return { kind: 'downloading', version: VERSION, transferred: 31_900_000, total: TOTAL }
      case 'preparing':
        return { kind: 'preparing', version: VERSION, transferred: TOTAL, total: null }
      case 'ready':
        return { kind: 'ready', version: VERSION, transferred: TOTAL, total: TOTAL }
      case 'failed':
        return { kind: 'failed', version: VERSION, reason: 'net::ERR_INTERNET_DISCONNECTED' }
      case 'upToDate':
        return { kind: 'upToDate', current: app.getVersion() }
      case 'notice':
        return {
          kind: 'notice',
          title: 'Factorial Desktop',
          lines: aboutDetail(translatorFor(getLocale()), {
            app: app.getVersion(),
            electron: process.versions.electron,
            chromium: process.versions.chrome,
          }).split('\n'),
        }
      default:
        return offer()
    }
  }

  function stopTicker(): void {
    if (ticker) clearInterval(ticker)
    ticker = null
  }

  function startDownload(): void {
    let transferred = 0
    pushUpdateView(view({ kind: 'downloading', version: VERSION, transferred, total: TOTAL }))
    ticker = setInterval(() => {
      transferred = Math.min(TOTAL, transferred + 2_500_000)
      if (transferred < TOTAL) {
        pushUpdateView(view({ kind: 'downloading', version: VERSION, transferred, total: TOTAL }))
        return
      }
      stopTicker()
      pushUpdateView(view({ kind: 'ready', version: VERSION, transferred, total: TOTAL }))
    }, 120)
  }

  function onAction(action: UpdateWindowAction): void {
    console.log('[update-preview] action:', JSON.stringify(action))
    switch (action.kind) {
      case 'install':
        startDownload()
        return
      case 'autoInstall':
        autoInstall = action.value
        return
      case 'cancel':
        stopTicker()
        pushUpdateView(view(offer()))
        return
      case 'restart':
        // Nothing to install in a preview; show the remaining card instead.
        stopTicker()
        pushUpdateView(view({ kind: 'upToDate', current: app.getVersion() }))
        return
      default:
        stopTicker()
        closeUpdateWindow()
    }
  }

  showUpdateWindow(view(initial()), onAction)
  return true
}
