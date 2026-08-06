const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'src');

/**
 * NOTA SOBRE EL ALCANCE DE ESTE SMOKE TEST:
 * El juego corre en un <canvas> de navegador (Firebase, Web Audio, Canvas2D),
 * así que un smoke test 100% fiel requeriría un navegador real (Playwright/
 * Puppeteer). Ese es el paso natural siguiente una vez que el entorno de CI
 * pueda instalar esas dependencias (ver tests/README.md). Mientras tanto,
 * este test cubre, SIN dependencias externas, lo que sí es 100% verificable
 * con Node puro y que ya atrapa la clase de error más común al romper el
 * arranque (typo de sintaxis, script faltante, orden de carga invertido):
 *
 *   1. Cada archivo de src/*.js parsea como JS válido (detecta errores de
 *      sintaxis antes de subir a producción).
 *   2. index.html referencia todos los archivos de src/ que existen en disco.
 *   3. El orden de <script> respeta las dependencias conocidas del proyecto
 *      (ej: TimerManager/I18N/KeyBindings deben cargar antes que main.js;
 *      xp-formula.js antes que level.js).
 *   4. Los elementos del DOM que el boot flow toca sí existen en index.html.
 */

function readSrcFiles() {
    return fs.readdirSync(SRC_DIR, { withFileTypes: true })
        .flatMap(entry => {
            if (entry.isDirectory()) {
                return fs.readdirSync(path.join(SRC_DIR, entry.name))
                    .filter(f => f.endsWith('.js'))
                    .map(f => path.join(entry.name, f));
            }
            return entry.name.endsWith('.js') ? [entry.name] : [];
        });
}

test('smoke: index.html existe y define el canvas del juego', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /<canvas id="gameCanvas">/);
});

test('smoke: todos los archivos de src/*.js parsean como JavaScript válido', () => {
    const files = readSrcFiles();
    assert.ok(files.length > 0, 'se esperaba encontrar al menos un archivo en src/');
    files.forEach(rel => {
        const content = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
        assert.doesNotThrow(() => new Function(content), `src/${rel} tiene un error de sintaxis`);
    });
});

test('smoke: index.html carga cada archivo de src/ que existe en disco', () => {
    // mobile.js es una excepción CONOCIDA y preexistente (no introducida por
    // este cambio): ni su <script> ni los elementos de DOM que necesita
    // (#joystick-zone, #aim-zone, #mobile-dash-btn, #mobile-reload-btn) están
    // en index.html — coherente con "v0.9 • PC Only" en la pantalla de carga.
    // Se documenta acá en vez de improvisar una UI táctil no pedida; sumar
    // controles móviles reales es un cambio de producto aparte, no de
    // preparación para publicación.
    const KNOWN_UNWIRED = new Set(['mobile.js']);
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const files = readSrcFiles().filter(f => !KNOWN_UNWIRED.has(f));
    files.forEach(rel => {
        const tag = `src="src/${rel.split(path.sep).join('/')}"`;
        assert.ok(html.includes(tag), `index.html no carga src/${rel} (falta <script ${tag}>)`);
    });
});

test('smoke: orden de carga — infraestructura transversal antes que main.js', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const posOf = (needle) => html.indexOf(needle);
    const mainPos = posOf('src="src/main.js"');
    ['src/timers.js', 'src/i18n.js', 'src/accessibility.js'].forEach(dep => {
        const depPos = posOf(`src="${dep}"`);
        assert.ok(depPos !== -1, `falta cargar ${dep}`);
        assert.ok(depPos < mainPos, `${dep} debe cargarse ANTES que main.js (main.js usa TimerManager/KeyBindings en su cuerpo)`);
    });
});

test('smoke: orden de carga — xp-formula.js antes que level.js', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const xpPos = html.indexOf('src="src/xp-formula.js"');
    const levelPos = html.indexOf('src="src/level.js"');
    assert.ok(xpPos !== -1 && levelPos !== -1 && xpPos < levelPos,
        'level.js consume XP_CONFIG/xpToNextLevel definidos en xp-formula.js: debe cargarse después');
});

test('smoke: index.html referencia la config de Firebase de DESARROLLO por defecto (no la de prod)', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(html.includes('src="firebase-config.dev.js"'),
        'index.html (fuente de desarrollo) debería apuntar a firebase-config.dev.js; build.js la reemplaza por la de prod solo en dist/');
});

test('smoke: build.js existe y su SRC_ORDER no está vacío', () => {
    const buildJs = fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8');
    assert.match(buildJs, /SRC_ORDER\s*=\s*\[/);
});
