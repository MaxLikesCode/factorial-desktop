import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { XIcon } from 'lucide-react'
import { translatorFor } from '@shared/locales'
import type { Translate } from '@shared/i18n'
import {
  formatBytes,
  type UpdateWindowAction,
  type UpdateWindowState,
  type UpdateWindowView,
} from '@shared/update-window'
import { Button } from '@renderer/components/ui/button'
import icon from './app-icon.png'
import { isBlank, sanitiseReleaseNotes } from './release-notes'

/**
 * The update window. One page, seven states, drawn from whatever the main
 * process last said — see `UpdateWindowState` for the seven.
 *
 * Nothing is decided here. Every button sends its action across and waits for
 * the next view; the page never guesses that "install" has started a download,
 * it is told. That keeps the two sides from disagreeing about what is going
 * on, and it makes the page a function of one value, which is the kind of page
 * that is easy to test.
 *
 * The window is frameless, so the top of the page is its title bar: the whole
 * surface is a drag region and the controls opt out of it, the same way the
 * widget's `.no-drag` does.
 */
export function UpdateApp(): React.JSX.Element | null {
  const [view, setView] = useState<UpdateWindowView | null>(null)

  useEffect(() => {
    let alive = true
    void window.updateBridge
      .getView()
      .then((initial) => {
        if (alive && initial !== null) setView(initial)
      })
      .catch(() => {})
    const stop = window.updateBridge.onView((next) => setView(next))
    return () => {
      alive = false
      stop()
    }
  }, [])

  // Escape is the window's close control on the keyboard.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') respond({ kind: 'close' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (view === null) return null
  const t = translatorFor(view.locale)
  const { state } = view

  return (
    <div className="drag-region relative flex h-screen w-screen flex-col overflow-hidden text-foreground">
      <button
        type="button"
        aria-label={t('updateWindow.close')}
        onClick={() => respond({ kind: 'close' })}
        className="no-drag absolute top-3 right-3 z-10 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <XIcon className="size-4" />
      </button>
      {state.kind === 'available' ? (
        <Offer state={state} t={t} />
      ) : state.kind === 'upToDate' ? (
        <Card
          title={t('updateWindow.upToDate')}
          lines={[t('updateWindow.upToDateDetail', { current: state.current })]}
          ok={t('updateWindow.ok')}
        />
      ) : state.kind === 'notice' ? (
        <Card title={state.title} lines={state.lines} ok={t('updateWindow.ok')} />
      ) : (
        <Progress state={state} t={t} />
      )}
    </div>
  )
}

function respond(action: UpdateWindowAction): void {
  void window.updateBridge.respond(action).catch(() => {})
}

function Offer({
  state,
  t,
}: {
  state: Extract<UpdateWindowState, { kind: 'available' }>
  t: Translate
}): React.JSX.Element {
  // Mirrored locally so the box flips on the click rather than on the round
  // trip; the stored value comes back with the next view either way.
  const [autoInstall, setAutoInstall] = useState(state.autoInstall)
  useEffect(() => setAutoInstall(state.autoInstall), [state.autoInstall])

  const notes = useMemo(() => {
    if (state.notes === null) return null
    const clean = sanitiseReleaseNotes(state.notes)
    return isBlank(clean) ? null : clean
  }, [state.notes])

  // Links in the notes open in the browser, never in this window. The main
  // process refuses navigation as well; this is the polite half.
  function onNotesClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const link = (event.target as HTMLElement).closest('a')
    if (link === null) return
    event.preventDefault()
    const href = link.getAttribute('href')
    if (href !== null) void window.updateBridge.openExternal(href).catch(() => {})
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      <div className="flex gap-5">
        <img src={icon} alt="" className="size-16 shrink-0 rounded-2xl" draggable={false} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
          <h1 className="text-lg font-semibold leading-tight">{t('updateWindow.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('updateWindow.summary', { version: state.version, current: state.current })}
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 pl-21">
        <div className="text-sm font-medium">{t('updateWindow.releaseNotes')}</div>
        {notes === null ? (
          <div className="flex-1 rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
            {t('updateWindow.noReleaseNotes')}
          </div>
        ) : (
          <div
            className="release-notes no-drag min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/40 p-4 text-sm"
            onClick={onNotesClick}
            dangerouslySetInnerHTML={{ __html: notes }}
          />
        )}

        <label className="no-drag mt-1 flex cursor-pointer items-center gap-2 text-sm select-none">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={autoInstall}
            onChange={(event) => {
              setAutoInstall(event.target.checked)
              respond({ kind: 'autoInstall', value: event.target.checked })
            }}
          />
          {t('updateWindow.autoInstall')}
        </label>

        <div className="mt-1 flex items-center gap-2">
          <Button variant="secondary" onClick={() => respond({ kind: 'skip' })}>
            {t('updateWindow.skip')}
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" onClick={() => respond({ kind: 'later' })}>
            {t('updateWindow.later')}
          </Button>
          <Button autoFocus onClick={() => respond({ kind: 'install' })}>
            {t('updateWindow.install')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * A centred card with one button: "up to date", the About box, and every
 * one-sentence answer that used to be a native message box.
 */
function Card({
  title,
  lines,
  ok,
}: {
  title: string
  lines: string[]
  ok: string
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-between gap-5 px-8 pt-10 pb-6 text-center">
      <img src={icon} alt="" className="size-20 rounded-2xl" draggable={false} />
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold leading-tight">{title}</h1>
        {lines.map((line, index) => (
          <p key={index} className="text-sm text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
      <Button autoFocus className="w-full" size="lg" onClick={() => respond({ kind: 'close' })}>
        {ok}
      </Button>
    </div>
  )
}

function Progress({
  state,
  t,
}: {
  state: Exclude<UpdateWindowState, { kind: 'available' | 'upToDate' | 'notice' }>
  t: Translate
}): React.JSX.Element {
  const title =
    state.kind === 'downloading'
      ? t('updateWindow.downloading')
      : state.kind === 'preparing'
        ? t('updateWindow.preparing')
        : state.kind === 'ready'
          ? t('updateWindow.ready')
          : t('updateWindow.failedTitle')

  return (
    <div className="flex flex-1 flex-col justify-between gap-5 p-6">
      <div className="flex items-center gap-4">
        <img src={icon} alt="" className="size-12 shrink-0 rounded-xl" draggable={false} />
        <h1 className="text-lg font-semibold leading-tight">{title}</h1>
      </div>

      {state.kind === 'failed' ? (
        <p className="text-sm text-muted-foreground" data-slot="reason">
          {state.reason}
        </p>
      ) : (
        <ProgressBar state={state} />
      )}

      <div className="flex items-center justify-between gap-4">
        <span className="text-sm tabular-nums text-muted-foreground" data-slot="progress">
          {state.kind === 'failed' ? '' : progressText(state, t)}
        </span>
        {state.kind === 'downloading' && (
          <Button variant="secondary" onClick={() => respond({ kind: 'cancel' })}>
            {t('updateWindow.cancel')}
          </Button>
        )}
        {state.kind === 'preparing' && (
          <Button variant="secondary" disabled>
            {t('updateWindow.installAndRelaunch')}
          </Button>
        )}
        {state.kind === 'ready' && (
          <Button autoFocus onClick={() => respond({ kind: 'restart' })}>
            {t('updateWindow.installAndRelaunch')}
          </Button>
        )}
        {state.kind === 'failed' && (
          <Button variant="secondary" onClick={() => respond({ kind: 'close' })}>
            {t('updateWindow.close')}
          </Button>
        )}
      </div>
    </div>
  )
}

function progressText(
  state: Extract<UpdateWindowState, { kind: 'downloading' | 'preparing' | 'ready' }>,
  t: Translate,
): string {
  if (state.total === null) return formatBytes(state.transferred)
  return t('updateWindow.progress', {
    transferred: formatBytes(state.transferred),
    total: formatBytes(state.total),
  })
}

/**
 * Determinate while bytes are counted, full once they all are, and a slow
 * pulse for macOS's second pass, where nothing reports a number — a bar stuck
 * at 100 % would say "done" about something that is not.
 */
function ProgressBar({
  state,
}: {
  state: Extract<UpdateWindowState, { kind: 'downloading' | 'preparing' | 'ready' }>
}): React.JSX.Element {
  const percent =
    state.kind === 'ready'
      ? 100
      : state.total === null || state.total === 0
        ? 0
        : Math.min(100, (state.transferred / state.total) * 100)
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={state.kind === 'preparing' ? undefined : Math.round(percent)}
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={`h-full rounded-full bg-primary transition-[width] duration-200 ${
          state.kind === 'preparing' ? 'w-full animate-pulse opacity-60' : ''
        }`}
        style={state.kind === 'preparing' ? undefined : { width: `${percent}%` }}
      />
    </div>
  )
}
