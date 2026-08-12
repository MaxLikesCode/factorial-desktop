import type { FactorialBridge } from '@shared/ipc-contract'

declare global {
  /**
   * Everything the renderer can do to the outside world. `contextIsolation` is
   * on, so this is not optional-at-runtime by accident: `src/preload/index.ts`
   * calls `exposeInMainWorld` before any renderer code runs, and if it ever
   * failed the widget would be broken in a way no `?.` could paper over.
   */
  interface Window {
    factorial: FactorialBridge
  }
}

export {}
