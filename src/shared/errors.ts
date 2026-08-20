/**
 * The one place an internal failure becomes a sentence a person can read.
 *
 * There is exactly one such place on purpose. The tray and the widget report the
 * same failures, and a second table would let them drift — the tray saying one
 * thing about a lost connection while the widget says another (`docs/DESIGN.md`).
 *
 * Every function here takes a `Translate`. Nothing in this file knows which
 * language it is producing, which is what keeps the wording in the catalogues
 * and the classification here.
 */

import type { Translate } from './i18n'
import { decodeActionError, type ActionErrorKind, type SnapshotErrorKind } from './ipc-contract'

/**
 * One key per kind. `graphql` gets the server's words appended; the rest
 * deliberately do not, because their internals are addressed to us.
 *
 * "Nothing was saved" is a promise this app can actually keep: there is no
 * offline queue and a failed mutation is never retried, so a rejected action
 * really did leave the time record alone.
 */
const ACTION_KEY = {
  unauthenticated: 'error.unauthenticated',
  graphql: 'error.graphql',
  network: 'error.network',
  malformed: 'error.malformed',
  unknown: 'error.unknown',
  busy: 'error.busy',
} as const satisfies Record<ActionErrorKind, string>

/**
 * The sentence for a failure that has already been classified.
 *
 * This is the entry point for the **main process**, where a rejected store call
 * arrives as the error object itself rather than as an encoded IPC message. The
 * renderer's `describeActionError` decodes first and then lands here, so both
 * paths read from the one table above.
 */
export function describeActionFailure(t: Translate, kind: ActionErrorKind, message: string): string {
  if (kind !== 'graphql') return t(ACTION_KEY[kind])

  const detail = message.trim()
  // Without a detail the framed sentence would end on a dangling colon.
  return detail === '' ? t('error.graphql') : t('error.graphqlDetail', { detail })
}

/**
 * The sentence for a rejected action that crossed IPC, ready for a toast.
 *
 * Tolerant of anything: a rejection that never went through the codec (a crash
 * in the preload, a thrown string) still has to produce a showable sentence
 * rather than throw a second time inside the error handler.
 */
export function describeActionError(t: Translate, error: unknown): string {
  const raw = error instanceof Error ? error.message : ''
  if (raw === '') return t('error.unknown')

  const { kind, message } = decodeActionError(raw)
  return describeActionFailure(t, kind, message)
}

/**
 * A setting that did not reach the disk.
 *
 * Deliberately not an `ActionErrorKind`: nothing was sent to Factorial and no
 * time record was touched — the file write failed, so the value simply did not
 * stick.
 */
export function describeSettingsWriteFailure(t: Translate): string {
  return t('error.settingsWrite')
}

/**
 * The short hint next to the status line while the snapshot is stale. Shaped as
 * a clause rather than a sentence because it is rendered after a separator dot.
 */
const STALE_KEY = {
  unauthenticated: 'stale.unauthenticated',
  graphql: 'stale.graphql',
  network: 'stale.network',
  malformed: 'stale.malformed',
  unknown: 'stale.unknown',
} as const satisfies Record<SnapshotErrorKind, string>

/**
 * `kind` can be `null` while `stale` is true only if a future refresh path
 * forgets to record one — the fallback keeps that from rendering an empty hint
 * that says nothing at all.
 */
export function describeStaleReason(t: Translate, kind: SnapshotErrorKind | null): string {
  return kind === null ? t('stale.generic') : t(STALE_KEY[kind])
}
