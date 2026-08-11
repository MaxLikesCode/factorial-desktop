# Factorial Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine Electron-App mit Floating-Widget und Tray, mit der man sich bei Factorial HR ein-/ausstempelt und Pausen startet.

**Architecture:** Der Main-Prozess besitzt Netzwerk und Zustand und spricht über `net.fetch` mit der Factorial-GraphQL-API (der Renderer kann das nicht — CORS). Der Renderer ist reine UI und kommuniziert ausschließlich über einen typisierten IPC-Vertrag. Auth läuft über ein Login-`BrowserWindow` in einer persistenten Session-Partition; die App liest das Cookie nie aus.

**Tech Stack:** Electron 43, electron-vite 5, electron-builder 26, React 19, TypeScript (strict), Tailwind CSS 4, shadcn/ui 4 (Preset `nova`, Base `base`), Vitest 4.

## Global Constraints

- **Sprache:** UI-Texte auf Deutsch. Code, Bezeichner und Kommentare auf Englisch.
- **TypeScript strict.** Kein `any` in produktivem Code, keine nicht-null-Assertions ohne begründenden Kommentar.
- **Zielplattform dieser Umsetzung ist macOS.** Windows-Code wird mitgeschrieben, aber nicht verifiziert.
- **Jede `process.platform`-Verzweigung bekommt einen `// PLATFORM:` Kommentar** mit einem Satz Begründung, und wird in `docs/WINDOWS.md` eingetragen. `grep -rn "// PLATFORM:" src/` muss die vollständige Liste liefern.
- **Erfolgsbehauptungen nur mit Beleg.** Was nicht ausgeführt wurde, wird als ungetestet gekennzeichnet.
- **API-Konstanten:** Endpoint `https://api.factorialhr.com/graphql`, `source: "desktop"`, Session-Partition `persist:factorial`.
- **Kein Offline-Queue.** Fehlgeschlagene Mutations werden nie automatisch wiederholt.
- **Spec:** `docs/superpowers/specs/2026-08-12-factorial-desktop-design.md` ist die Referenz. Bei Widerspruch gewinnt die Spec; melde den Widerspruch.

---

## File Structure

```
package.json                      Scripts, Deps
electron.vite.config.ts           Build für main/preload/renderer
electron-builder.yml              Packaging mac + win
vitest.config.ts                  Tests, erzwingt TZ
tsconfig.json, tsconfig.node.json, tsconfig.web.json
components.json                   shadcn-Konfiguration

src/shared/
  ipc-contract.ts                 Typen, die main + preload + renderer teilen
  attendance-state.ts             AttendanceState-Union, deriveState() — pure
  time.ts                         Zeitrekonstruktion + Formatierung — pure

src/main/
  index.ts                        Lifecycle, Single-Instance, Verdrahtung
  session.ts                      Partition, Logout
  auth.ts                         Session-Check, Login-Fenster
  factorial/
    client.ts                     GraphQL-Transport, injizierbar
    operations.ts                 die konkreten Queries/Mutations
    types.ts                      API-Antworttypen
  attendance.ts                   Store: Polling, optimistische Updates
  windows.ts                      Widget-Fenster, Positions-Persistenz
  tray.ts                         Icon, Titel, Kontextmenü
  settings.ts                     persistierte Einstellungen
  ipc.ts                          IPC-Handler

src/preload/index.ts              contextBridge

src/renderer/
  index.html
  src/main.tsx, App.tsx, styles.css
  components/StatusWidget.tsx, ProgressRing.tsx, ActionBar.tsx,
             BreakMenu.tsx, LocationSelect.tsx, ui/*
  hooks/useAttendance.ts

docs/WINDOWS.md                   Übergabe an den Windows-Agenten
```

**Grenzen:** `src/shared/` ist frei von Electron-Imports und damit trivial testbar. `factorial/operations.ts` ist die einzige Stelle mit Factorial-Semantik. `attendance.ts` kennt weder Fenster noch Tray.

---

### Task 1: Projekt-Scaffold und Toolchain

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `vitest.config.ts`, `tsconfig*.json`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`, `components.json`
- Test: `src/shared/__tests__/environment.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces: lauffähiges `npm run dev`, `npm test`, `npm run typecheck`. Alias `@shared/*` → `src/shared/*`, `@renderer/*` → `src/renderer/src/*`.

- [ ] **Step 1: Projekt initialisieren**

```bash
npm init -y
npm i -D electron@^43 electron-vite@^5 electron-builder@^26 vite@^8 vitest@^4 \
  typescript @types/node @vitejs/plugin-react \
  tailwindcss@^4 @tailwindcss/vite autoprefixer
npm i react@^19 react-dom@^19
npm i -D @types/react @types/react-dom
```

- [ ] **Step 2: `package.json` Scripts und Metadaten setzen**

```json
{
  "name": "factorial-desktop",
  "version": "0.1.0",
  "description": "Zeiterfassung für Factorial HR",
  "main": "./out/main/index.js",
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "npm run typecheck && electron-vite build",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "package:mac": "npm run build && electron-builder --mac",
    "package:win": "npm run build && electron-builder --win"
  }
}
```

- [ ] **Step 3: `vitest.config.ts` anlegen — erzwingt die Testzeitzone**

Die Zeitlogik rechnet in lokaler Zeit. Ohne feste Zeitzone würden Tests je nach Maschine unterschiedlich laufen.

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    environment: 'node',
    env: { TZ: 'Europe/Berlin' },
    include: ['src/**/__tests__/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Schreibe den fehlschlagenden Test**

Dieser Test bewacht die Testumgebung selbst. Läuft die Zeitzone nicht wie erwartet, sind alle späteren Zeittests wertlos — dann soll die Suite laut scheitern, nicht leise falsch bestehen.

`src/shared/__tests__/environment.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('test environment', () => {
  it('runs in Europe/Berlin so local-time maths is reproducible', () => {
    // 12 Aug 2026 is CEST (UTC+2). getTimezoneOffset returns minutes *behind* UTC.
    expect(new Date(2026, 7, 12, 12, 0, 0).getTimezoneOffset()).toBe(-120)
  })

  it('is in CET (UTC+1) in winter', () => {
    expect(new Date(2026, 0, 15, 12, 0, 0).getTimezoneOffset()).toBe(-60)
  })
})
```

- [ ] **Step 5: Test ausführen, Fehlschlag bestätigen**

Run: `npx vitest run src/shared/__tests__/environment.test.ts`
Expected: FAIL, solange `vitest.config.ts` fehlt oder die TZ nicht greift.

- [ ] **Step 6: `electron.vite.config.ts` anlegen**

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src'),
      },
    },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
})
```

- [ ] **Step 7: TypeScript-Konfiguration anlegen**

`tsconfig.json`:

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

`tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noUnusedLocals": true, "noUncheckedIndexedAccess": true,
    "skipLibCheck": true, "esModuleInterop": true, "noEmit": true,
    "types": ["node", "vitest/globals"],
    "baseUrl": ".", "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src/main/**/*", "src/preload/**/*", "src/shared/**/*",
              "electron.vite.config.ts", "vitest.config.ts"]
}
```

`tsconfig.web.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx", "strict": true, "noUnusedLocals": true,
    "noUncheckedIndexedAccess": true, "skipLibCheck": true, "noEmit": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"], "@renderer/*": ["src/renderer/src/*"] }
  },
  "include": ["src/renderer/**/*", "src/shared/**/*"]
}
```

- [ ] **Step 8: Minimale App-Dateien anlegen**

`src/main/index.ts`:

```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 340,
    height: 220,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(createWindow)

// PLATFORM: macOS keeps the app alive with no windows; every other platform quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

`src/preload/index.ts`:

```ts
// Populated in Task 7. Kept minimal so the scaffold runs.
export {}
```

`src/renderer/index.html`:

```html
<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <title>Factorial</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('root element missing')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`src/renderer/src/App.tsx`:

```tsx
export default function App() {
  return <div className="p-4 text-sm">Factorial Desktop</div>
}
```

`src/renderer/src/styles.css`:

```css
@import 'tailwindcss';
```

- [ ] **Step 9: Test ausführen, Erfolg bestätigen**

Run: `npm test`
Expected: PASS, 2 Tests.

- [ ] **Step 10: Dev-Modus manuell verifizieren**

Run: `npm run dev`
Expected: Ein Fenster öffnet sich und zeigt "Factorial Desktop". Konsole ohne Fehler. Danach beenden.

- [ ] **Step 11: Typecheck ausführen**

Run: `npm run typecheck`
Expected: keine Ausgabe, Exit-Code 0.

- [ ] **Step 12: shadcn/ui mit dem Nova-Preset einrichten**

```bash
npx shadcn@latest init --base base --preset nova --template vite --cwd . -y --css-variables
```

Falls die CLI die Projektstruktur nicht erkennt, `components.json` von Hand anlegen:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "nova",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "", "css": "src/renderer/src/styles.css",
                "baseColor": "neutral", "cssVariables": true },
  "aliases": { "components": "@renderer/components", "utils": "@renderer/lib/utils",
               "ui": "@renderer/components/ui", "hooks": "@renderer/hooks",
               "lib": "@renderer/lib" }
}
```

Anschließend die benötigten Komponenten installieren:

```bash
npx shadcn@latest add button dropdown-menu select tooltip badge sonner
```

Verifizieren: `npm run dev` zeigt das Fenster weiterhin fehlerfrei.

> Falls das Nova-Preset nicht auflösbar ist: **stoppen und melden**, nicht auf einen anderen Stil ausweichen. Die verfügbaren Presets sind `nova, vega, maia, lyra, mira, luma, sera, rhea`.

- [ ] **Step 13: `.gitignore` ergänzen und committen**

```bash
printf 'node_modules/\ndist/\nout/\nrelease/\n.DS_Store\n*.log\n' > .gitignore
git add -A
git commit -m "chore: scaffold electron-vite + react + tailwind + shadcn (nova)"
```

---

### Task 2: Zeitrekonstruktion (pure)

Der heikelste Teil der Integration. Kein Zeitstempel der API ist ein gültiger Instant — siehe Spec, Fallstrick 2.

**Files:**
- Create: `src/shared/time.ts`
- Test: `src/shared/__tests__/time.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `reconstructInstant(shiftDate: string, apiTimestamp: string, now?: Date): Date`
  - `formatDuration(ms: number): string` → `"H:MM:SS"`
  - `formatHoursMinutes(minutes: number): string` → `"HH:MM"`
  - `toLocalIsoWithOffset(d: Date): string` → `"2026-08-12T00:11:12+02:00"`
  - `toLocalDate(d: Date): string` → `"2026-08-12"`

- [ ] **Step 1: Schreibe die fehlschlagenden Tests**

`src/shared/__tests__/time.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  reconstructInstant, formatDuration, formatHoursMinutes,
  toLocalIsoWithOffset, toLocalDate,
} from '@shared/time'

describe('reconstructInstant', () => {
  it('rebuilds the real instant from the API’s mismatched date and time parts', () => {
    // Recorded from the live API: clocked in at 2026-08-12 00:11:12 local (+02:00),
    // but the API reports "2026-08-11T00:11:12+00:00" — UTC date glued to local time.
    const now = new Date(2026, 7, 12, 0, 30, 0)
    const result = reconstructInstant('2026-08-12', '2026-08-11T00:11:12+00:00', now)
    expect(result.getTime()).toBe(new Date(2026, 7, 12, 0, 11, 12).getTime())
  })

  it('ignores the date component entirely, so the 2000-01-01 sentinel works too', () => {
    const now = new Date(2026, 7, 12, 0, 30, 0)
    const result = reconstructInstant('2026-08-12', '2000-01-01T00:11:12Z', now)
    expect(result.getTime()).toBe(new Date(2026, 7, 12, 0, 11, 12).getTime())
  })

  it('steps back a day when the reconstructed time lies in the future', () => {
    // Overnight shift: date is 2026-08-12, clocked in 23:30, it is now 00:30 on the 13th.
    const now = new Date(2026, 7, 13, 0, 30, 0)
    const result = reconstructInstant('2026-08-12', '2026-08-12T23:30:00+00:00', now)
    expect(result.getTime()).toBe(new Date(2026, 7, 12, 23, 30, 0).getTime())
  })

  it('tolerates a small clock skew without stepping back a day', () => {
    const now = new Date(2026, 7, 12, 9, 0, 0)
    const result = reconstructInstant('2026-08-12', '2026-08-12T09:00:30+00:00', now)
    expect(result.getTime()).toBe(new Date(2026, 7, 12, 9, 0, 30).getTime())
  })

  it('works across the winter/summer time boundary', () => {
    const now = new Date(2026, 0, 15, 10, 0, 0)
    const result = reconstructInstant('2026-01-15', '2026-01-15T09:00:00+00:00', now)
    expect(result.getTime()).toBe(new Date(2026, 0, 15, 9, 0, 0).getTime())
  })

  it('throws on an unparseable timestamp rather than returning a wrong time', () => {
    expect(() => reconstructInstant('2026-08-12', 'nonsense')).toThrow()
  })
})

describe('formatDuration', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatDuration(3 * 3600_000 + 7 * 60_000 + 5000)).toBe('3:07:05')
  })
  it('shows a zero hour rather than hiding it', () => {
    expect(formatDuration(65_000)).toBe('0:01:05')
  })
  it('clamps negatives to zero so a clock skew never renders a minus', () => {
    expect(formatDuration(-5000)).toBe('0:00:00')
  })
})

describe('formatHoursMinutes', () => {
  it('pads to two digits', () => {
    expect(formatHoursMinutes(485)).toBe('08:05')
  })
  it('handles zero', () => {
    expect(formatHoursMinutes(0)).toBe('00:00')
  })
})

describe('local serialisation for the API', () => {
  it('emits an ISO string carrying the local offset', () => {
    expect(toLocalIsoWithOffset(new Date(2026, 7, 12, 0, 11, 12)))
      .toBe('2026-08-12T00:11:12+02:00')
  })
  it('emits the winter offset in winter', () => {
    expect(toLocalIsoWithOffset(new Date(2026, 0, 15, 9, 0, 0)))
      .toBe('2026-01-15T09:00:00+01:00')
  })
  it('emits the local calendar date', () => {
    expect(toLocalDate(new Date(2026, 7, 12, 0, 11, 12))).toBe('2026-08-12')
  })
})
```

- [ ] **Step 2: Tests ausführen, Fehlschlag bestätigen**

Run: `npx vitest run src/shared/__tests__/time.test.ts`
Expected: FAIL mit "Failed to resolve import @shared/time".

- [ ] **Step 3: Implementierung schreiben**

`src/shared/time.ts`:

```ts
/**
 * Factorial's API never returns a usable absolute timestamp.
 *
 * `openShift.clockIn`        -> "2000-01-01T00:11:12Z"      (sentinel date)
 * `shift.clockInWithSeconds` -> "2026-08-11T00:11:12+00:00" (UTC date + LOCAL time,
 *                                                            falsely labelled +00:00)
 *
 * Verified against a real record: the clock-in happened at 2026-08-12 00:11:12
 * local (+02:00) — 22 hours away from what the string literally means.
 *
 * Only the time-of-day is trustworthy. We pair it with the shift's own local
 * calendar date and interpret the result in the local zone.
 */

const TIME_OF_DAY = /T(\d{2}):(\d{2}):(\d{2})/
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Tolerated clock skew before we assume the shift began the previous day. */
const FUTURE_TOLERANCE_MS = 120_000

export function reconstructInstant(
  shiftDate: string,
  apiTimestamp: string,
  now: Date = new Date(),
): Date {
  const date = CALENDAR_DATE.exec(shiftDate)
  if (!date) throw new Error(`unparseable shift date: ${shiftDate}`)

  const time = TIME_OF_DAY.exec(apiTimestamp)
  if (!time) throw new Error(`unparseable API timestamp: ${apiTimestamp}`)

  const [, y, mo, d] = date
  const [, h, mi, s] = time

  const instant = new Date(
    Number(y), Number(mo) - 1, Number(d),
    Number(h), Number(mi), Number(s),
  )

  // An overnight shift is filed under the day it started, so a reconstructed
  // time in the future means we crossed midnight.
  if (instant.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    instant.setDate(instant.getDate() - 1)
  }
  return instant
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatHoursMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function toLocalDate(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
}

export function toLocalIsoWithOffset(d: Date): string {
  const offsetMinutes = -d.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const offset =
    `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
  return `${toLocalDate(d)}T${time}${offset}`
}
```

- [ ] **Step 4: Tests ausführen, Erfolg bestätigen**

Run: `npx vitest run src/shared/__tests__/time.test.ts`
Expected: PASS, alle 13 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/time.ts src/shared/__tests__/time.test.ts
git commit -m "feat: reconstruct usable instants from Factorial's malformed timestamps"
```

---

### Task 3: Zustandsableitung (pure)

**Files:**
- Create: `src/shared/attendance-state.ts`
- Test: `src/shared/__tests__/attendance-state.test.ts`

**Interfaces:**
- Consumes: `reconstructInstant` aus `@shared/time`
- Produces:
  - `type OpenShift` — die für die Ableitung relevanten API-Felder
  - `type AttendanceState` — diskriminierte Union über `kind`
  - `deriveState(openShift: OpenShift | null, now?: Date): AttendanceState`

- [ ] **Step 1: Schreibe die fehlschlagenden Tests**

`src/shared/__tests__/attendance-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { deriveState, type OpenShift } from '@shared/attendance-state'

const NOW = new Date(2026, 7, 12, 9, 0, 0)

const openShift: OpenShift = {
  id: '543339856',
  date: '2026-08-12',
  clockIn: '2000-01-01T08:30:00Z',
  locationType: 'office',
  workplaceId: '3333333',
  timeSettingsBreakConfiguration: null,
}

describe('deriveState', () => {
  it('reports clocked out when there is no open shift', () => {
    expect(deriveState(null, NOW)).toEqual({ kind: 'out' })
  })

  it('reports clocked in when a shift is open without a break', () => {
    const state = deriveState(openShift, NOW)
    expect(state.kind).toBe('in')
    if (state.kind !== 'in') throw new Error('unreachable')
    expect(state.shiftId).toBe('543339856')
    expect(state.locationType).toBe('office')
    expect(state.workplaceId).toBe('3333333')
    expect(state.since.getTime()).toBe(new Date(2026, 7, 12, 8, 30, 0).getTime())
  })

  it('reports a break when the shift carries a break configuration', () => {
    const state = deriveState(
      { ...openShift, timeSettingsBreakConfiguration: { id: '19613', name: 'Mittagspause' } },
      NOW,
    )
    expect(state.kind).toBe('break')
    if (state.kind !== 'break') throw new Error('unreachable')
    expect(state.breakId).toBe('19613')
    expect(state.breakName).toBe('Mittagspause')
  })

  it('falls back to a generic break label when the name is missing', () => {
    const state = deriveState(
      { ...openShift, timeSettingsBreakConfiguration: { id: '19613', name: null } },
      NOW,
    )
    if (state.kind !== 'break') throw new Error('unreachable')
    expect(state.breakName).toBe('Pause')
  })

  it('uses the shift date, not the sentinel date, for the start time', () => {
    const state = deriveState({ ...openShift, clockIn: '2000-01-01T08:30:00Z' }, NOW)
    if (state.kind !== 'in') throw new Error('unreachable')
    expect(state.since.getFullYear()).toBe(2026)
  })
})
```

- [ ] **Step 2: Tests ausführen, Fehlschlag bestätigen**

Run: `npx vitest run src/shared/__tests__/attendance-state.test.ts`
Expected: FAIL, Modul nicht auflösbar.

- [ ] **Step 3: Implementierung schreiben**

`src/shared/attendance-state.ts`:

```ts
import { reconstructInstant } from './time'

export interface BreakConfiguration {
  id: string
  name: string | null
}

export interface OpenShift {
  id: string
  date: string
  clockIn: string
  locationType: string | null
  workplaceId: string | null
  timeSettingsBreakConfiguration: BreakConfiguration | null
}

export type AttendanceState =
  | { kind: 'unknown' }
  | { kind: 'unauthenticated' }
  | { kind: 'out' }
  | { kind: 'in'; shiftId: string; since: Date; locationType: string | null; workplaceId: string | null }
  | { kind: 'break'; shiftId: string; since: Date; breakId: string; breakName: string }

/**
 * The single source of truth for "am I clocked in?". Everything is derived from
 * `openShift`; no parallel flag is kept anywhere.
 */
export function deriveState(openShift: OpenShift | null, now: Date = new Date()): AttendanceState {
  if (!openShift) return { kind: 'out' }

  const since = reconstructInstant(openShift.date, openShift.clockIn, now)
  const brk = openShift.timeSettingsBreakConfiguration

  if (brk) {
    return {
      kind: 'break',
      shiftId: openShift.id,
      since,
      breakId: brk.id,
      breakName: brk.name ?? 'Pause',
    }
  }

  return {
    kind: 'in',
    shiftId: openShift.id,
    since,
    locationType: openShift.locationType,
    workplaceId: openShift.workplaceId,
  }
}
```

- [ ] **Step 4: Tests ausführen, Erfolg bestätigen**

Run: `npx vitest run src/shared/__tests__/attendance-state.test.ts`
Expected: PASS, 5 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/attendance-state.ts src/shared/__tests__/attendance-state.test.ts
git commit -m "feat: derive attendance state from the open shift"
```

---

### Task 4: GraphQL-Client

**Files:**
- Create: `src/main/factorial/client.ts`
- Test: `src/main/factorial/__tests__/client.test.ts`

**Interfaces:**
- Consumes: nichts aus früheren Tasks
- Produces:
  - `type GraphQLFetch = (url: string, init: { method: string; headers: Record<string,string>; body: string }) => Promise<{ status: number; text: () => Promise<string> }>`
  - `class FactorialError extends Error { readonly kind: 'unauthenticated' | 'graphql' | 'network' | 'malformed' }`
  - `createClient(fetchImpl: GraphQLFetch): { execute<T>(op: { operationName: string; query: string; variables: Record<string, unknown> }): Promise<T> }`

Der Client bekommt seine Fetch-Implementierung injiziert. Produktiv ist das `net.fetch` mit der Session-Partition; im Test ein Fake. Dadurch ist der Client ohne laufendes Electron testbar.

- [ ] **Step 1: Schreibe die fehlschlagenden Tests**

`src/main/factorial/__tests__/client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createClient, FactorialError, type GraphQLFetch } from '../client'

function fakeFetch(status: number, body: string): GraphQLFetch {
  return vi.fn(async () => ({ status, text: async () => body }))
}

const OP = { operationName: 'Probe', query: 'query Probe { __typename }', variables: {} }

describe('createClient', () => {
  it('returns the data payload on success', async () => {
    const client = createClient(fakeFetch(200, JSON.stringify({ data: { __typename: 'root_query' } })))
    await expect(client.execute(OP)).resolves.toEqual({ __typename: 'root_query' })
  })

  it('posts to the GraphQL endpoint with the operation name in the query string', async () => {
    const impl = fakeFetch(200, JSON.stringify({ data: {} }))
    await createClient(impl).execute(OP)
    const [url, init] = (impl as unknown as { mock: { calls: [string, { method: string; headers: Record<string,string>; body: string }][] } }).mock.calls[0]!
    expect(url).toBe('https://api.factorialhr.com/graphql?Probe')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual(OP)
  })

  it('treats in-band GraphQL errors as failures even though HTTP says 200', async () => {
    // Factorial returns errors with HTTP 200 — status alone proves nothing.
    const body = JSON.stringify({ errors: [{ message: "Field 'x' doesn't exist" }] })
    const client = createClient(fakeFetch(200, body))
    await expect(client.execute(OP)).rejects.toMatchObject({
      kind: 'graphql',
      message: expect.stringContaining("Field 'x' doesn't exist"),
    })
  })

  it('flags an expired session as unauthenticated', async () => {
    const client = createClient(fakeFetch(401, 'Unauthorized'))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'unauthenticated' })
  })

  it('treats a 302 to the login page as unauthenticated', async () => {
    const client = createClient(fakeFetch(302, ''))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'unauthenticated' })
  })

  it('reports a transport failure as a network error', async () => {
    const client = createClient(async () => { throw new Error('ECONNREFUSED') })
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'network' })
  })

  it('reports unparseable JSON as malformed rather than crashing', async () => {
    const client = createClient(fakeFetch(200, '<html>gateway timeout</html>'))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('reports a 200 without a data field as malformed', async () => {
    const client = createClient(fakeFetch(200, JSON.stringify({ extensions: {} })))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('exposes FactorialError as a real Error', async () => {
    const client = createClient(fakeFetch(401, ''))
    await expect(client.execute(OP)).rejects.toBeInstanceOf(FactorialError)
  })
})
```

- [ ] **Step 2: Tests ausführen, Fehlschlag bestätigen**

Run: `npx vitest run src/main/factorial/__tests__/client.test.ts`
Expected: FAIL, `../client` nicht auflösbar.

- [ ] **Step 3: Implementierung schreiben**

`src/main/factorial/client.ts`:

```ts
export const GRAPHQL_ENDPOINT = 'https://api.factorialhr.com/graphql'

export interface GraphQLFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }):
    Promise<{ status: number; text: () => Promise<string> }>
}

export interface Operation {
  operationName: string
  query: string
  variables: Record<string, unknown>
}

export type FactorialErrorKind = 'unauthenticated' | 'graphql' | 'network' | 'malformed'

export class FactorialError extends Error {
  constructor(readonly kind: FactorialErrorKind, message: string) {
    super(message)
    this.name = 'FactorialError'
  }
}

interface GraphQLEnvelope {
  data?: unknown
  errors?: { message?: string }[]
}

export function createClient(fetchImpl: GraphQLFetch) {
  async function execute<T>(op: Operation): Promise<T> {
    let status: number
    let raw: string
    try {
      const res = await fetchImpl(`${GRAPHQL_ENDPOINT}?${op.operationName}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op),
      })
      status = res.status
      raw = await res.text()
    } catch (cause) {
      throw new FactorialError('network', cause instanceof Error ? cause.message : String(cause))
    }

    // A redirect means the session cookie no longer authenticates us.
    if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
      throw new FactorialError('unauthenticated', `session rejected (HTTP ${status})`)
    }

    let envelope: GraphQLEnvelope
    try {
      envelope = JSON.parse(raw) as GraphQLEnvelope
    } catch {
      throw new FactorialError('malformed', `expected JSON, got: ${raw.slice(0, 120)}`)
    }

    // Factorial reports errors in-band with HTTP 200. The status code alone
    // never establishes success.
    if (envelope.errors?.length) {
      const message = envelope.errors.map((e) => e.message ?? 'unknown error').join('; ')
      throw new FactorialError('graphql', message)
    }

    if (envelope.data === undefined || envelope.data === null) {
      throw new FactorialError('malformed', 'response carried neither data nor errors')
    }

    return envelope.data as T
  }

  return { execute }
}
```

- [ ] **Step 4: Tests ausführen, Erfolg bestätigen**

Run: `npx vitest run src/main/factorial/__tests__/client.test.ts`
Expected: PASS, 9 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/factorial/client.ts src/main/factorial/__tests__/client.test.ts
git commit -m "feat: GraphQL client with in-band error handling"
```

---

### Task 5: Factorial-Operations

**Files:**
- Create: `src/main/factorial/types.ts`, `src/main/factorial/operations.ts`
- Test: `src/main/factorial/__tests__/operations.test.ts`

**Interfaces:**
- Consumes: `createClient` und `Operation` aus `./client`, `toLocalDate`/`toLocalIsoWithOffset` aus `@shared/time`, `OpenShift` aus `@shared/attendance-state`
- Produces: `createOperations(client)` mit
  - `fetchMe(): Promise<Identity>` — `{ email, employeeId: number, fullName, companyId: number, companyName }`
  - `fetchOpenShift(employeeId: number): Promise<OpenShift | null>`
  - `fetchTodayShifts(employeeId: number, date: string): Promise<ShiftSummary[]>`
  - `fetchBreakConfigurations(): Promise<BreakConfigOption[]>` — `{ id: string; name: string }[]`
  - `clockIn(input: { now: Date; locationType: string; workplaceId: string | null }): Promise<void>`
  - `breakStart(input: { now: Date; breakConfigurationId: string }): Promise<void>`
  - `breakEnd(input: { now: Date }): Promise<void>`
  - `clockOut(input: { now: Date }): Promise<void>`

- [ ] **Step 1: Schreibe die fehlschlagenden Tests**

Getestet wird, dass die richtigen Operationen mit den richtigen Variablen abgesetzt und die Antworten korrekt entpackt werden. Die Fixtures sind echte, aufgezeichnete Antworten.

`src/main/factorial/__tests__/operations.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createOperations } from '../operations'
import type { Operation } from '../client'

function recordingClient(responses: unknown[]) {
  const calls: Operation[] = []
  let i = 0
  return {
    calls,
    client: {
      execute: vi.fn(async (op: Operation) => {
        calls.push(op)
        return responses[i++] ?? {}
      }),
    },
  }
}

describe('fetchMe', () => {
  it('flattens the current-user envelope', async () => {
    const { client } = recordingClient([{
      apiCore: { currentsConnection: { nodes: [{
        email: 'person@example.com',
        employee: { id: 1111111, fullName: 'Erika Beispiel' },
        company: { id: 2222222, name: 'Beispiel GmbH' },
      }] } },
    }])
    await expect(createOperations(client).fetchMe()).resolves.toEqual({
      email: 'person@example.com',
      employeeId: 1111111,
      fullName: 'Erika Beispiel',
      companyId: 2222222,
      companyName: 'Beispiel GmbH',
    })
  })

  it('throws when no current user is returned', async () => {
    const { client } = recordingClient([{ apiCore: { currentsConnection: { nodes: [] } } }])
    await expect(createOperations(client).fetchMe()).rejects.toThrow(/no current user/i)
  })
})

describe('fetchOpenShift', () => {
  it('returns null when the employee is clocked out', async () => {
    const { client } = recordingClient([{ attendance: { employee: { id: 1111111, openShift: null } } }])
    await expect(createOperations(client).fetchOpenShift(1111111)).resolves.toBeNull()
  })

  it('passes the employee id as a number, because the schema demands Int!', async () => {
    const { client, calls } = recordingClient([{ attendance: { employee: { openShift: null } } }])
    await createOperations(client).fetchOpenShift(1111111)
    expect(calls[0]!.variables.id).toBe(1111111)
    expect(typeof calls[0]!.variables.id).toBe('number')
  })

  it('returns the open shift when one exists', async () => {
    const { client } = recordingClient([{ attendance: { employee: { openShift: {
      id: '543339856', date: '2026-08-12', clockIn: '2000-01-01T00:11:12Z',
      locationType: 'office', workplaceId: '3333333', timeSettingsBreakConfiguration: null,
    } } } }])
    const shift = await createOperations(client).fetchOpenShift(1111111)
    expect(shift?.id).toBe('543339856')
  })
})

describe('fetchBreakConfigurations', () => {
  it('reads from timeSettings, not from attendance', async () => {
    // attendance.breakConfigurationsConnection exists but returns different ids
    // and name: null throughout. Only timeSettings carries usable labels.
    const { client, calls } = recordingClient([{ timeSettings: { breakConfigurationsConnection: {
      nodes: [{ id: 19613, name: 'Mittagspause' }, { id: 20261, name: 'Arztbesuch' }],
    } } }])
    const result = await createOperations(client).fetchBreakConfigurations()
    expect(calls[0]!.query).toContain('timeSettings')
    expect(result).toEqual([
      { id: '19613', name: 'Mittagspause' },
      { id: '20261', name: 'Arztbesuch' },
    ])
  })

  it('drops entries without a name so the menu never shows a blank row', async () => {
    const { client } = recordingClient([{ timeSettings: { breakConfigurationsConnection: {
      nodes: [{ id: 1, name: null }, { id: 2, name: 'Mittagspause' }],
    } } }])
    await expect(createOperations(client).fetchBreakConfigurations())
      .resolves.toEqual([{ id: '2', name: 'Mittagspause' }])
  })
})

describe('mutations', () => {
  const now = new Date(2026, 7, 12, 0, 11, 12)

  it('sends clock-in with local timestamps and source desktop', async () => {
    const { client, calls } = recordingClient([{ attendanceMutations: { clockInAttendanceShift: { errors: [] } } }])
    await createOperations(client).clockIn({ now, locationType: 'office', workplaceId: '3333333' })
    expect(calls[0]!.operationName).toBe('ClockIn')
    expect(calls[0]!.variables).toEqual({
      now: '2026-08-12T00:11:12+02:00',
      date: '2026-08-12',
      source: 'desktop',
      locationType: 'office',
      workplaceId: '3333333',
    })
  })

  it('sends break-start with the chosen break configuration id as a string', async () => {
    const { client, calls } = recordingClient([{ attendanceMutations: { breakStartAttendanceShift: { errors: [] } } }])
    await createOperations(client).breakStart({ now, breakConfigurationId: '19613' })
    expect(calls[0]!.operationName).toBe('BreakStart')
    expect(calls[0]!.variables).toMatchObject({
      now: '2026-08-12T00:11:12+02:00',
      startOn: '2026-08-12',
      endOn: '2026-08-12',
      source: 'desktop',
      timeSettingsBreakConfigurationId: '19613',
    })
  })

  it('sends break-end', async () => {
    const { client, calls } = recordingClient([{ attendanceMutations: { breakEndAttendanceShift: { errors: [] } } }])
    await createOperations(client).breakEnd({ now })
    expect(calls[0]!.operationName).toBe('BreakEnd')
    expect(calls[0]!.variables).toMatchObject({ source: 'desktop', startOn: '2026-08-12' })
  })

  it('sends clock-out', async () => {
    const { client, calls } = recordingClient([{ attendanceMutations: { clockOutAttendanceShift: { errors: [] } } }])
    await createOperations(client).clockOut({ now })
    expect(calls[0]!.operationName).toBe('ClockOut')
    expect(calls[0]!.variables).toEqual({
      now: '2026-08-12T00:11:12+02:00',
      date: '2026-08-12',
      startOn: '2026-08-12',
      endOn: '2026-08-12',
      source: 'desktop',
    })
  })

  it('surfaces a mutation-level error even though the transport succeeded', async () => {
    const { client } = recordingClient([{ attendanceMutations: { clockInAttendanceShift: {
      errors: [{ message: 'Already clocked in' }],
    } } }])
    await expect(createOperations(client).clockIn({ now, locationType: 'office', workplaceId: null }))
      .rejects.toThrow(/Already clocked in/)
  })
})
```

- [ ] **Step 2: Tests ausführen, Fehlschlag bestätigen**

Run: `npx vitest run src/main/factorial/__tests__/operations.test.ts`
Expected: FAIL, `../operations` nicht auflösbar.

- [ ] **Step 3: Typen schreiben**

`src/main/factorial/types.ts`:

```ts
export interface Identity {
  email: string
  employeeId: number
  fullName: string
  companyId: number
  companyName: string
}

export interface BreakConfigOption {
  id: string
  name: string
}

export interface ShiftSummary {
  id: string
  date: string
  minutes: number
}
```

- [ ] **Step 4: Operations schreiben**

`src/main/factorial/operations.ts`:

```ts
import { FactorialError, type Operation } from './client'
import { toLocalDate, toLocalIsoWithOffset } from '@shared/time'
import type { OpenShift } from '@shared/attendance-state'
import type { BreakConfigOption, Identity, ShiftSummary } from './types'

interface Client {
  execute<T>(op: Operation): Promise<T>
}

const OPEN_SHIFT_FIELDS = `
  id
  date
  clockIn
  locationType
  workplaceId
  timeSettingsBreakConfiguration { id name }
`

const MUTATION_RESULT = `errors { message } `

/** Every mutation reports failure in-band via `errors`, with HTTP 200. */
function assertNoMutationErrors(payload: unknown, field: string): void {
  const errors = (payload as Record<string, { errors?: { message?: string }[] } | undefined>)
    ?.[field]?.errors
  if (errors?.length) {
    throw new FactorialError('graphql', errors.map((e) => e.message ?? 'unknown').join('; '))
  }
}

export function createOperations(client: Client) {
  /** Shared by every mutation: local wall-clock time plus the local calendar day. */
  function timeVars(now: Date) {
    const date = toLocalDate(now)
    return { now: toLocalIsoWithOffset(now), date, startOn: date, endOn: date }
  }

  return {
    async fetchMe(): Promise<Identity> {
      const data = await client.execute<{
        apiCore: { currentsConnection: { nodes: {
          email: string
          employee: { id: number; fullName: string } | null
          company: { id: number; name: string } | null
        }[] } }
      }>({
        operationName: 'Me',
        variables: {},
        query: `query Me {
          apiCore { currentsConnection { nodes {
            email
            employee { id fullName }
            company { id name }
          } } }
        }`,
      })

      const node = data.apiCore.currentsConnection.nodes[0]
      if (!node?.employee || !node.company) {
        throw new FactorialError('malformed', 'no current user in response')
      }
      return {
        email: node.email,
        employeeId: node.employee.id,
        fullName: node.employee.fullName,
        companyId: node.company.id,
        companyName: node.company.name,
      }
    },

    async fetchOpenShift(employeeId: number): Promise<OpenShift | null> {
      const data = await client.execute<{
        attendance: { employee: { openShift: OpenShift | null } | null }
      }>({
        operationName: 'OpenShift',
        // The schema demands Int! here, while the mutations take ID (string).
        variables: { id: employeeId },
        query: `query OpenShift($id: Int!) {
          attendance { employee(id: $id) { openShift { ${OPEN_SHIFT_FIELDS} } } }
        }`,
      })
      return data.attendance.employee?.openShift ?? null
    },

    async fetchTodayShifts(employeeId: number, date: string): Promise<ShiftSummary[]> {
      const data = await client.execute<{
        attendance: { employee: { attendanceShiftsConnection: { nodes: ShiftSummary[] } } | null }
      }>({
        operationName: 'TodayShifts',
        variables: { id: employeeId, startOn: date, endOn: date },
        query: `query TodayShifts($id: Int!, $startOn: ISO8601Date!, $endOn: ISO8601Date!) {
          attendance { employee(id: $id) {
            attendanceShiftsConnection(startOn: $startOn, endOn: $endOn) {
              nodes { id date minutes }
            }
          } }
        }`,
      })
      return data.attendance.employee?.attendanceShiftsConnection.nodes ?? []
    },

    async fetchBreakConfigurations(): Promise<BreakConfigOption[]> {
      // Must be timeSettings — attendance.breakConfigurationsConnection returns
      // different ids and name: null for every entry.
      const data = await client.execute<{
        timeSettings: { breakConfigurationsConnection: { nodes: { id: number; name: string | null }[] } }
      }>({
        operationName: 'BreakConfigurations',
        variables: {},
        query: `query BreakConfigurations {
          timeSettings { breakConfigurationsConnection { nodes { id name } } }
        }`,
      })
      return data.timeSettings.breakConfigurationsConnection.nodes
        .filter((n): n is { id: number; name: string } => typeof n.name === 'string' && n.name.length > 0)
        .map((n) => ({ id: String(n.id), name: n.name }))
    },

    async clockIn(input: { now: Date; locationType: string; workplaceId: string | null }): Promise<void> {
      const { now, date } = timeVars(input.now)
      const data = await client.execute<Record<string, unknown>>({
        operationName: 'ClockIn',
        variables: {
          now, date, source: 'desktop',
          locationType: input.locationType,
          workplaceId: input.workplaceId,
        },
        query: `mutation ClockIn($now: ISO8601DateTime!, $locationType: AttendanceShiftLocationTypeEnum,
                                 $source: AttendanceEnumsShiftSourceEnum, $workplaceId: ID) {
          attendanceMutations {
            clockInAttendanceShift(now: $now, locationType: $locationType,
                                   source: $source, workplaceId: $workplaceId) { ${MUTATION_RESULT} }
          }
        }`,
      })
      assertNoMutationErrors(data.attendanceMutations, 'clockInAttendanceShift')
    },

    async breakStart(input: { now: Date; breakConfigurationId: string }): Promise<void> {
      const data = await client.execute<Record<string, unknown>>({
        operationName: 'BreakStart',
        variables: {
          ...timeVars(input.now),
          source: 'desktop',
          timeSettingsBreakConfigurationId: input.breakConfigurationId,
        },
        query: `mutation BreakStart($now: ISO8601DateTime!, $source: AttendanceEnumsShiftSourceEnum,
                                    $timeSettingsBreakConfigurationId: ID) {
          attendanceMutations {
            breakStartAttendanceShift(now: $now, source: $source, systemCreated: false,
              timeSettingsBreakConfigurationId: $timeSettingsBreakConfigurationId) { ${MUTATION_RESULT} }
          }
        }`,
      })
      assertNoMutationErrors(data.attendanceMutations, 'breakStartAttendanceShift')
    },

    async breakEnd(input: { now: Date }): Promise<void> {
      const data = await client.execute<Record<string, unknown>>({
        operationName: 'BreakEnd',
        variables: { ...timeVars(input.now), source: 'desktop' },
        query: `mutation BreakEnd($now: ISO8601DateTime!, $source: AttendanceEnumsShiftSourceEnum) {
          attendanceMutations {
            breakEndAttendanceShift(now: $now, source: $source, systemCreated: false) { ${MUTATION_RESULT} }
          }
        }`,
      })
      assertNoMutationErrors(data.attendanceMutations, 'breakEndAttendanceShift')
    },

    async clockOut(input: { now: Date }): Promise<void> {
      const data = await client.execute<Record<string, unknown>>({
        operationName: 'ClockOut',
        variables: { ...timeVars(input.now), source: 'desktop' },
        query: `mutation ClockOut($now: ISO8601DateTime!, $source: AttendanceEnumsShiftSourceEnum) {
          attendanceMutations {
            clockOutAttendanceShift(now: $now, source: $source) { ${MUTATION_RESULT} }
          }
        }`,
      })
      assertNoMutationErrors(data.attendanceMutations, 'clockOutAttendanceShift')
    },
  }
}

export type Operations = ReturnType<typeof createOperations>
```

> Die `timeVars`-Rückgabe enthält `startOn`/`endOn` auch für `ClockIn`. Der Test für `ClockIn` erwartet sie **nicht** — dort wird nur `now` und `date` destrukturiert. Achte darauf, dass die Variablen exakt den Tests entsprechen.

- [ ] **Step 5: Tests ausführen, Erfolg bestätigen**

Run: `npx vitest run src/main/factorial/__tests__/operations.test.ts`
Expected: PASS, 12 Tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/factorial src/main/factorial/__tests__
git commit -m "feat: typed Factorial attendance operations"
```

---

### Task 6: Session und Authentifizierung

**Files:**
- Create: `src/main/session.ts`, `src/main/auth.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `createClient` aus `factorial/client`, `createOperations` aus `factorial/operations`
- Produces:
  - `getFactorialSession(): Electron.Session` — Partition `persist:factorial`
  - `createNetFetch(session): GraphQLFetch`
  - `clearSession(): Promise<void>`
  - `ensureAuthenticated(ops): Promise<Identity>` — öffnet bei Bedarf das Login-Fenster und wartet
  - `openLoginWindow(): Promise<void>`

Dieser Task ist nicht unit-testbar (Electron-Laufzeit). Verifikation erfolgt manuell und ist explizit als solche zu dokumentieren.

- [ ] **Step 1: `src/main/session.ts` schreiben**

```ts
import { session as electronSession, net, type Session } from 'electron'
import type { GraphQLFetch } from './factorial/client'

export const PARTITION = 'persist:factorial'

export function getFactorialSession(): Session {
  return electronSession.fromPartition(PARTITION)
}

/**
 * The renderer cannot call the Factorial API: it has no origin the server
 * allows, so CORS blocks it. `net.fetch` runs in the main process, is not
 * subject to CORS, and attaches the partition's cookies automatically.
 */
export function createNetFetch(session: Session): GraphQLFetch {
  return async (url, init) => {
    const res = await net.fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      session,
      credentials: 'include',
      redirect: 'manual',
    })
    return { status: res.status, text: () => res.text() }
  }
}

/** Logout: drop every cookie in the partition. We never read them. */
export async function clearSession(): Promise<void> {
  const s = getFactorialSession()
  await s.clearStorageData({ storages: ['cookies'] })
}
```

- [ ] **Step 2: `src/main/auth.ts` schreiben**

```ts
import { BrowserWindow } from 'electron'
import { FactorialError } from './factorial/client'
import type { Operations } from './factorial/operations'
import type { Identity } from './factorial/types'
import { PARTITION } from './session'

const LOGIN_URL = 'https://app.factorialhr.com/'
const POLL_INTERVAL_MS = 1500

let loginWindow: BrowserWindow | null = null

/**
 * Opens Factorial's own login flow in a window sharing our persistent session
 * partition, then polls until the session works. We never read the cookie —
 * it is HttpOnly, and Chromium sends it for us.
 */
export function openLoginWindow(): BrowserWindow {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return loginWindow
  }
  loginWindow = new BrowserWindow({
    width: 520,
    height: 720,
    title: 'Bei Factorial anmelden',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // No preload: this loads a third-party website.
    },
  })
  void loginWindow.loadURL(LOGIN_URL)
  loginWindow.on('closed', () => { loginWindow = null })
  return loginWindow
}

export function closeLoginWindow(): void {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close()
  loginWindow = null
}

async function probe(ops: Operations): Promise<Identity | null> {
  try {
    return await ops.fetchMe()
  } catch (err) {
    if (err instanceof FactorialError && err.kind === 'unauthenticated') return null
    // Network hiccups must not be mistaken for a logged-out session.
    throw err
  }
}

/** Resolves once the stored session authenticates, opening the login window if needed. */
export async function ensureAuthenticated(ops: Operations): Promise<Identity> {
  const existing = await probe(ops)
  if (existing) return existing

  const win = openLoginWindow()

  return await new Promise<Identity>((resolve, reject) => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const identity = await probe(ops)
          if (!identity) return
          clearInterval(timer)
          closeLoginWindow()
          resolve(identity)
        } catch {
          // Keep polling; a transient failure is not a verdict.
        }
      })()
    }, POLL_INTERVAL_MS)

    win.on('closed', () => {
      clearInterval(timer)
      reject(new FactorialError('unauthenticated', 'Anmeldung abgebrochen'))
    })
  })
}
```

- [ ] **Step 3: `src/main/index.ts` verdrahten**

Ersetze den Inhalt durch:

```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { createClient } from './factorial/client'
import { createOperations } from './factorial/operations'
import { createNetFetch, getFactorialSession } from './session'
import { ensureAuthenticated } from './auth'

// PLATFORM: Windows launches a second process per invocation without this lock;
// macOS reuses the running instance on its own.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

async function bootstrap(): Promise<void> {
  const client = createClient(createNetFetch(getFactorialSession()))
  const ops = createOperations(client)

  const identity = await ensureAuthenticated(ops)
  console.log('[auth] signed in as', identity.fullName, '/', identity.companyName)

  const win = new BrowserWindow({
    width: 340,
    height: 220,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(bootstrap)

// PLATFORM: macOS keeps the app alive with no windows; every other platform quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 4: Manuell verifizieren — Erstanmeldung**

Run: `npm run dev`
Expected: Das Login-Fenster öffnet sich auf Factorial. Nach der Anmeldung schließt es sich selbst, und in der Terminal-Ausgabe erscheint `[auth] signed in as <Name> / <Firma>`.

- [ ] **Step 5: Manuell verifizieren — Session bleibt bestehen**

App beenden, `npm run dev` erneut starten.
Expected: **Kein** Login-Fenster. Direkt die `[auth] signed in`-Zeile.

Dieses Ergebnis ist der Beleg, dass die persistente Partition funktioniert. Halte es fest.

- [ ] **Step 6: Typecheck und Tests**

Run: `npm run typecheck && npm test`
Expected: beides grün.

- [ ] **Step 7: Commit**

```bash
git add src/main/session.ts src/main/auth.ts src/main/index.ts
git commit -m "feat: persistent session partition and embedded login flow"
```

---

### Task 7: Attendance-Store

**Files:**
- Create: `src/main/attendance.ts`
- Test: `src/main/__tests__/attendance.test.ts`

**Interfaces:**
- Consumes: `deriveState`, `AttendanceState`, `OpenShift` aus `@shared/attendance-state`; `Operations` aus `factorial/operations`
- Produces: `createAttendanceStore(deps)` mit
  - `getSnapshot(): Snapshot` — `{ state, todayMinutes, breakOptions, lastError, stale }`
  - `subscribe(listener: () => void): () => void`
  - `refresh(): Promise<void>`
  - `clockIn(input)`, `startBreak(breakId)`, `endBreak()`, `clockOut()`
  - `startPolling()`, `stopPolling()`

`deps` = `{ ops, employeeId, now: () => Date, setInterval?, clearInterval? }`. Die Zeitquelle wird injiziert, damit Tests deterministisch sind.

- [ ] **Step 1: Schreibe die fehlschlagenden Tests**

`src/main/__tests__/attendance.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createAttendanceStore } from '../attendance'
import type { OpenShift } from '@shared/attendance-state'

const NOW = new Date(2026, 7, 12, 9, 0, 0)

const OPEN: OpenShift = {
  id: '1', date: '2026-08-12', clockIn: '2000-01-01T08:30:00Z',
  locationType: 'office', workplaceId: '3333333', timeSettingsBreakConfiguration: null,
}

function makeOps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    fetchOpenShift: vi.fn(async () => null as OpenShift | null),
    fetchTodayShifts: vi.fn(async () => [{ id: '1', date: '2026-08-12', minutes: 120 }]),
    fetchBreakConfigurations: vi.fn(async () => [{ id: '19613', name: 'Mittagspause' }]),
    clockIn: vi.fn(async () => {}),
    breakStart: vi.fn(async () => {}),
    breakEnd: vi.fn(async () => {}),
    clockOut: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeStore(ops: ReturnType<typeof makeOps>) {
  return createAttendanceStore({ ops: ops as never, employeeId: 1111111, now: () => NOW })
}

describe('refresh', () => {
  it('starts in the unknown state before anything is loaded', () => {
    expect(makeStore(makeOps()).getSnapshot().state.kind).toBe('unknown')
  })

  it('reports clocked out after refreshing with no open shift', async () => {
    const store = makeStore(makeOps())
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('out')
  })

  it('reports clocked in when a shift is open', async () => {
    const store = makeStore(makeOps({ fetchOpenShift: vi.fn(async () => OPEN) }))
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('in')
  })

  it('sums today’s minutes across the shifts a break split apart', async () => {
    const store = makeStore(makeOps({
      fetchTodayShifts: vi.fn(async () => [
        { id: '1', date: '2026-08-12', minutes: 90 },
        { id: '2', date: '2026-08-12', minutes: 45 },
      ]),
    }))
    await store.refresh()
    expect(store.getSnapshot().todayMinutes).toBe(135)
  })

  it('notifies subscribers when the snapshot changes', async () => {
    const store = makeStore(makeOps())
    const listener = vi.fn()
    store.subscribe(listener)
    await store.refresh()
    expect(listener).toHaveBeenCalled()
  })

  it('marks the snapshot stale when a refresh fails, keeping the last known state', async () => {
    const ops = makeOps({ fetchOpenShift: vi.fn(async () => OPEN) })
    const store = makeStore(ops)
    await store.refresh()
    ops.fetchOpenShift.mockRejectedValueOnce(new Error('offline'))
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('in')
    expect(store.getSnapshot().stale).toBe(true)
  })

  it('reports an expired session as unauthenticated rather than merely stale', async () => {
    const { FactorialError } = await import('../factorial/client')
    const ops = makeOps({
      fetchOpenShift: vi.fn(async () => { throw new FactorialError('unauthenticated', 'session rejected') }),
    })
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('unauthenticated')
    expect(store.getSnapshot().stale).toBe(false)
  })

  it('clears the stale flag once a refresh succeeds again', async () => {
    const ops = makeOps()
    const store = makeStore(ops)
    ops.fetchOpenShift.mockRejectedValueOnce(new Error('offline'))
    await store.refresh()
    expect(store.getSnapshot().stale).toBe(true)
    await store.refresh()
    expect(store.getSnapshot().stale).toBe(false)
  })
})

describe('optimistic updates', () => {
  it('shows the clocked-in state immediately, before the server confirms', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const ops = makeOps({ clockIn: vi.fn(async () => { await gate }) })
    const store = makeStore(ops)
    await store.refresh()

    const pending = store.clockIn({ locationType: 'office', workplaceId: '3333333' })
    expect(store.getSnapshot().state.kind).toBe('in')
    ops.fetchOpenShift.mockResolvedValue(OPEN)
    release()
    await pending
    expect(store.getSnapshot().state.kind).toBe('in')
  })

  it('rolls back to the previous state when the mutation fails', async () => {
    const ops = makeOps({ clockIn: vi.fn(async () => { throw new Error('Already clocked in') }) })
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('out')

    await expect(store.clockIn({ locationType: 'office', workplaceId: null })).rejects.toThrow()
    expect(store.getSnapshot().state.kind).toBe('out')
    expect(store.getSnapshot().lastError).toMatch(/Already clocked in/)
  })

  it('never retries a failed mutation, because a late clock-in writes a wrong time', async () => {
    const ops = makeOps({ clockIn: vi.fn(async () => { throw new Error('boom') }) })
    const store = makeStore(ops)
    await store.refresh()
    await expect(store.clockIn({ locationType: 'office', workplaceId: null })).rejects.toThrow()
    expect(ops.clockIn).toHaveBeenCalledTimes(1)
  })

  it('rejects a second action while one is still in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const ops = makeOps({ clockIn: vi.fn(async () => { await gate }) })
    const store = makeStore(ops)
    await store.refresh()

    const first = store.clockIn({ locationType: 'office', workplaceId: null })
    await expect(store.clockIn({ locationType: 'office', workplaceId: null })).rejects.toThrow(/in flight/i)
    release()
    await first
  })

  it('starts a break optimistically with the chosen label', async () => {
    const ops = makeOps({ fetchOpenShift: vi.fn(async () => OPEN) })
    const store = makeStore(ops)
    await store.refresh()
    ops.fetchOpenShift.mockResolvedValue({
      ...OPEN, timeSettingsBreakConfiguration: { id: '19613', name: 'Mittagspause' },
    })
    await store.startBreak('19613')
    const state = store.getSnapshot().state
    expect(state.kind).toBe('break')
    if (state.kind !== 'break') throw new Error('unreachable')
    expect(state.breakName).toBe('Mittagspause')
  })
})
```

- [ ] **Step 2: Tests ausführen, Fehlschlag bestätigen**

Run: `npx vitest run src/main/__tests__/attendance.test.ts`
Expected: FAIL, `../attendance` nicht auflösbar.

- [ ] **Step 3: Implementierung schreiben**

`src/main/attendance.ts`:

```ts
import { deriveState, type AttendanceState, type OpenShift } from '@shared/attendance-state'
import type { Operations } from './factorial/operations'
import { FactorialError } from './factorial/client'
import { toLocalDate } from '@shared/time'
import type { AppSnapshot } from '@shared/ipc-contract'

/** The store's snapshot IS the app snapshot; there is no second shape. */
export type Snapshot = AppSnapshot

interface Deps {
  ops: Operations
  employeeId: number
  now?: () => Date
}

const POLL_INTERVAL_MS = 60_000

export function createAttendanceStore({ ops, employeeId, now = () => new Date() }: Deps) {
  let snapshot: Snapshot = {
    state: { kind: 'unknown' },
    todayMinutes: 0,
    breakOptions: [],
    lastError: null,
    stale: false,
  }

  const listeners = new Set<() => void>()
  let inFlight = false
  let poll: ReturnType<typeof setInterval> | null = null

  function emit(next: Partial<Snapshot>): void {
    snapshot = { ...snapshot, ...next }
    for (const l of listeners) l()
  }

  async function loadBreakOptions(): Promise<void> {
    if (snapshot.breakOptions.length) return
    try {
      emit({ breakOptions: await ops.fetchBreakConfigurations() })
    } catch {
      // Non-fatal: the break menu simply stays empty until the next attempt.
    }
  }

  async function refresh(): Promise<void> {
    try {
      const today = toLocalDate(now())
      const [openShift, shifts] = await Promise.all([
        ops.fetchOpenShift(employeeId),
        ops.fetchTodayShifts(employeeId, today),
      ])
      emit({
        state: deriveState(openShift, now()),
        todayMinutes: shifts.reduce((sum, s) => sum + (s.minutes ?? 0), 0),
        stale: false,
      })
      void loadBreakOptions()
    } catch (err) {
      // An expired session is a verdict, not a hiccup: surface it so the UI can
      // offer a new sign-in instead of showing a frozen timer forever.
      if (err instanceof FactorialError && err.kind === 'unauthenticated') {
        emit({ state: { kind: 'unauthenticated' }, stale: false, lastError: err.message })
        return
      }
      // Everything else: keep the last known state rather than blanking the widget.
      emit({ stale: true, lastError: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * Show the target state at once, then confirm against the server. On failure
   * we roll back — a failed clock-in is never retried, because writing the time
   * later would record a time that never happened.
   */
  async function mutate(optimistic: AttendanceState, action: () => Promise<void>): Promise<void> {
    if (inFlight) throw new Error('another action is already in flight')
    const previous = snapshot.state
    inFlight = true
    emit({ state: optimistic, lastError: null })
    try {
      await action()
      await refresh()
    } catch (err) {
      emit({ state: previous, lastError: err instanceof Error ? err.message : String(err) })
      void refresh()
      throw err
    } finally {
      inFlight = false
    }
  }

  /** Builds a provisional "clocked in" state that looks like a fresh server shift. */
  function optimisticClockedIn(extra: Partial<OpenShift> = {}): AttendanceState {
    const at = now()
    const hhmmss = [at.getHours(), at.getMinutes(), at.getSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':')
    const base: OpenShift = {
      id: 'optimistic',
      date: toLocalDate(at),
      // Mirrors the sentinel shape the API returns; only the time is read.
      clockIn: `2000-01-01T${hhmmss}Z`,
      locationType: null,
      workplaceId: null,
      timeSettingsBreakConfiguration: null,
      ...extra,
    }
    return deriveState(base, at)
  }

  return {
    getSnapshot: (): Snapshot => snapshot,

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    refresh,

    async clockIn(input: { locationType: string; workplaceId: string | null }): Promise<void> {
      await mutate(
        optimisticClockedIn({ locationType: input.locationType, workplaceId: input.workplaceId }),
        () => ops.clockIn({ now: now(), ...input }),
      )
    },

    async startBreak(breakId: string): Promise<void> {
      const option = snapshot.breakOptions.find((o) => o.id === breakId)
      const current = snapshot.state
      const since = current.kind === 'in' || current.kind === 'break' ? current.since : now()
      await mutate(
        { kind: 'break', shiftId: 'optimistic', since, breakId, breakName: option?.name ?? 'Pause' },
        () => ops.breakStart({ now: now(), breakConfigurationId: breakId }),
      )
    },

    async endBreak(): Promise<void> {
      await mutate(optimisticClockedIn(), () => ops.breakEnd({ now: now() }))
    },

    async clockOut(): Promise<void> {
      await mutate({ kind: 'out' }, () => ops.clockOut({ now: now() }))
    },

    startPolling(): void {
      if (poll) return
      poll = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    },

    stopPolling(): void {
      if (poll) clearInterval(poll)
      poll = null
    },
  }
}

export type AttendanceStore = ReturnType<typeof createAttendanceStore>
```

- [ ] **Step 4: Tests ausführen, Erfolg bestätigen**

Run: `npx vitest run src/main/__tests__/attendance.test.ts`
Expected: PASS, 13 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/attendance.ts src/main/__tests__/attendance.test.ts
git commit -m "feat: attendance store with optimistic updates and rollback"
```

---

### Task 8: IPC-Vertrag und Preload

**Files:**
- Create: `src/shared/ipc-contract.ts`, `src/main/ipc.ts`
- Modify: `src/preload/index.ts`, `src/main/index.ts`
- Test: `src/shared/__tests__/ipc-contract.test.ts`

**Interfaces:**
- Consumes: `Snapshot` aus `main/attendance`, `AttendanceState` aus `@shared/attendance-state`
- Produces:
  - `IPC` — Kanalnamen als Konstanten
  - `type SerialisedSnapshot` — wie `Snapshot`, aber `since` als Millisekunden-Zahl
  - `serialiseSnapshot(s) / deserialiseSnapshot(s)`
  - `window.factorial` im Renderer: `{ getSnapshot, onSnapshot, clockIn, startBreak, endBreak, clockOut, refresh, signOut, getSettings, setSettings }`

`Date`-Objekte überleben den IPC-Transport als String, nicht als `Date`. Deshalb wird explizit serialisiert.

- [ ] **Step 1: Schreibe die fehlschlagenden Tests**

`src/shared/__tests__/ipc-contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { serialiseSnapshot, deserialiseSnapshot } from '@shared/ipc-contract'

describe('snapshot serialisation', () => {
  it('round-trips a clocked-in snapshot, preserving the start instant', () => {
    const since = new Date(2026, 7, 12, 8, 30, 0)
    const original = {
      state: { kind: 'in', shiftId: '1', since, locationType: 'office', workplaceId: '3333333' },
      todayMinutes: 120, breakOptions: [{ id: '19613', name: 'Mittagspause' }],
      lastError: null, stale: false,
    } as const
    const restored = deserialiseSnapshot(serialiseSnapshot(original))
    expect(restored.state.kind).toBe('in')
    if (restored.state.kind !== 'in') throw new Error('unreachable')
    expect(restored.state.since).toBeInstanceOf(Date)
    expect(restored.state.since.getTime()).toBe(since.getTime())
  })

  it('round-trips a break snapshot', () => {
    const since = new Date(2026, 7, 12, 12, 0, 0)
    const restored = deserialiseSnapshot(serialiseSnapshot({
      state: { kind: 'break', shiftId: '1', since, breakId: '19613', breakName: 'Mittagspause' },
      todayMinutes: 0, breakOptions: [], lastError: null, stale: false,
    }))
    if (restored.state.kind !== 'break') throw new Error('unreachable')
    expect(restored.state.breakName).toBe('Mittagspause')
    expect(restored.state.since.getTime()).toBe(since.getTime())
  })

  it('round-trips states that carry no date', () => {
    for (const kind of ['unknown', 'unauthenticated', 'out'] as const) {
      const restored = deserialiseSnapshot(serialiseSnapshot({
        state: { kind }, todayMinutes: 0, breakOptions: [], lastError: null, stale: false,
      }))
      expect(restored.state.kind).toBe(kind)
    }
  })

  it('produces a structured-clone-safe payload with no Date instances', () => {
    const payload = serialiseSnapshot({
      state: { kind: 'in', shiftId: '1', since: new Date(), locationType: null, workplaceId: null },
      todayMinutes: 0, breakOptions: [], lastError: null, stale: false,
    })
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})
```

- [ ] **Step 2: Tests ausführen, Fehlschlag bestätigen**

Run: `npx vitest run src/shared/__tests__/ipc-contract.test.ts`
Expected: FAIL.

- [ ] **Step 3: `src/shared/ipc-contract.ts` schreiben**

```ts
import type { AttendanceState } from './attendance-state'

export const IPC = {
  getSnapshot: 'attendance:getSnapshot',
  snapshotChanged: 'attendance:snapshotChanged',
  clockIn: 'attendance:clockIn',
  startBreak: 'attendance:startBreak',
  endBreak: 'attendance:endBreak',
  clockOut: 'attendance:clockOut',
  refresh: 'attendance:refresh',
  signOut: 'auth:signOut',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
} as const

export interface BreakOption { id: string; name: string }

export interface AppSnapshot {
  state: AttendanceState
  todayMinutes: number
  breakOptions: BreakOption[]
  lastError: string | null
  stale: boolean
}

/** `since` travels as epoch milliseconds; Date does not survive IPC as a Date. */
export type SerialisedState =
  | { kind: 'unknown' } | { kind: 'unauthenticated' } | { kind: 'out' }
  | { kind: 'in'; shiftId: string; sinceMs: number; locationType: string | null; workplaceId: string | null }
  | { kind: 'break'; shiftId: string; sinceMs: number; breakId: string; breakName: string }

export interface SerialisedSnapshot {
  state: SerialisedState
  todayMinutes: number
  breakOptions: BreakOption[]
  lastError: string | null
  stale: boolean
}

export function serialiseSnapshot(s: AppSnapshot): SerialisedSnapshot {
  const state: SerialisedState =
    s.state.kind === 'in'
      ? { kind: 'in', shiftId: s.state.shiftId, sinceMs: s.state.since.getTime(),
          locationType: s.state.locationType, workplaceId: s.state.workplaceId }
      : s.state.kind === 'break'
        ? { kind: 'break', shiftId: s.state.shiftId, sinceMs: s.state.since.getTime(),
            breakId: s.state.breakId, breakName: s.state.breakName }
        : { kind: s.state.kind }
  return { ...s, state }
}

export function deserialiseSnapshot(s: SerialisedSnapshot): AppSnapshot {
  const state: AttendanceState =
    s.state.kind === 'in'
      ? { kind: 'in', shiftId: s.state.shiftId, since: new Date(s.state.sinceMs),
          locationType: s.state.locationType, workplaceId: s.state.workplaceId }
      : s.state.kind === 'break'
        ? { kind: 'break', shiftId: s.state.shiftId, since: new Date(s.state.sinceMs),
            breakId: s.state.breakId, breakName: s.state.breakName }
        : { kind: s.state.kind }
  return { ...s, state }
}

export interface AppSettings {
  openAtLogin: boolean
  alwaysOnTop: boolean
  lastLocationType: string
  lastWorkplaceId: string | null
}

export interface FactorialBridge {
  getSnapshot(): Promise<SerialisedSnapshot>
  onSnapshot(cb: (s: SerialisedSnapshot) => void): () => void
  clockIn(input: { locationType: string; workplaceId: string | null }): Promise<void>
  startBreak(breakId: string): Promise<void>
  endBreak(): Promise<void>
  clockOut(): Promise<void>
  refresh(): Promise<void>
  signOut(): Promise<void>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
}
```

- [ ] **Step 4: Tests ausführen, Erfolg bestätigen**

Run: `npx vitest run src/shared/__tests__/ipc-contract.test.ts`
Expected: PASS, 4 Tests.

- [ ] **Step 5: `src/preload/index.ts` schreiben**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppSettings, type FactorialBridge, type SerialisedSnapshot } from '@shared/ipc-contract'

const bridge: FactorialBridge = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  onSnapshot: (cb) => {
    const handler = (_e: unknown, s: SerialisedSnapshot): void => cb(s)
    ipcRenderer.on(IPC.snapshotChanged, handler)
    return () => { ipcRenderer.off(IPC.snapshotChanged, handler) }
  },
  clockIn: (input) => ipcRenderer.invoke(IPC.clockIn, input),
  startBreak: (breakId) => ipcRenderer.invoke(IPC.startBreak, breakId),
  endBreak: () => ipcRenderer.invoke(IPC.endBreak),
  clockOut: () => ipcRenderer.invoke(IPC.clockOut),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  signOut: () => ipcRenderer.invoke(IPC.signOut),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.setSettings, patch),
}

contextBridge.exposeInMainWorld('factorial', bridge)
```

- [ ] **Step 6: `src/main/ipc.ts` schreiben**

```ts
import { BrowserWindow, ipcMain } from 'electron'
import { IPC, serialiseSnapshot } from '@shared/ipc-contract'
import type { AttendanceStore } from './attendance'
import type { AppSettings } from '@shared/ipc-contract'

interface Deps {
  store: AttendanceStore
  settings: { get(): AppSettings; set(patch: Partial<AppSettings>): AppSettings }
  onSignOut: () => Promise<void>
}

export function registerIpc({ store, settings, onSignOut }: Deps): void {
  ipcMain.handle(IPC.getSnapshot, () => serialiseSnapshot(store.getSnapshot()))
  ipcMain.handle(IPC.clockIn, (_e, input: { locationType: string; workplaceId: string | null }) =>
    store.clockIn(input))
  ipcMain.handle(IPC.startBreak, (_e, breakId: string) => store.startBreak(breakId))
  ipcMain.handle(IPC.endBreak, () => store.endBreak())
  ipcMain.handle(IPC.clockOut, () => store.clockOut())
  ipcMain.handle(IPC.refresh, () => store.refresh())
  ipcMain.handle(IPC.signOut, () => onSignOut())
  ipcMain.handle(IPC.getSettings, () => settings.get())
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => settings.set(patch))

  store.subscribe(() => {
    const payload = serialiseSnapshot(store.getSnapshot())
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.snapshotChanged, payload)
    }
  })
}
```

- [ ] **Step 7: Typecheck und Tests**

Run: `npm run typecheck && npm test`
Expected: beides grün.

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc-contract.ts src/shared/__tests__/ipc-contract.test.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat: typed IPC contract between main and renderer"
```

---

### Task 9: Einstellungen und Autostart

**Files:**
- Create: `src/main/settings.ts`
- Test: `src/main/__tests__/settings.test.ts`

**Interfaces:**
- Consumes: `AppSettings` aus `@shared/ipc-contract`
- Produces: `createSettings(deps: { filePath: string; applyLoginItem: (open: boolean) => void })` mit `get()`, `set(patch)`

- [ ] **Step 1: Schreibe die fehlschlagenden Tests**

`src/main/__tests__/settings.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettings, DEFAULT_SETTINGS } from '../settings'

let dir: string
let file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fd-')); file = join(dir, 'settings.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('createSettings', () => {
  it('returns defaults when no file exists yet', () => {
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn() })
    expect(s.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('persists a change and reloads it', () => {
    const s1 = createSettings({ filePath: file, applyLoginItem: vi.fn() })
    s1.set({ alwaysOnTop: false })
    const s2 = createSettings({ filePath: file, applyLoginItem: vi.fn() })
    expect(s2.get().alwaysOnTop).toBe(false)
  })

  it('merges a patch instead of replacing the whole object', () => {
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn() })
    s.set({ lastWorkplaceId: '3333333' })
    expect(s.get().alwaysOnTop).toBe(DEFAULT_SETTINGS.alwaysOnTop)
    expect(s.get().lastWorkplaceId).toBe('3333333')
  })

  it('applies the login-item side effect only when openAtLogin changes', () => {
    const applyLoginItem = vi.fn()
    const s = createSettings({ filePath: file, applyLoginItem })
    applyLoginItem.mockClear()
    s.set({ alwaysOnTop: false })
    expect(applyLoginItem).not.toHaveBeenCalled()
    s.set({ openAtLogin: false })
    expect(applyLoginItem).toHaveBeenCalledWith(false)
  })

  it('falls back to defaults when the file is corrupt rather than crashing at startup', () => {
    writeFileSync(file, '{ not json')
    expect(createSettings({ filePath: file, applyLoginItem: vi.fn() }).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('ignores unknown keys from an older or newer version of the file', () => {
    writeFileSync(file, JSON.stringify({ alwaysOnTop: false, ancientFlag: true }))
    const s = createSettings({ filePath: file, applyLoginItem: vi.fn() })
    expect(s.get()).toEqual({ ...DEFAULT_SETTINGS, alwaysOnTop: false })
  })
})
```

- [ ] **Step 2: Tests ausführen, Fehlschlag bestätigen**

Run: `npx vitest run src/main/__tests__/settings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementierung schreiben**

`src/main/settings.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppSettings } from '@shared/ipc-contract'

export const DEFAULT_SETTINGS: AppSettings = {
  openAtLogin: true,
  alwaysOnTop: true,
  lastLocationType: 'office',
  lastWorkplaceId: null,
}

interface Deps {
  filePath: string
  applyLoginItem: (openAtLogin: boolean) => void
}

/** Keeps only known keys, so a stale or future file never injects surprises. */
function sanitise(raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  const r = raw as Partial<Record<keyof AppSettings, unknown>>
  return {
    openAtLogin: typeof r.openAtLogin === 'boolean' ? r.openAtLogin : DEFAULT_SETTINGS.openAtLogin,
    alwaysOnTop: typeof r.alwaysOnTop === 'boolean' ? r.alwaysOnTop : DEFAULT_SETTINGS.alwaysOnTop,
    lastLocationType: typeof r.lastLocationType === 'string' ? r.lastLocationType : DEFAULT_SETTINGS.lastLocationType,
    lastWorkplaceId: typeof r.lastWorkplaceId === 'string' ? r.lastWorkplaceId : null,
  }
}

export function createSettings({ filePath, applyLoginItem }: Deps) {
  let current: AppSettings
  try {
    current = sanitise(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    // Missing or corrupt file must never block startup.
    current = { ...DEFAULT_SETTINGS }
  }

  function persist(): void {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf8')
  }

  return {
    get: (): AppSettings => current,
    set(patch: Partial<AppSettings>): AppSettings {
      const before = current.openAtLogin
      current = sanitise({ ...current, ...patch })
      persist()
      if (current.openAtLogin !== before) applyLoginItem(current.openAtLogin)
      return current
    },
  }
}

export type Settings = ReturnType<typeof createSettings>
```

- [ ] **Step 4: Tests ausführen, Erfolg bestätigen**

Run: `npx vitest run src/main/__tests__/settings.test.ts`
Expected: PASS, 6 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/settings.ts src/main/__tests__/settings.test.ts
git commit -m "feat: persisted settings with login-item side effect"
```

---

### Task 10: Widget-Fenster mit Positions-Persistenz

**Files:**
- Create: `src/main/windows.ts`
- Test: `src/main/__tests__/window-position.test.ts`

**Interfaces:**
- Consumes: `Settings` aus `./settings`
- Produces:
  - `clampToVisibleArea(saved, displays, size): { x: number; y: number }` — pure, testbar
  - `createWidgetWindow(deps): BrowserWindow`
  - `toggleWidget(): void`, `showWidget(): void`, `getWidget(): BrowserWindow | null`

- [ ] **Step 1: Schreibe die fehlschlagenden Tests für die Positionslogik**

`src/main/__tests__/window-position.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { clampToVisibleArea, type DisplayBounds } from '../windows'

const SIZE = { width: 340, height: 220 }
const MAIN: DisplayBounds = { x: 0, y: 0, width: 1920, height: 1080 }
const SECOND: DisplayBounds = { x: 1920, y: 0, width: 1280, height: 720 }

describe('clampToVisibleArea', () => {
  it('keeps a position that is fully on a display', () => {
    expect(clampToVisibleArea({ x: 100, y: 100 }, [MAIN], SIZE)).toEqual({ x: 100, y: 100 })
  })

  it('keeps a position on a secondary display', () => {
    expect(clampToVisibleArea({ x: 2000, y: 100 }, [MAIN, SECOND], SIZE)).toEqual({ x: 2000, y: 100 })
  })

  it('recentres when the saved display is gone, so the window cannot vanish', () => {
    // Saved on a monitor that is no longer attached.
    const result = clampToVisibleArea({ x: 2000, y: 100 }, [MAIN], SIZE)
    expect(result).toEqual({ x: (1920 - 340) / 2, y: (1080 - 220) / 2 })
  })

  it('pulls a window back that hangs off the right edge', () => {
    const result = clampToVisibleArea({ x: 1900, y: 100 }, [MAIN], SIZE)
    expect(result.x).toBe(1920 - 340)
    expect(result.y).toBe(100)
  })

  it('pulls a window back that hangs off the bottom edge', () => {
    const result = clampToVisibleArea({ x: 100, y: 1000 }, [MAIN], SIZE)
    expect(result.y).toBe(1080 - 220)
  })

  it('pulls a window back from negative coordinates', () => {
    expect(clampToVisibleArea({ x: -200, y: -50 }, [MAIN], SIZE)).toEqual({ x: 0, y: 0 })
  })

  it('centres on the primary display when nothing was saved', () => {
    expect(clampToVisibleArea(null, [MAIN], SIZE)).toEqual({ x: 790, y: 430 })
  })

  it('survives an empty display list without throwing', () => {
    expect(clampToVisibleArea({ x: 10, y: 10 }, [], SIZE)).toEqual({ x: 0, y: 0 })
  })
})
```

- [ ] **Step 2: Tests ausführen, Fehlschlag bestätigen**

Run: `npx vitest run src/main/__tests__/window-position.test.ts`
Expected: FAIL.

- [ ] **Step 3: `src/main/windows.ts` schreiben**

```ts
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const WIDGET_SIZE = { width: 340, height: 224 } as const

export interface DisplayBounds { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/**
 * A saved position can point at a monitor that is no longer attached, or at
 * coordinates that are now off-screen. Either way the window would be
 * invisible with no way to get it back, so validate before using it.
 */
export function clampToVisibleArea(
  saved: Point | null,
  displays: DisplayBounds[],
  size: { width: number; height: number },
): Point {
  const primary = displays[0]
  if (!primary) return { x: 0, y: 0 }

  const centreOnPrimary = (): Point => ({
    x: Math.round(primary.x + (primary.width - size.width) / 2),
    y: Math.round(primary.y + (primary.height - size.height) / 2),
  })

  if (!saved) return centreOnPrimary()

  const host = displays.find(
    (d) => saved.x >= d.x && saved.x < d.x + d.width && saved.y >= d.y && saved.y < d.y + d.height,
  )
  if (!host) return centreOnPrimary()

  return {
    x: Math.min(Math.max(saved.x, host.x), host.x + host.width - size.width),
    y: Math.min(Math.max(saved.y, host.y), host.y + host.height - size.height),
  }
}

function readPoint(file: string): Point | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Point>
    if (typeof raw.x === 'number' && typeof raw.y === 'number') return { x: raw.x, y: raw.y }
  } catch { /* no saved position yet */ }
  return null
}

function writePoint(file: string, p: Point): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(p), 'utf8')
}

let widget: BrowserWindow | null = null

export function createWidgetWindow(deps: { positionFile: string; alwaysOnTop: boolean }): BrowserWindow {
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const { x, y } = clampToVisibleArea(readPoint(deps.positionFile), displays, WIDGET_SIZE)

  widget = new BrowserWindow({
    ...WIDGET_SIZE,
    x, y,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    // PLATFORM: macOS renders a rounded, shadowed transparent window natively.
    // Windows draws a square shadow around transparent windows and needs
    // `backgroundColor: '#00000000'`; verify on Windows.
    backgroundColor: '#00000000',
    alwaysOnTop: deps.alwaysOnTop,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // PLATFORM: keeps the widget visible above full-screen spaces on macOS.
  // No effect on Windows.
  if (process.platform === 'darwin') {
    widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  widget.on('moved', () => {
    const [nx, ny] = widget?.getPosition() ?? [0, 0]
    writePoint(deps.positionFile, { x: nx, y: ny })
  })

  // Closing hides; quitting happens through the tray.
  widget.on('close', (e) => {
    if (!(globalThis as { __quitting?: boolean }).__quitting) {
      e.preventDefault()
      widget?.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void widget.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void widget.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  widget.once('ready-to-show', () => widget?.show())
  return widget
}

export function getWidget(): BrowserWindow | null {
  return widget && !widget.isDestroyed() ? widget : null
}

export function showWidget(): void {
  const w = getWidget()
  if (!w) return
  w.show()
  w.focus()
}

export function toggleWidget(): void {
  const w = getWidget()
  if (!w) return
  if (w.isVisible()) w.hide()
  else showWidget()
}
```

- [ ] **Step 4: Tests ausführen, Erfolg bestätigen**

Run: `npx vitest run src/main/__tests__/window-position.test.ts`
Expected: PASS, 8 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/windows.ts src/main/__tests__/window-position.test.ts
git commit -m "feat: frameless widget window with validated position persistence"
```

---

### Task 11: Widget-UI

**Files:**
- Create: `src/renderer/src/hooks/useAttendance.ts`, `src/renderer/src/components/ProgressRing.tsx`, `src/renderer/src/components/StatusWidget.tsx`, `src/renderer/src/components/ActionBar.tsx`, `src/renderer/src/components/BreakMenu.tsx`, `src/renderer/src/components/LocationSelect.tsx`, `src/renderer/src/types/global.d.ts`
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `FactorialBridge`, `deserialiseSnapshot`, `AppSnapshot` aus `@shared/ipc-contract`; `formatDuration`, `formatHoursMinutes` aus `@shared/time`
- Produces: gerendertes Widget für alle Zustände

- [ ] **Step 1: Globalen Typ für die Bridge deklarieren**

`src/renderer/src/types/global.d.ts`:

```ts
import type { FactorialBridge } from '@shared/ipc-contract'

declare global {
  interface Window { factorial: FactorialBridge }
}
export {}
```

- [ ] **Step 2: `useAttendance`-Hook schreiben**

`src/renderer/src/hooks/useAttendance.ts`:

```ts
import { useEffect, useState } from 'react'
import { deserialiseSnapshot, type AppSnapshot } from '@shared/ipc-contract'

const INITIAL: AppSnapshot = {
  state: { kind: 'unknown' }, todayMinutes: 0, breakOptions: [], lastError: null, stale: false,
}

export function useAttendance(): AppSnapshot {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(INITIAL)

  useEffect(() => {
    let active = true
    void window.factorial.getSnapshot().then((s) => { if (active) setSnapshot(deserialiseSnapshot(s)) })
    const off = window.factorial.onSnapshot((s) => setSnapshot(deserialiseSnapshot(s)))
    return () => { active = false; off() }
  }, [])

  return snapshot
}

/** Re-renders once a second so the running timer stays current. */
export function useTicker(active: boolean): number {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return tick
}
```

- [ ] **Step 3: `ProgressRing` schreiben**

`src/renderer/src/components/ProgressRing.tsx`:

```tsx
interface Props {
  /** 0..1; values above 1 are clamped so overtime does not overdraw the ring. */
  progress: number
  label: string
  tone: 'idle' | 'active' | 'paused'
}

const TONE: Record<Props['tone'], string> = {
  idle: 'stroke-muted-foreground/40',
  active: 'stroke-emerald-500',
  paused: 'stroke-amber-500',
}

export function ProgressRing({ progress, label, tone }: Props) {
  const radius = 46
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(1, Math.max(0, progress))

  return (
    <div className="relative grid h-28 w-28 place-items-center">
      <svg className="h-28 w-28 -rotate-90" viewBox="0 0 112 112" aria-hidden>
        <circle cx="56" cy="56" r={radius} fill="none" strokeWidth="6" className="stroke-muted" />
        <circle
          cx="56" cy="56" r={radius} fill="none" strokeWidth="6" strokeLinecap="round"
          className={`${TONE[tone]} transition-[stroke-dashoffset] duration-500`}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
        />
      </svg>
      <span className="absolute text-2xl font-semibold tabular-nums">{label}</span>
    </div>
  )
}
```

- [ ] **Step 4: `BreakMenu` und `LocationSelect` schreiben**

`src/renderer/src/components/BreakMenu.tsx`:

```tsx
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import type { BreakOption } from '@shared/ipc-contract'

interface Props {
  options: BreakOption[]
  disabled: boolean
  onSelect: (id: string) => void
}

export function BreakMenu({ options, disabled, onSelect }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="secondary" disabled={disabled || options.length === 0}
                aria-label="Pause starten">
          <span className="text-base leading-none">❙❙</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => onSelect(o.id)}>{o.name}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

`src/renderer/src/components/LocationSelect.tsx`:

```tsx
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@renderer/components/ui/select'

export const LOCATIONS = [
  { value: 'office', label: 'Büro' },
  { value: 'work_from_home', label: 'Homeoffice' },
  { value: 'business_trip', label: 'Dienstreise' },
] as const

interface Props {
  value: string
  disabled: boolean
  onChange: (value: string) => void
}

export function LocationSelect({ value, disabled, onChange }: Props) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="h-7 border-none bg-transparent px-1 text-xs shadow-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LOCATIONS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
```

> `work_from_home` und `business_trip` sind **geraten** — nur `office` wurde live beobachtet. Sende beim ersten Test jeden Wert einmal; lehnt die API einen ab, notiere den korrekten Enum-Wert in `docs/WINDOWS.md` unter "Offene Punkte" und korrigiere die Liste.

- [ ] **Step 5: `ActionBar` schreiben**

`src/renderer/src/components/ActionBar.tsx`:

```tsx
import { Button } from '@renderer/components/ui/button'
import { BreakMenu } from './BreakMenu'
import type { AppSnapshot } from '@shared/ipc-contract'

interface Props {
  snapshot: AppSnapshot
  busy: boolean
  onClockIn: () => void
  onClockOut: () => void
  onStartBreak: (id: string) => void
  onEndBreak: () => void
  onSignIn: () => void
}

export function ActionBar({
  snapshot, busy, onClockIn, onClockOut, onStartBreak, onEndBreak, onSignIn,
}: Props) {
  const { state, breakOptions } = snapshot

  // An expired session must offer a way out, not a dead disabled button.
  if (state.kind === 'unauthenticated') {
    return <Button size="sm" onClick={onSignIn}>Anmelden</Button>
  }
  if (state.kind === 'out') {
    return <Button size="sm" disabled={busy} onClick={onClockIn}>Einstempeln</Button>
  }
  if (state.kind === 'in') {
    return (
      <div className="flex items-center gap-2">
        <BreakMenu options={breakOptions} disabled={busy} onSelect={onStartBreak} />
        <Button size="sm" variant="secondary" disabled={busy} onClick={onClockOut}>Ausstempeln</Button>
      </div>
    )
  }
  if (state.kind === 'break') {
    return (
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={onEndBreak}>Fortsetzen</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onClockOut}>Ausstempeln</Button>
      </div>
    )
  }
  return <Button size="sm" disabled>Lädt …</Button>
}
```

- [ ] **Step 6: `StatusWidget` schreiben**

`src/renderer/src/components/StatusWidget.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { formatDuration, formatHoursMinutes } from '@shared/time'
import { useAttendance, useTicker } from '@renderer/hooks/useAttendance'
import { ProgressRing } from './ProgressRing'
import { ActionBar } from './ActionBar'
import { LocationSelect } from './LocationSelect'

const TARGET_MINUTES = 8 * 60

const LABEL = {
  unknown: 'Lädt …',
  unauthenticated: 'Nicht angemeldet',
  out: 'Ausgestempelt',
  in: 'Eingestempelt',
  break: 'In einer Pause',
} as const

const DOT = {
  unknown: 'bg-muted-foreground/40',
  unauthenticated: 'bg-destructive',
  out: 'bg-muted-foreground/40',
  in: 'bg-emerald-500',
  break: 'bg-amber-500',
} as const

export function StatusWidget() {
  const snapshot = useAttendance()
  const [busy, setBusy] = useState(false)
  const [location, setLocation] = useState('office')

  const running = snapshot.state.kind === 'in' || snapshot.state.kind === 'break'
  const tick = useTicker(running)

  useEffect(() => {
    void window.factorial.getSettings().then((s) => setLocation(s.lastLocationType))
  }, [])

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await action()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Aktion fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  const elapsedMs = running && 'since' in snapshot.state ? tick - snapshot.state.since.getTime() : 0
  const workedMinutes = snapshot.todayMinutes + (snapshot.state.kind === 'in' ? elapsedMs / 60_000 : 0)
  const remaining = Math.max(0, TARGET_MINUTES - workedMinutes)

  return (
    <div className="flex h-full flex-col justify-between rounded-xl border bg-background/95 p-4 backdrop-blur">
      <div className="flex items-start justify-between" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${DOT[snapshot.state.kind]}`} />
            <span className="text-sm font-semibold">{LABEL[snapshot.state.kind]}</span>
            {snapshot.stale && (
              <span className="text-[10px] text-muted-foreground">· keine Verbindung</span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Verbleibende Zeit {formatHoursMinutes(remaining)}
          </p>
        </div>
        <ProgressRing
          progress={workedMinutes / TARGET_MINUTES}
          label={formatDuration(elapsedMs)}
          tone={snapshot.state.kind === 'in' ? 'active' : snapshot.state.kind === 'break' ? 'paused' : 'idle'}
        />
      </div>

      <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <ActionBar
          snapshot={snapshot}
          busy={busy}
          onClockIn={() => void run(async () => {
            await window.factorial.setSettings({ lastLocationType: location })
            await window.factorial.clockIn({ locationType: location, workplaceId: null })
          })}
          onClockOut={() => void run(() => window.factorial.clockOut())}
          onStartBreak={(id) => void run(() => window.factorial.startBreak(id))}
          onEndBreak={() => void run(() => window.factorial.endBreak())}
          onSignIn={() => void run(() => window.factorial.signOut())}
        />
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <LocationSelect value={location} disabled={busy || snapshot.state.kind !== 'out'}
                          onChange={setLocation} />
          {snapshot.state.kind === 'break' && <span>{snapshot.state.breakName}</span>}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 7: `App.tsx` und `styles.css` aktualisieren**

`src/renderer/src/App.tsx`:

```tsx
import { Toaster } from '@renderer/components/ui/sonner'
import { StatusWidget } from '@renderer/components/StatusWidget'

export default function App() {
  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent">
      <StatusWidget />
      <Toaster position="bottom-center" />
    </div>
  )
}
```

Ergänze in `src/renderer/src/styles.css` nach dem Tailwind-Import:

```css
html, body, #root { height: 100%; margin: 0; background: transparent; }
body { user-select: none; -webkit-user-select: none; }
```

- [ ] **Step 8: Manuell verifizieren — alle drei Zustände**

Run: `npm run dev`

Prüfe der Reihe nach und halte jedes Ergebnis fest:
1. Ausgestempelt: Punkt grau, Button "Einstempeln", Ort-Select aktiv.
2. Einstempeln klicken → Punkt grün, Timer läuft sekündlich, Pause- und Ausstempeln-Button erscheinen.
3. Pause wählen → Punkt amber, Pausenname unten rechts, "Fortsetzen" erscheint.
4. Fortsetzen → zurück auf grün.
5. Ausstempeln → zurück auf grau.
6. Fenster mit der Maus verschieben, App beenden, neu starten → Position bleibt.

> Dieser Durchlauf erzeugt echte Einträge in der Zeiterfassung. Räume sie danach im Factorial-Web auf.

- [ ] **Step 9: Typecheck und Tests**

Run: `npm run typecheck && npm test`
Expected: beides grün.

- [ ] **Step 10: Commit**

```bash
git add src/renderer
git commit -m "feat: widget UI with status, ring timer and actions"
```

---

### Task 12: Tray

**Files:**
- Create: `src/main/tray.ts`, `resources/trayTemplate.png`, `resources/trayTemplate@2x.png`, `resources/tray.ico`
- Modify: `src/main/index.ts`
- Test: `src/main/__tests__/tray-label.test.ts`

**Interfaces:**
- Consumes: `AttendanceStore`, `toggleWidget`/`showWidget` aus `./windows`
- Produces:
  - `trayLabel(snapshot, now): string` — pure, testbar
  - `createTray(deps): Tray`

- [ ] **Step 1: Schreibe die fehlschlagenden Tests für das Label**

`src/main/__tests__/tray-label.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { trayLabel } from '../tray'
import type { AppSnapshot } from '@shared/ipc-contract'

const base: AppSnapshot = {
  state: { kind: 'out' }, todayMinutes: 0, breakOptions: [], lastError: null, stale: false,
}
const NOW = new Date(2026, 7, 12, 11, 0, 0)

describe('trayLabel', () => {
  it('is empty when clocked out, so the menubar stays uncluttered', () => {
    expect(trayLabel(base, NOW)).toBe('')
  })

  it('shows hours and minutes while clocked in', () => {
    const snapshot: AppSnapshot = { ...base, state: {
      kind: 'in', shiftId: '1', since: new Date(2026, 7, 12, 9, 30, 0),
      locationType: 'office', workplaceId: null,
    } }
    expect(trayLabel(snapshot, NOW)).toBe('1:30')
  })

  it('marks a break with a pause glyph', () => {
    const snapshot: AppSnapshot = { ...base, state: {
      kind: 'break', shiftId: '1', since: new Date(2026, 7, 12, 10, 45, 0),
      breakId: '19613', breakName: 'Mittagspause',
    } }
    expect(trayLabel(snapshot, NOW)).toBe('❙❙ 0:15')
  })

  it('is empty while the state is still unknown', () => {
    expect(trayLabel({ ...base, state: { kind: 'unknown' } }, NOW)).toBe('')
  })

  it('does not render a negative time when the clock is skewed', () => {
    const snapshot: AppSnapshot = { ...base, state: {
      kind: 'in', shiftId: '1', since: new Date(2026, 7, 12, 11, 5, 0),
      locationType: null, workplaceId: null,
    } }
    expect(trayLabel(snapshot, NOW)).toBe('0:00')
  })
})
```

- [ ] **Step 2: Tests ausführen, Fehlschlag bestätigen**

Run: `npx vitest run src/main/__tests__/tray-label.test.ts`
Expected: FAIL.

- [ ] **Step 3: Tray-Icons erzeugen**

Erzeuge ein schlichtes Uhr-Glyph-Icon:
- `resources/trayTemplate.png` — 16×16, schwarz auf transparent
- `resources/trayTemplate@2x.png` — 32×32, schwarz auf transparent
- `resources/tray.ico` — enthält 16/32/48 px

Die `Template`-Namensendung ist für macOS bedeutsam: Electron färbt solche Icons automatisch passend zu Hell-/Dunkelmodus. Der Alpha-Kanal trägt die Form, die Farbe wird ignoriert.

Verifiziere die Größen: `file resources/trayTemplate*.png`

- [ ] **Step 4: `src/main/tray.ts` schreiben**

```ts
import { Menu, Tray, app, nativeImage } from 'electron'
import { join } from 'node:path'
import type { AppSnapshot } from '@shared/ipc-contract'
import type { AttendanceStore } from './attendance'
import { showWidget, toggleWidget } from './windows'

/** Compact running time for the menubar: "1:30", or "❙❙ 0:15" during a break. */
export function trayLabel(snapshot: AppSnapshot, now: Date): string {
  const { state } = snapshot
  if (state.kind !== 'in' && state.kind !== 'break') return ''
  const ms = Math.max(0, now.getTime() - state.since.getTime())
  const total = Math.floor(ms / 60_000)
  const text = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  return state.kind === 'break' ? `❙❙ ${text}` : text
}

function iconPath(): string {
  const dir = join(import.meta.dirname, '../../resources')
  // PLATFORM: macOS uses a monochrome template PNG that adapts to light/dark.
  // Windows needs a coloured .ico with multiple sizes for DPI scaling.
  return process.platform === 'darwin' ? join(dir, 'trayTemplate.png') : join(dir, 'tray.ico')
}

export function createTray(deps: { store: AttendanceStore; onQuit: () => void }): Tray {
  const image = nativeImage.createFromPath(iconPath())
  // PLATFORM: template images are a macOS concept; harmless elsewhere.
  if (process.platform === 'darwin') image.setTemplateImage(true)

  const tray = new Tray(image)

  function render(): void {
    const snapshot = deps.store.getSnapshot()
    const label = trayLabel(snapshot, new Date())
    const { state } = snapshot
    const busy = state.kind === 'in' || state.kind === 'break'

    // PLATFORM: setTitle is macOS-only — there is no menubar text on Windows.
    // Windows falls back to the tooltip plus the disabled first menu entry.
    if (process.platform === 'darwin') {
      tray.setTitle(label ? ` ${label}` : '')
    }
    tray.setToolTip(label ? `Factorial · ${label}` : 'Factorial · ausgestempelt')

    const template: Electron.MenuItemConstructorOptions[] = [
      // PLATFORM: on Windows this line carries the running time, since the
      // menubar cannot show it.
      { label: label ? `Erfasst: ${label}` : 'Ausgestempelt', enabled: false },
      { type: 'separator' },
    ]

    if (state.kind === 'out') {
      template.push({ label: 'Einstempeln', click: () => { void deps.store.clockIn({ locationType: 'office', workplaceId: null }) } })
    }
    if (state.kind === 'in') {
      template.push({
        label: 'Pause',
        submenu: snapshot.breakOptions.map((o) => ({
          label: o.name,
          click: () => { void deps.store.startBreak(o.id) },
        })),
      })
    }
    if (state.kind === 'break') {
      template.push({ label: 'Fortsetzen', click: () => { void deps.store.endBreak() } })
    }
    if (busy) {
      template.push({ label: 'Ausstempeln', click: () => { void deps.store.clockOut() } })
    }

    template.push(
      { type: 'separator' },
      { label: 'Fenster zeigen', click: () => showWidget() },
      { label: 'Aktualisieren', click: () => { void deps.store.refresh() } },
      { type: 'separator' },
      { label: 'Beenden', click: deps.onQuit },
    )

    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  render()
  deps.store.subscribe(render)
  // The label counts minutes, so a 15-second cadence is enough.
  setInterval(render, 15_000)

  // PLATFORM: on Windows a left click should toggle the window; on macOS the
  // click opens the context menu, which is the platform convention.
  if (process.platform !== 'darwin') {
    tray.on('click', () => toggleWidget())
  }

  app.on('before-quit', () => tray.destroy())
  return tray
}
```

- [ ] **Step 5: Tests ausführen, Erfolg bestätigen**

Run: `npx vitest run src/main/__tests__/tray-label.test.ts`
Expected: PASS, 5 Tests.

- [ ] **Step 6: `src/main/index.ts` vollständig verdrahten**

```ts
import { app, powerMonitor } from 'electron'
import { join } from 'node:path'
import { createClient } from './factorial/client'
import { createOperations } from './factorial/operations'
import { createNetFetch, clearSession, getFactorialSession } from './session'
import { ensureAuthenticated, openLoginWindow } from './auth'
import { createAttendanceStore } from './attendance'
import { createSettings } from './settings'
import { createWidgetWindow, getWidget, showWidget } from './windows'
import { createTray } from './tray'
import { registerIpc } from './ipc'

// PLATFORM: Windows launches a second process per invocation without this lock.
if (!app.requestSingleInstanceLock()) app.quit()

app.on('second-instance', () => showWidget())

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData')
  const settings = createSettings({
    filePath: join(userData, 'settings.json'),
    applyLoginItem: (openAtLogin) => {
      // PLATFORM: macOS registers a login item; Windows writes a Run registry
      // key and needs the executable path explicitly when packaged.
      app.setLoginItemSettings({ openAtLogin, path: app.getPath('exe') })
    },
  })
  app.setLoginItemSettings({ openAtLogin: settings.get().openAtLogin, path: app.getPath('exe') })

  const ops = createOperations(createClient(createNetFetch(getFactorialSession())))
  const identity = await ensureAuthenticated(ops)

  const store = createAttendanceStore({ ops, employeeId: identity.employeeId })

  registerIpc({
    store,
    settings,
    onSignOut: async () => {
      await clearSession()
      openLoginWindow()
    },
  })

  createWidgetWindow({
    positionFile: join(userData, 'window-position.json'),
    alwaysOnTop: settings.get().alwaysOnTop,
  })
  createTray({
    store,
    onQuit: () => {
      ;(globalThis as { __quitting?: boolean }).__quitting = true
      app.quit()
    },
  })

  await store.refresh()
  store.startPolling()

  // After standby the elapsed time is stale; recompute against the server.
  powerMonitor.on('resume', () => { void store.refresh() })
  getWidget()?.on('focus', () => { void store.refresh() })
}

void app.whenReady().then(bootstrap)

// PLATFORM: macOS keeps a tray app alive with no windows; the widget only hides.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { /* stay alive: this is a tray app */ }
})
```

- [ ] **Step 7: Manuell verifizieren — Tray**

Run: `npm run dev`

Prüfe und halte fest:
1. Tray-Icon erscheint in der Menubar.
2. Einstempeln → nach spätestens 15 s zeigt die Menubar die laufende Zeit.
3. Rechtsklick → Menü enthält Pause-Untermenü mit den echten Pausennamen.
4. Aus dem Tray-Menü ein-/ausstempeln, ohne das Fenster zu öffnen → Widget zeigt die Änderung.
5. Fenster schließen → App läuft weiter, Tray bleibt.
6. "Beenden" → App endet wirklich.

- [ ] **Step 8: Commit**

```bash
git add src/main/tray.ts src/main/index.ts src/main/__tests__/tray-label.test.ts resources
git commit -m "feat: tray with live timer, quick actions and platform fallbacks"
```

---

### Task 13: Soll-Zeit ermitteln

Der Fortschrittsring nutzt bis hierher ein hart kodiertes Tagesziel von 8 Stunden. Dieser Task ersetzt das durch den echten Wert — oder belegt, dass es ihn nicht gibt.

**Files:**
- Create: `docs/api-discovery.md`
- Modify: `src/main/factorial/operations.ts`, `src/main/attendance.ts`, `src/shared/ipc-contract.ts`, `src/renderer/src/components/StatusWidget.tsx`
- Test: `src/main/factorial/__tests__/operations.test.ts` (erweitern)

- [ ] **Step 1: Schema nach Kandidaten durchsuchen**

Starte die App im Dev-Modus, öffne die DevTools des Login-Fensters (dort läuft die Factorial-Seite) und setze folgende Introspection ab:

```js
const q = async (query) => (await (await fetch('https://api.factorialhr.com/graphql?X', {
  method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ operationName: 'X', variables: {}, query }),
})).json())

const j = await q('query X { __type(name: "attendance") { fields { name } } }')
j.data.__type.fields.map(f => f.name).filter(n => /expected|target|schedule|planned|contract|balance/i.test(n))
```

- [ ] **Step 2: Falls kein Feld passt, den Web-Client mitschneiden**

Öffne `https://app.factorialhr.com/dashboard`, injiziere den Interceptor (siehe `docs/api-discovery.md`, in Schritt 4 dieses Tasks angelegt) und lade das Dashboard neu. Suche in den erfassten Requests nach `ClockInWidget` und inspiziere dessen Response auf ein Soll-Zeit-Feld.

- [ ] **Step 3: Ergebnis umsetzen**

**Fall A — ein Feld existiert.** Ergänze in `operations.ts`:

```ts
async fetchExpectedMinutes(employeeId: number, date: string): Promise<number | null> {
  // Fill in the verified query. Return null when the API has no value for the day.
}
```

Ergänze `expectedMinutes: number | null` in `Snapshot` (`attendance.ts`), in `AppSnapshot` und `SerialisedSnapshot` (`ipc-contract.ts`), lade es in `refresh()`, und ersetze in `StatusWidget.tsx` die Konstante:

```tsx
const target = snapshot.expectedMinutes ?? 8 * 60
```

Schreibe je einen Test für „Wert vorhanden" und „Wert ist null" analog zu den bestehenden Operations-Tests.

**Fall B — kein Feld auffindbar.** Entferne die Anzeige "Verbleibende Zeit" aus `StatusWidget.tsx` und lass den Ring die reine Ist-Zeit gegen 8 Stunden zeigen, mit einem Kommentar, dass das Ziel nicht aus der API stammt. Trage das unter "Offene Punkte" in `docs/WINDOWS.md` ein.

- [ ] **Step 4: `docs/api-discovery.md` schreiben**

Dokumentiere die Methode reproduzierbar:

```markdown
# Factorial-API erforschen

## Warum ein Content-Script nicht reicht

`javascript_tool` und Browser-Erweiterungen laufen in einer **isolierten Welt**.
Ein dort gesetzter Patch auf `window.fetch` hat auf die Requests der Seite
keinerlei Wirkung — der Puffer bleibt leer, und man hält das fälschlich für
"die Seite benutzt fetch nicht".

## Was funktioniert

Ein `<script>`-Element in die Seite injizieren; dessen Code läuft im
Main-World der Seite. Der Rückkanal geht über ein verstecktes DOM-Element,
weil die isolierte Welt keine Variablen der Seite lesen kann.

[Den vollständigen Interceptor-Code hier einfügen — siehe Task 13, Schritt 2.]

## Introspection

Das Schema ist offen. Nützliche Einstiege:
- Root-Felder: `query { __schema { queryType { fields { name } } } }`
- Ein Typ:     `query { __type(name: "attendance") { fields { name } } }`

## Bekannte Typ-Fallen
- `attendance.employee(id:)` verlangt **Int!**, die Mutations nehmen **ID** (String).
- Pausentypen nur über `timeSettings`, nicht über `attendance`.
```

- [ ] **Step 5: Tests und Typecheck**

Run: `npm run typecheck && npm test`
Expected: beides grün.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: resolve the daily target from the API (or document its absence)"
```

---

### Task 14: Packaging

**Files:**
- Create: `electron-builder.yml`, `build/icon.icns`, `build/icon.ico`
- Modify: `package.json`

- [ ] **Step 1: `electron-builder.yml` schreiben**

```yaml
appId: com.maxgiess.factorial-desktop
productName: Factorial
directories:
  output: release
  buildResources: build
files:
  - out/**/*
  - resources/**/*
  - package.json

mac:
  category: public.app-category.productivity
  target:
    - target: dmg
      arch: [arm64]
    - target: zip
      arch: [arm64]
  # No signing identity: the app is unsigned by choice for now.
  identity: null
  # LSUIElement hides the dock icon — this is a menubar app.
  extendInfo:
    LSUIElement: 1

# PLATFORM: never verified. Icon sizes, NSIS behaviour and the Run-key autostart
# all need checking on a real Windows machine.
win:
  target:
    - target: nsis
      arch: [x64]
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
```

- [ ] **Step 2: App-Icons anlegen**

- `build/icon.icns` — macOS, 1024×1024 als Quelle
- `build/icon.ico` — Windows, 256×256 enthalten

- [ ] **Step 3: macOS-Build erzeugen**

Run: `npm run package:mac`
Expected: `release/Factorial-0.1.0-arm64.dmg` entsteht.

- [ ] **Step 4: Gepackte App verifizieren**

DMG öffnen, App nach `/Applications` ziehen, per **Rechtsklick → Öffnen** starten (unsigniert, deshalb nicht per Doppelklick).

Prüfe und halte fest:
1. App startet, kein Dock-Icon, nur Tray.
2. Anmeldung besteht weiterhin (oder Login-Fenster erscheint).
3. Ein- und Ausstempeln funktioniert aus der gepackten App.
4. Autostart-Eintrag ist gesetzt: `Systemeinstellungen → Allgemein → Anmeldeobjekte`.

- [ ] **Step 5: Windows-Build nur konfigurieren, nicht behaupten**

Führe `npm run package:win` **nicht** aus und behaupte nicht, es funktioniere. Vermerke in `docs/WINDOWS.md`, dass die Konfiguration existiert, aber nie ausgeführt wurde.

- [ ] **Step 6: Commit**

```bash
git add electron-builder.yml build package.json
git commit -m "build: electron-builder config for macOS (Windows configured, unverified)"
```

---

### Task 15: Windows-Übergabe schreiben

Der abschließende Deliverable. Ein Agent auf einer Windows-Maschine bekommt **keinen** Gesprächsverlauf — alles muss hier stehen.

**Files:**
- Create: `docs/WINDOWS.md`, `README.md`

- [ ] **Step 1: Alle Plattform-Stellen einsammeln**

Run: `grep -rn "// PLATFORM:" src/`
Erwartet: mindestens die Stellen aus `index.ts`, `windows.ts`, `tray.ts`. Jede muss in die Tabelle in Schritt 3.

Fehlt eine Verzweigung nach `process.platform` in dieser Ausgabe, ergänze zuerst den Kommentar im Code.

- [ ] **Step 2: `README.md` schreiben**

```markdown
# Factorial Desktop

Floating-Widget mit Tray für die Zeiterfassung in Factorial HR.
Ein-/Ausstempeln und Pausen, ohne den Browser zu öffnen.

## Start

    npm install
    npm run dev

Beim ersten Start öffnet sich Factorials eigenes Login. Danach bleibt die
Sitzung in einer persistenten Electron-Session-Partition erhalten.

## Befehle

| Befehl | Zweck |
|---|---|
| `npm run dev` | Entwicklungsmodus |
| `npm test` | Unit-Tests |
| `npm run typecheck` | TypeScript prüfen |
| `npm run package:mac` | macOS-Build (unsigniert) |
| `npm run package:win` | Windows-Build (nie ausgeführt) |

## Dokumente

- `docs/superpowers/specs/2026-08-12-factorial-desktop-design.md` — Design und vollständige API-Referenz
- `docs/WINDOWS.md` — Übergabe für die Windows-Portierung
- `docs/api-discovery.md` — wie die API erforscht wurde
```

- [ ] **Step 3: `docs/WINDOWS.md` schreiben**

Struktur mit den tatsächlich beim Bauen gefundenen Inhalten füllen:

```markdown
# Windows-Übergabe

Diese App wurde ausschließlich auf macOS gebaut und verifiziert. Der
Windows-Code ist mitgeschrieben, aber **nie ausgeführt worden**. Dieses Dokument
enthält alles, was du brauchst, ohne den ursprünglichen Gesprächsverlauf.

## Erst lesen

1. `docs/superpowers/specs/2026-08-12-factorial-desktop-design.md` — Architektur und die
   vollständige, verifizierte Factorial-API inklusive der Zeitstempel-Falle.
2. `docs/api-discovery.md` — wie du fehlende Queries selbst findest.
3. Dieses Dokument.

## Was verifiziert ist

[Liste der auf macOS tatsächlich ausgeführten und bestandenen Prüfungen —
Task für Task, mit dem konkreten Ergebnis.]

## Was nur kompiliert, aber nie gelaufen ist

[Jeder Windows-Zweig, jede geratene Enum-Konstante, der Windows-Build.]

## Plattformabhängige Stellen

| Datei:Zeile | Was | Warum | Auf Windows zu prüfen |
|---|---|---|---|
| [aus `grep -rn "// PLATFORM:" src/` befüllen] | | | |

## Die bekannten Windows-Themen

### Tray-Titel
`tray.setTitle()` gibt es nur auf macOS. Der Fallback in `src/main/tray.ts`
ist Tooltip plus deaktivierter erster Menüeintrag. Prüfen, ob das reicht oder
ob ein Icon-Overlay besser ist.

### Tray-Icon
macOS nutzt `trayTemplate.png` / `@2x` monochrom mit `setTemplateImage(true)`.
Windows braucht `resources/tray.ico` mit 16/32/48 px. Bei 150 % und 200 %
Skalierung auf Unschärfe prüfen.

### Transparentes, rahmenloses Fenster
`transparent: true` verhält sich auf Windows anders: eckiger Schatten, andere
Ecken-Behandlung, Resize-Ränder. Siehe `createWidgetWindow` in
`src/main/windows.ts`.

### Always-on-Top
`setVisibleOnAllWorkspaces` ist macOS-spezifisch und wird auf Windows
übersprungen. Prüfen, ob das Widget über maximierten Fenstern bleibt.

### Autostart
`app.setLoginItemSettings({ openAtLogin, path: app.getPath('exe') })` schreibt
auf Windows einen Run-Registry-Key. Im gepackten NSIS-Zustand prüfen, ob der
Pfad stimmt und ob die App minimiert in den Tray startet.

### Single-Instance
`app.requestSingleInstanceLock()` ist auf Windows zwingend, sonst startet die
App bei jedem Aufruf erneut. Der `second-instance`-Handler zeigt das Widget.

### Fensterposition bei gemischtem DPI
`clampToVisibleArea` in `src/main/windows.ts` ist reine Logik und getestet, aber
nur gegen synthetische Bounds. Mit zwei Monitoren unterschiedlicher Skalierung
gegenprüfen.

### Schließen-Verhalten
Aktuell blendet das X nur aus; beendet wird über das Tray. Auf Windows erwarten
Nutzer eher, dass X beendet. Bewusst entscheiden.

### Packaging
`electron-builder.yml` hat ein NSIS-Target, das **nie gebaut wurde**.
`npm run package:win` als Erstes ausprobieren.

## Offene Punkte

[Alles, was beim Bauen auffiel und auf macOS nicht entschieden werden konnte —
insbesondere die geratenen `locationType`-Werte `work_from_home` und
`business_trip`, von denen nur `office` live bestätigt ist, sowie das Ergebnis
der Soll-Zeit-Recherche aus Task 13.]
```

- [ ] **Step 4: Vollständigkeit prüfen**

Gehe die Checkliste durch:
- Jede Zeile aus `grep -rn "// PLATFORM:" src/` steht in der Tabelle.
- Jede geratene Konstante steht unter "Offene Punkte".
- Die Abschnitte "verifiziert" und "nur kompiliert" widersprechen sich nicht.
- Keine Erfolgsbehauptung ohne durchgeführte Prüfung.

- [ ] **Step 5: Commit**

```bash
git add docs/WINDOWS.md README.md
git commit -m "docs: Windows handoff and project README"
```
