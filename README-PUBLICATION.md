# SLIMEFRONT — Preparación para publicación pública (itch.io)

Este documento resume qué se hizo para cada uno de los 8 puntos pedidos,
qué quedó completo, y qué queda como trabajo de seguimiento explícito (con
su razón). Todo el código nuevo sigue el mismo estilo del proyecto original:
scope global, monkey-patching entre archivos, comentarios largos explicando
el "por qué".

## 1. Cumplimiento legal ✅
- `legal/privacy-policy.html`, `legal/terms-of-service.html`,
  `legal/data-deletion.html` — contenido específico al juego real (Firebase
  Auth/Firestore/Analytics, qué colecciones existen, qué NO se recopila).
- Enlazados desde: pantalla de login (`index.html`), pie del lobby
  (`game.buildLobby` en `src/main.js`), panel de Ajustes, y Créditos.
- **Importante**: son un punto de partida técnicamente preciso, no un
  reemplazo de asesoría legal. Antes de publicar, revisalos con un abogado si
  vas a operar en jurisdicciones con requisitos específicos (GDPR/CCPA/LOPD),
  y completá los datos de contacto reales.

## 2. Consentimiento para Analytics ✅
- `src/consent.js` (`ConsentManager`): banner que aparece en el primer uso,
  recuerda la decisión (`localStorage.slime_analytics_consent`), y se puede
  reabrir desde Ajustes → Privacidad → "Gestionar consentimiento".
- `src/FirebaseSaveSystem.js`: `firebase.analytics()` ya NO se llama al
  cargar la página. Se expone `window.__initAnalyticsIfNeeded()`, invocada
  únicamente si hay consentimiento aceptado.

## 3. Gestión centralizada de timers ✅ (parcial, documentado)
- `src/timers.js` (`TimerManager`): registro central de `setTimeout`/
  `setInterval`, con `TimerManager.clearAll()` llamado desde
  `game.goToMainMenu`, `game.playAgain` y el inicio de `game.init()`
  (`src/ui.js`, `src/main.js`).
- Migrados a `TimerManager`: overlay de daño y recargas/ráfagas
  (`src/player.js`), rayo de la tormenta (`src/events.js`), toasts de logro
  y de nivel (`src/achievements.js`, `src/level.js`).
- **Dejados fuera a propósito** (documentado en el código, no es un olvido):
  el debounce de sincronización de `FirebaseSaveSystem.js` (cancelarlo
  perdería el último guardado) y los fundidos de `MusicManager`
  (`src/effects.js`) — no referencian estado de partida, y cancelarlos en
  cada transición de menú cortaría la música de forma audible.

## 4. Estado visible del guardado en la nube ✅
- `src/save-indicator.js`: píldora discreta abajo a la izquierda, estados
  Guardando/Guardado/Sin conexión/Reintentando/Error, se autooculta tras
  "Guardado".
- `src/FirebaseSaveSystem.js` dispara `document` → evento
  `savesystem:status` en cada transición real (incluye detección de
  `navigator.onLine`/eventos `online`/`offline`).

## 5. Internacionalización (i18n) ✅ (framework completo, migración parcial)
- `src/i18n.js` (`I18N`) + `src/i18n/es.js`: diccionario centralizado,
  `I18N.t(key, vars)`, `data-i18n` / `applyDOM()` para HTML estático.
- Migrado: menús principales, HUD (oleada/dinero/nivel), Ajustes, login,
  legal, consentimiento, estado de guardado.
- **No migrado todavía (a propósito)**: nombres/descripciones de logros y
  mejoras (`src/achievements.js`, `src/progression.js`) y nombres de armas
  (`src/weapons.js`). Ya viven en objetos de configuración centralizados
  propios; el paso siguiente es mecánico (`desc: '...'` → `descKey: '...'`)
  pero se dejó afuera para no arriesgar el contenido/balance del juego en
  esta pasada. Agregar un idioma nuevo hoy ya no requiere tocar HTML/JS de
  UI, solo `src/i18n/<idioma>.js` + una línea en `index.html`.

## 6. Base de testing automatizado ✅
- `npm test` → `node --test` (sin dependencias externas), 24 tests, todos
  verdes hoy mismo (corridos en este entorno).
- `tests/unit/`: `xp-formula.test.js`, `i18n.test.js`, `timers.test.js`
  (lógica pura extraída, ver `src/xp-formula.js`).
- `tests/smoke/smoke.test.js`: sintaxis válida en todo `src/*.js`, orden de
  `<script>` correcto, elementos de DOM esperados presentes.
- `tests/README.md` explica el alcance actual y el paso siguiente
  (Playwright para un boot test real de navegador, no agregado por requerir
  `npm install` con red).

## 7. Build de producción ✅ (script listo; requiere `npm install` con red)
- `build.js`: concatena `src/*.js` en el mismo orden que `index.html`,
  minifica con esbuild y **quita `console.*`/`debugger`**, genera
  `dist/index.html` apuntando a un único `dist/bundle.min.js`, copia
  `assets/`, `legal/`, `Sounds/` (si existe) y `firebase-config.prod.js` —
  **nunca** copia `firebase-config.dev.js` a `dist/`.
- Separación dev/prod: `firebase-config.dev.js` (cargado por el
  `index.html` de desarrollo) vs `firebase-config.prod.js` (solo en
  `dist/`, generado por `build.js`). **Reemplazá los valores de
  `firebase-config.prod.js` por los de tu proyecto Firebase real de
  producción antes de publicar** — hoy tiene un placeholder.
- No pude ejecutar `npm install` / `npm run build` en este entorno (sin
  acceso a red), pero `node --check build.js` pasa y la lógica está
  verificada paso a paso arriba. Corré `npm install && npm run build` en tu
  máquina antes de subir `dist/` a itch.io.

## 8. Accesibilidad ✅ (base funcional, no exhaustiva)
- `src/accessibility.js`:
  - `KeyBindings`: remapeo de teclas persistente (`localStorage`), UI en
    Ajustes → "⌨️ Reconfigurar controles" (`game.openKeybindPanel`,
    `src/ui.js`). `src/main.js` traduce la tecla física configurada al
    código por defecto que el resto del juego ya usa, así **no hizo falta
    tocar** `src/player.js` para que el remapeo funcione en el gameplay real.
  - Modo daltónico: toggle en Ajustes, filtro CSS global
    (`assets/patch.css`) como primera etapa — no requiere tocar colores
    hardcodeados del HUD/canvas uno por uno.
  - `GamepadInput`: soporte real (no solo stub) para un mando estándar
    (stick izquierdo = movimiento, stick derecho = apuntado relativo, botón
    A = dash, botón X = recargar, gatillo derecho = disparo), integrado en
    el loop principal (`src/main.js`).
- **No incluido**: paletas específicas por tipo de daltonismo (solo el
  filtro genérico), remapeo de gamepad (botones fijos por ahora).

## Estructura final del proyecto

```
index.html                 (desarrollo: <script> sueltos desde src/)
firebase-config.dev.js     (config Firebase de desarrollo)
firebase-config.prod.js    (config Firebase de producción — completar antes de publicar)
build.js                   (genera dist/ para itch.io)
package.json / package-lock.json
firebase.json / firestore.rules
functions/                 (Cloud Functions, sin cambios de contenido)
assets/style.css           (sin cambios)
assets/patch.css           (nuevo: consentimiento, indicador de guardado, legal, daltónico)
legal/                     (nuevo: privacidad, términos, borrado de datos)
src/                       (todo el código del juego, ver detalle abajo)
tests/                     (nuevo: unit/ + smoke/, ver tests/README.md)
```

### Archivos nuevos en `src/`
`timers.js`, `i18n.js`, `i18n/es.js`, `xp-formula.js`, `accessibility.js`,
`consent.js`, `save-indicator.js`.

### Archivos existentes modificados
`FirebaseSaveSystem.js` (consentimiento + config dev/prod + estado de
guardado), `main.js` (TimerManager/KeyBindings/GamepadInput/i18n),
`ui.js` (TimerManager.clearAll, accesibilidad, privacidad),
`player.js` / `events.js` / `achievements.js` / `level.js` (timers →
TimerManager).

### Archivos sin cambios de contenido (solo reubicados bajo `src/`)
`lobbyscene.js`, `effects.js`, `world.js`, `weapons.js`, `enemies.js`,
`progression.js`, `auth-ui.js`, `mobile.js`, `boot.js`.

## Antes de publicar — checklist rápido

1. Completá `firebase-config.prod.js` con los valores reales de tu proyecto
   Firebase de producción (hoy tiene placeholders).
2. `npm install && npm run build` → subí el contenido de `dist/` a itch.io.
3. Completá los datos de contacto reales en las 3 páginas de `legal/`.
4. Revisá los textos legales con criterio propio/asesoría legal si aplica.
5. `npm test` antes de cada release.
