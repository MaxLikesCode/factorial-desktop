/**
 * App lifecycle and wiring. At this point in the build it claims the
 * single-instance lock, authenticates, builds the attendance store, loads the
 * persisted settings, registers the IPC contract and shows the widget window.
 * The widget's own module and the tray plug in here in tasks 10 and 12.
 */

import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { createAttendanceStore } from './attendance'
import { ensureAuthenticated, openLoginWindow } from './auth'
import { createClient } from './factorial/client'
import { createOperations } from './factorial/operations'
import { registerIpc } from './ipc'
import { clearSession, createNetFetch, getFactorialSession } from './session'
import { buildLoginItemSettings, createSettings } from './settings'

function createWindow(alwaysOnTop: boolean): void {
  const win = new BrowserWindow({
    width: 340,
    height: 220,
    show: false,
    // Only the value at startup. Toggling it while the app runs needs the window
    // handle the settings store does not have; that wiring belongs to Task 10.
    alwaysOnTop,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // electron-vite emits an ESM preload (`.mjs`, because package.json says
      // "type": "module"), and Electron refuses to load one into a sandboxed
      // renderer. The preload still gets nothing but `contextBridge` and
      // `ipcRenderer`; the renderer itself keeps context isolation and no Node.
      sandbox: false,
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

/**
 * Tells the OS whether to launch this app at login. The decision of *what* to
 * pass is in `buildLoginItemSettings`, which is pure and covers both platforms;
 * this is the one line that actually touches Electron.
 */
function applyLoginItem(openAtLogin: boolean): void {
  app.setLoginItemSettings(
    // PLATFORM: the platform-dependent part of autostart. `process.platform` is
    // read here and passed in, so the Windows branch stays testable on macOS —
    // see `buildLoginItemSettings` in `settings.ts` for both cases.
    buildLoginItemSettings({
      openAtLogin,
      platform: process.platform,
      execPath: process.execPath,
    }),
  )
}

async function bootstrap(): Promise<void> {
  const ops = createOperations(createClient(createNetFetch(getFactorialSession())))

  let employeeId: number
  try {
    const identity = await ensureAuthenticated(ops)
    employeeId = identity.employeeId
    console.log('[auth] signed in as', identity.fullName, '/', identity.companyName)
  } catch (error) {
    // Nothing this app does works without a session, and it has no offline mode
    // by design. Say so and stop, rather than opening a window that can only
    // show wrong data.
    dialog.showErrorBox('Factorial Desktop', `Anmeldung nicht möglich: ${describeError(error)}`)
    app.quit()
    return
  }

  const store = createAttendanceStore({ ops, employeeId })

  const settings = createSettings({
    filePath: join(app.getPath('userData'), 'settings.json'),
    applyLoginItem,
  })

  // The store only reports *changes*, so on a fresh install nothing would ever
  // register the login item even though the default is on — and if the user
  // removed the entry outside the app, the toggle would keep claiming it exists.
  // One reconciliation per start settles both. `setLoginItemSettings` is
  // idempotent.
  applyLoginItem(settings.get().openAtLogin)

  // Before the window exists: the renderer asks for a snapshot as it mounts, and
  // an unanswered `invoke` would reject in its first effect.
  registerIpc({
    store,
    settings,
    onSignOut: async () => {
      await clearSession()
      openLoginWindow()
    },
  })

  createWindow(settings.get().alwaysOnTop)

  // One read so the widget has real numbers immediately. Polling, the resume
  // hook and the focus refresh belong to the window/tray lifecycle (Task 10/12)
  // and are deliberately not started here.
  await store.refresh()
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
