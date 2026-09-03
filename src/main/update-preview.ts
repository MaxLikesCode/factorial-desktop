/**
 * A look at the update window without a release to show in it.
 *
 * A development run never checks for updates (`installKind` says so), and a
 * change to the updater only takes effect one release *after* the one that
 * ships it — see "Traps" in docs/RELEASING.md. Between those two facts there
 * is no honest way to see the window before it reaches users, other than this:
 * start with `FACTORIAL_PREVIEW_UPDATE=1` and it opens with a made-up release,
 * and the buttons walk it through a pretend download.
 *
 * Nothing here runs in a packaged build, whatever the environment says.
 */

import { app } from 'electron'
import type { Locale } from '@shared/i18n'
import type { UpdateWindowAction, UpdateWindowState } from '@shared/update-window'
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

export function maybePreviewUpdateWindow(getLocale: () => Locale): void {
  if (app.isPackaged) return
  if (process.env.FACTORIAL_PREVIEW_UPDATE !== '1') return

  let ticker: NodeJS.Timeout | null = null
  let autoInstall = false

  const view = (state: UpdateWindowState): { locale: Locale; state: UpdateWindowState } => ({
    locale: getLocale(),
    state,
  })

  const offer = (): UpdateWindowState => ({
    kind: 'available',
    version: '9.9.9',
    current: app.getVersion(),
    notes: FAKE_NOTES,
    autoInstall,
  })

  function stopTicker(): void {
    if (ticker) clearInterval(ticker)
    ticker = null
  }

  function startDownload(): void {
    let transferred = 0
    pushUpdateView(view({ kind: 'downloading', version: '9.9.9', transferred, total: TOTAL }))
    ticker = setInterval(() => {
      transferred = Math.min(TOTAL, transferred + 2_500_000)
      if (transferred < TOTAL) {
        pushUpdateView(view({ kind: 'downloading', version: '9.9.9', transferred, total: TOTAL }))
        return
      }
      stopTicker()
      pushUpdateView(view({ kind: 'ready', version: '9.9.9', transferred, total: TOTAL }))
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
        stopTicker()
        pushUpdateView(
          view({ kind: 'failed', version: '9.9.9', reason: 'Preview: nothing to install.' }),
        )
        return
      default:
        stopTicker()
        closeUpdateWindow()
    }
  }

  showUpdateWindow(view(offer()), onAction)
}
