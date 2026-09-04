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

import { Notification, app, dialog, nativeTheme, powerMonitor } from 'electron'
import { join } from 'node:path'
import { IPC, isMainWindowPage, type MainWindowPage, type ThemeSetting } from '@shared/ipc-contract'
import type { ExpandDirection } from '@shared/widget-size'
import { resolveUserDataPath } from './app-identity'
import { createAttendanceStore, type ClockInInput } from './attendance'
import { ensureAuthenticated, openLoginWindow } from './auth'
import { classifySignInFailure } from './auth-flow'
import { runIntrospection } from './debug-introspect'
import { installNetDebug } from './debug-net'
import { installWebDebug, openFactorialWeb } from './debug-web'
import { createClient } from './factorial/client'
import { createOperations, type Operations } from './factorial/operations'
import { isLocationType, type Identity } from './factorial/types'
import { registerIpc } from './ipc'
import { applyBrowserUserAgent, clearSession, createNetFetch, getFactorialSession } from './session'
import { buildLoginItemSettings, createSettings, type Settings } from './settings'
import { createTray, hasTray, refreshTray } from './tray'
import { createTimesheet } from './timesheet'
import { watchLongShifts } from './long-shift'
import { closeMainWindow, controlMainWindow, getMainWindow, showMainWindow } from './main-window'
import { createUpdateLog } from './update-log'
import { maybePreviewUpdateWindow } from './update-preview'
import { createUpdater } from './updater'
import { resolveLocale } from '@shared/i18n'
import { toLocalDate } from '@shared/time'
import { translatorFor } from '@shared/locales'
import {
  createWidgetWindow,
  getWidget,
  setWidgetAlwaysOnTop,
  setWidgetDragging,
  setWidgetInteractive,
  popupWidgetMenu,
  setWidgetExpandDirection,
  showWidget,
} from './windows'

/**
 * Makes `alwaysOnTop` take effect the moment it is toggled instead of on the
 * next start (carry-forward from Task 9), and tells the renderer that anything
 * changed at all. The settings store owns persistence and validation and
 * deliberately knows nothing about windows, so both side effects are layered on
 * here, where the wiring lives.
 *
 * The broadcast matters more than it looks. The tray writes this same store, and
 * the widget's own size is now one of the settings — without a push the widget
 * would keep drawing the old size in a window the main process had already
 * resized around it.
 */
function withWindowEffects(settings: Settings): Settings {
  return {
    get: () => settings.get(),
    set: (patch) => {
      const next = settings.set(patch)
      setWidgetAlwaysOnTop(next.alwaysOnTop)
      for (const win of [getWidget(), getMainWindow()]) {
        if (win && !win.isDestroyed()) win.webContents.send(IPC.settingsChanged, next)
      }
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
/**
 * Applies the chosen appearance — the entire renderer-side mechanism.
 *
 * Chromium reports `themeSource` to every renderer of this app as
 * `prefers-color-scheme`, and `styles.css` defines its dark tokens under exactly
 * that media query. So this one assignment repaints the widget, and there is no
 * theme prop, no context and no IPC channel that could disagree with it.
 *
 * `ThemeSetting`'s three values are `themeSource`'s three values, which is why
 * this needs no mapping — and why both the settings store and the IPC layer
 * whitelist the value: `themeSource` throws on anything else.
 */
function applyTheme(theme: ThemeSetting): void {
  nativeTheme.themeSource = theme
}

/**
 * Points the card at the other edge of its window.
 *
 * Thin on purpose: the window module owns the move and the clamp, because both
 * are properties of the window and neither belongs to a settings store that
 * deliberately knows nothing about Electron.
 */
function applyExpandDirection(direction: ExpandDirection): void {
  setWidgetExpandDirection(direction)
}

function applyLoginItem(openAtLogin: boolean): void {
  app.setLoginItemSettings(
    // PLATFORM: the platform-dependent part of autostart. `process.platform` is
    // read here and passed in, so the Windows branch stays testable on macOS —
    // see `buildLoginItemSettings` in `settings.ts` for both cases.
    buildLoginItemSettings({
      openAtLogin,
      platform: process.platform,
      execPath: process.execPath,
      // Set by electron-builder's portable target only; undefined everywhere
      // else, which is exactly the condition the function branches on.
      portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE,
    }),
  )
}

/**
 * Signs in, and offers another go when the answer simply never arrived.
 *
 * This used to end the app on any failure, with "Anmeldung nicht möglich" and
 * the raw reason. For a closed login window that is right. For a timeout it is
 * both wrong and misleading: `auth-flow.ts` is built on the rule that "the
 * server says no" is not "the server did not answer", and quitting here broke
 * that rule one layer up — a fifteen-second hiccup on a network that was fine a
 * minute later left an app that would not start, and a message blaming the
 * sign-in for it.
 *
 * Returns `null` when the app has been told to quit, so the caller stops.
 */
async function signInOrOfferAnother(ops: Operations): Promise<Identity | null> {
  // The stored language preference lives in settings, which are not loaded this
  // early — there is no session yet to load them for. The OS language is the
  // best answer available at this point, and the same one a first run gets.
  const t = translatorFor(resolveLocale('system', app.getLocale()))

  for (;;) {
    try {
      return await ensureAuthenticated(ops)
    } catch (error) {
      const reason = describeError(error)
      if (classifySignInFailure(reason) === 'aborted') {
        // The user closed the login window. Telling them that they are not
        // signed in would be reporting their own decision back at them.
        app.quit()
        return null
      }

      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: [t('auth.retry'), t('tray.quit')],
        defaultId: 0,
        cancelId: 1,
        title: t('auth.failedTitle'),
        message: t('auth.unreachable'),
        detail: t('auth.unreachableDetail', { reason }),
      })
      if (response !== 0) {
        app.quit()
        return null
      }
    }
  }
}

/** A system notification, if the platform offers them; a click opens the app window. */
function notify(title: string, body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  notification.on('click', onClick)
  notification.show()
}

async function bootstrap(): Promise<void> {
  const factorialSession = getFactorialSession()
  // Before anything touches the network: Factorial's sign-in refuses to verify
  // OTP and MFA codes from a User-Agent carrying the Electron token.
  applyBrowserUserAgent(factorialSession)
  // Off unless FACTORIAL_DEBUG_NET=1; see debug-net.ts for what it does and does
  // not record.
  installNetDebug(factorialSession)
  // Off unless FACTORIAL_DEBUG_WEB=1. Installed after the net log because it
  // takes over the same listener; see debug-web.ts.
  installWebDebug(factorialSession)
  const client = createClient(createNetFetch(factorialSession))
  const ops = createOperations(client)

  const identity = await signInOrOfferAnother(ops)
  // Nothing this app does works without a session, and it has no offline mode by
  // design: opening a window that can only show wrong data would be worse than
  // not opening one. `signInOrOfferAnother` has already quit in that case.
  if (identity === null) return
  // Off unless FACTORIAL_INTROSPECT names a type; see debug-introspect.ts.
  await runIntrospection(client)
  // Off unless FACTORIAL_DEBUG_WEB=1: Factorial's own web app in our session,
  // for comparing a working request with ours.
  openFactorialWeb(factorialSession)
  const employeeId = identity.employeeId
  console.log('[auth] signed in as', identity.fullName, '/', identity.companyName)

  const store = createAttendanceStore({ ops, employeeId })

  const settings = createSettings({
    filePath: join(app.getPath('userData'), 'settings.json'),
    applyLoginItem,
    applyTheme,
    applyExpandDirection,
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

  // Same reason, shorter story: `themeSource` starts every process at 'system',
  // so a stored 'dark' has to be re-applied on each launch. The store only
  // reports changes, and a launch is not one.
  applyTheme(settings.get().theme)

  /**
   * Drops the rejected session cookie and offers Factorial's login page again.
   * Used by the widget's "Anmelden" button and by the tray entry of the same
   * name, so both routes do exactly the same thing.
   */
  async function signInAgain(): Promise<void> {
    // The app window is for a signed-in user; with the session gone it goes
    // away, and the login page is the one window left to look at.
    closeMainWindow()
    await clearSession()
    openLoginWindow()
  }

  /**
   * The app window — for a signed-in user only. Without a session the login
   * window is offered instead: settings and the timesheet are Factorial's
   * data, and a page that can only show "not signed in" is not worth a
   * window.
   */
  function openApp(page: MainWindowPage | null): void {
    if (store.getSnapshot().state.kind === 'unauthenticated') {
      openLoginWindow()
      return
    }
    showMainWindow(page)
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

  // Built before the first read so that a failing refresh still leaves a tray
  // behind — otherwise a bad network on start would produce an app with a hidden
  // widget and no way to quit it.
  const updater = createUpdater({
    getTranslate: () => translatorFor(resolveLocale(settings.get().language, app.getLocale())),
    getLocale: () => resolveLocale(settings.get().language, app.getLocale()),
    // The broadcasting wrapper, so a tick in the update window's checkbox
    // reaches the tray's copy of the same setting.
    settings: settingsWithWindowEffects,
    // The tray is built below, and `refreshTray()` is a no-op until it exists —
    // which is exactly the right behaviour for a status change that arrives
    // before there is anywhere to show it.
    onStatusChange: () => refreshTray(),
    logger: createUpdateLog(app.getPath('userData')),
  })

  const timesheet = createTimesheet({
    ops,
    employeeId,
    defaultLocationType: () => settings.get().lastLocationType,
    // An edited today changes the widget's bar and sum; the store re-reads
    // rather than being told, so the two can never disagree.
    onSaved: (date) => {
      if (date === toLocalDate(new Date())) void store.refresh()
    },
  })

  // Before the window exists: the renderer asks for a snapshot as it mounts, and
  // an unanswered `invoke` would reject in its first effect.
  registerIpc({
    setWindowInteractive: setWidgetInteractive,
    setWindowDragging: setWidgetDragging,
    popupMenu: popupWidgetMenu,
    store,
    settings: settingsWithWindowEffects,
    onSignOut: signInAgain,
    timesheet,
    openMainWindow: (page) => openApp(page),
    getAppInfo: () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      user: { fullName: identity.fullName, email: identity.email, companyName: identity.companyName },
    }),
    checkForUpdates: () => void updater.checkNow(true),
    controlWindow: controlMainWindow,
    // The widget and the app window listen. The login window loads a
    // third-party page with no preload, so a broadcast there is at best wasted
    // and at worst hands app state to someone else's renderer. Both getters are
    // called per push, so this is correct before a window exists and after it
    // is gone.
    targets: () => [getWidget(), getMainWindow()].filter((w) => w !== null),
  })

  const widget = createWidgetWindow({
    positionFile: join(app.getPath('userData'), 'window-position.json'),
    alwaysOnTop: settings.get().alwaysOnTop,
    expandDirection: settings.get().expandDirection,
  })

  createTray({
    store,
    settings: settingsWithWindowEffects,
    clockInInput,
    onSignIn: () => {
      void signInAgain()
    },
    onCheckForUpdates: () => void updater.checkNow(true),
    getUpdateStatus: () => updater.getStatus(),
    onOpenWindow: (page) => openApp(page),
    onQuit: () => app.quit(),
  })

  // The forgotten shift: a notification after N hours, and — only when the
  // user switched it on — a clock-out after M. See long-shift.ts.
  watchLongShifts({
    getState: () => store.getSnapshot().state,
    getSettings: () => {
      const { longShiftReminderHours, autoClockOutHours } = settings.get()
      return { longShiftReminderHours, autoClockOutHours }
    },
    remind: (hours) => {
      const t = translatorFor(resolveLocale(settings.get().language, app.getLocale()))
      notify(t('longShift.reminderTitle'), t('longShift.reminderBody', { hours }), () => showMainWindow('overview'))
    },
    clockOut: async () => {
      await store.clockOut()
      const t = translatorFor(resolveLocale(settings.get().language, app.getLocale()))
      notify(t('longShift.clockedOutTitle'), t('longShift.clockedOutBody'), () => showMainWindow('timesheet'))
    },
    onClockOutFailed: (reason) => console.error('[long-shift] automatic clock-out failed:', reason),
  })

  // One read so the widget and the tray have real numbers immediately.
  await store.refresh()

  // DESIGN.md, "Synchronisation": every 60 s in the background.
  store.startPolling()

  // After the store, not before: the first update check waits half a minute and
  // has no business competing with the first attendance read for the network.
  updater.start()

  // Development only, and only when asked for — see update-preview.ts.
  maybePreviewUpdateWindow(() => resolveLocale(settings.get().language, app.getLocale()))
  // Same idea for the app window: FACTORIAL_OPEN_WINDOW=timesheet opens it at
  // start, so a change to it can be looked at without a trip through the tray.
  const openAt = process.env.FACTORIAL_OPEN_WINDOW
  if (!app.isPackaged && isMainWindowPage(openAt)) showMainWindow(openAt)

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

// Before ANY of the three lines below: `requestSingleInstanceLock` is keyed by
// the userData directory, and a sibling Factorial client resolves to the same
// one by default. Claiming the lock first would mean claiming *its* lock. See
// `app-identity.ts`.
app.setPath('userData', resolveUserDataPath(app.getPath('appData')))

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
