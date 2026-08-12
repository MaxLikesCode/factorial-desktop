# Factorial Desktop — Windows-Übergabe

**Status:** wächst mit der Implementierung. Stand: Ende Task 11 (Widget-UI).
Tasks 12–15 tragen hier weiter ein.

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
| `src/main/settings.ts` | persistierte Einstellungen als JSON + `buildLoginItemSettings` (Electron-frei, getestet) |
| `src/main/windows.ts` | das Widget-`BrowserWindow`: frameless, alwaysOnTop, Schließen blendet aus (Electron-Teil) |
| `src/main/window-position.ts` | wohin das Fenster darf: Clamping, Auflösung pro Monitor, Positionsdatei (Electron-frei, getestet) |
| `src/preload/index.ts` | `contextBridge` — die einzigen zehn Funktionen, die der Renderer sieht |
| `src/shared/ipc-contract.ts` | Kanalnamen, Snapshot-Serialisierung, Fehler-Codec (von Main **und** Renderer benutzt) |
| `src/shared/time.ts` | Zeitrekonstruktion (der gefährlichste Code im Repo) |
| `src/shared/attendance-state.ts` | Zustandsableitung aus `openShift` |
| `src/renderer/src/App.tsx` | Wurzel: Widget plus `Toaster` |
| `src/renderer/src/components/StatusWidget.tsx` | das Widget: Statuszeile, Ring, Aktionen, Fußzeile |
| `src/renderer/src/hooks/useAttendance.ts` | Snapshot-Abo über die Bridge + Sekundentakt für den Timer |
| `src/renderer/src/lib/errors.ts` | die einzige Stelle, die aus einem Fehler-`kind` deutschen Text macht |
| `src/renderer/src/components/ui/` | von der shadcn-CLI generiert (Style `base-nova`). **Nicht** von Hand an einen Plan-Schnipsel anpassen — siehe K11 in Abschnitt 6 |

**Zur Testeinrichtung des Renderers** (Carry-Forward C3, erledigt in Task 11):
`vitest.config.ts` läuft mit `environment: 'jsdom'` für die **gesamte** Suite,
kennt den Alias `@renderer` und sammelt auch `.tsx`. Die Main-Prozess-Tests
laufen unverändert darunter durch — sie sind pure Logik plus `node:fs`, und das
rührt jsdom nicht an. Zwei Eigenheiten, über die man sonst stolpert:

- **Vitest läuft ohne `globals`**, deshalb registriert Testing Library kein
  eigenes `afterEach(cleanup)`. Jede Komponenten-Testdatei ruft `cleanup()`
  selbst auf; ohne das stapeln sich die Renders im selben Dokument und der
  nächste `getBy*` scheitert mit „found multiple elements".
- **`TZ=Europe/Berlin`** bleibt gesetzt. Die Zeitrekonstruktion braucht sie nicht
  mehr (K6), die Formatierer und der Store-Takt schon.

## 2. Vollständige Liste der plattformabhängigen Stellen

Jede Verzweigung trägt im Code einen `PLATFORM:`-Kommentar.
`grep -rn "PLATFORM:" src/` liefert die vollständige Liste — diese Tabelle ist
die erklärte Fassung davon und muss mit dem Grep-Ergebnis übereinstimmen.

> **Seit Task 11 ist das Grep-Muster `PLATFORM:` statt `// PLATFORM:`.** Die
> erste plattformabhängige Stelle außerhalb von TypeScript liegt in
> `src/renderer/src/styles.css`, und dort ist der Kommentar `/* … */`. Wer nur
> nach `// PLATFORM:` sucht, übersieht sie.

| Datei:Zeile | Was | Warum | Auf Windows zu prüfen |
|---|---|---|---|
| `src/main/settings.ts:143` | `platform === 'win32'` → `{ openAtLogin, path, args: [] }` | Windows-Autostart ist ein Eintrag im Registry-Run-Key und braucht einen Pfad auf eine `.exe`. Ohne explizites `path` trägt Electron das ein, was gerade läuft — im Dev-Modus `electron.exe`, im gepackten Zustand potenziell der falsche Launcher (DESIGN.md, Zeile „Autostart"). | Haken „Autostart" setzen, abmelden/anmelden: die App muss starten. Danach `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"` — der Eintrag muss auf die installierte `.exe` zeigen, nicht auf `electron.exe`. Haken entfernen → Eintrag verschwindet. **Im Dev-Modus bewusst nicht ausprobieren**, sonst startet dauerhaft eine Electron-Instanz mit |
| `src/main/settings.ts:150` | alles außer `win32` → `{ openAtLogin }` ohne Pfad | macOS registriert das `.app`-Bundle selbst über die Service-Management-API; ein `path` würde auf das Helper-Binary im Bundle zeigen. Linux fällt in denselben Zweig, wo `setLoginItemSettings` ein No-op ist — das ist das harmlose Ergebnis. | Nichts; der Zweig ist auf Windows unerreichbar |
| `src/main/index.ts:57` | `applyLoginItem` liest `process.platform`/`process.execPath` und gibt sie an `buildLoginItemSettings` weiter | Die einzige Stelle, die `app.setLoginItemSettings` aufruft. Die Verzweigung selbst ist absichtlich ausgelagert und rein, damit der Windows-Zweig auf macOS getestet werden kann. | Nur zusammen mit den beiden Zeilen oben |
| `src/main/index.ts:118` | `app.requestSingleInstanceLock()`, sonst `app.quit()` | Ohne Lock startet auf Windows bei jedem Aufruf eine zweite komplette Instanz, inklusive zweitem Tray-Icon und zweitem Poll-Loop. Auf macOS übernimmt das die Plattform. | Zweiten Start auslösen (Verknüpfung, Autostart, Doppelklick): es darf keine zweite Instanz erscheinen |
| `src/main/index.ts:122` | `second-instance`-Handler ruft `showWidget()` | Gegenstück zum Lock: der zweite Start gibt hier ab, sonst passiert für den Nutzer sichtbar gar nichts. Auf macOS feuert das Event praktisch nie. Seit Task 10 zielt der Handler ausdrücklich auf das Widget statt auf `getAllWindows()[0]` — letzteres hätte das Login-Fenster nach vorn geholt, wenn gerade eines offen war. | Zweiten Start auslösen (Verknüpfung, Autostart, Doppelklick); das Widget muss sichtbar und fokussiert nach vorn kommen, auch wenn es vorher ausgeblendet oder minimiert war |
| `src/main/index.ts:133` | `window-all-closed` beendet die App außer auf `darwin` | macOS hält Apps ohne Fenster am Leben, Windows erwartet das Ende. Seit Task 10 blendet das Schließen des Widgets nur aus, das Fenster bleibt also am Leben und der Handler feuert dabei gar nicht mehr. Übrig bleibt der Fehlerpfad: Bootstrap gescheitert, oder der Benutzer schließt das Login-Fenster. **Achtung, Zwischenstand:** solange es kein Tray gibt (Task 12), hat Windows damit *keinen* Weg mehr, die App zu beenden — auf macOS tut es ⌘Q. Nicht in diesem Zustand ausliefern. | Nach Task 12 erneut prüfen: Widget schließen darf die App nicht beenden, „Beenden" im Tray schon |
| `src/main/windows.ts:104` | `transparent: true` + `backgroundColor: '#00000000'` | macOS zeichnet ein transparentes, frameless Fenster mit runden Ecken und weichem Schatten von selbst. Windows setzt hinter ein transparentes Fenster sonst ein weißes Rechteck und zeichnet einen eckigen Schatten drumherum. | Sichtprüfung: keine weißen Ecken hinter dem Widget, kein eckiger Schattenrahmen. Falls doch, sind `transparent`, `thickFrame: false` und ein Renderer-seitiger `border-radius` die Stellschrauben (DESIGN.md, „Frameless & Transparenz") |
| `src/main/windows.ts:123` | `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` nur auf `darwin` | Der Sinn eines schwebenden Zeit-Widgets ist, über Vollbild-Spaces sichtbar zu bleiben. `visibleOnFullScreen` ist eine macOS-Option; auf Windows gibt es kein Äquivalent, dort trägt allein `alwaysOnTop`. | Prüfen, ob das Widget über einer Vollbild-App sichtbar bleibt. Wenn nicht: `setAlwaysOnTop(true, 'screen-saver')` ist die Windows-taugliche Verschärfung, hat aber Nebenwirkungen auf Fokus und Taskleiste |
| `src/renderer/src/styles.css:32` | `.drag-region { -webkit-app-region: drag }` plus `.no-drag` für alles Anklickbare darin | Das Fenster ist `frame: false` und hat keine Titelleiste zum Anfassen; die Drag-Region **ist** die einzige Möglichkeit, das Widget zu verschieben. Chromium kennt die Eigenschaft auf beiden Plattformen, verhält sich aber nicht gleich. | Widget an der Kopfzeile ziehen: es muss sich bewegen und die Position nach dem Debounce speichern. Dann drei Windows-Eigenheiten prüfen: (1) an den oberen Bildschirmrand ziehen darf **kein** Aero Snap auslösen — das Fenster ist `resizable: false`, ein Snap-Versuch führt dort erfahrungsgemäß zu einem verzerrten oder unverschiebbaren Fenster; (2) Buttons und das Arbeitsort-Select innerhalb der Region müssen klickbar bleiben (dafür ist `.no-drag` da; unter Windows greift die Vererbung teils anders); (3) `moved` feuert unter Windows beim Ziehen laufend statt einmal — der 250-ms-Debounce in `src/main/windows.ts` ist genau dafür da |

Task 7 (`src/main/attendance.ts`) hat **keine** neue plattformabhängige Stelle
hinzugefügt: der Store kennt weder Fenster noch Tray und benutzt nur Promises und
`setTimeout`. Task 8 (IPC, Preload, Contract) ebenfalls nicht — IPC verhält sich
auf allen Plattformen gleich. Task 9 hat drei Einträge ergänzt (Autostart),
Task 10 zwei weitere (Transparenz, Vollbild-Sichtbarkeit) und zwei bestehende
umgeschrieben, Task 11 einen (die Drag-Region im CSS); die Tabelle hat damit
**neun** Einträge und deckt `grep -rn "PLATFORM:" src/` vollständig ab.

Task 11 hat **keine** neue `process.platform`-Verzweigung in TypeScript
hinzugefügt: der Renderer kennt `process` gar nicht (`contextIsolation: true`,
`nodeIntegration: false`) und darf ihn auch nie kennenlernen. Was
plattformabhängig ist, ist der eine CSS-Mechanismus oben.

`src/main/window-position.ts` ist bewusst **nicht** plattformabhängig, obwohl
Fensterpositionen es klassisch sind: die gesamte Logik rechnet nur mit Zahlen aus
`screen.getPrimaryDisplay()`/`getAllDisplays()` und wird deshalb auf jeder
Plattform gegen dieselben Unit-Tests gefahren. Zu prüfen ist auf Windows nur, ob
Electron dort dieselben Koordinaten liefert — siehe Abschnitt 3, Zeile
„Fensterposition".

Die Persistenz der Einstellungen selbst ist **nicht** plattformabhängig: das
Format ist JSON, der Ort kommt aus `app.getPath('userData')`
(`%APPDATA%\factorial-desktop\settings.json` bzw.
`~/Library/Application Support/factorial-desktop/settings.json`), und der Pfad
wird mit `node:path` zusammengesetzt. `src/main/settings.ts` importiert absichtlich
kein Electron — der Dateipfad und der Login-Item-Effekt kommen als Argumente
herein, deshalb ist der Store gegen ein echtes Temp-Verzeichnis testbar.

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
„Windows-Übergabe". Für die bisher gebauten Teile (Tasks 1–9) sind relevant:

| Thema | Was auf Windows anders ist | Betrifft |
|---|---|---|
| Single-Instance | zwingend, siehe oben | `src/main/index.ts` (erledigt, ungetestet) |
| IPC und Preload | kein Unterschied. Der Pfad zum Preload wird aus `import.meta.dirname` zusammengesetzt, nicht als String gebaut — auf Windows kommen dabei Backslashes heraus, was `BrowserWindow` erwartet | `src/main/index.ts`, `src/preload/index.ts` |
| Login-Fenster | Frameless/Transparenz spielt hier keine Rolle — das Fenster ist bewusst ein normales Fenster mit Titelleiste. Titel `Bei Factorial anmelden` erscheint auf Windows in der Titelleiste, auf macOS nur im Fenstermenü | `src/main/auth.ts` |
| Session-Partition | `persist:factorial` liegt unter `%APPDATA%\factorial-desktop`; auf macOS unter `~/Library/Application Support/factorial-desktop`. Kein Codeunterschied, aber der relevante Ort zum Zurücksetzen | `src/main/session.ts` |
| Autostart | `app.setLoginItemSettings` schreibt auf Windows in den Registry-Run-Key, auf macOS in die Service-Management-Datenbank. Auf Windows **müssen** `path` und `args` gesetzt sein (siehe Tabelle in Abschnitt 2), auf macOS dürfen sie es nicht. `openAsHidden` ist macOS-only und wird bewusst nicht gesetzt — das Widget soll beim Start sichtbar sein | `src/main/settings.ts` (`buildLoginItemSettings`), `src/main/index.ts` (`applyLoginItem`) — geschrieben, auf Windows ungetestet |
| Einstellungsdatei | gleicher Code, anderer Ort: `%APPDATA%\factorial-desktop\settings.json`. Geschrieben wird über eine `.tmp`-Datei plus `renameSync`; das ist auf NTFS ebenso atomar wie auf APFS, **aber** ein Virenscanner kann das `rename` kurzzeitig mit `EBUSY` blockieren. Wenn Einstellungen auf Windows sporadisch nicht speichern: hier zuerst nachsehen | `src/main/settings.ts` |
| Frameless & Transparenz | Keine macOS-Vibrancy, kein automatischer runder Schatten. Ecken und Schatten kommen auf Windows aus dem Renderer bzw. gar nicht. Das Fenster ist `resizable: false`, damit entfällt das abweichende Resize-Verhalten transparenter Fenster | `src/main/windows.ts` (geschrieben, auf Windows ungetestet) |
| Always-on-Top | `alwaysOnTop` wird beim Erzeugen gesetzt **und** zur Laufzeit über `setWidgetAlwaysOnTop` nachgezogen. Die Level-Namen (`'floating'`, `'screen-saver'`, …) sind plattformspezifisch; hier wird bewusst kein Level angegeben, es gilt der Standard | `src/main/windows.ts`, `src/main/index.ts` (`withWindowEffects`) |
| Fensterposition | Multi-Monitor mit gemischten DPI-Skalierungen verhält sich anders. Gespeicherte Positionen werden vor Gebrauch gegen die aktuell angeschlossenen Displays validiert — beim Start **und** bei jedem `display-added`/`display-removed`/`display-metrics-changed`. Gerechnet wird mit `workArea` (ohne Taskleiste), Koordinaten sind in DIP, nicht in physischen Pixeln | `src/main/window-position.ts` (getestet), `src/main/windows.ts` (Verdrahtung) |
| Schließen-Verhalten | Das Schließen blendet aus statt zu beenden (DESIGN.md, „Tray"). Auf Windows ist die Erwartung „X beendet die App" stärker als auf macOS; das Tray-Icon aus Task 12 ist dort deshalb keine Zierde, sondern der einzige sichtbare Beleg, dass die App noch läuft — zumal `skipTaskbar: true` gesetzt ist | `src/main/windows.ts` |
| Positionsdatei | `%APPDATA%\factorial-desktop\window-position.json`, gleiche Schreibweise wie bei den Einstellungen (`.tmp` + `rename`). Schreibfehler werden hier bewusst **verschluckt**, weil der Schreibvorgang aus einem `moved`-Handler kommt | `src/main/window-position.ts` |
| Drag-Region | siehe Abschnitt 2, letzte Zeile. Kurz: Aero Snap, `.no-drag`-Vererbung, `moved`-Frequenz | `src/renderer/src/styles.css` (geschrieben, auf Windows ungetestet) |
| Schriftart | `@fontsource-variable/geist` wird als WOFF2 mitgebaut und nicht vom System geholt — es gibt also keinen Fallback-Unterschied zwischen macOS und Windows. Was sich unterscheidet, ist das **Rendering**: Windows hinted anders, die Zeilen im Widget können dadurch 1–2 px höher ausfallen. Das Fenster ist `resizable: false` bei 340×224, ein Überlauf würde also abgeschnitten statt zu scrollen | `src/renderer/src/styles.css`, `src/main/windows.ts` (`WIDGET_SIZE`) |
| Renderer-Fonts und Emoji | Die UI benutzt bewusst **keine** Emoji oder Unicode-Blockzeichen als Icons (der Plan-Schnipsel hatte `❙❙` für „Pause") — auf Windows rendern die als farbiges Emoji oder als Ersatzkästchen. Stattdessen Lucide-SVGs plus deutsches Wort | `src/renderer/src/components/BreakMenu.tsx` |
| Toasts | `sonner` rendert in denselben transparenten, 340×224 großen Renderer. Position ist `bottom-center`, damit ein Toast nicht über die abgerundete Ecke hinausragt. Ob er auf Windows in ein transparentes, frameless Fenster genauso sauber zeichnet, ist ungeprüft | `src/renderer/src/App.tsx` |
| Tray, Packaging | noch nicht gebaut | Tasks 12, 14 |

## 4. Was verifiziert wurde und was nicht

**Verifiziert auf macOS (Darwin 25.5, Electron 43):**

- `npm test` — 297 Tests grün, `npm run typecheck` sauber, `npm run build`
  fehlerfrei (Stand Task 11).
- **Die Widget-UI in jsdom** (Task 11, 43 neue Tests): alle fünf Zustände
  (`unknown`, `unauthenticated`, `out`, `in`, `break`) werden gerendert und
  geprüft — Beschriftung, welche Buttons existieren, die aus `since` neu
  gerechnete laufende Zeit über zwei Ticks, die eingefrorene Ist-Zeit während
  einer Pause, der Stale-Hinweis (an *und* wieder aus, obwohl `lastError` stehen
  bleibt), der Unvollständig-Hinweis aus C4, das Sperren der Buttons während
  einer laufenden Aktion, und dass eine abgelehnte Aktion **deutschen** Text
  erzeugt statt der internen englischen Meldung. Das Pausen-Dropdown wird
  aufgeklappt und ein Eintrag angeklickt — genau der Pfad, den K11 gefährdet
  sah.
  **Das ist eine DOM-Prüfung, keine optische.** Sie belegt, dass die richtigen
  Texte und Zustände entstehen; sie belegt **nicht**, dass 340×224 dafür reicht.
- **Das Widget-Fenster in einem echten Electron** (Task 10, zwei Smoke-Läufe auf
  einer Maschine mit zwei Monitoren: intern `id 1`, `workArea {0,39,2056,1223}`,
  extern `id 5`, `workArea {1622,-1860,3360,1860}` — der zweite Monitor liegt also
  bei negativem `y`, was die Vorzeichen-Fälle echt statt hypothetisch macht).
  Nachweislich gelaufen:
  - Öffnen ohne gespeicherte Position → zentriert auf dem primären Display
    (`{858,539}`, exakt der gerechnete Wert), `isVisible()`, `isAlwaysOnTop()`.
  - Verschieben → nach dem Debounce liegt
    `{"byDisplay":{"1":{"x":120,"y":260}},"lastDisplayId":"1"}` in der Datei.
    Vor der ersten Bewegung wird **nicht** geschrieben.
  - `setWidgetAlwaysOnTop(false/true)` → `isAlwaysOnTop()` folgt sofort.
  - `close()` → `isDestroyed() === false`, `isVisible() === false`, `getWidget()`
    liefert weiter das Fenster. `showWidget()`/`toggleWidget()` blenden wieder
    ein und aus.
  - Wiederherstellung gegen die echten Displays, sieben Fälle: leerer Store →
    Mitte; gespeicherte Display-Id existiert nicht mehr → Mitte; auf dem primären
    Display gespeichert → exakt wiederhergestellt; über den rechten Rand hinaus
    gespeichert (`x=2036`) → auf `x=1716` zurückgezogen; kaputte Datei → Mitte;
    auf dem **echten** zweiten Monitor gespeichert (`{1662,-1820}`) → exakt dort
    geöffnet; zuletzt benutzter Monitor abgezogen, aber Eintrag für den primären
    vorhanden → dieser gewinnt.

  Nebenbefund aus dem ersten Lauf: Electron beendet sich, sobald das letzte
  Fenster **zerstört** wird, wenn kein `window-all-closed`-Listener registriert
  ist — auch auf macOS. `src/main/index.ts` registriert einen, der Fall ist also
  abgedeckt; wer einen eigenen Smoke-Test schreibt, muss daran denken.
- `npm run dev` startet, der Main-Prozess bootet ohne Fehler, und mit leerer
  Partition öffnet sich das Login-Fenster statt eines Absturzes. Belegt über den
  laufenden Renderer-Prozess und drei stehende TLS-Verbindungen. Damit ist der
  Pfad „leere Session → `unauthenticated` → Login-Fenster" einmal echt gelaufen;
  die Live-API antwortet ohne Session mit HTTP 401.
- **Der Einstellungs-Store gegen ein echtes Dateisystem** (Task 9, 23 Tests):
  Anlegen, Schreiben, Neuladen, fehlende Datei, kaputte Datei, unbekannte Keys,
  nicht anlegbares Verzeichnis. Kein Mock von `node:fs` — die Tests arbeiten in
  einem echten Temp-Verzeichnis. Ebenfalls getestet sind **beide** Zweige von
  `buildLoginItemSettings`, weil die Funktion die Plattform als Argument nimmt
  statt `process.platform` selbst zu lesen.
- `app.whenReady()` **feuert in dieser Umgebung doch** (entgegen der Notiz aus
  Task 8): ein minimales Electron-Skript ohne Fenster wurde ready, lieferte
  `app.getPath('userData')` und `app.getLoginItemSettings()`. Damit ist belegt,
  dass die Login-Item-API zur Laufzeit erreichbar ist. **Geschrieben** wurde
  nichts: `setLoginItemSettings` verändert echte Systemeinstellungen des
  Benutzers und wurde deshalb bewusst nicht ausgelöst.

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
- **Der Autostart als Effekt** (Task 9): `app.setLoginItemSettings` wurde nie
  aufgerufen — weder auf macOS noch auf Windows. Getestet ist nur, *was* der App
  übergeben würde. Ob macOS die App danach wirklich beim Login startet, ist offen;
  im ungepackten Dev-Modus würde ohnehin das Electron-Binary registriert, nicht
  die App. Sinnvoll prüfbar ist das erst nach Task 14 (Packaging).
- **Die Einstellungsdatei am echten Ort**: dass unter
  `app.getPath('userData')/settings.json` tatsächlich geschrieben wird, ist nie
  gelaufen — `bootstrap()` erreicht den Einstellungs-Store erst nach erfolgreicher
  Anmeldung. Der Store selbst ist gegen ein echtes Verzeichnis getestet, die
  Verdrahtung in `src/main/index.ts` nicht.
- **Das Widget im normalen Betrieb**, also über `npm run dev` mit echter
  Anmeldung: `bootstrap()` erreicht `createWidgetWindow` erst nach erfolgreichem
  Login, und der hat nie stattgefunden. Verifiziert ist das Fenster nur über die
  beiden Smoke-Läufe oben, die den Auth-Teil umgehen. Ungeprüft bleiben damit:
  das Zusammenspiel mit dem Preload im Widget, die Darstellung des Renderers in
  einem transparenten Fenster, und ob `withWindowEffects` beim Umschalten über
  die echte IPC-Route greift (der direkte Aufruf von `setWidgetAlwaysOnTop` tut
  es nachweislich).
- **Das Verschieben mit der Maus.** Die Positionsdatei wurde über
  `setPosition()` ausgelöst, nicht über einen echten Drag. Ob `moved` beim Ziehen
  einer eigenen Drag-Region (Task 11 baut sie) genauso feuert, ist offen — auf
  Windows feuert es erfahrungsgemäß laufend statt einmal, weshalb der Schreib-
  vorgang um 250 ms entprellt ist.
- **Das Verhalten beim An- und Abstecken eines Monitors zur Laufzeit.** Die
  Handler auf `display-added`/`display-removed`/`display-metrics-changed` sind
  registriert und rechnen mit derselben getesteten Funktion, ausgelöst wurde
  aber keiner davon.
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
- **Die Widget-UI in einem echten Chromium** (Task 11). jsdom rendert kein
  Layout: es kennt keine Zeilenhöhen, kein Flexbox-Ergebnis und keine Overflow-
  Berechnung. Damit ist **ungeprüft**, ob der Inhalt in die 340×224 des Fensters
  passt, ob der Fortschrittsring neben der Statusspalte Platz hat, ob der
  Popup-Inhalt des Pausen-Menüs und des Arbeitsort-Selects innerhalb des
  Fensters landet (beide sind portaliert und werden von Base UI positioniert —
  in einem 340×224-Fenster ist „unten anschlagen" der Normalfall, nicht der
  Ausnahmefall), und ob ein Toast sichtbar ist. **Wer die App als Erstes mit
  echter Anmeldung startet, sieht hier zuerst hin.**
- **Der komplette Klickpfad gegen die echte API** (Plan-Task 11, Schritt 8:
  Einstempeln → Pause → Fortsetzen → Ausstempeln). Nicht gelaufen, und zwar
  bewusst: dieser Durchlauf schreibt echte Einträge in eine echte
  Arbeitszeiterfassung. Das ist eine Handlung, die der Mensch auslöst, nicht ein
  Agent nebenbei. Gilt entsprechend für die drei `locationType`-Werte (siehe
  Abschnitt 6).
- **`npm run dev` mit Widget-UI**: der Main-Prozess bootet, der Renderer-
  Dev-Server läuft (`http://localhost:5173`), Electron startet — aber der
  Bootstrap bleibt vor `createWidgetWindow` in der Anmeldung stehen, weil keine
  gültige Session vorliegt. Es ist also weiterhin **kein einziges Mal** ein
  Renderer mit dieser UI in einem Electron-Fenster gelaufen. Insbesondere ist
  ungeprüft, ob `window.factorial` im Widget wirklich ankommt — der erste Punkt
  der Checkliste weiter oben.
- Sämtlicher Windows-Code.

**Nur kompiliert, nie ausgeführt:** die Windows-Ausprägung der
`PLATFORM:`-Zweige aus Abschnitt 2, inklusive der neuen Drag-Region;
`npm run package:win`.

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
- ~~**`second-instance`-Handler** greift auf das erste Fenster zu~~ — erledigt in
  Task 10: der Handler ruft jetzt `showWidget()`.
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
- ~~**Fehlermeldungen sind noch englisch.**~~ — erledigt in Task 11 für den
  Renderer. `src/renderer/src/lib/errors.ts` ist die einzige Stelle, an der aus
  einem `kind` deutscher Text wird: `describeActionError(error)` für den Toast
  (dekodiert `encodeActionError` und wirft die interne Meldung weg — außer bei
  `graphql`, wo DESIGN.md ausdrücklich die Server-Meldung sehen will) und
  `describeStaleReason(kind)` für den Hinweis neben der Statuszeile.
  **Noch offen für Task 12:** das Tray zeigt bisher gar nichts an, wird aber
  dieselben Fehler sehen. Es soll `describeActionError` mitbenutzen und keine
  zweite Übersetzungstabelle aufmachen — sonst driften die Formulierungen
  auseinander, und die englischen Originale (`another action is already in
  flight`, `request timed out after 15000 ms`, `session rejected (HTTP 401)`)
  stehen wieder in einer Benachrichtigung.

- **K11-Abweichungen: Nova ist Base UI, nicht Radix.** Die UI-Schnipsel in
  `docs/PLAN.md`, Task 11, sind gegen Radix-Props geschrieben. Alle folgenden
  Stellen wurden gegen die tatsächlich generierten Komponenten in
  `src/renderer/src/components/ui/` korrigiert. Sie kommen bei einem
  shadcn-Update wieder — dann hier zuerst nachsehen:

  | Plan (Radix) | Tatsächlich (Base UI 1.7) | Folge, wenn man den Plan übernimmt |
  |---|---|---|
  | `<DropdownMenuTrigger asChild>` | `render={<Button … />}` | `asChild` ist kein Prop; der Trigger rendert seinen eigenen `<button>` **um** den Button herum → zwei verschachtelte Buttons |
  | `<DropdownMenuItem onSelect={…}>` | `onClick={…}` | **Stiller Ausfall.** `onSelect` wird als unbekanntes DOM-Prop durchgereicht, kompiliert sauber und feuert nie. Das Pausen-Menü öffnet sich und tut nichts |
  | `<Select value onValueChange={(v: string) => …}>` | Handler bekommt `(value: string \| null, eventDetails)` | Typfehler beim direkten Durchreichen — der einzige Fall hier, den `tsc` fängt |
  | `<SelectValue />` zeigt das Label | zeigt den **rohen Wert**, solange `<Select items={…}>` fehlt | **Stiller Ausfall.** Im Widget stünde `work_from_home` statt `Homeoffice` |
  | `<Button size="icon">` mit `❙❙` als Beschriftung | Größen heißen `xs`/`sm`/`default`/`lg` bzw. `icon-xs`/`icon-sm`/`icon`/`icon-lg` | `size="icon"` existiert, aber der Unicode-Glyph rendert auf Windows als Emoji oder Ersatzkästchen — deshalb Lucide-SVG plus Wort |

  `npm run typecheck` fängt davon nur die dritte Zeile. Die zweite und die vierte
  sind der Grund, warum `src/renderer/src/__tests__/break-menu.test.tsx` das Menü
  wirklich aufklappt und anklickt, statt nur zu rendern.

- **Die Werte `work_from_home` und `business_trip` sind ungeprüft.** Live
  beobachtet wurde nur `office`. Die drei stehen als
  `AttendanceShiftLocationTypeEnum` im Schema und werden im Main-Prozess gegen
  `LOCATION_TYPES` (`src/main/factorial/types.ts`) validiert, bevor sie zur API
  gehen. Wer zum ersten Mal mit echter Anmeldung arbeitet: jeden der drei einmal
  beim Einstempeln senden. Lehnt die API einen ab, kommt der Fehler **in-band mit
  HTTP 200** zurück (`undefinedArgument`/`invalidValue`) und landet als
  `graphql`-Fehler im Toast — dann den korrigierten Enum-Wert in
  `src/main/factorial/types.ts` **und** in
  `src/renderer/src/components/LocationSelect.tsx` nachziehen.

- **Das Tagesziel ist bis Task 13 hart auf 8 Stunden verdrahtet.**
  `TARGET_MINUTES` in `src/renderer/src/components/StatusWidget.tsx`. „Verbleibende
  Zeit" und die Füllung des Rings sind bis dahin also für jeden anderen
  Arbeitsvertrag und für jeden Feiertag falsch. Task 13 ersetzt die Konstante
  durch `expectedMinutes` (K8) und muss dabei den Fall „kein Ziel" bauen: dann
  entfällt die Zeile ganz, statt 8 Stunden zu erfinden.

- **Die Ring-Mitte zeigt die Ist-Zeit des Tages, nicht die laufende Schicht** —
  bewusste Abweichung vom Plan-Schnipsel, siehe die Begründung im Commit und in
  `StatusWidget.tsx`. Falls jemand später doch die Segmentzeit dort erwartet:
  sie steht während einer Pause bereits in der Fußzeile
  (`Mittagspause · 0:12:34`), und `segmentMs` in derselben Datei ist der Wert.
- ~~**Snapshot-Push geht derzeit an *alle* Fenster**~~ — erledigt in Task 10:
  `src/main/index.ts` übergibt `targets: () => [getWidget()]` (leer, solange es
  kein Widget gibt). Der Default in `src/main/ipc.ts` bleibt bestehen, wird aber
  von der App nicht mehr benutzt.
- **`lastError` wird nie zurückgesetzt.** Ein erfolgreicher Refresh löscht
  `stale`, nicht aber `lastError`/`lastErrorKind` (Verhalten des Stores aus
  Task 7, im Contract dokumentiert). Die UI muss „keine Verbindung" deshalb an
  `stale` festmachen, nicht an `lastError !== null` — sonst klebt die alte
  Meldung für den Rest der Sitzung im Widget.
- **Autostart wird bei jedem Start einmal abgeglichen.** `src/main/index.ts` ruft
  `applyLoginItem(settings.get().openAtLogin)` nach dem Laden der Einstellungen
  auf, weil der Store nur *Änderungen* meldet: ohne diesen Abgleich würde bei
  einer Neuinstallation nie ein Login-Item entstehen, obwohl der Standard „an"
  ist, und ein außerhalb der App entfernter Eintrag käme nie zurück. Nebenwirkung:
  die App schreibt die Systemeinstellung bei jedem Start, auch wenn der Benutzer
  sie von Hand geändert hat — der gespeicherte Wert gewinnt. Falls das auf Windows
  unerwünscht ist, ist `app.getLoginItemSettings()` die Stelle, an der man
  vergleichen statt schreiben könnte.
- **Einstellungen werden nur beim Start gelesen.** Zwei parallel laufende
  Instanzen würden sich gegenseitig überschreiben. Der Single-Instance-Lock
  verhindert das auf Windows — genau deshalb ist er dort nicht optional.
- **Refresh bei Fensterfokus und nach Standby** (`powerMonitor`-Resume) fehlt
  noch, ebenso der Start des Poll-Loops. Der Store bietet `refresh()` und
  `startPolling()` dafür an; verdrahtet wird beides in Task 12, dessen Plan-Body
  die vollständige `index.ts` dafür vorgibt. Ohne den Resume-Hook zeigt der Timer
  nach dem Zuklappen des Deckels bis zu 60 s alte Zahlen — solange gar nicht
  gepollt wird, sogar dauerhaft.
- **Display-Ids als Schlüssel der Positionsdatei.** `Electron.Display.id` ist
  nicht garantiert stabil über Neustarts oder das Wiederanstecken desselben
  Monitors. Ändert sich die Id, ist die Position für diesen Bildschirm vergessen
  und das Widget landet mittig — der harmlose Ausgang, auf den die ganze
  Validierung ausgelegt ist. Sollte sich auf Windows zeigen, dass Ids dort *bei
  jedem Start* wechseln, wäre ein stabilerer Schlüssel (etwa
  `${bounds.width}x${bounds.height}@${bounds.x},${bounds.y}`) der Ersatz;
  gemessen ist das nicht.
- **Die Positionsdatei wird bei mehreren Instanzen nicht koordiniert** — dasselbe
  Thema wie bei den Einstellungen, und derselbe Schutz: der Single-Instance-Lock.
- **`skipTaskbar: true` ohne Tray.** Zwischen Task 10 und Task 12 ist ein
  ausgeblendetes Widget auf Windows durch nichts mehr erreichbar (keine
  Taskleiste, kein Tray). Nicht in diesem Zwischenstand testen oder ausliefern.
