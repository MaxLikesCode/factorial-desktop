/**
 * `npm run dev:update [state]` — a development run that opens the update
 * window instead of waiting for a release that will never come in dev.
 *
 * It exists because the environment variable it sets cannot be written in
 * front of the command in a way that works in both shells: `FOO=1 npm run dev`
 * is sh, `$env:FOO='1'; npm run dev` is PowerShell, and this project is built
 * on both. Node sets it and runs `electron-vite dev`, which is neither.
 *
 * The optional argument picks which of the window's states opens first, so
 * that all of them can be looked at without walking there through the buttons:
 *
 *   npm run dev:update            the offer (same as `offer`)
 *   npm run dev:update ready      downloaded, waiting for the restart
 *   npm run dev:update failed     the download failed
 *   npm run dev:update uptodate   "you are up to date"
 *   npm run dev:update about      the About card
 *
 * See `src/main/update-preview.ts` for the full list and what each one does.
 */

import { spawn } from 'node:child_process'

const state = process.argv[2] ?? '1'

const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, FACTORIAL_PREVIEW_UPDATE: state },
})

child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
