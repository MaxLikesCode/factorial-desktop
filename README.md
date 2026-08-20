# Factorial Desktop

![Das Widget auf dem Desktop: eingestempelt seit 8:43:11, Soll erfüllt mit +0:43, darunter Pause und Ausstempeln](docs/images/header.png)

Schwebendes Widget mit Tray-Icon für die Zeiterfassung in Factorial HR.
Ein- und Ausstempeln, Pause und Fortsetzen — ohne den Browser zu öffnen.

> **Stand:** gebaut und verifiziert ausschließlich auf macOS (Darwin 25.5,
> Electron 43). Der Windows-Code ist mitgeschrieben, kompiliert und
> typgeprüft, aber **nie auf Windows ausgeführt** worden — auch
> `npm run package:win` nicht. Wer dort weiterarbeitet, liest zuerst
> `docs/WINDOWS.md`; dort steht Stelle für Stelle, was belegt ist und was nur
> behauptet wäre.

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
| `npm run package:win` | Windows-Build, NSIS-Installer — **nie ausgeführt** |

Beide `package:`-Skripte laufen über `npm run build`, also inklusive Typecheck.
Die Artefakte landen in `release/` (in `.gitignore`).

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
