/**
 * App lifecycle and wiring. At this point in the build it claims the
 * single-instance lock, authenticates, builds the attendance store, loads the
 * persisted settings, registers the IPC contract and shows the widget window.
 * The tray, the poll loop and the resume/focus refresh plug in here in Task 12.
 */

import { app, dialog } from 'electron'
import { join } from 'node:path'
import { createAttendanceStore } from './attendance'
import { ensureAuthenticated, openLoginWindow } from './auth'
import { createClient } from './factorial/client'
import { createOperations } from './factorial/operations'
import { registerIpc } from './ipc'
import { clearSession, createNetFetch, getFactorialSession } from './session'
import { buildLoginItemSettings, createSettings, type Settings } from './settings'
import { createWidgetWindow, getWidget, setWidgetAlwaysOnTop, showWidget } from './windows'

/**
 * Makes `alwaysOnTop` take effect the moment it is toggled instead of on the
 * next start (carry-forward from Task 9). The settings store owns persistence
 * and validation and deliberately knows nothing about windows, so the window
 * side effect is layered on here, where the wiring lives.
 */
function withWindowEffects(settings: Settings): Settings {
  return {
    get: () => settings.get(),
    set: (patch) => {
      const next = settings.set(patch)
      setWidgetAlwaysOnTop(next.alwaysOnTop)
      return next
    },
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
    settings: withWindowEffects(settings),
    onSignOut: async () => {
      await clearSession()
      openLoginWindow()
    },
    // Only the widget listens. The login window loads a third-party page with no
    // preload, so a broadcast there is at best wasted and at worst hands app
    // state to someone else's renderer. `getWidget` is called per push, so this
    // is correct before the window exists and after it is gone.
    targets: () => {
      const widget = getWidget()
      return widget ? [widget] : []
    },
  })

  createWidgetWindow({
    positionFile: join(app.getPath('userData'), 'window-position.json'),
    alwaysOnTop: settings.get().alwaysOnTop,
  })

  // One read so the widget has real numbers immediately. Polling, the resume
  // hook and the focus refresh come with the tray in Task 12, whose plan body
  // specifies the whole lifecycle at once; starting half of it here would leave
  // a poll loop no quit command can stop.
  await store.refresh()
}

// PLATFORM: Windows starts a whole second app on every launch without this lock;
// macOS reuses the running instance by itself. Harmless on macOS, required there.
if (app.requestSingleInstanceLock()) {
  // PLATFORM: the Windows counterpart of the lock — the second launch hands over
  // here and expects the running instance to come to the front. It targets the
  // widget specifically: taking "the first window" would have raised the login
  // window whenever one was open.
  app.on('second-instance', () => showWidget())

  void app.whenReady().then(bootstrap)
} else {
  app.quit()
}

// PLATFORM: macOS keeps an app alive with no windows open; every other platform
// expects the last window to end it.
//
// Since Task 10 the widget's close button only hides it, so the widget keeps
// this from firing for as long as it exists — which is the intended behaviour
// for a tray app. What is left is the failure path: bootstrap died before the
// widget was built, or the user closed the login window. Ending there is right
// on Windows and Linux. Task 12 re-checks this once the tray provides a real
// quit command; until then ⌘Q is the only way out on macOS and there is **no**
// way out on Windows, because there is no tray yet (see docs/WINDOWS.md §4).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
