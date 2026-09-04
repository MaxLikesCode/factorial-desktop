/**
 * The app window: overview, timesheet and settings, in one ordinary window.
 *
 * Ordinary is the point. The widget (`windows.ts`) is a frameless,
 * transparent, always-on-top card with a hand-rolled drag; this one has a
 * frame, a title bar with the platform's own controls, a taskbar entry and a
 * remembered size, because it is a window somebody opens to do something and
 * closes again. It shares the widget's preload and bridge: the same
 * snapshot, the same settings, the same actions — plus the timesheet.
 *
 * One instance. `showMainWindow` opens it or brings it forward, and can ask
 * the page to switch to a section. Closing it closes it; the tray and the
 * widget stay, so this is never the app's last window.
 */

import { BrowserWindow, app, nativeTheme } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, MAIN_WINDOW_PAGES, type MainWindowPage } from '@shared/ipc-contract'

let win: BrowserWindow | null = null
/** The section asked for before the page had loaded, delivered on `did-finish-load`. */
let pendingPage: MainWindowPage | null = null

export function getMainWindow(): BrowserWindow | null {
  return win !== null && !win.isDestroyed() ? win : null
}

/** Closes the window if it is open — signing out takes the settings away. */
export function closeMainWindow(): void {
  const existing = getMainWindow()
  if (existing !== null) existing.close()
}

export function showMainWindow(page: MainWindowPage | null = null): void {
  const existing = getMainWindow()
  if (existing !== null) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    if (page !== null) existing.webContents.send(IPC.navigate, page)
    return
  }

  pendingPage = page
  const created = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Factorial Desktop',
    // The sidebar is the title bar: the platform draws only its own controls
    // over the page, which is what lets the sidebar run to the very top.
    // PLATFORM: on Windows `titleBarOverlay` draws minimise/maximise/close in
    // the top-right; on macOS the traffic lights sit top-left. Both tinted to
    // match the page so they do not float on a white strip.
    titleBarStyle: 'hidden',
    // The overlay sits over the content column's title strip, so it is tinted
    // to that strip (`--app-surface-a` in app.css), not to the sidebar — a
    // block of a different grey behind the three buttons reads as a widget
    // stuck onto the window.
    titleBarOverlay: {
      color: nativeTheme.shouldUseDarkColors ? '#1c1d21' : '#fbfaf8',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#e5e5e5' : '#2a2a2e',
      height: 56,
    },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#131318' : '#f3f2ef',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Same reason as in `windows.ts`: the preload is ESM.
      sandbox: false,
    },
  })
  win = created
  created.setMenuBarVisibility(false)

  created.once('ready-to-show', () => {
    if (created.isDestroyed()) return
    created.show()
    created.moveTop()
  })
  created.webContents.on('did-finish-load', () => {
    if (pendingPage !== null && !created.isDestroyed()) {
      created.webContents.send(IPC.navigate, pendingPage)
    }
    pendingPage = null
  })
  created.on('closed', () => {
    if (win === created) win = null
  })

  // The theme can change while the window is open; the overlay does not
  // follow `prefers-color-scheme` by itself the way the page does.
  const retint = (): void => {
    if (created.isDestroyed()) return
    const dark = nativeTheme.shouldUseDarkColors
    created.setTitleBarOverlay?.({
      color: dark ? '#1c1d21' : '#fbfaf8',
      symbolColor: dark ? '#e5e5e5' : '#2a2a2e',
      height: 56,
    })
    created.setBackgroundColor(dark ? '#131318' : '#f3f2ef')
  }
  nativeTheme.on('updated', retint)
  created.on('closed', () => nativeTheme.removeListener('updated', retint))

  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (!app.isPackaged) {
    // Development only: the page's console errors in the terminal, and a
    // screenshot of each section into FACTORIAL_SCREENSHOT_DIR a moment
    // after it has loaded — the way this window is looked at from a script.
    created.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') {
        console.log(`[app-window] ${event.level}: ${event.message}`)
      }
    })
    const dir = process.env.FACTORIAL_SCREENSHOT_DIR
    if (dir) {
      // A covered window stops painting, and `capturePage` then hands back
      // the frame it last had — three identical pictures of the first section.
      created.webContents.setBackgroundThrottling(false)
      created.webContents.once('did-finish-load', () => {
        void (async () => {
          for (const section of MAIN_WINDOW_PAGES) {
            if (created.isDestroyed()) return
            created.webContents.send(IPC.navigate, section)
            await new Promise((resolve) => setTimeout(resolve, 2500))
            const image = await created.webContents.capturePage()
            const file = join(dir, `${section}.png`)
            writeFileSync(file, image.toPNG())
            console.log(`[app-window] screenshot written to ${file}`)
          }
        })()
      })
    }
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void created.loadURL(`${process.env.ELECTRON_RENDERER_URL}/app.html`)
  } else {
    void created.loadFile(join(import.meta.dirname, '../renderer/app.html'))
  }
}
