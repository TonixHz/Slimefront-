/**
 * AJUSTES DEL JUGADOR
 */
// ULTRA: llevar los pools de partículas/casquillos/rastros a 0 reutiliza el mismo
// Object Pooling que el juego ya usa (game.spawnParticle/spawnCasing/spawnTrail hacen
// `find(p => !p.active)` sobre un array vacío y no crean nada), así que con solo vaciar
// esos pools quedan automáticamente desactivados TODOS los efectos que pasan por ahí:
// humo, chispas, sangre, partículas de muerte, rastro de dash/movimiento/fantasma/
// kamikaze, casquillos, explosiones decorativas, etc. — sin duplicar lógica en cada
// sitio que las dispara. La bandera "ultra" además activa game.fxEnabled (ver main.js),
// que apaga en un único lugar los pocos efectos que NO pasan por un pool: camera shake,
// destello de boca/glow del arma, partículas de clima y el tinte ambiental de pantalla.
const GRAPHICS_PRESETS = {
    LOW:    { props: 100, particles: 100, casings: 30,  projectiles: 60,  trails: 60,  shadows: false },
    MEDIUM: { props: 200, particles: 200, casings: 60,  projectiles: 100, trails: 120, shadows: true },
    PRO:    { props: 300, particles: 300, casings: 100, projectiles: 150, trails: 200, shadows: true },
    ULTRA:  { props: 50,  particles: 0,   casings: 0,   projectiles: 80,  trails: 0,   shadows: false, ultra: true }
};

// Único punto que decide si el <body> lleva la clase que apaga animaciones/transiciones/
// sombras/blur cosméticos de toda la UI (ver regla .ultra-mode en style.css).
function applyPerfClass() {
    if (document.body) document.body.classList.toggle('ultra-mode', Settings.graphics === 'ULTRA');
}

const Settings = {
    graphics: localStorage.getItem('slime_graphics') || 'PRO',
    sfxVolume: localStorage.getItem('slime_sfxVolume') !== null ? parseInt(localStorage.getItem('slime_sfxVolume')) : 100,
    musicVolume: localStorage.getItem('slime_musicVolume') !== null ? parseInt(localStorage.getItem('slime_musicVolume')) : 100,
    hudSize: localStorage.getItem('slime_hudSize') !== null ? parseInt(localStorage.getItem('slime_hudSize')) : 2,
    bestWave: parseInt(localStorage.getItem('slime_bestWave')) || 0,
    save() {
        localStorage.setItem('slime_graphics', this.graphics);
        localStorage.setItem('slime_sfxVolume', this.sfxVolume);
        localStorage.setItem('slime_musicVolume', this.musicVolume);
        localStorage.setItem('slime_hudSize', this.hudSize);
        localStorage.setItem('slime_bestWave', this.bestWave);
    }
};
applyPerfClass(); // aplica la preferencia guardada (ULTRA u otro) ni bien carga el script

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
    const sfxSlider = document.getElementById('sfx-vol-slider');
    const musicSlider = document.getElementById('music-vol-slider');
    if(sfxSlider) sfxSlider.value = Settings.sfxVolume;
    if(musicSlider) musicSlider.value = Settings.musicVolume;
    document.getElementById('sfx-vol-value').innerText = Settings.sfxVolume;
    document.getElementById('music-vol-value').innerText = Settings.musicVolume;
    document.querySelectorAll('#graphics-options .option-btn').forEach(b => b.classList.toggle('active', b.dataset.value === Settings.graphics));
};

game.closeSettings = function() {
    document.getElementById('settings-panel').style.display = 'none';
    document.getElementById(this.settingsOrigin === 'lobby' ? 'lobby-screen' : 'esc-menu').style.display = 'flex';
};

game.setGraphics = function(tier) {
    Settings.graphics = tier;
    Settings.save();
    document.querySelectorAll('#graphics-options .option-btn').forEach(b => b.classList.toggle('active', b.dataset.value === tier));
    applyPerfClass();
};

game.setSfxVolume = function(v) { Settings.sfxVolume = parseInt(v); Settings.save(); document.getElementById('sfx-vol-value').innerText = v; };
game.setMusicVolume = function(v) { 
    Settings.musicVolume = parseInt(v); 
    Settings.save(); 
    document.getElementById('music-vol-value').innerText = v;
    MusicManager.baseVolume = 0.25 * (Settings.musicVolume / 100);
    if(MusicManager.audio && !MusicManager.audio.paused) MusicManager.audio.volume = MusicManager.baseVolume;
};
// game.setHudSize removida (no existe en HTML)

// Pantalla de Controles
game.toggleControls = function(show) {
    document.getElementById('lobby-screen').style.display = show ? 'none' : 'flex';
    const panel = document.getElementById('controls-panel');
    if (panel) panel.style.display = show ? 'flex' : 'none';
};

game.updateShop = function() {
    const list = document.getElementById('shop-items');
    list.innerHTML = "";
    ['G18', 'KNIFE'].forEach(k => {
        list.innerHTML += `<div class="weapon-row"><span class="weapon-row-name">${k}</span><span class="weapon-row-status owned">ADQUIRIDA</span></div>`;
    });
    Object.keys(WEAPON_COSTS).forEach(k => {
        const owned = this.player.inventory.some(i => i && i.name === k);
        const cost = WEAPON_COSTS[k];
        if(owned) {
            const refund = Math.floor(cost / 2);
            list.innerHTML += `<div class="weapon-row"><span class="weapon-row-name">${k}</span><span class="weapon-row-status owned">ADQUIRIDA</span><button class="sell-btn" onclick="game.sellWeapon('${k}')">VENDER ($${refund})</button></div>`;
        } else {
            list.innerHTML += `<div class="weapon-row"><span class="weapon-row-name">${k}</span><span class="weapon-row-status">$${cost}</span><button class="buy-btn" onclick="game.buyWeapon('${k}')">COMPRAR</button></div>`;
        }
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

    this.paused = true;
    MusicManager.duck(600);

    document.getElementById('go-waves').innerText = wavesSurvived;
    document.getElementById('go-time').innerText = `${mm}:${ss}`;
    document.getElementById('go-record').innerText = recordText;
    document.getElementById('gameover-screen').style.display = 'flex';
};

// === CRÉDITOS ===
game.openCredits = function() {
    document.getElementById('lobby-screen').style.display = 'none';
    document.getElementById('credits-screen').style.display = 'flex';
};

game.closeCredits = function() {
    document.getElementById('credits-screen').style.display = 'none';
    document.getElementById('lobby-screen').style.display = 'flex';
};
