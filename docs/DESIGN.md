# Factorial Desktop — Design

**Datum:** 2026-08-12
**Status:** Entwurf, freigegeben

## Ziel

Eine Electron-Desktop-App, mit der man sich bei Factorial HR ein- und ausstempeln
und Pausen starten/beenden kann, ohne den Browser zu öffnen. Frameless
Floating-Widget, immer im Vordergrund, per Tray ein- und ausblendbar, mit
Live-Timer im macOS-Menubar.

Die App ist so geschnitten, dass später weitere Factorial-Funktionen
(Projektzeiten, Abwesenheiten) andocken können, ohne Transport oder State-Store
anzufassen.

### Nicht-Ziele (v1)

- **Kein Offline-Queue.** Ein fehlgeschlagener Stempelvorgang wird nicht später
  nachgeschoben. Das würde falsche Zeiten in eine Arbeitszeiterfassung schreiben.
  Die App schlägt sichtbar fehl und lädt den echten Zustand neu.
- **Kein Code-Signing / keine Notarisierung.** Beim ersten Start auf dem Mac per
  Rechtsklick → Öffnen freigeben.
- **Kein Auto-Update.**
- **Keine Windows-Verifikation.** Der Code bleibt plattformneutral und
  electron-builder erzeugt ein NSIS-Target, aber getestet wird ausschließlich
  macOS. Die Windows-Fertigstellung übernimmt ein separater Agent — siehe
  "Windows-Übergabe".
- **Keine Benachrichtigungen/Erinnerungen** ("du bist seit 9h eingestempelt").

## Die Factorial-API

Reverse-engineered am 2026-08-12 aus `app.factorialhr.com` (Interceptor im
Page-Kontext, echte Klicks auf Einstempeln → Mittagspause → Fortsetzen →
Ausstempeln) plus Schema-Introspection.

**Am 2026-08-12 vollständig gegen die Live-API nachverifiziert.** Alle vier
Mutations wurden per direktem `fetch` aus dem Seitenkontext ausgeführt
(`errors: []`), und `openShift` wurde in jedem der drei Zustände abgefragt. Die
dabei gefundenen Abweichungen vom ersten Mitschnitt sind unten jeweils als
**Korrektur** markiert — sie betreffen die Mutation-Signaturen, die
Zeitrekonstruktion und die Herkunft der Soll-Zeit.

### Transport

- **Ein Endpoint:** `POST https://api.factorialhr.com/graphql?<OperationName>`
  Der Query-String ist kosmetisch (Logging); maßgeblich ist `operationName` im Body.
- **Body:** `{ operationName, variables, query }`
- **Header:** nur `content-type: application/json`.
- **Auth: ausschließlich Session-Cookie.** Kein CSRF-Token, kein Bearer, keine
  Custom-Header. Verifiziert mit einem nackten `fetch` — HTTP 200.
- Das Session-Cookie ist **HttpOnly** und damit für JavaScript unsichtbar. Ein
  "Access-Token zum Rauskopieren" existiert nicht.
- **Introspection ist aktiviert** — das Schema kann für Codegen gezogen werden.

### Identität

```graphql
query Me {
  apiCore { currentsConnection { nodes {
    email
    employee { id fullName }
    company { id name }
  } } }
}
```

Antwort: `{ email, employee: { id: 1111111, fullName }, company: { id: 2222222, name } }`

Diese Query ist gleichzeitig der **Session-Check**: geht sie durch, ist man
eingeloggt.

> **Achtung Typ-Inkonsistenz:** `apiCore` liefert `employee.id` als **Int**, die
> Mutations erwarten `ID` (String), und `attendance.employee(id:)` verlangt
> zwingend **Int!**. Die Konvertierung muss explizit an einer Stelle passieren.

### Aktueller Zustand

```graphql
query Status($id: Int!) {
  attendance { employee(id: $id) { id openShift {
    id clockIn clockInOffset clockOut date referenceDate status
    locationType workplaceId workable
    timeSettingsBreakConfiguration { id name }
  } } }
}
```

`clockInOffset` ist für die Timer-Rekonstruktion zwingend — siehe „Fallstrick 2".
`workplaceId` liefert nebenbei den zuletzt benutzten Arbeitsplatz (beobachtet:
`3333333`) und taugt als Default fürs nächste Einstempeln.

Die Tagesliste der abgeschlossenen Shifts (für die Ist-Summe) kommt aus:

```graphql
attendanceShiftsConnection(startOn: $d, endOn: $d) { nodes {
  id date clockInWithSeconds clockInOffset clockOut minutes workable
  createdAt crossesMidnight timeSettingsBreakConfiguration { id name }
} }
```

### Pausentypen

```graphql
query BreakConfigurations {
  timeSettings {
    breakConfigurationsConnection(active: true) { nodes { id name archived } }
  }
}
```

**`active: true` ist nicht optional.** Factorial behält stillgelegte
Konfigurationen und liefert sie ungefiltert neben den aktuellen aus — mit
denselben Namen. Ohne Filter (Stand 2026-08-12, echtes Konto):

| ID | Name | `archived` | `paid` |
|---|---|---|---|
| 19613 | Mittagspause | `false` | `false` |
| 20211 | Verdienstausfall | **`true`** | `false` |
| 20261 | Arztbesuch | **`true`** | `false` |
| 21217 | Verdienstausfall | `false` | `true` |
| 21836 | Arztbesuch | `false` | `true` |

Im Menü stünden „Verdienstausfall" und „Arztbesuch" damit doppelt, ohne
sichtbaren Unterschied — und wer den falschen erwischt, bucht seine Pause gegen
eine stillgelegte Konfiguration mit dem **falschen `paid`-Flag** in eine echte
Arbeitszeiterfassung. Das ist keine Kosmetik.

> **`active: false` heißt nicht „nur archivierte", sondern „nicht filtern"** —
> es liefert alle fünf zurück. Zum Ansehen der archivierten Einträge taugt es
> nicht.

`operations.ts` filtert trotzdem zusätzlich clientseitig über `archived`, und
behandelt alles außer einem expliziten `false` als archiviert. Doppelt gemoppelt
mit Absicht: sollte `active` je seine Bedeutung ändern, hält die zweite Prüfung.

> **Nicht verwechseln:** `attendance.breakConfigurationsConnection` existiert
> ebenfalls, liefert aber andere IDs und durchgehend `name: null`. Für die
> Pausenauswahl ist ausschließlich `timeSettings` richtig.

### Mutations

Alle vier liegen unter `attendanceMutations`. Die Signaturen unten stammen aus
der Schema-Introspection und wurden am 2026-08-12 mit einem vollständigen
Live-Durchlauf (Ein → Pause → Fortsetzen → Aus, alle vier `errors: []`)
gegengeprüft.

**`now` ist das einzige Pflichtargument** — ISO8601 **mit lokalem Offset**,
z.B. `2026-08-12T01:18:23+02:00`.

> **Korrektur gegenüber dem Mitschnitt:** `date`, `startOn` und `endOn` sind
> **keine** Argumente dieser Mutations. Sie tauchten im Web-Client nur als
> deklarierte GraphQL-Variablen des Dokuments auf und gehören zu Feldern, die im
> selben Request nachgeladen werden. Mitschicken lässt das Schema sie nicht.

| Operation | Mutation-Feld | Akzeptierte Argumente (Auswahl) |
|---|---|---|
| ClockIn | `clockInAttendanceShift` | `locationType`, `workplaceId: Int`, `clockInWorkAreaId: Int`, `timeSettingsBreakConfigurationId: Int`, `workable`, `referenceDate`, `observations`, `source` |
| BreakStart | `breakStartAttendanceShift` | `timeSettingsBreakConfigurationId: Int`, **`systemCreated: Boolean!`**, `observations`, `source` |
| BreakEnd | `breakEndAttendanceShift` | `locationType`, **`systemCreated: Boolean!`**, `projectTaskId`, `projectWorkerId`, `subprojectId`, `source` |
| ClockOut | `clockOutAttendanceShift` | `clockOutWorkAreaId: Int`, `workable`, `observations`, `source` |

> **`breakStartAttendanceShift` akzeptiert kein `locationType`** — `breakEnd` und
> `clockIn` dagegen schon. Ein mitgeschicktes `locationType` lässt die
> BreakStart-Mutation mit `undefinedArgument` fehlschlagen.

Es existieren zusätzlich `breakStartAttendanceBreakShift` /
`breakEndAttendanceBreakShift`. Die werden **nicht** verwendet — der Web-Client
nutzt die `…AttendanceShift`-Variante, und nur die ist verifiziert.

**Enums:**

- `AttendanceEnumsShiftSourceEnum`: `desktop`, `mobile`, `face_recognition`,
  `qr_code`, `mobile_geolocation`, `shared_device`, `api`, `system`, `one_assistant`
- `AttendanceShiftLocationTypeEnum`: `office`, `business_trip`, `work_from_home`

Verifizierte Aufrufe:

```graphql
clockInAttendanceShift(now: $now, source: desktop, locationType: office)
breakStartAttendanceShift(now: $now, source: desktop, systemCreated: false,
                          timeSettingsBreakConfigurationId: 19613)
breakEndAttendanceShift(now: $now, source: desktop, systemCreated: false)
clockOutAttendanceShift(now: $now, source: desktop)
```

Jede Mutation gibt `{ errors, shift }` zurück — der neue Shift kommt also direkt
mit und muss nicht nachgeladen werden.

**`errors` ist `[MutationError!]!`, eine Union** und braucht Inline-Fragmente.
Ein blankes `errors` ist ein Syntaxfehler:

```graphql
errors {
  __typename
  ... on SimpleError { message type }
  ... on StructuredError { field messages }
}
```

### Zwei Fallstricke

**1. Fehler kommen in-band mit HTTP 200.** Erfolg heißt
`data.attendanceMutations.<op>.errors` ist leer. Der HTTP-Status allein sagt
nichts aus.

**2. Kein Zeitstempel der API ist ein gültiger absoluter Zeitpunkt.** Das ist der
gefährlichste Fallstrick der ganzen Integration.

`openShift.clockIn` liefert `"2000-01-01T00:11:12Z"` — korrekte Uhrzeit,
Platzhalter-Datum.

`shift.clockInWithSeconds` sieht auf den ersten Blick brauchbar aus, ist es aber
nicht. Verifiziert an einem realen Datensatz:

| | |
|---|---|
| Tatsächlich eingestempelt | `2026-08-12 00:11:12` lokal (Europe/Berlin, +02:00) |
| Also als UTC-Instant | `2026-08-11T22:11:12Z` |
| Was die API liefert | `2026-08-11T00:11:12+00:00` |

Factorial kombiniert die **UTC-Datumskomponente** (11. Aug., da 22:11 UTC) mit der
**lokalen Uhrzeit** (00:11:12) und deklariert das Ergebnis als `+00:00`. Als
Instant gelesen liegt der Wert 22 Stunden daneben.

**Korrekte Rekonstruktion:** lokales Kalenderdatum aus `shift.date`,
Uhrzeit-Komponente aus `clockInWithSeconds`, **Zonen-Offset aus `clockInOffset`**.

`clockInOffset` ist ein eigenes Feld und liefert den echten lokalen Offset
(`"+02:00"`). Damit braucht es weder die Zeitzone der laufenden Maschine noch die
frühere „liegt der Wert in der Zukunft, zieh einen Tag ab"-Heuristik — die entfällt
ersatzlos.

Gegengeprobt an einem realen Record: `AttendanceShift.createdAt` ist der einzige
**echte** UTC-Instant im ganzen Schema und dient als Kontrolle.

| Feld | Wert |
|---|---|
| `clockInWithSeconds` | `2026-08-11T09:49:05+00:00` |
| `clockInOffset` | `+02:00` |
| `shift.date` | `2026-08-11` |
| rekonstruiert | `2026-08-11T09:49:05+02:00` = `07:49:05Z` |
| `createdAt` (Kontrolle) | `2026-08-11T07:49:05Z` ✓ |

Der `+00:00`-Offset und die Datumskomponente von `clockIn*` sind **immer** zu
ignorieren.

**Für den offenen Shift gilt dieselbe Regel mit anderen Feldnamen.**
`AttendanceOpenShift` ist ein **anderer Typ** als `AttendanceShift` und kennt
weder `clockInWithSeconds` noch `minutes`. Verifizierte Form während einer
laufenden Schicht:

```jsonc
{ "id": 543343386, "date": "2026-08-12",
  "clockIn": "2000-01-01T01:18:23Z",   // Sentinel-Datum, lokale Uhrzeit, mit Sekunden
  "clockInOffset": "+02:00", "clockOut": null,
  "locationType": "office", "workplaceId": 3333333,
  "workable": true, "status": "opened", "referenceDate": "2026-08-12",
  "timeSettingsBreakConfiguration": null }
```

Also: `openShift.date` + Uhrzeit aus `openShift.clockIn` + `openShift.clockInOffset`.
Dieselbe Funktion, andere Feldnamen — sie muss beide Formen bedienen.

**3. `clockOut` gibt es nur in Minutenauflösung.** Ein `clockOutWithSeconds`
existiert nicht — das Schema kennt das Feld nicht.

**4. Eine Pause splittet den Shift in mehrere Records.** Ein Durchlauf
Einstempeln → Pause → Fortsetzen → Ausstempeln erzeugte drei Einträge mit
eigenen IDs, alle mit demselben `date`. Die Tagessumme ist also die Summe über
`minutes` aller Shifts des Tages plus die laufende Zeit des offenen Shifts —
nicht das Delta eines einzelnen Records.

## Architektur

### Entscheidung: Main-Prozess besitzt Netzwerk und State

Der Renderer ist reine UI und spricht nur über IPC.

**Begründung, in absteigender Härte:**

1. **CORS.** Der Renderer hat gegenüber `api.factorialhr.com` keinen erlaubten
   Origin; Requests von dort werden vom Browser blockiert. `net.request` im
   Main-Prozess unterliegt keiner CORS-Prüfung und hängt die Cookies der
   Session-Partition automatisch an. Das ist der einzige Weg, der funktioniert.
2. **Eine Wahrheit.** Das Tray braucht den Timer-State ohnehin im Main. Ein
   zweiter State im Renderer wäre eine dauerhafte Divergenzquelle.
3. **Isolation.** Das Session-Cookie bleibt außerhalb jedes Renderer-Kontexts.

### Verworfene Alternative

*Renderer spricht direkt mit der API.* Scheitert an CORS. Ließe sich nur mit
einem Custom-Protocol-Handler oder abgeschaltetem `webSecurity` erzwingen —
beides tauscht ein Sicherheitsmerkmal gegen nichts ein, da IPC hier ohnehin
gebraucht wird.

### Modulstruktur

```
main/
  session.ts        persist:factorial-Partition, Cookie-Lebenszyklus
  auth.ts           Login-Fenster, Session-Validierung
  factorial/
    client.ts       GraphQL-Transport über net.request
    operations.ts   die 8 Operations + Typen
  attendance.ts     State-Store: Ableitung, Polling, optimistische Updates
  tray.ts           Icon, Live-Timer, Kontextmenü
  windows.ts        Widget-, Login-, Settings-Fenster
  settings.ts       persistierte Einstellungen
  ipc.ts            typisierter IPC-Vertrag
preload/index.ts    contextBridge
renderer/           React + Tailwind v4 + shadcn/ui (Nova)
```

**Grenzen:**

- `factorial/operations.ts` ist die **einzige** Stelle, die Factorial-Semantik
  kennt. Ein neues Feature heißt: neue Operation hier, neues Panel im Renderer.
- `factorial/client.ts` kennt nur GraphQL-über-HTTP, nichts über Attendance.
- `attendance.ts` kennt keine Fenster und kein Tray — es publiziert Zustand,
  Konsumenten abonnieren.

## Auth

1. Beim Start `session.fromPartition('persist:factorial')` holen.
2. `Me`-Query über den Main-Client absetzen.
3. Erfolg → `employeeId` und `companyId` cachen, App startet normal.
4. 401 oder leere Antwort → Login-`BrowserWindow` auf `https://id.factorialhr.com`
   in derselben Partition öffnen.
5. **Auf Navigation warten, nicht pollen.** Sobald das Login-Fenster auf einem
   Factorial-Host landet, der *nicht* der Login-Host ist, einmal `Me` abfragen.
   Geht sie durch: Fenster schließen und normal weiterlaufen.

> **Während der Anmeldung stellt die App keine einzige API-Anfrage.** Das ist
> keine Optimierung, sondern eine Korrektur.
>
> Die erste Fassung fragte `Me` alle 1,5 Sekunden ab, solange das Login-Fenster
> offen war. Factorial lehnte daraufhin **jeden** Code ab — den per E-Mail
> geschickten OTP genauso wie den TOTP aus der Authenticator-App, beide mit
> „Ungültiger Code". Ein TOTP wird serverseitig aus Code, Secret und Uhrzeit
> geprüft; kein Client kann einen richtigen Code falsch machen. Wenn also beide
> Arten gleichzeitig scheitern, war nie der Code das Problem, sondern die
> Prüfanfrage fand ihre laufende Anmeldung nicht mehr.
>
> Ein Strom unauthentifizierter `Me`-Aufrufe im Sekundentakt, mit einem
> halbfertigen Auth-Cookie, gegen eine API hinter Cloudflare — das macht kein
> Browser, und es ist das Naheliegendste, was man entfernen kann.
>
> Das Prädikat dafür (`indicatesSignedIn` in `login-target.ts`) ist **positiv**
> formuliert: es sagt nur bei einem Factorial-Host außerhalb des Login-Hosts ja.
> Ein negatives „ist das noch der Login?" würde bei jedem unbekannten Umweg —
> SSO-Hop, `about:blank`, kaputte URL — mit nein antworten und genau dann eine
> Anfrage auslösen.
>
> Preis dieser Entscheidung: ändert Factorial das Ziel nach der Anmeldung, bleibt
> das Login-Fenster offen stehen. Das ist sichtbar und leicht zu finden — und
> allemal besser als eine Anmeldung, die grundsätzlich nicht durchgehen kann.

Die App **liest das Cookie nie aus und speichert keinen Token**. Chromium hält es
in der Partition, `net.request` schickt es mit. Logout = Cookies der Partition
löschen.

### Sitzung am Leben halten

Die Anmeldung hinterlässt drei Cookies. Aus einem echten Jar gelesen:

| Cookie | HttpOnly | Laufzeit |
|---|---|---|
| `_factorial_id` | ja | **2 Stunden** |
| `_factorial_id_refresh` | ja | 7 Monate |
| `_factorial_id_data` | nein | 7 Monate |

Das Cookie, auf dem die App reitet, ist also **absichtlich kurzlebig**. Angemeldet
zu bleiben heißt, den langlebigen Refresh-Cookie gegen einen frischen
Access-Cookie zu tauschen — genau das macht ein Browser-Tab im Hintergrund, und
genau deshalb bleibt Chrome den ganzen Tag eingeloggt.

Ohne diesen Tausch fiel die App etwa alle zwei Stunden aus der Sitzung und
verlangte eine vollständige Neuanmeldung samt 2FA, als wäre die Sitzung
widerrufen worden.

Der Tausch ist **ein nackter POST** — kein Body, keine Header, kein CSRF-Token,
nur der Cookie, den die Partition ohnehin hält:

```
POST https://id.factorialhr.com/api/auth/refresh
→ 401 { "success": false,
        "error": { "code": "invalid_refresh_token",
                   "message": "Ihre Sitzung ist abgelaufen. …" } }
```

**Reaktiv statt auf Timer.** Eine 401 ist das einzige verlässliche Signal, dass
der Token verbraucht ist. Eine Uhr müsste den Ablauf raten, würde über Standby
driften — und müsste die 401 für die Fälle trotzdem behandeln, in denen sie
falsch geraten hat.

Ablauf: 401 → einmal erneuern → **einmal** wiederholen. Ist auch die Wiederholung
nicht autorisiert, wird diese Antwort unverändert durchgereicht und die App tut,
was sie vorher tat — Sitzung als abgelaufen melden und Anmeldung anbieten. Eine
abgelaufene Sitzung darf niemals zu einer Schleife gegen ein HR-System werden.

Gleichzeitige 401 teilen sich **eine** Erneuerung: der Store feuert seine zwei
Queries zusammen, und zwei konkurrierende Tauschvorgänge sind der Weg, einen
rotierenden Refresh-Token selbst ungültig zu machen.

> **Widerspricht das „Mutations werden nie automatisch wiederholt"?** Nein, und
> der Unterschied ist wichtig. Die Regel zielt auf *fachliche* Fehlschläge — der
> Server hat die Anfrage geprüft und abgelehnt, oder die Antwort kam nie an. Ein
> Wiederholen erfindet dort Zeit.
>
> Eine 401 kommt nie bis zum Resolver: die Auth-Schicht weist sie vorher ab, es
> wurde nichts geschrieben, es gibt nichts zu duplizieren. Und die Wiederholung
> ist **byte-identisch** — jede Mutation trägt ihr eigenes `now`, der zweite
> Versuch schreibt also den Zeitstempel des *ursprünglichen Klicks*. Nicht zu
> wiederholen wäre die ungenauere Variante: der Nutzer klickt ein paar Sekunden
> später erneut und erfasst dann diesen späteren Moment.

Das Login-Fenster läuft mit `contextIsolation: true`, `nodeIntegration: false`
und **ohne Preload** — es lädt eine fremde Website.

### Cloudflare und der User-Agent

**Vor `api.factorialhr.com` steht Cloudflare.** Nachgewiesen am 2026-08-12 an
einem Cookie-Jar eines erfolgreichen Logins: dort liegt ein `cf_clearance`-Cookie
auf `.api.factorialhr.com`. In einer Partition, in der die Anmeldung scheiterte,
lag stattdessen nur `_factorial_id_auth_error`.

Das ist der Grund für ein Symptom, das sonst unerklärlich ist: die Anmeldung
lehnt **jeden** Code ab — den per E-Mail geschickten OTP genauso wie den
MFA-Code aus der Authenticator-App — mit „Ungültiger Code". Wenn beide Arten
gleichzeitig falsch sind, war nie der Code das Problem, sondern die
Verifikationsanfrage wird abgewiesen, bevor der Code überhaupt geprüft wird.

Electrons Standard-User-Agent trägt den Build offen im String:

```
Mozilla/5.0 (Macintosh; ...) ... Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36
```

Deshalb entfernt `applyBrowserUserAgent()` in `session.ts` das
`Electron/<version>`-Token — siehe `@shared/user-agent`. Übrig bleibt der String,
den Chromium für seine eigene Engine gebaut hat; die Chrome-Version und die
Plattform darin sind echt, nur die Build-Variante fällt weg.

Gesetzt wird das auf der **ganzen Partition**, nicht nur auf dem Login-Fenster.
Fenster und spätere API-Calls teilen sich diese Session, und einem Server für
eine Session zwei verschiedene User-Agents zu schicken ist genau die Art von
Widerspruch, die eine Session ungültig macht.

> **Beim Debuggen einer kaputten Anmeldung immer zuerst die Partition leeren.**
> Ein `_factorial_id_auth_error` aus einem gescheiterten Versuch überlebt den
> Neustart und kann den nächsten Versuch mit verunreinigen.
>
> ```
> rm -rf ~/Library/Application\ Support/factorial-desktop/Partitions/factorial
> ```
>
> Für einen Blick in den Jar reicht `sqlite3 <partition>/Cookies "select
> host_key, name from cookies"` — **ohne** die Wertespalte, die enthält die
> Session.

## Zustandsmodell

Drei Zustände, vollständig aus `openShift` abgeleitet — kein parallel gepflegtes Flag:

| `openShift` | `timeSettingsBreakConfiguration` | `workable` | Zustand |
|---|---|---|---|
| `null` | — | — | **aus** |
| gesetzt | `null` | `true` | **eingestempelt** |
| gesetzt | gesetzt | `false` | **in Pause** |

Dazu die Meta-Zustände `unknown` (vor dem ersten Laden) und `unauthenticated`.

Am 2026-08-12 live durchgespielt und bestätigt. `workable` korreliert
vollständig mit dem Pausenzustand, ist aber **redundant** — maßgeblich bleibt
`timeSettingsBreakConfiguration`, sonst gäbe es zwei Wahrheiten.

> **Das Factorial-Web-Widget ist keine verlässliche Referenz.** Beobachtet:
> Das Dashboard zeigte „In einer Pause" samt *Fortsetzen*-Button, auch nach
> Hard-Reload — während `openShift` `null` war, der zuletzt angelegte Shift
> geschlossen und der Stundenzettel `0h 00m` auswies. Der Client-Cache von
> Factorial hängt nach schnellen Zustandswechseln. **Die API ist die Wahrheit.**
> Unsere App wird in solchen Fällen bewusst vom Web-Widget abweichen; das ist
> kein Bug auf unserer Seite und darf nicht „passend" gemacht werden.

### Synchronisation

Neu geladen wird bei:

- **jeder Mutation** — die Antwort enthält den neuen Shift, wird direkt übernommen
- **alle 60 s** im Hintergrund
- **Fensterfokus** und **Tray-Öffnen**
- **`powerMonitor`-Resume** nach Standby — ohne das zeigt der Timer nach dem
  Zuklappen des MacBooks Unsinn

### Optimistische Updates

Beim Klick wird der Zielzustand sofort angezeigt und der Button gesperrt.
Kommt ein Fehler zurück, wird zurückgerollt, ein Toast gezeigt und der echte
Zustand neu geladen.

### Zeitberechnung

Der Timer zählt **nicht** selbst hoch. Bei jedem Tick wird die Differenz zu einem
rekonstruierten Startzeitpunkt neu gerechnet. Damit driftet er nicht und
übersteht Standby.

Der Startzeitpunkt wird nach der Regel aus "Fallstrick 2" gebildet: lokales
Kalenderdatum plus Uhrzeit-Komponente des API-Zeitstempels plus Zonen-Offset aus
`clockInOffset`. Für den abgeschlossenen Shift sind das `shift.date` +
`clockInWithSeconds` + `clockInOffset`, für den offenen `openShift.date` +
`openShift.clockIn` + `openShift.clockInOffset` — `AttendanceOpenShift` kennt
weder `clockInWithSeconds` noch `minutes`. Die frühere „Tagesrücksprung, falls
das Ergebnis in der Zukunft liegt"-Heuristik entfällt ersatzlos: der Offset kommt
mit den Daten, also wird nichts geraten und weder die aktuelle Uhr noch die
Zeitzone der Maschine geht ein. Diese Rekonstruktion liegt in **einer** Funktion
in `time.ts` (`reconstructInstant(localDate, apiTimestamp, offset)`) und wird
nirgends dupliziert.

Die Tagessumme ist die Summe über `minutes` aller heutigen Shifts plus die
laufende Zeit des offenen Shifts — Pausen splitten den Shift in mehrere Records.

## Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| `errors[]` nicht leer | Toast mit der Server-Message, Rollback, Reload |
| HTTP 401 | Zustand `unauthenticated`, Login-Fenster anbieten |
| Netzwerkfehler | Toast "keine Verbindung", Rollback, Reload. **Kein stiller Retry der Mutation** |
| Polling schlägt fehl | still ignorieren, letzter bekannter Zustand bleibt sichtbar, dezenter Stale-Indikator |

Eine fehlgeschlagene Mutation wird nie als Erfolg dargestellt.

## UI

**Widget:** ca. 320×210, frameless, `alwaysOnTop`, transparent abgerundet, eigene
Drag-Region. Position wird pro Monitor gemerkt.

**Aufbau** — linksbündig über die volle Kartenbreite:

- Kopfzeile: farbiger Punkt + Status (*Ausgestempelt* / *Eingestempelt* /
  *In einer Pause*), rechts daneben die Soll-Zeile
- Darunter der Timer, 42 px; die Sekunden eine Kontraststufe leiser
- Darunter der Fortschrittsbalken (6 px) über die volle Breite
- Buttons je nach Zustand:
  - aus → **Einstempeln**
  - ein → **Pause** (Dropdown mit Pausentypen) + **Ausstempeln**
  - Pause → **Fortsetzen** + **Ausstempeln**
- Fußzeile: Arbeitsort-Selector (Büro / Mobiles Arbeiten / Dienstreise). Nur in
  „Standard"; wo sie nichts zu zeigen hat, wird sie gar nicht erst gerendert —
  eine leere Zeile ist trotzdem eine Zeile, und in „Kompakt" waren das 24 px,
  die die Karte nicht hat

> **Der Ring ist einem Balken gewichen — aus Platzgründen, nicht aus Geschmack.**
> Der Ring maß 88 px bei 6 px Strich, also 67,6 px lichte Weite innen. „2:00:14"
> braucht bei 18 px rund 62 px und klebte damit schon am Strich; „10:23:45"
> braucht rund 73 px und lief beidseitig darüber hinaus. Die Zahl kleiner zu
> setzen hätte die Lesbarkeit gekostet, den Ring größer zu ziehen den
> Arbeitsort-Selector über die Unterkante gedrückt — die Karte hatte 6 px Luft.
>
> Der Balken löst beides auf einmal: er läuft über die volle Breite, gibt die
> Mitte der Karte für den Timer frei (42 px statt 18) und löst den Tag bei
> 320 px etwa viermal feiner auf, als es der Umfang eines 88-px-Rings konnte.
> Preis: das Widget sieht dem Factorial-Web-Widget nicht mehr ähnlich.
>
> **Die Sekunden tragen weniger Kontrast als der Rest der Zahl.** Bei 42 px
> tickt diese Bewegung den ganzen Tag im Augenwinkel mit — deutlich präsenter
> als bei 18 px. Gedämpft statt verkleinert: die Unruhe verschwindet, jede
> Ziffer bleibt voll lesbar.

> **Der Selector zeigt bei offener Schicht deren echten Arbeitsort, nicht die
> gespeicherte Voreinstellung.** Die Voreinstellung sagt nur, was das *nächste*
> Einstempeln benutzen würde — beides fällt auseinander, sobald jemand über das
> Web oder das Handy einstempelt. Die erste Fassung zeigte „Büro" für eine
> Schicht, die auf „Mobiles Arbeiten" lief: eine Absicht als Tatsache dargestellt.
> Nur wenn die API zur offenen Schicht keinen Ort liefert, greift die
> Voreinstellung als Rückfall — dann gibt es nichts Wahreres zu zeigen.
>
> Deshalb trägt auch der Pausenzustand den `locationType` mit: eine Pause wählt
> keinen neuen Ort, sie erbt den der unterbrochenen Schicht.
>
> **Die Beschriftungen sind Factorials eigene Wörter**, keine eigene Übersetzung.
> `work_from_home` heißt dort **„Mobiles Arbeiten"** (am echten Konto bestätigt),
> nicht „Homeoffice" — wer Widget und Weboberfläche nebeneinander legt, soll
> nicht erst übersetzen müssen.

### Während einer Pause zeigt der Timer die Pause

Die große Zahl ist in der Pause die **Dauer der Pause**, nicht die Tagessumme.
Der Punkt und der Balken sind amber, die Statuszeile nennt die Pause beim Namen
(„Pause · Mittagspause"), und die Tagessumme rückt nach oben neben den Status
(„Gearbeitet 07:23").

Vorher stand dort die Tagessumme — die während einer Pause stillsteht. Eine
große Zahl, die sich nicht mehr bewegt, liest sich als hängengebliebene App,
nicht als unterbrochene Schicht; die Pausendauer war in eine Fußzeile verbannt,
die so leise war, dass niemand die beiden verband.

**Der Tray macht das seit jeher so** (`primaryMs` in `tray-menu.ts`, mit dem
Kommentar „showing it counting up would be a lie"). Das Widget war die einzige
Oberfläche, die widersprach.

Das Wort „Pause" steht vor dem Namen und nicht nur der Name da: der amber Punkt
sagt bereits „pausiert", aber eine Pause namens „Arztbesuch" ließe damit die
Farbe als einzigen Träger dieser Information zurück, und Farbe darf nie der
einzige Träger sein.

Auf „Fortsetzen" übernimmt die Tagessumme die Zahl wieder und läuft weiter.

**Farbcodierung:** grün = eingestempelt, amber = Pause, neutral = ausgestempelt.

**Stack:** React + TypeScript, Tailwind v4, shadcn/ui im **Nova**-Stil. Genutzte
Komponenten: Button, DropdownMenu, Select, Tooltip, Badge, Sonner.

Der Arbeitsort merkt sich die letzte Wahl und wird beim Einstempeln als
`locationType` + `workplaceId` mitgeschickt.

### Soll-Zeit und Fortschrittsbalken — geklärt

Die Tages-Soll-Zeit kommt aus `attendanceEstimatedTimes`:

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

Reale Antwort für den 2026-08-12:

```jsonc
{ "date": "2026-08-12", "expectedMinutes": 480, "minutes": 480,
  "regularMinutes": 480, "overtimeMinutes": 0, "absencesMinutes": 0,
  "contractMinutes": 720, "timeUnit": "minute", "source": "contract_hours" }
```

`expectedMinutes: 480` ist die „Verbleibende Zeit 08:00" des Web-Widgets,
gegengeprüft mit dem Stundenzettel („0h 00m / 8h 00m" für den 12.8.).

**Nicht `contractMinutes` verwenden** — das sind 720 und meint etwas anderes.
**Nicht `minutes` aus dieser Query als Ist-Zeit verwenden** — der Wert stand bei
0 gearbeiteten Minuten ebenfalls auf 480. Die Ist-Zeit wird weiterhin aus der
Summe über `shift.minutes` des Tages plus laufender Zeit gebildet.

An freien Tagen bzw. bei Abwesenheit ist mit `expectedMinutes: 0` oder einem
leeren `nodes`-Array zu rechnen; dann entfällt der Soll-Vergleich und die Karte
zeigt reine Ist-Zeit.

**Der Balken entfällt dann ganz, er wird nicht leer gezeichnet.** Ein leerer
Balken ist nicht neutral — er behauptet „0 % von etwas", und dieses Etwas gibt
es an einem Tag ohne Soll nicht. Dieselbe Regel, aus der auch der Timer vor der
ersten Antwort ein Strich ist und keine 0:00:00. Das gilt genauso vor dem ersten
Snapshot: ohne bekannte Ist-Zeit gibt es nichts, wovon der Balken ein Bruchteil
wäre.

**Über dem Soll wechselt die Zeile von „Verbleibende Zeit 00:00" zu
„Soll erfüllt · +H:MM".** Die alte Angabe stimmte, nannte aber das
Uninteressante: nicht, dass nichts mehr übrig ist, sondern wie viel schon
darüber. Der Wechsel hängt an den *gerundeten* Überminuten, damit die Zeile nie
im Widerspruch zu dem steht, was sie druckt — eine Zehntelminute über dem Soll
zeigt weiterhin „Verbleibende Zeit 00:00" statt ein „+0:00", das wie ein Fehler
aussieht.

## Tray

**macOS:** Template-Icon (passt sich Light/Dark an) plus `tray.setTitle()` mit dem
laufenden Timer im Menubar.

**Windows:** `setTitle` existiert dort nicht. Stattdessen farbcodiertes Icon +
Tooltip mit der Zeit; im Kontextmenü steht die Zeit als erster, deaktivierter
Eintrag. **Der Live-Timer im Menubar bleibt ein macOS-Feature.**

**Kontextmenü:** Ein-/Ausstempeln, Pause (Untermenü mit den Typen) bzw.
Fortsetzen, Fenster zeigen/verstecken, Einstellungen, Beenden. Die Aktionen
funktionieren, ohne das Fenster zu öffnen.

Fenster schließen blendet aus statt zu beenden; beendet wird nur über das Tray.

## Einstellungen

- Autostart beim Login (Standard: an, `app.setLoginItemSettings`)
- Always-on-Top an/aus
- Größe: Standard (Vorgabe) / Kompakt / Minimal
- Erscheinungsbild: Systemvorgabe (Standard) / Hell / Dunkel
- Abmelden (Partition-Cookies löschen)

Persistiert als JSON in `app.getPath('userData')`.

### Größe

Drei Größen, keine drei Skins derselben Anordnung — jede lässt weg, was die
nächstkleinere nicht mehr trägt:

| | Karte | Fläche | Was fehlt |
|---|---|---|---|
| Standard | 340 × 224 | 76.160 px² | — |
| Kompakt | 300 × 126 | 37.800 px² | Arbeitsort-Selector |
| Minimal | 156 × 44 | 6.864 px² | alle Aktionen; Karte klappt auf |

Gespart wird über die **Höhe**. Die Breite braucht die Zahl: „10:23:45" misst bei
42 px 178 px — daran ist der frühere Fortschrittsring gescheitert. Die Höhe ging
dagegen fast vollständig für Dinge drauf, die nicht die Zeit sind.

Die Maße stehen in `src/shared/widget-size.ts`, zusammen mit der Rechnung, die
daraus die Fenstergröße macht.

**Kompakt verliert etwas Konkretes:** ohne Selector zeigt das Widget bei
laufender Schicht nicht mehr deren tatsächlichen Arbeitsort. Genau dieser Fehler
wurde weiter oben behoben („Der Selector zeigt bei offener Schicht deren echten
Arbeitsort"). In Kompakt ist die Angabe nicht falsch, sondern abwesend — das ist
der Unterschied, der sie vertretbar macht.

#### Fenster ≠ Karte

Für Minimal ist das Fenster **größer als die sichtbare Karte** und drumherum
durchsichtig. Der Grund ist die Animation: eine `BrowserWindow`-Größe ändert nur
der Main-Prozess mit `setSize()`, Frame für Frame über die IPC-Grenze, und dort
interpoliert nichts. Eine Feder wäre da ohnehin unmöglich — ihr Überschwinger
bräuchte Fenstergrößen jenseits des Ziels.

Also bleibt das Fenster stehen und nur das `div` darin wächst, als
CSS-Transition auf dem Compositor. Das Fenster hält den Platz vor, in den der
Überschwinger geht: 13 % über die Zielgröße, also 320 × 137 statt 300 × 126.
Ohne diesen Spielraum wird die Spitze abgeschnitten und die Feder ist lautlos
weg.

Der Preis ist der unsichtbare Rand. Er würde Klicks schlucken, die dem Desktop
dahinter galten — bei einem Fenster, das immer im Vordergrund liegt. Deshalb
macht der Main-Prozess das Fenster durchlässig (`setIgnoreMouseEvents(true,
{ forward: true })`), und der Renderer fordert die Klicks zurück, sobald der
Zeiger über der Karte ist. `forward: true` ist dabei das, was die Sache
umkehrbar macht: nur weil das durchlässige Fenster weiterhin Mausbewegungen
bekommt, merkt der Renderer die Ankunft überhaupt.

#### Aufklappen

Minimal hat keine Aktionen. Ein 20-px-Knopf neben der Zahl klappt die Karte auf
die Kompakt-Größe auf; das Tray-Menü bietet Ein-/Ausstempeln, Pause und
Fortsetzen ohnehin durchgehend an.

**Der Knopf ist erzwungen, nicht gewählt.** `-webkit-app-region: drag` schluckt
Mausereignisse vollständig — eine Karte, die man verschieben kann, kann man
nicht anklicken. Verschieben wiegt bei einem schwebenden Fenster schwerer, also
bleibt die Karte Drag-Region und bekommt einen eigenen Knopf. Die 8 px Breite,
die Minimal über den Inhalt hinaus misst, sind genau das.

Die verborgenen Zeilen bleiben die ganze Zeit im DOM — sonst gäbe es nichts
einzublenden — sind eingeklappt aber `inert` und `aria-hidden`. Ohne das läuft
die Tabulatortaste in ein unsichtbares „Ausstempeln", und Enter beendet eine
Schicht, von der auf dem Bildschirm nichts zu sehen ist.

**`inert` reicht dafür nicht, und `pointer-events: none` auch nicht.**
`-webkit-app-region` löst Chromiums Fenster-Hit-Testing auf, nicht die
Ereignisverarbeitung — eine unsichtbare Zeile mit `no-drag` bleibt eine
`no-drag`-Fläche. Die eingeklappte Karte ließ sich deshalb nur an einem 14 px
schmalen Streifen am linken Rand anfassen: genau links von der absolut
positionierten Aktionszeile. Eine Regel unter `[data-open='false']` gibt die
Fläche zurück, für den Container *und* für die Buttons darin — letztere werden
von `.drag-region button` einzeln erwischt und brauchen einen eigenen Selektor.

Der Aufklapp-Knopf liegt außerhalb dieser Zeilen und behält deshalb sein
`no-drag`. Das ist die einzige Stelle der eingeklappten Karte, die klickt statt
zu ziehen — und der Grund, warum sie außerhalb liegen muss.

#### Die Feder

Zwei Kurven, absichtlich verschieden (`--spring-out`, `--spring-back` in
`styles.css`): ein gedämpfter Schwinger, in 33 Stützstellen als `linear()`
ausgerechnet.

Eine Feder schwingt in **beide** Richtungen über. Nach draußen heißt das größer
als die Zielgröße — das ist der Schwung. Zurück heißt es kleiner als die
**Ruhegröße**, und die kennt das Auge bereits; derselbe Effekt liest sich dort
als Zucken statt als Leben. Bei Dämpfung 0,55 auf dem Rückweg tauchte die Karte
auf 130 × 34 px durch und `overflow: hidden` schnitt die Zahl an.

Deshalb: 0,55 hinaus (520 ms), 0,56 zurück über kürzere 420 ms. Der Rückweg
landet damit bei rund 34 px — knapp über den 33 px, die die eingeklappte Zahl
braucht. Die Deckkraft federt nie mit: ein Überschwinger unter 0 oder über 1
wird abgeschnitten, und der Schnitt liest sich als Hänger.

### Erscheinungsbild

Der gespeicherte Wert wird auf `nativeTheme.themeSource` gelegt — das ist der
ganze Mechanismus. Chromium meldet ihn jedem Renderer dieser App als
`prefers-color-scheme`, und `styles.css` definiert seine dunklen Tokens unter
genau dieser Media Query. Es gibt deshalb **keinen** Theme-State in React, keinen
Provider und keinen IPC-Kanal dafür: nichts, was mit der Einstellung ausser Takt
geraten könnte.

Die drei Werte von `ThemeSetting` sind genau die drei von `themeSource`, deshalb
braucht die Verdrahtung keine Übersetzungstabelle — und deshalb prüfen sowohl
der Settings-Store als auch die IPC-Schicht den Wert gegen die Whitelist:
`themeSource` wirft bei allem anderen, und eine von Hand editierte
Einstellungsdatei darf den nächsten Start nicht verhindern.

> **Vorher war das dunkle Design unerreichbar.** `styles.css` hatte die
> shadcn-Voreinstellung `@custom-variant dark (&:is(.dark *))` und legte seine
> Tokens unter `.dark` ab — eine Klasse, die niemand je gesetzt hat. `next-themes`
> war installiert, aber nur `sonner.tsx` importierte es, und einen `ThemeProvider`
> gab es nicht. Die dunklen Farben standen vollständig da und wurden nie
> gerendert. Der Wechsel auf die Media Query behebt das an der Wurzel: die
> Klasse musste jemand setzen, die Media Query muss niemand setzen.

`themeSource` startet in jedem Prozess bei `'system'`, deshalb wendet `index.ts`
den gespeicherten Wert einmal beim Start an — genau wie beim Login-Item. Der
Store meldet nur *Änderungen*, und ein Start ist keine.

## Testing

Vitest auf die Stellen, an denen Fehler teuer sind:

- Zustandsableitung aus allen `openShift`-Varianten inklusive der Grenzfälle
- Zeitberechnung, explizit gegen das Sentinel-Datum `2000-01-01`
- Parsing von GraphQL-Antworten: leere `errors`, gefüllte `errors`, HTTP 200 mit
  Fehlern, 401
- Der Client läuft gegen Fixtures aus den echten aufgezeichneten Responses

Kein E2E-Login-Test — fremde Website mit 2FA.

## Build

`electron-vite` für Dev und Build, `electron-builder` fürs Packaging.

- **macOS:** DMG + ZIP, arm64 (unsigniert)
- **Windows:** NSIS-Target konfiguriert, aber nicht verifiziert

## Windows-Übergabe

Die Windows-Fertigstellung übernimmt ein eigener Agent auf einer Windows-Maschine,
**ohne Zugriff auf diesen Gesprächsverlauf**. Der gesamte Kontext muss deshalb im
Repository liegen. Das ist ein harter Deliverable dieser Implementierung, kein
Nice-to-have.

### Deliverable: `docs/WINDOWS.md`

Wird während der Implementierung geschrieben, nicht nachträglich — jede
plattformabhängige Entscheidung wird festgehalten, wenn sie getroffen wird.
Inhalt:

**1. Einstieg ohne Vorwissen**
Was die App tut, wie sie aufgebaut ist, Verweis auf dieses Design-Doc, wie man
Dev-Modus und Build startet, wo die Einstiegspunkte liegen.

**2. Vollständige Liste aller plattformabhängigen Stellen**
Jede Verzweigung nach `process.platform` mit Datei, Zeile, Begründung und was auf
Windows zu prüfen ist. Diese Liste ist maschinell nachvollziehbar zu halten: jede
solche Stelle bekommt im Code einen `// PLATFORM:` Kommentar, damit ein `grep`
sie alle findet und nichts stillschweigend verloren geht.

**3. Die bekannten Windows-Themen im Detail**

| Thema | Was auf Windows anders ist |
|---|---|
| Tray-Titel | `tray.setTitle()` ist macOS-only. Windows braucht Tooltip + farbcodiertes Icon + Zeit als deaktivierten Menüeintrag |
| Tray-Icon | macOS: Template-PNG @1x/@2x, monochrom. Windows: `.ico` mit 16/32/48 px, farbig, DPI-abhängig |
| Frameless & Transparenz | Keine macOS-Vibrancy. Abgerundete Ecken, Schatten und Resize-Verhalten unterscheiden sich; `thickFrame` und `transparent` interagieren anders |
| Always-on-Top | Die Level-Namen sind plattformspezifisch; macOS-Panel-Level existieren so nicht |
| Autostart | macOS `setLoginItemSettings` vs. Windows Registry-Run-Key. Im gepackten Zustand müssen `path` und `args` explizit gesetzt werden |
| Single-Instance | Auf Windows zwingend `requestSingleInstanceLock()` plus `second-instance`-Handler, sonst startet die App mehrfach |
| Fensterposition | Multi-Monitor mit gemischten DPI-Skalierungen verhält sich anders; gespeicherte Positionen müssen gegen aktuelle Displays validiert werden |
| Schließen-Verhalten | Erwartungshaltung "X schließt die App" ist auf Windows stärker als auf macOS |
| Packaging | NSIS statt DMG, andere Artefaktnamen, `appId`, Installer-Optionen |

**4. Was auf macOS verifiziert wurde und was nicht**
Explizite Trennung: was nachweislich läuft, was nur kompiliert, was
ungetesteter Code ist. Keine impliziten Erfolgsbehauptungen.

**5. Wie man die Factorial-API selbst weiter erforscht**
Die Methode, mit der diese Spec entstanden ist, reproduzierbar dokumentiert.

Die **Introspection ist der schnellere Weg** und sollte der erste Griff sein:
In einer eingeloggten Session genügt ein direkter `fetch` aus dem Seitenkontext,
weil die API `credentials: 'include'` cross-origin akzeptiert.

```js
const gql = async (query, variables = {}, op = 'X') =>
  (await fetch('https://api.factorialhr.com/graphql?' + op, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationName: op, variables, query }),
  })).json()

// Felder eines Typs auflisten:
await gql(`query T($n:String!){ __type(name:$n){ fields {
  name args { name } type { kind name ofType { kind name } } } } }`,
  { n: 'AttendanceEmployee' }, 'T')
```

So wurden `attendanceEstimatedTimes.expectedMinutes`, `clockInOffset` und die
korrigierten Mutation-Signaturen gefunden — ohne jeden Interceptor.

**Zum Mitschneiden echter Requests:** `window.fetch` zu patchen bringt bei
Factorial **nichts**, auch nicht im Main World. Die App hält eine Referenz auf
`fetch`, die vor jedem nachträglichen Patch aufgelöst wurde; ein installierter
Wrapper fängt null Requests. Wer echte Requests sehen muss, patcht vor dem
Laden der App-Bundles oder nutzt die DevTools direkt. Für Feld-Discovery ist das
aber gar nicht nötig — Introspection reicht.

**6. Offene Punkte und Verdachtsmomente**
Alles, was beim Bauen auffiel, aber nicht auf macOS entschieden werden konnte.

### Regel für die Implementierung

Windows-Code wird **mitgeschrieben, nicht wegabstrahiert**. Wo eine Verzweigung
nötig ist, kommt sie sofort rein, mit `// PLATFORM:` markiert und in
`docs/WINDOWS.md` vermerkt — auch wenn der Zweig hier nicht getestet werden kann.
Ein leerer Windows-Pfad, der später "noch gebaut werden muss", ist schlechter als
ein plausibler ungetesteter, weil er im Code unsichtbar ist.

## Erweiterbarkeit

Der Schnitt ist darauf ausgelegt, dass weitere Factorial-Features andocken:

- Neue Operation in `factorial/operations.ts`
- Eigener Store neben `attendance.ts`, falls der Zustand unabhängig ist
- Neues Panel im Renderer

Transport, Auth und Fensterverwaltung bleiben unverändert.
