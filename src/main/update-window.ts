/**
 * The window that offers an update, shows it downloading, and offers the
 * restart — the Electron half of `src/shared/update-window.ts`.
 *
 * It holds one view at a time and knows nothing about updates: `updater.ts`
 * tells it what to show and gets every button press back through the handler
 * it registered. This split is what keeps the updater's state machine in one
 * file and lets this one be about windows only.
 *
 * One window, ever. A second offer while the first is open replaces its view
 * rather than opening a second window — two dialogs about the same release
 * would be a bug in any state.
 */

import { BrowserWindow, ipcMain, nativeTheme, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import {
  UPDATE_IPC,
  asUpdateWindowAction,
  updateWindowSizeFor,
  type UpdateWindowAction,
  type UpdateWindowView,
} from '@shared/update-window'

let win: BrowserWindow | null = null
let view: UpdateWindowView | null = null
let handler: ((action: UpdateWindowAction) => void) | null = null
let ipcInstalled = false
/** Set while `closeUpdateWindow` runs, so the `close` event lets it through. */
let closingFromCode = false

function isOpen(): boolean {
  return win !== null && !win.isDestroyed()
}

/** Only the update window itself may speak on these channels. */
function isOurs(sender: WebContents): boolean {
  return isOpen() && sender === win?.webContents
}

/**
 * Registers the three channels once. Idempotent, and called from the updater
 * rather than from `index.ts`, so that a future second caller cannot register
 * them twice — `ipcMain.handle` throws on a duplicate.
 */
export function installUpdateWindowIpc(): void {
  if (ipcInstalled) return
  ipcInstalled = true

  ipcMain.handle(UPDATE_IPC.getView, (event) => (isOurs(event.sender) ? view : null))

  ipcMain.handle(UPDATE_IPC.respond, (event, payload: unknown) => {
    if (!isOurs(event.sender)) return
    const action = asUpdateWindowAction(payload)
    if (action !== null) handler?.(action)
  })

  // Release notes link to GitHub. `http(s)` only — a `file:` or custom scheme
  // handed to the shell is a way to run things, not to read them.
  ipcMain.handle(UPDATE_IPC.openExternal, async (event, url: unknown) => {
    if (!isOurs(event.sender)) return
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    await shell.openExternal(url)
  })
}

/**
 * Shows `next`, opening the window if there is none. `onAction` replaces any
 * earlier handler: the updater that showed the latest view is the one that
 * should hear about the button.
 */
export function showUpdateWindow(
  next: UpdateWindowView,
  onAction: (action: UpdateWindowAction) => void,
): void {
  handler = onAction
  if (isOpen()) {
    pushUpdateView(next)
    win?.show()
    win?.focus()
    return
  }
  view = next

  const created = new BrowserWindow({
    ...updateWindowSizeFor(next.state.kind),
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Factorial Desktop',
    // What shows before the page paints — matched to the page's own
    // background so the window does not flash white in the dark theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#252525' : '#ffffff',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/update.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Same reason as in `windows.ts`: the preload is ESM, which a sandboxed
      // renderer refuses to load.
      sandbox: false,
    },
  })
  win = created
  created.setMenuBarVisibility(false)
  created.center()

  created.once('ready-to-show', () => {
    if (!created.isDestroyed()) created.show()
  })

  // The platform's close — Alt+F4, the red button — lands on the same handler
  // as the page's own X, so that closing means the same thing whichever way it
  // is done. The updater then closes for real through `closeUpdateWindow`.
  created.on('close', (event) => {
    if (closingFromCode) return
    event.preventDefault()
    handler?.({ kind: 'close' })
  })
  created.on('closed', () => {
    if (win === created) {
      win = null
      view = null
    }
  })

  // The page renders HTML from a release feed. Whatever slips past the
  // sanitiser must not be able to take the window anywhere.
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void created.loadURL(`${process.env.ELECTRON_RENDERER_URL}/update.html`)
  } else {
    void created.loadFile(join(import.meta.dirname, '../renderer/update.html'))
  }
}

/**
 * Replaces the view in an open window. Returns false when there is none —
 * progress for a download nobody is watching goes nowhere, and the caller
 * decides whether that is fine.
 */
export function pushUpdateView(next: UpdateWindowView): boolean {
  const previous = view
  view = next
  if (!isOpen() || win === null) return false
  if (previous === null || previous.state.kind !== next.state.kind) {
    const size = updateWindowSizeFor(next.state.kind)
    const [width, height] = win.getSize()
    if (width !== size.width || height !== size.height) {
      win.setSize(size.width, size.height)
      win.center()
    }
  }
  win.webContents.send(UPDATE_IPC.viewChanged, next)
  return true
}

export function isUpdateWindowOpen(): boolean {
  return isOpen()
}

export function closeUpdateWindow(): void {
  if (!isOpen() || win === null) return
  closingFromCode = true
  try {
    win.close()
  } finally {
    closingFromCode = false
  }
  win = null
  view = null
}
