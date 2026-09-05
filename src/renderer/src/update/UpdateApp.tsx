import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { XIcon } from 'lucide-react'
import { translatorFor } from '@shared/locales'
import type { Translate } from '@shared/i18n'
import {
  formatBytes,
  type UpdateWindowAction,
  type UpdateWindowState,
  type UpdateWindowView,
} from '@shared/update-window'
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
 * It is dressed as the app window, not as a dialog: the same surface gradient,
 * glass cards, pill buttons and title-bar close control, from `app.css`, which
 * this window now imports (see `main.tsx`). Two windows that open from the
 * same tray menu should not look like they came from two programs.
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
    <div className="update-surface drag-region flex h-screen w-screen flex-col overflow-hidden">
      {/* The app window's title bar, minus the entries: an empty strip to
          drag by, with the same close button in the same corner. */}
      <div className="flex h-11 shrink-0 items-center justify-end px-2.5">
        <button
          type="button"
          aria-label={t('updateWindow.close')}
          onClick={() => respond({ kind: 'close' })}
          className="app-window-btn app-window-btn-close no-drag"
        >
          <XIcon />
        </button>
      </div>
      {/*
        Keyed by state so each of the seven states is a fresh mount and
        fades in (`.update-state`) instead of replacing the whole window's
        content in one frame. Enter only; the outgoing state is replaced.
      */}
      <div key={state.kind} className="update-state flex min-h-0 flex-1 flex-col">
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
    </div>
  )
}

function respond(action: UpdateWindowAction): void {
  void window.updateBridge.respond(action).catch(() => {})
}

/** The app's pill button, in the three weights the window uses. */
function Btn({
  variant = 'secondary',
  large = false,
  className = '',
  children,
  ...rest
}: {
  variant?: 'primary' | 'secondary' | 'ghost'
  large?: boolean
  className?: string
  children: ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      className={`app-btn app-btn-${variant} ${large ? 'app-btn-lg' : ''} no-drag ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

function Offer({
  state,
  t,
}: {
  state: Extract<UpdateWindowState, { kind: 'available' }>
  t: Translate
}): React.JSX.Element {
  // Mirrored locally so the switch flips on the click rather than on the round
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

  function toggleAuto(): void {
    setAutoInstall(!autoInstall)
    respond({ kind: 'autoInstall', value: !autoInstall })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-7 pt-1 pb-6">
      <div className="flex items-center gap-4">
        <img src={icon} alt="" className="size-14 shrink-0 rounded-2xl" draggable={false} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-[17px] leading-tight font-semibold">{t('updateWindow.title')}</h1>
          <p className="app-muted text-[13px]">
            {t('updateWindow.summary', { version: state.version, current: state.current })}
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="app-eyebrow px-1">{t('updateWindow.releaseNotes')}</div>
        {notes === null ? (
          <div className="app-card app-muted flex-1 p-4 text-[13px]" style={{ borderRadius: 14 }}>
            {t('updateWindow.noReleaseNotes')}
          </div>
        ) : (
          <div
            className="release-notes app-card app-scroll no-drag min-h-0 flex-1 p-4 text-[13px]"
            style={{ borderRadius: 14 }}
            onClick={onNotesClick}
            dangerouslySetInnerHTML={{ __html: notes }}
          />
        )}
      </div>

      {/* The setting sits on the same row as the answers: it is about every
          future update, not about this one, and a full-width row of its own
          would give it the weight of a question being asked. */}
      <div className="flex items-center gap-3 px-1 select-none">
        <button
          type="button"
          role="switch"
          aria-checked={autoInstall}
          aria-label={t('updateWindow.autoInstall')}
          className="app-switch no-drag"
          onClick={toggleAuto}
        />
        {/* The text is part of the control, as in the settings page: the
            switch is 40 px wide and nobody aims for it. */}
        <span className="app-muted no-drag cursor-pointer text-[13px]" onClick={toggleAuto}>
          {t('updateWindow.autoInstall')}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Btn variant="ghost" onClick={() => respond({ kind: 'skip' })}>
          {t('updateWindow.skip')}
        </Btn>
        <span className="flex-1" />
        <Btn variant="secondary" onClick={() => respond({ kind: 'later' })}>
          {t('updateWindow.later')}
        </Btn>
        <Btn variant="primary" autoFocus onClick={() => respond({ kind: 'install' })}>
          {t('updateWindow.install')}
        </Btn>
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
    <div className="flex flex-1 flex-col items-center justify-between gap-4 px-8 pt-2 pb-6 text-center">
      <img src={icon} alt="" className="size-16 rounded-2xl" draggable={false} />
      <div className="flex flex-col gap-2">
        <h1 className="text-[19px] leading-tight font-semibold">{title}</h1>
        {lines.map((line, index) => (
          <p key={index} className="app-muted app-num text-[13px]">
            {line}
          </p>
        ))}
      </div>
      {/* Wide enough to be the obvious answer, not so wide that a one-word
          button becomes a bar across the window. */}
      <Btn variant="primary" large autoFocus className="min-w-44" onClick={() => respond({ kind: 'close' })}>
        {ok}
      </Btn>
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
    <div className="flex flex-1 flex-col justify-between gap-4 px-6 pt-1 pb-6">
      <div className="flex items-center gap-3.5">
        <img src={icon} alt="" className="size-11 shrink-0 rounded-xl" draggable={false} />
        <h1 className="text-[15px] leading-tight font-semibold">{title}</h1>
      </div>

      {state.kind === 'failed' ? (
        <p className="app-muted text-[13px]" data-slot="reason">
          {state.reason}
        </p>
      ) : (
        <ProgressBar state={state} />
      )}

      <div className="flex items-center justify-between gap-4">
        <span className="app-faint app-num text-[13px]" data-slot="progress">
          {state.kind === 'failed' ? '' : progressText(state, t)}
        </span>
        {state.kind === 'downloading' && (
          <Btn onClick={() => respond({ kind: 'cancel' })}>{t('updateWindow.cancel')}</Btn>
        )}
        {state.kind === 'preparing' && (
          <Btn disabled>{t('updateWindow.installAndRelaunch')}</Btn>
        )}
        {state.kind === 'ready' && (
          <Btn variant="primary" autoFocus onClick={() => respond({ kind: 'restart' })}>
            {t('updateWindow.installAndRelaunch')}
          </Btn>
        )}
        {state.kind === 'failed' && (
          <Btn onClick={() => respond({ kind: 'close' })}>{t('updateWindow.close')}</Btn>
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
      className="update-bar"
    >
      <div
        className={`update-bar-fill ${state.kind === 'preparing' ? 'update-bar-pulse' : ''}`}
        style={state.kind === 'preparing' ? undefined : { width: `${percent}%` }}
      />
    </div>
  )
}
