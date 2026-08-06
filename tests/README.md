# Tests — SLIMEFRONT

Usa el test runner incorporado en Node 18+ (`node --test`), sin dependencias
externas que instalar.

## Correr los tests

```bash
npm test
# o directamente:
node --test tests/unit tests/smoke
```

## Estructura

```
tests/
  unit/            Pruebas de módulos puros (sin DOM/Firebase)
    xp-formula.test.js   Fórmula de experiencia/nivel (src/xp-formula.js)
    i18n.test.js         Sistema de traducciones (src/i18n.js + src/i18n/es.js)
    timers.test.js       Registro centralizado de timers (src/timers.js)
  smoke/
    smoke.test.js  Verifica que el juego "arranca": sintaxis válida en todo
                   src/*.js, index.html carga cada archivo, y el orden de
                   <script> respeta las dependencias conocidas (ver notas
                   dentro del archivo).
```

## Por qué estos módulos primero

Se priorizaron para testing automatizado los módulos que:
- son **puros** (mismo input -> mismo output, sin tocar `document`/Firebase),
  así corren en Node sin necesidad de un navegador headless; y
- **cambian seguido** y son fáciles de romper sin darse cuenta (la curva de
  XP, el registro de timers, las claves de traducción).

Los sistemas centrales del juego (`player.js`, `enemies.js`, `world.js`, el
loop de `main.js`) están fuertemente acoplados al DOM/Canvas2D/Firebase por
diseño (es un juego de arcade en tiempo real, no una librería), así que
testearlos de forma significativa requiere un navegador real.

## Siguiente paso natural (no incluido todavía)

Para testear el arranque real end-to-end (boot flow completo: carga de
assets -> login -> click-to-start -> lobby -> `game.init()` -> primer frame
sin excepciones), el camino natural es sumar **Playwright** como
devDependency y un test tipo:

```js
// tests/e2e/boot.spec.js (futuro)
test('el juego arranca y llega al lobby', async ({ page }) => {
  await page.goto('http://localhost:PORT/index.html');
  await page.click('#login-guest-btn');
  await page.click('#clickstart-screen');
  await expect(page.locator('#lobby-screen')).toBeVisible();
});
```

No se agregó en esta etapa porque requiere `npm install` con acceso a
red — el smoke test actual (`tests/smoke/smoke.test.js`) cubre, sin esa
dependencia, la clase de regresión más común (sintaxis rota, script faltante,
orden de carga invertido) para poder detectar problemas antes de publicar.

## Agregar un test nuevo

1. Si el módulo que querés testear tiene lógica pura extraíble (sin
   `document`/`game`/Firebase), extraela a su propio archivo bajo `src/`
   (como se hizo con `src/xp-formula.js`) para poder testearla en aislamiento.
2. Creá `tests/unit/<nombre>.test.js` usando `node:test` + `node:assert/strict`.
3. Corré `npm test` antes de cada release.
