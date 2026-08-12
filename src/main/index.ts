/**
 * App lifecycle and wiring. At this point in the build it does three things:
 * claim the single-instance lock, authenticate, and show the (still empty)
 * widget window. The attendance store, IPC and tray plug in here later.
 */

import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { ensureAuthenticated } from './auth'
import { createClient } from './factorial/client'
import { createOperations } from './factorial/operations'
import { createNetFetch, getFactorialSession } from './session'

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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function bootstrap(): Promise<void> {
  const ops = createOperations(createClient(createNetFetch(getFactorialSession())))

  try {
    const identity = await ensureAuthenticated(ops)
    console.log('[auth] signed in as', identity.fullName, '/', identity.companyName)
  } catch (error) {
    // Nothing this app does works without a session, and it has no offline mode
    // by design. Say so and stop, rather than opening a window that can only
    // show wrong data.
    dialog.showErrorBox('Factorial Desktop', `Anmeldung nicht möglich: ${describeError(error)}`)
    app.quit()
    return
  }

  createWindow()
}

// PLATFORM: Windows starts a whole second app on every launch without this lock;
// macOS reuses the running instance by itself. Harmless on macOS, required there.
if (app.requestSingleInstanceLock()) {
  // PLATFORM: the Windows counterpart of the lock — the second launch hands over
  // here and expects the running instance to come to the front.
  app.on('second-instance', () => {
    const existing = BrowserWindow.getAllWindows()[0]
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  void app.whenReady().then(bootstrap)
} else {
  app.quit()
}

// PLATFORM: macOS keeps an app alive with no windows open; every other platform
// expects the last window to end it.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
