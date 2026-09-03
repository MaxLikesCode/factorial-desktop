import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // Two preloads for two windows: the widget's, and the update window's much
    // smaller one. Named inputs so the files come out as `index.mjs` and
    // `update.mjs`, which is what `windows.ts` and `update-window.ts` load.
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          update: resolve('src/preload/update.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src'),
      },
    },
    // Two pages, same bundle: the widget and the update window.
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          update: resolve('src/renderer/update.html'),
        },
      },
    },
  },
})
