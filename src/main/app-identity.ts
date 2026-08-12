/**
 * Where this app keeps its state on disk, and why it insists on saying so.
 *
 * Electron derives `userData` from `app.getName()`, which comes from
 * `package.json`. A second Factorial client lives at
 * `~/Development/personal/factorial-desktop` — a separate, independent build of
 * the same idea — and its `package.json` carries the same `name`. In dev mode
 * both therefore resolved to `~/Library/Application Support/factorial-desktop`
 * and shared, without either one knowing:
 *
 * - the session partitions (two different login states in one cookie directory),
 * - `settings.json` and `window-position.json`,
 * - and the single-instance lock, which is keyed by this very directory — so
 *   starting one while the other ran made the newcomer quit on the spot and
 *   raise the *other* app's window instead.
 *
 * Packaged builds never collided: the two differ in `appId` and `productName`.
 * It was only ever `npm run dev` — which is where all the debugging happens.
 *
 * The path is pinned here rather than left to `app.getName()` so that renaming
 * the product, or electron-builder's `productName` differing from
 * `package.json`'s `name`, cannot silently move a user's session somewhere else.
 * Dev and packaged builds resolve to the same directory precisely because
 * neither reads the name.
 */

import { join } from 'node:path'

/** Sibling app to stay clear of; see the note above. */
export const FOREIGN_USER_DATA_DIRECTORY = 'factorial-desktop'

/** Ours. Deliberately not equal to `FOREIGN_USER_DATA_DIRECTORY`. */
export const USER_DATA_DIRECTORY = 'factorial-desktop-2'

/**
 * `appData` is the platform's roaming application directory —
 * `~/Library/Application Support` on macOS, `%APPDATA%` on Windows. Electron
 * resolves both; this only appends our own name to it.
 */
export function resolveUserDataPath(appData: string): string {
  return join(appData, USER_DATA_DIRECTORY)
}
