/**
 * Checking for a new version, and asking before doing anything about it.
 *
 * The Electron half of `update-policy.ts`: that module decides, this one talks
 * to `electron-updater` and to the user. Nothing here decides *whether* an
 * update may happen — it asks the policy — so the awkward cases (portable
 * build, clocked in, dev mode) are checked by unit tests rather than by
 * remembering to try them.
 *
 * Three deliberate choices:
 *
 * 1. **Nothing downloads without being asked.** `autoDownload` is off. An app
 *    that pulls 100 MB on a metered connection because it felt like it is not a
 *    good citizen, and the dialog costs one click.
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
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import type { Translate } from '@shared/i18n'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  type UpdateStatus,
  capabilityFor,
  installKind,
  restartModeFor,
  shouldOffer,
} from './update-policy'
import type { UpdateLogger } from './update-log'

/** Where a portable build sends people, since it cannot update itself. */
const RELEASES_URL = 'https://github.com/MaxLikesCode/factorial-desktop/releases/latest'

export interface UpdaterDeps {
  /**
   * The translator, resolved per prompt for the same reason as the state: a
   * dialog opened after the language changed must speak the new one.
   */
  getTranslate: () => Translate
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

  let timer: NodeJS.Timeout | null = null
  let firstTimer: NodeJS.Timeout | null = null
  /** The version the user said no to, so the same one is not offered twice. */
  let declined: string | null = null
  /** Guards against a second check while one is in flight. */
  let busy = false
  /** Downloaded and waiting for a quit; used to answer a manual re-check. */
  let staged: string | null = null
  /** The version currently being fetched, so the second phase can name it. */
  let pending: string | null = null
  let status: UpdateStatus = { kind: 'idle' }

  function setStatus(next: UpdateStatus): void {
    status = next
    deps.onStatusChange?.()
  }

  // Loaded lazily so that `npm test` and the dev run never pull the module in;
  // it reads app-update.yml at import time and complains when there is none.
  function resolveUpdater(): AppUpdater | null {
    if (deps.updater) return deps.updater
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require('electron-updater') as { autoUpdater: AppUpdater }).autoUpdater
    } catch (error) {
      console.error('[update] electron-updater not available:', describe(error))
      return null
    }
  }

  async function offerDownload(updater: AppUpdater, info: UpdateInfo): Promise<void> {
    const t = deps.getTranslate()
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: [t('update.download'), t('update.later')],
      defaultId: 0,
      cancelId: 1,
      title: t('update.availableTitle'),
      message: t('update.available', { version: info.version }),
      detail: t('update.availableDetail', { current: app.getVersion() }),
    })
    if (response !== 0) {
      declined = info.version
      return
    }
    pending = info.version
    setStatus({ kind: 'downloading', percent: 0 })
    await updater.downloadUpdate()
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

  async function offerRestart(version: string): Promise<void> {
    staged = version
    setStatus({ kind: 'ready', version })
    const t = deps.getTranslate()
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: [t('update.restartNow'), t('update.onNextQuit')],
      defaultId: 0,
      cancelId: 1,
      title: t('update.readyTitle'),
      message: t('update.ready', { version }),
      detail: t('update.readyDetail'),
    })
    if (response === 0) {
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
        await offerRestart(staged)
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

      // A version already declined this session is not offered again unless the
      // user asked for the check themselves.
      if (!manual && !shouldOffer(info.version, declined)) return

      if (!can.install) {
        await offerLink(info)
        return
      }
      await offerDownload(updater, info)
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

      updater.on('download-progress', (progress: { percent: number }) => {
        setStatus({ kind: 'downloading', percent: progress.percent })
      })

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
          return
        }
        void offerRestart(info.version)
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
          void offerRestart(pending ?? app.getVersion())
        })
        nativeUpdater.on('error', (error: Error) => {
          deps.logger?.error(`Squirrel: ${describe(error)}`)
          console.error('[update] squirrel error:', describe(error))
          setStatus({ kind: 'idle' })
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
