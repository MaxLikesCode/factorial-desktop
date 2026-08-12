import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  FOREIGN_USER_DATA_DIRECTORY,
  USER_DATA_DIRECTORY,
  resolveUserDataPath,
} from '../app-identity'

const repoRoot = resolve(__dirname, '../../..')
const read = (file: string): string => readFileSync(resolve(repoRoot, file), 'utf8')

describe('resolveUserDataPath', () => {
  it('appends our own directory to the platform application-data path', () => {
    expect(resolveUserDataPath('/Users/max/Library/Application Support')).toBe(
      '/Users/max/Library/Application Support/factorial-desktop-2',
    )
  })

  it('does the same for a Windows-shaped path', () => {
    expect(resolveUserDataPath('C:\\Users\\max\\AppData\\Roaming')).toContain(USER_DATA_DIRECTORY)
  })
})

/**
 * The whole point of the module. A sibling Factorial client shares this app's
 * `package.json` name, and Electron derives `userData` from that name — so
 * without these guarantees both apps land in one directory and share cookies,
 * settings and the single-instance lock.
 */
describe('isolation from the sibling Factorial client', () => {
  it('does not use the sibling’s directory', () => {
    expect(USER_DATA_DIRECTORY).not.toBe(FOREIGN_USER_DATA_DIRECTORY)
  })

  it('is not merely a prefix match away — a path check must not confuse the two', () => {
    expect(resolveUserDataPath('/root')).not.toBe(`/root/${FOREIGN_USER_DATA_DIRECTORY}`)
  })

  it('keeps package.json’s name distinct, so even an unpinned userData would not collide', () => {
    const pkg = JSON.parse(read('package.json')) as { name: string }
    expect(pkg.name).not.toBe(FOREIGN_USER_DATA_DIRECTORY)
    expect(pkg.name).toBe(USER_DATA_DIRECTORY)
  })

  it('ships a distinct appId and productName, so packaged builds cannot collide either', () => {
    const builder = read('electron-builder.yml')
    expect(builder).toMatch(/^appId: com\.maxgiess\.factorial-desktop-2$/m)
    // "Factorial Timer" is the sibling's productName; ours must differ.
    expect(builder).not.toMatch(/^productName: Factorial Timer$/m)
    expect(builder).toMatch(/^productName: .+$/m)
  })

  it('pins userData in main before the single-instance lock is claimed', () => {
    const index = read('src/main/index.ts')
    const setPath = index.indexOf("app.setPath('userData'")
    const lock = index.indexOf('app.requestSingleInstanceLock()')
    expect(setPath).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(-1)
    // The lock is keyed by userData. Claiming it first would claim the sibling's.
    expect(setPath).toBeLessThan(lock)
  })
})
