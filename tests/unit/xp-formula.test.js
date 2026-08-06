const test = require('node:test');
const assert = require('node:assert/strict');
const { XP_CONFIG, xpToNextLevel, XP_PER_KILL, XP_PER_KILL_DEFAULT, xpForWaveClear } = require('../../src/xp-formula.js');

test('xpToNextLevel: nivel 1 requiere exactamente curveBase de XP', () => {
    assert.equal(xpToNextLevel(1), XP_CONFIG.curveBase);
});

test('xpToNextLevel: crece con el nivel (curva exponencial, nunca decrece)', () => {
    let prev = xpToNextLevel(1);
    for (let lvl = 2; lvl <= 30; lvl++) {
        const curr = xpToNextLevel(lvl);
        assert.ok(curr >= prev, `xpToNextLevel(${lvl})=${curr} debería ser >= xpToNextLevel(${lvl - 1})=${prev}`);
        prev = curr;
    }
});

test('xpToNextLevel: siempre devuelve un entero (Math.floor aplicado)', () => {
    for (let lvl = 1; lvl <= 15; lvl++) {
        assert.equal(Number.isInteger(xpToNextLevel(lvl)), true);
    }
});

test('xpForWaveClear: crece linealmente con la oleada', () => {
    assert.equal(xpForWaveClear(0), XP_CONFIG.waveClearBase);
    assert.equal(xpForWaveClear(1), XP_CONFIG.waveClearBase + XP_CONFIG.waveClearPerWave);
    assert.equal(xpForWaveClear(10), XP_CONFIG.waveClearBase + 10 * XP_CONFIG.waveClearPerWave);
});

test('XP_PER_KILL: el jefe (BOSS) da más XP que cualquier enemigo común', () => {
    const commonTypes = ['TANK', 'RANGED', 'FAST', 'BASIC', 'INVISIBLE', 'KAMIKAZE', 'GHOST'];
    commonTypes.forEach(type => {
        assert.ok(XP_PER_KILL.BOSS > XP_PER_KILL[type], `BOSS (${XP_PER_KILL.BOSS}) debería dar más XP que ${type} (${XP_PER_KILL[type]})`);
    });
});

test('XP_PER_KILL_DEFAULT: se usa como fallback para tipos de enemigo desconocidos', () => {
    const fallback = XP_PER_KILL['TIPO_INEXISTENTE'] ?? XP_PER_KILL_DEFAULT;
    assert.equal(fallback, XP_PER_KILL_DEFAULT);
});
