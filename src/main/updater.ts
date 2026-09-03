/**
 * Checking for a new version, and asking before doing anything about it.
 *
 * The Electron half of `update-policy.ts`: that module decides, this one talks
 * to `electron-updater` and to the user. Nothing here decides *whether* an
 * update may happen — it asks the policy — so the awkward cases (portable
 * build, clocked in, dev mode) are checked by unit tests rather than by
 * remembering to try them.
 *
 * The conversation with the user happens in the update window
 * (`update-window.ts`): one window that offers the release with its notes,
 * shows the download, and offers the restart. Native message boxes remain
 * for the answers that are one sentence long — "you are up to date", "this
 * copy cannot update itself", "the check failed".
 *
 * Four deliberate choices:
 *
 * 1. **Nothing downloads without being asked.** `autoDownload` is off. An app
 *    that pulls 100 MB on a metered connection because it felt like it is not a
 *    good citizen, and the dialog costs one click. The one exception is the
 *    user's own: the offer's "automatically download and install" checkbox,
 *    which is a stored setting and is undone from the tray.
 * 2. **A running shift does not stand in the way.** It used to: the restart
 *    prompt was withheld while somebody was clocked in. But the shift is
 *    Factorial's record, not this app's, so a restart never stopped it — the
 *    rule only forced people to clock out to install an update.
 * 3. **The app quits itself.** `quitAndInstall()` leaves that to Electron, and
 *    Electron waits for every window to close first — which this app's windows
 *    never do. See the note at the call.
 * 4. **Silence when nobody asked.** A background check that fails (no network,
 *    GitHub down, a release without the metadata) writes to the log and stops.
 *    A check somebody clicked reports what happened, success or not, because an
 *    action with no response reads as broken.
 */

import { app, autoUpdater as nativeUpdater, dialog, shell } from 'electron'
import type { AppUpdater, CancellationToken, UpdateInfo } from 'electron-updater'
import type { Locale, Translate } from '@shared/i18n'
import type { UpdateWindowAction, UpdateWindowState, UpdateWindowView } from '@shared/update-window'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  type UpdateStatus,
  capabilityFor,
  installKind,
  restartModeFor,
  notesOf,
  shouldOffer,
} from './update-policy'
import type { UpdateLogger } from './update-log'
import type { Settings } from './settings'
import {
  closeUpdateWindow,
  installUpdateWindowIpc,
  isUpdateWindowOpen,
  pushUpdateView,
  showUpdateWindow,
} from './update-window'

/** Where a portable build sends people, since it cannot update itself. */
const RELEASES_URL = 'https://github.com/MaxLikesCode/factorial-desktop/releases/latest'

/** What the lazily loaded module hands back; see `resolveModule`. */
interface UpdaterModule {
  autoUpdater: AppUpdater
  CancellationToken: new () => CancellationToken
}

export interface UpdaterDeps {
  /**
   * The translator, resolved per prompt for the same reason as the state: a
   * dialog opened after the language changed must speak the new one.
   */
  getTranslate: () => Translate
  /** The language the update window draws in, resolved per view for the same reason. */
  getLocale: () => Locale
  /**
   * Where "skip this version" and "install automatically" are kept. The
   * broadcasting wrapper from `index.ts`, so the tray's checkbox follows a tick
   * in the window.
   */
  settings: Settings
  /** Injected for tests; the real one is electron-updater's singleton. */
  updater?: AppUpdater
  /**
   * Called whenever `getStatus()` starts returning something else, so the tray
   * can redraw. The tray polls slowly on its own; a download would otherwise
   * advance in fifteen-second jumps.
   */
  onStatusChange?: () => void
  /**
   * Where the updater writes what happened. Handed to electron-updater as well,
   * so its own internals land in the same file — see `update-log.ts`.
   */
  logger?: UpdateLogger
}

export interface Updater {
  /** Starts the background schedule. Does nothing where updates cannot apply. */
  start(): void
  stop(): void
  /**
   * Checks now. `manual` decides whether silence is acceptable: a background
   * check says nothing when there is nothing to say, a requested one always
   * answers.
   */
  checkNow(manual: boolean): Promise<void>
  /** What the tray should be saying right now. */
  getStatus(): UpdateStatus
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const kind = installKind({
    packaged: app.isPackaged,
    portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE,
  })
  const can = capabilityFor(kind)
  installUpdateWindowIpc()

  let timer: NodeJS.Timeout | null = null
  let firstTimer: NodeJS.Timeout | null = null
  /** The version the user said "later" to, so the same one is not offered twice this session. */
  let declined: string | null = null
  /** Guards against a second check while one is in flight. */
  let busy = false
  /** Downloaded and waiting for a quit; used to answer a manual re-check. */
  let staged: string | null = null
  /** The version currently being fetched, so the second phase can name it. */
  let pending: string | null = null
  /** The release the window is about, so a button press knows which one. */
  let offered: UpdateInfo | null = null
  /** The running download's cancel handle, or null when none runs. */
  let token: CancellationToken | null = null
  /** What the window was last told to show; `close` is interpreted against it. */
  let shown: UpdateWindowState | null = null
  /** Bytes so far, kept for the states after `downloading` that still show them. */
  let bytes: { transferred: number; total: number | null } = { transferred: 0, total: null }
  let status: UpdateStatus = { kind: 'idle' }

  function setStatus(next: UpdateStatus): void {
    status = next
    deps.onStatusChange?.()
  }

  // Loaded lazily so that `npm test` and the dev run never pull the module in;
  // it reads app-update.yml at import time and complains when there is none.
  function resolveModule(): UpdaterModule | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require('electron-updater') as UpdaterModule
      return deps.updater ? { ...loaded, autoUpdater: deps.updater } : loaded
    } catch (error) {
      console.error('[update] electron-updater not available:', describe(error))
      return null
    }
  }

  function resolveUpdater(): AppUpdater | null {
    return deps.updater ?? resolveModule()?.autoUpdater ?? null
  }

  function view(state: UpdateWindowState): UpdateWindowView {
    shown = state
    return { locale: deps.getLocale(), state }
  }

  /** Shows the state, opening the window if it is closed. */
  function show(state: UpdateWindowState): void {
    showUpdateWindow(view(state), handleAction)
  }

  /** Updates an open window; a closed one is left closed. */
  function push(state: UpdateWindowState): void {
    pushUpdateView(view(state))
  }

  function offerDownload(updater: AppUpdater, info: UpdateInfo, manual: boolean): void {
    offered = info
    const settings = deps.settings.get()
    // The user's standing answer. Only for checks nobody asked for: a manual
    // check is a request to be shown the offer, whatever the checkbox says.
    if (!manual && settings.autoInstallUpdates) {
      void download(updater, info, true)
      return
    }
    show({
      kind: 'available',
      version: info.version,
      current: app.getVersion(),
      notes: notesOf(info),
      autoInstall: settings.autoInstallUpdates,
    })
  }

  /**
   * Fetches the release. `quiet` is the automatic path: no window unless
   * something goes wrong or the download finishes, at which point the restart
   * has to be offered by somebody.
   */
  async function download(updater: AppUpdater, info: UpdateInfo, quiet: boolean): Promise<void> {
    const module = resolveModule()
    if (module === null) return
    if (token !== null) return
    offered = info
    pending = info.version
    bytes = { transferred: 0, total: null }
    token = new module.CancellationToken()
    setStatus({ kind: 'downloading', percent: 0 })
    if (!quiet) show({ kind: 'downloading', version: info.version, ...bytes })
    try {
      await updater.downloadUpdate(token)
    } catch (error) {
      // electron-updater rejects a cancelled download with a CancellationError
      // and, unlike every other failure, does not emit `error` for it.
      const cancelled = token.cancelled
      setStatus({ kind: 'idle' })
      if (cancelled) {
        declined = info.version
        closeUpdateWindow()
        return
      }
      deps.logger?.error(`download failed: ${describe(error)}`)
      // A failure nobody was watching is a log line; one they were watching, or
      // one they asked for, is a message.
      if (!quiet || isUpdateWindowOpen()) {
        show({ kind: 'failed', version: info.version, reason: describe(error) })
      }
    } finally {
      token = null
    }
  }

  async function offerLink(info: UpdateInfo): Promise<void> {
    const t = deps.getTranslate()
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: [t('update.openDownloads'), t('update.later')],
      defaultId: 0,
      cancelId: 1,
      title: t('update.availableTitle'),
      message: t('update.available', { version: info.version }),
      // Saying why, because "download it yourself" looks like a missing feature
      // rather than a consequence of how this copy was started.
      detail: t('update.availablePortableDetail', { current: app.getVersion() }),
    })
    if (response === 0) await shell.openExternal(RELEASES_URL)
    else declined = info.version
  }

  function offerRestart(version: string): void {
    staged = version
    setStatus({ kind: 'ready', version })
    // Shown whether or not the window is open: on the automatic path this is
    // the first the user hears of it, and a restart needs somebody to press it.
    show({ kind: 'ready', version, ...bytes })
  }

  function installNow(): void {
    const updater = resolveUpdater()
    // The two arguments are the whole difference between an update that
    // applies itself and one that hands the setup wizard back to the user;
    // `restartModeFor` carries the reasoning.
    const mode = restartModeFor(process.platform)
    updater?.quitAndInstall(mode.silent, mode.runAfter)
    // `quitAndInstall()` is not enough on its own, and the reason is a
    // collision between two reasonable designs. Electron's version closes
    // every window and calls `app.quit()` only once they are all closed. This
    // app's windows do not close: `windows.ts` hides them and calls
    // `preventDefault()`, because closing the widget is not meant to end the
    // app (DESIGN.md, "Tray"). The guard it uses — `quitting` — is set by
    // `before-quit`, which nothing has fired yet at this point.
    //
    // So the widget vanished, the tray survived, "all windows closed" never
    // happened, `app.quit()` was never called, and the update sat staged
    // until the app was quit by hand. Squirrel had done its part; nobody
    // ever left.
    //
    // Quitting here takes the app's own route out — `before-quit` sets
    // `quitting`, the windows then really close, the process exits, and
    // ShipIt, already armed by the call above, swaps the bundle and relaunches.
    app.quit()
  }

  /** Every button in the window ends up here. */
  function handleAction(action: UpdateWindowAction): void {
    switch (action.kind) {
      case 'skip':
        // Persisted, unlike "later": a skip is meant to outlast the session.
        if (offered !== null) deps.settings.set({ skippedUpdateVersion: offered.version })
        closeUpdateWindow()
        return
      case 'later':
        if (offered !== null) declined = offered.version
        closeUpdateWindow()
        return
      case 'install': {
        const updater = resolveUpdater()
        if (updater !== null && offered !== null) void download(updater, offered, false)
        return
      }
      case 'autoInstall':
        deps.settings.set({ autoInstallUpdates: action.value })
        return
      case 'cancel':
        // The download's own catch closes the window once the cancel lands.
        if (token !== null) token.cancel()
        else closeUpdateWindow()
        return
      case 'restart':
        installNow()
        return
      case 'close':
        // The X means whatever "no" means in the state it was pressed in. A
        // downloaded update is not thrown away by it: it stays staged for the
        // next quit, and the tray keeps offering the restart.
        if (shown?.kind === 'available') handleAction({ kind: 'later' })
        else if (shown?.kind === 'downloading') handleAction({ kind: 'cancel' })
        else closeUpdateWindow()
        return
    }
  }

  async function checkNow(manual: boolean): Promise<void> {
    if (!can.check) {
      if (manual) {
        const t = deps.getTranslate()
        await dialog.showMessageBox({
          type: 'info',
          buttons: ['OK'],
          title: t('update.disabledTitle'),
          message: t('update.disabled'),
          detail: t('update.disabledDetail'),
        })
      }
      return
    }
    if (busy) return
    busy = true

    try {
      // Already downloaded and waiting: answer from what is known rather than
      // asking GitHub again.
      if (staged !== null) {
        offerRestart(staged)
        return
      }
      // Mid-download: the answer is the window that shows it.
      if (token !== null) {
        if (manual && shown !== null) show(shown)
        return
      }

      const updater = resolveUpdater()
      if (updater === null) {
        if (manual) await reportFailure(deps.getTranslate()('update.disabled'))
        return
      }

      updater.autoDownload = false
      updater.autoInstallOnAppQuit = true

      const result = await updater.checkForUpdates()
      const info = result?.updateInfo
      if (!info || info.version === app.getVersion()) {
        if (manual) {
          const t = deps.getTranslate()
          await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            title: t('update.noneTitle'),
            message: t('update.none'),
            detail: t('update.noneDetail', { current: app.getVersion() }),
          })
        }
        return
      }

      // A version already declined this session, or skipped for good, is not
      // offered again unless the user asked for the check themselves.
      if (!manual && !shouldOffer(info.version, declined, deps.settings.get().skippedUpdateVersion)) {
        return
      }

      if (!can.install) {
        await offerLink(info)
        return
      }
      offerDownload(updater, info, manual)
    } catch (error) {
      console.error('[update] check failed:', describe(error))
      if (manual) await reportFailure(describe(error))
    } finally {
      busy = false
    }
  }

  async function reportFailure(detail: string): Promise<void> {
    const t = deps.getTranslate()
    await dialog.showMessageBox({
      type: 'warning',
      buttons: ['OK'],
      title: t('update.failedTitle'),
      message: t('update.failed'),
      detail,
    })
  }

  function start(): void {
    if (!can.check) {
      console.log(`[update] disabled for this install (${kind})`)
      return
    }

    const updater = resolveUpdater()
    if (updater !== null && can.install) {
      if (deps.logger) updater.logger = deps.logger
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = true

      updater.on(
        'download-progress',
        (progress: { percent: number; transferred: number; total: number }) => {
          bytes = { transferred: progress.transferred, total: progress.total }
          setStatus({ kind: 'downloading', percent: progress.percent })
          push({ kind: 'downloading', version: pending ?? '', ...bytes })
        },
      )

      updater.on('update-downloaded', (info: UpdateInfo) => {
        pending = info.version
        // PLATFORM: on macOS this does *not* mean the update can be installed.
        // electron-updater has only written the archive into its cache and
        // started a local HTTP server; Squirrel still has to fetch the whole
        // thing from that server, and only Squirrel's own `update-downloaded`
        // means "installable". Offering a restart here is what made "Restart
        // now" do nothing at all: `quitAndInstall()` finds Squirrel not ready,
        // quietly registers a listener and returns — no quit, no message, and
        // `autoInstallOnAppQuit` cannot save it either, because there is still
        // nothing staged when the app is quit by hand.
        if (process.platform === 'darwin') {
          setStatus({ kind: 'preparing' })
          push({ kind: 'preparing', version: info.version, ...bytes })
          return
        }
        offerRestart(info.version)
      })

      // Without a listener electron-updater treats an error as unhandled and
      // takes the process down with it — over a failed network request.
      updater.on('error', (error: Error) => {
        deps.logger?.error(`electron-updater: ${describe(error)}`)
        console.error('[update] error:', describe(error))
        setStatus({ kind: 'idle' })
      })

      if (process.platform === 'darwin') {
        // Squirrel's own events, which are the truthful ones on this platform.
        // Attaching a listener is safe on an unsigned build; only calling into
        // it would not be.
        nativeUpdater.on('update-downloaded', () => {
          deps.logger?.info('Squirrel staged the update; a restart now installs it')
          offerRestart(pending ?? app.getVersion())
        })
        nativeUpdater.on('error', (error: Error) => {
          deps.logger?.error(`Squirrel: ${describe(error)}`)
          console.error('[update] squirrel error:', describe(error))
          setStatus({ kind: 'idle' })
          if (isUpdateWindowOpen()) {
            show({ kind: 'failed', version: pending ?? '', reason: describe(error) })
          }
        })
      }
    }

    firstTimer = setTimeout(() => void checkNow(false), FIRST_CHECK_DELAY_MS)
    timer = setInterval(() => void checkNow(false), CHECK_INTERVAL_MS)
  }

  function stop(): void {
    if (firstTimer) clearTimeout(firstTimer)
    if (timer) clearInterval(timer)
    firstTimer = null
    timer = null
  }

  return { start, stop, checkNow, getStatus: () => status }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
