/**
 * XP-FORMULA.js — Fórmulas puras de experiencia/nivel, sin ninguna dependencia
 * de DOM/Firebase/game. Extraído de level.js específicamente para poder
 * testearlo con Node (ver tests/unit/xp-formula.test.js) sin tener que cargar
 * todo el juego. level.js consume estas mismas constantes/funciones (no las
 * redeclara), así que no hay dos fuentes de verdad para el balance de XP.
 *
 * Debe cargarse ANTES que level.js en index.html / build.js (SRC_ORDER).
 */
const XP_CONFIG = {
    curveBase: 150,
    curveGrowth: 1.22,
    perKill: { BOSS: 40, TANK: 3, RANGED: 2, FAST: 1, BASIC: 1, INVISIBLE: 2, KAMIKAZE: 1, GHOST: 2 },
    perKillDefault: 1,
    waveClearBase: 8,
    waveClearPerWave: 2
};

function xpToNextLevel(level) {
    return Math.floor(XP_CONFIG.curveBase * Math.pow(XP_CONFIG.curveGrowth, level - 1));
}

const XP_PER_KILL = XP_CONFIG.perKill;
const XP_PER_KILL_DEFAULT = XP_CONFIG.perKillDefault;
function xpForWaveClear(wave) { return XP_CONFIG.waveClearBase + wave * XP_CONFIG.waveClearPerWave; }

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { XP_CONFIG, xpToNextLevel, XP_PER_KILL, XP_PER_KILL_DEFAULT, xpForWaveClear };
}
