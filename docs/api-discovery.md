# Exploring the Factorial API

How the API reference in [`DESIGN.md`](DESIGN.md) was produced — reproducibly, so
that a missing field can be found rather than guessed.

> **Warning:** the mutations write to a real timesheet. While experimenting, send
> queries only; every mutation creates a real entry that has to be corrected by
> hand afterwards.

## Introspection is the fast way

The schema is open and the API accepts `credentials: 'include'` cross-origin. In a
signed-in session (a tab on `app.factorialhr.com`, DevTools console) a bare
`fetch` from the page context is therefore enough — no interceptor, no extension,
no token.

```js
const gql = async (query, variables = {}, op = 'X') =>
  (await fetch('https://api.factorialhr.com/graphql?' + op, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationName: op, variables, query }),
  })).json()

// List a type's fields together with their arguments:
await gql(`query T($n:String!){ __type(name:$n){ fields {
  name args { name } type { kind name ofType { kind name } } } } }`,
  { n: 'AttendanceEmployee' }, 'T')
```

That is how `attendanceEstimatedTimes.expectedMinutes`, `clockInOffset` and the
corrected mutation signatures were found.

Useful starting points:

- Root fields: `query { __schema { queryType { fields { name } } } }`
- One type: `query { __type(name: "attendance") { fields { name } } }`
- A mutation's arguments:
  `__type(name: "AttendanceMutations") { fields { name args { name } } }`

## Intercepting requests does not work

Patching `window.fetch` catches **zero requests** at Factorial, even in the main
world: the app holds a reference to `fetch` that was resolved before any later
patch. A content script in the isolated world has no effect on the page at all. To
see real requests you would have to patch before the app bundles load, or use
DevTools. For field discovery neither is necessary.

## Known type traps

- `attendance.employee(id:)` insists on **Int!**. `apiCore` returns
  `employee.id` as an Int too, and the mutation ids are **Int**, not `ID`/string.
- The four attendance mutations take **only `now`**. `date`, `startOn` and
  `endOn` are not arguments — they belong to the connections.
- `errors` is a union; a bare `errors { message }` does not parse.
- Break types come from `timeSettings` only, never from `attendance`.
- No `clock*` timestamp is an instant. Always combine `date` + time of day +
  `clockInOffset` (`reconstructInstant` in `src/shared/time.ts`).

## The target time in particular

`attendanceEstimatedTimesConnection(startOn:, endOn:)` returns one node per day.
A real answer, with **zero minutes worked**:

```jsonc
{ "date": "2026-08-12", "expectedMinutes": 480, "minutes": 480,
  "regularMinutes": 480, "overtimeMinutes": 0, "absencesMinutes": 0,
  "contractMinutes": 720, "source": "contract_hours" }
```

Three lessons from this one node:

1. **`expectedMinutes` is the day's target** (480 = 8 h, cross-checked against
   the timesheet reading "0h 00m / 8h 00m").
2. **`contractMinutes` is not** — 720 against a target of 480.
3. **`minutes` from this query is not time worked** — it also read 480 with zero
   minutes worked. Time worked stays the sum over the day's `shift.minutes` plus
   the running time of the open shift.

On days off, expect `expectedMinutes: 0` or an empty `nodes` array. Both mean "no
target" and are not filled in with eight hours.

## Introspection is switched off now (2026-09)

`__schema` and `__type` answer *"Field '__type' doesn't exist on type
'root_query'"* since some point after August 2026. What still works is
**validation**: a document that names candidate fields next to one that
certainly does not exist fails validation as a whole, so nothing executes — a
mutation included — and the error list names every field that was unknown.
Whatever is not in that list exists, and graphql-ruby's *"Did you mean …?"*
points at neighbours. Run it through the app's own session:

```bash
FACTORIAL_PROBE_MUTATIONS=updateAttendanceShift,deleteAttendanceShift npm run dev
FACTORIAL_PROBE_SHIFT_FIELDS=clockIn,clockOut,observations npm run dev
FACTORIAL_PROBE_DOC='mutation Probe { attendanceMutations { updateAttendanceShift(id: 1, foo: 1) { __typename } __thisFieldCannotExist } }' npm run dev
```

See `src/main/debug-introspect.ts`; the raw document must contain the
sentinel `__thisFieldCannotExist`, or the tool refuses to send it.

### Editing shifts — found this way on 2026-09-04

Three more fields on `attendanceMutations`:

| Mutation | Required | Accepted |
|---|---|---|
| `createAttendanceShift` | `date: ISO8601Date!` | `clockIn`, `clockOut` (ISO8601DateTime), `locationType`, `workplaceId`, `observations`, `workable`, `timeSettingsBreakConfigurationId`, `referenceDate`, `source`, `employeeId`, `halfDay` |
| `updateAttendanceShift` | `id: Int!` | `clockIn`, `clockOut`, `date`, `locationType`, `workplaceId`, `observations`, `timeSettingsBreakConfigurationId`, `referenceDate` — **not** `workable`, `source`, `halfDay`, `now` |
| `deleteAttendanceShift` | `id: Int!` | nothing else |

They do report failure in-band like the four clock mutations: a save was refused
with a `StructuredError`, `field: "messages"` — Rails' record-level bucket, not
an attribute — reading *"Schichten können ohne entsprechende Berechtigung weder
erstellt, bearbeitet noch gelöscht werden."* So the permission check is one
guard for all three, and a refusal arrives with HTTP 200 and an empty error list
nowhere in sight.

These three are the manager-side mutations. The section below settles why, and
what an employee is meant to send instead.

Still not verified: what an approved month answers.

`AttendanceShift` also has `clockOut`, `clockOutOffset`, `observations`,
`locationType`, `workplaceId`, `halfDay`, `attendancePeriodId`, `inSource`,
`outSource`, `referenceDate`, `employeeId` — none of `status`, `approved`,
`editable`. The month's approval state is not on the shift; `AttendanceEmployee`
has `attendanceCyclesConnection` and `attendanceBalancesConnection(startOn,
endOn)`, neither of which carries an approval field under any obvious name.

### Why the edit mutations are refused — answered 2026-09-05

They are refused because this account genuinely may not use them. Factorial's own
web interface does not edit shifts directly either: the pencil on a row opens
**"Änderungen beantragen"** with an **"Anfrage senden"** button, and the timesheet
table carries an **"Anfragestatus"** column. An employee proposes a change; a
manager approves it. `create/update/deleteAttendanceShift` are the manager-side
mutations, and the permission error is correct, not a malformed request.

The employee-side mutation is on `attendanceMutations` after all — the earlier
probe missed it by guessing `createAttendanceEditRequest` when the name is:

```graphql
attendanceMutations {
  createAttendanceEditTimesheetRequest(
    employeeId: Int!                                              # required
    requestType: AttendanceEditTimesheetRequestRequestTypeEnum!   # required
    attendanceShiftId: Int         # the record to change; omitted for create_shift
    clockIn: String  clockOut: String        # "18:08" — a time of day, see below
    date: ISO8601Date  referenceDate: ISO8601Date
    workable: Boolean  timeSettingsBreakConfigurationId: Int
    locationType: AttendanceShiftLocationTypeEnum
    workplaceId: Int  clockInWorkAreaId: Int  clockOutWorkAreaId: Int
    observations: String  reason: String
  ) {
    editTimesheetRequest { id approved requestType attendanceShiftId }
    errors { ... }        # the same MutationError union as the clock mutations
  }
}
```

`requestType` takes `create_shift`, `update_shift`, `delete_shift` — verified by
validation probe; `create`/`update`/`delete` are rejected.

**Do not take the ids from the web app's bundle.** It declares its variables as
`ID`, and sending that is rejected outright with `variableMismatch`:
*"Type mismatch on variable $employeeId and argument employeeId (ID! / Int!)"*.
They are `Int`, like every other attendance mutation — K4 applies here too. The
bundle is a good way to find a name and a bad way to learn a type; the server is
the only authority on the second.

`clockIn`/`clockOut` being `String` next to a separate `date` is the other
surprise, and it means what it looks like: **times of day, not instants**. The
request that finally went through carried `clockIn: "13:12", clockOut: "18:08"`
with `date: "2026-09-01"`.

Verified end to end on 2026-09-05 with the document in `operations.ts`:

```jsonc
{ "editTimesheetRequest": { "id": 13542327, "approved": null,
                            "requestType": "update_shift" }, "errors": [] }
```

`approved: null` is the pending state — the write has not happened yet and may
never. Nothing about the shift itself changed in that response.

How this was found, without writing anything: the operation lives in the web
app's JS bundle as a GraphQL AST, so fetching the page's own scripts and reading
the `Name` nodes yields the whole signature. The enum values and the required
arguments were then confirmed against the live API with the sentinel trick from
above — a document that fails validation executes nothing.

The consequence for this app is not a fixed request but a different feature: a
saved day cannot change the timesheet, only ask for it to be changed.

### Reading the requests back, and taking one back — 2026-09-05

What the "Anfragestatus" column is made of. Three places answer, all verified
by sentinel probe and one by a real read:

- `attendance.employee(id:).attendanceEditTimesheetRequestsConnection(startOn:, endOn:)`
  — **the one this app uses.** Every request of the employee in the range,
  answered or not, with `approved: true | false | null` (null is pending), the
  `requestType`, the proposed `clockIn`/`clockOut` as `"HH:MM"`, and
  `attendanceShift { id }` for the record it concerns. A `create_shift` request
  has no shift, which is why the shift-side field below is not enough.
- `AttendanceShift.editTimesheetRequest` — the same object, from the record.
- `attendance.editTimesheetRequestsConnection` — exists; arguments not probed.

Real answer for 2026-09-01 (trimmed): one applied request (`approved: true`,
the 18:07 that is now in the record) and the pending ones next to it, each
naming shift `554387733`.

`attendanceMutations.deleteAttendanceEditTimesheetRequest(id: Int!)` withdraws
a pending request; payload `DeleteAttendanceEditTimesheetRequestPayload` with
the usual `errors` union and `editTimesheetRequest`. There is also an
`updateAttendanceEditTimesheetRequest`, not probed.

## The profile widgets — 2026-09-05

`app.factorialhr.com/profile` shows five cards: status, absences, timesheet,
tasks and salary. The documents behind them are not in the bundle as text —
the app ships them as pre-parsed GraphQL ASTs — but the AST objects can be
found by operation name (`value:"TimeoffWidget"`), evaluated, and printed
with a thirty-line printer from the page console. The bundle declares every
id variable as `ID`; the server wants `Int` (K4), as everywhere else.

**Absences** (`TimeoffWidget`): `timeoff.leavesConnection` answers one
question per read. `approved: true` returns approved leaves only,
`includePending: true` returns pending ones only, and neither contains the
other's — the web app reads both and shows the union. `from:` is the first
day to consider; `employeeIds: [Int]`, `first`, `includeDuration: true` and
`sortOrder: {field: "start_on", order: "asc"}` are accepted. A real node:

```jsonc
{ "id": 33401718, "approved": true, "startOn": "2026-11-19", "finishOn": "2026-11-20",
  "halfDay": null, "hoursAmountInCents": null,
  "durationAttributes": "{\"workable_units\":{\"days\":{\"2026\":2.0},\"hours\":{\"2026\":16.0}}, …}",
  "leaveType": { "id": 2740693, "color": "07A2AD", "identifier": "holiday", "translatedName": "Urlaub" } }
```

`durationAttributes` is a JSON **string**, and its `workable_units.days`
(keyed by year) is the only place the "2 Tage" of the card lives.

**Timesheet** (`TimesheetInsight`):
`attendance.employee(id:).attendanceAggregatedWorkedTime(startOn:, endOn:)`
returns `{ id, minutes, trackedMinutes }` — Factorial's own sum, which read
1856 for a month the web app showed as "30h 56m". The card's planned hours
are the sum of `attendanceEstimatedTimesConnection`'s per-day `minutes`
(see "The target time in particular" for why `expectedMinutes` is used
here instead). `timeInsights.inconsistenciesConnection(employeeIds:,
startOn:, endOn:, state: pending) { totalCount }` is the "zu
vervollständigen" count.

**Tasks** (`TasksInsight`) hang off `tasks.tasksSummariesConnection(assigneeId:)`
with an *access* id, not the employee id, and are not read by this app.
