/**
 * CLOUD FUNCTIONS — Único camino de escritura hacia /players/{uid} y /leaderboard/{uid}.
 *
 * Las Firestore Rules (firestore.rules) bloquean CUALQUIER escritura directa
 * del cliente a esas colecciones ("allow write: if false"). El Admin SDK que
 * usan estas funciones ignora las Rules, así que este archivo es el ÚNICO
 * lugar del proyecto donde el progreso del jugador realmente se guarda.
 *
 * Esto cierra el hueco de seguridad que existía antes: abrir la consola del
 * navegador y llamar a SaveSystem.set('profile', {money: 999999999, ...})
 * seguía funcionando localmente (localStorage), pero ya NO tiene ningún
 * efecto sobre lo que queda guardado en la nube ni sobre el leaderboard
 * público, porque acá se valida cada campo antes de escribir.
 *
 * FirebaseSaveSystem.js (cliente) llama a `syncProgress` en vez de escribir
 * directo en Firestore; sigue siendo "offline-first" (localStorage no
 * cambia), solo cambia A DÓNDE va la sincronización remota.
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

// Únicas claves que el juego usa hoy (ver SaveSystem.get/set en el resto del
// proyecto). Cualquier otra clave que llegue en el payload se descarta en
// silencio: el cliente no puede inventarse una clave nueva para esquivar
// la validación.
const ALLOWED_KEYS = ['profile', 'progression', 'achv_stats', 'achv_state'];

// Debe coincidir con UPGRADES_DB en progression.js (maxLevel: 5 para todas
// las mejoras actuales).
const MAX_UPGRADE_LEVEL = 5;

function clampNum(v, min, max, fallback = min) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}
function str(v, maxLen = 60) {
    return (typeof v === 'string') ? v.slice(0, maxLen) : '';
}

/**
 * Cada validador recibe (incoming, previous) — el dato que mandó el cliente
 * y lo que YA había guardado en Firestore antes de este sync — y devuelve
 * el objeto saneado/clampeado a guardar, o null si hay que descartar toda
 * la clave (payload con forma inválida).
 *
 * La estrategia de "nunca más de X respecto a lo anterior" es deliberada:
 * no intenta recalcular el juego entero server-side, pero sí vuelve inútil
 * escribir un valor arbitrariamente alto de un sync a otro (el salto queda
 * recortado al máximo plausible para ese período).
 */
const VALIDATORS = {
    profile(incoming, previous) {
        if (typeof incoming !== 'object' || incoming === null) return null;
        const prev = previous || {};
        const prevLevel = clampNum(prev.level, 1, 5000, 1);

        const out = {};
        out.level = clampNum(incoming.level, 1, prevLevel + 20, prevLevel); // máx. +20 niveles por sync
        out.xp = clampNum(incoming.xp, 0, 10_000_000, 0);
        out.playTimeSec = clampNum(incoming.playTimeSec, 0, clampNum(prev.playTimeSec, 0, 1e9, 0) + 60 * 60 * 6, prev.playTimeSec || 0); // +6h por sync
        out.kills = clampNum(incoming.kills, 0, clampNum(prev.kills, 0, 1e12, 0) + 100000, prev.kills || 0);
        out.deaths = clampNum(incoming.deaths, 0, clampNum(prev.deaths, 0, 1e9, 0) + 5000, prev.deaths || 0);
        out.shotsFired = clampNum(incoming.shotsFired, 0, clampNum(prev.shotsFired, 0, 1e12, 0) + 500000, prev.shotsFired || 0);
        out.shotsHit = Math.min(out.shotsFired, clampNum(incoming.shotsHit, 0, 1e12, 0));
        out.distance = clampNum(incoming.distance, 0, clampNum(prev.distance, 0, 1e12, 0) + 50_000_000, prev.distance || 0);
        out.bestWave = clampNum(incoming.bestWave, 0, clampNum(prev.bestWave, 0, 100000, 0) + 50, prev.bestWave || 0);
        out.diamonds = clampNum(incoming.diamonds, 0, clampNum(prev.diamonds, 0, 1e9, 0) + 100000, prev.diamonds || 0);

        out.weaponUsage = {};
        if (incoming.weaponUsage && typeof incoming.weaponUsage === 'object') {
            Object.keys(incoming.weaponUsage).slice(0, 40).forEach(k => {
                out.weaponUsage[str(k, 20)] = clampNum(incoming.weaponUsage[k], 0, 1e9, 0);
            });
        }
        out.unlocks = Array.isArray(incoming.unlocks) ? incoming.unlocks.slice(0, 500).map(u => ({
            level: clampNum(u && u.level, 0, 5000, 0),
            type: str(u && u.type, 20),
            label: str(u && u.label, 60)
        })) : [];
        return out;
    },

    progression(incoming, previous) {
        if (typeof incoming !== 'object' || incoming === null) return null;
        const prevLevels = (previous && previous.levels) || {};
        const levels = {};
        const src = (incoming.levels && typeof incoming.levels === 'object') ? incoming.levels : {};
        Object.keys(src).slice(0, 20).forEach(k => {
            const prevLvl = clampNum(prevLevels[k], 0, MAX_UPGRADE_LEVEL, 0);
            // Comprar una mejora sube de a 1 nivel por vez (ver Progression.buy
            // en progression.js): nunca aceptamos más de +1 por sync.
            levels[k] = clampNum(src[k], 0, Math.min(MAX_UPGRADE_LEVEL, prevLvl + 1), prevLvl);
        });
        return { levels };
    },

    achv_stats(incoming, previous) {
        if (typeof incoming !== 'object' || incoming === null) return null;
        const prev = previous || {};
        const out = {};
        const numFields = ['bossKills', 'reloads', 'killStreakNoDeath', 'bestKillStreak', 'meleeBossKills',
            'perfectWaves', 'eventsCompleted', 'weaponsPurchased', 'weaponsSold', 'upgradesBuys',
            'healthPackUses', 'dashUses', 'proWavesCleared', 'moneyEarned', 'lowHpClears', 'pendingMoney'];
        numFields.forEach(f => {
            const prevV = clampNum(prev[f], 0, 1e12, 0);
            out[f] = clampNum(incoming[f], 0, prevV + 100000, prevV);
        });
        out.heavyWeaponPurchased = !!incoming.heavyWeaponPurchased;
        out.categoryKills = {};
        if (incoming.categoryKills && typeof incoming.categoryKills === 'object') {
            Object.keys(incoming.categoryKills).slice(0, 20).forEach(k => {
                out.categoryKills[str(k, 20)] = clampNum(incoming.categoryKills[k], 0, 1e9, 0);
            });
        }
        ['weaponsUsed', 'eventTypesCompleted', 'upgradesTouched', 'bossWavesDefeated'].forEach(f => {
            out[f] = Array.isArray(incoming[f])
                ? incoming[f].slice(0, 100).map(v => (typeof v === 'string' ? str(v, 20) : clampNum(v, 0, 100000, 0)))
                : [];
        });
        return out;
    },

    achv_state(incoming) {
        if (typeof incoming !== 'object' || incoming === null) return null;
        const out = {};
        Object.keys(incoming).slice(0, 500).forEach(id => {
            const s = incoming[id];
            out[str(id, 60)] = { notified: !!(s && s.notified), claimed: !!(s && s.claimed) };
        });
        return out;
    }
};

exports.syncProgress = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Se requiere iniciar sesión.');
    }
    if (!data || typeof data !== 'object') {
        throw new functions.https.HttpsError('invalid-argument', 'Payload inválido.');
    }
    const uid = context.auth.uid;

    const docRef = db.collection('players').doc(uid);
    const snap = await docRef.get();
    const previous = snap.exists ? snap.data() : {};

    const patch = {};
    ALLOWED_KEYS.forEach(key => {
        if (!(key in data)) return;
        const clean = VALIDATORS[key](data[key], previous[key]);
        if (clean !== null) patch[key] = clean;
    });

    if (Object.keys(patch).length === 0) {
        return { ok: true, written: [] };
    }

    patch._updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await docRef.set(patch, { merge: true });

    // El leaderboard se recalcula a partir del documento YA validado en este
    // mismo request, nunca a partir de lo que mandó el cliente sin pasar por
    // los validadores de arriba.
    if (patch.profile) {
        await db.collection('leaderboard').doc(uid).set({
            name: str(context.auth.token.name || context.auth.token.email || 'Jugador', 40),
            level: patch.profile.level,
            bestWave: patch.profile.bestWave,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    return { ok: true, written: Object.keys(patch) };
});

exports.clearProgress = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Se requiere iniciar sesión.');
    }
    const uid = context.auth.uid;
    await db.collection('players').doc(uid).set({}, { merge: false });
    await db.collection('leaderboard').doc(uid).delete().catch(() => {});
    return { ok: true };
});
