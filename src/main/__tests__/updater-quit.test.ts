import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (file: string): string => readFileSync(resolve(process.cwd(), file), 'utf8')

/**
 * Asserted as source text rather than by running it, the same way
 * `app-identity.test.ts` asserts the order of two calls in `index.ts`: this is
 * about two Electron behaviours meeting, and there is no seam to unit test.
 *
 * The bug it guards against looked like a dead button. `quitAndInstall()` closes
 * every window and calls `app.quit()` only once they are all closed — but this
 * app's windows never close, they hide, so the app stayed alive with its tray
 * and the staged update was only installed when somebody quit it by hand.
 */
describe('installing an update actually leaves', () => {
  const updater = read('src/main/updater.ts')

  it('quits after arming Squirrel, not before', () => {
    const install = updater.indexOf('quitAndInstall()')
    const quit = updater.indexOf('app.quit()')
    expect(install).toBeGreaterThan(-1)
    expect(quit).toBeGreaterThan(-1)
    // The other order would exit before Squirrel had been told to install.
    expect(install).toBeLessThan(quit)
  })

  it('still hides rather than closes on a plain window close', () => {
    // The other half of the collision. If this ever stops being true, the quit
    // above becomes redundant rather than wrong — but the comment explaining it
    // would be a lie, so it is worth knowing.
    const windows = read('src/main/windows.ts')
    expect(windows).toContain('event.preventDefault()')
    expect(windows).toContain('win.hide()')
  })
})
