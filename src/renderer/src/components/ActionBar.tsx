import { Button } from '@renderer/components/ui/button'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { BreakMenu } from './BreakMenu'
import type { AppSnapshot } from '@shared/ipc-contract'

interface Props {
  snapshot: AppSnapshot
  /** True while an action is in flight; every control locks (DESIGN.md, "Optimistische Updates"). */
  busy: boolean
  onClockIn: () => void
  onClockOut: () => void
  onStartBreak: (id: string) => void
  onEndBreak: () => void
  onSignIn: () => void
}

/**
 * Which buttons exist is a function of the state, not of a flag: the store
 * derives the state from `openShift` alone, so there is no way for this bar to
 * offer "Fortsetzen" while the server thinks the shift is running.
 */
export function ActionBar({
  snapshot,
  busy,
  onClockIn,
  onClockOut,
  onStartBreak,
  onEndBreak,
  onSignIn,
}: Props): React.JSX.Element {
  const t = useTranslate()
  const { state, breakOptions } = snapshot

  // An expired session must offer a way out, not a dead disabled button.
  // `signOut` is the right call even here: it drops the rejected cookie and
  // opens the login window (`onSignOut` in `src/main/index.ts`).
  if (state.kind === 'unauthenticated') {
    return (
      <Button size="sm" disabled={busy} onClick={onSignIn}>
        {t('tray.signIn')}
      </Button>
    )
  }

  if (state.kind === 'out') {
    return (
      <Button size="sm" disabled={busy} onClick={onClockIn}>
        {t('tray.clockIn')}
      </Button>
    )
  }

  if (state.kind === 'in') {
    return (
      <div className="flex items-center gap-2">
        <BreakMenu options={breakOptions} disabled={busy} onSelect={onStartBreak} />
        <Button size="sm" variant="outline" disabled={busy} onClick={onClockOut}>
          {t('tray.clockOut')}
        </Button>
      </div>
    )
  }

  if (state.kind === 'break') {
    return (
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={onEndBreak}>
          {t('tray.resume')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onClockOut}>
          {t('tray.clockOut')}
        </Button>
      </div>
    )
  }

  // `unknown`: before the first answer. Not labelled "Einstempeln" — a button
  // that reads like the state is known would be a claim we cannot back.
  return (
    <Button size="sm" variant="outline" disabled>
      {t('widget.pleaseWait')}
    </Button>
  )
}
