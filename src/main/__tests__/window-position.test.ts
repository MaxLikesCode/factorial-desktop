import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EMPTY_POSITION_STORE,
  clampToVisibleArea,
  readPositionStore,
  recordPosition,
  resolveWidgetPosition,
  writePositionStore,
  type DisplayBounds,
  type DisplayInfo,
  type PositionStore,
} from '../window-position'

const SIZE = { width: 340, height: 220 }
const MAIN: DisplayBounds = { x: 0, y: 0, width: 1920, height: 1080 }
const SECOND: DisplayBounds = { x: 1920, y: 0, width: 1280, height: 720 }

describe('clampToVisibleArea', () => {
  it('keeps a position that is fully on a display', () => {
    expect(clampToVisibleArea({ x: 100, y: 100 }, [MAIN], SIZE)).toEqual({ x: 100, y: 100 })
  })

  it('keeps a position on a secondary display', () => {
    expect(clampToVisibleArea({ x: 2000, y: 100 }, [MAIN, SECOND], SIZE)).toEqual({
      x: 2000,
      y: 100,
    })
  })

  it('recentres when the saved display is gone, so the window cannot vanish', () => {
    // Saved on a monitor that is no longer attached.
    const result = clampToVisibleArea({ x: 2000, y: 100 }, [MAIN], SIZE)
    expect(result).toEqual({ x: (1920 - 340) / 2, y: (1080 - 220) / 2 })
  })

  it('pulls a window back that hangs off the right edge', () => {
    const result = clampToVisibleArea({ x: 1900, y: 100 }, [MAIN], SIZE)
    expect(result.x).toBe(1920 - 340)
    expect(result.y).toBe(100)
  })

  it('pulls a window back that hangs off the bottom edge', () => {
    const result = clampToVisibleArea({ x: 100, y: 1000 }, [MAIN], SIZE)
    expect(result.y).toBe(1080 - 220)
  })

  it('pulls a window back from negative coordinates', () => {
    expect(clampToVisibleArea({ x: -200, y: -50 }, [MAIN], SIZE)).toEqual({ x: 0, y: 0 })
  })

  it('centres on the primary display when nothing was saved', () => {
    expect(clampToVisibleArea(null, [MAIN], SIZE)).toEqual({ x: 790, y: 430 })
  })

  it('survives an empty display list without throwing', () => {
    expect(clampToVisibleArea({ x: 10, y: 10 }, [], SIZE)).toEqual({ x: 0, y: 0 })
  })

  it('treats the first display as the primary one, including a negative origin', () => {
    // A monitor placed left of the built-in screen has negative coordinates on
    // both platforms; centring must be relative to the display, not to 0,0.
    const left: DisplayBounds = { x: -1920, y: -200, width: 1920, height: 1080 }
    expect(clampToVisibleArea(null, [left, MAIN], SIZE)).toEqual({ x: -1130, y: 230 })
  })

  it('rounds a centred position to whole pixels', () => {
    const odd: DisplayBounds = { x: 0, y: 0, width: 1001, height: 601 }
    const result = clampToVisibleArea(null, [odd], SIZE)
    expect(Number.isInteger(result.x)).toBe(true)
    expect(Number.isInteger(result.y)).toBe(true)
  })

  it('keeps the top-left corner visible on a display smaller than the window', () => {
    // Clamping to `right - width` would move the window off the left edge here.
    // Losing the bottom-right of the widget is recoverable; losing its title
    // drag region is not.
    const tiny: DisplayBounds = { x: 0, y: 0, width: 200, height: 100 }
    expect(clampToVisibleArea({ x: 50, y: 20 }, [tiny], SIZE)).toEqual({ x: 0, y: 0 })
  })

  it('rejects a saved position with non-finite coordinates', () => {
    expect(clampToVisibleArea({ x: Number.NaN, y: 0 }, [MAIN], SIZE)).toEqual({ x: 790, y: 430 })
  })

  it('picks the display the window covers most of, not the one holding its corner', () => {
    // Top-left is 20px inside MAIN, but 320 of the widget's 340px are on SECOND.
    const result = clampToVisibleArea({ x: 1900, y: 100 }, [MAIN, SECOND], SIZE)
    expect(result).toEqual({ x: 1920, y: 100 })
  })

  it('discards a position that touches no display at all', () => {
    // One pixel short of MAIN's left edge: nothing of the widget would be seen.
    expect(clampToVisibleArea({ x: -340, y: 100 }, [MAIN], SIZE)).toEqual({ x: 790, y: 430 })
  })
})

const MAIN_DISPLAY: DisplayInfo = { id: '1', bounds: MAIN }
const SECOND_DISPLAY: DisplayInfo = { id: '2', bounds: SECOND }

describe('resolveWidgetPosition', () => {
  it('centres on the primary display when nothing was ever saved', () => {
    expect(
      resolveWidgetPosition(EMPTY_POSITION_STORE, [MAIN_DISPLAY, SECOND_DISPLAY], SIZE),
    ).toEqual({ x: 790, y: 430 })
  })

  it('restores the position of the display the widget was last on', () => {
    const store: PositionStore = {
      byDisplay: { '1': { x: 100, y: 100 }, '2': { x: 2000, y: 100 } },
      lastDisplayId: '2',
    }
    expect(resolveWidgetPosition(store, [MAIN_DISPLAY, SECOND_DISPLAY], SIZE)).toEqual({
      x: 2000,
      y: 100,
    })
  })

  it('falls back to a still-attached display when the last one was unplugged', () => {
    const store: PositionStore = {
      byDisplay: { '1': { x: 100, y: 100 }, '2': { x: 2000, y: 100 } },
      lastDisplayId: '2',
    }
    expect(resolveWidgetPosition(store, [MAIN_DISPLAY], SIZE)).toEqual({ x: 100, y: 100 })
  })

  it('centres when no saved display is attached any more', () => {
    const store: PositionStore = { byDisplay: { '2': { x: 2000, y: 100 } }, lastDisplayId: '2' }
    expect(resolveWidgetPosition(store, [MAIN_DISPLAY], SIZE)).toEqual({ x: 790, y: 430 })
  })

  it('clamps a restored position when that display got smaller', () => {
    const store: PositionStore = { byDisplay: { '1': { x: 1900, y: 100 } }, lastDisplayId: '1' }
    const shrunk: DisplayInfo = { id: '1', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
    expect(resolveWidgetPosition(store, [shrunk], SIZE)).toEqual({ x: 1580, y: 100 })
  })

  it('ignores a lastDisplayId that has no saved position', () => {
    const store: PositionStore = { byDisplay: { '1': { x: 100, y: 100 } }, lastDisplayId: '2' }
    expect(resolveWidgetPosition(store, [MAIN_DISPLAY, SECOND_DISPLAY], SIZE)).toEqual({
      x: 100,
      y: 100,
    })
  })

  it('centres when there is no display at all', () => {
    expect(resolveWidgetPosition(EMPTY_POSITION_STORE, [], SIZE)).toEqual({ x: 0, y: 0 })
  })
})

describe('recordPosition', () => {
  const displays = [MAIN_DISPLAY, SECOND_DISPLAY]

  it('files a position under the display that contains it', () => {
    const next = recordPosition(EMPTY_POSITION_STORE, displays, { x: 2000, y: 100 }, SIZE)
    expect(next).toEqual({ byDisplay: { '2': { x: 2000, y: 100 } }, lastDisplayId: '2' })
  })

  it('keeps what other displays remembered', () => {
    const store: PositionStore = { byDisplay: { '1': { x: 10, y: 10 } }, lastDisplayId: '1' }
    const next = recordPosition(store, displays, { x: 2000, y: 100 }, SIZE)
    expect(next.byDisplay['1']).toEqual({ x: 10, y: 10 })
    expect(next.lastDisplayId).toBe('2')
  })

  it('overwrites the entry when the widget moves on the same display', () => {
    const store: PositionStore = { byDisplay: { '1': { x: 10, y: 10 } }, lastDisplayId: '1' }
    expect(recordPosition(store, displays, { x: 20, y: 30 }, SIZE).byDisplay['1']).toEqual({
      x: 20,
      y: 30,
    })
  })

  it('files a window dragged past the left edge under that same display', () => {
    // Negative coordinates are a normal drag result, not a corrupt value.
    const next = recordPosition(EMPTY_POSITION_STORE, displays, { x: -100, y: 40 }, SIZE)
    expect(next).toEqual({ byDisplay: { '1': { x: -100, y: 40 } }, lastDisplayId: '1' })
  })

  it('does not mutate the store it was given', () => {
    const store: PositionStore = { byDisplay: { '1': { x: 10, y: 10 } }, lastDisplayId: '1' }
    recordPosition(store, displays, { x: 2000, y: 100 }, SIZE)
    expect(store).toEqual({ byDisplay: { '1': { x: 10, y: 10 } }, lastDisplayId: '1' })
  })

  it('ignores a position that belongs to no attached display', () => {
    const store: PositionStore = { byDisplay: { '1': { x: 10, y: 10 } }, lastDisplayId: '1' }
    expect(recordPosition(store, displays, { x: 9000, y: 9000 }, SIZE)).toEqual(store)
  })

  it('ignores a non-finite position', () => {
    expect(recordPosition(EMPTY_POSITION_STORE, displays, { x: 0, y: Number.NaN }, SIZE)).toEqual(
      EMPTY_POSITION_STORE,
    )
  })
})

describe('readPositionStore / writePositionStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fd-win-'))
    file = join(dir, 'window-position.json')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns an empty store when the file does not exist', () => {
    expect(readPositionStore(file)).toEqual(EMPTY_POSITION_STORE)
  })

  it('returns an empty store for a corrupt file instead of throwing', () => {
    writeFileSync(file, '{ not json', 'utf8')
    expect(readPositionStore(file)).toEqual(EMPTY_POSITION_STORE)
  })

  it('round-trips a store through the file', () => {
    const store: PositionStore = {
      byDisplay: { '1': { x: 10, y: 20 }, '2': { x: 2000, y: 30 } },
      lastDisplayId: '2',
    }
    writePositionStore(file, store)
    expect(readPositionStore(file)).toEqual(store)
  })

  it('creates the directory on the way', () => {
    const nested = join(dir, 'a', 'b', 'window-position.json')
    writePositionStore(nested, { byDisplay: { '1': { x: 1, y: 2 } }, lastDisplayId: '1' })
    expect(JSON.parse(readFileSync(nested, 'utf8')) as unknown).toEqual({
      byDisplay: { '1': { x: 1, y: 2 } },
      lastDisplayId: '1',
    })
  })

  it('drops entries whose coordinates are not usable numbers', () => {
    writeFileSync(
      file,
      JSON.stringify({
        byDisplay: { '1': { x: 10, y: 20 }, '2': { x: '2000', y: 30 }, '3': null, '4': { x: 1 } },
        lastDisplayId: '1',
      }),
      'utf8',
    )
    expect(readPositionStore(file)).toEqual({
      byDisplay: { '1': { x: 10, y: 20 } },
      lastDisplayId: '1',
    })
  })

  it('drops a lastDisplayId that is not a string', () => {
    writeFileSync(file, JSON.stringify({ byDisplay: {}, lastDisplayId: 7 }), 'utf8')
    expect(readPositionStore(file).lastDisplayId).toBeNull()
  })

  it('returns an empty store when the file holds something that is not an object', () => {
    writeFileSync(file, '[1,2,3]', 'utf8')
    expect(readPositionStore(file)).toEqual(EMPTY_POSITION_STORE)
  })

  it('does not throw when the position cannot be written', () => {
    // The writer runs inside a window `moved` handler; an exception there would
    // take down the main process over a forgotten window position.
    const blocked = join(file, 'window-position.json')
    writeFileSync(file, '{}', 'utf8')
    expect(() => writePositionStore(blocked, EMPTY_POSITION_STORE)).not.toThrow()
  })
})
