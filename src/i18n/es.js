/**
 * Diccionario ES (idioma base). Cubre la "UI de armazón" (menús, botones,
 * ajustes, login, legal, consentimiento, estado de guardado, accesibilidad).
 *
 * A propósito NO incluye (todavía) textos generados dinámicamente desde datos
 * (nombres/descripciones de logros y mejoras en achievements.js/progression.js,
 * nombres de armas en weapons.js): esos ya viven en objetos de configuración
 * centralizados propios, así que migrarlos a I18N es un paso mecánico futuro
 * (cambiar `desc: '...'` por `descKey: 'achv.kills_total.desc'`) que no bloquea
 * esta primera etapa y no arriesga romper el balance/contenido del juego.
 */
I18N.register('es', {
    'app.title': 'SLIMEFRONT',

    'boot.connecting': 'Conectando con el servidor...',
    'boot.syncing': 'Sincronizando progreso...',
    'boot.sounds': 'Cargando sonidos...',
    'boot.music': 'Cargando música...',
    'boot.graphics': 'Cargando recursos gráficos...',
    'boot.systems': 'Inicializando sistemas...',
    'boot.ready': '¡Listo!',

    'login.subtitle': 'Inicia sesión para guardar tu progreso',
    'login.google': '🔑 CONTINUAR CON GOOGLE',
    'login.guest': '👤 CONTINUAR COMO INVITADO',
    'login.legal_notice': 'Al continuar aceptás nuestros {terms} y nuestra {privacy}.',
    'login.terms_link': 'Términos de Servicio',
    'login.privacy_link': 'Política de Privacidad',
    'clickstart.prompt': '▶ CLICK PARA EMPEZAR ◀',

    'menu.play': 'Jugar',
    'menu.play_sub': 'Empieza una nueva incursión',
    'menu.achievements': 'Logros',
    'menu.settings': 'Opciones',
    'menu.settings_sub': 'Gráficos, audio y cuenta',
    'menu.exit': 'Salir',
    'menu.exit_sub': 'Cerrar SLIMEFRONT',
    'menu.resume': 'CONTINUAR',
    'menu.back': 'VOLVER',
    'menu.main_menu': 'VOLVER AL MENÚ',
    'menu.play_again': '🔁 JUGAR DE NUEVO',
    'menu.pause_title': 'PAUSA',
    'menu.gameover_title': 'MISIÓN FALLIDA',
    'menu.credits': 'Créditos',
    'menu.controls': 'Controles',
    'menu.store': 'Tienda',
    'menu.collection': 'Colección',
    'menu.workshop': 'Taller',

    'settings.title': 'AJUSTES',
    'settings.graphics': 'Gráficos',
    'settings.sfx_volume': 'Volumen de efectos',
    'settings.music_volume': 'Volumen de música',
    'settings.account': 'Cuenta',
    'settings.logout': '🚪 CERRAR SESIÓN',
    'settings.delete_progress': '🗑️ BORRAR PROGRESO',
    'settings.language': 'Idioma',
    'settings.accessibility': 'Accesibilidad',
    'settings.rebind_keys': '⌨️ Reconfigurar controles',
    'settings.colorblind_mode': 'Modo daltónico',
    'settings.privacy_consent': 'Privacidad y estadísticas',
    'settings.manage_consent': '🔎 Gestionar consentimiento de estadísticas',
    'settings.legal_links': 'Legal',

    'confirm.logout_title': 'CERRAR SESIÓN',
    'confirm.logout_body': '¿Seguro que deseas cerrar sesión?',
    'confirm.delete_title': '⚠️ BORRAR PROGRESO',
    'confirm.delete_body': 'Esta acción eliminará permanentemente tu progreso local y en la nube.',
    'confirm.exit_title': 'SALIR',
    'confirm.exit_body': '¿Seguro que deseas salir de SLIMEFRONT?',
    'confirm.cancel': 'CANCELAR',
    'confirm.delete_action': 'ELIMINAR PROGRESO',
    'confirm.exit_action': 'SALIR',

    'hud.wave': 'WAVE: {n}',
    'hud.cash': 'CASH: ${n}',
    'hud.level': 'NIVEL {n}',

    'error.fatal_title': '⚠️ ERROR INESPERADO',
    'error.fatal_body': 'SLIMEFRONT encontró un problema y no puede continuar de forma segura.',
    'error.reload': '🔁 RECARGAR JUEGO',

    'consent.title': '🍪 Estadísticas de uso',
    'consent.body': 'Usamos Firebase Analytics para entender de forma anónima cómo se juega SLIMEFRONT (oleadas alcanzadas, armas usadas, errores) y mejorarlo. No vendemos estos datos. Podés aceptar o rechazar; podés cambiar de opinión después desde Ajustes.',
    'consent.accept': 'Aceptar',
    'consent.reject': 'Rechazar',
    'consent.learn_more': 'Ver Política de Privacidad',

    'save.saving': 'Guardando...',
    'save.saved': 'Progreso guardado',
    'save.offline': 'Sin conexión — se guardará al reconectar',
    'save.retrying': 'Reintentando sincronización...',
    'save.error': 'Error al guardar en la nube',

    'legal.privacy_title': 'Política de Privacidad',
    'legal.terms_title': 'Términos de Servicio',
    'legal.deletion_title': 'Eliminación de datos',
    'legal.back_to_game': '← Volver al juego'
});
