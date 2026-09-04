import { useEffect, useState } from 'react'
import { CalendarDaysIcon, HouseIcon, SettingsIcon, type LucideIcon } from 'lucide-react'
import type { AppInfo, MainWindowPage } from '@shared/ipc-contract'
import type { MessageKey } from '@shared/i18n'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { Toaster } from '@renderer/components/ui/sonner'
import logo from '../update/app-icon.png'
import { OverviewPage } from './OverviewPage'
import { SettingsPage } from './SettingsPage'
import { TimesheetPage } from './TimesheetPage'

/** Where the traffic lights are — the one platform fact this page needs. */
const MAC = navigator.platform.toLowerCase().includes('mac')

const NAV: { page: MainWindowPage; icon: LucideIcon; tint: string; key: MessageKey }[] = [
  { page: 'overview', icon: HouseIcon, tint: 'linear-gradient(180deg, #ff9a3c, #ef6a1f)', key: 'app.overview' },
  { page: 'timesheet', icon: CalendarDaysIcon, tint: 'linear-gradient(180deg, #5aa9ff, #2f7be6)', key: 'app.timesheet' },
  { page: 'settings', icon: SettingsIcon, tint: 'linear-gradient(180deg, #8d8d94, #64646b)', key: 'app.settings' },
]

/**
 * The app window: a sidebar of three sections and the section itself.
 *
 * The section is plain state, not a router — three pages do not need one,
 * and the main process can set it by pushing a page name (`onNavigate`),
 * which is how "Timesheet …" in the tray lands on the timesheet.
 *
 * The top of both columns is the title bar: the platform paints its window
 * controls over the content column's strip (`titleBarOverlay` in
 * main-window.ts), dragging either strip moves the window, and a page may
 * put its own controls into the content strip through `headerSlot`.
 */
export function AppShell(): React.JSX.Element {
  const t = useTranslate()
  const [page, setPage] = useState<MainWindowPage>('overview')
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => window.factorial.onNavigate(setPage), [])
  useEffect(() => {
    void window.factorial.getAppInfo().then(setInfo, () => {})
  }, [])

  return (
    <div className="flex h-screen w-screen">
      <aside
        // The same 12 px above the first entry as beside it. PLATFORM: macOS
        // paints its traffic lights over this corner, so there the column
        // starts below them.
        className={`flex w-[232px] shrink-0 flex-col px-3 pb-3 ${MAC ? 'pt-9' : 'pt-3'}`}
        style={{ background: 'var(--app-sidebar)' }}
      >
        <nav className="flex flex-col gap-1">
          {NAV.map(({ page: target, icon: Icon, tint, key }) => (
            <button
              key={target}
              type="button"
              onClick={() => setPage(target)}
              aria-current={target === page ? 'page' : undefined}
              className="app-nav no-drag"
            >
              <span className="app-nav-tile" style={{ background: tint }}>
                <Icon className="size-4" />
              </span>
              {t(key)}
            </button>
          ))}
        </nav>
        <div className="flex-1" />
        <div className="app-card flex items-center gap-2.5 px-3 py-2.5" style={{ borderRadius: 12 }}>
          <img src={logo} alt="" className="size-7 shrink-0 rounded-lg" draggable={false} />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold">Factorial Desktop</span>
            {info !== null && (
              <span className="app-faint text-[11px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {t('about.version', { version: info.version })}
              </span>
            )}
          </span>
        </div>
      </aside>

      <main className="app-surface flex min-w-0 flex-1 flex-col">
        <div className="titlebar flex h-14 shrink-0 items-center justify-between px-7 text-[13px] font-medium app-muted" style={{ borderBottom: '1px solid var(--app-line)' }}>
          <div ref={setHeaderSlot} className="flex min-w-0 flex-1 items-center">
            {page !== 'timesheet' && <span>{t(NAV.find((n) => n.page === page)?.key ?? 'app.overview')}</span>}
          </div>
        </div>
        <div className="app-scroll flex-1 px-8 pb-10">
          {page === 'overview' && <OverviewPage onEditToday={() => setPage('timesheet')} />}
          {page === 'timesheet' && <TimesheetPage headerSlot={headerSlot} />}
          {page === 'settings' && <SettingsPage />}
        </div>
      </main>
      <Toaster position="bottom-right" />
    </div>
  )
}
