/**
 * The only module that knows Factorial's attendance semantics: which documents
 * to send, which argument types the schema insists on, and how to read what
 * comes back. `client.ts` below it knows GraphQL-over-HTTP and nothing else;
 * everything above it sees plain application types.
 *
 * Two rules run through the whole file:
 *
 * 1. **The client's cast is unchecked.** `execute<T>` hands over `data` as `T`
 *    without looking at it, so every field read here is validated first. A
 *    surprise in the payload has to become a visible `malformed` error, never a
 *    silently wrong time.
 * 2. **A failure is never rendered as success.** The mutations report errors
 *    in-band with HTTP 200; a missing payload or a missing `errors` list is
 *    treated as "not confirmed", not as "fine".
 *
 * The verified corrections K1-K5 live here:
 *   K1 the four mutations take only `now` (plus their own optional arguments);
 *      `date`/`startOn`/`endOn` are connection arguments, not mutation ones.
 *   K2 `breakStartAttendanceShift` rejects `locationType`.
 *   K3 `systemCreated: Boolean!` is mandatory on both break mutations.
 *   K4 ids are `Int` in the schema, strings everywhere in this app.
 *   K5 `errors` is a union and needs inline fragments.
 */

import { toLocalIsoWithOffset } from '@shared/time'
import type { BreakConfiguration, OpenShift } from '@shared/attendance-state'
import { FactorialError, type GraphQLClient } from './client'
import { isEditRequestType } from '@shared/timesheet'
import type {
  BreakConfigOption,
  EditRequestRecord,
  EditRequestType,
  Identity,
  LeaveRecord,
  LocationType,
  MonthWorkedTime,
  MutationError,
  ShiftRecord,
  ShiftSummary,
} from './types'

/** Every record this app writes is tagged as coming from the desktop client. */
const SOURCE = 'desktop'

/** Shown when the server rejects something without saying what. */
const UNKNOWN_ERROR_TEXT = 'unbekannter Fehler'

/** Used when a StructuredError names messages but not the field they belong to. */
const UNKNOWN_FIELD_TEXT = 'Feld'

// --- response validation ----------------------------------------------------

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'nothing'
  if (Array.isArray(value)) return 'a list'
  if (typeof value === 'object') return 'an object'
  return `${typeof value} ${JSON.stringify(value)}`
}

function fail(path: string, expected: string, value: unknown): never {
  throw new FactorialError('malformed', `${path}: expected ${expected}, got ${describeValue(value)}`)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'an object', value)
  }
  return value as Record<string, unknown>
}

function asList(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'a list', value)
  return value
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'a non-empty string', value)
  return value
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null
  return asString(value, path)
}

function asInteger(value: unknown, path: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  // Ids cross IPC and React as strings; a digit string is still an Int.
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
  return fail(path, 'an integer', value)
}

function asNullableInteger(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null
  return asInteger(value, path)
}

/**
 * Ids leave this module as strings. Factorial sends `openShift.id` as a JSON
 * number and break configuration ids as numbers too, while the UI and the IPC
 * contract use strings throughout — the conversion happens here, once.
 */
function asNullableBoolean(value: unknown, path: string): boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'boolean') throw new FactorialError('malformed', `${path} is not a boolean`)
  return value
}

function asId(value: unknown, path: string): string {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  return fail(path, 'an id', value)
}

function field(value: unknown, path: string, key: string): unknown {
  return asRecord(value, path)[key]
}

/**
 * Every attendance query nests under `attendance.employee(id:)`.
 *
 * A null employee is *not* "clocked out": we asked for our own id, so an absent
 * record means the answer is unusable. Reporting it as being off the clock would
 * be a lie the user acts on.
 */
function attendanceEmployee(data: unknown, operation: string): Record<string, unknown> {
  const attendance = field(data, `${operation}.data`, 'attendance')
  const employee = field(attendance, `${operation}.data.attendance`, 'employee')
  if (employee === null || employee === undefined) {
    throw new FactorialError('malformed', `${operation}: attendance.employee was ${describeValue(employee)}`)
  }
  return asRecord(employee, `${operation}.data.attendance.employee`)
}

function connectionNodes(value: unknown, path: string): unknown[] {
  return asList(field(value, path, 'nodes'), `${path}.nodes`)
}

function parseBreakConfiguration(value: unknown, path: string): BreakConfiguration | null {
  if (value === null || value === undefined) return null
  const config = asRecord(value, path)
  return {
    id: asId(config.id, `${path}.id`),
    name: asNullableString(config.name, `${path}.name`),
  }
}

/**
 * `AttendanceOpenShift` is a different type from `AttendanceShift` (K7): no
 * `clockInWithSeconds`, no `minutes`. `clockInOffset` is mandatory here — the
 * clock-in time cannot be turned into an instant without it, and defaulting to
 * UTC would move the timer by hours.
 */
function parseOpenShift(value: unknown, path: string): OpenShift {
  const shift = asRecord(value, path)
  return {
    id: asId(shift.id, `${path}.id`),
    date: asString(shift.date, `${path}.date`),
    clockIn: asString(shift.clockIn, `${path}.clockIn`),
    clockInOffset: asString(shift.clockInOffset, `${path}.clockInOffset`),
    locationType: asNullableString(shift.locationType, `${path}.locationType`),
    workplaceId: asNullableInteger(shift.workplaceId, `${path}.workplaceId`),
    timeSettingsBreakConfiguration: parseBreakConfiguration(
      shift.timeSettingsBreakConfiguration,
      `${path}.timeSettingsBreakConfiguration`,
    ),
  }
}

// --- mutation errors --------------------------------------------------------

/** Tolerant on purpose: this runs on the failure path and must not lose it. */
function parseMutationError(value: unknown): MutationError {
  if (typeof value !== 'object' || value === null) return { kind: 'unknown', typename: UNKNOWN_ERROR_TEXT }
  const error = value as Record<string, unknown>
  const typename = typeof error.__typename === 'string' ? error.__typename : UNKNOWN_ERROR_TEXT

  if (typename === 'SimpleError') {
    return {
      kind: 'simple',
      typename,
      message: typeof error.message === 'string' ? error.message : null,
      type: typeof error.type === 'string' ? error.type : null,
    }
  }
  if (typename === 'StructuredError') {
    const messages = Array.isArray(error.messages)
      ? error.messages.filter((message): message is string => typeof message === 'string')
      : []
    return {
      kind: 'structured',
      typename,
      field: typeof error.field === 'string' ? error.field : null,
      messages,
    }
  }
  return { kind: 'unknown', typename }
}

/**
 * The buckets Rails uses for an error that belongs to the record as a whole
 * rather than to one of its attributes. Naming them in the toast reads as a
 * field called "messages", which is worse than saying nothing.
 */
const RECORD_LEVEL_FIELDS = new Set(['base', 'messages'])

/** Both union members flattened into one readable line for the toast. */
function describeMutationError(error: MutationError): string {
  switch (error.kind) {
    case 'simple':
      return error.message ?? UNKNOWN_ERROR_TEXT
    case 'structured': {
      const joined = error.messages.join(', ')
      if (error.field !== null && RECORD_LEVEL_FIELDS.has(error.field)) {
        return joined === '' ? UNKNOWN_ERROR_TEXT : joined
      }
      const name = error.field ?? UNKNOWN_FIELD_TEXT
      return error.messages.length > 0 ? `${name}: ${joined}` : `${name}: ungültig`
    }
    case 'unknown':
      return error.typename
  }
}

/**
 * Every mutation reports failure in-band via `errors`, with HTTP 200. Success is
 * exactly one thing: the payload exists and its `errors` list is empty. Anything
 * else — no payload, no list — means the write was never confirmed.
 */
function assertMutationSucceeded(data: unknown, operation: string, mutationField: string): void {
  const mutations = field(data, `${operation}.data`, 'attendanceMutations')
  const payload = field(mutations, `${operation}.data.attendanceMutations`, mutationField)
  if (payload === null || payload === undefined) {
    throw new FactorialError(
      'malformed',
      `${operation}: ${mutationField} returned ${describeValue(payload)}, so the write is unconfirmed`,
    )
  }

  const path = `${operation}.data.attendanceMutations.${mutationField}`
  const errors = asList(field(payload, path, 'errors'), `${path}.errors`)
  if (errors.length > 0) {
    throw new FactorialError('graphql', errors.map((e) => describeMutationError(parseMutationError(e))).join('; '))
  }
}

// --- documents --------------------------------------------------------------

const OPEN_SHIFT_FIELDS = `
    id
    date
    clockIn
    clockInOffset
    locationType
    workplaceId
    timeSettingsBreakConfiguration { id name }
`

/**
 * K5: `errors` is `[MutationError!]!`, a union. A bare `errors { message }` is a
 * syntax error the server rejects before it ever looks at the mutation.
 */
const MUTATION_RESULT = `
      errors {
        __typename
        ... on SimpleError { message type }
        ... on StructuredError { field messages }
      }
`

const LEAVE_FIELDS = `
                id approved startOn finishOn halfDay durationAttributes
                leaveType { id color translatedName }
`

/**
 * One `TimeoffLeave`. `durationAttributes` is a JSON *string* holding, among
 * other things, the working days per year the leave covers —
 * `{"workable_units":{"days":{"2026":2.0}}}` — and is the only place the day
 * count lives. It is read tolerantly: a card that says "Urlaub 19.–20. Nov"
 * without "2 Tage" is still right, a card that failed to load is not.
 */
function parseLeave(value: unknown, path: string): LeaveRecord {
  const leave = asRecord(value, path)
  const type = asRecord(leave.leaveType, `${path}.leaveType`)
  return {
    id: asId(leave.id, `${path}.id`),
    approved: asNullableBoolean(leave.approved, `${path}.approved`),
    startOn: asString(leave.startOn, `${path}.startOn`),
    finishOn: asString(leave.finishOn, `${path}.finishOn`),
    name: asString(type.translatedName, `${path}.leaveType.translatedName`),
    color: asNullableString(type.color, `${path}.leaveType.color`),
    days: leaveDays(leave.durationAttributes),
  }
}

function leaveDays(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const units = asRecord(asRecord(parsed, 'durationAttributes').workable_units, 'workable_units')
    const days = asRecord(units.days, 'days')
    let total = 0
    for (const amount of Object.values(days)) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return null
      total += amount
    }
    return total
  } catch {
    return null
  }
}

// --- operations -------------------------------------------------------------

export function createOperations(client: GraphQLClient) {
  /**
   * The only variable shared by all four mutations (K1). `date`, `startOn` and
   * `endOn` are not mutation arguments — they belong to the connections below.
   * Sending them brings the mutation down with `undefinedArgument`, and does it
   * with HTTP 200, so it is easy to miss.
   */
  function nowVar(now: Date): { now: string; source: string } {
    return { now: toLocalIsoWithOffset(now), source: SOURCE }
  }

  return {
    /** Doubles as the session check: if this succeeds, the cookie is still good. */
    async fetchMe(): Promise<Identity> {
      const data = await client.execute<unknown>({
        operationName: 'Me',
        variables: {},
        query: `query Me {
          apiCore { currentsConnection { nodes {
            email
            employee { id fullName }
            company { id name }
          } } }
        }`,
      })

      const apiCore = field(data, 'Me.data', 'apiCore')
      const nodes = connectionNodes(
        field(apiCore, 'Me.data.apiCore', 'currentsConnection'),
        'Me.data.apiCore.currentsConnection',
      )
      const node = nodes[0]
      if (node === undefined) {
        throw new FactorialError('malformed', 'Me: no current user in response')
      }

      const path = 'Me.data.apiCore.currentsConnection.nodes[0]'
      const employee = field(node, path, 'employee')
      const company = field(node, path, 'company')
      if (!employee || !company) {
        throw new FactorialError('malformed', 'Me: no current user with an employee and a company')
      }

      return {
        email: asString(field(node, path, 'email'), `${path}.email`),
        // Int on the wire and Int on the way back in — never stringified.
        employeeId: asInteger(field(employee, `${path}.employee`, 'id'), `${path}.employee.id`),
        fullName: asString(field(employee, `${path}.employee`, 'fullName'), `${path}.employee.fullName`),
        companyId: asInteger(field(company, `${path}.company`, 'id'), `${path}.company.id`),
        companyName: asString(field(company, `${path}.company`, 'name'), `${path}.company.name`),
      }
    },

    /** `null` means clocked out — the one authoritative answer to that question. */
    async fetchOpenShift(employeeId: number): Promise<OpenShift | null> {
      const data = await client.execute<unknown>({
        operationName: 'OpenShift',
        // The schema demands Int! here, while the mutations take other types.
        variables: { id: employeeId },
        query: `query OpenShift($id: Int!) {
          attendance { employee(id: $id) { openShift {${OPEN_SHIFT_FIELDS}          } } }
        }`,
      })

      const employee = attendanceEmployee(data, 'OpenShift')
      const openShift = employee.openShift
      if (openShift === null || openShift === undefined) return null
      return parseOpenShift(openShift, 'OpenShift.data.attendance.employee.openShift')
    },

    /**
     * All of the day's closed shifts. A break splits one working day into
     * several records (verified: in → break → resume → out produced three), so
     * the day's total is the sum over these plus the running shift — never the
     * delta of a single record.
     */
    async fetchTodayShifts(employeeId: number, date: string): Promise<ShiftSummary[]> {
      const data = await client.execute<unknown>({
        operationName: 'TodayShifts',
        // startOn/endOn are correct HERE: they are connection arguments (K1).
        variables: { id: employeeId, startOn: date, endOn: date },
        query: `query TodayShifts($id: Int!, $startOn: ISO8601Date!, $endOn: ISO8601Date!) {
          attendance { employee(id: $id) {
            attendanceShiftsConnection(startOn: $startOn, endOn: $endOn) {
              nodes {
                id date minutes workable clockInWithSeconds clockInOffset
                timeSettingsBreakConfiguration { id name }
              }
            }
          } }
        }`,
      })

      const employee = attendanceEmployee(data, 'TodayShifts')
      const base = 'TodayShifts.data.attendance.employee.attendanceShiftsConnection'
      return connectionNodes(employee.attendanceShiftsConnection, base).map((node, index) => {
        const path = `${base}.nodes[${index}]`
        return {
          id: asId(field(node, path, 'id'), `${path}.id`),
          date: asString(field(node, path, 'date'), `${path}.date`),
          minutes: asNullableInteger(field(node, path, 'minutes'), `${path}.minutes`),
          // Both signals for "is this a break", because a break is a shift
          // record like any other and the day's total must not count it.
          workable: asNullableBoolean(field(node, path, 'workable'), `${path}.workable`),
          breakConfiguration: parseBreakConfiguration(
            field(node, path, 'timeSettingsBreakConfiguration'),
            `${path}.timeSettingsBreakConfiguration`,
          ),
          // Only ever used to order the day; a record's length always comes from
          // `minutes`, so neither of these is worth failing a refresh over.
          clockInWithSeconds: asNullableString(
            field(node, path, 'clockInWithSeconds'),
            `${path}.clockInWithSeconds`,
          ),
          clockInOffset: asNullableString(
            field(node, path, 'clockInOffset'),
            `${path}.clockInOffset`,
          ),
        }
      })
    },

    /**
     * The day's target, for the progress ring (K8).
     *
     * Two traps sit in the very same node:
     *   - `contractMinutes` is NOT the target. It read 720 while the day's target
     *     was 480.
     *   - this query's own `minutes` is NOT the time worked. It read 480 with
     *     zero minutes actually worked. Worked time stays the sum over
     *     `shift.minutes` plus the running shift.
     *
     * On a day off the connection comes back empty, or `expectedMinutes` is 0 —
     * then there is no target and the ring shows plain elapsed time.
     */
    async fetchExpectedMinutes(employeeId: number, date: string): Promise<number | null> {
      const data = await client.execute<unknown>({
        operationName: 'EstimatedTime',
        // startOn/endOn are correct HERE: they are connection arguments (K1).
        variables: { id: employeeId, startOn: date, endOn: date },
        query: `query EstimatedTime($id: Int!, $startOn: ISO8601Date!, $endOn: ISO8601Date!) {
          attendance { employee(id: $id) {
            attendanceEstimatedTimesConnection(startOn: $startOn, endOn: $endOn) {
              nodes { date expectedMinutes minutes regularMinutes
                      overtimeMinutes absencesMinutes contractMinutes source }
            }
          } }
        }`,
      })

      const employee = attendanceEmployee(data, 'EstimatedTime')
      const base = 'EstimatedTime.data.attendance.employee.attendanceEstimatedTimesConnection'
      const node = connectionNodes(employee.attendanceEstimatedTimesConnection, base)[0]
      if (node === undefined) return null
      return asNullableInteger(field(node, `${base}.nodes[0]`, 'expectedMinutes'), `${base}.nodes[0].expectedMinutes`)
    },

    /**
     * The break types for the menu. Must come from `timeSettings`:
     * `attendance.breakConfigurationsConnection` exists as well but returns
     * different ids and `name: null` for every entry.
     */
    /**
     * Only the break types that are still in use.
     *
     * Factorial keeps retired configurations and serves them alongside the live
     * ones, distinguished by `archived` and nothing else — the names repeat.
     * Observed on the real account: two "Verdienstausfall" and two "Arztbesuch",
     * where the archived pair is `paid: false` and the current pair `paid: true`.
     * Offering both is not merely an ugly menu with a duplicate in it: picking
     * the wrong one books the break against a retired configuration with the
     * wrong paid flag, in a real HR record.
     *
     * Filtered twice on purpose. `active: true` does the work server-side, and
     * `archived` is read back and checked here as well. Belt and braces is
     * justified by the cost of being wrong: if that argument ever changes
     * meaning, the second filter still holds the line.
     *
     * `active: false` is **not** "only the archived ones" — it means "do not
     * filter" and returns the lot. Do not use it to inspect archived entries.
     */
    async fetchBreakConfigurations(): Promise<BreakConfigOption[]> {
      const data = await client.execute<unknown>({
        operationName: 'BreakConfigurations',
        variables: {},
        query: `query BreakConfigurations {
          timeSettings {
            breakConfigurationsConnection(active: true) { nodes { id name archived } }
          }
        }`,
      })

      const timeSettings = field(data, 'BreakConfigurations.data', 'timeSettings')
      const base = 'BreakConfigurations.data.timeSettings.breakConfigurationsConnection'
      const nodes = connectionNodes(
        field(timeSettings, 'BreakConfigurations.data.timeSettings', 'breakConfigurationsConnection'),
        base,
      )

      const options: BreakConfigOption[] = []
      nodes.forEach((node, index) => {
        const path = `${base}.nodes[${index}]`
        const name = asNullableString(field(node, path, 'name'), `${path}.name`)?.trim()
        // A nameless entry would render as a blank row in the break menu.
        if (!name) return
        // The second half of the filter described above. Anything but an
        // explicit `false` is treated as archived: a missing or malformed flag
        // must not let a retired configuration through.
        if (field(node, path, 'archived') !== false) return
        options.push({ id: asId(field(node, path, 'id'), `${path}.id`), name })
      })
      return options
    },

    /**
     * Every record in a date range, both ends included — the timesheet editor's
     * read. Same connection as `fetchTodayShifts`, more fields, any range.
     */
    async fetchShifts(employeeId: number, startOn: string, endOn: string): Promise<ShiftRecord[]> {
      const data = await client.execute<unknown>({
        operationName: 'Shifts',
        variables: { id: employeeId, startOn, endOn },
        query: `query Shifts($id: Int!, $startOn: ISO8601Date!, $endOn: ISO8601Date!) {
          attendance { employee(id: $id) {
            attendanceShiftsConnection(startOn: $startOn, endOn: $endOn) {
              nodes {
                id date minutes workable clockIn clockOut clockInWithSeconds clockInOffset clockOutOffset
                locationType workplaceId
                timeSettingsBreakConfiguration { id name }
              }
            }
          } }
        }`,
      })

      const employee = attendanceEmployee(data, 'Shifts')
      const base = 'Shifts.data.attendance.employee.attendanceShiftsConnection'
      return connectionNodes(employee.attendanceShiftsConnection, base).map((node, index) => {
        const path = `${base}.nodes[${index}]`
        return {
          id: asId(field(node, path, 'id'), `${path}.id`),
          date: asString(field(node, path, 'date'), `${path}.date`),
          minutes: asNullableInteger(field(node, path, 'minutes'), `${path}.minutes`),
          workable: asNullableBoolean(field(node, path, 'workable'), `${path}.workable`),
          breakConfiguration: parseBreakConfiguration(
            field(node, path, 'timeSettingsBreakConfiguration'),
            `${path}.timeSettingsBreakConfiguration`,
          ),
          clockIn: asNullableString(field(node, path, 'clockIn'), `${path}.clockIn`),
          clockOut: asNullableString(field(node, path, 'clockOut'), `${path}.clockOut`),
          clockInWithSeconds: asNullableString(
            field(node, path, 'clockInWithSeconds'),
            `${path}.clockInWithSeconds`,
          ),
          clockInOffset: asNullableString(field(node, path, 'clockInOffset'), `${path}.clockInOffset`),
          clockOutOffset: asNullableString(field(node, path, 'clockOutOffset'), `${path}.clockOutOffset`),
          locationType: asNullableString(field(node, path, 'locationType'), `${path}.locationType`),
          workplaceId: asNullableInteger(field(node, path, 'workplaceId'), `${path}.workplaceId`),
        }
      })
    },

    /** The target per day over a range, keyed by date. Days the API omits are absent. */
    async fetchExpectedMinutesByDay(
      employeeId: number,
      startOn: string,
      endOn: string,
    ): Promise<Map<string, number | null>> {
      const data = await client.execute<unknown>({
        operationName: 'EstimatedTimes',
        variables: { id: employeeId, startOn, endOn },
        query: `query EstimatedTimes($id: Int!, $startOn: ISO8601Date!, $endOn: ISO8601Date!) {
          attendance { employee(id: $id) {
            attendanceEstimatedTimesConnection(startOn: $startOn, endOn: $endOn) {
              nodes { date expectedMinutes }
            }
          } }
        }`,
      })
      const employee = attendanceEmployee(data, 'EstimatedTimes')
      const base = 'EstimatedTimes.data.attendance.employee.attendanceEstimatedTimesConnection'
      const out = new Map<string, number | null>()
      connectionNodes(employee.attendanceEstimatedTimesConnection, base).forEach((node, index) => {
        const path = `${base}.nodes[${index}]`
        out.set(
          asString(field(node, path, 'date'), `${path}.date`),
          asNullableInteger(field(node, path, 'expectedMinutes'), `${path}.expectedMinutes`),
        )
      })
      return out
    },

    /**
     * Absences from a day on, approved and still-pending alike — the profile
     * page's "Abwesenheiten" card (docs/api-discovery.md, "The profile
     * widgets"). Two reads because the connection answers one question at a
     * time: `approved: true` returns approved leaves only, `includePending:
     * true` returns pending ones only, and neither returns the other's. Merged
     * by id and ordered by start, at most `first` of each.
     *
     * `employeeIds` is `[Int]` on the server; the web app's bundle declares
     * `ID`, which is the same mismatch as everywhere else (K4).
     */
    async fetchUpcomingLeaves(employeeId: number, from: string, first = 5): Promise<LeaveRecord[]> {
      const data = await client.execute<unknown>({
        operationName: 'UpcomingLeaves',
        variables: { employeeId, from, first },
        query: `query UpcomingLeaves($employeeId: Int!, $from: ISO8601Date!, $first: Int!) {
          timeoff {
            approved: leavesConnection(approved: true, employeeIds: [$employeeId], first: $first, from: $from,
                                       includeDuration: true, sortOrder: {field: "start_on", order: "asc"}) {
              nodes {${LEAVE_FIELDS}              }
            }
            pending: leavesConnection(employeeIds: [$employeeId], first: $first, from: $from,
                                      includeDuration: true, includePending: true,
                                      sortOrder: {field: "start_on", order: "asc"}) {
              nodes {${LEAVE_FIELDS}              }
            }
          }
        }`,
      })

      const timeoff = field(data, 'UpcomingLeaves.data', 'timeoff')
      const byId = new Map<string, LeaveRecord>()
      for (const list of ['approved', 'pending'] as const) {
        const base = `UpcomingLeaves.data.timeoff.${list}`
        connectionNodes(field(timeoff, 'UpcomingLeaves.data.timeoff', list), base).forEach((node, index) => {
          const leave = parseLeave(node, `${base}.nodes[${index}]`)
          if (!byId.has(leave.id)) byId.set(leave.id, leave)
        })
      }
      return [...byId.values()].sort((a, b) => a.startOn.localeCompare(b.startOn))
    },

    /**
     * Factorial's own sum of a range's worked minutes, plus how many days in it
     * it flags as inconsistent — the profile page's "Stundenzettel" card. The
     * sum is `attendanceAggregatedWorkedTime.minutes`; verified on 2026-09-05
     * to match the web app's "30h 56m" for the month to date.
     *
     * The inconsistency count is decoration: a malformed answer there is
     * `null`, not a failed card.
     */
    async fetchMonthWorkedTime(employeeId: number, startOn: string, endOn: string): Promise<MonthWorkedTime> {
      const data = await client.execute<unknown>({
        operationName: 'MonthWorkedTime',
        variables: { id: employeeId, startOn, endOn },
        query: `query MonthWorkedTime($id: Int!, $startOn: ISO8601Date!, $endOn: ISO8601Date!) {
          attendance { employee(id: $id) {
            attendanceAggregatedWorkedTime(startOn: $startOn, endOn: $endOn) { id minutes trackedMinutes }
          } }
          timeInsights {
            inconsistenciesConnection(employeeIds: [$id], startOn: $startOn, endOn: $endOn, state: pending) { totalCount }
          }
        }`,
      })

      const employee = attendanceEmployee(data, 'MonthWorkedTime')
      const aggregated = employee.attendanceAggregatedWorkedTime
      const base = 'MonthWorkedTime.data.attendance.employee.attendanceAggregatedWorkedTime'
      // No record in the range at all comes back as null; that is zero minutes.
      const minutes =
        aggregated === null || aggregated === undefined ? 0 : asInteger(field(aggregated, base, 'minutes'), `${base}.minutes`)

      let pendingInconsistencies: number | null = null
      try {
        const insights = field(data, 'MonthWorkedTime.data', 'timeInsights')
        const connection = field(insights, 'MonthWorkedTime.data.timeInsights', 'inconsistenciesConnection')
        pendingInconsistencies = asInteger(
          field(connection, 'MonthWorkedTime.data.timeInsights.inconsistenciesConnection', 'totalCount'),
          'MonthWorkedTime.data.timeInsights.inconsistenciesConnection.totalCount',
        )
      } catch {
        pendingInconsistencies = null
      }
      return { minutes, pendingInconsistencies }
    },

    /**
     * The next three write attendance shifts directly, which is the *manager's*
     * side of the timesheet: an ordinary account is refused by all of them with
     * *"Schichten können ohne entsprechende Berechtigung weder erstellt,
     * bearbeitet noch gelöscht werden"*. Nothing in this app calls them — the
     * editor goes through `requestTimesheetEdit` below — and they are kept
     * because they are the verified shape of that side of the API, for an
     * account that does hold the permission.
     *
     * A record with both ends. Found by validation-error probing on 2026-09-04
     * (docs/api-discovery.md): `date` is the one required argument;
     * `workable: false` plus the break type is what makes the record a break.
     */
    async createShift(input: {
      date: string
      clockIn: Date
      clockOut: Date
      workable: boolean
      breakConfigurationId: string | null
      locationType: LocationType | null
    }): Promise<void> {
      const variables: Record<string, unknown> = {
        date: input.date,
        clockIn: toLocalIsoWithOffset(input.clockIn),
        clockOut: toLocalIsoWithOffset(input.clockOut),
        workable: input.workable,
        source: SOURCE,
      }
      if (input.breakConfigurationId !== null) {
        variables.timeSettingsBreakConfigurationId = asInteger(
          input.breakConfigurationId,
          'breakConfigurationId',
        )
      }
      if (input.locationType !== null) variables.locationType = input.locationType
      const data = await client.execute<unknown>({
        operationName: 'CreateShift',
        variables,
        query: `mutation CreateShift($date: ISO8601Date!, $clockIn: ISO8601DateTime, $clockOut: ISO8601DateTime,
                                     $workable: Boolean, $timeSettingsBreakConfigurationId: Int,
                                     $locationType: AttendanceShiftLocationTypeEnum,
                                     $source: AttendanceEnumsShiftSourceEnum) {
          attendanceMutations {
            createAttendanceShift(date: $date, clockIn: $clockIn, clockOut: $clockOut, workable: $workable,
                                  timeSettingsBreakConfigurationId: $timeSettingsBreakConfigurationId,
                                  locationType: $locationType, source: $source) {${MUTATION_RESULT}            }
          }
        }`,
      })
      assertMutationSucceeded(data, 'CreateShift', 'createAttendanceShift')
    },

    /** Moves one record's ends. `workable` cannot be changed this way (see the probe). */
    async updateShift(input: { id: string; clockIn: Date; clockOut: Date }): Promise<void> {
      const data = await client.execute<unknown>({
        operationName: 'UpdateShift',
        variables: {
          id: asInteger(input.id, 'shift id'),
          clockIn: toLocalIsoWithOffset(input.clockIn),
          clockOut: toLocalIsoWithOffset(input.clockOut),
        },
        query: `mutation UpdateShift($id: Int!, $clockIn: ISO8601DateTime, $clockOut: ISO8601DateTime) {
          attendanceMutations {
            updateAttendanceShift(id: $id, clockIn: $clockIn, clockOut: $clockOut) {${MUTATION_RESULT}            }
          }
        }`,
      })
      assertMutationSucceeded(data, 'UpdateShift', 'updateAttendanceShift')
    },

    async deleteShift(input: { id: string }): Promise<void> {
      const data = await client.execute<unknown>({
        operationName: 'DeleteShift',
        variables: { id: asInteger(input.id, 'shift id') },
        query: `mutation DeleteShift($id: Int!) {
          attendanceMutations {
            deleteAttendanceShift(id: $id) {${MUTATION_RESULT}            }
          }
        }`,
      })
      assertMutationSucceeded(data, 'DeleteShift', 'deleteAttendanceShift')
    },

    /**
     * What an employee may actually write (2026-09-05, docs/api-discovery.md).
     *
     * The three mutations above are the manager's side of the timesheet. An
     * ordinary account is refused by all of them — *"Schichten können ohne
     * entsprechende Berechtigung weder erstellt, bearbeitet noch gelöscht
     * werden"* — and Factorial's own web interface does not use them either: it
     * opens "Änderungen beantragen" and sends this instead. One request per
     * changed record; somebody with the permission then approves it.
     *
     * One thing differs from every other mutation in this file:
     * **`clockIn`/`clockOut` are `String`, not `ISO8601DateTime`**, and the date
     * travels beside them in its own argument. They are times of day — `18:08` —
     * not instants. Verified against the live API on 2026-09-05, which accepted
     * exactly this document and answered with a pending request.
     *
     * The ids are `Int` like everywhere else (K4). The web app's own bundle
     * declares them `ID`, which is wrong and would be rejected with
     * `variableMismatch` — do not copy the client's types, ask the server.
     */
    async requestTimesheetEdit(input: {
      employeeId: number
      requestType: EditRequestType
      /** The record to change. Null only for `create_shift`, which has none yet. */
      shiftId: string | null
      date: string
      /** `HH:MM`. Null for `delete_shift`, which changes no times. */
      clockIn: string | null
      clockOut: string | null
      workable: boolean | null
      breakConfigurationId: string | null
      locationType: LocationType | null
    }): Promise<void> {
      // Only what this request is actually about is sent. An explicit null on an
      // argument the change does not concern is a different request from leaving
      // it out, and this mutation has fifteen of them.
      const variables: Record<string, unknown> = {
        employeeId: input.employeeId,
        requestType: input.requestType,
        date: input.date,
      }
      if (input.shiftId !== null) variables.attendanceShiftId = asInteger(input.shiftId, 'shift id')
      if (input.clockIn !== null) variables.clockIn = input.clockIn
      if (input.clockOut !== null) variables.clockOut = input.clockOut
      if (input.workable !== null) variables.workable = input.workable
      if (input.breakConfigurationId !== null) {
        variables.timeSettingsBreakConfigurationId = asInteger(
          input.breakConfigurationId,
          'breakConfigurationId',
        )
      }
      if (input.locationType !== null) variables.locationType = input.locationType

      const data = await client.execute<unknown>({
        operationName: 'RequestTimesheetEdit',
        variables,
        query: `mutation RequestTimesheetEdit($employeeId: Int!,
                                              $requestType: AttendanceEditTimesheetRequestRequestTypeEnum!,
                                              $attendanceShiftId: Int, $clockIn: String, $clockOut: String,
                                              $date: ISO8601Date, $workable: Boolean,
                                              $timeSettingsBreakConfigurationId: Int,
                                              $locationType: AttendanceShiftLocationTypeEnum) {
          attendanceMutations {
            createAttendanceEditTimesheetRequest(employeeId: $employeeId, requestType: $requestType,
                                                 attendanceShiftId: $attendanceShiftId,
                                                 clockIn: $clockIn, clockOut: $clockOut, date: $date,
                                                 workable: $workable,
                                                 timeSettingsBreakConfigurationId: $timeSettingsBreakConfigurationId,
                                                 locationType: $locationType) {
              editTimesheetRequest { id approved requestType }
${MUTATION_RESULT}            }
          }
        }`,
      })
      assertMutationSucceeded(data, 'RequestTimesheetEdit', 'createAttendanceEditTimesheetRequest')
    },

    /**
     * Every change request in a date range, answered or not. Read from the
     * employee's own connection rather than `AttendanceShift.editTimesheetRequest`,
     * because a `create_shift` request has no shift to hang off. Verified on
     * 2026-09-05 against a day with one applied and two pending requests.
     */
    async fetchEditRequests(employeeId: number, startOn: string, endOn: string): Promise<EditRequestRecord[]> {
      const data = await client.execute<unknown>({
        operationName: 'EditRequests',
        variables: { id: employeeId, startOn, endOn },
        query: `query EditRequests($id: Int!, $startOn: ISO8601Date!, $endOn: ISO8601Date!) {
          attendance { employee(id: $id) {
            attendanceEditTimesheetRequestsConnection(startOn: $startOn, endOn: $endOn) {
              nodes {
                id approved requestType date clockIn clockOut workable
                timeSettingsBreakConfigurationId
                attendanceShift { id }
              }
            }
          } }
        }`,
      })

      const employee = attendanceEmployee(data, 'EditRequests')
      const base = 'EditRequests.data.attendance.employee.attendanceEditTimesheetRequestsConnection'
      return connectionNodes(employee.attendanceEditTimesheetRequestsConnection, base).map((node, index) => {
        const path = `${base}.nodes[${index}]`
        const requestType = asString(field(node, path, 'requestType'), `${path}.requestType`)
        if (!isEditRequestType(requestType)) fail(`${path}.requestType`, 'a known request type', requestType)
        const shift = field(node, path, 'attendanceShift')
        const breakId = field(node, path, 'timeSettingsBreakConfigurationId')
        return {
          id: asId(field(node, path, 'id'), `${path}.id`),
          approved: asNullableBoolean(field(node, path, 'approved'), `${path}.approved`),
          requestType,
          date: asString(field(node, path, 'date'), `${path}.date`),
          shiftId: shift === null || shift === undefined ? null : asId(field(shift, `${path}.attendanceShift`, 'id'), `${path}.attendanceShift.id`),
          clockIn: asNullableString(field(node, path, 'clockIn'), `${path}.clockIn`),
          clockOut: asNullableString(field(node, path, 'clockOut'), `${path}.clockOut`),
          workable: asNullableBoolean(field(node, path, 'workable'), `${path}.workable`),
          breakConfigurationId: breakId === null || breakId === undefined ? null : asId(breakId, `${path}.timeSettingsBreakConfigurationId`),
        }
      })
    },

    /** Takes a pending request back. `id: Int!` is its only argument (probe, 2026-09-05). */
    async withdrawTimesheetEdit(input: { id: string }): Promise<void> {
      const data = await client.execute<unknown>({
        operationName: 'WithdrawTimesheetEdit',
        variables: { id: asInteger(input.id, 'request id') },
        query: `mutation WithdrawTimesheetEdit($id: Int!) {
          attendanceMutations {
            deleteAttendanceEditTimesheetRequest(id: $id) {${MUTATION_RESULT}            }
          }
        }`,
      })
      assertMutationSucceeded(data, 'WithdrawTimesheetEdit', 'deleteAttendanceEditTimesheetRequest')
    },

    async clockIn(input: { now: Date; locationType: LocationType; workplaceId: number | null }): Promise<void> {
      const variables: Record<string, unknown> = {
        ...nowVar(input.now),
        locationType: input.locationType,
      }
      // The verified call passed no workplaceId at all. An explicit null is a
      // different request and an untested one, so the key is left out instead.
      if (input.workplaceId !== null) variables.workplaceId = input.workplaceId

      const data = await client.execute<unknown>({
        operationName: 'ClockIn',
        variables,
        // workplaceId is Int (K4). Verified call:
        //   clockInAttendanceShift(now: $now, source: desktop, locationType: office)
        query: `mutation ClockIn($now: ISO8601DateTime!, $locationType: AttendanceShiftLocationTypeEnum,
                                 $source: AttendanceEnumsShiftSourceEnum, $workplaceId: Int) {
          attendanceMutations {
            clockInAttendanceShift(now: $now, locationType: $locationType,
                                   source: $source, workplaceId: $workplaceId) {${MUTATION_RESULT}            }
          }
        }`,
      })
      assertMutationSucceeded(data, 'ClockIn', 'clockInAttendanceShift')
    },

    async breakStart(input: { now: Date; breakConfigurationId: string }): Promise<void> {
      // Converted before the request goes out: a NaN in a time record is worse
      // than a failed click.
      const breakConfigurationId = asInteger(input.breakConfigurationId, 'breakConfigurationId')

      const data = await client.execute<unknown>({
        operationName: 'BreakStart',
        variables: { ...nowVar(input.now), timeSettingsBreakConfigurationId: breakConfigurationId },
        // No locationType here (K2) — this mutation rejects it with
        // undefinedArgument. systemCreated is Boolean! and mandatory (K3).
        query: `mutation BreakStart($now: ISO8601DateTime!, $source: AttendanceEnumsShiftSourceEnum,
                                    $timeSettingsBreakConfigurationId: Int) {
          attendanceMutations {
            breakStartAttendanceShift(now: $now, source: $source, systemCreated: false,
              timeSettingsBreakConfigurationId: $timeSettingsBreakConfigurationId) {${MUTATION_RESULT}            }
          }
        }`,
      })
      assertMutationSucceeded(data, 'BreakStart', 'breakStartAttendanceShift')
    },

    async breakEnd(input: { now: Date }): Promise<void> {
      const data = await client.execute<unknown>({
        operationName: 'BreakEnd',
        variables: nowVar(input.now),
        // systemCreated is mandatory here too (K3).
        query: `mutation BreakEnd($now: ISO8601DateTime!, $source: AttendanceEnumsShiftSourceEnum) {
          attendanceMutations {
            breakEndAttendanceShift(now: $now, source: $source, systemCreated: false) {${MUTATION_RESULT}            }
          }
        }`,
      })
      assertMutationSucceeded(data, 'BreakEnd', 'breakEndAttendanceShift')
    },

    async clockOut(input: { now: Date }): Promise<void> {
      const data = await client.execute<unknown>({
        operationName: 'ClockOut',
        variables: nowVar(input.now),
        query: `mutation ClockOut($now: ISO8601DateTime!, $source: AttendanceEnumsShiftSourceEnum) {
          attendanceMutations {
            clockOutAttendanceShift(now: $now, source: $source) {${MUTATION_RESULT}            }
          }
        }`,
      })
      assertMutationSucceeded(data, 'ClockOut', 'clockOutAttendanceShift')
    },
  }
}

export type Operations = ReturnType<typeof createOperations>
