# Factorial Desktop

![The widget on the desktop: clocked in since 8:43:11, target met with +0:43, Pause and Clock out below](docs/images/header.png)

A small floating widget and a tray icon for tracking time in Factorial HR. Clock
in, take a break, resume, clock out — without opening the browser.

The card sits on top of whatever you are working on and shows the day at a
glance: how long you have worked, how much is left, and where the breaks were.
Click it to open the full card, click again to collapse it.

## Download

Grab the latest build from the [releases page](https://github.com/MaxLikesCode/factorial-desktop/releases/latest).

| Platform | File | Notes |
|---|---|---|
| **Windows** | `Factorial-Desktop-Setup-<version>.exe` | Installs for your user only — no admin rights needed. Adds a Start-menu entry and can start with Windows. This is the one to pick. |
| **Windows** | `Factorial-Desktop.exe` | Runs from anywhere without installing. Handy for a USB stick or a locked-down machine. |
| **macOS** | `Factorial-Desktop-<version>-arm64.dmg` | Apple Silicon. |

The builds are not code-signed, so the first launch needs one extra step:

- **Windows:** SmartScreen shows a blue box. Click *More info* → *Run anyway*.
- **macOS:** right-click the app → *Open*, then confirm. A double-click alone
  gets refused by Gatekeeper.

## Using it

**Signing in.** The first launch opens Factorial's own login page in a window —
the app never sees your password, and two-factor works exactly as it does in the
browser. The session is kept, so the next launch goes straight to the widget.

**The tray icon is where the app lives.** It has no taskbar button and no dock
icon on purpose: closing the widget only hides it. The icon's colour is the
state at a glance — grey clocked out, green clocked in, amber on a break — and
hovering shows the running time without opening anything.

> **Windows tip:** new tray icons are hidden behind the `^` chevron by default.
> Drag it onto the taskbar once and it stays there.

**The tray menu** is the way to everything: clock in and out, pick a break type,
show or hide the widget, and *Einstellungen* for start-with-system, always-on-top,
which way the card opens, light or dark, and checking for updates.

**Updates.** The installed build checks for a new version half a minute after
launch and every six hours after that, and always asks before downloading
anything. If a shift is running it will not restart — the update is applied the
next time you quit. The portable build cannot replace itself, so it points at the
download page instead.

**One thing worth knowing:** this writes to your real timesheet. The app never
guesses a time — when it loses contact with Factorial it shows the last known
state and says so, rather than inventing something that looks plausible.

The interface is in German, matching Factorial's own.

## Development

Node 22 or newer.

```
npm install
npm run dev
```

| Command | Purpose |
|---|---|
| `npm run dev` | Dev mode with hot reload (electron-vite) |
| `npm test` | Unit tests (Vitest, no Electron runtime needed) |
| `npm run test:watch` | The same tests, watching |
| `npm run typecheck` | TypeScript across main, preload, shared and renderer |
| `npm run build` | Typecheck, then build to `out/` |
| `npm run package:mac` | macOS: DMG + ZIP, arm64 |
| `npm run package:win` | Windows: NSIS installer + portable exe, x64 |

Both `package:` scripts run `npm run build` first, so a type error stops them
before electron-builder starts. Artefacts land in `release/`, which is ignored.

**Architecture in one paragraph.** The main process owns the truth: it talks to
Factorial's GraphQL API, keeps one attendance store, and pushes snapshots to the
renderer over a ten-function `contextBridge`. The renderer draws and never
decides — it has no Node, no `require`, and no way to reach the network. The
pieces that can be tested without Electron are deliberately kept free of it and
are, which is why the suite runs anywhere.

**Tests.** 521 of them, no Electron runtime required. They cover the time
reconstruction, the store's optimistic updates and rollbacks, the IPC codec, the
widget's five states, and the platform-dependent decisions — the last of those
take their inputs as arguments precisely so that, say, the Windows autostart path
can be checked from a Mac.

**CI.** `.github/workflows/build.yml` runs tests and typecheck on every push and
pull request. Tagging `v*` builds both platforms and attaches the files to a
GitHub release; macOS runners are billed at ten times the Linux rate, so the
builds do not run on every push.

**Releasing.** Bump `version` in `package.json`, commit, then tag:

```
git tag -a v0.1.2 -m "..."
git push origin v0.1.2
```

The release must keep `latest.yml` among its assets — that file is the feed the
installed app reads to notice a new version.

## Documentation

- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture and the full API reference,
  verified against the live API. Where anything disagrees, this wins.
- [`docs/api-discovery.md`](docs/api-discovery.md) — how the Factorial API was
  mapped out, and how to find a query nobody has needed yet.
