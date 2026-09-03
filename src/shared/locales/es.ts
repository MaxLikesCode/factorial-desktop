import type { Catalogue } from '../i18n'

/**
 * Spanish.
 *
 * **Caveat that applies to every language except German and English:** the
 * work-location labels here are translations, not Factorial's own wording
 * confirmed against an account in that language. `work_from_home` reads
 * "Teletrabajo", which is the ordinary Spanish term and very likely what
 * Factorial uses — but "very likely" is not "checked", and the point of these
 * labels is that the widget and the web interface say the same thing. Anyone
 * with an account in one of these languages should compare and correct.
 */
export const es: Catalogue = {
  'state.unknown': 'Cargando …',
  'state.unauthenticated': 'No has iniciado sesión',
  'state.out': 'Jornada finalizada',
  'state.in': 'Fichado',
  'state.break': 'En una pausa',

  'tray.clockIn': 'Fichar entrada',
  'tray.clockOut': 'Fichar salida',
  'tray.break': 'Pausa',
  'tray.resume': 'Reanudar',
  'tray.signIn': 'Iniciar sesión',
  'tray.signOut': 'Cerrar sesión',
  'tray.showWindow': 'Mostrar ventana',
  'tray.hideWindow': 'Ocultar ventana',
  'tray.refresh': 'Actualizar',
  'tray.settings': 'Ajustes',
  'tray.quit': 'Salir',

  'settings.startAtLogin': 'Iniciar al arrancar',
  'settings.alwaysOnTop': 'Siempre visible',
  'settings.expand': 'Desplegar',
  'settings.expandRight': 'Hacia la derecha',
  'settings.expandLeft': 'Hacia la izquierda',
  'settings.appearance': 'Apariencia',
  'settings.appearanceSystem': 'Sistema',
  'settings.appearanceLight': 'Claro',
  'settings.appearanceDark': 'Oscuro',
  'settings.language': 'Idioma',
  'settings.languageSystem': 'Sistema',
  'settings.checkForUpdates': 'Buscar actualizaciones …',
  'settings.autoInstallUpdates': 'Instalar actualizaciones automáticamente',
  'tray.about': 'Acerca de Factorial Desktop …',
  'about.version': 'Versión {version}',

  'tray.breakWithTime': 'Pausa {time}',
  'tray.today': 'hoy {time}',
  'tray.breakToday': 'Pausas hoy {time}',
  'tray.incomplete': 'incompleto',
  'tray.tooltip': 'Factorial · {status}',

  'widget.worked': 'Trabajado {time}',
  'widget.breakTotal': 'Pausa {time}',
  'widget.remaining': 'Tiempo restante {time}',
  'widget.targetMet': 'Objetivo cumplido · {overtime}',
  'widget.incomplete': 'Total del día incompleto',

  'widget.collapse': 'Contraer widget',
  'widget.expand': 'Mostrar acciones',
  'widget.pleaseWait': 'Espera un momento',
  'widget.workLocation': 'Lugar de trabajo',
  'location.office': 'Oficina',
  'location.work_from_home': 'Teletrabajo',
  'location.business_trip': 'Viaje de trabajo',

  'error.unauthenticated': 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
  'error.graphql': 'Factorial ha rechazado la acción.',
  'error.network': 'Sin conexión con Factorial. No se ha guardado nada.',
  'error.malformed': 'Respuesta inesperada de Factorial. No se ha guardado nada.',
  'error.unknown': 'La acción ha fallado.',
  'error.busy': 'Ya hay una acción en curso. Espera un momento.',
  'error.graphqlDetail': 'Factorial ha rechazado la acción: {detail}',
  'stale.generic': 'desactualizado',
  'error.settingsWrite': 'No se ha podido guardar el ajuste.',

  'stale.unauthenticated': 'Sesión caducada',
  'stale.graphql': 'Factorial informa de un error',
  'stale.network': 'Sin conexión',
  'stale.malformed': 'Respuesta inesperada',
  'stale.unknown': 'Error al actualizar',

  'auth.failedTitle': 'Factorial Desktop',
  'auth.unreachable': 'Factorial no ha respondido.',
  'auth.unreachableDetail':
    'Tu sesión no se ve afectada: parece un problema de red temporal.\n\n{reason}',
  'auth.retry': 'Intentarlo de nuevo',

  'update.availableTitle': 'Actualización disponible',
  'update.available': 'La versión {version} está disponible.',
  'update.availablePortableDetail':
    'Tienes la {current}. Esta copia funciona sin instalación y no puede reemplazarse a sí misma: descarga el archivo nuevo y sustitúyelo.',
  'update.openDownloads': 'Abrir página de descargas',
  'update.later': 'Más tarde',
  'update.downloading': 'Descargando la actualización … {percent}%',
  'update.preparing': 'Preparando la actualización …',
  'update.restartToInstall': 'Reiniciar para instalar {version}',
  'update.disabledTitle': 'Actualizaciones no disponibles',
  'update.disabled': 'Esta versión no busca actualizaciones.',
  'update.disabledDetail': 'La búsqueda de actualizaciones está desactivada en modo desarrollo.',
  'update.failedTitle': 'Error al buscar actualizaciones',
  'update.failed': 'No se ha podido buscar actualizaciones.',
  'updateWindow.title': '¡Hay una nueva versión de Factorial Desktop!',
  'updateWindow.summary':
    'Factorial Desktop {version} ya está disponible; tienes la {current}. ¿Quieres descargarla ahora?',
  'updateWindow.releaseNotes': 'Notas de la versión:',
  'updateWindow.noReleaseNotes': 'Esta versión no tiene notas.',
  'updateWindow.autoInstall': 'Descargar e instalar actualizaciones automáticamente en el futuro',
  'updateWindow.skip': 'Omitir esta versión',
  'updateWindow.later': 'Recordar más tarde',
  'updateWindow.install': 'Instalar actualización',
  'updateWindow.downloading': 'Descargando la actualización …',
  'updateWindow.preparing': 'Preparando la actualización …',
  'updateWindow.ready': 'Lista para instalar',
  'updateWindow.progress': '{transferred} de {total}',
  'updateWindow.cancel': 'Cancelar',
  'updateWindow.installAndRelaunch': 'Instalar y reiniciar',
  'updateWindow.failedTitle': 'No se pudo descargar la actualización',
  'updateWindow.close': 'Cerrar',
  'updateWindow.upToDate': '¡Estás al día!',
  'updateWindow.upToDateDetail': 'Factorial Desktop {current} es actualmente la versión más reciente disponible.',
  'updateWindow.ok': 'OK',
}
