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
  'auth.failed': 'No se ha podido iniciar sesión: {reason}',

  'update.availableTitle': 'Actualización disponible',
  'update.available': 'La versión {version} está disponible.',
  'update.availableDetail':
    'Tienes la {current}. La actualización se descargará ahora; solo se instalará cuando lo confirmes.',
  'update.availablePortableDetail':
    'Tienes la {current}. Esta copia funciona sin instalación y no puede reemplazarse a sí misma: descarga el archivo nuevo y sustitúyelo.',
  'update.download': 'Descargar',
  'update.openDownloads': 'Abrir página de descargas',
  'update.later': 'Más tarde',
  'update.readyTitle': 'Actualización lista',
  'update.ready': 'La versión {version} se ha descargado.',
  'update.readyDetail': 'Reiniciar tarda un momento. Tu sesión se mantiene.',
  'update.restartNow': 'Reiniciar ahora',
  'update.downloading': 'Descargando la actualización … {percent}%',
  'update.preparing': 'Preparando la actualización …',
  'update.restartToInstall': 'Reiniciar para instalar {version}',
  'update.onNextQuit': 'Al salir la próxima vez',
  'update.noneTitle': 'Sin actualizaciones',
  'update.none': 'Tienes la versión más reciente.',
  'update.noneDetail': 'Tienes la {current}.',
  'update.disabledTitle': 'Actualizaciones no disponibles',
  'update.disabled': 'Esta versión no busca actualizaciones.',
  'update.disabledDetail': 'La búsqueda de actualizaciones está desactivada en modo desarrollo.',
  'update.failedTitle': 'Error al buscar actualizaciones',
  'update.failed': 'No se ha podido buscar actualizaciones.',
}
