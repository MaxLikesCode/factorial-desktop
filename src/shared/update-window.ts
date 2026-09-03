/**
 * The vocabulary of the update window, shared by the three parties that speak
 * it: `src/main/updater.ts` decides what the window shows, `src/preload/update.ts`
 * carries it across, and `src/renderer/src/update/` draws it.
 *
 * Kept apart from `ipc-contract.ts` on purpose. That file is the widget's
 * bridge; the update window is a second renderer with a second, much smaller
 * preload, and giving it the widget's channels would hand a window that shows
 * release notes the ability to clock people out.
 *
 * Everything that crosses is plain data (see note 1 in `ipc-contract.ts`).
 */

import type { Locale } from './i18n'

export const UPDATE_IPC = {
  /** The renderer asks for what it should be showing, once, as it mounts. */
  getView: 'update:getView',
  /** Pushed whenever that changes: progress, ready, failed. */
  viewChanged: 'update:viewChanged',
  /** A button was pressed. */
  respond: 'update:respond',
  /** A link in the release notes was clicked. */
  openExternal: 'update:openExternal',
} as const

/**
 * The five things the window can be showing.
 *
 * `transferred` and `total` are bytes. `total` is null until the first progress
 * event names it — and stays null on macOS's second pass (see `preparing` in
 * `update-policy.ts`), where nothing reports a size.
 */
export type UpdateWindowState =
  | {
      kind: 'available'
      version: string
      current: string
      /**
       * The release's notes as HTML, straight from GitHub's release feed, or
       * null when the feed had none. The renderer sanitises before it renders;
       * nothing here vouches for the markup.
       */
      notes: string | null
      /** What the "install automatically" checkbox shows. */
      autoInstall: boolean
    }
  | { kind: 'downloading'; version: string; transferred: number; total: number | null }
  | { kind: 'preparing'; version: string; transferred: number; total: number | null }
  | { kind: 'ready'; version: string; transferred: number; total: number | null }
  | { kind: 'failed'; version: string; reason: string }
  /** The answer to a check the user asked for that found nothing. */
  | { kind: 'upToDate'; current: string }

/** What the window draws: a state, and the language to draw it in. */
export interface UpdateWindowView {
  locale: Locale
  state: UpdateWindowState
}

/**
 * What a button press means. `close` is the window's own close control — and
 * the platform's close, which lands on the same handler — whose meaning depends
 * on the state: it declines an offer, cancels a download, and merely puts a
 * finished one away until the next quit.
 */
export type UpdateWindowAction =
  | { kind: 'skip' }
  | { kind: 'later' }
  | { kind: 'install' }
  | { kind: 'cancel' }
  | { kind: 'restart' }
  | { kind: 'close' }
  | { kind: 'autoInstall'; value: boolean }

const ACTION_KINDS: readonly UpdateWindowAction['kind'][] = [
  'skip',
  'later',
  'install',
  'cancel',
  'restart',
  'close',
  'autoInstall',
]

/** Turns whatever arrived on the channel into an action, or nothing. */
export function asUpdateWindowAction(value: unknown): UpdateWindowAction | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.kind !== 'string') return null
  if (!(ACTION_KINDS as readonly string[]).includes(raw.kind)) return null
  if (raw.kind === 'autoInstall') {
    return typeof raw.value === 'boolean' ? { kind: 'autoInstall', value: raw.value } : null
  }
  return { kind: raw.kind as Exclude<UpdateWindowAction['kind'], 'autoInstall'> }
}

export interface UpdateBridge {
  getView(): Promise<UpdateWindowView | null>
  /** Returns its own unsubscribe. */
  onView(callback: (view: UpdateWindowView) => void): () => void
  respond(action: UpdateWindowAction): Promise<void>
  openExternal(url: string): Promise<void>
}

/**
 * The window's size for each state, in DIP.
 *
 * Three sizes rather than one: the offer carries release notes and wants room
 * to show them, the download is a progress bar and a number and would look lost
 * in that room, and "up to date" is a card with a centred icon. The window is
 * resized in place as the state moves on.
 */
export function updateWindowSizeFor(kind: UpdateWindowState['kind']): {
  width: number
  height: number
} {
  if (kind === 'available') return { width: 620, height: 560 }
  if (kind === 'upToDate') return { width: 440, height: 330 }
  return { width: 460, height: 210 }
}

/**
 * `31.9 MB`, the way a download dialog says it.
 *
 * Decimal megabytes, one decimal — the unit people read on a progress bar, not
 * the one the file system uses. Below a megabyte it says kilobytes without a
 * decimal, because "0.3 MB" reads as nothing happening.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 KB'
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}
