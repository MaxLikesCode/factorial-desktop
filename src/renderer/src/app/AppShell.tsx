import { useEffect, useState } from 'react'
import { CalendarDaysIcon, HouseIcon, SettingsIcon, type LucideIcon } from 'lucide-react'
import type { MainWindowPage } from '@shared/ipc-contract'
import type { MessageKey } from '@shared/i18n'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { Toaster } from '@renderer/components/ui/sonner'
import { OverviewPage } from './OverviewPage'
import { SettingsPage } from './SettingsPage'
import { TimesheetPage } from './TimesheetPage'

const NAV: { page: MainWindowPage; icon: LucideIcon; tint: string; key: MessageKey }[] = [
  { page: 'overview', icon: HouseIcon, tint: 'bg-orange-500', key: 'app.overview' },
  { page: 'timesheet', icon: CalendarDaysIcon, tint: 'bg-sky-500', key: 'app.timesheet' },
  { page: 'settings', icon: SettingsIcon, tint: 'bg-neutral-500', key: 'app.settings' },
]

/**
 * The app window: a sidebar of three sections and the section itself.
 *
 * The section is plain state, not a router — three pages do not need one,
 * and the main process can set it by pushing a page name (`onNavigate`),
 * which is how "Timesheet …" in the tray lands on the timesheet.
 *
 * The top 40 px of both columns are the title bar: the platform paints its
 * window controls over that strip (`titleBarOverlay` in main-window.ts), and
 * dragging it moves the window.
 */
export function AppShell(): React.JSX.Element {
  const t = useTranslate()
  const [page, setPage] = useState<MainWindowPage>('overview')

  useEffect(() => window.factorial.onNavigate(setPage), [])

  return (
    <div className="flex h-screen w-screen text-foreground">
      <aside className="flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
        <div className="titlebar" />
        <nav className="flex flex-col gap-1 px-3">
          {NAV.map(({ page: target, icon: Icon, tint, key }) => {
            const active = target === page
            return (
              <button
                key={target}
                type="button"
                onClick={() => setPage(target)}
                aria-current={active ? 'page' : undefined}
                className={`no-drag flex items-center gap-3 rounded-lg px-3 py-2 text-left text-[15px] font-medium transition-colors ${
                  active
                    ? 'bg-foreground/10 text-foreground'
                    : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                }`}
              >
                <span className={`flex size-7 items-center justify-center rounded-md ${tint} text-white`}>
                  <Icon className="size-4" />
                </span>
                {t(key)}
              </button>
            )
          })}
        </nav>
        <div className="flex-1" />
        <div className="px-4 pb-4 text-xs font-medium text-muted-foreground">Factorial Desktop</div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <div className="titlebar flex items-center px-8 text-sm font-medium text-muted-foreground">
          {t(NAV.find((n) => n.page === page)?.key ?? 'app.overview')}
        </div>
        <div className="app-scroll flex-1 px-8 pb-10">
          {page === 'overview' && <OverviewPage onEditToday={() => setPage('timesheet')} />}
          {page === 'timesheet' && <TimesheetPage />}
          {page === 'settings' && <SettingsPage />}
        </div>
      </main>
      <Toaster position="bottom-right" />
    </div>
  )
}
