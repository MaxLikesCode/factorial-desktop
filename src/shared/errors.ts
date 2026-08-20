/**
 * Where the app's internals stop being English.
 *
 * Everything upstream of this file speaks in machine terms on purpose: the
 * GraphQL client throws `session rejected (HTTP 401)`, `session.ts` throws
 * `request timed out after 15000 ms`, and the store refuses a second click with
 * `another action is already in flight`. None of those sentences is for a user,
 * and every one of them could otherwise reach a toast or a tray menu —
 * German text for the user, never the server's own words.
 *
 * The kind, not the text, is what carries meaning: over IPC `encodeActionError`
 * packs it into the message (a custom `Error` property does not survive
 * `contextBridge`) and `decodeActionError` unpacks it again. So the German
 * phrasing below is keyed off `kind` and the original wording is dropped — with
 * exactly one exception, `graphql`, where the server's own message is the only
 * thing that says *what* Factorial objected to (DESIGN.md, "Fehlerbehandlung":
 * Toast mit der Server-Message).
 *
 * **This file lives in `src/shared` since Task 12** — it used to be
 * `src/renderer/src/lib/errors.ts`. The tray runs in the main process, shows the
 * same failures, and must not open a second translation table (`docs/DESIGN.md`
 * §6). `src/renderer/src/lib/errors.ts` is now a re-export so the renderer's
 * import path and its tests keep working.
 */

import { decodeActionError, type ActionErrorKind, type SnapshotErrorKind } from './ipc-contract'

/**
 * One sentence per kind. `graphql` gets the server's words appended; the rest
 * deliberately do not, because their internals are addressed to us.
 *
 * "Es wurde nichts gespeichert" is a promise this app can actually keep: there
 * is no offline queue and a failed mutation is never retried (DESIGN.md,
 * "Nicht-Ziele"), so a rejected action really did leave the time record alone.
 */
const ACTION_TEXT: Record<ActionErrorKind, string> = {
  unauthenticated: 'Die Sitzung ist abgelaufen. Bitte neu anmelden.',
  graphql: 'Factorial hat die Aktion abgelehnt.',
  network: 'Keine Verbindung zu Factorial. Es wurde nichts gespeichert.',
  malformed: 'Unerwartete Antwort von Factorial. Es wurde nichts gespeichert.',
  unknown: 'Die Aktion ist fehlgeschlagen.',
  busy: 'Es läuft bereits eine Aktion. Bitte einen Moment warten.',
}

/**
 * The German sentence for a failure that has already been classified.
 *
 * This is the entry point for the **main process**, where a rejected store call
 * arrives as the error object itself rather than as an encoded IPC message. The
 * renderer's `describeActionError` decodes first and then lands here, so both
 * paths read from the one table above.
 */
export function describeActionFailure(kind: ActionErrorKind, message: string): string {
  if (kind !== 'graphql') return ACTION_TEXT[kind]

  const detail = message.trim()
  // Without a detail the framed sentence would end on a dangling colon.
  return detail === '' ? ACTION_TEXT.graphql : `Factorial hat die Aktion abgelehnt: ${detail}`
}

/**
 * The German sentence for a rejected action that crossed IPC, ready for a toast.
 *
 * Tolerant of anything: a rejection that never went through the codec (a crash
 * in the preload, a thrown string) still has to produce a showable sentence
 * rather than throw a second time inside the error handler.
 */
export function describeActionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : ''
  if (raw === '') return ACTION_TEXT.unknown

  const { kind, message } = decodeActionError(raw)
  return describeActionFailure(kind, message)
}

/**
 * A setting that did not reach the disk.
 *
 * Deliberately not an `ActionErrorKind`: nothing was sent to Factorial and no
 * time record was touched — the file write failed, so the value simply did not
 * stick. It lives here rather than in the tray because this file is where the
 * app's internals stop being English, and there is to be one such place
 * (`docs/DESIGN.md`).
 */
export const SETTINGS_WRITE_FAILED = 'Einstellung konnte nicht gespeichert werden.'

/**
 * The short hint next to the status line while the snapshot is stale. Lower case
 * and clause-shaped because it is rendered after a separator dot, not as a
 * sentence of its own.
 */
const STALE_TEXT: Record<SnapshotErrorKind, string> = {
  unauthenticated: 'Sitzung abgelaufen',
  graphql: 'Factorial meldet einen Fehler',
  network: 'keine Verbindung',
  malformed: 'unerwartete Antwort',
  unknown: 'Aktualisierung fehlgeschlagen',
}

/**
 * `kind` can be `null` while `stale` is true only if a future refresh path
 * forgets to record one — the fallback keeps that from rendering an empty hint
 * that says nothing at all.
 */
export function describeStaleReason(kind: SnapshotErrorKind | null): string {
  return kind === null ? 'nicht aktuell' : STALE_TEXT[kind]
}
