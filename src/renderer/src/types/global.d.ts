import type { FactorialBridge } from '@shared/ipc-contract'
import type { UpdateBridge } from '@shared/update-window'

declare global {
  /**
   * Everything the renderer can do to the outside world. `contextIsolation` is
   * on, so this is not optional-at-runtime by accident: `src/preload/index.ts`
   * calls `exposeInMainWorld` before any renderer code runs, and if it ever
   * failed the widget would be broken in a way no `?.` could paper over.
   *
   * Each window gets exactly one of the two. The widget has `factorial`, the
   * update window has `updateBridge`; neither page ever sees the other's.
   */
  interface Window {
    factorial: FactorialBridge
    updateBridge: UpdateBridge
  }
}

export {}
