/**
 * App lifecycle and wiring. At this point in the build it claims the
 * single-instance lock, authenticates, builds the attendance store, registers
 * the IPC contract and shows the widget window. Settings, the widget's own
 * module and the tray plug in here in tasks 9, 10 and 12.
 */

import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import type { AppSettings } from '@shared/ipc-contract'
import { createAttendanceStore } from './attendance'
import { ensureAuthenticated, openLoginWindow } from './auth'
import { createClient } from './factorial/client'
import { createOperations } from './factorial/operations'
import { registerIpc } from './ipc'
import { clearSession, createNetFetch, getFactorialSession } from './session'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 340,
    height: 220,
    show: false,
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
 * Placeholder for Task 9's persisted settings. It keeps the IPC contract whole
 * (`getSettings`/`setSettings` answer, and the widget can already remember a
 * location within one run) without pre-empting the file format, the login-item
 * side effect or the sanitising that task owns. Nothing is written to disk, so
 * every restart starts from these defaults.
 */
function createInMemorySettings(): {
  get(): AppSettings
  set(patch: Partial<AppSettings>): AppSettings
} {
  let current: AppSettings = {
    openAtLogin: true,
    alwaysOnTop: true,
    lastLocationType: 'office',
    lastWorkplaceId: null,
  }
  return {
    get: () => current,
    set: (patch) => {
      current = { ...current, ...patch }
      return current
    },
  }
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

  // Before the window exists: the renderer asks for a snapshot as it mounts, and
  // an unanswered `invoke` would reject in its first effect.
  registerIpc({
    store,
    settings: createInMemorySettings(),
    onSignOut: async () => {
      await clearSession()
      openLoginWindow()
    },
  })

  createWindow()

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
