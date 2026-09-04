/**
 * Schema introspection through the app's own signed-in session.
 *
 * `docs/api-discovery.md` describes doing this from a browser tab's console.
 * This is the same thing without the browser: start with
 *
 *   FACTORIAL_INTROSPECT=AttendanceMutations,AttendanceShift npm run dev
 *
 * and each named type's fields, with their arguments and types, are printed
 * to the terminal as JSON once the sign-in has succeeded. `schema` in the
 * list prints the root query and mutation fields instead of a type.
 *
 * Read-only by construction — it sends `__type` and `__schema` queries and
 * nothing else — and never active in a packaged build, whatever the
 * environment says. Off unless the variable is set, like `debug-net.ts`.
 */

import { app } from 'electron'
import type { GraphQLClient } from './factorial/client'

const FLAG = 'FACTORIAL_INTROSPECT'

/** Enough nesting to unwrap NON_NULL → LIST → NON_NULL → the named type. */
const TYPE_REF = `kind name ofType { kind name ofType { kind name ofType { kind name } } }`

/**
 * The fallback for when `__type` is switched off, which Factorial did at some
 * point after August 2026: a document that names candidate fields next to one
 * that certainly does not exist. GraphQL validates the whole document before
 * executing any of it, so the certain miss guarantees nothing runs — a
 * mutation included — and the error list names every field that was unknown.
 * Whatever is *not* in that list exists. graphql-ruby adds "Did you mean …?"
 * to each miss, which is how neighbouring names are found.
 *
 *   FACTORIAL_PROBE_MUTATIONS=updateAttendanceShift,deleteAttendanceShift
 *   FACTORIAL_PROBE_SHIFT_FIELDS=clockIn,clockOut,observations
 */
const PROBE_MUTATIONS = 'FACTORIAL_PROBE_MUTATIONS'
const PROBE_SHIFT_FIELDS = 'FACTORIAL_PROBE_SHIFT_FIELDS'
const PROBE_DOC = 'FACTORIAL_PROBE_DOC'
const CERTAIN_MISS = '__thisFieldCannotExist'

async function probe(
  client: GraphQLClient,
  label: string,
  query: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await client.execute<unknown>({ operationName: 'Probe', variables: {}, query })
    log(`[probe] ${label}: executed without a validation error — the sentinel failed, check the document`)
  } catch (error) {
    log(`[probe] ${label}\n${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function runIntrospection(
  client: GraphQLClient,
  log: (line: string) => void = console.log,
): Promise<void> {
  if (app.isPackaged) return

  const mutations = process.env[PROBE_MUTATIONS]
  if (mutations !== undefined && mutations.trim() !== '') {
    const fields = mutations.split(',').map((s) => s.trim()).filter((s) => s !== '')
    await probe(
      client,
      'mutations',
      `mutation Probe { attendanceMutations { ${fields.map((f) => `${f} { __typename }`).join(' ')} ${CERTAIN_MISS} } }`,
      log,
    )
  }
  const shiftFields = process.env[PROBE_SHIFT_FIELDS]
  if (shiftFields !== undefined && shiftFields.trim() !== '') {
    const fields = shiftFields.split(',').map((s) => s.trim()).filter((s) => s !== '')
    await probe(
      client,
      'shift fields',
      `query Probe { attendance { employee(id: 0) { attendanceShiftsConnection(startOn: "2026-01-01", endOn: "2026-01-01") { nodes { ${fields.join(' ')} ${CERTAIN_MISS} } } } } }`,
      log,
    )
  }

  // A raw document, for probes the two shapes above do not cover. It must
  // carry its own certain miss; nothing is added to it.
  const doc = process.env[PROBE_DOC]
  if (doc !== undefined && doc.trim() !== '') {
    if (!doc.includes(CERTAIN_MISS)) {
      log(`[probe] document refused: it does not contain ${CERTAIN_MISS}, so it could execute`)
    } else {
      await probe(client, 'document', doc, log)
    }
  }

  const value = process.env[FLAG]
  if (value === undefined || value.trim() === '') return

  for (const name of value.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    try {
      const data =
        name === 'schema'
          ? await client.execute<unknown>({
              operationName: 'IntrospectSchema',
              variables: {},
              query: `query IntrospectSchema {
                __schema {
                  queryType { fields { name } }
                  mutationType { fields { name } }
                }
              }`,
            })
          : await client.execute<unknown>({
              operationName: 'IntrospectType',
              variables: { name },
              query: `query IntrospectType($name: String!) {
                __type(name: $name) {
                  kind name
                  fields {
                    name
                    args { name type { ${TYPE_REF} } }
                    type { ${TYPE_REF} }
                  }
                  inputFields { name type { ${TYPE_REF} } }
                  enumValues { name }
                }
              }`,
            })
      log(`[introspect] ${name}\n${JSON.stringify(data)}`)
    } catch (error) {
      log(`[introspect] ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
