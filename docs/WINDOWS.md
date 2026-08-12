# Factorial Desktop — Windows-Übergabe

**Status:** wächst mit der Implementierung. Stand: Ende Task 8 (IPC-Vertrag und
Preload). Tasks 9–15 tragen hier weiter ein.

Dieses Dokument ist für einen Agenten geschrieben, der auf einer Windows-Maschine
weiterarbeitet und **den Gesprächsverlauf dieser Implementierung nicht kennt**.
Alles, was zum Weiterarbeiten nötig ist, steht im Repository.

## 1. Einstieg ohne Vorwissen

Die App ist ein Electron-Desktop-Client für die Zeiterfassung von Factorial HR:
Einstempeln, Pause, Fortsetzen, Ausstempeln — ohne den Browser zu öffnen.

- **Architektur und API-Referenz:** `docs/DESIGN.md`. Das ist die maßgebliche
  Spezifikation, inklusive der live verifizierten GraphQL-Operationen und der
  Zeit-Fallstricke. Bei Widerspruch gewinnt dieses Dokument.
- **Umsetzungsplan:** `docs/PLAN.md`, Task für Task. Die beiden Blöcke ganz oben
  („Verifizierte API-Korrekturen K1–K11", „Carry-Forwards aus Tasks 1–5")
  überschreiben widersprechende Code-Schnipsel weiter unten im Plan.

**Befehle:**

| | |
|---|---|
| `npm install` | Abhängigkeiten |
| `npm run dev` | electron-vite im Dev-Modus (Main + Preload + Renderer mit HMR) |
| `npm test` | Vitest, ohne Electron-Laufzeit |
| `npm run typecheck` | `tsconfig.node.json` (Main/Preload/Shared) + `tsconfig.web.json` (Renderer) |
| `npm run build` | Typecheck + electron-vite build nach `out/` |
| `npm run package:win` | Build + electron-builder NSIS (**nie ausgeführt**) |

**Einstiegspunkte:**

| Datei | Rolle |
|---|---|
| `src/main/index.ts` | Lifecycle, Single-Instance-Lock, Verdrahtung, Bootstrap |
| `src/main/session.ts` | Partition `persist:factorial`, netzwerkfähiges `fetch`, Logout |
| `src/main/session-fetch.ts` | Timeout-Adapter über `ses.fetch` (Electron-frei, getestet) |
| `src/main/auth.ts` | Login-`BrowserWindow` (Electron-Teil) |
| `src/main/auth-flow.ts` | Login-Ablauf ohne Electron (getestet) |
| `src/main/factorial/client.ts` | GraphQL-Transport |
| `src/main/factorial/operations.ts` | die konkreten Operationen, einzige Stelle mit Factorial-Semantik |
| `src/main/attendance.ts` | Store: Polling, optimistische Updates, Snapshot |
| `src/main/ipc.ts` | Registrierung der Kanäle auf `ipcMain`, Snapshot-Push in die Fenster (Electron-Teil) |
| `src/main/ipc-handlers.ts` | was hinter jedem Kanal passiert: Payload-Prüfung, Fehler-Klassifizierung (Electron-frei, getestet) |
| `src/preload/index.ts` | `contextBridge` — die einzigen zehn Funktionen, die der Renderer sieht |
| `src/shared/ipc-contract.ts` | Kanalnamen, Snapshot-Serialisierung, Fehler-Codec (von Main **und** Renderer benutzt) |
| `src/shared/time.ts` | Zeitrekonstruktion (der gefährlichste Code im Repo) |
| `src/shared/attendance-state.ts` | Zustandsableitung aus `openShift` |

## 2. Vollständige Liste der plattformabhängigen Stellen

Jede Verzweigung trägt im Code einen `// PLATFORM:`-Kommentar.
`grep -rn "// PLATFORM:" src/` liefert die vollständige Liste — diese Tabelle ist
die erklärte Fassung davon und muss mit dem Grep-Ergebnis übereinstimmen.

| Datei:Zeile | Was | Warum | Auf Windows zu prüfen |
|---|---|---|---|
| `src/main/index.ts:111` | `app.requestSingleInstanceLock()`, sonst `app.quit()` | Ohne Lock startet auf Windows bei jedem Aufruf eine zweite komplette Instanz, inklusive zweitem Tray-Icon und zweitem Poll-Loop. Auf macOS übernimmt das die Plattform. | Zweiten Start auslösen (Verknüpfung, Autostart, Doppelklick): es darf keine zweite Instanz erscheinen |
| `src/main/index.ts:114` | `second-instance`-Handler holt das vorhandene Fenster nach vorn | Gegenstück zum Lock: der zweite Start gibt hier ab, sonst passiert für den Nutzer sichtbar gar nichts. Auf macOS feuert das Event praktisch nie. | Zweiten Start auslösen; das laufende Fenster muss in den Vordergrund kommen und aus dem minimierten Zustand zurückkehren. Der Handler nimmt derzeit das **erste** Fenster aus `getAllWindows()` — sobald Task 10 das Widget-Fenster einführt, ist das auf das Widget umzustellen |
| `src/main/index.ts:128` | `window-all-closed` beendet die App außer auf `darwin` | macOS hält Apps ohne Fenster am Leben, Windows erwartet das Ende. **Achtung:** Sobald es Tray + „Schließen blendet aus" gibt (Task 10/12), ist diese Regel neu zu bewerten — dann darf das Schließen des Widgets die App gerade *nicht* beenden. | Verhalten nach Einführung des Trays erneut prüfen |

Task 7 (`src/main/attendance.ts`) hat **keine** neue plattformabhängige Stelle
hinzugefügt: der Store kennt weder Fenster noch Tray und benutzt nur Promises und
`setTimeout`. Task 8 (IPC, Preload, Contract) ebenfalls nicht — IPC verhält sich
auf allen Plattformen gleich. Die Tabelle ist damit weiterhin vollständig
(drei Einträge).

**Nicht plattformabhängig, aber plattformübergreifend wichtig:**
`src/main/index.ts` setzt am Widget-Fenster `sandbox: false`. Grund: `package.json`
hat `"type": "module"`, electron-vite baut das Preload deshalb als
`out/preload/index.mjs`, und Electron lädt ein ESM-Preload nicht in einen
sandboxed Renderer. Der Renderer behält `contextIsolation: true` und
`nodeIntegration: false`; das Preload benutzt ausschließlich `contextBridge` und
`ipcRenderer`. Wer die Sandbox zurückhaben will, muss das Preload als CommonJS
(`.cjs`) bauen — das ist eine Änderung an `electron.vite.config.ts`, keine an
diesem Code.

## 3. Bekannte Windows-Themen

Die vollständige Themenliste steht in `docs/DESIGN.md`, Abschnitt
„Windows-Übergabe". Für die bisher gebauten Teile (Tasks 1–8) sind relevant:

| Thema | Was auf Windows anders ist | Betrifft |
|---|---|---|
| Single-Instance | zwingend, siehe oben | `src/main/index.ts` (erledigt, ungetestet) |
| IPC und Preload | kein Unterschied. Der Pfad zum Preload wird aus `import.meta.dirname` zusammengesetzt, nicht als String gebaut — auf Windows kommen dabei Backslashes heraus, was `BrowserWindow` erwartet | `src/main/index.ts`, `src/preload/index.ts` |
| Login-Fenster | Frameless/Transparenz spielt hier keine Rolle — das Fenster ist bewusst ein normales Fenster mit Titelleiste. Titel `Bei Factorial anmelden` erscheint auf Windows in der Titelleiste, auf macOS nur im Fenstermenü | `src/main/auth.ts` |
| Session-Partition | `persist:factorial` liegt unter `%APPDATA%\factorial-desktop`; auf macOS unter `~/Library/Application Support/factorial-desktop`. Kein Codeunterschied, aber der relevante Ort zum Zurücksetzen | `src/main/session.ts` |
| Autostart, Tray, Fensterposition, Packaging | noch nicht gebaut | Tasks 9, 10, 12, 14 |

## 4. Was verifiziert wurde und was nicht

**Verifiziert auf macOS (Darwin 25.5, Electron 43):**

- `npm test` — 190 Tests grün, `npm run typecheck` sauber, `npm run build`
  fehlerfrei (Stand Task 8).
- `npm run dev` startet, der Main-Prozess bootet ohne Fehler, und mit leerer
  Partition öffnet sich das Login-Fenster statt eines Absturzes. Belegt über den
  laufenden Renderer-Prozess und drei stehende TLS-Verbindungen. Damit ist der
  Pfad „leere Session → `unauthenticated` → Login-Fenster" einmal echt gelaufen;
  die Live-API antwortet ohne Session mit HTTP 401.

**Nicht verifiziert, auf keiner Plattform:**

- Der **vollständige Login** (Formular ausfüllen, 2FA, Fenster schließt sich
  selbst, `[auth] signed in as …` erscheint) — braucht echte Zugangsdaten und
  einen Menschen. Ebenso der zweite Start *ohne* Login-Fenster, der die
  Persistenz der Partition belegen würde.
- Das Verhalten von `ses.fetch` bei `redirect: 'manual'`: ob Electron den echten
  3xx-Status durchreicht oder eine „opaque" Antwort mit Status 0. Beide Fälle
  sind in `src/main/session-fetch.ts` behandelt (Status 0 wird zu 302
  normalisiert), **ausgelöst wurde aber keiner von beiden**: die Live-API
  antwortet auf einen Aufruf ohne Session mit HTTP 401 ohne Redirect
  (per `curl` am 2026-08-12 nachgemessen). Die Redirect-Behandlung ist reine
  Vorsorge und ungetestet gegen echten Verkehr.
- `clearSession()` (Logout) — geschrieben, nie ausgeführt.
- **Der Attendance-Store** (`src/main/attendance.ts`, Task 7): 34 Unit-Tests
  gegen gefälschte Operations, aber **kein einziger Lauf gegen die echte API**.
  Seit Task 8 ist er in `src/main/index.ts` verdrahtet, aber ein Start der App
  braucht eine echte Anmeldung und hat deshalb nicht stattgefunden.
  Insbesondere ungeprüft: das 60-s-Polling gegen den echten Endpunkt und jede
  Mutation über den Store.
- **Der komplette IPC-Pfad zur Laufzeit** (Task 8): `src/preload/index.ts`,
  `src/main/ipc.ts` und die `sandbox: false`-Entscheidung sind **nie in einem
  laufenden Electron ausgeführt worden**. Getestet ist alles, was ohne Electron
  läuft (Contract-Codec und Handler-Logik, 36 Unit-Tests), und `npm run build`
  erzeugt `out/preload/index.mjs` fehlerfrei. Ein eigens gebauter Smoke-Test
  (echtes `registerIpc` + gefälschter Store + Fenster mit dem gebauten Preload)
  ließ sich in dieser Umgebung nicht ausführen: `app.whenReady()` löst hier nie
  aus, weil der Prozess keinen Zugriff auf den Fenstermanager bekommt. **Wer als
  Erstes die App startet, prüft bitte in dieser Reihenfolge:** (1) lädt das
  Preload überhaupt (Renderer-Konsole: `typeof window.factorial === 'object'`),
  (2) liefert `window.factorial.getSnapshot()` ein Objekt mit `state.sinceMs` als
  Zahl, (3) kommt nach einem `refresh()` ein Push über `onSnapshot` an.
- Sämtlicher Windows-Code.

**Nur kompiliert, nie ausgeführt:** die drei `// PLATFORM:`-Zweige aus Abschnitt 2
in ihrer Windows-Ausprägung; `npm run package:win`.

## 5. Wie man die Factorial-API selbst weiter erforscht

Ausführlich in `docs/DESIGN.md`, Abschnitt „Windows-Übergabe → 5". Kurzfassung:

- **Introspection ist der schnelle Weg.** In einer eingeloggten Browser-Session
  genügt ein `fetch` aus dem Seitenkontext, weil die API `credentials: 'include'`
  cross-origin akzeptiert. So wurden `expectedMinutes`, `clockInOffset` und die
  korrigierten Mutation-Signaturen gefunden.
- **`window.fetch` patchen bringt nichts** — die App hält eine Referenz, die vor
  jedem nachträglichen Patch aufgelöst wurde.
- **Vorsicht mit Mutations beim Experimentieren:** sie schreiben in eine echte
  Arbeitszeiterfassung.

## 6. Offene Punkte und Verdachtsmomente

- **`redirect: 'manual'` bei `ses.fetch`.** Siehe Abschnitt 4. Wenn auf Windows
  ein abgelaufener Login sichtbar wird: prüfen, welchen Status die Antwort
  wirklich trägt, und die Normalisierung in `session-fetch.ts` entsprechend
  festziehen oder entfernen.
- **Request-Timeout 15 s** (`REQUEST_TIMEOUT_MS` in `src/main/session.ts`) ist
  gesetzt, weil ein hängender Socket sonst die ganze App einfriert
  (Carry-Forward C2). Der Wert ist geschätzt, nicht gemessen.
- **Login-Host.** `docs/DESIGN.md` nennt `id.factorialhr.com`, `docs/PLAN.md`
  nennt im Task-6-Schnipsel `app.factorialhr.com`. Umgesetzt ist die
  Design-Variante. Falls die Anmeldung dort je hakt, ist `app.factorialhr.com`
  die dokumentierte Alternative — es leitet ohne Session auf `id` weiter.
- **`second-instance`-Handler** greift auf das erste Fenster zu; das ist erst
  richtig, wenn das Widget-Fenster existiert (Task 10).
- **Taucht der laufende Shift in `attendanceShiftsConnection` auf?** Unbekannt.
  Der Store filtert ihn deshalb per Id aus der Tagessumme (`summariseDay` in
  `src/main/attendance.ts`), weil er die laufende Zeit aus `state.since` selbst
  dazurechnet — täte er es nicht, würde die laufende Schicht doppelt zählen.
  Wenn die Tagessumme auf Windows (oder macOS) je zu hoch oder zu niedrig
  aussieht: hier zuerst nachsehen.
- **Welchen `clockIn` meldet der offene Shift während einer Pause?** Vermutlich
  den Pausenbeginn (eine Pause legt einen eigenen Record an — DESIGN.md,
  Fallstrick 4), verifiziert ist es nicht. Der Store zeigt beim Pausenstart
  optimistisch `now` an; die Antwort des nächsten Refresh überschreibt das nach
  spätestens einem Request. Sichtbar wäre ein Fehler als kurzes Springen des
  Timers beim Klick auf „Pause".
- **Fehlermeldungen sind noch englisch.** Der Store legt zu jedem Fehler ein
  `lastErrorKind` (`network` / `graphql` / `malformed` / `unauthenticated` /
  `unknown`) in den Snapshot, damit die UI daraus deutschen Text bilden kann.
  Diese Zuordnung ist noch nicht gebaut (Task 11/12) — bis dahin würde eine
  Anzeige die internen englischen Meldungen durchreichen. Task 8 hat die
  Voraussetzung dafür geschaffen: eine abgelehnte Aktion trägt ihre Art im
  Fehlertext mit (`encodeActionError` / `decodeActionError` in
  `src/shared/ipc-contract.ts`), inklusive der zusätzlichen Art `busy` für den
  abgelehnten zweiten Klick. **Die UI muss `decodeActionError(err.message)`
  benutzen und den deutschen Text aus `kind` bilden** — gibt sie `err.message`
  roh aus, steht dort die interne englische Meldung samt Präfix.
- **Snapshot-Push geht derzeit an *alle* Fenster** (`registerIpc` in
  `src/main/ipc.ts`, Default von `targets`). Das ist heute unkritisch, weil das
  einzige andere Fenster das Login-Fenster ohne Preload ist und dort niemand
  zuhören kann. Sobald Task 10 das Widget-Fenster hat, sollte `targets` auf genau
  dieses Fenster gesetzt werden.
- **`lastError` wird nie zurückgesetzt.** Ein erfolgreicher Refresh löscht
  `stale`, nicht aber `lastError`/`lastErrorKind` (Verhalten des Stores aus
  Task 7, im Contract dokumentiert). Die UI muss „keine Verbindung" deshalb an
  `stale` festmachen, nicht an `lastError !== null` — sonst klebt die alte
  Meldung für den Rest der Sitzung im Widget.
- **Refresh bei Fensterfokus und nach Standby** (`powerMonitor`-Resume) fehlt
  noch. Der Store bietet `refresh()` dafür an, aufgerufen wird es erst in
  Task 10/12. Ohne den Resume-Hook zeigt der Timer nach dem Zuklappen des
  Deckels bis zu 60 s alte Zahlen.
