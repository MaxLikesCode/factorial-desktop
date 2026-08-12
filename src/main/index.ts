/**
 * App lifecycle and wiring: it claims the single-instance lock, authenticates,
 * builds the attendance store, loads the persisted settings, registers the IPC
 * contract, shows the widget window, puts the tray in place and starts the
 * background synchronisation.
 *
 * Since Task 12 this is a tray application. The widget's close button hides it,
 * and the only way out is the tray's "Beenden" (or ⌘Q on macOS) — see the
 * `window-all-closed` handler at the bottom.
 */

import { app, dialog, powerMonitor } from 'electron'
import { join } from 'node:path'
import { createAttendanceStore, type ClockInInput } from './attendance'
import { ensureAuthenticated, openLoginWindow } from './auth'
import { installNetDebug } from './debug-net'
import { createClient } from './factorial/client'
import { createOperations } from './factorial/operations'
import { isLocationType } from './factorial/types'
import { registerIpc } from './ipc'
import { applyBrowserUserAgent, clearSession, createNetFetch, getFactorialSession } from './session'
import { buildLoginItemSettings, createSettings, type Settings } from './settings'
import { createTray, hasTray } from './tray'
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
  const factorialSession = getFactorialSession()
  // Before anything touches the network: Factorial's sign-in refuses to verify
  // OTP and MFA codes from a User-Agent carrying the Electron token.
  applyBrowserUserAgent(factorialSession)
  // Off unless FACTORIAL_DEBUG_NET=1; see debug-net.ts for what it does and does
  // not record.
  installNetDebug(factorialSession)
  const ops = createOperations(createClient(createNetFetch(factorialSession)))

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

  // One wrapped instance for both writers — the widget through IPC and the
  // tray's "Einstellungen" submenu. Wrapping twice would work but would make it
  // possible for one route to gain the window side effect and the other not.
  const settingsWithWindowEffects = withWindowEffects(settings)

  // The store only reports *changes*, so on a fresh install nothing would ever
  // register the login item even though the default is on — and if the user
  // removed the entry outside the app, the toggle would keep claiming it exists.
  // One reconciliation per start settles both. `setLoginItemSettings` is
  // idempotent.
  applyLoginItem(settings.get().openAtLogin)

  /**
   * Drops the rejected session cookie and offers Factorial's login page again.
   * Used by the widget's "Anmelden" button and by the tray entry of the same
   * name, so both routes do exactly the same thing.
   */
  async function signInAgain(): Promise<void> {
    await clearSession()
    openLoginWindow()
  }

  /**
   * What a clock-in from the *tray* sends. The remembered work location is a
   * persisted preference and there must be exactly one of it: a second default
   * in the tray would file shifts at the wrong place whenever the user picked
   * something other than "Büro" in the widget.
   */
  function clockInInput(): ClockInInput {
    const { lastLocationType, lastWorkplaceId } = settings.get()
    return {
      // Re-checked on read: the field is a plain string in the contract, and an
      // unknown value fails the mutation in-band with HTTP 200 (K4).
      locationType: isLocationType(lastLocationType) ? lastLocationType : 'office',
      workplaceId: lastWorkplaceId,
    }
  }

  // Before the window exists: the renderer asks for a snapshot as it mounts, and
  // an unanswered `invoke` would reject in its first effect.
  registerIpc({
    store,
    settings: settingsWithWindowEffects,
    onSignOut: signInAgain,
    // Only the widget listens. The login window loads a third-party page with no
    // preload, so a broadcast there is at best wasted and at worst hands app
    // state to someone else's renderer. `getWidget` is called per push, so this
    // is correct before the window exists and after it is gone.
    targets: () => {
      const widget = getWidget()
      return widget ? [widget] : []
    },
  })

  const widget = createWidgetWindow({
    positionFile: join(app.getPath('userData'), 'window-position.json'),
    alwaysOnTop: settings.get().alwaysOnTop,
  })

  // Built before the first read so that a failing refresh still leaves a tray
  // behind — otherwise a bad network on start would produce an app with a hidden
  // widget and no way to quit it.
  createTray({
    store,
    settings: settingsWithWindowEffects,
    clockInInput,
    onSignIn: () => {
      void signInAgain()
    },
    onQuit: () => app.quit(),
  })

  // One read so the widget and the tray have real numbers immediately.
  await store.refresh()

  // DESIGN.md, "Synchronisation": every 60 s in the background.
  store.startPolling()

  // The timer is recomputed from the shift's start on every render, so it cannot
  // drift while the machine sleeps — but `todayMinutes` and the state itself
  // can be hours out of date on wake. Polling is stopped for the duration
  // because a request fired into a suspending network stack just fails and marks
  // the snapshot stale for no reason.
  powerMonitor.on('suspend', () => store.stopPolling())
  powerMonitor.on('resume', () => {
    void store.refresh()
    store.startPolling()
  })

  // DESIGN.md, "Synchronisation": window focus. Bringing the widget forward is
  // the moment someone is about to trust what it says.
  widget.on('focus', () => {
    void store.refresh()
  })
}

// PLATFORM: Windows starts a whole second app on every launch without this lock;
// macOS reuses the running instance by itself. Harmless on macOS, required there.
if (app.requestSingleInstanceLock()) {
  // PLATFORM: the Windows counterpart of the lock — the second launch hands over
  // here and expects the running instance to come to the front. It targets the
  // widget specifically: taking "the first window" would have raised the login
  // window whenever one was open.
  app.on('second-instance', () => showWidget())

  void app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      // Anything escaping `bootstrap` (the auth failure has its own handler) —
      // a tray that could not be created, an unreadable settings directory —
      // would otherwise leave a running process with no tray and, on Windows,
      // nothing at all to click. Say so and end.
      dialog.showErrorBox('Factorial Desktop', `Start fehlgeschlagen: ${describeError(error)}`)
      app.quit()
    })
} else {
  app.quit()
}

// PLATFORM: the classic version of this handler quits everywhere except macOS.
// Since Task 12 the platform is no longer what decides it — the tray is, on
// every platform alike:
//
// - **With a tray**, this is a tray application. Closing the widget only hides
//   it (Task 10), so this handler is reached only in odd cases such as a login
//   window being closed while the widget is hidden. Quitting there would end the
//   app behind the user's back although its icon is sitting in the menubar,
//   offering "Beenden". So it stays alive, on Windows too.
// - **Without a tray**, the app has no visible surface and no way to be quit:
//   `skipTaskbar` keeps the widget out of the taskbar and there is no icon to
//   click. That only happens on the failure path — bootstrap died before the
//   tray existed, or the user closed the login window — and there the last
//   window closing is the end, on macOS as well.
//
// Electron quits by itself when the last window is *destroyed* and no listener
// is registered, so this handler must exist even though it usually does nothing.
app.on('window-all-closed', () => {
  if (!hasTray()) app.quit()
})
