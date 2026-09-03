/**
 * When to look for a new version, and what to do about one — as arithmetic.
 *
 * The Electron half lives in `updater.ts`; this half decides and is unit
 * tested, the same split as `window-position.ts` and `settings.ts`. Everything
 * here takes what it needs as an argument rather than reading it from the
 * process, which is why the Windows-only cases can be checked from any machine.
 *
 * This module used to open with a rule: never restart while somebody is clocked
 * in. It has been dropped, because the premise was wrong. The shift does not
 * live here — `clockIn` and `fetchOpenShift` are calls to Factorial, and the
 * app is a display and a remote control for a record kept on their server. A
 * restart therefore stops nothing; it re-reads the shift on the way back up.
 * What the old rule actually protected was the *view* of the timer, for the few
 * seconds an update takes, at the price of making people clock out to install
 * one.
 */

import type { Translate } from '@shared/i18n'

/** How the running copy was installed, which decides what an update can do. */
export type InstallKind =
  /** NSIS install under Programs. The only kind electron-updater can replace. */
  | 'installed'
  /**
   * The portable .exe, which unpacks to %TEMP% and runs from there. There is
   * nothing to replace: the file the user keeps is somewhere this process
   * cannot know is still writable, and overwriting a running unpack does not
   * update anything.
   */
  | 'portable'
  /** `npm run dev`, or a build running out of a directory. Never updates. */
  | 'development'

/**
 * Which of the three this process is.
 *
 * `PORTABLE_EXECUTABLE_FILE` is set by electron-builder's portable launcher and
 * by nothing else, which makes it the reliable signal — more so than inspecting
 * the path, since a portable copy can sit anywhere.
 *
 * PLATFORM: the `portable` case only ever occurs on Windows — there is no
 * portable target for macOS, where the equivalent is a .app the user drags
 * where they like and which electron-updater handles like any other install.
 * The branch is written platform-free so it can be tested from anywhere, which
 * is the whole reason it takes its inputs as arguments.
 */
export function installKind(input: {
  packaged: boolean
  portableExecutable?: string | undefined
}): InstallKind {
  if (!input.packaged) return 'development'
  if (input.portableExecutable !== undefined && input.portableExecutable !== '') return 'portable'
  return 'installed'
}

/** What the updater is allowed to do for a given install. */
export interface UpdateCapability {
  /** Whether to ask the release feed at all. */
  check: boolean
  /** Whether a found version can be downloaded and installed in place. */
  install: boolean
}

export function capabilityFor(kind: InstallKind): UpdateCapability {
  switch (kind) {
    case 'installed':
      return { check: true, install: true }
    // Checking is still worth it: the app can say a new version exists and open
    // the download page. Pretending it can install one would be a lie that ends
    // in a progress bar going nowhere.
    case 'portable':
      return { check: true, install: false }
    case 'development':
      return { check: false, install: false }
  }
}

/** Milliseconds between checks. Six hours: releases are not that frequent. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * How long after launch the first check waits.
 *
 * Long enough that it is never competing with the first attendance refresh for
 * the network, short enough that somebody who leaves the app open all day gets
 * told on the first day rather than the second.
 */
export const FIRST_CHECK_DELAY_MS = 30 * 1000

/**
 * Whether a version that was already declined should be offered again.
 *
 * Being asked twice about the same version is how a prompt becomes something
 * people dismiss without reading, so a decline holds until a *different*
 * version shows up. It deliberately does not persist across restarts: the
 * question is cheap once per session, and a stored "never ask again" tends to
 * outlive the reason it was set.
 *
 * `skipped` is the one that does persist — the offer's "skip this version",
 * kept in settings. It is still bounded to a version: the next release is
 * offered again, so the setting cannot outlive its reason either.
 */
export function shouldOffer(
  version: string,
  declined: string | null,
  skipped: string | null = null,
): boolean {
  return version !== declined && version !== skipped
}

/**
 * What the updater is doing, as far as the tray needs to say so.
 *
 * `preparing` is not padding between `downloading` and `ready`. On macOS
 * electron-updater's own download only writes the archive into a cache and
 * starts a local HTTP server; Squirrel then fetches the whole thing *again*
 * from that server, and the update is installable only when that second pass
 * finishes. Nothing reports progress for it, so it gets a state of its own
 * rather than a percentage that would sit at 100 and be a lie.
 */
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'preparing' }
  | { kind: 'ready'; version: string }

/**
 * The tray's update entry, which doubles as the progress display.
 *
 * Disabled while something is in flight: a second click cannot help, and an
 * entry that stays clickable invites one. `ready` stays clickable because there
 * the click is the whole point.
 */
export function updateMenuEntry(
  t: Translate,
  status: UpdateStatus,
): { label: string; enabled: boolean } {
  switch (status.kind) {
    case 'downloading':
      return {
        label: t('update.downloading', { percent: String(Math.round(status.percent)) }),
        enabled: false,
      }
    case 'preparing':
      return { label: t('update.preparing'), enabled: false }
    case 'ready':
      return { label: t('update.restartToInstall', { version: status.version }), enabled: true }
    case 'idle':
      return { label: t('settings.checkForUpdates'), enabled: true }
  }
}

/**
 * How `quitAndInstall` has to be called, per platform.
 *
 * PLATFORM: this is a Windows problem with a Windows answer. electron-updater's
 * NSIS path does not install anything itself — it spawns the downloaded
 * `Factorial-Desktop-Setup-<version>.exe` and lets it do the work, passing
 * `--updated` plus whatever these two flags say:
 *
 *   silent   -> `/S`, which is what turns the setup wizard off
 *   runAfter -> `--force-run`, which is what starts the app again afterwards
 *
 * Both default to `false`, and that default is what made "Restart now" hand
 * people the whole installer a second time: welcome page, install-mode page,
 * directory page, finish page — for a version they had already agreed to
 * install. With `/S` the installer takes the existing installation out of the
 * registry (`InstallLocation` under the per-user or per-machine key) instead of
 * asking for it, so the silent run replaces exactly the copy that is running.
 *
 * `runAfter` is not optional alongside it. The assisted installer only starts
 * the app from its finish page — the page `/S` just removed — and without
 * `--force-run` a silent update ends with no app at all, which reads as a crash.
 *
 * macOS gets neither. There the installing is Squirrel's, `quitAndInstall`
 * takes no arguments it would use, and the relaunch is part of what ShipIt does.
 */
export interface RestartMode {
  /** Suppress the installer UI. */
  silent: boolean
  /** Start the app again once the installer is done. */
  runAfter: boolean
}

export function restartModeFor(platform: NodeJS.Platform): RestartMode {
  if (platform === 'win32') return { silent: true, runAfter: true }
  return { silent: false, runAfter: false }
}

/**
 * The release's notes as one HTML string, or null when there are none.
 *
 * The GitHub provider hands over the release body as rendered HTML — a string
 * for the latest release, or one entry per skipped release when
 * `fullChangelog` is on. Both shapes are folded to one string here so the
 * window has a single thing to sanitise.
 */
export function notesOf(info: { releaseNotes?: string | Array<{ note?: string | null }> | null }): string | null {
  const notes = info.releaseNotes
  if (typeof notes === 'string') return notes.trim() === '' ? null : notes
  if (Array.isArray(notes)) {
    const joined = notes
      .map((entry) => entry.note ?? '')
      .filter((note) => note.trim() !== '')
      .join('\n<hr>\n')
    return joined === '' ? null : joined
  }
  return null
}
