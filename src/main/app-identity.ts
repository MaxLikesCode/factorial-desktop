/**
 * Where this app keeps its state on disk, and why it insists on saying so.
 *
 * Electron derives `userData` from `app.getName()`, which comes from
 * `package.json`. Pinning the path here instead means that renaming the product
 * — electron-builder's `productName`, or `package.json`'s `name` drifting away
 * from it — cannot silently move a user's session somewhere else. Dev and
 * packaged builds resolve to the same directory precisely because neither reads
 * the name.
 *
 * Historical note, because the directory used to be called `factorial-desktop-2`
 * and the reason still matters: an earlier Factorial client of Max's lives at
 * `~/Development/personal/factorial-desktop-old` and carries this same
 * `package.json` name. While both were in use they had to be kept apart, since
 * sharing this directory means sharing
 *
 * - the session partitions (two different login states in one cookie directory),
 * - `settings.json` and `window-position.json`,
 * - and the single-instance lock, which is keyed by this very directory — so
 *   starting one while the other ran made the newcomer quit on the spot and
 *   raise the *other* app's window instead.
 *
 * That client is retired, so this app now takes the plain name. Running the old
 * one again would reintroduce every one of those collisions.
 */

import { join } from 'node:path'

/** Ours, pinned rather than derived from the product name. */
export const USER_DATA_DIRECTORY = 'factorial-desktop'

/**
 * `appData` is the platform's roaming application directory —
 * `~/Library/Application Support` on macOS, `%APPDATA%` on Windows. Electron
 * resolves both; this only appends our own name to it.
 */
export function resolveUserDataPath(appData: string): string {
  return join(appData, USER_DATA_DIRECTORY)
}
