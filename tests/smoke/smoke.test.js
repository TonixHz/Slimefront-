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
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const files = readSrcFiles();
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

test('smoke: index.html referencia la config única de Firebase (sin distinción dev/prod)', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(html.includes('src="firebase-config.js"'),
        'index.html debería cargar firebase-config.js (config única de Firebase)');
    assert.ok(!html.includes('firebase-config.dev.js') && !html.includes('firebase-config.prod.js'),
        'no deberían quedar referencias al sistema DEV/PROD de configuración de Firebase');
});

test('smoke: build.js existe y su SRC_ORDER no está vacío', () => {
    const buildJs = fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8');
    assert.match(buildJs, /SRC_ORDER\s*=\s*\[/);
});

test('smoke: los controles móviles están conectados y sus dependencias existen', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const mobile = fs.readFileSync(path.join(SRC_DIR, 'mobile.js'), 'utf8');
    const buildJs = fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8');
    ['mobile-controls', 'joystick-zone', 'joystick-knob', 'aim-zone', 'aim-knob', 'mobile-dash-btn', 'mobile-reload-btn'].forEach(id => {
        assert.ok(html.includes(`id="${id}"`), `falta el elemento táctil #${id} en index.html`);
    });
    assert.ok(html.includes('src="src/mobile.js"'), 'index.html debe cargar mobile.js en desarrollo');
    assert.ok(buildJs.includes("'mobile.js'"), 'build.js debe incluir mobile.js en el bundle de producción');
    assert.match(mobile, /g\.player\.dash\(\)/, 'el botón de dash debe invocar el método de Player');
    assert.match(mobile, /g\.reload\(\)/, 'el botón de recarga debe invocar el método de recarga del juego');
    assert.match(mobile, /function updateAim\(touch\)/, 'el joystick derecho debe definir la dirección de apuntado');
    assert.match(mobile, /g\.mouse\.down = rawDist > maxDist \* 0\.12/, 'el joystick derecho debe disparar al inclinarse');
    assert.match(mobile, /g\.started && !g\.paused/, 'los controles solo deben mostrarse durante una partida activa y no pausada');
    assert.match(mobile, /gameover-screen/, 'los controles deben ocultarse en Game Over');
    assert.match(mobile, /esc-menu/, 'los controles deben ocultarse al abrir el menú de pausa');
});


test('smoke: el zoom de cámara móvil se adapta a horizontal y no afecta PC', () => {
    const main = fs.readFileSync(path.join(SRC_DIR, 'main.js'), 'utf8');
    const effects = fs.readFileSync(path.join(SRC_DIR, 'effects.js'), 'utf8');
    assert.match(main, /pointer: coarse.*orientation: landscape/);
    assert.match(main, /mobileLandscape \? 0\.58/);
    assert.match(main, /ctx\.scale\(worldZoom, worldZoom\)/);
    assert.match(main, /ctx\.restore\(\); \/\/ El HUD y los overlays permanecen/);
    assert.match(effects, /const viewWidth = canvas\.width \/ zoom/);
    assert.match(effects, /const viewHeight = canvas\.height \/ zoom/);
});


test('smoke: pantallas de menú, carga y lobby tienen layout responsive para móvil', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'assets', 'patch.css'), 'utf8');
    assert.match(html, /id="loading-screen"/);
    assert.match(html, /id="lobby-screen"/);
    assert.match(css, /#loading-screen \.loading-content/);
    assert.match(css, /\.menu-screen > \.menu-panel/);
    assert.match(css, /body\.lobby-active #lobby-screen\.lobby-screen-v2/);
    assert.match(css, /grid-template-areas: "left" "right" "bottom"/);
    assert.match(css, /max-height: calc\(100dvh/);
    assert.match(css, /env\(safe-area-inset-top\)/);
});


test('smoke: HUD de partida ultracompacto en móvil horizontal', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets', 'patch.css'), 'utf8');
    assert.match(css, /orientation: landscape\) and \(max-height: 500px\) and \(pointer: coarse\)/);
    assert.match(css, /grid-template-columns: minmax\(76px, 1\.05fr\)/);
    assert.match(css, /#health-container \{ width: 100%; height: 9px/);
    assert.match(css, /#hotbar \{[\s\S]*?max-width: 42vw/);
    assert.match(css, /max-height: 380px\) and \(pointer: coarse\)/);
});

test('smoke: al iniciar sesión se combina el progreso local con el remoto sin perder mejoras', () => {
    const save = fs.readFileSync(path.join(ROOT, 'src', 'FirebaseSaveSystem.js'), 'utf8');
    assert.match(save, /_mergeProgress\(key, local, remote\)/);
    assert.match(save, /if \(key === 'progression'\)/);
    assert.match(save, /levels\[name\] = mergeMax\(level, levels\[name\]\)/);
    assert.match(save, /if \(key === 'profile'\)/);
    assert.match(save, /merged\.unlocks = mergeArrays/);
    assert.match(save, /if \(key === 'achv_state'\)/);
    assert.match(save, /this\._dirty\.add\(k\)/);
});


test('smoke: borrar progreso bloquea reintentos de sync hasta terminar la eliminación remota', () => {
    const save = fs.readFileSync(path.join(ROOT, 'src', 'FirebaseSaveSystem.js'), 'utf8');
    assert.match(save, /_clearingProgress: false/);
    assert.match(save, /if \(!this\._clearingProgress\) this\._scheduleSync\(\)/);
    assert.match(save, /_scheduleSync\(\) \{\s*if \(this\._clearingProgress\) return;/);
    assert.match(save, /if \(!this\._clearingProgress && this\._uid && this\._dirty\.size > 0/);
    assert.match(save, /this\._clearingProgress = true;[\s\S]*?await _clearProgressFn\(\)/);
    assert.match(save, /finally \{\s*this\._clearingProgress = false;/);
});


test('smoke: cloud sync merges stale device snapshots without rolling progress back', () => {
    const cloud = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    assert.match(cloud, /db\.runTransaction\(async transaction =>/);
    assert.match(cloud, /Math\.max\(prevLvl, clampNum\(src\[k\]/);
    assert.match(cloud, /Math\.max\(prevV, clampNum\(incoming\[f\]/);
    assert.match(cloud, /oldState\.claimed \|\| !!newState\.claimed/);
    assert.match(cloud, /Math\.max\(clampNum\(previous\.level/);
    assert.match(cloud, /Math\.max\(clampNum\(previous\.bestWave/);
    assert.match(cloud, /out\.pendingMoney = clampNum\(incoming\.pendingMoney/);
    assert.doesNotMatch(cloud, /'moneyEarned', 'lowHpClears', 'pendingMoney'/);
});


test('smoke: diamond currency changes are server-transactional and idempotent', () => {
    const cloud = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    const save = fs.readFileSync(path.join(ROOT, 'src', 'FirebaseSaveSystem.js'), 'utf8');
    const level = fs.readFileSync(path.join(ROOT, 'src', 'level.js'), 'utf8');
    assert.match(cloud, /exports\.changeDiamonds = functions\.https\.onCall/);
    assert.match(cloud, /playerRef\.collection\('currencyOperations'\)\.doc\(operationId\)/);
    assert.match(cloud, /if \(operationSnap\.exists\) return \{ ok: true, balance, duplicate: true \}/);
    assert.match(cloud, /profile: \{ \.\.\.profile, diamonds: nextBalance \}/);
    assert.match(save, /_changeDiamondsFn = _functions\.httpsCallable\('changeDiamonds'\)/);
    assert.match(save, /_diamondQueue/);
    assert.match(level, /SaveSystem\.changeDiamonds\(amount\)/);
    assert.match(cloud, /out\.diamonds = clampNum\(prev\.diamonds/);
});


test('smoke: queued diamond rewards are bound to the account that earned them', () => {
    const save = fs.readFileSync(path.join(ROOT, 'src', 'FirebaseSaveSystem.js'), 'utf8');
    assert.match(save, /if \(!this\._uid\) return Promise\.resolve\(false\)/,
        'guest rewards must not be queued for a future login');
    assert.match(save, /this\._diamondQueue\.push\(\{ operationId, delta, uid: this\._uid \}\)/,
        'each queued reward must store its owner UID');
    assert.match(save, /typeof op\.uid === 'string'/,
        'legacy operations without an owner must be discarded');
    assert.match(save, /findIndex\(op => op\.uid === uid\)/,
        'only the active account may drain its own operations');
    assert.match(save, /if \(this\._uid !== uid\) return false/,
        'an account switch during a request must not mutate the new account balance');
});


test('smoke: resetting one account preserves other accounts’ queued diamond operations', () => {
    const save = fs.readFileSync(path.join(ROOT, 'src', 'FirebaseSaveSystem.js'), 'utf8');
    assert.match(save, /const clearingUid = this\._uid/);
    assert.match(save, /this\._diamondQueue = clearingUid[\s\S]*?this\._diamondQueue\.filter\(op => op\.uid !== clearingUid\)/);
});


test('smoke: deleting progress captures the original account and preserves cache after account switch', () => {
    const save = fs.readFileSync(path.join(ROOT, 'src', 'FirebaseSaveSystem.js'), 'utf8');
    assert.match(save, /async clearProgress\(\) \{[\s\S]*?const clearingUid = this\._uid/);
    assert.match(save, /if \(this\._uid !== clearingUid\) throw new Error/);
    assert.match(save, /if \(this\._uid !== clearingUid\) return;[\s\S]*?keys\.forEach/);
});
