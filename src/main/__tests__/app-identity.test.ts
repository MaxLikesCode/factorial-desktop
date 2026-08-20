import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { USER_DATA_DIRECTORY, resolveUserDataPath } from '../app-identity'

const repoRoot = resolve(__dirname, '../../..')
const read = (file: string): string => readFileSync(resolve(repoRoot, file), 'utf8')

describe('resolveUserDataPath', () => {
  it('appends our own directory to the platform application-data path', () => {
    // Separator-normalised: `join` yields backslashes on Windows. What is
    // asserted is that exactly our directory name gets appended and that
    // nothing else about the path changes - true on both platforms.
    const appended = resolveUserDataPath('/Users/max/Library/Application Support')
      .split(sep)
      .join('/')
    expect(appended).toBe('/Users/max/Library/Application Support/factorial-desktop')
  })

  it('does the same for a Windows-shaped path', () => {
    expect(resolveUserDataPath('C:\\Users\\max\\AppData\\Roaming')).toContain(USER_DATA_DIRECTORY)
  })
})

/**
 * The point of pinning the path in code: the product may be renamed, but a
 * user's session, settings and window position must stay where they are.
 */
describe('independence from the product name', () => {
  it('does not follow electron-builder’s productName', () => {
    const productName = /^productName: (.+)$/m.exec(read('electron-builder.yml'))?.[1]
    expect(productName).toBeDefined()
    expect(resolveUserDataPath('/root')).not.toBe(`/root/${productName}`)
  })

  it('pins userData in main before the single-instance lock is claimed', () => {
    const index = read('src/main/index.ts')
    const setPath = index.indexOf("app.setPath('userData'")
    const lock = index.indexOf('app.requestSingleInstanceLock()')
    expect(setPath).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(-1)
    // The lock is keyed by userData. Claiming it first would key it to whatever
    // Electron derived from the app name instead.
    expect(setPath).toBeLessThan(lock)
  })
})
