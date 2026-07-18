/**
 * AJUSTES DEL JUGADOR
 */
const GRAPHICS_PRESETS = {
    LOW:    { props: 100, particles: 100, casings: 30,  projectiles: 60,  trails: 60,  shadows: false },
    MEDIUM: { props: 200, particles: 200, casings: 60,  projectiles: 100, trails: 120, shadows: true },
    PRO:    { props: 300, particles: 300, casings: 100, projectiles: 150, trails: 200, shadows: true }
};

const Settings = {
    graphics: localStorage.getItem('slime_graphics') || 'PRO',
    sfxVolume: localStorage.getItem('slime_sfxVolume') !== null ? parseInt(localStorage.getItem('slime_sfxVolume')) : 100,
    musicVolume: localStorage.getItem('slime_musicVolume') !== null ? parseInt(localStorage.getItem('slime_musicVolume')) : 100,
    hudSize: localStorage.getItem('slime_hudSize') !== null ? parseInt(localStorage.getItem('slime_hudSize')) : 3,
    bestWave: parseInt(localStorage.getItem('slime_bestWave')) || 0,
    save() {
        localStorage.setItem('slime_graphics', this.graphics);
        localStorage.setItem('slime_sfxVolume', this.sfxVolume);
        localStorage.setItem('slime_musicVolume', this.musicVolume);
        localStorage.setItem('slime_hudSize', this.hudSize);
        localStorage.setItem('slime_bestWave', this.bestWave);
    }
};

/**
 * PROGRESIÓN ENTRE PARTIDAS (puntos de mejora persistentes)
 */
const UPGRADES_DB = {
    hp:      { label: '❤️ VIDA MÁXIMA (+10)',      base: 150, perLevel: 150, maxLevel: 5, value: 10 },
    stamina: { label: '🏃 STAMINA MÁXIMA (+10)',    base: 150, perLevel: 150, maxLevel: 5, value: 10 },
    damage:  { label: '⚔️ DAÑO GLOBAL (+5%)',       base: 250, perLevel: 250, maxLevel: 5, value: 0.05 },
    reload:  { label: '⏱️ VELOCIDAD DE RECARGA (+5%)', base: 250, perLevel: 250, maxLevel: 5, value: 0.05 },
    money:   { label: '💰 DINERO INICIAL (+100)',   base: 150, perLevel: 150, maxLevel: 5, value: 100 }
};

const Progression = {
    points: parseInt(localStorage.getItem('slime_points')) || 0,
    levels: JSON.parse(localStorage.getItem('slime_upgrades') || '{}'),
    save() {
        localStorage.setItem('slime_points', this.points);
        localStorage.setItem('slime_upgrades', JSON.stringify(this.levels));
    },
    getLevel(k) { return this.levels[k] || 0; },
    cost(k) { const u = UPGRADES_DB[k]; return u.base + u.perLevel * this.getLevel(k); },
    buy(k) {
        const u = UPGRADES_DB[k];
        const lvl = this.getLevel(k);
        if (lvl >= u.maxLevel) return false;
        const c = this.cost(k);
        if (this.points < c) return false;
        this.points -= c;
        this.levels[k] = lvl + 1;
        this.save();
        return true;
    },
    getBonus(k) { return UPGRADES_DB[k].value * this.getLevel(k); },
    awardForRun(wavesSurvived) {
        this.points += wavesSurvived * 10;
        this.save();
    }
};

/**
 * CATEGORÍAS DE ARMA (íconos/colores para hotbar y tienda)
 */
const CATEGORY_META = {
    melee:   { icon: '🔪', color: '#bdc3c7' },
    pistol:  { icon: '🔫', color: '#f1c40f' },
    smg:     { icon: '💨', color: '#e67e22' },
    shotgun: { icon: '💥', color: '#e74c3c' },
    rifle:   { icon: '🎯', color: '#2ecc71' },
    sniper:  { icon: '🔭', color: '#34495e' },
    heavy:   { icon: '⚙️', color: '#c0392b' },
    special: { icon: '☢️', color: '#8e44ad' }
};

// ---- Lobby / Pausa / Ajustes ----
game.startFromLobby = function() {
    document.getElementById('lobby-screen').style.display = 'none';
    MusicManager.duck(500);
    MusicManager.tracks = MusicManager.combatTracks;
    MusicManager.currentIndex = -1;
    this.init();
};

game.toggleEscMenu = function() {
    if(!this.started) return;
    if(document.getElementById('shop-menu').style.display === 'block') return;
    const menu = document.getElementById('esc-menu');
    const isOpen = menu.style.display === 'flex';
    if(isOpen) this.closeEscMenu();
    else {
        menu.style.display = 'flex';
        this.paused = true;
        MusicManager.duck(400);
    }
};

game.closeEscMenu = function() {
    document.getElementById('esc-menu').style.display = 'none';
    this.paused = false;
    MusicManager.resume(600);
};

game.goToMainMenu = function() { location.reload(); };

game.openSettings = function(from) {
    this.settingsOrigin = from;
    document.getElementById(from === 'lobby' ? 'lobby-screen' : 'esc-menu').style.display = 'none';
    document.getElementById('settings-panel').style.display = 'flex';
    document.getElementById('sfx-vol-slider').value = Settings.sfxVolume;
    document.getElementById('music-vol-slider').value = Settings.musicVolume;
    document.getElementById('sfx-vol-value').innerText = Settings.sfxVolume;
    document.getElementById('music-vol-value').innerText = Settings.musicVolume;
    document.querySelectorAll('#graphics-options .option-btn').forEach(b => b.classList.toggle('active', b.dataset.value === Settings.graphics));
    document.querySelectorAll('#hud-size-options .option-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.value) === Settings.hudSize));
};

game.closeSettings = function() {
    document.getElementById('settings-panel').style.display = 'none';
    document.getElementById(this.settingsOrigin === 'lobby' ? 'lobby-screen' : 'esc-menu').style.display = 'flex';
};

game.setGraphics = function(tier) {
    Settings.graphics = tier;
    Settings.save();
    document.querySelectorAll('#graphics-options .option-btn').forEach(b => b.classList.toggle('active', b.dataset.value === tier));
};

game.setSfxVolume = function(v) { Settings.sfxVolume = parseInt(v); Settings.save(); document.getElementById('sfx-vol-value').innerText = v; };
game.setMusicVolume = function(v) { 
    Settings.musicVolume = parseInt(v); 
    Settings.save(); 
    document.getElementById('music-vol-value').innerText = v;
    MusicManager.baseVolume = 0.25 * (Settings.musicVolume / 100);
    if(MusicManager.audio && !MusicManager.audio.paused) MusicManager.audio.volume = MusicManager.baseVolume;
};
game.setHudSize = function(v) {
    Settings.hudSize = parseInt(v);
    Settings.save();
    document.body.dataset.hudSize = Settings.hudSize;
    document.querySelectorAll('#hud-size-options .option-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.value) === Settings.hudSize));
};
document.body.dataset.hudSize = Settings.hudSize;

// Pantalla de Controles
game.toggleControls = function(show) {
    document.getElementById('lobby-screen').style.display = show ? 'none' : 'flex';
    document.getElementById('controls-panel').style.display = show ? 'flex' : 'none';
};

// Pantalla de Mejoras (progresión persistente)
game.openUpgrades = function() {
    document.getElementById('lobby-screen').style.display = 'none';
    document.getElementById('upgrades-screen').style.display = 'flex';
    this.renderUpgrades();
};
game.closeUpgrades = function() {
    document.getElementById('upgrades-screen').style.display = 'none';
    document.getElementById('lobby-screen').style.display = 'flex';
};
game.renderUpgrades = function() {
    document.getElementById('upgrade-points').innerText = Progression.points;
    const list = document.getElementById('upgrades-list');
    list.innerHTML = "";
    Object.keys(UPGRADES_DB).forEach(k => {
        const u = UPGRADES_DB[k];
        const lvl = Progression.getLevel(k);
        const maxed = lvl >= u.maxLevel;
        const cost = Progression.cost(k);
        list.innerHTML += `<div class="upgrade-row">
            <span class="upgrade-name">${u.label} — Nv ${lvl}/${u.maxLevel}</span>
            ${maxed ? '<span class="weapon-row-status owned">MAX</span>' : `<button class="buy-btn" onclick="game.buyUpgrade('${k}')">${cost} PTS</button>`}
        </div>`;
    });
};
game.buyUpgrade = function(k) {
    if (Progression.buy(k)) { playSFX('coin'); this.renderUpgrades(); }
};

game.updateShop = function() {
    const list = document.getElementById('shop-items');
    list.innerHTML = "";
    Object.keys(WEAPONS_DB).forEach(k => {
        const w = WEAPONS_DB[k];
        const meta = CATEGORY_META[w.cat] || CATEGORY_META.pistol;
        const owned = this.player.inventory.some(i => i && i.name === k);
        const cost = WEAPON_COSTS[k] || 0;
        const unlockWave = WEAPON_UNLOCK_WAVE[k] || 1;
        const desc = w.desc || '';
        let statusHtml, actionHtml = '';
        if (owned) {
            const refund = Math.floor(cost / 2);
            statusHtml = `<span class="weapon-row-status owned">ADQUIRIDA</span>`;
            actionHtml = `<button class="sell-btn" onclick="game.sellWeapon('${k}')">VENDER ($${refund})</button>`;
        } else if (this.wave < unlockWave) {
            statusHtml = `<span class="weapon-row-status locked">DISPONIBLE EN WAVE ${unlockWave}</span>`;
        } else {
            statusHtml = `<span class="weapon-row-status">$${cost}</span>`;
            actionHtml = `<button class="buy-btn" onclick="game.buyWeapon('${k}')">COMPRAR</button>`;
        }
        list.innerHTML += `<div class="weapon-row">
            <span class="weapon-row-cat" style="color:${meta.color}">${meta.icon}</span>
            <div class="weapon-row-info"><span class="weapon-row-name">${k}</span><span class="weapon-row-desc">${desc}</span></div>
            ${statusHtml}${actionHtml}
        </div>`;
    });
};

game.gameOver = function() {
    const wavesSurvived = this.wave - 1;
    const elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
    const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const ss = String(elapsedSec % 60).padStart(2, '0');

    let recordText = "";
    if (wavesSurvived > Settings.bestWave) {
        Settings.bestWave = wavesSurvived;
        Settings.save();
        recordText = "¡NUEVO RÉCORD!";
    }

    Progression.awardForRun(wavesSurvived);

    this.paused = true;
    MusicManager.duck(600);

    document.getElementById('go-waves').innerText = wavesSurvived;
    document.getElementById('go-time').innerText = `${mm}:${ss}`;
    document.getElementById('go-record').innerText = recordText;
    document.getElementById('go-points').innerText = `+${wavesSurvived * 10} PUNTOS DE MEJORA`;
    document.getElementById('gameover-screen').style.display = 'flex';
};
