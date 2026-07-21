/**
 * SISTEMA DE LOGROS
 * Modular y aditivo, siguiendo el mismo patrón que level.js: envuelve (wrap) funciones
 * ya existentes para escuchar eventos del juego sin duplicar lógica de combate/economía.
 *
 * Para agregar un logro nuevo alcanza con sumar una entrada a ACHIEVEMENTS_DB (o usar
 * buildChain para una cadena progresiva) indicando su "trigger" (cuándo se re-evalúa) y
 * su getValue() (de dónde saca el progreso actual). Nunca hay condiciones de logros
 * sueltas dentro de la lógica principal del juego: todo vive acá.
 *
 * Persistencia: reutiliza SaveSystem (definido en level.js). El día que se quiera un
 * guardado online alcanza con tocar SaveSystem.get()/set(), no este archivo.
 *
 * UPDATE 7 — BALANCE: todos los umbrales de logros viven como números literales dentro
 * de cada buildChain/buildUnique de más abajo (agrupados por sección) para que ajustar
 * la dificultad sea simplemente cambiar esos números, sin tocar el motor de evaluación.
 * Se subieron considerablemente respecto de la Update 6, sobre todo en las últimas
 * etapas (Mítico/Legendario) y en las cadenas de progreso, para que requieran muchas
 * partidas y no se completen en las primeras horas de juego.
 */

const RARITY = {
    RARO:       { label: 'RARO',        color: '#3498db' },
    SUPER_RARO: { label: 'SÚPER RARO',  color: '#1abc9c' },
    EPICO:      { label: 'ÉPICO',       color: '#9b59b6' },
    MITICO:     { label: 'MÍTICO',      color: '#e74c3c' },
    LEGENDARIO: { label: 'LEGENDARIO',  color: '#f1c40f' }
};

const ACHIEVEMENT_CATEGORIES = {
    COMBAT:      '⚔️ Combate',
    SURVIVAL:    '🛡️ Supervivencia',
    WEAPONS:     '🔫 Armas',
    BOSSES:      '💀 Bosses',
    PROGRESSION: '⭐ Progresión',
    EVENTS:      '🌪️ Eventos',
    EXPLORATION: '🗺️ Exploración',
    SPECIAL:     '🎖️ Especiales'
};

// Mapeo cosmético arma -> categoría (independiente de WEAPONS_DB, solo para agrupar logros)
const WEAPON_CATEGORY = {
    KNIFE: 'melee', MACHETE: 'melee', CHAINSAW: 'melee',
    G18: 'pistol', REVOLVER: 'pistol',
    UZI: 'smg', MP5: 'smg', P90: 'smg',
    SHOTGUN: 'shotgun', SAWEDOFF: 'shotgun', AA12: 'shotgun',
    AK47: 'rifle', M4A1: 'rifle', FAMAS: 'rifle', SCAR: 'rifle',
    WINCHESTER: 'sniper', AWP: 'sniper', SNIPER: 'sniper',
    M249: 'heavy', MINIGUN: 'heavy',
    RPG: 'special', FLAMETHROWER: 'special', CROSSBOW: 'special'
};
const TOTAL_WEAPON_COUNT = Object.keys(WEAPON_CATEGORY).length;

// Íconos por categoría cosmética de arma (mismas claves que WEAPON_CATEGORY),
// usados solo para agrupar/mostrar los logros de "Especialista <categoría>".
const CATEGORY_META = {
    melee:   { icon: '🔪' },
    pistol:  { icon: '🔫' },
    smg:     { icon: '💥' },
    shotgun: { icon: '💢' },
    rifle:   { icon: '🎯' },
    sniper:  { icon: '🔭' },
    heavy:   { icon: '🧱' },
    special: { icon: '🚀' }
};

function fmt(n) { return n.toLocaleString('es-ES'); }

// Recompensa de un logro. Nunca otorga XP "gratis" de más: el xp de logro es aparte del
// xp de nivel (que ahora se rebalanceó en level.js) y sirve como bonus de progreso, no
// reemplaza los requisitos de nivel. Acepta diamantes (moneda nueva, ver level.js).
function reward(opts) {
    opts = opts || {};
    const xp = opts.xp || 0, money = opts.money || 0, diamonds = opts.diamonds || 0;
    const cosmetic = opts.cosmetic || null;
    const parts = [];
    if (xp) parts.push(`+${fmt(xp)} XP`);
    if (money) parts.push(`+$${fmt(money)}`);
    if (diamonds) parts.push(`+${fmt(diamonds)} 💎`);
    if (cosmetic && opts.label) parts.push(opts.label);
    return { xp, money, diamonds, label: parts.join('  ') || opts.label || '', cosmetic };
}

// ---- Progreso/estadísticas usadas exclusivamente por los logros (no duplica lo de level.js) ----
const AchievementStats = Object.assign({
    bossKills: 0, categoryKills: {}, weaponsUsed: [], reloads: 0,
    killStreakNoDeath: 0, bestKillStreak: 0, meleeBossKills: 0,
    perfectWaves: 0, eventsCompleted: 0, eventTypesCompleted: [],
    weaponsPurchased: 0, heavyWeaponPurchased: false, weaponsSold: 0,
    upgradesBuys: 0, upgradesTouched: [], healthPackUses: 0, dashUses: 0,
    proWavesCleared: 0, moneyEarned: 0, bossWavesDefeated: [], lowHpClears: 0,
    pendingMoney: 0
}, SaveSystem.get('achv_stats', {}));

// ---- Estado por logro: solo lo mínimo indispensable (progreso se recalcula en vivo) ----
const AchievementState = SaveSystem.get('achv_state', {});

const ACHIEVEMENTS_DB = {};

function buildChain(idPrefix, category, icon, trigger, nameFn, descFn, getValueFn, stages, hidden) {
    stages.forEach((s, i) => {
        ACHIEVEMENTS_DB[`${idPrefix}_${i + 1}`] = {
            id: `${idPrefix}_${i + 1}`, category, icon, trigger,
            name: nameFn(s.target, i + 1), desc: descFn(s.target, i + 1),
            rarity: s.rarity, target: s.target, getValue: getValueFn,
            reward: reward(s), hidden: !!hidden
        };
    });
}
function buildUnique(id, category, icon, trigger, name, desc, rarity, target, getValue, rewardOpts, hidden) {
    ACHIEVEMENTS_DB[id] = { id, category, icon, trigger, name, desc, rarity, target, getValue, reward: reward(rewardOpts), hidden: !!hidden };
}

// ================= CADENAS PROGRESIVAS =================
// (targets subidos considerablemente en la Update 7 — ver comentario de cabecera)

buildChain('kills_total', 'COMBAT', '🔫', 'kill',
    t => `Exterminador (${fmt(t)})`, t => `Elimina ${fmt(t)} enemigos en total.`,
    () => PlayerProfile.kills,
    [{ target: 300, rarity: 'RARO', xp: 40, money: 60 }, { target: 5000, rarity: 'SUPER_RARO', xp: 150, money: 350 },
     { target: 50000, rarity: 'EPICO', xp: 500, money: 1500 }, { target: 500000, rarity: 'LEGENDARIO', xp: 1500, money: 6000, diamonds: 100 }]);

buildChain('boss_kills', 'BOSSES', '💀', 'kill',
    t => `Cazador de Bosses (${fmt(t)})`, t => `Derrota a ${fmt(t)} jefes.`,
    () => AchievementStats.bossKills,
    [{ target: 3, rarity: 'RARO', xp: 60, money: 120 }, { target: 15, rarity: 'SUPER_RARO', xp: 200, money: 500 },
     { target: 60, rarity: 'EPICO', xp: 600, money: 1800 }, { target: 200, rarity: 'LEGENDARIO', xp: 2000, money: 7000, diamonds: 120 }]);

buildChain('waves_survived', 'SURVIVAL', '🌊', 'waveClear',
    t => `Superviviente (Oleada ${t})`, t => `Sobrevive hasta la oleada ${t}.`,
    () => PlayerProfile.bestWave,
    [{ target: 15, rarity: 'RARO', xp: 80, money: 180 }, { target: 40, rarity: 'SUPER_RARO', xp: 250, money: 600 },
     { target: 80, rarity: 'EPICO', xp: 700, money: 2200 }, { target: 150, rarity: 'LEGENDARIO', xp: 1800, money: 7000, diamonds: 100 }]);

buildChain('playtime', 'SURVIVAL', '⏱️', 'waveClear',
    t => `Veterano de Guerra (${t} min)`, t => `Acumula ${t} minutos de juego.`,
    () => Math.floor(AchievementManager.getTotalPlaySeconds() / 60),
    [{ target: 60, rarity: 'RARO', xp: 60, money: 120 }, { target: 300, rarity: 'SUPER_RARO', xp: 200, money: 450 },
     { target: 900, rarity: 'EPICO', xp: 550, money: 1400 }, { target: 2400, rarity: 'LEGENDARIO', xp: 1500, money: 5000, diamonds: 80 }]);

buildChain('distance', 'EXPLORATION', '🗺️', 'waveClear',
    t => `Nómada (${fmt(t)} m)`, t => `Recorre ${fmt(t)} metros en total.`,
    () => Math.floor(PlayerProfile.distance),
    [{ target: 15000, rarity: 'RARO', xp: 60, money: 120 }, { target: 75000, rarity: 'SUPER_RARO', xp: 200, money: 450 },
     { target: 400000, rarity: 'EPICO', xp: 550, money: 1400 }, { target: 2000000, rarity: 'LEGENDARIO', xp: 1500, money: 5000, diamonds: 80 }]);

buildChain('accuracy', 'COMBAT', '🎯', 'waveClear',
    t => `Puntería (${t}%)`, t => `Alcanza ${t}% de precisión (mínimo 500 disparos).`,
    () => (PlayerProfile.shotsFired >= 500 ? Math.round(PlayerProfile.shotsHit / PlayerProfile.shotsFired * 100) : 0),
    [{ target: 50, rarity: 'RARO', xp: 80, money: 150 }, { target: 70, rarity: 'SUPER_RARO', xp: 250, money: 500 },
     { target: 85, rarity: 'EPICO', xp: 700, money: 1600 }, { target: 95, rarity: 'LEGENDARIO', xp: 1800, money: 5500, diamonds: 90 }]);

buildChain('deaths', 'SURVIVAL', '☠️', 'death',
    t => `Que no te tiemble el gel (${fmt(t)})`, t => `Muere ${fmt(t)} veces. Nadie dijo que fuera fácil.`,
    () => PlayerProfile.deaths,
    [{ target: 1, rarity: 'RARO', xp: 20, money: 30 }, { target: 25, rarity: 'SUPER_RARO', xp: 80, money: 150 },
     { target: 100, rarity: 'EPICO', xp: 300, money: 600 }, { target: 300, rarity: 'LEGENDARIO', xp: 900, money: 2200 }]);

buildChain('reloads', 'WEAPONS', '🔄', 'reload',
    t => `Manos rápidas (${fmt(t)})`, t => `Recarga tus armas ${fmt(t)} veces.`,
    () => AchievementStats.reloads,
    [{ target: 150, rarity: 'RARO', xp: 40, money: 90 }, { target: 800, rarity: 'SUPER_RARO', xp: 140, money: 280 },
     { target: 4000, rarity: 'EPICO', xp: 450, money: 1000 }, { target: 15000, rarity: 'LEGENDARIO', xp: 1200, money: 3500, diamonds: 60 }]);

buildChain('level', 'PROGRESSION', '⭐', 'levelUp',
    t => `Nivel ${t}`, t => `Alcanza el nivel ${t} de jugador.`,
    () => PlayerProfile.level,
    [{ target: 8, rarity: 'RARO', money: 150 }, { target: 18, rarity: 'SUPER_RARO', money: 400 },
     { target: 35, rarity: 'EPICO', money: 1300 }, { target: 60, rarity: 'LEGENDARIO', money: 5000, diamonds: 150 }]);

buildChain('perfect_waves', 'COMBAT', '🛡️', 'waveClear',
    t => `Impecable (${fmt(t)})`, t => `Completa ${fmt(t)} oleadas sin recibir daño.`,
    () => AchievementStats.perfectWaves,
    [{ target: 5, rarity: 'RARO', xp: 60, money: 120 }, { target: 30, rarity: 'SUPER_RARO', xp: 220, money: 550 },
     { target: 120, rarity: 'EPICO', xp: 700, money: 2200 }, { target: 300, rarity: 'LEGENDARIO', xp: 2200, money: 8000, diamonds: 120 }]);

buildChain('kill_streak', 'COMBAT', '🔥', 'kill',
    t => `Racha letal (${fmt(t)})`, t => `Elimina ${fmt(t)} enemigos seguidos sin morir.`,
    () => AchievementStats.bestKillStreak,
    [{ target: 150, rarity: 'RARO', xp: 80, money: 160 }, { target: 700, rarity: 'EPICO', xp: 350, money: 900 },
     { target: 3000, rarity: 'MITICO', xp: 1200, money: 3500, diamonds: 60 }]);

buildChain('events_completed', 'EVENTS', '🌪️', 'eventComplete',
    t => `Curtido en tormentas (${fmt(t)})`, t => `Supera ${fmt(t)} oleadas con un evento dinámico activo.`,
    () => AchievementStats.eventsCompleted,
    [{ target: 5, rarity: 'RARO', xp: 40, money: 90 }, { target: 40, rarity: 'SUPER_RARO', xp: 180, money: 450 },
     { target: 200, rarity: 'EPICO', xp: 600, money: 1700 }]);

buildChain('weapons_used', 'WEAPONS', '🎒', 'shoot',
    t => `Arsenal (${t}/${TOTAL_WEAPON_COUNT})`, t => `Usa ${t} armas distintas al menos una vez.`,
    () => AchievementStats.weaponsUsed.length,
    [{ target: 5, rarity: 'RARO', xp: 50, money: 100 }, { target: 10, rarity: 'SUPER_RARO', xp: 150, money: 300 },
     { target: 15, rarity: 'EPICO', xp: 450, money: 900 }, { target: TOTAL_WEAPON_COUNT, rarity: 'LEGENDARIO', xp: 1200, money: 3000, diamonds: 60 }]);

buildChain('healthpacks', 'SURVIVAL', '💉', 'healthBuy',
    t => `Adicto a la sanación (${fmt(t)})`, t => `Compra curación en la tienda ${fmt(t)} veces.`,
    () => AchievementStats.healthPackUses,
    [{ target: 25, rarity: 'RARO', xp: 40, money: 80 }, { target: 150, rarity: 'SUPER_RARO', xp: 150, money: 300 },
     { target: 600, rarity: 'EPICO', xp: 450, money: 900 }]);

buildChain('pro_graphics', 'SPECIAL', '🖥️', 'waveClear',
    t => `Sin concesiones (${fmt(t)})`, t => `Completa ${fmt(t)} oleadas con gráficos en PRO.`,
    () => AchievementStats.proWavesCleared,
    [{ target: 25, rarity: 'RARO', xp: 60, money: 100 }, { target: 150, rarity: 'EPICO', xp: 250, money: 500 }]);

buildChain('money_earned', 'PROGRESSION', '💰', 'kill',
    t => `Fortuna acumulada ($${fmt(t)})`, t => `Gana $${fmt(t)} en total eliminando enemigos.`,
    () => AchievementStats.moneyEarned,
    [{ target: 5000, rarity: 'RARO', xp: 60, money: 100 }, { target: 50000, rarity: 'SUPER_RARO', xp: 200, money: 400 },
     { target: 750000, rarity: 'EPICO', xp: 700, money: 1500 }, { target: 10000000, rarity: 'LEGENDARIO', xp: 2000, money: 5000, diamonds: 100 }]);

buildChain('shots_fired', 'WEAPONS', '💥', 'shoot',
    t => `Dedo caliente (${fmt(t)})`, t => `Dispara ${fmt(t)} veces en total.`,
    () => PlayerProfile.shotsFired,
    [{ target: 2000, rarity: 'RARO', xp: 40, money: 80 }, { target: 15000, rarity: 'SUPER_RARO', xp: 140, money: 250 },
     { target: 75000, rarity: 'EPICO', xp: 450, money: 900 }, { target: 400000, rarity: 'LEGENDARIO', xp: 1200, money: 3000, diamonds: 60 }]);

// Bajas por categoría de arma (2 escalones cada una)
Object.keys(CATEGORY_META).forEach(cat => {
    const meta = CATEGORY_META[cat];
    buildChain(`cat_kills_${cat}`, 'WEAPONS', meta.icon, 'kill',
        t => `Especialista ${cat.toUpperCase()} (${fmt(t)})`, t => `Elimina ${fmt(t)} enemigos usando armas de categoría "${cat}".`,
        () => AchievementStats.categoryKills[cat] || 0,
        [{ target: 400, rarity: 'RARO', xp: 50, money: 100 }, { target: 5000, rarity: 'EPICO', xp: 350, money: 800 }]);
});

// Sobrevivir a cada tipo de evento notable al menos una vez
[['STORM', '🌩️'], ['SANDSTORM', '🌪️'], ['BLIZZARD', '❄️'], ['RADIOACTIVE', '☢️'], ['INVASION', '💀'], ['DARKNESS', '🌑']].forEach(([key, icon]) => {
    buildUnique(`event_survive_${key}`, 'EVENTS', icon, 'eventSurvive',
        `Superó: ${RANDOM_EVENTS[key].label}`, `Completa una oleada entera con el evento "${RANDOM_EVENTS[key].label}" activo.`,
        'MITICO', 1, () => (AchievementStats.eventTypesCompleted.includes(key) ? 1 : 0), { xp: 250, money: 500, diamonds: 20 });
});

// ================= LOGROS ÚNICOS =================

buildUnique('melee_boss_kill', 'SPECIAL', '🔪', 'kill', 'Filo Contra Titanes',
    'Derrota a un jefe usando únicamente un arma cuerpo a cuerpo.', 'LEGENDARIO', 1,
    () => AchievementStats.meleeBossKills, { xp: 1000, money: 2500, diamonds: 80 }, true);

buildUnique('no_buy_weapons_w15', 'SPECIAL', '🎒', 'waveClear', 'Minimalista',
    'Llega a la oleada 15 sin comprar ninguna arma en la tienda.', 'MITICO', 1,
    () => (PlayerProfile.bestWave >= 15 && AchievementStats.weaponsPurchased === 0 ? 1 : 0), { xp: 600, money: 1500, diamonds: 40 }, true);

buildUnique('level_40_rewards', 'PROGRESSION', '🏅', 'levelUp', 'Veterano Condecorado',
    'Alcanza el nivel 60.', 'EPICO', 1, () => (PlayerProfile.level >= 60 ? 1 : 0),
    { money: 2500, cosmetic: 'title', label: 'Título "Veterano"' });

buildUnique('wave_200', 'SURVIVAL', '🏆', 'waveClear', 'Inmortal del Slime',
    'Sobrevive hasta la oleada 200.', 'LEGENDARIO', 200, () => PlayerProfile.bestWave, { xp: 3000, money: 10000, diamonds: 150 });

buildUnique('boss_wave15', 'BOSSES', '👹', 'kill', 'Segundo Contacto',
    'Derrota al jefe de la oleada 15.', 'EPICO', 1, () => (AchievementStats.bossWavesDefeated.includes(15) ? 1 : 0), { xp: 450, money: 1200 });

buildUnique('boss_wave30', 'BOSSES', '👺', 'kill', 'El Verdadero Desafío',
    'Derrota al jefe de la oleada 30.', 'MITICO', 1, () => (AchievementStats.bossWavesDefeated.includes(30) ? 1 : 0), { xp: 900, money: 2500, diamonds: 40 });

buildUnique('heavy_weapon_purchase', 'WEAPONS', '⚙️', 'buyWeapon', 'Artillería Pesada',
    'Compra tu primera arma de categoría pesada o especial.', 'SUPER_RARO', 1,
    () => (AchievementStats.heavyWeaponPurchased ? 1 : 0), { xp: 100, money: 250 });

buildUnique('sell_weapon_first', 'WEAPONS', '💵', 'sellWeapon', 'Reventa Táctica',
    'Vende un arma en la tienda por primera vez.', 'RARO', 1, () => (AchievementStats.weaponsSold >= 1 ? 1 : 0), { xp: 25, money: 60 });

buildUnique('upgrades_all_maxed', 'PROGRESSION', '📈', 'upgradeBuy', 'Mejora Total',
    'Lleva las 5 mejoras permanentes a su nivel máximo.', 'LEGENDARIO', 1,
    () => (Object.keys(UPGRADES_DB).every(k => Progression.getLevel(k) >= UPGRADES_DB[k].maxLevel) ? 1 : 0),
    { money: 4000, diamonds: 100, cosmetic: 'skin', label: 'Skin exclusiva' });

buildUnique('upgrades_each_one', 'PROGRESSION', '🧬', 'upgradeBuy', 'Todoterreno',
    'Compra al menos un nivel de cada mejora permanente.', 'SUPER_RARO', Object.keys(UPGRADES_DB).length,
    () => AchievementStats.upgradesTouched.length, { xp: 120, money: 300 });

buildUnique('dash_master', 'SPECIAL', '💨', 'dash', 'Maestro del Dash',
    'Utiliza el dash 1500 veces.', 'SUPER_RARO', 1500, () => AchievementStats.dashUses, { xp: 150, money: 400 });

buildUnique('low_hp_clear', 'SURVIVAL', '💓', 'waveClear', 'Al Filo de la Muerte',
    'Termina una oleada con menos del 10% de tu vida máxima.', 'EPICO', 1, () => AchievementStats.lowHpClears, { xp: 250, money: 600 }, true);

// Índice por trigger para no recorrer los ~100 logros en cada evento, solo el subconjunto relevante
const _achTriggerIndex = {};
Object.values(ACHIEVEMENTS_DB).forEach(def => {
    (_achTriggerIndex[def.trigger] = _achTriggerIndex[def.trigger] || []).push(def);
});

const AchievementManager = {
    getState(id) {
        if (!AchievementState[id]) AchievementState[id] = { notified: false, claimed: false };
        return AchievementState[id];
    },
    evaluate(trigger) {
        const defs = _achTriggerIndex[trigger];
        if (!defs) return;
        let dirty = false;
        defs.forEach(def => {
            if (def.getValue() < def.target) return;
            const state = this.getState(def.id);
            if (!state.notified) { state.notified = true; this.showToast(def); dirty = true; }
        });
        if (dirty) this.saveState();
    },
    claim(id) {
        const def = ACHIEVEMENTS_DB[id];
        if (!def) return false;
        const state = this.getState(id);
        if (state.claimed || def.getValue() < def.target) return false;
        state.claimed = true;
        this.applyReward(def);
        this.saveState();
        return true;
    },
    applyReward(def) {
        const r = def.reward;
        if (r.xp) game.grantXP(r.xp);
        if (r.diamonds) game.grantDiamonds(r.diamonds);
        if (r.money) {
            if (game.player) game.player.money += r.money;
            else AchievementStats.pendingMoney += r.money;
        }
        if (r.cosmetic) PlayerProfile.unlocks.push({ achievement: def.id, type: r.cosmetic, label: r.label });
        PlayerProfile.save();
        this.saveStats();
    },
    showToast(def) {
        playSFX('coin', 0.6, 0.05);
        const el = document.getElementById('achievement-toast');
        if (!el) return;
        const rarity = RARITY[def.rarity];
        el.innerHTML = `<div class="achv-toast-header" style="color:${rarity.color}">🏆 LOGRO DESBLOQUEADO — ${rarity.label}</div><div class="achv-toast-name">${def.icon} ${def.name}</div>`;
        el.style.setProperty('--rarity-color', rarity.color);
        el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
    },
    getTotalPlaySeconds() {
        const live = game.started ? Math.floor((Date.now() - game.startTime) / 1000) : 0;
        return PlayerProfile.playTimeSec + live;
    },
    onWaveClear(waveNum, eventKey) {
        if (!this._tookDamageThisWave) AchievementStats.perfectWaves++;
        this._tookDamageThisWave = false;
        if (eventKey) {
            AchievementStats.eventsCompleted++;
            if (!AchievementStats.eventTypesCompleted.includes(eventKey)) AchievementStats.eventTypesCompleted.push(eventKey);
            this.evaluate('eventComplete');
            this.evaluate('eventSurvive');
        }
        if (Settings.graphics === 'PRO') AchievementStats.proWavesCleared++;
        if (game.player && game.player.hp < game.player.maxHp * 0.1) AchievementStats.lowHpClears++;
        this.evaluate('waveClear');
        this.saveStats();
    },
    saveStats() { SaveSystem.set('achv_stats', AchievementStats); },
    saveState() { SaveSystem.set('achv_state', AchievementState); }
};

// ================= HOOKS (envuelven funciones ya existentes, no las reescriben) =================

// Kills: racha, categoría, bosses y dinero ganado, reutilizando la transición viva->muriendo
// que level.js ya usa. Se engancha DESPUÉS de level.js (ver orden de <script> en index.html).
const _achOrigHitEnemy = game.hitEnemy;
game.hitEnemy = function(e, dmg, ...rest) {
    const wasAlive = !e.isDying;
    const wasBoss = e.type === 'BOSS';
    const bossWave = e.bossWave;
    const weapon = this.player && this.player.weapon;
    const moneyBefore = this.player ? this.player.money : 0;
    _achOrigHitEnemy.call(this, e, dmg, ...rest);
    if (wasAlive && e.isDying) {
        AchievementStats.killStreakNoDeath++;
        AchievementStats.bestKillStreak = Math.max(AchievementStats.bestKillStreak, AchievementStats.killStreakNoDeath);
        if (weapon) {
            const cat = WEAPON_CATEGORY[weapon.name];
            if (cat) AchievementStats.categoryKills[cat] = (AchievementStats.categoryKills[cat] || 0) + 1;
        }
        if (wasBoss) {
            AchievementStats.bossKills++;
            if (weapon && weapon.type === 'melee') AchievementStats.meleeBossKills++;
            if (bossWave && !AchievementStats.bossWavesDefeated.includes(bossWave)) AchievementStats.bossWavesDefeated.push(bossWave);
        }
        if (this.player) AchievementStats.moneyEarned += Math.max(0, this.player.money - moneyBefore);
        AchievementManager.evaluate('kill');
    }
};

// Uso de armas (para "Arsenal") + disparos totales: mismo truco que level.js (detectar
// avance de this.lastShot, que el juego solo mueve cuando efectivamente se dispara).
const _achOrigShoot = game.shoot;
game.shoot = function() {
    const w = this.player && this.player.weapon;
    const prevLastShot = this.lastShot;
    _achOrigShoot.call(this);
    if (w && this.lastShot !== prevLastShot) {
        if (!AchievementStats.weaponsUsed.includes(w.name)) AchievementStats.weaponsUsed.push(w.name);
        AchievementManager.evaluate('shoot');
    }
};

// Recargas efectivas
const _achOrigReload = game.reload;
game.reload = function() {
    const w = this.player && this.player.weapon;
    const before = w ? w.ammo : null;
    _achOrigReload.call(this);
    if (w && w.type !== 'melee' && before !== null && before !== w.capacity) {
        AchievementStats.reloads++;
        AchievementManager.evaluate('reload');
    }
};

// Daño recibido en la oleada actual (para "Impecable" y "Al Filo de la Muerte")
const _achOrigTakeDamage = Player.prototype.takeDamage;
Player.prototype.takeDamage = function(amt) {
    AchievementManager._tookDamageThisWave = true;
    _achOrigTakeDamage.call(this, amt);
};

// Dash efectivo
const _achOrigDash = Player.prototype.dash;
Player.prototype.dash = function() {
    const before = this.isDashing;
    _achOrigDash.call(this);
    if (!before && this.isDashing) { AchievementStats.dashUses++; AchievementManager.evaluate('dash'); }
};

// Oleada superada: reutiliza la misma detección de cambio de wave que level.js, pero
// tomando el evento activo ANTES de que EventManager.deactivate() lo limpie dentro del loop original.
const _achOrigLoop = game.loop;
game.loop = function() {
    const waveBefore = this.wave;
    const eventBefore = this.activeEvent;
    _achOrigLoop.call(this);
    if (this.wave !== waveBefore) AchievementManager.onWaveClear(waveBefore, eventBefore);
};

// Subida de nivel
const _achOrigShowLevelUp = game.showLevelUp;
game.showLevelUp = function(level) {
    _achOrigShowLevelUp.call(this, level);
    AchievementManager.evaluate('levelUp');
};

// Muerte del jugador
const _achOrigGameOver = game.gameOver;
game.gameOver = function() {
    _achOrigGameOver.call(this);
    AchievementStats.killStreakNoDeath = 0;
    AchievementManager.evaluate('death');
    AchievementManager.saveStats();
};

// Compra/venta de armas
const _achOrigBuyWeapon = game.buyWeapon;
game.buyWeapon = function(k) {
    const before = this.player.inventory.some(s => s && s.name === k);
    _achOrigBuyWeapon.call(this, k);
    const after = this.player.inventory.some(s => s && s.name === k);
    if (!before && after) {
        AchievementStats.weaponsPurchased++;
        const cat = WEAPON_CATEGORY[k];
        if (cat === 'heavy' || cat === 'special') AchievementStats.heavyWeaponPurchased = true;
        AchievementManager.evaluate('buyWeapon');
        AchievementManager.saveStats();
    }
};
const _achOrigSellWeapon = game.sellWeapon;
game.sellWeapon = function(k) {
    _achOrigSellWeapon.call(this, k);
    AchievementStats.weaponsSold++;
    AchievementManager.evaluate('sellWeapon');
    AchievementManager.saveStats();
};

// Compra de curación en tienda
const _achOrigBuyHealth = game.buyHealth;
game.buyHealth = function() {
    const before = this.player.money;
    _achOrigBuyHealth.call(this);
    if (this.player.money < before) { AchievementStats.healthPackUses++; AchievementManager.evaluate('healthBuy'); }
};

// Mejoras permanentes (progresión entre partidas)
const _achOrigProgBuy = Progression.buy;
Progression.buy = function(k) {
    const result = _achOrigProgBuy.call(this, k);
    if (result) {
        AchievementStats.upgradesBuys++;
        if (!AchievementStats.upgradesTouched.includes(k)) AchievementStats.upgradesTouched.push(k);
        AchievementManager.evaluate('upgradeBuy');
        AchievementManager.saveStats();
    }
    return result;
};

// Dinero pendiente de logros reclamados fuera de partida, se acredita al iniciar la siguiente
const _achOrigInit = game.init;
game.init = function() {
    _achOrigInit.call(this);
    if (AchievementStats.pendingMoney) {
        this.player.money += AchievementStats.pendingMoney;
        AchievementStats.pendingMoney = 0;
        AchievementManager.saveStats();
    }
};

window.addEventListener('beforeunload', () => AchievementManager.saveStats());

// ================= UI: pestaña de Logros dentro del Perfil =================

const _achOrigOpenProfile = game.openProfile;
game.openProfile = function() {
    _achOrigOpenProfile.call(this);
    game.setProfileTab('stats');
};

game.setProfileTab = function(tab) {
    const statsTab = document.getElementById('profile-tab-stats');
    const achvTab = document.getElementById('profile-tab-achv');
    const btnStats = document.getElementById('tab-btn-stats');
    const btnAchv = document.getElementById('tab-btn-achv');
    if (!statsTab || !achvTab) return;
    statsTab.style.display = tab === 'stats' ? 'block' : 'none';
    achvTab.style.display = tab === 'achv' ? 'block' : 'none';
    if (btnStats) btnStats.classList.toggle('active', tab === 'stats');
    if (btnAchv) btnAchv.classList.toggle('active', tab === 'achv');
    if (tab === 'achv') game.renderAchievements();
};

game.claimAchievement = function(id) {
    if (AchievementManager.claim(id)) { playSFX('coin'); game.renderAchievements(); }
};

game.renderAchievements = function() {
    const listEl = document.getElementById('achv-list');
    const summaryEl = document.getElementById('achv-summary');
    if (!listEl) return;
    const searchEl = document.getElementById('achv-search');
    const catEl = document.getElementById('achv-category-filter');
    const statusEl = document.getElementById('achv-status-filter');
    const search = searchEl ? searchEl.value.trim().toLowerCase() : '';
    const catFilter = catEl ? catEl.value : 'ALL';
    const statusFilter = statusEl ? statusEl.value : 'ALL';

    let total = 0, completedCount = 0;
    const cards = [];
    Object.values(ACHIEVEMENTS_DB).forEach(def => {
        total++;
        const value = def.getValue();
        const isCompleted = value >= def.target;
        if (isCompleted) completedCount++;
        const state = AchievementManager.getState(def.id);

        if (catFilter !== 'ALL' && def.category !== catFilter) return;
        if (statusFilter === 'COMPLETED' && !isCompleted) return;
        if (statusFilter === 'UNCLAIMED' && !(isCompleted && !state.claimed)) return;
        if (statusFilter === 'LOCKED' && isCompleted) return;

        const showHidden = def.hidden && !isCompleted;
        const name = showHidden ? '???' : def.name;
        const desc = showHidden ? 'Logro secreto. Descúbrelo jugando.' : def.desc;
        if (search && !name.toLowerCase().includes(search) && !desc.toLowerCase().includes(search)) return;

        const rarity = RARITY[def.rarity];
        const pct = Math.min(100, Math.floor(value / def.target * 100));
        const cardClasses = ['achv-card'];
        if (isCompleted) cardClasses.push('completed');
        if (isCompleted && def.rarity === 'LEGENDARIO') cardClasses.push('legendary-glow');

        let actionHtml;
        if (state.claimed) actionHtml = '<span class="achv-claimed">RECLAMADO</span>';
        else if (isCompleted) actionHtml = `<button class="buy-btn" onclick="game.claimAchievement('${def.id}')">RECLAMAR</button>`;
        else actionHtml = '<span class="achv-locked">🔒</span>';

        cards.push(`<div class="${cardClasses.join(' ')}" style="--rarity-color:${rarity.color}">
            <div class="achv-icon">${showHidden ? '❓' : def.icon}</div>
            <div class="achv-info">
                <div class="achv-name">${name} <span class="achv-rarity" style="color:${rarity.color}">${rarity.label}</span></div>
                <div class="achv-desc">${desc}</div>
                <div class="achv-progress-bar"><div class="achv-progress-inner" style="width:${pct}%; background:${rarity.color}"></div></div>
                <div class="achv-progress-text">${Math.min(value, def.target)} / ${def.target} — ${pct}%</div>
                <div class="achv-reward">🎁 ${def.reward.label || 'Recompensa cosmética'}</div>
            </div>
            <div class="achv-action">${actionHtml}</div>
        </div>`);
    });

    listEl.innerHTML = cards.join('') || '<p style="color:#888;">No hay logros que coincidan con el filtro.</p>';
    if (summaryEl) summaryEl.innerHTML = `<div class="hud-text">Progreso total: ${completedCount} / ${total} (${Math.floor(completedCount / total * 100)}%)</div>`;
};

window.addEventListener('DOMContentLoaded', () => {
    const catSelect = document.getElementById('achv-category-filter');
    if (catSelect) {
        Object.entries(ACHIEVEMENT_CATEGORIES).forEach(([key, label]) => {
            const opt = document.createElement('option');
            opt.value = key; opt.textContent = label;
            catSelect.appendChild(opt);
        });
    }
});
