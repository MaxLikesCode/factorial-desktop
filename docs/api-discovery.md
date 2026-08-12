# Factorial-API erforschen

Wie die API-Spezifikation in `docs/DESIGN.md` entstanden ist — reproduzierbar,
damit ein späterer Agent ein fehlendes Feld selbst findet, statt zu raten.

> **Warnung:** Die Mutations schreiben in eine echte Arbeitszeiterfassung. Beim
> Experimentieren nur Queries absetzen; jede Mutation erzeugt einen realen
> Eintrag, der von Hand wieder korrigiert werden muss.

## Introspection ist der schnelle Weg

Das Schema ist offen, und die API akzeptiert `credentials: 'include'`
cross-origin. In einer eingeloggten Session (Tab auf `app.factorialhr.com`,
DevTools-Konsole) reicht deshalb ein nackter `fetch` aus dem Seitenkontext —
kein Interceptor, keine Erweiterung, kein Token.

```js
const gql = async (query, variables = {}, op = 'X') =>
  (await fetch('https://api.factorialhr.com/graphql?' + op, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationName: op, variables, query }),
  })).json()

// Felder eines Typs samt Argumenten auflisten:
await gql(`query T($n:String!){ __type(name:$n){ fields {
  name args { name } type { kind name ofType { kind name } } } } }`,
  { n: 'AttendanceEmployee' }, 'T')
```

So wurden `attendanceEstimatedTimes.expectedMinutes`, `clockInOffset` und die
korrigierten Mutation-Signaturen (K1–K5 in `docs/PLAN.md`) gefunden.

Nützliche Einstiege:

- Root-Felder: `query { __schema { queryType { fields { name } } } }`
- Ein Typ: `query { __type(name: "attendance") { fields { name } } }`
- Argumente einer Mutation:
  `__type(name: "AttendanceMutations") { fields { name args { name } } }`

## Requests mitschneiden bringt nichts

`window.fetch` zu patchen fängt bei Factorial **null Requests** — auch im Main
World. Die App hält eine Referenz auf `fetch`, die vor jedem nachträglichen Patch
aufgelöst wurde. Ein Content-Script in der isolierten Welt hat ohnehin keine
Wirkung auf die Seite. Wer echte Requests sehen muss, patcht vor dem Laden der
App-Bundles oder nimmt die DevTools. Für Feld-Discovery ist beides unnötig.

## Bekannte Typ-Fallen

- `attendance.employee(id:)` verlangt **Int!**. `apiCore` liefert `employee.id`
  ebenfalls als Int, die Mutation-Ids sind **Int**, nicht `ID`/String.
- Die vier Attendance-Mutations nehmen **nur `now`**. `date`, `startOn`, `endOn`
  sind keine Argumente — sie gehören zu den Connections.
- `errors` ist eine Union; ein bares `errors { message }` parst nicht.
- Pausentypen nur über `timeSettings`, nicht über `attendance`.
- Kein `clock*`-Zeitstempel ist ein Instant. Immer `date` + Uhrzeit +
  `clockInOffset` kombinieren (`reconstructInstant` in `src/shared/time.ts`).

## Die Soll-Zeit im Besonderen (Task 13)

`attendanceEstimatedTimesConnection(startOn:, endOn:)` liefert pro Tag einen
Knoten. Reale Antwort für den 2026-08-12 bei **0 gearbeiteten Minuten**:

```jsonc
{ "date": "2026-08-12", "expectedMinutes": 480, "minutes": 480,
  "regularMinutes": 480, "overtimeMinutes": 0, "absencesMinutes": 0,
  "contractMinutes": 720, "source": "contract_hours" }
```

Drei Lehren aus genau diesem Knoten:

1. **`expectedMinutes` ist das Tagessoll** (480 = 8 h, gegen den Stundenzettel
   „0h 00m / 8h 00m" gegengeprüft).
2. **`contractMinutes` ist es nicht** — 720 bei einem Soll von 480.
3. **`minutes` aus dieser Query ist keine Ist-Zeit** — der Wert stand bei null
   gearbeiteten Minuten ebenfalls auf 480. Die Ist-Zeit bleibt die Summe über
   `shift.minutes` des Tages plus die laufende Zeit des offenen Shifts.

An freien Tagen ist mit `expectedMinutes: 0` oder einem leeren `nodes`-Array zu
rechnen. Beides heißt „kein Soll" und wird nicht mit acht Stunden aufgefüllt.
