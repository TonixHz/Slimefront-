/**
 * CLOUD FUNCTIONS — Único camino de escritura hacia /players/{uid} y /leaderboard/{uid}.
 * (Sin cambios de contenido respecto a la versión original del proyecto;
 * movido a functions/ para coincidir con "source": "functions" en firebase.json.)
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

const ALLOWED_KEYS = ['profile', 'progression', 'achv_stats', 'achv_state'];
const MAX_UPGRADE_LEVEL = 5;

function clampNum(v, min, max, fallback = min) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}
function str(v, maxLen = 60) {
    return (typeof v === 'string') ? v.slice(0, maxLen) : '';
}

const VALIDATORS = {
    profile(incoming, previous) {
        if (typeof incoming !== 'object' || incoming === null) return null;
        const prev = previous || {};
        const prevLevel = clampNum(prev.level, 1, 5000, 1);

        const out = {};
        out.level = Math.max(prevLevel, clampNum(incoming.level, 1, prevLevel + 20, prevLevel));
        const incomingXp = clampNum(incoming.xp, 0, 10_000_000, 0);
        // XP can reset on level-up: preserve the newer level's XP, otherwise
        // take the maximum when both devices are on the same level.
        out.xp = out.level > prevLevel ? incomingXp
            : out.level < prevLevel ? clampNum(prev.xp, 0, 10_000_000, 0)
            : Math.max(clampNum(prev.xp, 0, 10_000_000, 0), incomingXp);
        out.playTimeSec = Math.max(clampNum(prev.playTimeSec, 0, 1e9, 0),
            clampNum(incoming.playTimeSec, 0, clampNum(prev.playTimeSec, 0, 1e9, 0) + 60 * 60 * 6, prev.playTimeSec || 0));
        out.kills = Math.max(clampNum(prev.kills, 0, 1e12, 0),
            clampNum(incoming.kills, 0, clampNum(prev.kills, 0, 1e12, 0) + 100000, prev.kills || 0));
        out.deaths = Math.max(clampNum(prev.deaths, 0, 1e9, 0),
            clampNum(incoming.deaths, 0, clampNum(prev.deaths, 0, 1e9, 0) + 5000, prev.deaths || 0));
        out.shotsFired = Math.max(clampNum(prev.shotsFired, 0, 1e12, 0),
            clampNum(incoming.shotsFired, 0, clampNum(prev.shotsFired, 0, 1e12, 0) + 500000, prev.shotsFired || 0));
        out.shotsHit = Math.min(out.shotsFired, Math.max(clampNum(prev.shotsHit, 0, 1e12, 0),
            clampNum(incoming.shotsHit, 0, 1e12, 0)));
        out.distance = Math.max(clampNum(prev.distance, 0, 1e12, 0),
            clampNum(incoming.distance, 0, clampNum(prev.distance, 0, 1e12, 0) + 50_000_000, prev.distance || 0));
        out.bestWave = Math.max(clampNum(prev.bestWave, 0, 100000, 0),
            clampNum(incoming.bestWave, 0, clampNum(prev.bestWave, 0, 100000, 0) + 50, prev.bestWave || 0));
        out.diamonds = Math.max(clampNum(prev.diamonds, 0, 1e9, 0),
            clampNum(incoming.diamonds, 0, clampNum(prev.diamonds, 0, 1e9, 0) + 100000, prev.diamonds || 0));

        out.weaponUsage = {};
        const previousUsage = prev.weaponUsage && typeof prev.weaponUsage === 'object' ? prev.weaponUsage : {};
        const incomingUsage = incoming.weaponUsage && typeof incoming.weaponUsage === 'object' ? incoming.weaponUsage : {};
        [...new Set([...Object.keys(previousUsage), ...Object.keys(incomingUsage)])].slice(0, 40).forEach(k => {
            out.weaponUsage[str(k, 20)] = Math.max(clampNum(previousUsage[k], 0, 1e9, 0),
                clampNum(incomingUsage[k], 0, 1e9, 0));
        });
        const unlockKey = u => `${clampNum(u && u.level, 0, 5000, 0)}:${str(u && u.type, 20)}`;
        const unlocks = new Map();
        [...(Array.isArray(prev.unlocks) ? prev.unlocks : []), ...(Array.isArray(incoming.unlocks) ? incoming.unlocks : [])]
            .forEach(u => {
                if (!u || typeof u !== 'object') return;
                const clean = { level: clampNum(u.level, 0, 5000, 0), type: str(u.type, 20), label: str(u.label, 60) };
                unlocks.set(unlockKey(clean), clean);
            });
        out.unlocks = [...unlocks.values()].slice(0, 500);
        return out;
    },

    progression(incoming, previous) {
        if (typeof incoming !== 'object' || incoming === null) return null;
        const prevLevels = (previous && previous.levels) || {};
        const levels = {};
        const src = (incoming.levels && typeof incoming.levels === 'object') ? incoming.levels : {};
        Object.keys(src).slice(0, 20).forEach(k => {
            const prevLvl = clampNum(prevLevels[k], 0, MAX_UPGRADE_LEVEL, 0);
            levels[k] = Math.max(prevLvl, clampNum(src[k], 0, Math.min(MAX_UPGRADE_LEVEL, prevLvl + 1), prevLvl));
        });
        return { levels };
    },

    achv_stats(incoming, previous) {
        if (typeof incoming !== 'object' || incoming === null) return null;
        const prev = previous || {};
        const out = {};
        // These fields are cumulative counters. pendingMoney is intentionally
        // excluded: it is a consumable queue that is cleared after claiming, not
        // a lifetime statistic, so max-merging it can re-grant already claimed money.
        const numFields = ['bossKills', 'reloads', 'killStreakNoDeath', 'bestKillStreak', 'meleeBossKills',
            'perfectWaves', 'eventsCompleted', 'weaponsPurchased', 'weaponsSold', 'upgradesBuys',
            'healthPackUses', 'dashUses', 'proWavesCleared', 'moneyEarned', 'lowHpClears'];
        numFields.forEach(f => {
            const prevV = clampNum(prev[f], 0, 1e12, 0);
            out[f] = Math.max(prevV, clampNum(incoming[f], 0, prevV + 100000, prevV));
        });
        // Pending rewards are mutable. Accept a validated snapshot instead of
        // forcing it upward, otherwise a stale cloud value can resurrect a claim.
        out.pendingMoney = clampNum(incoming.pendingMoney, 0, 1e9, 0);
        out.heavyWeaponPurchased = !!(prev.heavyWeaponPurchased || incoming.heavyWeaponPurchased);
        out.categoryKills = {};
        const previousCategories = prev.categoryKills && typeof prev.categoryKills === 'object' ? prev.categoryKills : {};
        const incomingCategories = incoming.categoryKills && typeof incoming.categoryKills === 'object' ? incoming.categoryKills : {};
        [...new Set([...Object.keys(previousCategories), ...Object.keys(incomingCategories)])].slice(0, 20).forEach(k => {
            out.categoryKills[str(k, 20)] = Math.max(clampNum(previousCategories[k], 0, 1e9, 0),
                clampNum(incomingCategories[k], 0, 1e9, 0));
        });
        ['weaponsUsed', 'eventTypesCompleted', 'upgradesTouched', 'bossWavesDefeated'].forEach(f => {
            const values = [...(Array.isArray(prev[f]) ? prev[f] : []), ...(Array.isArray(incoming[f]) ? incoming[f] : [])];
            out[f] = [...new Set(values.map(v => typeof v === 'string' ? str(v, 20) : clampNum(v, 0, 100000, 0)))].slice(0, 100);
        });
        return out;
    },

    achv_state(incoming, previous) {
        if (typeof incoming !== 'object' || incoming === null) return null;
        const out = {};
        const prev = previous && typeof previous === 'object' ? previous : {};
        [...new Set([...Object.keys(prev), ...Object.keys(incoming)])].slice(0, 500).forEach(id => {
            const oldState = prev[id] || {};
            const newState = incoming[id] || {};
            out[str(id, 60)] = {
                notified: !!oldState.notified || !!newState.notified,
                claimed: !!oldState.claimed || !!newState.claimed
            };
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
    // Transaction serializes concurrent writes from multiple devices. Validators
    // merge counters/unlocks monotonically so an older offline snapshot cannot
    // roll back progression already accepted from another device.
    const patch = await db.runTransaction(async transaction => {
        const snap = await transaction.get(docRef);
        const previous = snap.exists ? snap.data() : {};
        const nextPatch = {};
        ALLOWED_KEYS.forEach(key => {
            if (!(key in data)) return;
            const clean = VALIDATORS[key](data[key], previous[key]);
            if (clean !== null) nextPatch[key] = clean;
        });
        if (Object.keys(nextPatch).length === 0) return {};
        nextPatch._updatedAt = admin.firestore.FieldValue.serverTimestamp();
        transaction.set(docRef, nextPatch, { merge: true });
        return nextPatch;
    });

    if (Object.keys(patch).length === 0) {
        return { ok: true, written: [] };
    }

    if (patch.profile) {
        const leaderboardRef = db.collection('leaderboard').doc(uid);
        await db.runTransaction(async transaction => {
            const snap = await transaction.get(leaderboardRef);
            const previous = snap.exists ? snap.data() : {};
            transaction.set(leaderboardRef, {
                name: str(context.auth.token.name || context.auth.token.email || previous.name || 'Jugador', 40),
                level: Math.max(clampNum(previous.level, 1, 5000, 1), patch.profile.level),
                bestWave: Math.max(clampNum(previous.bestWave, 0, 100000, 0), patch.profile.bestWave),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });
    }

    return { ok: true, written: Object.keys(patch).filter(key => key !== '_updatedAt') };
});

exports.clearProgress = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Se requiere iniciar sesión.');
    }
    const uid = context.auth.uid;
    await db.collection('players').doc(uid).delete();
    await db.collection('leaderboard').doc(uid).delete().catch(() => {});
    return { ok: true };
});
