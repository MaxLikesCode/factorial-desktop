import type { Catalogue } from '../i18n'

/**
 * Portuguese. See the caveat in `es.ts` about the work-location labels.
 *
 * One catalogue for `pt-PT` and `pt-BR`: `resolveLocale` only looks at the part
 * before the dash. Where the two differ the European form is used, since that is
 * the market Factorial sells into.
 */
export const pt: Catalogue = {
  'state.unknown': 'A carregar …',
  'state.unauthenticated': 'Sessão não iniciada',
  'state.out': 'Saída registada',
  'state.in': 'Entrada registada',
  'state.break': 'Em pausa',

  'tray.clockIn': 'Registar entrada',
  'tray.clockOut': 'Registar saída',
  'tray.break': 'Pausa',
  'tray.resume': 'Retomar',
  'tray.signIn': 'Iniciar sessão',
  'tray.signOut': 'Terminar sessão',
  'tray.showWindow': 'Mostrar janela',
  'tray.hideWindow': 'Ocultar janela',
  'tray.refresh': 'Atualizar',
  'tray.settings': 'Definições',
  'tray.quit': 'Sair',

  'settings.startAtLogin': 'Iniciar com o sistema',
  'settings.alwaysOnTop': 'Sempre visível',
  'settings.expand': 'Expandir',
  'settings.expandRight': 'Para a direita',
  'settings.expandLeft': 'Para a esquerda',
  'settings.appearance': 'Aparência',
  'settings.appearanceSystem': 'Sistema',
  'settings.appearanceLight': 'Claro',
  'settings.appearanceDark': 'Escuro',
  'settings.language': 'Idioma',
  'settings.languageSystem': 'Sistema',
  'settings.checkForUpdates': 'Procurar atualizações …',
  'tray.about': 'Acerca do Factorial Desktop …',
  'about.version': 'Versão {version}',

  'tray.breakWithTime': 'Pausa {time}',
  'tray.today': 'hoje {time}',
  'tray.breakToday': 'Pausas hoje {time}',
  'tray.incomplete': 'incompleto',
  'tray.tooltip': 'Factorial · {status}',

  'widget.worked': 'Trabalhado {time}',
  'widget.breakTotal': 'Pausa {time}',
  'widget.remaining': 'Tempo restante {time}',
  'widget.targetMet': 'Objetivo cumprido · {overtime}',
  'widget.incomplete': 'Total do dia incompleto',

  'widget.collapse': 'Reduzir widget',
  'widget.expand': 'Mostrar ações',
  'widget.pleaseWait': 'Aguarda um momento',
  'widget.workLocation': 'Local de trabalho',
  'location.office': 'Escritório',
  'location.work_from_home': 'Teletrabalho',
  'location.business_trip': 'Viagem de trabalho',

  'error.unauthenticated': 'A sessão expirou. Inicia sessão novamente.',
  'error.graphql': 'O Factorial rejeitou a ação.',
  'error.network': 'Sem ligação ao Factorial. Não foi guardado nada.',
  'error.malformed': 'Resposta inesperada do Factorial. Não foi guardado nada.',
  'error.unknown': 'A ação falhou.',
  'error.busy': 'Já está uma ação em curso. Aguarda um momento.',
  'error.graphqlDetail': 'O Factorial rejeitou a ação: {detail}',
  'stale.generic': 'desatualizado',
  'error.settingsWrite': 'Não foi possível guardar a definição.',

  'stale.unauthenticated': 'Sessão expirada',
  'stale.graphql': 'O Factorial reporta um erro',
  'stale.network': 'Sem ligação',
  'stale.malformed': 'Resposta inesperada',
  'stale.unknown': 'Falha ao atualizar',

  'auth.failedTitle': 'Factorial Desktop',
  'auth.failed': 'Não foi possível iniciar sessão: {reason}',

  'update.availableTitle': 'Atualização disponível',
  'update.available': 'A versão {version} está disponível.',
  'update.availableDetail':
    'Tens a {current}. A atualização vai ser transferida agora; só é instalada quando concordares.',
  'update.availablePortableDetail':
    'Tens a {current}. Esta cópia funciona sem instalação e não se pode substituir a si própria — transfere o novo ficheiro e troca-o.',
  'update.download': 'Transferir',
  'update.openDownloads': 'Abrir página de transferências',
  'update.later': 'Mais tarde',
  'update.readyTitle': 'Atualização pronta',
  'update.ready': 'A versão {version} foi transferida.',
  'update.readyDetail': 'Reiniciar demora um momento. A tua sessão mantém-se.',
  'update.restartNow': 'Reiniciar agora',
  'update.downloading': 'A transferir a atualização … {percent}%',
  'update.preparing': 'A preparar a atualização …',
  'update.restartToInstall': 'Reiniciar para instalar {version}',
  'update.onNextQuit': 'Da próxima vez que sair',
  'update.noneTitle': 'Sem atualizações',
  'update.none': 'Estás na versão mais recente.',
  'update.noneDetail': 'Tens a {current}.',
  'update.disabledTitle': 'Atualizações indisponíveis',
  'update.disabled': 'Esta versão não procura atualizações.',
  'update.disabledDetail': 'A procura de atualizações está desativada em modo de desenvolvimento.',
  'update.failedTitle': 'Falha ao procurar atualizações',
  'update.failed': 'Não foi possível procurar atualizações.',
}
