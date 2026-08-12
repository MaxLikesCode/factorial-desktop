/**
 * The Electron half of the IPC contract: it puts the handlers from
 * `ipc-handlers.ts` on `ipcMain` and pushes snapshots into real windows. The
 * decisions — payload validation, error classification, serialisation — live in
 * that module, which has no Electron import and is therefore tested. This file
 * is wiring and is verified by running the app.
 */

import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc-contract'
import {
  createIpcHandlers,
  createSnapshotBroadcaster,
  type IpcHandlerDeps,
} from './ipc-handlers'

export interface RegisterIpcDeps extends IpcHandlerDeps {
  /**
   * Which windows receive snapshot pushes. Defaults to every window, which is
   * safe today — the only other window is the login window, and it runs a
   * third-party page with no preload, so nothing there can listen. Task 10/12
   * should narrow this to the widget once it exists.
   */
  targets?: () => BrowserWindow[]
}

/**
 * Registers every channel and starts pushing state changes. Returns a dispose
 * function: without it a second `registerIpc` (a re-login, a test) would hit
 * Electron's "second handler for this channel" error.
 */
export function registerIpc({
  targets = () => BrowserWindow.getAllWindows(),
  ...deps
}: RegisterIpcDeps): () => void {
  const handlers = createIpcHandlers(deps)

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, payload: unknown) => handler(payload))
  }

  const unsubscribe = createSnapshotBroadcaster(deps.store, (snapshot) => {
    for (const win of targets()) {
      // A window can be destroyed between the store's change and this loop;
      // sending to it throws and would take the whole notification down.
      if (!win.isDestroyed()) win.webContents.send(IPC.snapshotChanged, snapshot)
    }
  })

  return () => {
    unsubscribe()
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}
