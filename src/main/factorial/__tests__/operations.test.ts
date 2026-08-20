import { describe, expect, it } from 'vitest'
import { deriveState } from '@shared/attendance-state'
import { FactorialError, type GraphQLClient, type Operation } from '../client'
import { createOperations } from '../operations'

/**
 * A client that answers with canned payloads and records what it was asked.
 * The payloads are shaped like the *raw* `data` of a real response, because that
 * is exactly what `client.execute` hands over — it casts without checking, so
 * every shape assumption in operations.ts is under test here.
 */
function recordingClient(...responses: unknown[]): { client: GraphQLClient; calls: Operation[] } {
  const calls: Operation[] = []
  let index = 0
  const client: GraphQLClient = {
    execute: async <T>(op: Operation): Promise<T> => {
      calls.push(op)
      if (index >= responses.length) throw new Error(`no canned response for ${op.operationName}`)
      const response = responses[index]
      index += 1
      return response as T
    },
  }
  return { client, calls }
}

function only(calls: Operation[]): Operation {
  const call = calls[0]
  if (!call) throw new Error('no operation was executed')
  return call
}

/** Verified AttendanceOpenShift (DESIGN.md): numeric id, sentinel clock-in date. */
const OPEN_SHIFT_FIXTURE = {
  id: 543343386,
  date: '2026-08-12',
  clockIn: '2000-01-01T01:18:23Z',
  clockInOffset: '+02:00',
  locationType: 'office',
  workplaceId: 3333333,
  timeSettingsBreakConfiguration: null,
}

const now = new Date(2026, 7, 12, 0, 11, 12)
const NOW_ISO = '2026-08-12T00:11:12+02:00'

describe('fetchMe', () => {
  it('flattens the current-user envelope', async () => {
    const { client } = recordingClient({
      apiCore: {
        currentsConnection: {
          nodes: [
            {
              email: 'person@example.com',
              employee: { id: 1111111, fullName: 'Erika Beispiel' },
              company: { id: 2222222, name: 'Beispiel GmbH' },
            },
          ],
        },
      },
    })
    await expect(createOperations(client).fetchMe()).resolves.toEqual({
      email: 'person@example.com',
      employeeId: 1111111,
      fullName: 'Erika Beispiel',
      companyId: 2222222,
      companyName: 'Beispiel GmbH',
    })
  })

  it('keeps the employee id numeric, because attendance.employee(id:) demands Int!', async () => {
    const { client } = recordingClient({
      apiCore: {
        currentsConnection: {
          nodes: [
            {
              email: 'a@b.de',
              employee: { id: 1111111, fullName: 'Erika Beispiel' },
              company: { id: 2222222, name: 'Beispiel GmbH' },
            },
          ],
        },
      },
    })
    const identity = await createOperations(client).fetchMe()
    expect(typeof identity.employeeId).toBe('number')
  })

  it('throws when no current user is returned', async () => {
    const { client } = recordingClient({ apiCore: { currentsConnection: { nodes: [] } } })
    await expect(createOperations(client).fetchMe()).rejects.toThrow(/no current user/i)
  })

  it('reports an envelope of the wrong shape as malformed instead of crashing', async () => {
    const { client } = recordingClient({ apiCore: null })
    await expect(createOperations(client).fetchMe()).rejects.toMatchObject({ kind: 'malformed' })
  })
})

describe('fetchOpenShift', () => {
  it('returns null when the employee is clocked out', async () => {
    const { client } = recordingClient({ attendance: { employee: { id: 1111111, openShift: null } } })
    await expect(createOperations(client).fetchOpenShift(1111111)).resolves.toBeNull()
  })

  it('passes the employee id as a number, because the schema demands Int!', async () => {
    const { client, calls } = recordingClient({ attendance: { employee: { openShift: null } } })
    await createOperations(client).fetchOpenShift(1111111)
    expect(only(calls).variables.id).toBe(1111111)
    expect(typeof only(calls).variables.id).toBe('number')
  })

  it('returns the open shift when one exists', async () => {
    const { client } = recordingClient({ attendance: { employee: { openShift: OPEN_SHIFT_FIXTURE } } })
    const shift = await createOperations(client).fetchOpenShift(1111111)
    expect(shift).toEqual({
      // The wire id is a JSON number; every id leaves this module as a string.
      id: '543343386',
      date: '2026-08-12',
      clockIn: '2000-01-01T01:18:23Z',
      clockInOffset: '+02:00',
      locationType: 'office',
      workplaceId: 3333333,
      timeSettingsBreakConfiguration: null,
    })
  })

  it('accepts an id that already arrives as a string', async () => {
    const { client } = recordingClient({
      attendance: { employee: { openShift: { ...OPEN_SHIFT_FIXTURE, id: '543343386' } } },
    })
    const shift = await createOperations(client).fetchOpenShift(1111111)
    expect(shift?.id).toBe('543343386')
  })

  it('normalises the break configuration id to a string as well', async () => {
    const { client } = recordingClient({
      attendance: {
        employee: {
          openShift: {
            ...OPEN_SHIFT_FIXTURE,
            timeSettingsBreakConfiguration: { id: 19613, name: 'Mittagspause' },
          },
        },
      },
    })
    const shift = await createOperations(client).fetchOpenShift(1111111)
    expect(shift?.timeSettingsBreakConfiguration).toEqual({ id: '19613', name: 'Mittagspause' })
  })

  it('feeds deriveState, which rebuilds the real instant from the sentinel date', async () => {
    // End to end over the recorded shape: 01:18:23 local on 2026-08-12 at +02:00.
    const { client } = recordingClient({ attendance: { employee: { openShift: OPEN_SHIFT_FIXTURE } } })
    const state = deriveState(await createOperations(client).fetchOpenShift(1111111))
    if (state.kind !== 'in') throw new Error(`expected an open shift, got ${state.kind}`)
    expect(state.since.toISOString()).toBe('2026-08-11T23:18:23.000Z')
    expect(state.workplaceId).toBe(3333333)
  })

  it('asks for clockInOffset, without which no timestamp can be reconstructed', async () => {
    const { client, calls } = recordingClient({ attendance: { employee: { openShift: null } } })
    await createOperations(client).fetchOpenShift(1111111)
    expect(only(calls).query).toContain('clockInOffset')
    // AttendanceOpenShift has no clockInWithSeconds — asking for it is a hard error.
    expect(only(calls).query).not.toContain('clockInWithSeconds')
  })

  it('asks for every field the state derivation reads', async () => {
    const { client, calls } = recordingClient({ attendance: { employee: { openShift: null } } })
    await createOperations(client).fetchOpenShift(1111111)
    for (const field of ['date', 'clockIn', 'locationType', 'workplaceId', 'timeSettingsBreakConfiguration']) {
      expect(only(calls).query).toContain(field)
    }
  })

  it('rejects a shift without an offset rather than guessing UTC', async () => {
    // A missing offset would silently shift the timer by hours.
    const shift: Record<string, unknown> = { ...OPEN_SHIFT_FIXTURE }
    delete shift.clockInOffset
    const { client } = recordingClient({ attendance: { employee: { openShift: shift } } })
    await expect(createOperations(client).fetchOpenShift(1111111)).rejects.toMatchObject({
      kind: 'malformed',
    })
  })

  it('does not read a missing employee as "clocked out"', async () => {
    // We asked for our own id. No record means the answer is unusable, not that
    // the user is off the clock — showing "Ausgestempelt" here would be a lie.
    const { client } = recordingClient({ attendance: { employee: null } })
    await expect(createOperations(client).fetchOpenShift(1111111)).rejects.toMatchObject({
      kind: 'malformed',
    })
  })
})

describe('fetchTodayShifts', () => {
  /**
   * A break splits a day into several records — and one of those records IS the
   * break. Both signals that tell them apart have to survive the parse, or the
   * day sum counts lunch as work (which it did).
   */
  it('returns the day’s shifts with both break signals and passes the date twice', async () => {
    const { client, calls } = recordingClient({
      attendance: {
        employee: {
          attendanceShiftsConnection: {
            nodes: [
              {
                id: 543343386,
                date: '2026-08-12',
                minutes: 67,
                workable: true,
                clockInWithSeconds: '2026-08-12T08:00:00+00:00',
                clockInOffset: '+02:00',
                timeSettingsBreakConfiguration: null,
              },
              {
                id: 543343999,
                date: '2026-08-12',
                minutes: 30,
                workable: false,
                clockInWithSeconds: '2026-08-12T12:30:00+00:00',
                clockInOffset: '+02:00',
                timeSettingsBreakConfiguration: { id: 19613, name: 'Mittagspause' },
              },
            ],
          },
        },
      },
    })
    await expect(createOperations(client).fetchTodayShifts(1111111, '2026-08-12')).resolves.toEqual([
      {
        id: '543343386',
        date: '2026-08-12',
        minutes: 67,
        workable: true,
        breakConfiguration: null,
        clockInWithSeconds: '2026-08-12T08:00:00+00:00',
        clockInOffset: '+02:00',
      },
      {
        id: '543343999',
        date: '2026-08-12',
        minutes: 30,
        workable: false,
        breakConfiguration: { id: '19613', name: 'Mittagspause' },
        clockInWithSeconds: '2026-08-12T12:30:00+00:00',
        clockInOffset: '+02:00',
      },
    ])

    const call = only(calls)
    expect(call.variables).toEqual({ id: 1111111, startOn: '2026-08-12', endOn: '2026-08-12' })
    // Asked for by name: a query that quietly stops requesting these is the bug
    // coming back, and nothing else would notice.
    expect(call.query).toContain('workable')
    expect(call.query).toContain('timeSettingsBreakConfiguration')
    // The day cannot be drawn in order without these.
    expect(call.query).toContain('clockInWithSeconds')
  })

  it('keeps a null minutes as null instead of counting it as zero', async () => {
    const { client } = recordingClient({
      attendance: {
        employee: {
          attendanceShiftsConnection: {
            nodes: [
              {
                id: 1,
                date: '2026-08-12',
                minutes: null,
                workable: true,
                timeSettingsBreakConfiguration: null,
              },
            ],
          },
        },
      },
    })
    await expect(createOperations(client).fetchTodayShifts(1111111, '2026-08-12')).resolves.toEqual([
      {
        id: '1',
        date: '2026-08-12',
        minutes: null,
        workable: true,
        breakConfiguration: null,
        clockInWithSeconds: null,
        clockInOffset: null,
      },
    ])
  })

  /**
   * Neither field is confirmed on a closed record. An older account, or a
   * Factorial that simply omits them, must degrade to the previous behaviour
   * rather than failing the whole day sum.
   */
  it('tolerates a record that carries neither signal', async () => {
    const { client } = recordingClient({
      attendance: {
        employee: {
          attendanceShiftsConnection: { nodes: [{ id: 1, date: '2026-08-12', minutes: 42 }] },
        },
      },
    })
    await expect(createOperations(client).fetchTodayShifts(1111111, '2026-08-12')).resolves.toEqual([
      {
        id: '1',
        date: '2026-08-12',
        minutes: 42,
        workable: null,
        breakConfiguration: null,
        clockInWithSeconds: null,
        clockInOffset: null,
      },
    ])
  })

  it('returns an empty list when nothing was recorded that day', async () => {
    const { client } = recordingClient({
      attendance: { employee: { attendanceShiftsConnection: { nodes: [] } } },
    })
    await expect(createOperations(client).fetchTodayShifts(1111111, '2026-08-12')).resolves.toEqual([])
  })
})

describe('fetchExpectedMinutes', () => {
  it('reads the daily target from expectedMinutes', async () => {
    // Recorded for 2026-08-12: expectedMinutes 480 == the web widget's "08:00".
    // The same node carries contractMinutes 720 and minutes 480 — both traps.
    const { client, calls } = recordingClient({
      attendance: {
        employee: {
          attendanceEstimatedTimesConnection: {
            nodes: [
              {
                date: '2026-08-12',
                expectedMinutes: 480,
                minutes: 480,
                regularMinutes: 480,
                overtimeMinutes: 0,
                absencesMinutes: 0,
                contractMinutes: 720,
                source: 'contract_hours',
              },
            ],
          },
        },
      },
    })
    await expect(createOperations(client).fetchExpectedMinutes(1111111, '2026-08-12')).resolves.toBe(480)
    expect(only(calls).variables).toEqual({ id: 1111111, startOn: '2026-08-12', endOn: '2026-08-12' })
  })

  it('returns null on a day off, where the connection comes back empty', async () => {
    const { client } = recordingClient({
      attendance: { employee: { attendanceEstimatedTimesConnection: { nodes: [] } } },
    })
    await expect(createOperations(client).fetchExpectedMinutes(1111111, '2026-08-15')).resolves.toBeNull()
  })

  it('returns null when the node carries no target at all', async () => {
    const { client } = recordingClient({
      attendance: {
        employee: {
          attendanceEstimatedTimesConnection: { nodes: [{ date: '2026-08-15', expectedMinutes: null }] },
        },
      },
    })
    await expect(createOperations(client).fetchExpectedMinutes(1111111, '2026-08-15')).resolves.toBeNull()
  })
})

describe('fetchBreakConfigurations', () => {
  it('reads from timeSettings, not from attendance', async () => {
    // attendance.breakConfigurationsConnection exists but returns different ids
    // and name: null throughout. Only timeSettings carries usable labels.
    const { client, calls } = recordingClient({
      timeSettings: {
        breakConfigurationsConnection: {
          nodes: [
            { id: 19613, name: 'Mittagspause', archived: false },
            { id: 20261, name: 'Arztbesuch', archived: false },
          ],
        },
      },
    })
    await expect(createOperations(client).fetchBreakConfigurations()).resolves.toEqual([
      { id: '19613', name: 'Mittagspause' },
      { id: '20261', name: 'Arztbesuch' },
    ])
    expect(only(calls).query).toContain('timeSettings')
    expect(only(calls).query).not.toContain('attendance')
  })

  it('asks the server for active configurations only', async () => {
    const { client, calls } = recordingClient({
      timeSettings: { breakConfigurationsConnection: { nodes: [] } },
    })
    await createOperations(client).fetchBreakConfigurations()
    expect(only(calls).query).toContain('active: true')
  })

  /**
   * The real account, read from the live API on 2026-08-12. Factorial keeps
   * retired configurations and serves them next to the live ones under the same
   * names — and the archived pair carries paid: false where the current pair
   * carries paid: true. Offering both would let a user book a break against a
   * retired configuration in a real HR record.
   */
  it('drops archived duplicates even if the server hands them over anyway', async () => {
    const { client } = recordingClient({
      timeSettings: {
        breakConfigurationsConnection: {
          nodes: [
            { id: 19613, name: 'Mittagspause', archived: false },
            { id: 20211, name: 'Verdienstausfall', archived: true },
            { id: 20261, name: 'Arztbesuch', archived: true },
            { id: 21217, name: 'Verdienstausfall', archived: false },
            { id: 21836, name: 'Arztbesuch', archived: false },
          ],
        },
      },
    })
    await expect(createOperations(client).fetchBreakConfigurations()).resolves.toEqual([
      { id: '19613', name: 'Mittagspause' },
      { id: '21217', name: 'Verdienstausfall' },
      { id: '21836', name: 'Arztbesuch' },
    ])
  })

  it('treats a missing or malformed archived flag as archived', async () => {
    // Erring the other way would put a retired configuration back in the menu,
    // which is the failure that costs something.
    const { client } = recordingClient({
      timeSettings: {
        breakConfigurationsConnection: {
          nodes: [
            { id: 1, name: 'Ohne Flag' },
            { id: 2, name: 'Nullflag', archived: null },
            { id: 3, name: 'Stringflag', archived: 'false' },
            { id: 4, name: 'Mittagspause', archived: false },
          ],
        },
      },
    })
    await expect(createOperations(client).fetchBreakConfigurations()).resolves.toEqual([
      { id: '4', name: 'Mittagspause' },
    ])
  })

  it('drops entries without a name so the menu never shows a blank row', async () => {
    const { client } = recordingClient({
      timeSettings: {
        breakConfigurationsConnection: {
          nodes: [
            { id: 1, name: null, archived: false },
            { id: 2, name: '   ', archived: false },
            { id: 3, name: 'Mittagspause', archived: false },
          ],
        },
      },
    })
    await expect(createOperations(client).fetchBreakConfigurations()).resolves.toEqual([
      { id: '3', name: 'Mittagspause' },
    ])
  })
})

describe('mutations', () => {
  /** K1: the schema rejects these outright. No mutation may declare or send them. */
  const FORBIDDEN = ['date', 'startOn', 'endOn'] as const

  const ok = (field: string): unknown => ({ attendanceMutations: { [field]: { errors: [] } } })

  it('sends clock-in with the local timestamp and source desktop', async () => {
    const { client, calls } = recordingClient(ok('clockInAttendanceShift'))
    await createOperations(client).clockIn({ now, locationType: 'office', workplaceId: 3333333 })
    expect(only(calls).operationName).toBe('ClockIn')
    expect(only(calls).variables).toEqual({
      now: NOW_ISO,
      source: 'desktop',
      locationType: 'office',
      workplaceId: 3333333,
    })
  })

  it('declares workplaceId as Int, not ID', async () => {
    const { client, calls } = recordingClient(ok('clockInAttendanceShift'))
    await createOperations(client).clockIn({ now, locationType: 'office', workplaceId: 3333333 })
    expect(only(calls).query).toContain('$workplaceId: Int')
    expect(typeof only(calls).variables.workplaceId).toBe('number')
  })

  it('omits workplaceId entirely when there is none, reproducing the verified call', async () => {
    // The verified clock-in passed no workplaceId at all. Sending an explicit
    // null is a different request, and an untested one.
    const { client, calls } = recordingClient(ok('clockInAttendanceShift'))
    await createOperations(client).clockIn({ now, locationType: 'work_from_home', workplaceId: null })
    expect(Object.keys(only(calls).variables).sort()).toEqual(['locationType', 'now', 'source'])
  })

  it('sends break-start with the break configuration id as an Int and systemCreated', async () => {
    const { client, calls } = recordingClient(ok('breakStartAttendanceShift'))
    await createOperations(client).breakStart({ now, breakConfigurationId: '19613' })
    expect(only(calls).operationName).toBe('BreakStart')
    expect(only(calls).variables).toEqual({
      now: NOW_ISO,
      source: 'desktop',
      timeSettingsBreakConfigurationId: 19613,
    })
    expect(typeof only(calls).variables.timeSettingsBreakConfigurationId).toBe('number')
    // K3: systemCreated is Boolean! — mandatory on both break mutations.
    expect(only(calls).query).toContain('systemCreated: false')
  })

  it('never sends locationType on break-start, which the mutation does not accept', async () => {
    // K2: breakStartAttendanceShift fails with undefinedArgument if locationType
    // is passed. clockIn and breakEnd accept it; this one does not.
    const { client, calls } = recordingClient(ok('breakStartAttendanceShift'))
    await createOperations(client).breakStart({ now, breakConfigurationId: '19613' })
    expect(only(calls).query).not.toContain('locationType')
    expect(only(calls).variables).not.toHaveProperty('locationType')
  })

  it('refuses a break id that is not an Int instead of sending NaN', async () => {
    const { client, calls } = recordingClient(ok('breakStartAttendanceShift'))
    await expect(
      createOperations(client).breakStart({ now, breakConfigurationId: 'Mittagspause' }),
    ).rejects.toBeInstanceOf(FactorialError)
    expect(calls).toHaveLength(0)
  })

  it('sends break-end with systemCreated', async () => {
    const { client, calls } = recordingClient(ok('breakEndAttendanceShift'))
    await createOperations(client).breakEnd({ now })
    expect(only(calls).operationName).toBe('BreakEnd')
    expect(only(calls).variables).toEqual({ now: NOW_ISO, source: 'desktop' })
    expect(only(calls).query).toContain('systemCreated: false')
  })

  it('sends clock-out', async () => {
    const { client, calls } = recordingClient(ok('clockOutAttendanceShift'))
    await createOperations(client).clockOut({ now })
    expect(only(calls).operationName).toBe('ClockOut')
    expect(only(calls).variables).toEqual({ now: NOW_ISO, source: 'desktop' })
  })

  it('sends neither date nor startOn nor endOn — they are not mutation arguments', async () => {
    const { client, calls } = recordingClient(
      ok('clockInAttendanceShift'),
      ok('breakStartAttendanceShift'),
      ok('breakEndAttendanceShift'),
      ok('clockOutAttendanceShift'),
    )
    const ops = createOperations(client)
    await ops.clockIn({ now, locationType: 'office', workplaceId: null })
    await ops.breakStart({ now, breakConfigurationId: '19613' })
    await ops.breakEnd({ now })
    await ops.clockOut({ now })

    expect(calls).toHaveLength(4)
    for (const call of calls) {
      for (const forbidden of FORBIDDEN) {
        expect(call.variables).not.toHaveProperty(forbidden)
        expect(call.query).not.toContain(`$${forbidden}`)
      }
    }
  })

  it('asks for the error union with inline fragments on every mutation', async () => {
    const { client, calls } = recordingClient(
      ok('clockInAttendanceShift'),
      ok('breakStartAttendanceShift'),
      ok('breakEndAttendanceShift'),
      ok('clockOutAttendanceShift'),
    )
    const ops = createOperations(client)
    await ops.clockIn({ now, locationType: 'office', workplaceId: null })
    await ops.breakStart({ now, breakConfigurationId: '19613' })
    await ops.breakEnd({ now })
    await ops.clockOut({ now })

    for (const call of calls) {
      // A bare `errors { message }` is a syntax error the server rejects (K5).
      expect(call.query).toContain('... on SimpleError')
      expect(call.query).toContain('... on StructuredError')
      expect(call.query).toContain('__typename')
      expect(call.query).toContain('$now: ISO8601DateTime!')
    }
  })

  it('surfaces a SimpleError even though the transport succeeded', async () => {
    const { client } = recordingClient({
      attendanceMutations: {
        clockInAttendanceShift: {
          errors: [{ __typename: 'SimpleError', message: 'Already clocked in', type: 'conflict' }],
        },
      },
    })
    await expect(
      createOperations(client).clockIn({ now, locationType: 'office', workplaceId: null }),
    ).rejects.toMatchObject({ kind: 'graphql', message: expect.stringContaining('Already clocked in') })
  })

  it('renders a StructuredError as field plus messages', async () => {
    const { client } = recordingClient({
      attendanceMutations: {
        clockInAttendanceShift: {
          errors: [{ __typename: 'StructuredError', field: 'workplaceId', messages: ['is invalid'] }],
        },
      },
    })
    await expect(
      createOperations(client).clockIn({ now, locationType: 'office', workplaceId: null }),
    ).rejects.toThrow(/workplaceId: is invalid/)
  })

  it('joins several in-band errors into one message', async () => {
    const { client } = recordingClient({
      attendanceMutations: {
        clockOutAttendanceShift: {
          errors: [
            { __typename: 'SimpleError', message: 'first', type: null },
            { __typename: 'StructuredError', field: 'now', messages: ['second', 'third'] },
          ],
        },
      },
    })
    await expect(createOperations(client).clockOut({ now })).rejects.toThrow(
      'first; now: second, third',
    )
  })

  it('still fails on an error union member it has never seen', async () => {
    const { client } = recordingClient({
      attendanceMutations: { clockOutAttendanceShift: { errors: [{ __typename: 'FutureError' }] } },
    })
    await expect(createOperations(client).clockOut({ now })).rejects.toMatchObject({
      kind: 'graphql',
      message: expect.stringContaining('FutureError'),
    })
  })

  it('does not read a missing mutation payload as success', async () => {
    // No payload means the write was never confirmed. Reporting success here
    // would show a clock-in that never happened.
    const { client } = recordingClient({ attendanceMutations: { clockOutAttendanceShift: null } })
    await expect(createOperations(client).clockOut({ now })).rejects.toMatchObject({
      kind: 'malformed',
    })
  })

  it('does not read a missing errors list as success either', async () => {
    const { client } = recordingClient({ attendanceMutations: { clockOutAttendanceShift: {} } })
    await expect(createOperations(client).clockOut({ now })).rejects.toMatchObject({
      kind: 'malformed',
    })
  })
})
