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
import { indicatesSignedIn, LOGIN_URL } from './login-target'
import { PARTITION } from './session'

const LOGIN_WINDOW_WIDTH = 520
const LOGIN_WINDOW_HEIGHT = 720

let loginWindow: BrowserWindow | null = null

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
    // `did-navigate` is main-frame only, which is what this wants: sub-frame and
    // in-page navigations are not a completed sign-in.
    onNavigate: (listener) => {
      win.webContents.on('did-navigate', (_event, url) => listener(url))
      // A redirect that never becomes a fresh document still lands the user
      // somewhere new, and after sign-in Factorial does exactly that.
      win.webContents.on('did-redirect-navigation', (_event, url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) listener(url)
      })
    },
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
    indicatesSignedIn,
  })
}
