import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      // Carry-forward C3: renderer components import through this alias, and
      // without it here no component test resolves a single one of them.
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
  test: {
    // C3: jsdom for the whole suite rather than per-file. The main-process
    // modules under test are pure logic plus `node:fs`, which jsdom does not
    // touch — verified by running the full suite after the switch.
    environment: 'jsdom',
    // Every timestamp in this app is reconstructed from an offset that arrives
    // with the data, but the formatters and the store's `now()` still read the
    // machine's zone. Pinning it keeps a green suite from depending on where it runs.
    env: { TZ: 'Europe/Berlin' },
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
  },
})
