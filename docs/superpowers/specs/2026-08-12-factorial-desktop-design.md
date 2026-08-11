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
    id clockIn clockOut date locationType workplaceId workable
    timeSettingsBreakConfiguration { id name }
  } } }
}
```

### Pausentypen

```graphql
query BreakConfigurations {
  timeSettings { breakConfigurationsConnection { nodes { id name } } }
}
```

Beobachtet: `19613 Mittagspause`, `20211 Verdienstausfall`, `20261 Arztbesuch`,
`21217 Verdienstausfall`, `21836 Arztbesuch`.

> **Nicht verwechseln:** `attendance.breakConfigurationsConnection` existiert
> ebenfalls, liefert aber andere IDs und durchgehend `name: null`. Für die
> Pausenauswahl ist ausschließlich `timeSettings` richtig.

### Mutations

Alle vier liegen unter `attendanceMutations`. Gemeinsame Variablen:

- `now` — ISO8601 **mit lokalem Offset**, z.B. `2026-08-12T00:11:12+02:00`
- `date` / `startOn` / `endOn` — lokales `YYYY-MM-DD`
- `source` — `"desktop"` (offizieller Enum-Wert von `AttendanceEnumsShiftSourceEnum`)

| Operation | Mutation-Feld | Zusätzliche Variablen |
|---|---|---|
| ClockIn | `clockInAttendanceShift` | `locationType`, `workplaceId`, `clockInWorkAreaId`, `projectTaskId`, `projectWorkerId`, `subprojectId`, `timeSettingsBreakConfigurationId` |
| BreakStart | `breakStartAttendanceShift` | `timeSettingsBreakConfigurationId`, `systemCreated: false` |
| BreakEnd | `breakEndAttendanceShift` | `projectTaskId`, `projectWorkerId`, `subprojectId`, `systemCreated: false` |
| ClockOut | `clockOutAttendanceShift` | — |

Beobachtete Variablen (echte Requests):

```jsonc
// ClockIn
{"now":"2026-08-12T00:11:12+02:00","date":"2026-08-12","source":"desktop","locationType":"office"}
// BreakStart
{"now":"...","date":"...","source":"desktop","locationType":"office",
 "timeSettingsBreakConfigurationId":"19613","startOn":"2026-08-12","endOn":"2026-08-12"}
// ClockOut
{"now":"...","date":"...","source":"desktop","startOn":"2026-08-12","endOn":"2026-08-12"}
```

Jede Mutation gibt `{ errors, shift }` zurück — der neue Shift kommt also direkt
mit und muss nicht nachgeladen werden.

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

**Korrekte Rekonstruktion:** lokale Kalenderdatum aus `shift.date` nehmen, die
Uhrzeit-Komponente aus `clockInWithSeconds`, und beides in der **lokalen**
Zeitzone zusammensetzen. Ergibt der Wert einen Zeitpunkt in der Zukunft, einen
Tag abziehen — das deckt über Mitternacht laufende Schichten ab
(`crossesMidnight` / `isOvernight` sind als Flags vorhanden).

Der `+00:00`-Offset und die Datumskomponente von `clockIn*` sind **immer** zu
ignorieren.

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
5. Parallel die `Me`-Query pollen. Sobald sie durchgeht, Login-Fenster schließen
   und normal weiterlaufen.

Die App **liest das Cookie nie aus und speichert keinen Token**. Chromium hält es
in der Partition, `net.request` schickt es mit. Logout = Cookies der Partition
löschen.

Das Login-Fenster läuft mit `contextIsolation: true`, `nodeIntegration: false`
und **ohne Preload** — es lädt eine fremde Website.

## Zustandsmodell

Drei Zustände, vollständig aus `openShift` abgeleitet — kein parallel gepflegtes Flag:

| `openShift` | `timeSettingsBreakConfiguration` | Zustand |
|---|---|---|
| `null` | — | **aus** |
| gesetzt | `null` | **eingestempelt** |
| gesetzt | gesetzt | **in Pause** |

Dazu die Meta-Zustände `unknown` (vor dem ersten Laden) und `unauthenticated`.

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

Der Startzeitpunkt wird nach der Regel aus "Fallstrick 2" gebildet: `shift.date`
plus Uhrzeit-Komponente aus `clockInWithSeconds`, in lokaler Zeitzone, mit
Tagesrücksprung falls das Ergebnis in der Zukunft liegt. Diese Rekonstruktion
liegt in **einer** Funktion in `time.ts` und wird nirgends dupliziert.

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

**Aufbau** (angelehnt an das Factorial-Web-Widget):

- Statuszeile mit farbigem Punkt: *Ausgestempelt* / *Eingestempelt* / *In einer Pause*
- Darunter "Verbleibende Zeit HH:MM"
- Fortschrittsring (SVG) mit großem Timer in der Mitte
- Buttons je nach Zustand:
  - aus → **Einstempeln**
  - ein → **Pause** (Dropdown mit Pausentypen) + **Ausstempeln**
  - Pause → **Fortsetzen** + **Ausstempeln**
- Fußzeile: Arbeitsort-Selector (Büro / Homeoffice / Dienstreise), bei aktiver
  Pause zusätzlich der Pausenname

**Farbcodierung:** grün = eingestempelt, amber = Pause, neutral = ausgestempelt.

**Stack:** React + TypeScript, Tailwind v4, shadcn/ui im **Nova**-Stil. Genutzte
Komponenten: Button, DropdownMenu, Select, Tooltip, Badge, Sonner.

Der Arbeitsort merkt sich die letzte Wahl und wird beim Einstempeln als
`locationType` + `workplaceId` mitgeschickt.

### Offen: Soll-Zeit und Fortschrittsring

Die gearbeitete Zeit liegt vor (`shift.minutes`, plus laufende Zeit aus
`clockInWithSeconds`). **Die Tages-Soll-Zeit ist noch nicht verifiziert.** Das
Web-Widget zeigt "Verbleibende Zeit 08:00", die zugehörige Query wurde beim
Mitschnitt nicht erfasst — Kandidaten sind `ClockInWidget`,
`TimesheetLastWorkingShift` oder ein Work-Schedule-Feld.

Erster Implementierungsschritt für dieses Feature ist deshalb eine kurze
Discovery per Introspection und Interceptor, mit derselben Methode wie bei den
Mutations. Findet sich keine saubere Quelle, fällt der Ring auf reine
Ist-Zeit-Anzeige ohne Soll-Vergleich zurück; der Rest der App ist davon nicht
betroffen.

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
- Abmelden (Partition-Cookies löschen)

Persistiert als JSON in `app.getPath('userData')`.

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
Die Methode, mit der diese Spec entstanden ist, reproduzierbar dokumentiert:
Interceptor in den Page-Kontext injizieren (ein Content-Script in der isolierten
Welt reicht **nicht** — `window.fetch` dort zu patchen hat keine Wirkung),
Rückkanal über ein verstecktes DOM-Element, plus Schema-Introspection. Damit kann
der Windows-Agent fehlende Queries selbst nachziehen.

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
