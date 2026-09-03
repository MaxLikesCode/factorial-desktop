import { describe, expect, it } from 'vitest'
import { translatorFor } from '@shared/locales'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  capabilityFor,
  installKind,
  notesOf,
  restartModeFor,
  shouldOffer,
  updateMenuEntry,
} from '../update-policy'

/**
 * The awkward cases of updating, checked here because they are unreachable from
 * the machine the code is written on: a portable build only exists on Windows,
 * and a running shift only exists against a real account. Every input is an
 * argument for exactly that reason — see the note at the top of the module.
 */

describe('installKind', () => {
  it('is development for anything not packaged', () => {
    expect(installKind({ packaged: false })).toBe('development')
    // Even with the variable set: an unpacked build is a dev build first.
    expect(installKind({ packaged: false, portableExecutable: 'D:\\x.exe' })).toBe('development')
  })

  it('is installed when nothing says portable', () => {
    expect(installKind({ packaged: true })).toBe('installed')
    expect(installKind({ packaged: true, portableExecutable: undefined })).toBe('installed')
    // An empty string is what an unset environment variable can arrive as, and
    // it must not read as "portable" — that would disable updates for every
    // installed copy.
    expect(installKind({ packaged: true, portableExecutable: '' })).toBe('installed')
  })

  it('is portable when the launcher named the real file', () => {
    expect(installKind({ packaged: true, portableExecutable: 'D:\\Tools\\App.exe' })).toBe(
      'portable',
    )
  })
})

describe('capabilityFor', () => {
  it('lets an installed build check and install', () => {
    expect(capabilityFor('installed')).toEqual({ check: true, install: true })
  })

  /**
   * The portable build unpacks to %TEMP% and runs from there, so there is
   * nothing it could replace: the file the user keeps is elsewhere, and
   * overwriting the unpacked copy updates nothing. Checking still earns its
   * keep — it can say a version exists and open the download page.
   */
  it('lets a portable build check but not install', () => {
    expect(capabilityFor('portable')).toEqual({ check: true, install: false })
  })

  it('does neither in development', () => {
    expect(capabilityFor('development')).toEqual({ check: false, install: false })
  })
})

describe('shouldOffer', () => {
  it('offers a version nobody has declined', () => {
    expect(shouldOffer('1.2.0', null)).toBe(true)
  })

  it('does not ask twice about the same version', () => {
    expect(shouldOffer('1.2.0', '1.2.0')).toBe(false)
  })

  it('asks again once a different version appears', () => {
    expect(shouldOffer('1.3.0', '1.2.0')).toBe(true)
  })
})

describe('timing', () => {
  it('waits before the first check and then spaces them out', () => {
    // Not asserted as exact numbers — the point is the relationship. A first
    // check that fires immediately competes with the first attendance read; an
    // interval shorter than the delay would be a busy loop by accident.
    expect(FIRST_CHECK_DELAY_MS).toBeGreaterThan(5_000)
    expect(CHECK_INTERVAL_MS).toBeGreaterThan(FIRST_CHECK_DELAY_MS)
    expect(CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000)
  })
})

/**
 * The tray entry is the only place a download is visible at all, so what it
 * says is part of the fix rather than decoration: an update that reports
 * nothing for the minutes it takes reads as an entry that did nothing.
 */
describe('updateMenuEntry', () => {
  const t = translatorFor('de')

  it('asks when there is nothing in flight', () => {
    expect(updateMenuEntry(t, { kind: 'idle' })).toEqual({
      label: 'Nach Updates suchen …',
      enabled: true,
    })
  })

  it('reports whole percentages while downloading, and refuses a second click', () => {
    // electron-updater reports fractions; a menu that renders 41.83871 % is
    // reporting the wrong thing about itself.
    expect(updateMenuEntry(t, { kind: 'downloading', percent: 41.83871 })).toEqual({
      label: 'Update wird geladen … 42%',
      enabled: false,
    })
    expect(updateMenuEntry(t, { kind: 'downloading', percent: 0 }).label).toContain('0%')
  })

  /**
   * The second half of a macOS update — Squirrel refetching the archive from
   * the local server — reports no progress at all. Showing 100 % through it
   * would claim the thing is finished while the restart still does nothing,
   * which is the exact confusion this whole change exists to remove.
   */
  it('says it is preparing rather than claiming 100 %', () => {
    expect(updateMenuEntry(t, { kind: 'preparing' })).toEqual({
      label: 'Update wird vorbereitet …',
      enabled: false,
    })
  })

  it('offers the restart, and names the version, once one is staged', () => {
    expect(updateMenuEntry(t, { kind: 'ready', version: '0.2.1' })).toEqual({
      label: 'Zum Installieren von 0.2.1 neu starten',
      enabled: true,
    })
  })
})

/**
 * The flags that decide whether "Restart now" restarts or reopens the setup
 * wizard. Windows-only behaviour, which is exactly why it is arithmetic here
 * rather than something to try on a Windows box.
 */
describe('restartModeFor', () => {
  it('installs silently and relaunches on Windows', () => {
    // `silent` becomes `/S` and `runAfter` becomes `--force-run` on the
    // installer electron-updater spawns. Both, or neither is any use: without
    // `/S` the user gets the whole wizard again, and without `--force-run` the
    // silent install finishes with no app running, because the only thing that
    // would have started it is the finish page `/S` removed.
    expect(restartModeFor('win32')).toEqual({ silent: true, runAfter: true })
  })

  it('leaves macOS to Squirrel', () => {
    // MacUpdater ignores both arguments — the swap and the relaunch are ShipIt's
    // — so passing Windows' answer there would only be misleading.
    expect(restartModeFor('darwin')).toEqual({ silent: false, runAfter: false })
    expect(restartModeFor('linux')).toEqual({ silent: false, runAfter: false })
  })
})

describe('shouldOffer with a skipped version', () => {
  it('holds a skip until a different version shows up', () => {
    expect(shouldOffer('0.3.0', null, '0.3.0')).toBe(false)
    expect(shouldOffer('0.3.1', null, '0.3.0')).toBe(true)
  })

  it('treats "later" and "skip" alike, and either alone is enough', () => {
    expect(shouldOffer('0.3.0', '0.3.0', null)).toBe(false)
    expect(shouldOffer('0.3.0', '0.2.9', '0.2.8')).toBe(true)
  })
})

describe('notesOf', () => {
  it('passes a string through and treats blank as none', () => {
    expect(notesOf({ releaseNotes: '<p>Hi</p>' })).toBe('<p>Hi</p>')
    expect(notesOf({ releaseNotes: '   ' })).toBeNull()
    expect(notesOf({ releaseNotes: null })).toBeNull()
    expect(notesOf({})).toBeNull()
  })

  it('folds a full changelog into one document', () => {
    expect(
      notesOf({ releaseNotes: [{ note: '<p>b</p>' }, { note: '' }, { note: '<p>a</p>' }] }),
    ).toBe('<p>b</p>\n<hr>\n<p>a</p>')
  })
})
