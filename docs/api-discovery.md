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

Not yet verified: whether they return `{ errors, shift }` like the four clock
mutations (assume so), and what an approved month answers.

`AttendanceShift` also has `clockOut`, `clockOutOffset`, `observations`,
`locationType`, `workplaceId`, `halfDay`, `attendancePeriodId`, `inSource`,
`outSource`, `referenceDate`, `employeeId` — none of `status`, `approved`,
`editable`. The month's approval state is not on the shift; `AttendanceEmployee`
has `attendanceCyclesConnection` and `attendanceBalancesConnection(startOn,
endOn)`, neither of which carries an approval field under any obvious name.
