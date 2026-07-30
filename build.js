/**
 * build.js — Bundler de SLIMEFRONT con esbuild.
 *
 * IMPORTANTE: FILES_IN_ORDER es la única fuente de verdad del orden de carga.
 * Reemplaza a los <script> de index.html: reproduce EXACTAMENTE el mismo orden
 * que tenían antes, porque varios archivos dependen de que ciertas funciones
 * (game.hitEnemy, Player.prototype.update, etc.) ya existan antes de ser
 * "envueltas" (monkey-patch) por el siguiente archivo en la cadena.
 *
 * Estrategia: concatenar los fuentes (mismo scope global de siempre, cero
 * reescritura de lógica) y pasar el resultado por esbuild para minificar
 * (prod) o generar sourcemap (dev). Esto da UN solo bundle.js sin depender
 * de que un humano mantenga el orden de <script> en el HTML.
 */
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const isProd = process.argv.includes('--mode=production');
const watch = process.argv.includes('--watch');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'src');
const DIST_DIR = path.join(ROOT, 'dist');

const FILES_IN_ORDER = [
  'FirebaseSaveSystem.js',
  'main.js',
  'ui.js',
  'effects.js',
  'events.js',
  'world.js',
  'weapons.js',
  'player.js',
  'enemies.js',
  'level.js',
  'progression.js',
  'achievements.js',
  'auth-ui.js',
  'mobile.js',
  'boot.js',
];

function concatenate() {
  let out = '"use strict";\n';
  for (const file of FILES_IN_ORDER) {
    const full = path.join(SRC_DIR, file);
    if (!fs.existsSync(full)) throw new Error(`Falta el archivo fuente: ${full}`);
    const code = fs.readFileSync(full, 'utf8');
    out += `\n/* ================= ${file} ================= */\n`;
    out += code;
    // Truco de DevTools: aunque todo viva en un solo bundle.js, cada bloque
    // aparece como un "archivo" separado en la pestaña Sources del navegador.
    out += `\n//# sourceURL=${file}\n`;
  }
  // Los sonidos se sirven desde dist/assets/Sounds/ (ver copyAssets), así que
  // reescribimos acá los paths relativos que usa effects.js ('Sounds/...').
  return out.split('Sounds/').join('assets/Sounds/');
}

function copyAssets() {
  const assetsDir = path.join(DIST_DIR, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const soundsSrc = path.join(ROOT, 'Sounds');
  if (fs.existsSync(soundsSrc)) {
    fs.cpSync(soundsSrc, path.join(assetsDir, 'Sounds'), { recursive: true });
  } else {
    console.warn('[build] No se encontró Sounds/ en la raíz del proyecto, se omite.');
  }

  const cssSrc = path.join(ROOT, 'style.css');
  if (fs.existsSync(cssSrc)) fs.copyFileSync(cssSrc, path.join(assetsDir, 'style.css'));
}

function copyIndexHtml() {
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(DIST_DIR, 'index.html'));
}

async function run() {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  copyAssets();
  copyIndexHtml();

  const tmpFile = path.join(DIST_DIR, '.combined.js');
  fs.writeFileSync(tmpFile, concatenate());

  const buildOptions = {
    entryPoints: [tmpFile],
    bundle: false,               // ya concatenamos a mano; acá esbuild solo transforma/minifica
    outfile: path.join(DIST_DIR, 'bundle.js'),
    minify: isProd,
    sourcemap: isProd ? false : 'inline',
    target: ['es2019'],
    legalComments: 'none',
    logLevel: 'info',
  };

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[build] watch activo — recompilando bundle.js ante cambios en src/');
    fs.watch(SRC_DIR, { recursive: true }, () => {
      try { fs.writeFileSync(tmpFile, concatenate()); }
      catch (e) { console.error('[build] error recombinando fuentes:', e.message); }
    });
  } else {
    await esbuild.build(buildOptions);
    fs.unlinkSync(tmpFile);
    console.log(`[build] dist/ generado (${isProd ? 'PRODUCCIÓN' : 'DESARROLLO'}).`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });