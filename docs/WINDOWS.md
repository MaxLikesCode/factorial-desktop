# Factorial Desktop — Windows-Übergabe

**Status:** wächst mit der Implementierung. Stand: Ende Task 14 (Packaging).
Task 15 trägt hier weiter ein.

> **Für Windows ist Task 12 der wichtigste Abschnitt dieses Dokuments.** Der
> Live-Timer in der Menubar ist ein macOS-Feature; auf Windows tragen ihn
> Tooltip, farbcodiertes Icon und der erste, deaktivierte Menüeintrag. Und erst
> seit diesem Task gibt es auf Windows überhaupt einen Weg, die App zu beenden.

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
| `npm run package:mac` | Build + electron-builder DMG/ZIP arm64, unsigniert (auf macOS ausgeführt, siehe Abschnitt 4) |
| `npm run package:win` | Build + electron-builder NSIS (**nie ausgeführt**) |

Beide `package:`-Skripte laufen über `npm run build`, also **inklusive
Typecheck** — ein Typfehler bricht das Packaging ab, bevor electron-builder
überhaupt startet. Die Artefakte landen in `release/`, das in `.gitignore` steht.

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
| `src/main/tray.ts` | das `Tray`-Objekt: Icons, Menubar-Titel, Tooltip, Render-Takt, Klick-Verhalten (Electron-Teil) |
| `src/main/tray-menu.ts` | was das Tray anzeigt und anbietet: Label, Statuszeile, Tooltip, Menü, deutscher Fehlertext (Electron-frei, getestet) |
| `src/shared/errors.ts` | die **einzige** Stelle, die aus einem Fehler-`kind` deutschen Text macht — seit Task 12 in `shared`, weil Renderer *und* Main sie brauchen |
| `resources/` | Tray-Icons plus `make-tray-icons.py`, das sie erzeugt |
| `electron-builder.yml` | Packaging: `appId`, Artefakt-Targets, `files`-Globs, NSIS-Optionen |
| `build/` | App-Icons (`icon.icns`, `icon.ico`) plus `make-app-icon.py`, das sie erzeugt. Das Verzeichnis ist `directories.buildResources` und wird von electron-builder **nicht** mit ins Paket gelegt |
| `src/preload/index.ts` | `contextBridge` — die einzigen zehn Funktionen, die der Renderer sieht |
| `src/shared/ipc-contract.ts` | Kanalnamen, Snapshot-Serialisierung, Fehler-Codec (von Main **und** Renderer benutzt) |
| `src/shared/time.ts` | Zeitrekonstruktion (der gefährlichste Code im Repo) |
| `src/shared/attendance-state.ts` | Zustandsableitung aus `openShift` |
| `src/renderer/src/App.tsx` | Wurzel: Widget plus `Toaster` |
| `src/renderer/src/components/StatusWidget.tsx` | das Widget: Statuszeile, Ring, Aktionen, Fußzeile |
| `src/renderer/src/hooks/useAttendance.ts` | Snapshot-Abo über die Bridge + Sekundentakt für den Timer |
| `src/renderer/src/lib/errors.ts` | nur noch ein Re-Export von `src/shared/errors.ts` (Task 12) |
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
>
> **Seit Task 14 reicht `src/` als Suchraum nicht mehr.** Die
> Windows-Konfiguration steht in `electron-builder.yml`, also außerhalb von
> `src/`. Vollständig ist erst `grep -rn "PLATFORM:" src/ electron-builder.yml`
> — 16 Treffer in `src/`, einer in der YAML.

| Datei:Zeile | Was | Warum | Auf Windows zu prüfen |
|---|---|---|---|
| `src/main/settings.ts:143` | `platform === 'win32'` → `{ openAtLogin, path, args: [] }` | Windows-Autostart ist ein Eintrag im Registry-Run-Key und braucht einen Pfad auf eine `.exe`. Ohne explizites `path` trägt Electron das ein, was gerade läuft — im Dev-Modus `electron.exe`, im gepackten Zustand potenziell der falsche Launcher (DESIGN.md, Zeile „Autostart"). | Haken „Autostart" setzen, abmelden/anmelden: die App muss starten. Danach `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"` — der Eintrag muss auf die installierte `.exe` zeigen, nicht auf `electron.exe`. Haken entfernen → Eintrag verschwindet. **Im Dev-Modus bewusst nicht ausprobieren**, sonst startet dauerhaft eine Electron-Instanz mit |
| `src/main/settings.ts:150` | alles außer `win32` → `{ openAtLogin }` ohne Pfad | macOS registriert das `.app`-Bundle selbst über die Service-Management-API; ein `path` würde auf das Helper-Binary im Bundle zeigen. Linux fällt in denselben Zweig, wo `setLoginItemSettings` ein No-op ist — das ist das harmlose Ergebnis. | Nichts; der Zweig ist auf Windows unerreichbar |
| `src/main/index.ts:53` | `applyLoginItem` liest `process.platform`/`process.execPath` und gibt sie an `buildLoginItemSettings` weiter | Die einzige Stelle, die `app.setLoginItemSettings` aufruft. Die Verzweigung selbst ist absichtlich ausgelagert und rein, damit der Windows-Zweig auf macOS getestet werden kann. | Nur zusammen mit den beiden Zeilen oben |
| `src/main/index.ts:184` | `app.requestSingleInstanceLock()`, sonst `app.quit()` | Ohne Lock startet auf Windows bei jedem Aufruf eine zweite komplette Instanz, inklusive zweitem Tray-Icon und zweitem Poll-Loop. Auf macOS übernimmt das die Plattform. | Zweiten Start auslösen (Verknüpfung, Autostart, Doppelklick): es darf keine zweite Instanz erscheinen |
| `src/main/index.ts:187` | `second-instance`-Handler ruft `showWidget()` | Gegenstück zum Lock: der zweite Start gibt hier ab, sonst passiert für den Nutzer sichtbar gar nichts. Auf macOS feuert das Event praktisch nie. Seit Task 10 zielt der Handler ausdrücklich auf das Widget statt auf `getAllWindows()[0]` — letzteres hätte das Login-Fenster nach vorn geholt, wenn gerade eines offen war. | Zweiten Start auslösen (Verknüpfung, Autostart, Doppelklick); das Widget muss sichtbar und fokussiert nach vorn kommen, auch wenn es vorher ausgeblendet oder minimiert war |
| `src/main/index.ts:208` | `window-all-closed` beendet die App **nur, wenn es kein Tray gibt** | Seit Task 12 entscheidet nicht mehr die Plattform, sondern das Tray. Mit Tray ist das hier eine Tray-App: Schließen des Widgets blendet nur aus (Task 10), und die App hinter dem Rücken des Benutzers zu beenden, während ihr Icon im Infobereich „Beenden" anbietet, wäre falsch — auf Windows genauso wie auf macOS. Ohne Tray (Bootstrap gescheitert, Login-Fenster geschlossen) gibt es keine sichtbare Oberfläche und wegen `skipTaskbar: true` auch keinen Weg zurück: dann ist das letzte geschlossene Fenster das Ende. Der Handler muss registriert bleiben, weil Electron sonst von sich aus beendet, sobald das letzte Fenster **zerstört** wird. | Widget schließen → App läuft weiter, Tray-Icon bleibt. „Beenden" im Tray → Prozess ist wirklich weg (Task-Manager). Login-Fenster bei fehlgeschlagenem Bootstrap schließen → App beendet sich, es bleibt kein unsichtbarer Prozess übrig |
| `src/main/tray.ts:105` | `iconFor`: `darwin` → `trayTemplate.png` + `setTemplateImage(true)`, sonst → `tray-<tone>.ico` | macOS erwartet ein monochromes Template-Bild und färbt es selbst für Hell-/Dunkelmodus und die hervorgehobene Menubar; ein farbiges Icon würde gegen das System arbeiten. Weil macOS den Zustand daneben als Text zeigt, reicht dort **ein** Icon. Windows hat diesen Text nicht — dort **ist** die Farbe der Zustand, deshalb vier `.ico` (grau/grün/amber/rot, dieselben Farben wie der Statuspunkt im Widget) mit je 16/32/48 px. | Icon in allen vier Zuständen ansehen: ausgestempelt grau, eingestempelt grün, Pause amber, Sitzung abgelaufen rot. Bei 100 %, 150 % und 200 % Skalierung prüfen, ob die 16/32/48-Auflösungen sauber greifen und das Glyph nicht matschig ist |
| `src/main/tray.ts:117` | Fallback auf `tray-<tone>.png`, wenn das `.ico` leer dekodiert | Ob die `.ico`-Dateien auf Windows dekodieren, war auf macOS **nicht** prüfbar: Electron hat dort überhaupt keinen ICO-Decoder (gemessen: jede `.ico` kommt als leeres 0×0-Bild zurück, auch eine mit klassischen BMP-Einträgen). Ein leeres Tray-Bild ist auf Windows ein unsichtbares Icon — und damit eine App, die man weder zeigen noch beenden kann. PNG dekodiert überall. | Wenn das Icon sichtbar ist, hat das `.ico` funktioniert. Erscheint stattdessen `[tray] icon missing or unreadable` in der Konsole, greift der Fallback: dann `resources/make-tray-icons.py` anpassen (z. B. `bitmap_format` entfernen, um PNG-Einträge zu schreiben) und erneut probieren |
| `src/main/tray.ts:154` | `setTitle` nur auf `darwin` | Der Live-Timer in der Menubar ist ein macOS-Feature (DESIGN.md, „Tray"): `tray.setTitle` existiert auf Windows nicht. | Nichts; auf Windows unerreichbar. Die Zeit muss stattdessen im Tooltip und im ersten Menüeintrag stehen — genau das ist unten zu prüfen |
| `src/main/tray.ts:160` | sonst `setImage(iconFor(trayTone(snapshot)))` bei jedem Render | Das Gegenstück: ohne Text neben dem Icon trägt allein die Icon-Farbe den Zustand, also muss das Bild bei jedem Zustandswechsel neu gesetzt werden. | Ein-/Ausstempeln und Pause auslösen: das Icon muss binnen 15 s (Render-Takt) bzw. sofort (Store-Änderung) die Farbe wechseln, ohne zu flackern |
| `src/main/tray.ts:267` | Linksklick → `toggleWidget()`, nur wenn **nicht** `darwin` | Auf Windows öffnet das Kontextmenü per Rechtsklick, der Linksklick ist per Konvention „App öffnen". Auf macOS öffnet der Linksklick das Menü selbst — dort zusätzlich das Fenster zu schalten, würde gegen die Plattform arbeiten. | Linksklick auf das Tray-Icon blendet das Widget ein und wieder aus; Rechtsklick öffnet das Menü. Zusätzlich prüfen, ob der Doppelklick (beide Plattformen, `showWidget`) nicht mit dem Einfachklick kollidiert — auf Windows feuert vor dem Doppelklick immer auch ein `click` |
| `src/main/tray-menu.ts:116` | `trayLabel` ist der Text für `setTitle` — Kommentar, keine Verzweigung | Dokumentiert, dass diese Funktion auf Windows **keinen** Konsumenten hat. Ihr Inhalt taucht dort nur über `trayStatusLine` auf. | Nichts direkt |
| `src/main/tray-menu.ts:143` | `trayStatusLine` ist auf Windows die einzige Stelle mit der laufenden Zeit — Kommentar, keine Verzweigung | Sie füllt den Tooltip **und** den ersten, deaktivierten Menüeintrag. Beide sind auf Windows der Ersatz für den fehlenden Menubar-Titel. | Tooltip anzeigen lassen: `Factorial · Eingestempelt · 1:30`. Menü öffnen: derselbe Text als erster, ausgegrauter Eintrag. Beides muss sich mit der Zeit fortschreiben |
| `src/main/windows.ts:104` | `transparent: true` + `backgroundColor: '#00000000'` | macOS zeichnet ein transparentes, frameless Fenster mit runden Ecken und weichem Schatten von selbst. Windows setzt hinter ein transparentes Fenster sonst ein weißes Rechteck und zeichnet einen eckigen Schatten drumherum. | Sichtprüfung: keine weißen Ecken hinter dem Widget, kein eckiger Schattenrahmen. Falls doch, sind `transparent`, `thickFrame: false` und ein Renderer-seitiger `border-radius` die Stellschrauben (DESIGN.md, „Frameless & Transparenz") |
| `src/main/windows.ts:123` | `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` nur auf `darwin` | Der Sinn eines schwebenden Zeit-Widgets ist, über Vollbild-Spaces sichtbar zu bleiben. `visibleOnFullScreen` ist eine macOS-Option; auf Windows gibt es kein Äquivalent, dort trägt allein `alwaysOnTop`. | Prüfen, ob das Widget über einer Vollbild-App sichtbar bleibt. Wenn nicht: `setAlwaysOnTop(true, 'screen-saver')` ist die Windows-taugliche Verschärfung, hat aber Nebenwirkungen auf Fokus und Taskleiste |
| `src/renderer/src/styles.css:32` | `.drag-region { -webkit-app-region: drag }` plus `.no-drag` für alles Anklickbare darin | Das Fenster ist `frame: false` und hat keine Titelleiste zum Anfassen; die Drag-Region **ist** die einzige Möglichkeit, das Widget zu verschieben. Chromium kennt die Eigenschaft auf beiden Plattformen, verhält sich aber nicht gleich. | Widget an der Kopfzeile ziehen: es muss sich bewegen und die Position nach dem Debounce speichern. Dann drei Windows-Eigenheiten prüfen: (1) an den oberen Bildschirmrand ziehen darf **kein** Aero Snap auslösen — das Fenster ist `resizable: false`, ein Snap-Versuch führt dort erfahrungsgemäß zu einem verzerrten oder unverschiebbaren Fenster; (2) Buttons und das Arbeitsort-Select innerhalb der Region müssen klickbar bleiben (dafür ist `.no-drag` da; unter Windows greift die Vererbung teils anders); (3) `moved` feuert unter Windows beim Ziehen laufend statt einmal — der 250-ms-Debounce in `src/main/windows.ts` ist genau dafür da |

| `electron-builder.yml:26` | der ganze `win:`-Block (`nsis`, `x64`) plus die `nsis:`-Optionen | Die einzige plattformabhängige Stelle außerhalb von `src/`: macOS bekommt DMG + ZIP, Windows einen NSIS-Installer. Kein Code, sondern Konfiguration — und die einzige im Repo, die **nie** ausgeführt wurde. | `npm run package:win` als Allererstes ausprobieren. Danach: enthält `build/icon.ico` genug Auflösungen (16–256 px sind drin), installiert der Installer in ein wählbares Verzeichnis (`allowToChangeInstallationDirectory: true`), und läuft er ohne Adminrechte durch (`perMachine: false`)? Siehe Abschnitt 4 für das, was auf macOS belegt ist |

Task 7 (`src/main/attendance.ts`) hat **keine** neue plattformabhängige Stelle
hinzugefügt: der Store kennt weder Fenster noch Tray und benutzt nur Promises und
`setTimeout`. Task 8 (IPC, Preload, Contract) ebenfalls nicht — IPC verhält sich
auf allen Plattformen gleich. Task 9 hat drei Einträge ergänzt (Autostart),
Task 10 zwei weitere (Transparenz, Vollbild-Sichtbarkeit) und zwei bestehende
umgeschrieben, Task 11 einen (die Drag-Region im CSS), Task 12 sieben (fünf im
Tray, zwei erklärende Kommentare in `tray-menu.ts`) und den
`window-all-closed`-Eintrag komplett umgeschrieben; Task 14 einen
(`electron-builder.yml`). Die Tabelle hat damit **siebzehn** Einträge und deckt
`grep -rn "PLATFORM:" src/ electron-builder.yml` vollständig ab (Stand Task 14:
16 Treffer in sechs Dateien unter `src/`, plus einer in der YAML). Die Tasks 13
(Soll-Zeit im Ring) und 14 haben in `src/` **keine** neue Verzweigung erzeugt:
die Soll-Zeit ist reine Rechnung, und das Packaging ist Konfiguration.

Die nachgereichte **„Einstellungen"-Ebene im Tray-Menü** (Autostart, Immer im
Vordergrund, Abmelden) hat **keinen** neuen Eintrag erzeugt: sie ist reine
Menülogik in `src/main/tray-menu.ts` und schreibt über denselben
`src/main/settings.ts`, dessen beide Plattformzweige oben schon stehen. Sie ist
aber der Grund, warum die Zeilen zu Autostart und Always-on-Top jetzt überhaupt
von Hand auslösbar sind — vorher gab es in der laufenden App keine Oberfläche
dafür. Die Zeilennummern der Tray-Einträge oben sind mit dieser Änderung
nachgezogen worden.

Zwei der sechzehn Treffer sind **Kommentare ohne Verzweigung**
(`src/main/tray-menu.ts`): die Datei ist bewusst plattformfrei und pur, aber sie
produziert Texte, deren Konsument je nach Plattform ein anderer ist. Das gehört
in dieselbe Liste, sonst sucht jemand die Windows-Entsprechung von `setTitle` im
falschen Modul.

Die Tray-Tests (`src/main/__tests__/tray-menu.test.ts`) tragen **absichtlich
keine** `PLATFORM:`-Marker, obwohl sie plattformabhängiges Verhalten festhalten:
die Liste soll produktiven Code auflisten, nicht Testkommentare.

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
„Windows-Übergabe". Für die bisher gebauten Teile (Tasks 1–12) sind relevant:

| Thema | Was auf Windows anders ist | Betrifft |
|---|---|---|
| Single-Instance | zwingend, siehe oben | `src/main/index.ts` (erledigt, ungetestet) |
| IPC und Preload | kein Unterschied. Der Pfad zum Preload wird aus `import.meta.dirname` zusammengesetzt, nicht als String gebaut — auf Windows kommen dabei Backslashes heraus, was `BrowserWindow` erwartet | `src/main/index.ts`, `src/preload/index.ts` |
| Login-Fenster | Frameless/Transparenz spielt hier keine Rolle — das Fenster ist bewusst ein normales Fenster mit Titelleiste. Titel `Bei Factorial anmelden` erscheint auf Windows in der Titelleiste, auf macOS nur im Fenstermenü | `src/main/auth.ts` |
| Session-Partition | `persist:factorial` liegt unter `%APPDATA%\factorial-desktop`; auf macOS unter `~/Library/Application Support/factorial-desktop`. Kein Codeunterschied, aber der relevante Ort zum Zurücksetzen | `src/main/session.ts` |
| Autostart | `app.setLoginItemSettings` schreibt auf Windows in den Registry-Run-Key, auf macOS in die Service-Management-Datenbank. Auf Windows **müssen** `path` und `args` gesetzt sein (siehe Tabelle in Abschnitt 2), auf macOS dürfen sie es nicht. `openAsHidden` ist macOS-only und wird bewusst nicht gesetzt — das Widget soll beim Start sichtbar sein. **Auslösbar ist der Schalter nur über das Tray:** Tray-Menü → „Einstellungen" → „Autostart" (Checkbox). Eine andere Oberfläche dafür gibt es in der App nicht | `src/main/settings.ts` (`buildLoginItemSettings`), `src/main/index.ts` (`applyLoginItem`), `src/main/tray-menu.ts` (`settingsSubmenu`) — geschrieben, auf Windows ungetestet |
| Einstellungsdatei | gleicher Code, anderer Ort: `%APPDATA%\factorial-desktop\settings.json`. Geschrieben wird über eine `.tmp`-Datei plus `renameSync`; das ist auf NTFS ebenso atomar wie auf APFS, **aber** ein Virenscanner kann das `rename` kurzzeitig mit `EBUSY` blockieren. Wenn Einstellungen auf Windows sporadisch nicht speichern: hier zuerst nachsehen | `src/main/settings.ts` |
| Frameless & Transparenz | Keine macOS-Vibrancy, kein automatischer runder Schatten. Ecken und Schatten kommen auf Windows aus dem Renderer bzw. gar nicht. Das Fenster ist `resizable: false`, damit entfällt das abweichende Resize-Verhalten transparenter Fenster | `src/main/windows.ts` (geschrieben, auf Windows ungetestet) |
| Always-on-Top | `alwaysOnTop` wird beim Erzeugen gesetzt **und** zur Laufzeit über `setWidgetAlwaysOnTop` nachgezogen. Die Level-Namen (`'floating'`, `'screen-saver'`, …) sind plattformspezifisch; hier wird bewusst kein Level angegeben, es gilt der Standard. Umgeschaltet wird über Tray-Menü → „Einstellungen" → „Immer im Vordergrund"; Tray und IPC benutzen **dieselbe** `withWindowEffects`-Instanz, damit der Schalter auf beiden Wegen sofort am lebenden Fenster wirkt | `src/main/windows.ts`, `src/main/index.ts` (`withWindowEffects`), `src/main/tray.ts` |
| Fensterposition | Multi-Monitor mit gemischten DPI-Skalierungen verhält sich anders. Gespeicherte Positionen werden vor Gebrauch gegen die aktuell angeschlossenen Displays validiert — beim Start **und** bei jedem `display-added`/`display-removed`/`display-metrics-changed`. Gerechnet wird mit `workArea` (ohne Taskleiste), Koordinaten sind in DIP, nicht in physischen Pixeln | `src/main/window-position.ts` (getestet), `src/main/windows.ts` (Verdrahtung) |
| Schließen-Verhalten | Das Schließen blendet aus statt zu beenden (DESIGN.md, „Tray"). Auf Windows ist die Erwartung „X beendet die App" stärker als auf macOS; das Tray-Icon ist dort deshalb keine Zierde, sondern der einzige sichtbare Beleg, dass die App noch läuft — zumal `skipTaskbar: true` gesetzt ist. Seit Task 12 gibt es „Beenden" im Tray-Menü, und `window-all-closed` beendet nur noch, wenn gar kein Tray existiert | `src/main/windows.ts`, `src/main/index.ts`, `src/main/tray.ts` |
| Tray-Titel | `tray.setTitle()` ist macOS-only und trägt dort den Live-Timer. Windows bekommt stattdessen **drei** Ersatzkanäle: farbcodiertes Icon (Zustand), Tooltip (`Factorial · Eingestempelt · 1:30`) und die Zeit als ersten, deaktivierten Menüeintrag. Der Live-Timer *in der Taskleiste* bleibt ein macOS-Feature — auf Windows aktualisiert sich der Text erst beim Hovern bzw. Öffnen des Menüs | `src/main/tray.ts`, `src/main/tray-menu.ts` (geschrieben, auf Windows ungetestet) |
| Tray-Icon | macOS: `trayTemplate.png` @1x/@2x, monochrom, System färbt. Windows: `tray-{idle,active,paused,alert}.ico`, farbig, je 16/32/48 px. Erzeugt von `resources/make-tray-icons.py` (Pillow), die Dateien sind eingecheckt. **Auf macOS nicht prüfbar**: Electron hat dort keinen ICO-Decoder, deshalb der PNG-Fallback in `iconFor` | `resources/`, `src/main/tray.ts` (ungetestet) |
| Tray-Menü | Gleiche Einträge auf beiden Plattformen, aber auf Windows ist es der Hauptzugang: Zustand + Zeit (deaktiviert), letzte Fehlermeldung (deaktiviert, deutsch), Ein-/Ausstempeln bzw. Pause-Untermenü/Fortsetzen, Fenster zeigen/ausblenden, Aktualisieren, **Einstellungen** (Untermenü: „Autostart" und „Immer im Vordergrund" als Checkboxen, dazu „Abmelden", solange eine Sitzung besteht), Beenden. Das Untermenü ist die **einzige** Oberfläche für DESIGN.md, Abschnitt „Einstellungen" — das Widget hat keine. Untermenüs mit dynamischen Einträgen (die Pausentypen) sind auf Windows unauffällig, aber das Menü wird bei **jedem** Render neu gebaut — falls es dort beim Öffnen flackert, ist der 15-s-Takt in `RENDER_INTERVAL_MS` die Stellschraube | `src/main/tray.ts`, `src/main/tray-menu.ts` |
| Standby und Bildschirmsperre | `powerMonitor.on('suspend'/'resume')` ist auf beiden Plattformen vorhanden, feuert auf Windows aber auch bei „Moderner Standby" (S0) anders als beim klassischen S3. Die App stoppt beim Suspend das Polling und lädt beim Resume einmal neu. Bleibt die Uhr nach dem Zuklappen stehen, ist zuerst zu prüfen, ob `resume` überhaupt kam | `src/main/index.ts` (geschrieben, ungetestet) |
| Positionsdatei | `%APPDATA%\factorial-desktop\window-position.json`, gleiche Schreibweise wie bei den Einstellungen (`.tmp` + `rename`). Schreibfehler werden hier bewusst **verschluckt**, weil der Schreibvorgang aus einem `moved`-Handler kommt | `src/main/window-position.ts` |
| Drag-Region | siehe Abschnitt 2, letzte Zeile. Kurz: Aero Snap, `.no-drag`-Vererbung, `moved`-Frequenz | `src/renderer/src/styles.css` (geschrieben, auf Windows ungetestet) |
| Schriftart | `@fontsource-variable/geist` wird als WOFF2 mitgebaut und nicht vom System geholt — es gibt also keinen Fallback-Unterschied zwischen macOS und Windows. Was sich unterscheidet, ist das **Rendering**: Windows hinted anders, die Zeilen im Widget können dadurch 1–2 px höher ausfallen. Das Fenster ist `resizable: false` bei 340×224, ein Überlauf würde also abgeschnitten statt zu scrollen | `src/renderer/src/styles.css`, `src/main/windows.ts` (`WIDGET_SIZE`) |
| Renderer-Fonts und Emoji | Die UI benutzt bewusst **keine** Emoji oder Unicode-Blockzeichen als Icons (der Plan-Schnipsel hatte `❙❙` für „Pause") — auf Windows rendern die als farbiges Emoji oder als Ersatzkästchen. Stattdessen Lucide-SVGs plus deutsches Wort | `src/renderer/src/components/BreakMenu.tsx` |
| Toasts | `sonner` rendert in denselben transparenten, 340×224 großen Renderer. Position ist `bottom-center`, damit ein Toast nicht über die abgerundete Ecke hinausragt. Ob er auf Windows in ein transparentes, frameless Fenster genauso sauber zeichnet, ist ungeprüft | `src/renderer/src/App.tsx` |
| Packaging | macOS ist gebaut (DMG + ZIP, arm64, unsigniert), Windows ist **nur konfiguriert**. Zwei Dinge, die auf Windows anders sind: das Artefakt (NSIS-Installer statt DMG) und das App-Icon (`build/icon.ico` statt `build/icon.icns`). `resources/` liegt nachweislich im Paket — `src/main/tray.ts` sucht die Icons unter `import.meta.dirname/../../resources`, also `app.asar/resources`, und genau diese zwölf Dateien sind im gebauten `app.asar` enthalten (nachgezählt, Abschnitt 4). Wird das Verzeichnis je ausgeschlossen oder nach `extraResources` verschoben, ist `ICON_DIR` nachzuziehen | `electron-builder.yml`, `build/`, `src/main/tray.ts` |
| App-Icon | `build/icon.icns` (macOS) und `build/icon.ico` (Windows, 16/24/32/48/64/128/256 px) erzeugt `build/make-app-icon.py` aus **einem** 1024-px-Master. Der `.icns`-Teil des Skripts ruft `iconutil` auf und läuft deshalb **nur auf macOS**; die fertige Datei ist eingecheckt, Windows braucht sie nicht. Der `.ico`-Teil ist reines Pillow und läuft überall | `build/` |

## 4. Was verifiziert wurde und was nicht

**Verifiziert auf macOS (Darwin 25.5, Electron 43):**

- `npm test` — 364 Tests grün, `npm run typecheck` sauber, `npm run build`
  fehlerfrei (Stand Task 14).
- **Das macOS-Packaging** (Task 14). `npm run package:mac` ist gelaufen und hat
  `release/Factorial-0.1.0-arm64.dmg` (119,2 MB) und
  `release/Factorial-0.1.0-arm64-mac.zip` (119,1 MB) erzeugt. Am Ergebnis
  nachgeprüft, nicht am Log:
  - `Contents/Info.plist` des gebauten Bundles: `CFBundleIdentifier =
    com.maxgiess.factorial-desktop`, `CFBundleName = Factorial`,
    `CFBundleIconFile = icon.icns`, `CFBundleShortVersionString = 0.1.0` und
    **`LSUIElement = 1`** — das gepackte Programm bringt also kein Dock-Icon mit.
  - `codesign -dvv` meldet `Signature=adhoc`, `TeamIdentifier=not set`:
    unsigniert wie beabsichtigt (`identity: null`), electron-builder protokolliert
    dazu `skipped macOS code signing`. Der erste Start muss deshalb über
    **Rechtsklick → Öffnen** gehen.
  - Das DMG wurde read-only gemountet: es enthält `Factorial.app` und den
    üblichen Symlink auf `/Applications`; dieselben Info.plist-Werte wie oben.
    Das ZIP enthält dasselbe Bundle (587 Einträge).
  - Inhalt von `Contents/Resources/app.asar`, ausgezählt: `out/main/index.js`,
    `out/preload/index.mjs`, zehn Dateien unter `out/renderer/` und **alle zwölf
    Dateien aus `resources/`**, inklusive `trayTemplate.png`, `trayTemplate@2x.png`
    und der vier `.ico`. Der Pfad, den `src/main/tray.ts` erwartet
    (`app.asar/resources`), existiert also im Paket.
  - **Carry-Forward C1 ist am Artefakt belegt, nicht nur an der `package.json`:**
    im `app.asar` liegt weder `shadcn` noch `@fontsource-variable/geist` noch
    `tw-animate-css`. Die Geist-Schrift ist stattdessen als fünf `.woff2` in
    `out/renderer/assets/` einkompiliert, kommt also weiterhin mit — nur eben
    gebündelt statt als Paket.
- **Die Soll-Zeit im Ring** (Task 13) — aber nur als Unit-Test. Belegt ist die
  Verdrahtung Store → IPC → Ring gegen einen gefälschten `fetchExpectedMinutes`:
  der Wert landet im Snapshot, übersteht die Serialisierung, ein fehlgeschlagener
  Abruf lässt Zustand und Tagessumme unangetastet, und ohne Soll (`null` **oder**
  `0`) verschwindet die Zeile „Verbleibende Zeit" und der Ring bleibt leer. Der
  Abgleich mit dem echten Stundenzettel ist **nicht** gelaufen — siehe unten.
- **Das Tray in einem echten Electron** (Task 12, Smoke-Lauf mit gefälschtem
  Store; `Menu.buildFromTemplate` wurde dabei mitgeschnitten, um das erzeugte
  Menü lesen zu können). Nachweislich gelaufen:
  - `trayTemplate.png` lädt als 16×16-Bild, `new Tray(...)` erzeugt ein echtes
    Icon in der Menubar, `hasTray()` stimmt.
  - `tray.getTitle()` ist `" 5:30"` bei 240 gebuchten Minuten plus 90 Minuten
    laufender Schicht — der Menubar-Timer zeigt also dieselbe Tageszeit wie der
    Ring im Widget.
  - Eine Store-Änderung rendert das Tray ohne Zutun neu: nach dem Wechsel in die
    Pause steht `" Pause 0:15"` im Titel und
    `In einer Pause · Mittagspause · 0:15` als erster, deaktivierter
    Menüeintrag.
  - Das Pausen-Untermenü trägt die echten Namen aus dem Snapshot
    (`Mittagspause`, `Arztbesuch`), das Menü enthält `Ausstempeln` und
    `Beenden`.
  - **Der Fehlerpfad**: `Ausstempeln` gegen einen Store, der mit
    `FactorialError('network', 'request timed out after 15000 ms')` ablehnt →
    im Menü steht `Keine Verbindung zu Factorial. Es wurde nichts gespeichert.`
    als deaktivierter Eintrag. Die englische Originalmeldung taucht nirgends
    auf. Beim Start der nächsten Aktion verschwindet der Eintrag wieder.
  - `Einstempeln` schickt die **gemerkte** Arbeitsort-Einstellung
    (`{locationType:'work_from_home', workplaceId:3333333}`), nicht das
    hartkodierte `office` aus dem Plan-Schnipsel.
  - `Aktualisieren` ruft `store.refresh()`.
  - `Beenden` beendet die App wirklich, und `before-quit` zerstört das Tray
    (`hasTray() === false`).
- **Das „Einstellungen"-Untermenü in einem echten Electron** (Nachtrag zu
  Task 12, zweiter Smoke-Lauf mit gefälschtem Store, echtem Settings-Store in
  einem Temp-Verzeichnis und mitgeschnittenem `Menu.buildFromTemplate`).
  Nachweislich gelaufen:
  - Das Menü der obersten Ebene lautet
    `Eingestempelt · 5:30 | --- | Pause | Ausstempeln | --- | Fenster zeigen |
    Aktualisieren | Einstellungen | --- | Beenden` — „Einstellungen" steht also
    an der von DESIGN.md („Tray", Kontextmenü) genannten Stelle.
  - Das Untermenü ist `Autostart[true] | Immer im Vordergrund[true] | --- |
    Abmelden`; beide Schalter sind echte `type: 'checkbox'`-Einträge und zeigen
    den gespeicherten Wert.
  - Klick auf „Autostart" schreibt `"openAtLogin": false` in die
    `settings.json`, ruft `applyLoginItem(false)` **einmal** und das neu gebaute
    Untermenü zeigt danach `Autostart[false]`.
  - Klick auf „Immer im Vordergrund" setzt `alwaysOnTop` auf `false` (die
    Fensterwirkung selbst hängt an `withWindowEffects` und wurde in diesem Lauf
    ohne Fenster nicht geprüft).
  - Klick auf „Abmelden" ruft denselben Callback wie „Anmelden".
  - **Nicht geprüft:** wie das Untermenü aussieht (Häkchen-Darstellung), und der
    Fehlerpfad eines fehlgeschlagenen Schreibvorgangs
    (`SETTINGS_WRITE_FAILED`) — der ist nur durch Unit-Tests und Lesen belegt.
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

- **Die `.ico`-Dateien.** Electron kann auf macOS überhaupt kein ICO lesen:
  `nativeImage.createFromPath('resources/tray-active.ico')` liefert ein leeres
  0×0-Bild — auch dann, wenn die Datei klassische BMP-Einträge statt
  eingebetteter PNGs enthält (beides ausprobiert). Ob die Dateien *inhaltlich*
  in Ordnung sind, kann hier also niemand feststellen. Deshalb der PNG-Fallback
  in `iconFor` und die Fehlerzeile `[tray] icon missing or unreadable` in der
  Konsole. **Erster Prüfpunkt auf Windows.**
- **Der farbcodierte Icon-Wechsel, der Tooltip und der Linksklick auf das Tray**
  — alles Windows-Zweige, auf macOS unerreichbar.
- **Der 15-Sekunden-Render-Takt über längere Zeit.** Im Smoke-Lauf wurde nur der
  Render selbst ausgelöst, nicht abgewartet. Ob der Menubar-Titel über Stunden
  sauber weiterzählt, ist ungeprüft — er wird bei jedem Tick neu gerechnet, kann
  also nicht driften, aber der Takt selbst ist nicht beobachtet worden.
- **Der Refresh beim Öffnen des Trays.** Electron meldet kein „Menü geöffnet";
  ersatzweise lösen `mouse-enter`, `click` und `right-click` einen Refresh aus,
  gedrosselt auf einen alle 10 s. Ausgelöst wurde davon nichts — dazu braucht es
  eine echte Maus.
- **`powerMonitor`-Suspend/Resume und der Focus-Refresh des Widgets.**
  Verdrahtet in `src/main/index.ts`, nie ausgelöst: Suspend hätte einen echten
  Standby gebraucht, Focus ein Fenster hinter einer echten Anmeldung.
- **Der Poll-Loop im laufenden Betrieb** (`store.startPolling()` in
  `bootstrap`). Der Store ist dafür unit-getestet, aber gestartet wurde er nie
  gegen die echte API.
- **Die Soll-Zeit gegen die echte API** (Task 13, Schritt 5). `fetchExpectedMinutes`
  ist seit Task 5 gegen die Live-API verifiziert (`expectedMinutes: 480` am
  2026-08-12), aber die Kette bis in den Ring lief nie mit echten Daten: dafür
  hätte `npm run dev` eine echte Anmeldung gebraucht. Offen ist damit auch, ob
  ein freier Tag `expectedMinutes: 0` **oder** ein leeres `nodes`-Array liefert —
  beide Fälle sind im Code abgedeckt, beobachtet wurde keiner. Erster Prüfpunkt,
  sobald jemand die App angemeldet startet: zeigt „Verbleibende Zeit" dasselbe
  wie der Stundenzettel im Factorial-Web (**nicht** das Dashboard-Widget, K9)?
- **`window-all-closed` mit und ohne Tray.** Die Verzweigung hängt an
  `hasTray()`; beide Zweige sind nur gelesen, nicht gelaufen.

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
- **Das Zusammenspiel Tray ↔ echter Store ↔ Widget.** Der Smoke-Lauf benutzte
  einen gefälschten Store und kein Fenster. Ungeprüft bleiben damit: ob eine
  Tray-Aktion das sichtbare Widget aktualisiert (sie muss, beide hängen am
  selben Store), ob `Fenster zeigen/ausblenden` das echte Widget schaltet, und
  ob `Anmelden` aus dem Tray die Session wirklich neu aufbaut.
- **Die gepackte App im Betrieb** (Plan-Task 14, Schritt 4). Das DMG ist gebaut
  und sein Inhalt ausgelesen, aber `Factorial.app` wurde **nie gestartet** —
  weder aus dem Volume noch aus `/Applications`. Zwei Gründe, beide bewusst:
  `src/main/index.ts` ruft beim Start `applyLoginItem(settings.get().openAtLogin)`
  auf, und `openAtLogin` ist per Voreinstellung `true` — ein Start hätte also
  einen echten Eintrag in den macOS-Anmeldeobjekten erzeugt, der auf den
  Release-Ordner zeigt. Und der interessante Teil des Schritts (Ein-/Ausstempeln
  aus der gepackten App) schreibt in eine echte Arbeitszeiterfassung. Beides ist
  eine Handlung, die der Mensch auslöst. **Damit ist ungeprüft:** ob die App aus
  dem Bundle heraus überhaupt hochkommt, ob das Tray-Icon aus `app.asar/resources`
  wirklich geladen wird (der Pfad existiert nachweislich, das Laden nicht),
  ob `LSUIElement` das Dock-Icon tatsächlich unterdrückt, ob die Session aus
  `~/Library/Application Support/factorial-desktop` auch für das Bundle gilt,
  und ob der Anmeldeobjekt-Eintrag den richtigen Pfad bekommt.
- **`npm run package:win`.** Nie ausgeführt — es gab keine Windows-Maschine.
  Belegt ist nur, dass electron-builder die Konfiguration **lädt** (es
  protokolliert `loaded configuration file=…/electron-builder.yml` beim
  macOS-Lauf) und dass `build/icon.ico` die von electron-builder geforderte
  256-px-Auflösung enthält (im Test nachgerechnet, nicht von einem Windows-Build
  akzeptiert).
- Sämtlicher Windows-Code.

**Nur kompiliert, nie ausgeführt:** die Windows-Ausprägung der
`PLATFORM:`-Zweige aus Abschnitt 2, inklusive der neuen Drag-Region und
sämtlicher Tray-Zweige; `npm run package:win`.

**Checkliste für den ersten echten Start mit Anmeldung** (die Punkte aus Task 11
plus Task 12, in dieser Reihenfolge abzuarbeiten):

1. `typeof window.factorial === 'object'` in der Renderer-Konsole.
2. `window.factorial.getSnapshot()` liefert ein Objekt mit `state.sinceMs` als
   Zahl; nach `refresh()` kommt ein Push über `onSnapshot` an.
3. Passt der Inhalt in die 340×224? Landen die Popups von Pausen-Menü und
   Arbeitsort-Select im Fenster? Ist ein Toast sichtbar?
4. Erscheint das Tray-Icon, und zeigt die Menubar (macOS) nach dem Einstempeln
   binnen 15 s eine laufende Zeit?
5. Zeigt das Tray-Menü die echten Pausennamen aus `timeSettings`?
6. Ein-/Ausstempeln **aus dem Tray**, ohne das Fenster zu öffnen: übernimmt das
   Widget den Zustand?
7. Widget schließen → App läuft weiter, Tray bleibt. „Beenden" → Prozess ist weg.
8. Erst danach der vollständige Klickpfad gegen die echte API (Einstempeln →
   Pause → Fortsetzen → Ausstempeln) und die drei `locationType`-Werte — das
   schreibt echte Einträge in eine echte Arbeitszeiterfassung.
9. **Und ganz zuletzt dasselbe noch einmal mit der gepackten App** (Plan-Task 14,
   Schritt 4): `release/Factorial-0.1.0-arm64.dmg` öffnen, `Factorial.app` nach
   `/Applications` ziehen, per **Rechtsklick → Öffnen** starten (unsigniert, ein
   Doppelklick wird von Gatekeeper abgewiesen). Zu prüfen: kein Dock-Icon, nur
   das Tray; die Anmeldung besteht weiter oder das Login-Fenster erscheint; das
   Tray-Icon ist sichtbar (das ist der Beleg, dass `app.asar/resources` gelesen
   wird); Ein- und Ausstempeln funktioniert; und unter
   `Systemeinstellungen → Allgemein → Anmeldeobjekte` steht ein Eintrag, der auf
   `/Applications/Factorial.app` zeigt — **nicht** auf einen Release- oder
   Entwicklungsordner. Steht dort ein falscher Pfad, ist das ein echter Fehler
   und kein Schönheitsfehler: die App startet dann bei jedem Login aus einem
   Ordner, den es vielleicht nicht mehr gibt.

## 5. Wie man die Factorial-API selbst weiter erforscht

**Vollständig und reproduzierbar in `docs/api-discovery.md`** (Introspection-Snippet,
nützliche Einstiegsqueries, die bekannten Typ-Fallen, und warum
`attendanceEstimatedTimes` drei Zahlen liefert, von denen nur eine das Tagessoll
ist). Ausführlich außerdem in `docs/DESIGN.md`, Abschnitt „Windows-Übergabe → 5".
Kurzfassung:

- **Introspection ist der schnelle Weg.** In einer eingeloggten Browser-Session
  genügt ein `fetch` aus dem Seitenkontext, weil die API `credentials: 'include'`
  cross-origin akzeptiert. So wurden `expectedMinutes`, `clockInOffset` und die
  korrigierten Mutation-Signaturen gefunden.
- **`window.fetch` patchen bringt nichts** — die App hält eine Referenz, die vor
  jedem nachträglichen Patch aufgelöst wurde.
- **Vorsicht mit Mutations beim Experimentieren:** sie schreiben in eine echte
  Arbeitszeiterfassung.

## 6. Offene Punkte und Verdachtsmomente

- **Das Paket schleppt 36,8 MB toter `node_modules` mit.** Gemessen am gebauten
  `app.asar` (40,0 MB gesamt): `node_modules` 36,8 MB, `out/` 1,3 MB,
  `resources/` 0,1 MB. electron-builder kopiert **alle** `dependencies` ins
  Paket, aber geladen wird davon zur Laufzeit nichts: der Renderer ist von Vite
  vollständig gebündelt, und die gebauten `out/main/index.js` und
  `out/preload/index.mjs` importieren nachweislich nur `electron`, `node:fs` und
  `node:path` (nachgezählt an den Bundles). React, Base UI, Lucide und Sonner
  liegen also doppelt im Paket — einmal einkompiliert, einmal als Quelldateien.
  Carry-Forward C1 hat nur die drei ausdrücklich genannten Build-Zeit-Pakete
  entfernt; der Rest wäre über ein `- '!node_modules'` in `files` (oder einen
  Umzug aller Renderer-Pakete nach `devDependencies`) zu erledigen. **Bewusst
  nicht gemacht:** die gepackte App wurde nie gestartet (Abschnitt 4), und eine
  Verschlankung, deren Ergebnis niemand starten kann, ist kein guter Tausch. Wer
  sie angeht, muss die App danach wirklich starten. Größenordnung: das DMG wäre
  danach etwa 36 MB kleiner, von 119 MB — der Löwenanteil ist Electron selbst.
- **Im Dev-Modus erscheint weiterhin ein Dock-Icon.** `LSUIElement: 1` steht in
  `Info.plist` und wirkt deshalb nur für das gepackte Bundle. `npm run dev`
  startet die generische Electron-App und zeigt deren Dock-Icon. Der Code ruft
  bewusst kein `app.dock.hide()` — das wäre eine weitere Plattformverzweigung
  für einen reinen Entwicklungs-Nebeneffekt. Wenn das stört, ist
  `app.dock?.hide()` in `src/main/index.ts` die Stelle, und dann gehört sie in
  die Tabelle in Abschnitt 2.
- **`build/icon.icns` lässt sich nur auf macOS neu erzeugen.**
  `build/make-app-icon.py` ruft für die `.icns` das Systemwerkzeug `iconutil`
  auf. Auf Windows schlägt das Skript an dieser Stelle fehl — die fertige Datei
  ist eingecheckt und wird dort auch nicht gebraucht. Nur die `.ico` (Pillow)
  entsteht plattformunabhängig. Wer das Icon ändert, macht das also auf macOS
  und checkt beide Dateien ein.
- **`js-yaml` ist eine reine Test-Abhängigkeit.** `src/shared/__tests__/packaging.test.ts`
  liest `electron-builder.yml` und prüft die Struktur (Targets, `identity: null`,
  `LSUIElement`, die `files`-Globs). Ohne echten Parser würde ein falsch
  eingerückter Schlüssel durch jede Textprüfung rutschen, und genau das ist die
  Fehlerart, die man hier fürchtet. Das Paket steht in `devDependencies` und
  landet nicht im Produkt.
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
  ~~**Noch offen für Task 12:** das Tray …~~ — erledigt in Task 12, allerdings
  mit einem Umzug: die Tabelle liegt jetzt in **`src/shared/errors.ts`**, weil
  der Main-Prozess nichts aus `src/renderer` importieren kann (weder der
  tsconfig noch der electron-vite-Alias kennen `@renderer` dort).
  `src/renderer/src/lib/errors.ts` ist nur noch ein Re-Export, der Importpfad
  des Renderers bleibt also gleich. Das Tray benutzt
  `describeActionFailure(kind, message)` — dieselbe Tabelle, nur ohne den
  IPC-Codec davor, weil es den Store direkt aufruft und den Fehler als Objekt
  bekommt. Klassifiziert wird mit `classifyActionError` aus
  `src/main/ipc-handlers.ts`, also mit **derselben** Funktion wie im IPC-Pfad.
  Belegt im Smoke-Lauf (Abschnitt 4): die englischen Originale erscheinen
  nirgends.

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
- ~~**Refresh bei Fensterfokus und nach Standby** … fehlt noch~~ — erledigt in
  Task 12: `src/main/index.ts` startet den Poll-Loop, lädt bei `resume` neu
  (und stoppt das Polling bei `suspend`, damit ein in einen einschlafenden
  Netzwerk-Stack abgesetzter Request den Snapshot nicht grundlos als „nicht
  aktuell" markiert) und hängt einen `focus`-Handler ans Widget. Ausgelöst wurde
  keiner der drei — siehe Abschnitt 4.
- **„Tray-Öffnen" ist nur angenähert.** DESIGN.md verlangt einen Refresh, wenn
  das Tray geöffnet wird; Electron meldet kein solches Ereignis. Ersatz sind
  `mouse-enter`, `click` und `right-click`, gedrosselt auf einen Refresh pro
  10 s (`OPEN_REFRESH_MIN_INTERVAL_MS`). Ein bereits geöffnetes Menü behält den
  Snapshot, mit dem es gebaut wurde — die Antwort landet erst im nächsten
  Render. Auf Windows ist zu prüfen, ob `mouse-enter` dort überhaupt feuert;
  wenn nicht, bleibt der Klick, und der Effekt ist erst beim zweiten Öffnen
  sichtbar.
- **Die Zeit im Tray-Menü ist beim Öffnen bis zu 15 s alt** (Render-Takt), auf
  Windows entsprechend auch der Tooltip. Das ist bewusst so: die Zahl wird bei
  jedem Render neu aus `state.since` gerechnet und kann deshalb nicht driften,
  aber sie wird eben nur alle 15 s neu gesetzt. Ein Sekundentakt im Main-Prozess
  wäre für eine Minutenanzeige verschwendete Arbeit.
- **Ein zweites Tray-Icon bei zwei Instanzen** wäre die sichtbarste Folge eines
  fehlenden Single-Instance-Locks. Auf Windows ist der Lock deshalb nicht
  optional — siehe Abschnitt 2.
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
- ~~**`skipTaskbar: true` ohne Tray.**~~ — erledigt in Task 12: das Tray ist da,
  das ausgeblendete Widget ist über Icon-Klick (Windows), Doppelklick oder den
  Menüeintrag „Fenster zeigen" erreichbar, und „Beenden" gibt es in jedem
  Zustand. Der Rest des Hinweises gilt weiter für den Fehlerpfad *ohne* Tray —
  dort beendet `window-all-closed` die App absichtlich.
- **Das Tray-Menü kennt keinen „läuft gerade"-Zustand.** Der Store lehnt eine
  zweite gleichzeitige Aktion mit `busy` ab, aber das Menü graut währenddessen
  nichts aus (anders als das Widget, das seine Buttons sperrt) — ein
  Kontextmenü ist beim Klick ohnehin schon wieder zu. Wer zweimal schnell klickt
  oder gleichzeitig im Widget klickt, bekommt beim nächsten Öffnen den Satz
  „Es läuft bereits eine Aktion. Bitte einen Moment warten." als deaktivierten
  Eintrag. Geschrieben wird dabei nichts Falsches; die zweite Aktion wird
  verworfen, nicht nachgeholt.
- **Das Tray ist die einzige Oberfläche für die Einstellungen.** DESIGN.md,
  Abschnitt „Einstellungen", nennt drei Punkte (Autostart, Always-on-Top,
  Abmelden); alle drei liegen im Untermenü „Einstellungen" des Tray-Menüs. Das
  Widget hat bewusst keinen zweiten Ort dafür — es ist 340×224 groß und zeigt
  Zeit, nicht Konfiguration. Zwei Folgen, die man kennen muss:
  1. **Ohne Tray gibt es keine Einstellungen mehr.** Auf dem Fehlerpfad (Task 12,
     Bootstrap gescheitert) beendet sich die App ohnehin.
  2. **„Abmelden" erscheint nur, solange eine Sitzung besteht.** Im Zustand
     `unauthenticated` steht stattdessen „Anmelden" auf der obersten Ebene —
     derselbe Aufruf (`signInAgain` in `src/main/index.ts`), nur das passende
     Wort. Beide Wege gleichzeitig anzubieten würde eine Aktion zweimal mit
     gegensätzlichen Wörtern benennen.
  Ein fehlgeschlagener Schreibvorgang (auf Windows realistisch: Virenscanner
  blockiert das `rename` mit `EBUSY`, siehe Abschnitt 3) wird abgefangen und
  erscheint als deaktivierter Eintrag `Einstellung konnte nicht gespeichert
  werden.` (`SETTINGS_WRITE_FAILED` in `src/shared/errors.ts` — dieselbe Datei
  wie die übrigen deutschen Sätze, kein zweiter Ort). Das Häkchen springt beim
  Neuaufbau des Menüs auf den alten Wert zurück, weil `Settings.set` erst
  schreibt und dann übernimmt.
- **Der Arbeitsort beim Einstempeln aus dem Tray** kommt aus den gespeicherten
  Einstellungen (`lastLocationType`/`lastWorkplaceId`), nicht aus einem zweiten
  Default — bewusste Abweichung vom Plan-Schnipsel, der `office` hartkodierte.
  Das Tray bietet **keine** Auswahl des Arbeitsorts an; wer einen anderen will,
  stellt ihn im Widget ein, wo er ohnehin persistiert wird.
