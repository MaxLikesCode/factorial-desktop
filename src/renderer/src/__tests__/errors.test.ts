/**
 * The renderer is the last place an internal English sentence can be stopped
 * before a user reads it. These tests pin that: every kind the main process can
 * produce has German words here, and the raw internals never leak through.
 */

import { describe, expect, it } from 'vitest'
import { encodeActionError } from '@shared/ipc-contract'
import { describeActionError, describeStaleReason } from '@renderer/lib/errors'

/** What `ipcRenderer.invoke` actually hands the renderer on a rejected handler. */
function asInvokeRejection(kind: Parameters<typeof encodeActionError>[0], message: string): Error {
  return new Error(
    `Error invoking remote method 'attendance:clockIn': Error: ${encodeActionError(kind, message)}`,
  )
}

describe('describeActionError', () => {
  it('turns the store’s in-flight refusal into German', () => {
    // `ACTION_IN_FLIGHT_MESSAGE` is deliberately English internally; the IPC
    // layer maps it to the kind `busy` and this is where it gets its words.
    const text = describeActionError(
      asInvokeRejection('busy', 'another action is already in flight'),
    )
    expect(text).toBe('Es läuft bereits eine Aktion. Bitte einen Moment warten.')
    expect(text).not.toContain('in flight')
  })

  it('turns a hung request into "keine Verbindung" instead of the timeout text', () => {
    const text = describeActionError(
      asInvokeRejection('network', 'request timed out after 15000 ms'),
    )
    expect(text).toBe('Keine Verbindung zu Factorial. Es wurde nichts gespeichert.')
    expect(text).not.toContain('timed out')
    expect(text).not.toContain('15000')
  })

  it('says the session expired when the cookie was rejected', () => {
    const text = describeActionError(asInvokeRejection('unauthenticated', 'session rejected (HTTP 401)'))
    expect(text).toBe('Die Sitzung ist abgelaufen. Bitte neu anmelden.')
    expect(text).not.toContain('HTTP 401')
  })

  it('keeps the server’s own wording for a rejected mutation, framed in German', () => {
    // DESIGN.md, "Fehlerbehandlung": a non-empty `errors[]` shows the server
    // message — it is the only thing that says *what* Factorial objected to.
    const text = describeActionError(asInvokeRejection('graphql', 'Shift overlaps an existing one'))
    expect(text).toBe('Factorial hat die Aktion abgelehnt: Shift overlaps an existing one')
  })

  it('drops the server wording when there is none rather than ending on a colon', () => {
    expect(describeActionError(asInvokeRejection('graphql', '   '))).toBe(
      'Factorial hat die Aktion abgelehnt.',
    )
  })

  it('has German for a malformed answer', () => {
    const text = describeActionError(
      asInvokeRejection('malformed', 'HTTP 200: expected JSON, got: <!doctype html>'),
    )
    expect(text).toBe('Unerwartete Antwort von Factorial. Es wurde nichts gespeichert.')
    expect(text).not.toContain('doctype')
  })

  it('falls back to German for an error that never went through the codec', () => {
    expect(describeActionError(new Error('preload blew up'))).toBe('Die Aktion ist fehlgeschlagen.')
  })

  it('survives a thrown non-Error', () => {
    expect(describeActionError('nope')).toBe('Die Aktion ist fehlgeschlagen.')
    expect(describeActionError(undefined)).toBe('Die Aktion ist fehlgeschlagen.')
  })
})

describe('describeStaleReason', () => {
  it('has one German phrase per snapshot error kind', () => {
    expect(describeStaleReason('network')).toBe('keine Verbindung')
    expect(describeStaleReason('unauthenticated')).toBe('Sitzung abgelaufen')
    expect(describeStaleReason('graphql')).toBe('Factorial meldet einen Fehler')
    expect(describeStaleReason('malformed')).toBe('unerwartete Antwort')
    expect(describeStaleReason('unknown')).toBe('Aktualisierung fehlgeschlagen')
  })

  it('still says something when the snapshot is stale without a recorded kind', () => {
    expect(describeStaleReason(null)).toBe('nicht aktuell')
  })
})
