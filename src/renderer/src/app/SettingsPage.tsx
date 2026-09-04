import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { LANGUAGE_NAMES, LOCALES } from '@shared/i18n'
import type { AppInfo, AppSettings } from '@shared/ipc-contract'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { Button } from '@renderer/components/ui/button'

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
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.factorial.getAppInfo().then(setInfo, () => {})
  }, [])

  if (settings === null) return <div className="pt-6 text-sm text-muted-foreground">{t('widget.pleaseWait')}</div>

  function set(patch: Partial<AppSettings>): void {
    void window.factorial.setSettings(patch).catch(() => toast.error(t('error.settingsWrite')))
  }

  return (
    <div className="flex max-w-2xl flex-col gap-8 pt-2">
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
          <Select
            value={settings.theme}
            onChange={(v) => set({ theme: v as AppSettings['theme'] })}
            options={[
              { value: 'system', label: t('settings.appearanceSystem') },
              { value: 'light', label: t('settings.appearanceLight') },
              { value: 'dark', label: t('settings.appearanceDark') },
            ]}
          />
        </Row>
      </Section>

      <Section title={t('settingsPage.widget')}>
        <Row label={t('settings.alwaysOnTop')}>
          <Switch checked={settings.alwaysOnTop} onChange={(v) => set({ alwaysOnTop: v })} />
        </Row>
        <Row label={t('settings.expand')}>
          <Select
            value={settings.expandDirection}
            onChange={(v) => set({ expandDirection: v as AppSettings['expandDirection'] })}
            options={[
              { value: 'right', label: t('settings.expandRight') },
              { value: 'left', label: t('settings.expandLeft') },
            ]}
          />
        </Row>
      </Section>

      <Section title={t('settingsPage.clockIn')}>
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
          <Button variant="outline" size="sm" onClick={() => void window.factorial.checkForUpdates().catch(() => {})}>
            {t('settings.checkForUpdates')}
          </Button>
        </Row>
      </Section>

      <Section title={t('settingsPage.account')}>
        <Row label={t('settingsPage.signedInAs')}>
          <Button variant="outline" size="sm" onClick={() => void window.factorial.signOut().catch(() => {})}>
            {t('tray.signOut')}
          </Button>
        </Row>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="divide-y rounded-2xl border bg-card">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): React.JSX.Element {
  return (
    <label className="flex cursor-default items-center justify-between gap-6 px-5 py-3.5">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[15px] font-medium">{label}</span>
        {hint !== undefined && <span className="text-sm text-muted-foreground">{hint}</span>}
      </span>
      <span className="shrink-0">{children}</span>
    </label>
  )
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-10 rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}`}
    >
      <span
        className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`}
      />
    </button>
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
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 rounded-lg border bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
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
