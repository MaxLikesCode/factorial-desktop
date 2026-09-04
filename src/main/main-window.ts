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

import { BrowserWindow, app, webContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, MAIN_WINDOW_PAGES, type MainWindowPage, type WindowControl } from '@shared/ipc-contract'

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
    // The page draws the window: its rounded corners, border and shadow. The
    // extra 2 x FRAME_MARGIN is the transparent room the shadow needs.
    width: 980 + 2 * FRAME_MARGIN,
    height: 680 + 2 * FRAME_MARGIN,
    // One size. The frame is drawn by the page, so there is no edge to grab
    // anyway, and a fixed window has no maximised state to draw differently.
    resizable: false,
    maximizable: false,
    show: false,
    title: 'Factorial Desktop',
    // Frameless and transparent, like the widget: the platform's own corner
    // radius cannot be changed, so the window is drawn by the page — a
    // larger radius, at the price of Aero Snap and edge resizing. The
    // controls are the page's own too (`controlWindow`).
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
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

/** The transparent margin around the drawn window, in DIP: room for its shadow. */
export const FRAME_MARGIN = 32

/** The page's own window buttons. Acts on the window that asked. */
export function controlMainWindow(action: WindowControl, senderId?: number): void {
  const sender = senderId === undefined ? null : webContents.fromId(senderId)
  const target = (sender ? BrowserWindow.fromWebContents(sender) : null) ?? getMainWindow()
  if (target === null || target.isDestroyed()) return
  if (action === 'minimize') target.minimize()
  else if (action === 'close') target.close()
}
