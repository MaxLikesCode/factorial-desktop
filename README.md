# Factorial Desktop

![Das Widget auf dem Desktop: eingestempelt seit 8:43:11, Soll erfüllt mit +0:43, darunter Pause und Ausstempeln](docs/images/header.png)

Schwebendes Widget mit Tray-Icon für die Zeiterfassung in Factorial HR.
Ein- und Ausstempeln, Pause und Fortsetzen — ohne den Browser zu öffnen.

> **Stand:** entwickelt und verifiziert auf macOS (Darwin 25.5, Electron 43).
> Am 2026-08-20 lief die erste Inbetriebnahme auf Windows 11: `npm test`,
> `npm run package:win` und die gepackte App sind dort durch, Tray-Icon,
> Widget und der IPC-Pfad ebenfalls — und ein Windows-Fehler kam dabei heraus
> und wurde behoben (Mausbewegungen werden an ein klickdurchlässiges Fenster
> nicht weitergeleitet, das Widget blieb dadurch unbedienbar). **Nicht**
> gelaufen ist der Durchstich gegen die echte API: Ein- und Ausstempeln
> schreibt in eine echte Arbeitszeiterfassung und ist Sache eines Menschen.
> Wer auf Windows weiterarbeitet, liest zuerst `docs/WINDOWS.md`, Abschnitt 4a;
> dort steht Stelle für Stelle, was belegt ist und was nur behauptet wäre.

## Start

    npm install
    npm run dev

Beim ersten Start öffnet sich Factorials eigenes Login in einem eigenen Fenster.
Danach bleibt die Sitzung in einer persistenten Electron-Session-Partition
(`persist:factorial`) erhalten; ein zweiter Start kommt ohne Anmeldung aus.

Die App hat bewusst **kein** Dock- bzw. Taskleisten-Icon (gepackt über
`LSUIElement`, unter Windows über `skipTaskbar`). Sichtbar ist sie als
Tray-Icon; das Tray-Menü ist zugleich die einzige Oberfläche für die
Einstellungen (Autostart, Immer im Vordergrund, Abmelden). Das Schließen des
Widgets blendet es nur aus — beendet wird über „Beenden" im Tray.

## Befehle

| Befehl | Zweck |
|---|---|
| `npm run dev` | Entwicklungsmodus (electron-vite, Main + Preload + Renderer mit HMR) |
| `npm test` | Unit-Tests (Vitest, ohne Electron-Laufzeit) |
| `npm run test:watch` | dieselben Tests im Watch-Modus |
| `npm run typecheck` | TypeScript prüfen (Main/Preload/Shared **und** Renderer) |
| `npm run build` | Typecheck + Build nach `out/` |
| `npm run package:mac` | macOS-Build, DMG + ZIP arm64, **unsigniert** (Erststart per Rechtsklick → Öffnen) |
| `npm run package:win` | Windows-Build: NSIS-Installer **und** portable `.exe`, x64, unsigniert (SmartScreen: „Weitere Informationen" → „Trotzdem ausführen") |

Beide `package:`-Skripte laufen über `npm run build`, also inklusive Typecheck.
Die Artefakte landen in `release/` (in `.gitignore`).

Für Windows entstehen zwei Dateien, und die Wahl zwischen ihnen ist nicht nur
Geschmack:

- **`Factorial Desktop Setup <version>.exe`** installiert nach
  `%LOCALAPPDATA%\Programs` (ohne Adminrechte), legt einen Startmenü-Eintrag an
  und ist die Variante, bei der **Autostart sinnvoll ist** — der Run-Key-Eintrag
  zeigt dann auf einen Pfad, den es dauerhaft gibt.
- **`Factorial Desktop.exe`** läuft ohne Installation von überall. Sie entpackt
  sich beim Start nach `%TEMP%`; Sitzung und Einstellungen teilt sie sich mit
  der installierten Variante (beide schreiben nach
  `%APPDATA%\factorial-desktop`), aber der Autostart hängt dann daran, dass die
  Datei liegen bleibt, wo sie liegt.

`.github/workflows/build.yml` baut beides plus die macOS-Artefakte. Tests und
Typecheck laufen dort bei jedem Push und Pull Request; die Builds bei einem
`v*`-Tag oder auf Knopfdruck (macOS-Runner sind teuer). Ein Tag erzeugt einen
Release-Entwurf mit allen Dateien.

## Wichtig zu wissen

Die App schreibt in eine **echte Arbeitszeiterfassung**. Ein falscher Zeitstempel
ist der teure Fehlerfall, nicht ein hässliches Layout. Zwei Konsequenzen, die
sich durch den Code ziehen:

- Zeiten werden nie geraten. Ist ein Snapshot veraltet, zeigt das Widget die
  letzte bekannte Zeit **mit Hinweis** statt einer geschätzten.
- Wer die Aktionen zum ersten Mal durchklickt (Einstempeln → Pause →
  Fortsetzen → Ausstempeln), erzeugt echte Einträge. Das ist eine Handlung für
  einen Menschen, nicht für einen Agenten nebenbei.

## Dokumente

- `docs/DESIGN.md` — Architektur und die vollständige, live verifizierte
  API-Referenz. Bei Widerspruch gewinnt dieses Dokument.
- `docs/PLAN.md` — der Umsetzungsplan, Task für Task. Die beiden Blöcke ganz
  oben („Verifizierte API-Korrekturen K1–K11", „Carry-Forwards aus Tasks 1–5")
  überschreiben widersprechende Schnipsel weiter unten.
- `docs/WINDOWS.md` — die Übergabe für die Windows-Portierung: jede
  plattformabhängige Stelle mit Datei, Zeile, Grund und Prüfschritt, dazu die
  ehrliche Trennung zwischen „verifiziert", „nur kompiliert" und „ungetestet".
- `docs/api-discovery.md` — wie die Factorial-API erforscht wurde und wie man
  fehlende Queries selbst findet.
