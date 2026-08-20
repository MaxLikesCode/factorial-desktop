/**
 * The tray is the only surface that exists when the widget is hidden, and on
 * Windows it is the only one that shows the running time at all. What it says
 * and what it offers is therefore pinned here, in the Electron-free half.
 *
 * Two things these tests exist to prevent:
 *
 * 1. **A wrong or invented time in the menubar.** The label is recomputed from
 *    the snapshot on every render, never counted up, and a clock that jumped
 *    backwards must not produce a negative.
 * 2. **English internals reaching the user.** A tray action rejects with the
 *    store's own English sentence; the tray shows German, from the same table
 *    as the widget's toast.
 */

import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { encodeActionError, type AppSettings, type AppSnapshot } from '@shared/ipc-contract'
import { translatorFor } from '@shared/locales'
import { FactorialError } from '../factorial/client'
import { ACTION_IN_FLIGHT_MESSAGE } from '../attendance'
import {
  buildTrayMenu,
  trayActionErrorText,
  trayLabel,
  trayStatusLine,
  trayTone,
  trayTooltip,
  type TrayActions,
} from '../tray-menu'

const base: AppSnapshot = {
  state: { kind: 'out' },
  todayMinutes: 0,
  daySegments: [],
  incompleteShifts: 0,
  expectedMinutes: null,
  breakOptions: [],
  lastError: null,
  lastErrorKind: null,
  stale: false,
}

/** The assertions below are the German wording, so the tests speak German. */
const t = translatorFor('de')

const NOW = new Date(2026, 7, 12, 11, 0, 0)

const settings: AppSettings = {
  openAtLogin: true,
  alwaysOnTop: true,
  lastLocationType: 'office',
  lastWorkplaceId: null,
  theme: 'system',
  expandDirection: 'right',
  language: 'en',
}

function clockedIn(since: Date): AppSnapshot['state'] {
  return { kind: 'in', shiftId: '1', since, locationType: 'office', workplaceId: null }
}

function onBreak(since: Date): AppSnapshot['state'] {
  return { kind: 'break', shiftId: '1', since, breakId: '19613', breakName: 'Mittagspause', locationType: 'office' }
}

function noopActions(): TrayActions {
  return {
    clockIn: vi.fn(),
    startBreak: vi.fn(),
    endBreak: vi.fn(),
    clockOut: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    toggleWindow: vi.fn(),
    refresh: vi.fn(),
    setOpenAtLogin: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setTheme: vi.fn(),
    setExpandDirection: vi.fn(),
    checkForUpdates: vi.fn(),
    setLanguage: vi.fn(),
    quit: vi.fn(),
  }
}

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.map((item) => (item.type === 'separator' ? '---' : (item.label ?? '')))
}

function itemAt(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = items.find((item) => item.label === label)
  if (!found) throw new Error(`no menu item labelled "${label}" in: ${labels(items).join(' | ')}`)
  return found
}

function submenuOf(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  if (!Array.isArray(item.submenu)) throw new Error(`"${item.label}" has no submenu array`)
  return item.submenu
}

/**
 * Electron calls a click handler with `(menuItem, browserWindow, event)`. None
 * of the handlers built here reads any of them, so the test calls them without —
 * the cast is a test-only convenience, not a production shortcut.
 */
function fire(item: MenuItemConstructorOptions | undefined): void {
  const click = item?.click
  if (!click) throw new Error(`"${item?.label ?? '?'}" has no click handler`)
  ;(click as unknown as () => void)()
}

describe('trayLabel', () => {
  it('is empty when clocked out, so the menubar stays uncluttered', () => {
    expect(trayLabel(t, base, NOW)).toBe('')
  })

  it('shows hours and minutes while clocked in', () => {
    expect(trayLabel(t, { ...base, state: clockedIn(new Date(2026, 7, 12, 9, 30, 0)) }, NOW)).toBe(
      '1:30',
    )
  })

  it('adds the day’s closed shifts, so it matches the widget’s ring', () => {
    // An earlier draft showed the running segment
    // alone: the widget's ring centre shows the day's worked time, and two
    // surfaces of one app disagreeing about "how long today" is the kind of
    // divergence DESIGN.md's "eine Wahrheit" exists to prevent.
    const snapshot: AppSnapshot = {
      ...base,
      todayMinutes: 240,
      state: clockedIn(new Date(2026, 7, 12, 10, 30, 0)),
    }
    expect(trayLabel(t, snapshot, NOW)).toBe('4:30')
  })

  it('marks a break with the German word, not a glyph', () => {
    // The plan used "❙❙". Windows renders such block glyphs as an emoji or a
    // replacement box in tooltips and menus — the same reason Task 11 dropped
    // it from the widget: on Windows they render as emoji or as tofu.
    const snapshot: AppSnapshot = { ...base, state: onBreak(new Date(2026, 7, 12, 10, 45, 0)) }
    expect(trayLabel(t, snapshot, NOW)).toBe('Pause 0:15')
  })

  it('counts the break itself, not the day, while paused', () => {
    const snapshot: AppSnapshot = {
      ...base,
      todayMinutes: 240,
      state: onBreak(new Date(2026, 7, 12, 10, 45, 0)),
    }
    expect(trayLabel(t, snapshot, NOW)).toBe('Pause 0:15')
  })

  it('is empty while the state is still unknown', () => {
    expect(trayLabel(t, { ...base, state: { kind: 'unknown' } }, NOW)).toBe('')
  })

  it('is empty when the session is gone rather than showing a frozen time', () => {
    expect(trayLabel(t, { ...base, state: { kind: 'unauthenticated' } }, NOW)).toBe('')
  })

  it('does not render a negative time when the clock is skewed', () => {
    const snapshot: AppSnapshot = { ...base, state: clockedIn(new Date(2026, 7, 12, 11, 5, 0)) }
    expect(trayLabel(t, snapshot, NOW)).toBe('0:00')
  })

  it('does not cap the hours at a day', () => {
    const snapshot: AppSnapshot = { ...base, state: clockedIn(new Date(2026, 7, 11, 8, 0, 0)) }
    expect(trayLabel(t, snapshot, NOW)).toBe('27:00')
  })
})

describe('trayStatusLine', () => {
  it('names the state in German when there is no time to show', () => {
    expect(trayStatusLine(t, base, NOW)).toBe('Ausgestempelt')
    expect(trayStatusLine(t, { ...base, state: { kind: 'unknown' } }, NOW)).toBe('Lädt …')
    expect(trayStatusLine(t, { ...base, state: { kind: 'unauthenticated' } }, NOW)).toBe(
      'Nicht angemeldet',
    )
  })

  it('reports the day’s time after clocking out', () => {
    expect(trayStatusLine(t, { ...base, todayMinutes: 480 }, NOW)).toBe('Ausgestempelt · heute 8:00')
  })

  it('carries the running time, which is all Windows has to show it', () => {
    const snapshot: AppSnapshot = { ...base, state: clockedIn(new Date(2026, 7, 12, 9, 30, 0)) }
    expect(trayStatusLine(t, snapshot, NOW)).toBe('Eingestempelt · 1:30')
  })

  it('names the break and how long it has run', () => {
    const snapshot: AppSnapshot = { ...base, state: onBreak(new Date(2026, 7, 12, 10, 45, 0)) }
    expect(trayStatusLine(t, snapshot, NOW)).toBe('In einer Pause · Mittagspause · 0:15')
  })

  it('says the numbers are old instead of passing them off as current', () => {
    const snapshot: AppSnapshot = {
      ...base,
      state: clockedIn(new Date(2026, 7, 12, 9, 30, 0)),
      stale: true,
      lastError: 'request timed out after 15000 ms',
      lastErrorKind: 'network',
    }
    // German from the shared table, not the internal English sentence.
    expect(trayStatusLine(t, snapshot, NOW)).toBe('Eingestempelt · 1:30 · keine Verbindung')
    expect(trayStatusLine(t, snapshot, NOW)).not.toContain('timed out')
  })

  it('flags an incomplete day sum (C4) rather than understating it silently', () => {
    const snapshot: AppSnapshot = { ...base, todayMinutes: 60, incompleteShifts: 1 }
    expect(trayStatusLine(t, snapshot, NOW)).toBe('Ausgestempelt · heute 1:00 · unvollständig')
  })
})

describe('trayTooltip', () => {
  it('names the app, because a tray icon has no other caption', () => {
    const snapshot: AppSnapshot = { ...base, state: clockedIn(new Date(2026, 7, 12, 9, 30, 0)) }
    // On Windows this tooltip is the only place the running time appears
    // outside the menu, since `setTitle` does not exist there.
    expect(trayTooltip(t, snapshot, NOW)).toBe('Factorial · Eingestempelt · 1:30')
  })
})

describe('trayTone', () => {
  it('has one tone per state, for the colour-coded Windows icon', () => {
    expect(trayTone(base)).toBe('idle')
    expect(trayTone({ ...base, state: { kind: 'unknown' } })).toBe('idle')
    expect(trayTone({ ...base, state: clockedIn(NOW) })).toBe('active')
    expect(trayTone({ ...base, state: onBreak(NOW) })).toBe('paused')
    expect(trayTone({ ...base, state: { kind: 'unauthenticated' } })).toBe('alert')
  })
})

describe('buildTrayMenu', () => {
  function menu(snapshot: AppSnapshot, overrides: Partial<Parameters<typeof buildTrayMenu>[0]> = {}) {
    return buildTrayMenu({
    t,
      snapshot,
      now: NOW,
      windowVisible: true,
      lastActionError: null,
      settings,
      actions: noopActions(),
      ...overrides,
    })
  }

  it('starts with the status line as a disabled entry', () => {
    // This entry is where Windows reads the running time.
    const items = menu({ ...base, state: clockedIn(new Date(2026, 7, 12, 9, 30, 0)) })
    expect(items[0]?.label).toBe('Eingestempelt · 1:30')
    expect(items[0]?.enabled).toBe(false)
  })

  it('offers only clocking in while clocked out', () => {
    expect(labels(menu(base))).toEqual([
      'Ausgestempelt',
      '---',
      'Einstempeln',
      '---',
      'Fenster ausblenden',
      'Aktualisieren',
      'Einstellungen',
      '---',
      'Beenden',
    ])
  })

  it('offers the real break types as a submenu while clocked in', () => {
    const snapshot: AppSnapshot = {
      ...base,
      state: clockedIn(NOW),
      breakOptions: [
        { id: '19613', name: 'Mittagspause' },
        { id: '20261', name: 'Arztbesuch' },
      ],
    }
    const actions = noopActions()
    const items = menu(snapshot, { actions })
    const pause = itemAt(items, 'Pause')
    expect(pause.enabled).not.toBe(false)
    expect(submenuOf(pause).map((entry) => entry.label)).toEqual(['Mittagspause', 'Arztbesuch'])

    fire(submenuOf(pause)[1])
    expect(actions.startBreak).toHaveBeenCalledWith('20261')
    expect(labels(items)).toContain('Ausstempeln')
  })

  it('disables the break entry while the types have not arrived', () => {
    // An empty list means "not loaded yet", never "no breaks configured" — the
    // store only ever fills it from the API.
    const pause = itemAt(menu({ ...base, state: clockedIn(NOW) }), 'Pause')
    expect(pause.enabled).toBe(false)
    expect(pause.submenu).toBeUndefined()
  })

  it('offers resuming and clocking out while on a break', () => {
    const items = menu({ ...base, state: onBreak(NOW) })
    expect(labels(items)).toContain('Fortsetzen')
    expect(labels(items)).toContain('Ausstempeln')
    expect(labels(items)).not.toContain('Pause')
  })

  it('offers a sign-in and nothing that would write a time when the session is gone', () => {
    const items = menu({ ...base, state: { kind: 'unauthenticated' } })
    expect(labels(items)).toContain('Anmelden')
    expect(labels(items)).not.toContain('Einstempeln')
    expect(labels(items)).not.toContain('Ausstempeln')
  })

  it('offers no clock action at all before the first answer', () => {
    const items = menu({ ...base, state: { kind: 'unknown' } })
    for (const label of ['Einstempeln', 'Ausstempeln', 'Pause', 'Fortsetzen', 'Anmelden']) {
      expect(labels(items)).not.toContain(label)
    }
    expect(labels(items)).toContain('Aktualisieren')
  })

  it('says whether the window would be shown or hidden', () => {
    expect(labels(menu(base, { windowVisible: false }))).toContain('Fenster zeigen')
    expect(labels(menu(base, { windowVisible: true }))).toContain('Fenster ausblenden')
  })

  it('always keeps a way out of the app', () => {
    // Without this entry a Windows user has no way to quit,
    // because closing the widget only hides it and `skipTaskbar` is set.
    const actions = noopActions()
    const items = menu({ ...base, state: { kind: 'unknown' } }, { actions })
    fire(itemAt(items, 'Beenden'))
    expect(actions.quit).toHaveBeenCalledOnce()
  })

  it('shows the last failed tray action in German, below the status line', () => {
    const items = menu(base, { lastActionError: 'Die Aktion ist fehlgeschlagen.' })
    expect(items[1]?.label).toBe('Die Aktion ist fehlgeschlagen.')
    expect(items[1]?.enabled).toBe(false)
  })

  describe('the break line', () => {
    /**
     * Asked for after a day where the break was invisible everywhere: the tray
     * menu is where you look when the widget is behind something.
     */
    it('sits directly under the status, where the eye already is', () => {
      const items = menu({
        ...base,
        state: clockedIn(NOW),
        daySegments: [
          { kind: 'work', minutes: 270 },
          { kind: 'break', minutes: 33 },
        ],
      })
      expect(labels(items)[1]).toBe('Pause heute 0:33')
      expect(items[1]?.enabled).toBe(false)
    })

    it('counts a break that is still running', () => {
      const items = menu({
        ...base,
        state: onBreak(new Date(NOW.getTime() - 12 * 60_000)),
        daySegments: [{ kind: 'break', minutes: 20 }],
      })
      // 20 minutes closed plus 12 running.
      expect(labels(items)[1]).toBe('Pause heute 0:32')
    })

    /** A zero would be a reminder nobody asked for, every morning. */
    it('says nothing on a day without a break', () => {
      const items = menu({ ...base, state: clockedIn(NOW), daySegments: [{ kind: 'work', minutes: 90 }] })
      expect(labels(items)[1]).not.toContain('Pause heute')
    })
  })

  describe('Einstellungen', () => {
    // DESIGN.md, "Tray": the context menu carries "Einstellungen", and
    // DESIGN.md, "Einstellungen" names exactly these three items. The tray is
    // the app's only surface for them — the widget shows "Anmelden" only while
    // the session is gone and has no settings UI at all.
    it('is offered in every state, because there is no other settings surface', () => {
      for (const state of [
        base.state,
        clockedIn(NOW),
        onBreak(NOW),
        { kind: 'unknown' } as const,
        { kind: 'unauthenticated' } as const,
      ]) {
        expect(labels(menu({ ...base, state }))).toContain('Einstellungen')
      }
    })

    it('shows the two toggles as checkboxes reflecting what is stored', () => {
      const entries = submenuOf(itemAt(menu(base), 'Einstellungen'))
      const autostart = itemAt(entries, 'Autostart')
      const onTop = itemAt(entries, 'Immer im Vordergrund')

      expect(autostart.type).toBe('checkbox')
      expect(onTop.type).toBe('checkbox')
      expect(autostart.checked).toBe(true)
      expect(onTop.checked).toBe(true)

      const off = submenuOf(
        itemAt(
          menu(base, { settings: { ...settings, openAtLogin: false, alwaysOnTop: false } }),
          'Einstellungen',
        ),
      )
      expect(itemAt(off, 'Autostart').checked).toBe(false)
      expect(itemAt(off, 'Immer im Vordergrund').checked).toBe(false)
    })

    it('offers both directions as radios and writes the one it names', () => {
      const actions = noopActions()
      const directions = submenuOf(
        itemAt(submenuOf(itemAt(menu(base, { actions }), 'Einstellungen')), 'Aufklappen'),
      )

      expect(directions.map((entry) => entry.label)).toEqual(['Nach rechts', 'Nach links'])
      for (const entry of directions) expect(entry.type).toBe('radio')
      // The fixture stores 'right', the direction that shipped first.
      expect(directions.map((entry) => entry.checked)).toEqual([true, false])

      fire(directions[1])
      expect(actions.setExpandDirection).toHaveBeenCalledWith('left')
    })

    it('offers the appearance as three radios, with the stored one marked', () => {
      const entries = submenuOf(itemAt(menu(base), 'Einstellungen'))
      const theme = submenuOf(itemAt(entries, 'Erscheinungsbild'))

      expect(theme.map((entry) => entry.label)).toEqual(['Systemvorgabe', 'Hell', 'Dunkel'])
      for (const entry of theme) expect(entry.type).toBe('radio')
      // The fixture stores 'system'.
      expect(theme.map((entry) => entry.checked)).toEqual([true, false, false])

      const dark = submenuOf(
        itemAt(
          submenuOf(
            itemAt(menu(base, { settings: { ...settings, theme: 'dark' } }), 'Einstellungen'),
          ),
          'Erscheinungsbild',
        ),
      )
      expect(dark.map((entry) => entry.checked)).toEqual([false, false, true])
    })

    it('writes the value it names, not the radio item’s own state', () => {
      // Same trap as the checkboxes: Electron sets a radio's `checked` on click
      // before the handler runs, so reading it back would tell the handler
      // nothing but "you were clicked".
      const actions = noopActions()
      const theme = submenuOf(
        itemAt(submenuOf(itemAt(menu(base, { actions }), 'Einstellungen')), 'Erscheinungsbild'),
      )

      fire(theme[2])
      expect(actions.setTheme).toHaveBeenCalledWith('dark')
      fire(theme[0])
      expect(actions.setTheme).toHaveBeenCalledWith('system')
    })

    it('writes the opposite of the stored value, not of the menu item’s own state', () => {
      // Electron flips a checkbox item's `checked` on click by itself. The
      // handler must ask the settings for the value it inverts, otherwise a
      // menu built from a stale render would write back what is already there.
      const actions = noopActions()
      const entries = submenuOf(itemAt(menu(base, { actions }), 'Einstellungen'))

      fire(itemAt(entries, 'Autostart'))
      expect(actions.setOpenAtLogin).toHaveBeenCalledWith(false)

      fire(itemAt(entries, 'Immer im Vordergrund'))
      expect(actions.setAlwaysOnTop).toHaveBeenCalledWith(false)

      const offActions = noopActions()
      const off = submenuOf(
        itemAt(
          menu(base, {
            actions: offActions,
            settings: { ...settings, openAtLogin: false, alwaysOnTop: false },
          }),
          'Einstellungen',
        ),
      )
      fire(itemAt(off, 'Autostart'))
      expect(offActions.setOpenAtLogin).toHaveBeenCalledWith(true)
      fire(itemAt(off, 'Immer im Vordergrund'))
      expect(offActions.setAlwaysOnTop).toHaveBeenCalledWith(true)
    })

    it('offers "Abmelden" while there is a session to drop', () => {
      const actions = noopActions()
      const entries = submenuOf(itemAt(menu(base, { actions }), 'Einstellungen'))
      fire(itemAt(entries, 'Abmelden'))
      expect(actions.signOut).toHaveBeenCalledOnce()
    })

    it('does not offer "Abmelden" when the session is already gone', () => {
      // The top-level entry there is "Anmelden", which runs the same code;
      // offering both at once would name one action twice, with opposite words.
      const items = menu({ ...base, state: { kind: 'unauthenticated' } })
      const entries = submenuOf(itemAt(items, 'Einstellungen'))
      expect(entries.map((entry) => entry.label)).not.toContain('Abmelden')
      expect(labels(items)).toContain('Anmelden')
    })
  })
})

describe('trayActionErrorText', () => {
  it('turns the store’s in-flight refusal into German', () => {
    // The race this exists for: a click in the tray menu and a click in the
    // widget land in the store at the same time; the second one is refused.
    const text = trayActionErrorText(t, new Error(ACTION_IN_FLIGHT_MESSAGE))
    expect(text).toBe('Es läuft bereits eine Aktion. Bitte einen Moment warten.')
    expect(text).not.toContain('in flight')
  })

  it('turns a hung request into "keine Verbindung"', () => {
    const text = trayActionErrorText(t, 
      new FactorialError('network', 'request timed out after 15000 ms'),
    )
    expect(text).toBe('Keine Verbindung zu Factorial. Es wurde nichts gespeichert.')
    expect(text).not.toContain('15000')
  })

  it('keeps Factorial’s own wording for a rejected mutation', () => {
    const text = trayActionErrorText(t, 
      new FactorialError('graphql', 'Shift overlaps an existing one'),
    )
    expect(text).toBe('Factorial hat die Aktion abgelehnt: Shift overlaps an existing one')
  })

  it('says the session expired instead of showing the HTTP status', () => {
    const text = trayActionErrorText(t, new FactorialError('unauthenticated', 'session rejected (HTTP 401)'))
    expect(text).toBe('Die Sitzung ist abgelaufen. Bitte neu anmelden.')
    expect(text).not.toContain('401')
  })

  it('also understands an error that already crossed IPC', () => {
    // Not the tray's own path today, but the codec is the shared one and a
    // double-encoded message must not reach a menu.
    const text = trayActionErrorText(t, new Error(encodeActionError('busy', 'whatever')))
    expect(text).toBe('Es läuft bereits eine Aktion. Bitte einen Moment warten.')
  })

  it('survives a thrown non-Error', () => {
    expect(trayActionErrorText(t, 'nope')).toBe('Die Aktion ist fehlgeschlagen.')
  })
})
