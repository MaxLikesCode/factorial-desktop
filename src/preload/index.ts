/**
 * The only bridge between the renderer and the main process.
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so the renderer has no
 * `require`, no `ipcRenderer` and no Node at all — it gets exactly the handful of
 * functions below and nothing else. Each one is a thin call: no state, no
 * caching, no interpretation. Anything cleverer would be a second truth next to
 * the store in the main process.
 *
 * Channel names are never written as strings here; they come from the shared
 * `IPC` constants so a rename cannot leave one side listening on a dead channel.
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppSettings,
  type FactorialBridge,
  type SerialisedSnapshot,
} from '@shared/ipc-contract'

const bridge: FactorialBridge = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),

  onSnapshot: (callback) => {
    // The event object stays here on purpose: handing the renderer an
    // `IpcRendererEvent` would hand it `sender`, and with it a way to talk on
    // channels this contract does not describe.
    const handler = (_event: unknown, snapshot: SerialisedSnapshot): void => callback(snapshot)
    ipcRenderer.on(IPC.snapshotChanged, handler)
    return () => {
      ipcRenderer.off(IPC.snapshotChanged, handler)
    }
  },

  // The four actions reject when the write fails — the store has rolled back by
  // then. The rejection is what the widget turns into a toast, so it is
  // deliberately not swallowed here.
  clockIn: (input) => ipcRenderer.invoke(IPC.clockIn, input),
  startBreak: (breakId) => ipcRenderer.invoke(IPC.startBreak, breakId),
  endBreak: () => ipcRenderer.invoke(IPC.endBreak),
  clockOut: () => ipcRenderer.invoke(IPC.clockOut),

  refresh: () => ipcRenderer.invoke(IPC.refresh),
  signOut: () => ipcRenderer.invoke(IPC.signOut),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.setSettings, patch),

  onSettings: (callback) => {
    // Same rule as `onSnapshot`: the event object stays on this side.
    const handler = (_event: unknown, settings: AppSettings): void => callback(settings)
    ipcRenderer.on(IPC.settingsChanged, handler)
    return () => {
      ipcRenderer.off(IPC.settingsChanged, handler)
    }
  },
  setWindowInteractive: (interactive: boolean) =>
    ipcRenderer.invoke(IPC.setWindowInteractive, interactive),
}

contextBridge.exposeInMainWorld('factorial', bridge)
