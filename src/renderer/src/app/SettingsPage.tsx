import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { toast } from 'sonner'
import { LANGUAGE_NAMES, LOCALES } from '@shared/i18n'
import type { AppInfo, AppSettings } from '@shared/ipc-contract'
import { useAttendance } from '@renderer/hooks/useAttendance'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTranslate } from '@renderer/hooks/useTranslate'

/** The hour choices for the two long-shift settings; null is "off". */
const HOUR_CHOICES: (number | null)[] = [null, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 24]

/**
 * Every setting the tray used to hold, as a form. One store behind it: each
 * control writes a patch through the same bridge the widget uses, and the
 * push that comes back is what the controls render — no local copy that
 * could show a value the main process refused.
 */
export function SettingsPage(): React.JSX.Element {
  const t = useTranslate()
  const settings = useSettings()
  const snapshot = useAttendance()
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.factorial.getAppInfo().then(setInfo, () => {})
  }, [])

  if (settings === null) return <div className="app-muted pt-7 text-sm">{t('widget.pleaseWait')}</div>

  function set(patch: Partial<AppSettings>): void {
    void window.factorial.setSettings(patch).catch(() => toast.error(t('error.settingsWrite')))
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6 pt-7">
      <Section title={t('settingsPage.general')}>
        <Row label={t('settings.startAtLogin')}>
          <Switch checked={settings.openAtLogin} onChange={(v) => set({ openAtLogin: v })} />
        </Row>
        <Row label={t('settings.language')}>
          <Select
            value={settings.language}
            onChange={(v) => set({ language: v as AppSettings['language'] })}
            options={[
              { value: 'system', label: t('settings.languageSystem') },
              ...LOCALES.map((locale) => ({ value: locale, label: LANGUAGE_NAMES[locale] })),
            ]}
          />
        </Row>
        <Row label={t('settings.appearance')}>
          <Segmented
            value={settings.theme}
            onChange={(v) => set({ theme: v as AppSettings['theme'] })}
            options={[
              { value: 'light', label: t('settings.appearanceLight') },
              { value: 'dark', label: t('settings.appearanceDark') },
              { value: 'system', label: t('settings.appearanceSystem') },
            ]}
          />
        </Row>
      </Section>

      <Section title={t('settingsPage.widget')}>
        <Row label={t('settings.alwaysOnTop')}>
          <Switch checked={settings.alwaysOnTop} onChange={(v) => set({ alwaysOnTop: v })} />
        </Row>
        <Row label={t('settings.expand')}>
          <Segmented
            value={settings.expandDirection}
            onChange={(v) => set({ expandDirection: v as AppSettings['expandDirection'] })}
            options={[
              { value: 'left', label: t('settings.expandLeft') },
              { value: 'right', label: t('settings.expandRight') },
            ]}
          />
        </Row>
      </Section>

      <Section title={t('settingsPage.clockIn')} wide>
        <Row label={t('settingsPage.askLocation')} hint={t('settingsPage.askLocationHint')}>
          <Switch checked={settings.askLocationOnClockIn} onChange={(v) => set({ askLocationOnClockIn: v })} />
        </Row>
        <Row label={t('settingsPage.reminder')} hint={t('settingsPage.reminderHint')}>
          <HoursSelect value={settings.longShiftReminderHours} onChange={(v) => set({ longShiftReminderHours: v })} />
        </Row>
        <Row label={t('settingsPage.autoClockOut')} hint={t('settingsPage.autoClockOutHint')}>
          <HoursSelect value={settings.autoClockOutHours} onChange={(v) => set({ autoClockOutHours: v })} />
        </Row>
      </Section>

      <Section title={t('settingsPage.updates')}>
        <Row label={t('settings.autoInstallUpdates')}>
          <Switch checked={settings.autoInstallUpdates} onChange={(v) => set({ autoInstallUpdates: v })} />
        </Row>
        <Row label={info === null ? '' : t('about.version', { version: info.version })} hint={info === null ? undefined : `Electron ${info.electron} · Chromium ${info.chromium}`}>
          <button type="button" className="app-btn app-btn-secondary" onClick={() => void window.factorial.checkForUpdates().catch(() => {})}>
            {t('settings.checkForUpdates')}
          </button>
        </Row>
      </Section>

      <Section title={t('settingsPage.account')}>
        <Row
          label={snapshot.state.kind === 'unauthenticated' ? t('state.unauthenticated') : t('settingsPage.signedInAs')}
        >
          <button type="button" className="app-btn app-btn-secondary" onClick={() => void window.factorial.signOut().catch(() => {})}>
            {snapshot.state.kind === 'unauthenticated' ? t('tray.signIn') : t('tray.signOut')}
          </button>
        </Row>
      </Section>
    </div>
  )
}

function Section({ title, children, wide = false }: { title: string; children: ReactNode; wide?: boolean }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2" data-wide={wide || undefined}>
      <h2 className="app-eyebrow px-1">{title}</h2>
      <div className="app-card app-divide overflow-hidden">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string | undefined; children: ReactNode }): React.JSX.Element {
  return (
    <label className="flex cursor-default items-center justify-between gap-6 px-[18px] py-3.5">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[15px] font-medium">{label}</span>
        {hint !== undefined && <span className="app-muted text-[13px]">{hint}</span>}
      </span>
      <span className="shrink-0">{children}</span>
    </label>
  )
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }): React.JSX.Element {
  return <button type="button" role="switch" aria-checked={checked} className="app-switch" onClick={() => onChange(!checked)} />
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <span className="app-seg">
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </span>
  )
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <span className="relative inline-flex items-center">
      <select value={value} onChange={(event) => onChange(event.target.value)} className="app-input app-select text-[13px]">
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="app-faint pointer-events-none absolute right-2.5 size-3.5" />
    </span>
  )
}

function HoursSelect({ value, onChange }: { value: number | null; onChange: (value: number | null) => void }): React.JSX.Element {
  const t = useTranslate()
  const choices = HOUR_CHOICES.includes(value) ? HOUR_CHOICES : [...HOUR_CHOICES, value]
  return (
    <Select
      value={value === null ? 'off' : String(value)}
      onChange={(v) => onChange(v === 'off' ? null : Number(v))}
      options={choices.map((hours) => ({
        value: hours === null ? 'off' : String(hours),
        label: hours === null ? t('settingsPage.off') : t('settingsPage.hours', { hours }),
      }))}
    />
  )
}
