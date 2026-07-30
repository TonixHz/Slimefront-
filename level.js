/**
 * SISTEMA DE NIVEL / XP + PERFIL DEL JUGADOR
 * Módulo nuevo y aditivo: no reescribe ninguna mecánica existente, solo
 * "envuelve" (wrap) las funciones ya presentes en el juego (game.hitEnemy,
 * game.shoot, game.loop, game.gameOver, Player.prototype.update) para
 * escuchar eventos que ya ocurren y sumar XP / estadísticas sin duplicar
 * lógica de combate, economía ni oleadas.
 *
 * NOTA (migración a Firebase): el SaveSystem (localStorage puro) que antes vivía
 * acá se reemplazó por FirebaseSaveSystem.js (Auth + Firestore + caché local,
 * offline-first). Ese archivo se carga ANTES que este y define el mismo objeto
 * global `SaveSystem` con exactamente la misma interfaz (get/set), así que todo
 * lo de más abajo sigue funcionando sin cambios.
 *
 * Como el login con Google resuelve de forma asíncrona (después de que este
 * script ya construyó PlayerProfile con lo que había en la caché local), nos
 * suscribimos con SaveSystem.onRemoteData para "refrescar" PlayerProfile si
 * llegan datos más nuevos desde la nube una vez el usuario inicia sesión.
 */

/**
 * UPDATE 7 — BALANCE DE PROGRESIÓN
 * Todo el ritmo de la experiencia vive en este único objeto: subir XP_CONFIG.curveBase
 * o bajar los valores de perKill/waveClear alcanza para rebalancear el juego entero sin
 * tocar la lógica de más abajo. Respecto de la Update 6 se bajó mucho la XP otorgada por
 * kill/oleada y se subió la curva de nivel, para que los niveles altos cuesten de verdad.
 */
const XP_CONFIG = {
    curveBase: 150,      // XP para pasar de nivel 1 a 2
    curveGrowth: 1.22,   // multiplicador de dificultad por cada nivel adicional
    perKill: { BOSS: 40, TANK: 3, RANGED: 2, FAST: 1, BASIC: 1, INVISIBLE: 2, KAMIKAZE: 1, GHOST: 2 },
    perKillDefault: 1,
    waveClearBase: 8,
    waveClearPerWave: 2
};

// Curva de XP: cuánta experiencia hace falta para pasar del nivel N al N+1.
function xpToNextLevel(level) {
    return Math.floor(XP_CONFIG.curveBase * Math.pow(XP_CONFIG.curveGrowth, level - 1));
}

// XP otorgada por eliminar cada tipo de enemigo (mismas claves que REWARDS de dinero en player.js)
const XP_PER_KILL = XP_CONFIG.perKill;
const XP_PER_KILL_DEFAULT = XP_CONFIG.perKillDefault;
// XP por completar una oleada (crece con el número de oleada)
function xpForWaveClear(wave) { return XP_CONFIG.waveClearBase + wave * XP_CONFIG.waveClearPerWave; }

// Recompensas por nivel: único lugar a editar para agregar/cambiar hitos.
// type: 'money' (se acredita directo), 'diamonds' (moneda premium, ver PlayerProfile.diamonds),
// 'box'/'skin'/'title' (por ahora solo quedan registradas en profile.unlocks, listas para que
// un sistema de cosméticos las use). IMPORTANTE (Update 7): los niveles NUNCA otorgan XP como
// recompensa (el XP ya es lo que cuesta subir de nivel); solo dinero/diamantes/cosméticos.
const LEVEL_REWARDS = {
    5:  { type: 'money', amount: 300, label: '+$300' },
    10: { type: 'diamonds', amount: 20, label: '+20 💎' },
    15: { type: 'box', label: 'Caja' },
    20: { type: 'money', amount: 800, label: '+$800' },
    25: { type: 'diamonds', amount: 50, label: '+50 💎' },
    30: { type: 'skin', label: 'Skin' },
    40: { type: 'title', label: 'Título' },
    50: { type: 'diamonds', amount: 100, label: '+100 💎' }
};

// Perfil persistente del jugador. Preparado para sumar más estadísticas sin migraciones:
// cualquier campo nuevo que se agregue acá simplemente empieza en su valor por defecto
// para partidas viejas (Object.assign conserva lo guardado y completa lo que falte).
const PlayerProfile = Object.assign({
    level: 1, xp: 0,
    playTimeSec: 0, kills: 0, deaths: 0,
    shotsFired: 0, shotsHit: 0,
    weaponUsage: {}, distance: 0, bestWave: 0,
    unlocks: [], diamonds: 0
}, SaveSystem.get('profile', {}));

PlayerProfile.save = function() { SaveSystem.set('profile', this); }; // funciones no se serializan, JSON.stringify las ignora solo

game.grantXP = function(amount) {
    amount = Math.floor(amount);
    if (amount <= 0) return;
    PlayerProfile.xp += amount;
    let leveledUp = false;
    while (PlayerProfile.xp >= xpToNextLevel(PlayerProfile.level)) {
        PlayerProfile.xp -= xpToNextLevel(PlayerProfile.level);
        PlayerProfile.level++;
        leveledUp = true;
        game.applyLevelReward(PlayerProfile.level);
    }
    if (leveledUp) game.showLevelUp(PlayerProfile.level);
    PlayerProfile.save();
};

// Moneda premium nueva (Update 7). Se acredita directo si hay partida en curso; si no,
// como PlayerProfile.diamonds es persistente y no depende de game.player, no necesita
// cola de "pendiente" como el dinero de logros: siempre está disponible.
game.grantDiamonds = function(amount) {
    amount = Math.floor(amount);
    if (amount <= 0) return;
    PlayerProfile.diamonds += amount;
    PlayerProfile.save();
};

game.applyLevelReward = function(level) {
    const reward = LEVEL_REWARDS[level];
    if (!reward) return;
    if (reward.type === 'money' && game.player) game.player.money += reward.amount;
    if (reward.type === 'diamonds') game.grantDiamonds(reward.amount);
    PlayerProfile.unlocks.push({ level, type: reward.type, label: reward.label });
};

game.showLevelUp = function(level) {
    playSFX('levelup', 0.7, 0.05);
    const el = document.getElementById('levelup-toast');
    if (!el) return;
    const reward = LEVEL_REWARDS[level];
    el.innerHTML = `¡NIVEL ${level}!` + (reward ? `<span>${reward.label}</span>` : '');
    el.classList.remove('show');
    void el.offsetWidth; // fuerza reflow para poder re-disparar la animación en niveles consecutivos
    el.classList.add('show');
    clearTimeout(game._levelupToastTimer);
    game._levelupToastTimer = setTimeout(() => el.classList.remove('show'), 2400);
};

game.updateLevelHUD = function() {
    const lvlEl = document.getElementById('level-display');
    const xpEl = document.getElementById('xp-inner');
    if (!lvlEl || !xpEl) return;
    lvlEl.innerText = "NIVEL " + PlayerProfile.level;
    xpEl.style.width = Math.min(100, (PlayerProfile.xp / xpToNextLevel(PlayerProfile.level)) * 100) + "%";
};

// ---- Pantalla de Perfil ----
game.openProfile = function() {
    document.getElementById('lobby-screen').style.display = 'none';
    const p = PlayerProfile;
    const acc = p.shotsFired > 0 ? Math.min(100, Math.round(p.shotsHit / p.shotsFired * 100)) : 0;
    const favEntry = Object.entries(p.weaponUsage).sort((a, b) => b[1] - a[1])[0];
    const favWeapon = favEntry ? favEntry[0] : '--';
    const liveSec = this.started ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
    const totalSec = p.playTimeSec + liveSec;
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0'), ss = String(totalSec % 60).padStart(2, '0');
    const rows = [
        ['Cuenta', typeof AuthUI !== 'undefined' ? AuthUI.currentLabel() : 'Invitado (local)'],
        ['Nivel', p.level],
        ['XP', `${p.xp} / ${xpToNextLevel(p.level)}`],
        ['Diamantes', '💎 ' + p.diamonds],
        ['Tiempo jugado', `${mm}:${ss}`],
        ['Zombies eliminados', p.kills],
        ['Precisión', acc + '%'],
        ['Arma favorita', favWeapon],
        ['Distancia recorrida', Math.floor(p.distance) + ' m'],
        ['Mayor oleada', p.bestWave],
        ['Muertes', p.deaths]
    ];
    document.getElementById('profile-stats').innerHTML = rows.map(([label, val]) =>
        `<div class="upgrade-row"><span class="upgrade-name">${label}</span><span class="hud-text">${val}</span></div>`
    ).join('');
    document.getElementById('profile-screen').style.display = 'flex';
};
game.closeProfile = function() {
    document.getElementById('profile-screen').style.display = 'none';
    document.getElementById('lobby-screen').style.display = 'flex';
};

// ---- Hooks (wrapping no invasivo de funciones ya existentes) ----

// Kills + XP por enemigo + arma favorita: se detecta la transición viva -> muriendo
// dentro del mismo hitEnemy que ya usa el juego para dinero/partículas/floating text.
const _levelOrigHitEnemy = game.hitEnemy;
game.hitEnemy = function(e, dmg, meta) {
    const wasAlive = !e.isDying;
    _levelOrigHitEnemy.call(this, e, dmg);
    // Solo cuenta como "impacto" (precisión) los golpes marcados como disparo
    // real del jugador, y como máximo 1 por disparo efectivamente hecho (evita
    // que perdigones de escopeta que pegan en varios enemigos, o el pierce,
    // inflen shotsHit por sobre lo que realmente disparó el jugador).
    if (meta && meta.playerShot && !this._shotHitRegistered) {
        PlayerProfile.shotsHit++;
        this._shotHitRegistered = true;
    }
    if (wasAlive && e.isDying) {
        PlayerProfile.kills++;
        const w = this.player && this.player.weapon;
        if (w) PlayerProfile.weaponUsage[w.name] = (PlayerProfile.weaponUsage[w.name] || 0) + 1;
        game.grantXP(XP_PER_KILL[e.type] ?? XP_PER_KILL_DEFAULT);
    }
};

// Disparos efectivos (para precisión): se detecta comparando game.lastShot antes/después,
// que el propio juego ya actualiza únicamente cuando el arma efectivamente dispara.
const _levelOrigShoot = game.shoot;
game.shoot = function() {
    const w = this.player && this.player.weapon;
    const prevLastShot = this.lastShot;
    _levelOrigShoot.call(this);
    if (w && this.lastShot !== prevLastShot && w.type !== 'melee') {
        PlayerProfile.shotsFired++;
        this._shotHitRegistered = false; // nuevo disparo: habilita registrar como máx. 1 impacto
    }
};

// Distancia recorrida: se mide el desplazamiento real ya aplicado por el movimiento del jugador.
const _levelOrigPlayerUpdate = Player.prototype.update;
Player.prototype.update = function(keys) {
    const px = this.x, py = this.y;
    _levelOrigPlayerUpdate.call(this, keys);
    const d = Math.hypot(this.x - px, this.y - py);
    if (d > 0) PlayerProfile.distance += d;
};

// Oleadas: XP por cada oleada superada + refresco del HUD de nivel, enganchado al loop principal
// (se detecta el mismo incremento de this.wave que ya dispara la tienda entre oleadas).
const _levelOrigLoop = game.loop;
game.loop = function() {
    const waveBefore = this.wave;
    _levelOrigLoop.call(this);
    if (this.wave !== waveBefore) {
        game.grantXP(xpForWaveClear(waveBefore));
        PlayerProfile.bestWave = Math.max(PlayerProfile.bestWave, waveBefore);
        PlayerProfile.save();
    }
    game.updateLevelHUD();
};

// Muertes + tiempo jugado acumulado, sin tocar la lógica de fin de partida existente.
const _levelOrigGameOver = game.gameOver;
game.gameOver = function() {
    PlayerProfile.deaths++;
    PlayerProfile.playTimeSec += Math.floor((Date.now() - this.startTime) / 1000);
    PlayerProfile.bestWave = Math.max(PlayerProfile.bestWave, this.wave - 1);
    PlayerProfile.save();
    _levelOrigGameOver.call(this);
};

window.addEventListener('beforeunload', () => PlayerProfile.save());

// ---- Migración a Firebase: refresco cuando llegan datos remotos más nuevos que la
// caché local con la que se armó PlayerProfile al cargar este script ----
SaveSystem.onRemoteData(function(keys) {
    if (!keys.includes('profile')) return;
    Object.assign(PlayerProfile, SaveSystem.get('profile', {}));
    game.updateLevelHUD();
});

// Botón de Perfil en el lobby + HUD inicial. Se registra después que main.js arma el
// innerHTML del lobby, así que se agrega al final del panel sin pisar nada.
window.addEventListener('DOMContentLoaded', () => {
    const panel = document.querySelector('#lobby-screen .menu-panel');
    if (panel) {
        const btn = document.createElement('button');
        btn.className = 'menu-btn';
        btn.textContent = '🪪 PERFIL';
        btn.onclick = () => game.openProfile();
        panel.appendChild(btn);
    }
    game.updateLevelHUD();
});
