# Factorial Desktop — Design

Architecture, and the API reference this app is built on. Where anything else in
the repository disagrees with this file, this file wins.

## Goal

An Electron app for clocking in and out of Factorial HR and starting or ending
breaks, without opening the browser. A frameless floating card, always on top,
shown and hidden from the tray.

It is cut so that further Factorial features (project time, absences) can be
added without touching the transport or the state store.

### Non-goals

- **No offline queue.** A failed clock-in is not replayed later; that would write
  invented times into a real timesheet. The app fails visibly and reloads the
  real state.
- **No code signing or notarisation.** The first launch needs right-click → Open
  on macOS, *More info → Run anyway* on Windows.
- **No notifications or reminders** ("you have been clocked in for 9 hours").

## The Factorial API

Reverse-engineered from `app.factorialhr.com` — an interceptor in the page
context, real clicks through clock-in → lunch → resume → clock-out — plus schema
introspection, then verified against the live API: all four mutations executed
with `errors: []`, and `openShift` queried in each of the three states.

### Transport

- **One endpoint:** `POST https://api.factorialhr.com/graphql?<OperationName>`.
  The query string is cosmetic (for logging); `operationName` in the body is what
  counts.
- **Body:** `{ operationName, variables, query }`
- **Headers:** `content-type: application/json`, nothing else.
- **Auth is the session cookie alone.** No CSRF token, no bearer, no custom
  headers — verified with a bare `fetch` returning HTTP 200.
- The session cookie is **HttpOnly** and therefore invisible to JavaScript. There
  is no "access token to copy out".
- **Introspection is enabled**, so the schema can be pulled for codegen.

### Identity

```graphql
query Me {
  apiCore { currentsConnection { nodes {
    email
    employee { id fullName }
    company { id name }
  } } }
}
```

Returns `{ email, employee: { id, fullName }, company: { id, name } }`. This
query doubles as the **session check**: if it succeeds, you are signed in.

> **Type inconsistency:** `apiCore` returns `employee.id` as an **Int**, the
> mutations expect `ID` (a string), and `attendance.employee(id:)` insists on
> **Int!**. The conversion has to happen explicitly, in one place.

### Current state

```graphql
query Status($id: Int!) {
  attendance { employee(id: $id) { id openShift {
    id clockIn clockInOffset clockOut date referenceDate status
    locationType workplaceId workable
    timeSettingsBreakConfiguration { id name }
  } } }
}
```

`clockInOffset` is required for reconstructing the timer — see pitfall 2.
`workplaceId` also yields the last workplace used, which serves as the default
for the next clock-in.

Today's finished shifts, for the worked total:

```graphql
attendanceShiftsConnection(startOn: $d, endOn: $d) { nodes {
  id date clockInWithSeconds clockInOffset clockOut minutes workable
  createdAt crossesMidnight timeSettingsBreakConfiguration { id name }
} }
```

### Break types

```graphql
query BreakConfigurations {
  timeSettings {
    breakConfigurationsConnection(active: true) { nodes { id name archived } }
  }
}
```

**`active: true` is not optional.** Factorial keeps retired configurations and
serves them next to the current ones — under the same names. Unfiltered, from a
real account:

| ID | Name | `archived` | `paid` |
|---|---|---|---|
| 19613 | Mittagspause | `false` | `false` |
| 20211 | Verdienstausfall | **`true`** | `false` |
| 20261 | Arztbesuch | **`true`** | `false` |
| 21217 | Verdienstausfall | `false` | `true` |
| 21836 | Arztbesuch | `false` | `true` |

The menu would list "Verdienstausfall" and "Arztbesuch" twice with no visible
difference, and picking the wrong one books the break against a retired
configuration with the **wrong `paid` flag** — into a real timesheet. Not
cosmetic.

> **`active: false` does not mean "archived only", it means "do not filter"** and
> returns all five. It is no use for inspecting the archived ones.

`operations.ts` filters client-side on `archived` as well, treating anything but
an explicit `false` as archived. Deliberately redundant: if `active` ever changes
meaning, the second check holds.

> **Do not confuse it with** `attendance.breakConfigurationsConnection`, which
> also exists but returns different IDs and `name: null` throughout. Only
> `timeSettings` is right for the break picker.

### Mutations

All four live under `attendanceMutations`. **`now` is the only required
argument** — ISO8601 **with the local offset**, e.g. `2026-08-12T01:18:23+02:00`.

> `date`, `startOn` and `endOn` are **not** arguments of these mutations. They
> appear in the web client only as declared GraphQL variables of the document and
> belong to fields fetched in the same request. The schema rejects them.

| Operation | Mutation field | Accepted arguments (selection) |
|---|---|---|
| ClockIn | `clockInAttendanceShift` | `locationType`, `workplaceId: Int`, `clockInWorkAreaId: Int`, `timeSettingsBreakConfigurationId: Int`, `workable`, `referenceDate`, `observations`, `source` |
| BreakStart | `breakStartAttendanceShift` | `timeSettingsBreakConfigurationId: Int`, **`systemCreated: Boolean!`**, `observations`, `source` |
| BreakEnd | `breakEndAttendanceShift` | `locationType`, **`systemCreated: Boolean!`**, `projectTaskId`, `projectWorkerId`, `subprojectId`, `source` |
| ClockOut | `clockOutAttendanceShift` | `clockOutWorkAreaId: Int`, `workable`, `observations`, `source` |

> **`breakStartAttendanceShift` accepts no `locationType`** — `breakEnd` and
> `clockIn` do. Sending one makes BreakStart fail with `undefinedArgument`.

`breakStartAttendanceBreakShift` / `breakEndAttendanceBreakShift` also exist and
are **not** used: the web client uses the `…AttendanceShift` variants, and only
those are verified.

**Enums:**

- `AttendanceEnumsShiftSourceEnum`: `desktop`, `mobile`, `face_recognition`,
  `qr_code`, `mobile_geolocation`, `shared_device`, `api`, `system`,
  `one_assistant`
- `AttendanceShiftLocationTypeEnum`: `office`, `business_trip`, `work_from_home`

Verified calls:

```graphql
clockInAttendanceShift(now: $now, source: desktop, locationType: office)
breakStartAttendanceShift(now: $now, source: desktop, systemCreated: false,
                          timeSettingsBreakConfigurationId: 19613)
breakEndAttendanceShift(now: $now, source: desktop, systemCreated: false)
clockOutAttendanceShift(now: $now, source: desktop)
```

Each returns `{ errors, shift }`, so the new shift comes back with the response
and does not need a follow-up query.

**`errors` is `[MutationError!]!`, a union**, and needs inline fragments. A bare
`errors` is a syntax error:

```graphql
errors {
  __typename
  ... on SimpleError { message type }
  ... on StructuredError { field messages }
}
```

### Four pitfalls

**1. Errors arrive in-band with HTTP 200.** Success means
`data.attendanceMutations.<op>.errors` is empty. The HTTP status says nothing.

**2. No timestamp from this API is a valid absolute instant.** This is the most
dangerous thing in the whole integration.

`openShift.clockIn` returns `"2000-01-01T00:11:12Z"` — correct time of day,
placeholder date.

`shift.clockInWithSeconds` looks usable and is not. Against a real record:

| | |
|---|---|
| Actually clocked in | `2026-08-12 00:11:12` local (Europe/Berlin, +02:00) |
| So as a UTC instant | `2026-08-11T22:11:12Z` |
| What the API returns | `2026-08-11T00:11:12+00:00` |

Factorial combines the **UTC date component** (the 11th, since it is 22:11 UTC)
with the **local time of day** (00:11:12) and declares the result `+00:00`. Read
as an instant, that is 22 hours out.

**The correct reconstruction:** local calendar date from `shift.date`, time of
day from `clockInWithSeconds`, **zone offset from `clockInOffset`**. That last
field is separate and carries the real local offset, so neither the running
machine's timezone nor any "if it looks like the future, subtract a day"
heuristic is needed.

Cross-checked against a real record — `AttendanceShift.createdAt` is the only
genuine UTC instant in the schema and serves as the control:

| Field | Value |
|---|---|
| `clockInWithSeconds` | `2026-08-11T09:49:05+00:00` |
| `clockInOffset` | `+02:00` |
| `shift.date` | `2026-08-11` |
| reconstructed | `2026-08-11T09:49:05+02:00` = `07:49:05Z` |
| `createdAt` (control) | `2026-08-11T07:49:05Z` ✓ |

The `+00:00` offset and the date component of any `clockIn*` field are **always**
to be ignored.

The same rule applies to the open shift under different field names.
`AttendanceOpenShift` is a **different type** from `AttendanceShift` and has
neither `clockInWithSeconds` nor `minutes`:

```jsonc
{ "id": 543343386, "date": "2026-08-12",
  "clockIn": "2000-01-01T01:18:23Z",   // sentinel date, local time, with seconds
  "clockInOffset": "+02:00", "clockOut": null,
  "locationType": "office", "workplaceId": 3333333,
  "workable": true, "status": "opened", "referenceDate": "2026-08-12",
  "timeSettingsBreakConfiguration": null }
```

So: `openShift.date` + time from `openShift.clockIn` + `openShift.clockInOffset`.
One function, both shapes — `reconstructInstant` in `shared/time.ts`, duplicated
nowhere.

**3. `clockOut` has minute resolution only.** There is no
`clockOutWithSeconds`; the schema does not have the field.

**4. A break splits the shift into several records.** One pass of clock-in →
break → resume → clock-out produced three records with their own IDs and the same
`date`. The day's total is therefore the sum over `minutes` of the day's records
plus the running time of the open shift — not the delta of a single record.

## Architecture

### The main process owns the network and the state

The renderer is pure UI and speaks only over IPC. In descending order of how
binding the reason is:

1. **CORS.** The renderer has no permitted origin against
   `api.factorialhr.com`; the browser blocks those requests. A fetch from the
   main process is not subject to CORS and attaches the partition's cookies
   automatically. It is the only thing that works.
2. **One truth.** The tray needs the timer state in the main process anyway. A
   second state in the renderer would be a permanent source of divergence.
3. **Isolation.** The session cookie stays out of any renderer context.

*Rejected alternative:* the renderer talking to the API directly. It fails on
CORS and could only be forced with a custom protocol handler or by disabling
`webSecurity` — trading a security property for nothing, since IPC is needed
regardless.

### Modules

```
main/
  session.ts          persist:factorial partition, cookie lifecycle, user agent
  auth.ts             login window
  auth-flow.ts        the login sequence, Electron-free
  factorial/
    client.ts         GraphQL transport
    operations.ts     the operations and their types
  attendance.ts       state store: derivation, polling, optimistic updates
  tray.ts             icon, tooltip, context menu
  tray-menu.ts        what the menu says, Electron-free
  windows.ts          the widget window
  window-position.ts  where the window may go, Electron-free
  settings.ts         persisted settings, Electron-free
  updater.ts          update checks and prompts
  update-policy.ts    when an update may happen, Electron-free
  ipc.ts              channel registration
  ipc-handlers.ts     what each channel does, Electron-free
preload/index.ts      contextBridge — ten functions, nothing else
shared/               contract, time reconstruction, state derivation, errors
renderer/             React, Tailwind v4, shadcn/ui (Nova)
```

**Boundaries:**

- `factorial/operations.ts` is the **only** place that knows Factorial's
  semantics. A new feature means a new operation here and a new panel in the
  renderer.
- `factorial/client.ts` knows GraphQL-over-HTTP and nothing about attendance.
- `attendance.ts` knows neither windows nor tray — it publishes state and
  consumers subscribe.
- Every module marked *Electron-free* above is that way on purpose: it takes what
  it needs as arguments and is unit tested without an Electron runtime.

## Auth

1. Get `session.fromPartition('persist:factorial')` at startup.
2. Run the `Me` query through the main-process client.
3. Success → cache `employeeId`, carry on.
4. 401 or an empty answer → open a login `BrowserWindow` on
   `https://id.factorialhr.com` in the same partition.
5. **Wait for navigation, do not poll.** Once the login window lands on a
   Factorial host that is *not* the login host, query `Me` once. If it succeeds,
   close the window and continue.

> **The app makes no API request at all while signing in.** That is a correction,
> not an optimisation.
>
> The first version polled `Me` every 1.5 seconds while the login window was
> open. Factorial then rejected **every** code — the emailed OTP and the TOTP from
> the authenticator app alike, both with "invalid code". A TOTP is checked
> server-side from code, secret and clock; no client can get a correct code wrong.
> When both kinds fail at once, the code was never the problem — the verification
> request could no longer find its in-flight sign-in.
>
> A stream of unauthenticated `Me` calls once a second, carrying a half-finished
> auth cookie, against an API behind Cloudflare: no browser does that, and it is
> the most obvious thing to remove.
>
> The predicate (`indicatesSignedIn` in `login-target.ts`) is phrased
> **positively**: it says yes only for a Factorial host outside the login host. A
> negative "is this still the login?" would answer yes on every unexpected detour
> — an SSO hop, `about:blank`, a malformed URL — and fire a request exactly then.
>
> The price: if Factorial changes where it lands after sign-in, the login window
> stays open. That is visible and easy to find, and far better than a sign-in that
> cannot succeed at all.

The app **never reads the cookie and stores no token.** Chromium keeps it in the
partition. Signing out means clearing the partition's cookies.

### Keeping the session alive

Signing in leaves three cookies:

| Cookie | HttpOnly | Lifetime |
|---|---|---|
| `_factorial_id` | yes | **2 hours** |
| `_factorial_id_refresh` | yes | 7 months |
| `_factorial_id_data` | no | 7 months |

The cookie the app rides on is **deliberately short-lived**. Staying signed in
means trading the long-lived refresh cookie for a fresh access cookie — which is
what a browser tab does in the background, and why Chrome stays signed in all
day.

Without that trade the app fell out of the session about every two hours and
demanded a full re-authentication including 2FA, as if the session had been
revoked.

The trade is **a bare POST** — no body, no headers, no CSRF token, just the
cookie the partition already holds:

```
POST https://id.factorialhr.com/api/auth/refresh
```

**Reactive, not on a timer.** A 401 is the only reliable signal that the token is
spent. A clock would have to guess the expiry, would drift across standby, and
would still need to handle the 401 for the times it guessed wrong.

The sequence is: 401 → refresh once → retry **once**. If the retry is also
unauthorised, that answer is passed through unchanged and the app does what it
did before — report the session as expired and offer to sign in. An expired
session must never become a loop against an HR system.

Concurrent 401s share **one** refresh: the store fires its queries together, and
two competing trades are how you invalidate a rotating refresh token yourself.

> **Does that contradict "mutations are never retried automatically"?** No, and
> the difference matters. That rule is about *domain* failures — the server
> considered the request and refused it, or the answer never arrived. Retrying
> there invents time.
>
> A 401 never reaches the resolver: the auth layer refuses it first, nothing was
> written, there is nothing to duplicate. And the retry is **byte-identical** —
> every mutation carries its own `now`, so the second attempt writes the timestamp
> of the *original click*. Not retrying would be the less accurate option: the
> user clicks again a few seconds later and records that later moment instead.

The login window runs with `contextIsolation: true`, `nodeIntegration: false` and
**no preload** — it loads somebody else's website.

### Cloudflare and the user agent

**Cloudflare sits in front of `api.factorialhr.com`.** Shown by a cookie jar from
a successful login: it holds a `cf_clearance` cookie on `.api.factorialhr.com`. A
partition where sign-in had failed held `_factorial_id_auth_error` instead.

That explains a symptom that is otherwise inexplicable: sign-in rejects **every**
code, emailed OTP and authenticator alike, with "invalid code". When both kinds
are wrong at once, the code was never the problem — the verification request is
refused before the code is checked at all.

Electron's default user agent carries the build in the string:

```
Mozilla/5.0 (Macintosh; ...) ... Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36
```

So `applyBrowserUserAgent()` in `session.ts` strips the `Electron/<version>`
token. What is left is the string Chromium built for its own engine; the Chrome
version and the platform in it are real, only the build flavour is gone.

It is set on the **whole partition**, not just the login window. Windows and later
API calls share this session, and sending a server two different user agents for
one session is exactly the kind of contradiction that invalidates it.

> **When debugging a broken sign-in, empty the partition first.** A
> `_factorial_id_auth_error` from a failed attempt survives a restart and can
> contaminate the next one. To look inside the jar,
> `sqlite3 <partition>/Cookies "select host_key, name from cookies"` — **without**
> the value column, which is the session.

## State model

Three states, derived entirely from `openShift` — no flag maintained alongside:

| `openShift` | `timeSettingsBreakConfiguration` | `workable` | State |
|---|---|---|---|
| `null` | — | — | **out** |
| set | `null` | `true` | **clocked in** |
| set | set | `false` | **on a break** |

Plus the meta-states `unknown` (before the first load) and `unauthenticated`.

Confirmed live. `workable` correlates completely with the break state but is
**redundant** — `timeSettingsBreakConfiguration` decides, or there would be two
truths.

> **Factorial's own web widget is not a reliable reference.** Observed: the
> dashboard showed "on a break" with a *Resume* button, even after a hard reload,
> while `openShift` was `null`, the last shift was closed and the timesheet read
> `0h 00m`. Factorial's client cache lags after quick state changes. **The API is
> the truth.** This app will deliberately disagree with the web widget in such
> cases; that is not a bug here and must not be "fixed" to match.

### Synchronisation

Reloaded on: **every mutation** (the response carries the new shift and is
adopted directly), **every 60 s** in the background, **window focus** and **tray
open**, and **`powerMonitor` resume** after standby — without that last one the
timer shows nonsense after a laptop lid has been closed.

### Optimistic updates

A click shows the target state immediately and disables the button. On an error
it rolls back, shows a toast, and reloads the real state.

### Time calculation

The timer does **not** count up by itself. On every tick it recomputes the
difference to a reconstructed start instant, so it cannot drift and it survives
standby.

The start instant follows the rule from pitfall 2, in one function
(`reconstructInstant`), used everywhere.

The day's total is the sum over `minutes` of today's **work** records plus the
running time of the open shift.

> **Breaks split the shift into several records — and one of those records IS the
> break.** Starting a break closes the work record and opens a break record;
> that is exactly why `openShift.timeSettingsBreakConfiguration` can identify the
> state at all. For the day's total it means both kinds arrive in the same list
> and have to be told apart.
>
> The first version fetched only `id date minutes` and so had nothing to tell them
> apart with — every break counted as work. Reported from a real account: 7:56 in
> the widget for a day Factorial recorded as 7:23, exactly the 33 minutes of
> break. On a widget people read to decide when to go home, that sends them home
> early.
>
> Breaks are excluded on **both** signals of the record: `workable === false` or a
> set `timeSettingsBreakConfiguration`. Not two truths about one question, but one
> question asked twice — the correlation is confirmed live for the *open* shift
> and for neither on a *closed* record, so both are believed. If both are absent,
> the total behaves as before.
>
> The asymmetry is intentional: an unrecognised break inflates the day and sends
> somebody home early, while a work record misread as a break understates it and
> costs nothing but a second look at Factorial.

## Error handling

| Case | Behaviour |
|---|---|
| `errors[]` non-empty | Toast with the server's message, roll back, reload |
| HTTP 401 | State `unauthenticated`, offer the login window |
| Network error | Toast "no connection", roll back, reload. **No silent retry of the mutation** |
| Polling fails | Ignored quietly; the last known state stays visible with a discreet stale indicator |

A failed mutation is never presented as a success.

German user-facing text for a failure comes from **one** table, in
`shared/errors.ts`. The renderer and the tray both use it; neither opens a second
one.

## UI

One card, two states:

| | Size | Contents |
|---|---|---|
| collapsed | 156 × 44 | dot · number · day bar |
| expanded | 300 × 162 | + status · remaining · buttons · work location · break total |

**The expanded state is a moment of acting, not a view to sit in.** You open it to
press Pause or clock out, and it closes again. That is why it shows everything at
once instead of making anyone open it twice — and why it is not remembered: the
collapsed state is the one the day is spent in.

There used to be three fixed sizes with a setting in the tray. The middle one
showed nothing the expanded card does not, and could not carry the break total
without overflowing; the largest spread 37 px of air it did not need. What is left
is one card with no setting at all: 300 × 162 against the former 340 × 224, **36 %
less area for the same content**.

Row positions live in `widget-size.ts`, not as numbers in the component —
geometry that nothing checks will drift. The footer sat 3 px above the day bar for
a while and looked like it rested on it: the work-location selector is 24 px tall,
not the 16 of a line of text, so the row ends 8 px lower than it looks in the
source. `widget-size.test.ts` does that arithmetic now.

Expanding happens via the chevron next to the number or a double click on the
card. The hint line ("no connection") sits in the gap the composition leaves
between number and buttons and therefore costs no height.

### The bar draws the day, not a fraction

The bar shows the **course of the day**: work green, breaks amber, the rest until
the earliest possible end of day transparent — in the order things actually
happened.

It used to be worked time against the target. On that axis a break has **no
width**, because it is precisely the time that does not count there: a day with a
break looked like a day without one. That is a problem when the law requires a
break and this app is where people look.

**The span is target plus breaks**, because a break pushes the end of the day back
by its own length. When the day runs past that — overtime, target long met — the
span is simply everything that happened: the bar fills and stops rather than
overflowing. Worth knowing while reading it: a longer break stretches the whole
bar, because it really does move the finish line.

Lengths and order only, never clock times. Two records with a gap between them
(clocked out and back in without taking a break) are drawn adjacent — the widget
answers "how much worked, how much paused", it does not reconstruct a timesheet.

`attendanceShiftsConnection` guarantees **no order**, so the store sorts by
`clockInWithSeconds` + `clockInOffset` through `reconstructInstant`. A record
whose start cannot be read keeps its length and goes last: its contribution to the
total is right either way, only its position is a guess, and the end of the day is
the guess that disturbs least.

**Amber stays amber**, even once the break is over and work has resumed. It is the
break colour everywhere else in the app; one that changed after the break ended
would be a second word for the same thing.

### During a break the timer shows the break

The large number is the **duration of the break**, not the day's total. The dot
and the bar are amber, the status line names the break ("Pause · Mittagspause"),
and the day's total moves up next to the status ("Gearbeitet 07:23").

It used to be the day's total — which stands still during a break. A large number
that has stopped moving reads as a hung app, not as an interrupted shift; the
break duration was exiled to a footer so quiet that nobody connected the two.

**The tray has always done it this way** (`primaryMs` in `tray-menu.ts`, with the
comment "showing it counting up would be a lie"). The widget was the only surface
that disagreed.

The word "Pause" precedes the name rather than the name standing alone: the amber
dot already says paused, but a break called "Arztbesuch" would leave colour as the
only carrier of that information, and colour must never be the only carrier.

On resume the day's total takes the number back and keeps running.

### The break total

The footer's right-hand corner reads "Pause HH:MM" — the corner that came free
when the running break time moved up into the timer. It therefore costs **no
height**, which is the only reason a second number is bearable there.

The tray menu shows the same figure as its own line directly under the status
line. Its own line, and no further addition to the status line: that one already
carries state, time, break name and freshness, and the one number somebody opens
this menu for should not be the fifth element of a row.

On a day without a break it shows **nothing** rather than "0:00" — a zero would be
a reminder every morning that nobody asked for.

> **No statutory threshold is built in.** Under German ArbZG §4 the minimum break
> depends on hours worked (over 6 h → 30 min, over 9 h → 45 min); collective and
> works agreements differ, other countries more so. Hard-wiring a threshold would
> mean this app makes a legal statement — on a surface that writes to a real
> timesheet. It shows the number; the judgement stays with the person.

### Target time

The day's target comes from `attendanceEstimatedTimes`:

```graphql
query EstimatedTime($id: Int!, $d: ISO8601Date!) {
  attendance { employee(id: $id) {
    attendanceEstimatedTimesConnection(startOn: $d, endOn: $d) { nodes {
      date expectedMinutes minutes regularMinutes
      overtimeMinutes absencesMinutes contractMinutes source
    } }
  } }
}
```

A real answer:

```jsonc
{ "date": "2026-08-12", "expectedMinutes": 480, "minutes": 480,
  "regularMinutes": 480, "overtimeMinutes": 0, "absencesMinutes": 0,
  "contractMinutes": 720, "timeUnit": "minute", "source": "contract_hours" }
```

`expectedMinutes: 480` is the web widget's "remaining 08:00", cross-checked
against the timesheet.

**Do not use `contractMinutes`** — that is 720 and means something else. **Do not
use `minutes` from this query as time worked** — it also read 480 with zero
minutes worked. Time worked stays the sum over `shift.minutes` plus running time.

On days off or during absence, expect `expectedMinutes: 0` or an empty `nodes`
array; the target comparison then falls away and the card shows plain time worked.

**The bar disappears in that case rather than being drawn empty.** An empty bar is
not neutral — it claims "0 % of something", and on a day without a target that
something does not exist. Same rule as the timer being a dash rather than 0:00:00
before the first answer.

**Past the target the line changes from "Verbleibende Zeit 00:00" to "Soll erfüllt
· +H:MM".** The old wording was true but named the uninteresting part: not that
nothing is left, but how much is already beyond. The switch keys off the *rounded*
overtime so the line never contradicts what it prints — a tenth of a minute over
still shows "00:00" rather than a "+0:00" that looks like a bug.

### Work location

The selector shows the **open shift's actual location**, not the stored
preference. The preference only says what the *next* clock-in would use, and the
two come apart as soon as somebody clocks in from the web or the phone. The first
version showed "Büro" for a shift running as "Mobiles Arbeiten": an intention
presented as a fact. The preference is the fallback only when the API gives no
location for the open shift — then there is nothing truer to show.

This is also why the break state carries `locationType`: a break does not pick a
new location, it inherits the interrupted shift's.

**The labels are Factorial's own words**, not a translation of ours.
`work_from_home` is **"Mobiles Arbeiten"** there, not "Homeoffice" — anyone
putting widget and web side by side should not have to translate first.

> **Break type and work location open a NATIVE menu, not a DOM dropdown.** In a
> 321 × 179 window a menu drawn in the document gets clipped — the break list cut
> off after two entries with the rest behind a scrollbar. No window size fixes
> that: the list is as long as an employer configured it, and the window size is
> fixed by the animation. A native menu is a window of the platform: bounded by
> the screen rather than by ours, and it flips near an edge by itself. The
> renderer sends rows and an anchor in window coordinates, the main process opens
> the menu and answers with the choice — or `null` if it was dismissed.

### Window ≠ card

The window is **larger than the visible card** and transparent around it. The
reason is the animation: only the main process can change a `BrowserWindow`'s
size, frame by frame across the IPC boundary, with nothing interpolating in
between.

So the window stays put and only the `div` inside it grows, as a CSS transition on
the compositor. The remainder is headroom for the card to grow into.

The price is the invisible margin. It would swallow clicks meant for the desktop
behind — on a window that is always on top. So the main process makes the window
click-through (`setIgnoreMouseEvents(true, { forward: true })`) and the renderer
asks for clicks back once the pointer is over the card.

> **On Windows that forwarding does not arrive.** Measured against a bare
> transparent window: 29 `mousemove` while interactive, **0** while forwarding,
> focused or not. Without a substitute the card goes click-through once and never
> comes back — a widget nobody can operate. So on Windows the main process samples
> the cursor every 32 ms while the window is click-through and pushes the position
> to the renderer, which decides exactly as it does from a real move.

### Motion

The card grows and shrinks on `--ease-out`, the same curve as everything else.
Open, 520 ms; close, 420 ms — arriving may take its time, leaving should not keep
anyone waiting.

It used to be a sampled damped oscillation, 41 `linear()` stops per direction,
overshooting and settling back. It was retuned twice and got louder both times
**without anyone touching it**: the overshoot is a fraction of the distance
travelled, and the card grew. The same 12.6 % that threw it 10 px past the target
when it expanded to 126 px threw it 15 px past when it expanded to 162 px.

Without the overshoot, nothing is left that `--ease-out` did not already do. Gone
with the springs: 400 characters of generated easing, the headroom the window had
to reserve for a peak, and the standing coupling between *how big the card is* and
*how loudly it moves*.

### Appearance

The stored value is put on `nativeTheme.themeSource` — that is the entire
mechanism. Chromium reports it to every renderer of this app as
`prefers-color-scheme`, and `styles.css` defines its dark tokens under exactly
that media query. There is therefore **no** theme state in React, no provider and
no IPC channel for it: nothing that could fall out of step with the setting.

`ThemeSetting`'s three values are exactly `themeSource`'s three, so the wiring
needs no translation table — and both the settings store and the IPC layer check
the value against the whitelist, because `themeSource` throws on anything else and
a hand-edited settings file must not stop the next start.

> **The dark theme used to be unreachable.** `styles.css` had shadcn's default
> `@custom-variant dark (&:is(.dark *))` and put its tokens under `.dark` — a class
> nobody ever set. `next-themes` was installed but only `sonner.tsx` imported it,
> and there was no `ThemeProvider`. The dark colours were all there and were never
> rendered. Moving to the media query fixes it at the root: the class needed
> somebody to set it, the media query needs nobody.

**Colour coding:** green clocked in, amber on a break, neutral clocked out.

**Stack:** React and TypeScript, Tailwind v4, shadcn/ui in the **Nova** style.

## Tray

The tray is where the app lives — there is no taskbar button and no dock icon, and
closing the widget only hides it.

**macOS:** a template icon (adapting to light and dark) plus `tray.setTitle()`
with the running timer in the menu bar.

**Windows:** `setTitle` does not exist there. Instead a colour-coded icon, a
tooltip with the time, and the time as the first, disabled entry of the context
menu. **The live timer in the menu bar stays a macOS feature.**

**Context menu:** clock in and out, break (submenu of types) or resume, show or
hide the window, refresh, settings, quit. The actions work without opening the
window.

## Settings

- Start at login (default on)
- Always on top
- Expand direction: right (default) or left
- Appearance: system (default), light, dark
- Language: system (default) or one of seven
- Check for updates — doubles as the download's progress display
- About: the app version and the Electron/Chromium it runs on. Deliberately next
  to the update entry: it is how "did that update apply?" gets answered, and the
  only place in the app that can answer it
- Sign out (clears the partition's cookies)

Persisted as JSON in `app.getPath('userData')`. The tray submenu is the only
settings surface; the card is 300 px wide and shows time, not configuration.

## Updates

`electron-updater` against the GitHub releases of this repository. Three rules,
expressed as testable arithmetic in `update-policy.ts`:

1. **Nothing downloads unasked.** `autoDownload` is off.
2. **A running shift is not in the way.** This used to be the opposite rule: the
   restart was withheld while clocked in, and the update waited for the next
   quit. The premise was wrong. The shift is Factorial's record — `clockIn` and
   `fetchOpenShift` are calls to their API — so a restart stops no timer, it
   only re-reads the shift on the way back up. The old rule protected a few
   seconds of *view* at the price of making people clock out to install.
3. **Nothing pretends.** The portable Windows build cannot replace itself: it
   unpacks to `%TEMP%` on every start and the file the user keeps is elsewhere. It
   checks anyway and offers the download page.

A fourth rule is Windows-only and lives in `restartModeFor`: **the installer is
never shown twice.** electron-updater does not install anything itself on
Windows — it spawns the downloaded `Factorial-Desktop-Setup-<version>.exe` with
`--updated` and hands it two flags that both default to *off*. With them off,
"Restart now" ran the setup wizard again — welcome, install mode, directory,
finish — for a version the user had already agreed to install, and 0.2.10 and
everything before it shipped that way. `silent` adds `/S`, which drops the pages
and takes the installation path out of the registry (`InstallLocation`) instead
of asking for it, so the silent run replaces exactly the copy that is running.
`runAfter` adds `--force-run`, and is not optional next to it: the assisted
installer starts the app from its finish page, and `/S` is what removed that
page, so without it a "restart" ends with nothing running.

macOS gets neither flag. `MacUpdater.quitAndInstall` ignores both — the swap and
the relaunch are ShipIt's — so passing Windows' answer there would only be
misleading.

The one thing this does not touch is SmartScreen. It appears on the *first*
install because the setup exe was downloaded by a browser, which marks it, and
the build is unsigned; the update installer is fetched by the app itself, never
gets that mark, and so is never asked about. Signing is the only thing that
removes the first prompt.

Two build-configuration pieces are easy to get wrong. `publish:` in
`electron-builder.yml` is not an upload target — it is what makes `app-update.yml`
exist inside the package, and without it there is no feed at all. And `latest.yml`
has to be among the release assets, because that file *is* the feed.

`verifyUpdateCodeSignature` is off on Windows: electron-updater compares the
download's signature against the running app's, and the Windows builds are
unsigned, so the check can only fail. It should be turned back on the day there
is a certificate for that platform.

macOS has no such switch, and this is the single most expensive thing to learn
about updating an Electron app late. Squirrel.Mac validates the signature of
every update, always. With `identity: null` the bundle kept the ad-hoc signature
Electron's own binary ships with — `Identifier=Electron`, no sealed resources —
and Squirrel refused every update with *code has no resources but signature
indicates they must be present*. Ad-hoc signing the bundle properly does not
rescue it either: its designated requirement is the `cdhash` of that one build,
so the next version can never satisfy the running one's. Only a real identity
produces a requirement that holds across releases:

    identifier "com.maxgiess.factorial-desktop" and anchor apple generic
      and certificate leaf[subject.OU] = "<team>"

Hence the Developer ID certificate, and hence `hardenedRuntime` with the
entitlements in `build/`, which signing brings with it.

## Language

The app speaks seven languages and picks one from the OS, falling back to English.
The catalogues live in `src/shared/locales/`, the machinery in
`src/shared/i18n.ts`.

**In `shared` because both halves need it.** The tray menu, the update dialogs
and the error table run in the main process, the widget in the renderer, and
several strings appear in both — the five state labels used to exist twice, once
per process, which is exactly the arrangement that lets two surfaces disagree
about what is on screen.

**No i18n library.** The whole surface is a lookup in a record plus
`{placeholder}` substitution. A library would bring a loader, a plural engine and
a React context to do that; the plural engine is the only part with real value
here, and this app counts hours and prints them as digits.

**English is the source, and the type system enforces the rest.** The other
catalogues are typed against it, so a missing or invented key fails the build
rather than rendering blank in a language nobody on the team reads. Three things
the tests add on top, all of them silent failures otherwise: no empty values, the
same placeholders as English in every language, and an unknown locale resolving
to English rather than to nothing.

**Region is ignored.** `pt-BR` gets the Portuguese catalogue rather than falling
through to English, which is the better of the two answers available.

**Where the wording is not just a translation.** The work-location labels are
meant to be Factorial's own words, so that somebody comparing the widget with the
web interface does not have to work out that two terms mean the same thing.
German is confirmed against a real account — `work_from_home` is "Mobiles
Arbeiten" there, not "Homeoffice". The other languages are honest translations
that nobody has checked against a Factorial account in that language; the note
sits in `src/shared/locales/es.ts` for whoever can check one.

**How the renderer knows.** The language is an ordinary setting, so it travels
with the others over the existing settings push — no channel of its own, and no
second place where the current language is remembered. Before the first settings
answer arrives, `useTranslate` falls back to the system language, which is what
`system` would have resolved to anyway; the first paint is therefore not in the
wrong language and then corrected.

## Icons

**The app icon is Factorial's own mark** on a white rounded square, generated by
`build/make-app-icon.py` from `build/factorial-logo.png`. White rather than
transparency: an app icon lands on the user's wallpaper, in Launchpad and in the
task bar, and a red glyph on nothing disappears against anything red or dark.
Factorial's own favicon does the same, so the two read as one product.

That the mark belongs to Factorial and this is not their product is worth being
aware of; the repository is public and the releases are downloadable.

The script writes both `icon.ico` and `icon.icns` with Pillow and therefore runs
on any platform. It used to shell out to `iconutil` for the `.icns`, which exists
only on macOS — so the two files could not be regenerated from one machine.

**The tray icon is the same mark, recoloured.** `resources/make-tray-icons.py`
reads the same source file and tints it: grey clocked out, emerald clocked in,
amber on a break, red when the session is gone — the widget's status-dot colours,
so the two surfaces agree.

Tinting rather than badging, because on Windows the icon's colour *is* the state:
there is no text beside it. Leaving the mark its own red in every state would
mean the tray says nothing about whether you are clocked in, which is the one
thing it is there to say. A coloured dot in the corner was the alternative and
loses at 16 px, where the whole icon is sixteen pixels and a badge would be four.

Recolouring is exact rather than approximate: the mark is a single flat colour,
so replacing every pixel's colour while keeping its alpha preserves the shape
*and* the antialiased edge, which is what makes the small sizes legible.

macOS gets the same mark as a monochrome template, and the system tints it for
light mode, dark mode and the highlighted menu bar. The state there is carried by
`tray.setTitle()` next to the icon, so one template is enough.

## Platform differences

The app runs on macOS and Windows from one codebase. Every place that behaves
differently carries a `PLATFORM:` comment, so `grep -rn "PLATFORM:" src/` finds
them all. The substantive ones:

| Topic | Difference |
|---|---|
| Tray title | `tray.setTitle()` is macOS-only; Windows uses tooltip, colour-coded icon and a disabled menu entry |
| Tray icon | The same mark either way. macOS: monochrome template, tinted by the system. Windows: four coloured `.ico` at 16/32/48 px, because there the colour is the state |
| Tray visibility | Windows 11 hides new tray icons behind the overflow chevron until the user drags one out |
| Click-through | `setIgnoreMouseEvents(… { forward: true })` delivers no mouse moves on Windows; a cursor poll in the main process stands in |
| Transparency | macOS draws rounded corners and a soft shadow itself; Windows needs a fully transparent background colour |
| Full screen | `visibleOnFullScreen` is macOS-only; on Windows `alwaysOnTop` alone carries it |
| Autostart | macOS uses the Service Management API without a path; Windows writes a Run-key entry that **must** name the executable — and for the portable build that path comes from `PORTABLE_EXECUTABLE_FILE`, not `execPath`, which points into `%TEMP%` |
| Single instance | Required on Windows: without the lock every launch starts another full instance with its own tray icon |
| Window position | Multi-monitor with mixed DPI behaves differently; stored positions are validated against the attached displays on start and on every display change |
| Packaging | DMG + ZIP against NSIS installer + portable exe |

The platform-dependent decisions are written to take their inputs as arguments
rather than reading `process.platform` themselves. That is what makes the Windows
branches testable from a Mac and vice versa.

## Testing

Vitest, on the places where being wrong is expensive:

- State derivation from every `openShift` shape, including the edge cases
- Time reconstruction, explicitly against the sentinel date `2000-01-01`
- Parsing GraphQL answers: empty `errors`, filled `errors`, HTTP 200 with errors,
  401
- The client against fixtures recorded from real responses
- The widget's five states, rendered
- The platform-dependent decisions, both branches

No end-to-end login test — somebody else's website with 2FA.

The suite needs no Electron runtime, which is why it runs on any machine and in
CI on Linux.

## Build and release

`electron-vite` for dev and build, `electron-builder` for packaging.

- **macOS:** DMG + ZIP, arm64, signed with a Developer ID certificate and
  notarized. Both are required and for different reasons: signing is what lets
  the app update itself (Squirrel validates it), notarization is what lets it
  start at all — Gatekeeper refuses a signed-but-un-notarized build, and since
  macOS 15 there is no right-click → Open around it
- **Windows:** NSIS installer + portable exe, x64, unsigned

Tagging `v*` builds both platforms in CI and attaches the artefacts to a GitHub
release. The platforms build one after another so that the second adds to the
release the first created.

## Extensibility

The cut is meant to let further Factorial features dock on:

- A new operation in `factorial/operations.ts`
- Its own store next to `attendance.ts`, if the state is independent
- A new panel in the renderer

Transport, auth and window management stay as they are.
