/**
 * The Electron half of authentication: Factorial's own login page in a window
 * that shares our persistent partition, so that signing in there leaves a
 * session cookie every later API call uses.
 *
 * The decision logic lives in `auth-flow.ts`, which is Electron-free and
 * therefore unit tested. This file is the wiring: a real `BrowserWindow`, a real
 * clock. It is verified by running the app, not by tests.
 *
 * The window loads a third-party website, so it gets no preload script, no node
 * integration and a context-isolated renderer. Nothing of ours runs in it.
 */

import { BrowserWindow } from 'electron'
import { authenticate, createSessionProbe, type LoginWindowHandle } from './auth-flow'
import type { Operations } from './factorial/operations'
import type { Identity } from './factorial/types'
import { PARTITION } from './session'

/**
 * DESIGN.md names `id.factorialhr.com` as the login host (PLAN.md's Task 6
 * snippet says `app.factorialhr.com`; the design document wins). Both lead to
 * the same form — `app` bounces to `id` when there is no session — but pointing
 * straight at the login host avoids one redirect on the cold path.
 */
const LOGIN_URL = 'https://id.factorialhr.com/'

/** Slow enough not to hammer the API, fast enough to feel immediate after 2FA. */
const POLL_INTERVAL_MS = 1500

const LOGIN_WINDOW_WIDTH = 520
const LOGIN_WINDOW_HEIGHT = 720

let loginWindow: BrowserWindow | null = null

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Opens the login window, or focuses the one already open. */
export function openLoginWindow(): BrowserWindow {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return loginWindow
  }

  const win = new BrowserWindow({
    width: LOGIN_WINDOW_WIDTH,
    height: LOGIN_WINDOW_HEIGHT,
    title: 'Bei Factorial anmelden',
    webPreferences: {
      // Same partition as every API call — that is the entire point of this window.
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // No preload: this loads a third-party website.
    },
  })
  loginWindow = win

  win.on('closed', () => {
    if (loginWindow === win) loginWindow = null
  })
  void win.loadURL(LOGIN_URL)
  return win
}

export function closeLoginWindow(): void {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close()
  loginWindow = null
}

/** Adapts the window to the flow's minimal view of it. */
function toHandle(win: BrowserWindow): LoginWindowHandle {
  return {
    onClosed: (listener) => win.once('closed', listener),
    close: () => closeLoginWindow(),
  }
}

/**
 * Resolves once the stored session authenticates, opening the login window and
 * waiting if it does not. Rejects when the user closes that window, and when the
 * first check fails for a reason a login would not fix (no network, bad
 * response) — see `auth-flow.ts`.
 */
export function ensureAuthenticated(ops: Operations): Promise<Identity> {
  return authenticate({
    probe: createSessionProbe(ops),
    openLoginWindow: () => toHandle(openLoginWindow()),
    sleep,
    pollIntervalMs: POLL_INTERVAL_MS,
  })
}
