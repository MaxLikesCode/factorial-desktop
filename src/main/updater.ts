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
 * 2. **Nothing restarts a running shift.** `mayRestart` gates the restart
 *    prompt on the attendance state. If somebody is clocked in, the update is
 *    staged and applied the next time they quit — `autoInstallOnAppQuit` — and
 *    they are told so rather than being nagged.
 * 3. **Silence when nobody asked.** A background check that fails (no network,
 *    GitHub down, a release without the metadata) writes to the log and stops.
 *    A check somebody clicked reports what happened, success or not, because an
 *    action with no response reads as broken.
 */

import { app, dialog, shell } from 'electron'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  capabilityFor,
  installKind,
  mayRestart,
  shouldOffer,
} from './update-policy'

/** Where a portable build sends people, since it cannot update itself. */
const RELEASES_URL = 'https://github.com/MaxLikesCode/factorial-desktop/releases/latest'

export interface UpdaterDeps {
  /** The attendance state's `kind`, read per prompt — never captured once. */
  getStateKind: () => string
  /** Injected for tests; the real one is electron-updater's singleton. */
  updater?: AppUpdater
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
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Herunterladen', 'Später'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update verfügbar',
      message: `Version ${info.version} ist verfügbar.`,
      detail: `Installiert ist ${app.getVersion()}. Das Update wird jetzt geladen; installiert wird es erst, wenn du zustimmst.`,
    })
    if (response !== 0) {
      declined = info.version
      return
    }
    await updater.downloadUpdate()
  }

  async function offerLink(info: UpdateInfo): Promise<void> {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Download-Seite öffnen', 'Später'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update verfügbar',
      message: `Version ${info.version} ist verfügbar.`,
      // Saying why, because "download it yourself" looks like a missing feature
      // rather than a consequence of how this copy was started.
      detail:
        `Installiert ist ${app.getVersion()}. Diese Fassung läuft ohne Installation und ` +
        `kann sich nicht selbst ersetzen — lade die neue Datei herunter und tausche sie aus.`,
    })
    if (response === 0) await shell.openExternal(RELEASES_URL)
    else declined = info.version
  }

  async function offerRestart(version: string): Promise<void> {
    staged = version
    if (!mayRestart(deps.getStateKind())) {
      // Clocked in: the update is on disk and will apply on the next quit. Said
      // once, not asked repeatedly.
      await dialog.showMessageBox({
        type: 'info',
        buttons: ['Verstanden'],
        title: 'Update bereit',
        message: `Version ${version} ist heruntergeladen.`,
        detail:
          'Weil gerade eine Schicht läuft, wird jetzt nicht neu gestartet. ' +
          'Das Update wird automatisch installiert, sobald du die App das nächste Mal beendest.',
      })
      return
    }

    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Jetzt neu starten', 'Beim nächsten Beenden'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update bereit',
      message: `Version ${version} ist heruntergeladen.`,
      detail: 'Der Neustart dauert einen Moment. Deine Anmeldung bleibt erhalten.',
    })
    if (response === 0) {
      const updater = resolveUpdater()
      updater?.quitAndInstall()
    }
  }

  async function checkNow(manual: boolean): Promise<void> {
    if (!can.check) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          buttons: ['OK'],
          title: 'Kein Update möglich',
          message: 'Diese Fassung sucht nicht nach Updates.',
          detail: 'Im Entwicklungsmodus ist die Update-Prüfung abgeschaltet.',
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
        if (manual) await reportFailure('Die Update-Funktion steht nicht zur Verfügung.')
        return
      }

      updater.autoDownload = false
      updater.autoInstallOnAppQuit = true

      const result = await updater.checkForUpdates()
      const info = result?.updateInfo
      if (!info || info.version === app.getVersion()) {
        if (manual) {
          await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            title: 'Kein Update',
            message: 'Du verwendest die neueste Version.',
            detail: `Installiert ist ${app.getVersion()}.`,
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
    await dialog.showMessageBox({
      type: 'warning',
      buttons: ['OK'],
      title: 'Update-Prüfung fehlgeschlagen',
      message: 'Es konnte nicht nach Updates gesucht werden.',
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
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = true
      updater.on('update-downloaded', (info: UpdateInfo) => {
        void offerRestart(info.version)
      })
      // Without a listener electron-updater treats an error as unhandled and
      // takes the process down with it — over a failed network request.
      updater.on('error', (error: Error) => {
        console.error('[update] error:', describe(error))
      })
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

  return { start, stop, checkNow }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
