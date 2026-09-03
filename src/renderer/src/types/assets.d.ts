/**
 * Vite turns an imported image into its URL. The update window imports the
 * app icon this way; nothing else in the renderer does, which is why this is
 * one line rather than `vite/client`'s whole catalogue of asset types.
 */
declare module '*.png' {
  const url: string
  export default url
}
