import type { Catalogue } from '../i18n'

/**
 * German.
 *
 * The work-location labels are **Factorial's own words**, taken from a real
 * German account: `work_from_home` is "Mobiles Arbeiten" there, not
 * "Homeoffice". Anyone putting the widget next to the web interface should not
 * have to translate first. The same intent applies to the other languages, but
 * only this one and English have been checked against Factorial's own wording —
 * see the note in `es.ts`.
 */
export const de: Catalogue = {
  'state.unknown': 'Lädt …',
  'state.unauthenticated': 'Nicht angemeldet',
  'state.out': 'Ausgestempelt',
  'state.in': 'Eingestempelt',
  'state.break': 'In einer Pause',

  'tray.clockIn': 'Einstempeln',
  'tray.clockOut': 'Ausstempeln',
  'tray.break': 'Pause',
  'tray.resume': 'Fortsetzen',
  'tray.signIn': 'Anmelden',
  'tray.signOut': 'Abmelden',
  'tray.showWindow': 'Fenster zeigen',
  'tray.hideWindow': 'Fenster ausblenden',
  'tray.refresh': 'Aktualisieren',
  'tray.settings': 'Einstellungen',
  'tray.quit': 'Beenden',

  'settings.startAtLogin': 'Autostart',
  'settings.alwaysOnTop': 'Immer im Vordergrund',
  'settings.expand': 'Aufklappen',
  'settings.expandRight': 'Nach rechts',
  'settings.expandLeft': 'Nach links',
  'settings.appearance': 'Erscheinungsbild',
  'settings.appearanceSystem': 'Systemvorgabe',
  'settings.appearanceLight': 'Hell',
  'settings.appearanceDark': 'Dunkel',
  'settings.language': 'Sprache',
  'settings.languageSystem': 'Systemvorgabe',
  'settings.checkForUpdates': 'Nach Updates suchen …',

  'tray.breakWithTime': 'Pause {time}',
  'tray.today': 'heute {time}',
  'tray.breakToday': 'Pause heute {time}',
  'tray.incomplete': 'unvollständig',
  'tray.tooltip': 'Factorial · {status}',

  'widget.worked': 'Gearbeitet {time}',
  'widget.breakTotal': 'Pause {time}',
  'widget.remaining': 'Verbleibende Zeit {time}',
  'widget.targetMet': 'Soll erfüllt · {overtime}',
  'widget.incomplete': 'Tagessumme unvollständig',

  'widget.collapse': 'Widget verkleinern',
  'widget.expand': 'Aktionen zeigen',
  'widget.pleaseWait': 'Bitte warten',
  'widget.workLocation': 'Arbeitsort',
  'location.office': 'Büro',
  'location.work_from_home': 'Mobiles Arbeiten',
  'location.business_trip': 'Dienstreise',

  'error.unauthenticated': 'Die Sitzung ist abgelaufen. Bitte neu anmelden.',
  'error.graphql': 'Factorial hat die Aktion abgelehnt.',
  'error.network': 'Keine Verbindung zu Factorial. Es wurde nichts gespeichert.',
  'error.malformed': 'Unerwartete Antwort von Factorial. Es wurde nichts gespeichert.',
  'error.unknown': 'Die Aktion ist fehlgeschlagen.',
  'error.busy': 'Es läuft bereits eine Aktion. Bitte einen Moment warten.',
  'error.graphqlDetail': 'Factorial hat die Aktion abgelehnt: {detail}',
  'stale.generic': 'nicht aktuell',
  'error.settingsWrite': 'Einstellung konnte nicht gespeichert werden.',

  'stale.unauthenticated': 'Sitzung abgelaufen',
  'stale.graphql': 'Factorial meldet einen Fehler',
  'stale.network': 'keine Verbindung',
  'stale.malformed': 'unerwartete Antwort',
  'stale.unknown': 'Aktualisierung fehlgeschlagen',

  'auth.failedTitle': 'Factorial Desktop',
  'auth.failed': 'Anmeldung nicht möglich: {reason}',

  'update.availableTitle': 'Update verfügbar',
  'update.available': 'Version {version} ist verfügbar.',
  'update.availableDetail':
    'Installiert ist {current}. Das Update wird jetzt geladen; installiert wird es erst, wenn du zustimmst.',
  'update.availablePortableDetail':
    'Installiert ist {current}. Diese Fassung läuft ohne Installation und kann sich nicht selbst ersetzen — lade die neue Datei herunter und tausche sie aus.',
  'update.download': 'Herunterladen',
  'update.openDownloads': 'Download-Seite öffnen',
  'update.later': 'Später',
  'update.readyTitle': 'Update bereit',
  'update.ready': 'Version {version} ist heruntergeladen.',
  'update.readyDetail': 'Der Neustart dauert einen Moment. Deine Anmeldung bleibt erhalten.',
  'update.restartNow': 'Jetzt neu starten',
  'update.downloading': 'Update wird geladen … {percent}%',
  'update.preparing': 'Update wird vorbereitet …',
  'update.restartToInstall': 'Zum Installieren von {version} neu starten',
  'update.onNextQuit': 'Beim nächsten Beenden',
  'update.duringShiftDetail':
    'Weil gerade eine Schicht läuft, wird jetzt nicht neu gestartet. Das Update wird automatisch installiert, sobald du die App das nächste Mal beendest.',
  'update.understood': 'Verstanden',
  'update.noneTitle': 'Kein Update',
  'update.none': 'Du verwendest die neueste Version.',
  'update.noneDetail': 'Installiert ist {current}.',
  'update.disabledTitle': 'Kein Update möglich',
  'update.disabled': 'Diese Fassung sucht nicht nach Updates.',
  'update.disabledDetail': 'Im Entwicklungsmodus ist die Update-Prüfung abgeschaltet.',
  'update.failedTitle': 'Update-Prüfung fehlgeschlagen',
  'update.failed': 'Es konnte nicht nach Updates gesucht werden.',
}
