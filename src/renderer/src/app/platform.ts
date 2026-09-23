/** macOS draws this window natively; Windows gets the page's drawn frame. */
export const MAC = navigator.platform.toLowerCase().includes('mac')

/**
 * FRAME_MARGIN in main-window.ts: the transparent room around the drawn
 * window. PLATFORM: none on macOS, where the window has a native frame.
 */
export const FRAME_MARGIN = MAC ? 0 : 32
