import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

/**
 * Packaging configuration, checked as data rather than by eye.
 *
 * This file has nothing to do with `src/shared`, but that is where the test
 * runner and the typechecker can both see it: `vitest.config.ts` only collects
 * `src/**\/__tests__/**` and `tsconfig.node.json` only includes
 * `src/{main,preload,shared}`. `environment.test.ts` sits here for the same
 * reason.
 *
 * What this cannot prove is that electron-builder likes the file — only a real
 * `npm run package:mac` does that, and its result is written down in
 * `docs/WINDOWS.md` §4.
 */

// Vitest runs every test with the config's root as the working directory, and
// that root is this repository. `import.meta.url` is not usable here: under the
// jsdom environment it is not a `file:` URL.
const ROOT = process.cwd()

type PackageJson = {
  main: string
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  /** electron-builder would read this and silently ignore electron-builder.yml. */
  build?: unknown
}

type BuilderTarget = { target: string; arch: string[] }

type BuilderConfig = {
  appId: string
  productName: string
  directories: { output: string; buildResources: string }
  files: string[]
  mac: {
    category: string
    target: BuilderTarget[]
    identity: string | null
    extendInfo: Record<string, unknown>
  }
  win: { target: BuilderTarget[] }
  nsis: Record<string, boolean>
  portable: Record<string, string>
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson

describe('package.json dependency classification (carry-forward C1)', () => {
  // electron-builder copies *production* dependencies into the app, so anything
  // that only ever runs at build time has to sit in devDependencies or it ships.
  const buildTimeOnly = ['shadcn', '@fontsource-variable/geist', 'tw-animate-css']

  for (const name of buildTimeOnly) {
    it(`ships no copy of ${name}`, () => {
      expect(pkg.dependencies[name]).toBeUndefined()
      expect(pkg.devDependencies[name]).toBeDefined()
    })
  }

  it('keeps the toolchain pins from K10', () => {
    // vite ^8 breaks the electron-vite@5 peer range, TS 7 removed `baseUrl`.
    expect(pkg.devDependencies['vite']).toBe('^7.3.6')
    expect(pkg.devDependencies['typescript']).toBe('^5.9.3')
  })

  it('has no inline electron-builder config that would shadow the yml', () => {
    expect(pkg.build).toBeUndefined()
  })

  it('packages only after a typechecked build', () => {
    expect(pkg.scripts['package:mac']).toBe('npm run build && electron-builder --mac')
    expect(pkg.scripts['package:win']).toBe('npm run build && electron-builder --win')
    expect(pkg.scripts['build']).toContain('npm run typecheck')
  })

  it('points `main` at the built entry point', () => {
    // electron-builder reads this out of the packaged package.json, so the path
    // has to be covered by the `files` globs below.
    expect(pkg.main).toBe('./out/main/index.js')
  })
})

describe('electron-builder.yml', () => {
  const raw = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
  const config = load(raw) as BuilderConfig

  it('identifies the app', () => {
    // A retired Factorial client of Max's ships as com.maxgiess.factorialtimer /
    // "Factorial Timer"; two installed apps must not share an identity. See
    // src/main/app-identity.ts.
    expect(config.appId).toBe('com.maxgiess.factorial-desktop')
    expect(config.productName).toBe('Factorial Desktop')
  })

  it('writes artefacts to the ignored release/ directory', () => {
    expect(config.directories.output).toBe('release')
    expect(config.directories.buildResources).toBe('build')
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toContain('release/')
  })

  it('packs the built output, the tray icons and package.json', () => {
    // `resources/**/*` is not optional: `src/main/tray.ts` resolves its icons as
    // `import.meta.dirname/../../resources`, i.e. inside the asar.
    expect(config.files).toContain('out/**/*')
    expect(config.files).toContain('resources/**/*')
    expect(config.files).toContain('package.json')
  })

  it('builds an unsigned arm64 DMG and ZIP for macOS', () => {
    expect(config.mac.target).toEqual([
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ])
    // Unsigned by choice — see docs/WINDOWS.md §4.
    expect(config.mac.identity).toBeNull()
    expect(config.mac.category).toBe('public.app-category.productivity')
  })

  it('hides the dock icon, because this is a menubar app', () => {
    expect(config.mac.extendInfo['LSUIElement']).toBe(1)
  })

  it('configures an NSIS installer for Windows', () => {
    expect(config.win.target).toContainEqual({ target: 'nsis', arch: ['x64'] })
    expect(config.nsis['oneClick']).toBe(false)
    expect(config.nsis['perMachine']).toBe(false)
    expect(config.nsis['allowToChangeInstallationDirectory']).toBe(true)
  })

  /**
   * The installer is what an autostart entry can point at; the portable file is
   * what somebody downloads to try the thing without installing anything. Both
   * are asserted because dropping either one is a silent loss — the build still
   * succeeds, and only whoever goes looking for the missing artefact finds out.
   */
  it('also ships Windows as a single portable file, named without the version', () => {
    expect(config.win.target).toContainEqual({ target: 'portable', arch: ['x64'] })
    // Otherwise every shortcut anybody makes carries 0.1.0 in its name.
    expect(config.portable['artifactName']).toBe('${productName}.${ext}')
  })
})

describe('build resources', () => {
  it('has a macOS icon with a retina-sized entry', () => {
    const icns = readFileSync(join(ROOT, 'build/icon.icns'))
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    // Bytes 4..8 are the total length; a truncated file is the failure mode.
    expect(icns.readUInt32BE(4)).toBe(icns.byteLength)
    // `ic09` is the 512x512 entry. electron-builder wants at least 512.
    expect(icns.includes(Buffer.from('ic09', 'ascii'))).toBe(true)
  })

  it('has a Windows icon that contains a 256px image', () => {
    const ico = readFileSync(join(ROOT, 'build/icon.ico'))
    // ICONDIR: reserved 0, type 1 (icon), then the image count.
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    const count = ico.readUInt16LE(4)
    expect(count).toBeGreaterThan(0)

    // Each ICONDIRENTRY is 16 bytes; a width byte of 0 means 256 px, which is
    // the size electron-builder rejects the file for not having.
    const widths = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + i * 16))
    expect(widths).toContain(0)
  })

  it('keeps the icon source script next to the icons', () => {
    expect(existsSync(join(ROOT, 'build/make-app-icon.py'))).toBe(true)
  })
})
