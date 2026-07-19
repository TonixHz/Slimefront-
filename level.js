/**
 * SISTEMA DE NIVEL / XP + PERFIL DEL JUGADOR
 * Módulo nuevo y aditivo: no reescribe ninguna mecánica existente, solo
 * "envuelve" (wrap) las funciones ya presentes en el juego (game.hitEnemy,
 * game.shoot, game.loop, game.gameOver, Player.prototype.update) para
 * escuchar eventos que ya ocurren y sumar XP / estadísticas sin duplicar
 * lógica de combate, economía ni oleadas.
 *
 * Todo lo persistente pasa por SaveSystem: hoy usa localStorage, el día que
 * se quiera un guardado online alcanza con reemplazar get()/set() acá abajo
 * (por ejemplo por llamadas async a una API) sin tocar el resto del archivo
 * ni el resto del juego.
 */
const SaveSystem = {
    _prefix: 'slime_',
    get(key, fallback) {
        try {
            const raw = localStorage.getItem(this._prefix + key);
            return raw !== null ? JSON.parse(raw) : fallback;
        } catch (e) { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(this._prefix + key, JSON.stringify(value)); } catch (e) {}
    }
};

// Curva de XP: cuánta experiencia hace falta para pasar del nivel N al N+1.
// Creciente y exponencial suave; para ajustar la progresión alcanza con tocar esta función.
function xpToNextLevel(level) {
    return Math.floor(80 * Math.pow(1.16, level - 1));
}

// XP otorgada por eliminar cada tipo de enemigo (mismas claves que REWARDS de dinero en player.js)
const XP_PER_KILL = { BOSS: 250, TANK: 20, RANGED: 12, FAST: 8, BASIC: 6, INVISIBLE: 10, KAMIKAZE: 8, GHOST: 12 };
const XP_PER_KILL_DEFAULT = 6;
// XP por completar una oleada (crece con el número de oleada)
function xpForWaveClear(wave) { return 25 + wave * 6; }

// Recompensas por nivel: único lugar a editar para agregar/cambiar hitos.
// type: 'money' (se acredita directo), 'box'/'skin'/'title' (por ahora solo quedan
// registradas en profile.unlocks, listas para que un sistema de cosméticos las use).
const LEVEL_REWARDS = {
    5:  { type: 'money', amount: 500,  label: '+$500' },
    10: { type: 'box',   label: 'Caja' },
    15: { type: 'skin',  label: 'Skin' },
    20: { type: 'money', amount: 1000, label: '+$1000' },
    25: { type: 'box',   label: 'Caja rara' },
    30: { type: 'title', label: 'Título' },
    40: { type: 'skin',  label: 'Skin épica' }
};

// Perfil persistente del jugador. Preparado para sumar más estadísticas sin migraciones:
// cualquier campo nuevo que se agregue acá simplemente empieza en su valor por defecto
// para partidas viejas (Object.assign conserva lo guardado y completa lo que falte).
const PlayerProfile = Object.assign({
    level: 1, xp: 0,
    playTimeSec: 0, kills: 0, deaths: 0,
    shotsFired: 0, shotsHit: 0,
    weaponUsage: {}, distance: 0, bestWave: 0,
    unlocks: []
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

game.applyLevelReward = function(level) {
    const reward = LEVEL_REWARDS[level];
    if (!reward) return;
    if (reward.type === 'money' && game.player) game.player.money += reward.amount;
    PlayerProfile.unlocks.push({ level, type: reward.type, label: reward.label });
};

game.showLevelUp = function(level) {
    playSFX('coin', 0.7, 0.05);
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
        ['Nivel', p.level],
        ['XP', `${p.xp} / ${xpToNextLevel(p.level)}`],
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
game.hitEnemy = function(e, dmg, ...rest) {
    const wasAlive = !e.isDying;
    _levelOrigHitEnemy.call(this, e, dmg, ...rest);
    PlayerProfile.shotsHit++;
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
