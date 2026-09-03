/**
 * The update window's bridge — the second, much smaller preload.
 *
 * Kept apart from `index.ts` for the reason `update-window.ts` in `src/shared`
 * gives: this window shows release notes and four buttons, and it gets exactly
 * the four calls that needs. The widget's channels — clocking in and out,
 * settings — are not exposed here at all.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { UPDATE_IPC, type UpdateBridge, type UpdateWindowView } from '@shared/update-window'

const bridge: UpdateBridge = {
  getView: () => ipcRenderer.invoke(UPDATE_IPC.getView),
  onView: (callback) => {
    // The event object stays here, same as in the widget's preload.
    const handler = (_event: unknown, view: UpdateWindowView): void => callback(view)
    ipcRenderer.on(UPDATE_IPC.viewChanged, handler)
    return () => {
      ipcRenderer.off(UPDATE_IPC.viewChanged, handler)
    }
  },
  respond: (action) => ipcRenderer.invoke(UPDATE_IPC.respond, action),
  openExternal: (url) => ipcRenderer.invoke(UPDATE_IPC.openExternal, url),
}

contextBridge.exposeInMainWorld('updateBridge', bridge)
