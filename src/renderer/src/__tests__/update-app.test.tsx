import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateWindowView } from '@shared/update-window'
import { UpdateApp } from '@renderer/update/UpdateApp'

/**
 * A bridge that remembers what it was told and can push a view, standing in
 * for `src/preload/update.ts` the way `fake-bridge.ts` stands in for the
 * widget's.
 */
function installBridge(initial: UpdateWindowView | null): {
  respond: ReturnType<typeof vi.fn>
  openExternal: ReturnType<typeof vi.fn>
  push: (view: UpdateWindowView) => void
} {
  let listener: ((view: UpdateWindowView) => void) | null = null
  const respond = vi.fn(() => Promise.resolve())
  const openExternal = vi.fn(() => Promise.resolve())
  window.updateBridge = {
    getView: () => Promise.resolve(initial),
    onView: (callback) => {
      listener = callback
      return () => {
        listener = null
      }
    },
    respond,
    openExternal,
  }
  return { respond, openExternal, push: (view) => listener?.(view) }
}

const OFFER: UpdateWindowView = {
  locale: 'en',
  state: {
    kind: 'available',
    version: '0.3.0',
    current: '0.2.13',
    notes: '<h2>Fixes</h2><ul><li>Drag no longer <b>sticks</b></li></ul><p><a href="https://example.com/x">More</a></p>',
    autoInstall: false,
  },
}

async function mount(initial: UpdateWindowView | null): Promise<ReturnType<typeof installBridge>> {
  const bridge = installBridge(initial)
  await act(async () => {
    render(<UpdateApp />)
  })
  return bridge
}

afterEach(cleanup)

describe('the offer', () => {
  it('names both versions and shows the notes, sanitised', async () => {
    await mount(OFFER)
    expect(screen.getByText(/0\.3\.0 is now available/)).toBeTruthy()
    expect(screen.getByText(/you have 0\.2\.13/)).toBeTruthy()
    expect(screen.getByText('Fixes')).toBeTruthy()
    expect(screen.getByText('sticks')).toBeTruthy()
  })

  it('has the three answers and the checkbox, each sent as its own action', async () => {
    const bridge = await mount(OFFER)
    fireEvent.click(screen.getByText('Skip this version'))
    fireEvent.click(screen.getByText('Remind me later'))
    fireEvent.click(screen.getByText('Install update'))
    fireEvent.click(screen.getByLabelText(/Automatically download/))
    expect(bridge.respond.mock.calls.map((call) => call[0])).toEqual([
      { kind: 'skip' },
      { kind: 'later' },
      { kind: 'install' },
      { kind: 'autoInstall', value: true },
    ])
  })

  it('opens links outside rather than navigating the window', async () => {
    const bridge = await mount(OFFER)
    fireEvent.click(screen.getByText('More'))
    expect(bridge.openExternal).toHaveBeenCalledWith('https://example.com/x')
  })

  it('says so when a release has no notes', async () => {
    await mount({ ...OFFER, state: { ...OFFER.state, notes: null } as UpdateWindowView['state'] })
    expect(screen.getByText('This release has no notes.')).toBeTruthy()
  })

  it('speaks the language it was given', async () => {
    await mount({ ...OFFER, locale: 'de' })
    expect(screen.getByText('Update installieren')).toBeTruthy()
  })
})

describe('the download', () => {
  it('follows the pushed views from downloading to ready', async () => {
    const bridge = await mount(OFFER)
    await act(async () => {
      bridge.push({
        locale: 'en',
        state: { kind: 'downloading', version: '0.3.0', transferred: 31_900_000, total: 59_000_000 },
      })
    })
    expect(screen.getByText('Downloading update …')).toBeTruthy()
    expect(screen.getByText('31.9 MB of 59.0 MB')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('54')

    fireEvent.click(screen.getByText('Cancel'))
    expect(bridge.respond).toHaveBeenLastCalledWith({ kind: 'cancel' })

    await act(async () => {
      bridge.push({
        locale: 'en',
        state: { kind: 'ready', version: '0.3.0', transferred: 59_000_000, total: 59_000_000 },
      })
    })
    expect(screen.getByText('Ready to install')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
    fireEvent.click(screen.getByText('Install and relaunch'))
    expect(bridge.respond).toHaveBeenLastCalledWith({ kind: 'restart' })
  })

  it('shows the reason when it fails', async () => {
    await mount({
      locale: 'en',
      state: { kind: 'failed', version: '0.3.0', reason: 'net::ERR_INTERNET_DISCONNECTED' },
    })
    expect(screen.getByText('The update could not be downloaded')).toBeTruthy()
    expect(screen.getByText('net::ERR_INTERNET_DISCONNECTED')).toBeTruthy()
  })
})

describe('up to date', () => {
  it('names the installed version and closes on OK', async () => {
    const bridge = await mount({ locale: 'en', state: { kind: 'upToDate', current: '0.3.0' } })
    expect(screen.getByText('You’re up to date!')).toBeTruthy()
    expect(screen.getByText(/0\.3\.0 is currently the newest/)).toBeTruthy()
    fireEvent.click(screen.getByText('OK'))
    expect(bridge.respond).toHaveBeenLastCalledWith({ kind: 'close' })
  })
})

describe('a notice', () => {
  it('shows the lines it was given and closes on OK', async () => {
    const bridge = await mount({
      locale: 'de',
      state: { kind: 'notice', title: 'Factorial Desktop', lines: ['Version 0.3.1', 'Electron 43'] },
    })
    expect(screen.getByText('Factorial Desktop')).toBeTruthy()
    expect(screen.getByText('Version 0.3.1')).toBeTruthy()
    expect(screen.getByText('Electron 43')).toBeTruthy()
    fireEvent.click(screen.getByText('OK'))
    expect(bridge.respond).toHaveBeenLastCalledWith({ kind: 'close' })
  })
})

describe('closing', () => {
  it('sends close for the X and for Escape, and leaves the meaning to the main process', async () => {
    const bridge = await mount(OFFER)
    fireEvent.click(screen.getByLabelText('Close'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(bridge.respond.mock.calls.map((call) => call[0])).toEqual([
      { kind: 'close' },
      { kind: 'close' },
    ])
  })
})
