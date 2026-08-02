/**
 * SISTEMA DE NIVEL / XP + PERFIL DEL JUGADOR
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

const PLAYER_PROFILE_DEFAULTS = {
    level: 1, xp: 0,
    playTimeSec: 0, kills: 0, deaths: 0,
    shotsFired: 0, shotsHit: 0,
    weaponUsage: {}, distance: 0, bestWave: 0,
    unlocks: [], diamonds: 0
};
const PlayerProfile = Object.assign({}, PLAYER_PROFILE_DEFAULTS, SaveSystem.get('profile', {}));

PlayerProfile.save = function() { SaveSystem.set('profile', this); };

PlayerProfile.reset = function() {
    Object.keys(PLAYER_PROFILE_DEFAULTS).forEach(k => {
        const d = PLAYER_PROFILE_DEFAULTS[k];
        this[k] = Array.isArray(d) ? [] : (d && typeof d === 'object' ? {} : d);
    });
    this.save();
    if (typeof game !== 'undefined' && game.updateLevelHUD) game.updateLevelHUD();
};

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
    void el.offsetWidth;
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

game.openProfile = function() {
    // hideLobbyScreen (definida en ui.js) también saca la clase body.lobby-active,
    // así el fondo vivo (LobbyScene) sigue dibujándose detrás sin problema —
    // #profile-screen es opaco igual que el resto de pantallas modales.
    if (typeof hideLobbyScreen === 'function') hideLobbyScreen(); else document.getElementById('lobby-screen').style.display = 'none';
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
    if (typeof showLobbyScreen === 'function') showLobbyScreen(); else document.getElementById('lobby-screen').style.display = 'grid';
};

const _levelOrigHitEnemy = game.hitEnemy;
game.hitEnemy = function(e, dmg, meta) {
    const wasAlive = !e.isDying;
    _levelOrigHitEnemy.call(this, e, dmg);
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

const _levelOrigShoot = game.shoot;
game.shoot = function() {
    const w = this.player && this.player.weapon;
    const prevLastShot = this.lastShot;
    _levelOrigShoot.call(this);
    if (w && this.lastShot !== prevLastShot && w.type !== 'melee') {
        PlayerProfile.shotsFired++;
        this._shotHitRegistered = false;
    }
};

const _levelOrigPlayerUpdate = Player.prototype.update;
Player.prototype.update = function(keys) {
    const px = this.x, py = this.y;
    _levelOrigPlayerUpdate.call(this, keys);
    const d = Math.hypot(this.x - px, this.y - py);
    if (d > 0) PlayerProfile.distance += d;
};

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

const _levelOrigGameOver = game.gameOver;
game.gameOver = function() {
    PlayerProfile.deaths++;
    PlayerProfile.playTimeSec += Math.floor((Date.now() - this.startTime) / 1000);
    PlayerProfile.bestWave = Math.max(PlayerProfile.bestWave, this.wave - 1);
    PlayerProfile.save();
    _levelOrigGameOver.call(this);
};

window.addEventListener('beforeunload', () => PlayerProfile.save());

SaveSystem.onRemoteData(function(keys) {
    if (!keys.includes('profile')) return;
    Object.assign(PlayerProfile, SaveSystem.get('profile', {}));
    game.updateLevelHUD();
    if (typeof game.refreshLobbyPanels === 'function') game.refreshLobbyPanels();
});

window.addEventListener('DOMContentLoaded', () => {
    // El botón de "Perfil" ahora vive como tarjeta de navegación ("Logros" abre
    // el perfil en la pestaña de logros) en el lobby v2 (ver game.buildLobby en
    // main.js), así que ya no hace falta inyectar un botón extra acá.
    game.updateLevelHUD();
});
