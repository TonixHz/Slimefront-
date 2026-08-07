#!/usr/bin/env node
/**
 * build.js — Build de producción para publicar en itch.io.
 *
 * Filosofía (retomada de la decisión de volver a <script> tags directos en
 * desarrollo, ver memoria del proyecto): NO se usa esbuild como bundler real
 * (no hay resolución de módulos ES ni tree-shaking, y el juego depende del
 * orden de <script> para sus monkey-patches). esbuild se usa ÚNICAMENTE como
 * minificador/transformador sobre el resultado de CONCATENAR los archivos de
 * src/ en el mismo orden exacto en que index.html los carga hoy — así el
 * comportamiento en producción es idéntico al de desarrollo, solo que en un
 * único archivo minificado y sin sentencias de consola/depuración.
 *
 * Ya no existe distinción DEV/PROD de Firebase: hay una única
 * `firebase-config.js` que se usa tanto en desarrollo como en dist/, así que
 * este script NO la modifica ni la sustituye, solo la copia tal cual.
 *
 * Qué hace, paso a paso:
 *   1. Lee SRC_ORDER (el mismo orden que <script> tags en index.html).
 *   2. Concatena esos archivos con un separador que preserva los números de
 *      línea aproximados (útil si hay que debuggear un stack trace en prod).
 *   3. Pasa el resultado por esbuild.transform con minify:true y
 *      drop:['console','debugger'] (ver DROP_CONSOLE_LOG más abajo si en
 *      algún momento se necesita loguear algo crítico en producción).
 *   4. Escribe dist/bundle.min.js.
 *   5. Genera dist/index.html: mismo HTML que el de desarrollo, pero todos
 *      los <script src="src/..."> se reemplazan por un único
 *      <script src="bundle.min.js">.
 *   6. Copia tal cual: assets/, legal/, firebase-config.js, y (si existen
 *      en el repo) Sounds/.
 *
 * Uso:
 *   npm install        (una vez, instala esbuild como devDependency)
 *   npm run build       -> genera dist/
 *   (subir el CONTENIDO de dist/ como .zip a itch.io)
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'src');
const DIST_DIR = path.join(ROOT, 'dist');

// Mismo orden que los <script src="src/..."> en index.html. Si agregás un
// archivo nuevo a src/, agregalo ACÁ en la misma posición relativa que en
// index.html, o el build tendrá un orden de carga distinto al de desarrollo.
const SRC_ORDER = [
    'FirebaseSaveSystem.js',
    'timers.js',
    'i18n.js',
    'i18n/es.js',
    'accessibility.js',
    'consent.js',
    'save-indicator.js',
    'main.js',
    'lobbyscene.js',
    'ui.js',
    'effects.js',
    'events.js',
    'world.js',
    'weapons.js',
    'player.js',
    'enemies.js',
    'xp-formula.js',
    'level.js',
    'progression.js',
    'achievements.js',
    'auth-ui.js',
    'boot.js'
];

function rmrf(p) {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function copyIfExists(src, dest) {
    if (!fs.existsSync(src)) {
        console.warn(`[build] Aviso: no existe "${path.relative(ROOT, src)}", se omite.`);
        return;
    }
    fs.cpSync(src, dest, { recursive: true });
}

async function main() {
    console.log('[build] Limpiando dist/ ...');
    rmrf(DIST_DIR);
    fs.mkdirSync(DIST_DIR, { recursive: true });

    console.log('[build] Concatenando src/ en el orden de carga...');
    let concatenated = '';
    for (const rel of SRC_ORDER) {
        const filePath = path.join(SRC_DIR, rel);
        if (!fs.existsSync(filePath)) {
            throw new Error(`[build] Falta src/${rel} (listado en SRC_ORDER pero no existe en disco).`);
        }
        const content = fs.readFileSync(filePath, 'utf8');
        concatenated += `\n/* ==== src/${rel} ==== */\n${content}\n`;
    }

    console.log('[build] Minificando y quitando console.*/debugger con esbuild...');
    const result = await esbuild.transform(concatenated, {
        loader: 'js',
        minify: true,
        drop: ['console', 'debugger'],
        legalComments: 'none',
        target: 'es2019'
    });

    const bundlePath = path.join(DIST_DIR, 'bundle.min.js');
    fs.writeFileSync(bundlePath, result.code);
    const sizeKb = (Buffer.byteLength(result.code) / 1024).toFixed(1);
    console.log(`[build] dist/bundle.min.js escrito (${sizeKb} KB).`);

    console.log('[build] Generando dist/index.html de producción...');
    let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    // Reemplaza el bloque de <script src="src/FirebaseSaveSystem.js"> ... <script src="src/boot.js">
    // por un único <script src="bundle.min.js">. Se hace con un recorte de línea
    // a línea (no regex frágil) para no depender de que el HTML no cambie de forma.
    // firebase-config.js NO se toca: es el mismo archivo en dev y en dist/.
    const lines = html.split('\n');
    const startMarker = '<script src="src/FirebaseSaveSystem.js"></script>';
    const endMarker = '<script src="src/boot.js"></script>';
    const startIdx = lines.findIndex(l => l.includes(startMarker));
    const endIdx = lines.findIndex(l => l.includes(endMarker));
    if (startIdx === -1 || endIdx === -1) {
        throw new Error('[build] No se encontraron los marcadores de script en index.html; revisá SRC_ORDER/index.html en conjunto.');
    }
    lines.splice(startIdx, endIdx - startIdx + 1, '<script src="bundle.min.js"></script>');
    html = lines.join('\n');

    fs.writeFileSync(path.join(DIST_DIR, 'index.html'), html);

    console.log('[build] Copiando assets estáticos...');
    copyIfExists(path.join(ROOT, 'assets'), path.join(DIST_DIR, 'assets'));
    copyIfExists(path.join(ROOT, 'legal'), path.join(DIST_DIR, 'legal'));
    copyIfExists(path.join(ROOT, 'Sounds'), path.join(DIST_DIR, 'Sounds'));
    copyIfExists(path.join(ROOT, 'firebase-config.js'), path.join(DIST_DIR, 'firebase-config.js'));

    console.log('\n[build] Listo. dist/ contiene el build de producción.');
    console.log('[build] Verificá antes de publicar: firebase-config.js tiene los valores REALES de tu proyecto Firebase (ver comentario en ese archivo).');
}

main().catch(err => {
    console.error('[build] Falló:', err);
    process.exit(1);
});