/**
 * AJUSTES DEL JUGADOR
 */
const GRAPHICS_PRESETS = {
    LOW:    { props: 100, particles: 100, casings: 30,  projectiles: 60,  trails: 60,  shadows: false },
    MEDIUM: { props: 200, particles: 200, casings: 60,  projectiles: 100, trails: 120, shadows: true },
    PRO:    { props: 300, particles: 300, casings: 100, projectiles: 150, trails: 200, shadows: true },
    ULTRA:  { props: 50,  particles: 0,   casings: 0,   projectiles: 80,  trails: 0,   shadows: false, ultra: true }
};

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
applyPerfClass();

// #lobby-screen usa CSS grid (ver assets/style.css → .lobby-screen-v2), no
// flex: todo lo que lo vuelve a mostrar debe usar 'grid', nunca 'flex'.
function showLobbyScreen() {
    document.body.classList.add('lobby-active');
    document.getElementById('lobby-screen').style.display = 'grid';
    if (typeof game.refreshLobbyPanels === 'function') game.refreshLobbyPanels();
}
function hideLobbyScreen() {
    document.body.classList.remove('lobby-active');
    document.getElementById('lobby-screen').style.display = 'none';
}

game.startFromLobby = function() {
    hideLobbyScreen();
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

// Vuelve al menú SIN recargar la página: pausa/limpia la partida en curso y
// muestra el lobby. Sirve tanto desde el menú de pausa (ESC) como desde la
// pantalla de Game Over.
game.goToMainMenu = function() {
    document.getElementById('gameover-screen').style.display = 'none';
    document.getElementById('esc-menu').style.display = 'none';
    document.getElementById('shop-menu').style.display = 'none';

    this.started = false; // el loop único de main.js deja de dibujar en el próximo frame
    this.paused = true;
    this.isWaveActive = false;
    this.enemies = [];
    if (this.particles) this.particles.forEach(p => p.active = false);
    if (this.casings) this.casings.forEach(c => c.active = false);
    if (this.projectiles) this.projectiles.forEach(p => p.active = false);
    if (this.trails) this.trails.forEach(t => t.active = false);
    if (this.floatingTexts) this.floatingTexts.forEach(t => t.active = false);
    if (typeof EventManager !== 'undefined') EventManager.deactivate();

    // Cancela cualquier timer de partida pendiente (recargas en curso, ráfagas,
    // rayos de tormenta, toasts de logro/nivel) para que no se ejecute nada
    // sobre esta partida ya descartada. Ver src/timers.js para qué NO pasa
    // por acá (sync de guardado, fundidos de música).
    if (typeof TimerManager !== 'undefined') TimerManager.clearAll();

    const uiLayer = document.getElementById('ui-layer');
    if (uiLayer) uiLayer.style.display = 'none';

    MusicManager.duck(400);
    MusicManager.tracks = MusicManager.mainTracks;
    MusicManager.currentIndex = -1;
    setTimeout(() => { if (!game.started) MusicManager.start(); }, 450);

    showLobbyScreen();
};

// Arranca una partida nueva directo desde la pantalla de Game Over (sin pasar
// por el menú principal).
game.playAgain = function() {
    document.getElementById('gameover-screen').style.display = 'none';
    hideLobbyScreen();
    MusicManager.duck(300);
    if (typeof TimerManager !== 'undefined') TimerManager.clearAll();
    this.init();
};

// ---- Cuenta: cerrar sesión / borrar progreso (Ajustes) ----
game.openLogoutConfirm = function() { document.getElementById('confirm-logout-modal').style.display = 'flex'; };
game.closeLogoutConfirm = function() { document.getElementById('confirm-logout-modal').style.display = 'none'; };
game.confirmLogout = async function() {
    game.closeLogoutConfirm();
    document.getElementById('settings-panel').style.display = 'none';
    await SaveSystem.signOut();
    // Recargar es la forma más simple de garantizar que no quede ningún estado de
    // partida colgado; boot.js detecta que no hay sesión y muestra el login.
    location.reload();
};

game.openDeleteConfirm = function() { document.getElementById('confirm-delete-modal').style.display = 'flex'; };
game.closeDeleteConfirm = function() { document.getElementById('confirm-delete-modal').style.display = 'none'; };

game.resetAllProgress = async function() {
    if (typeof SaveSystem.clearProgress === 'function') await SaveSystem.clearProgress();
    if (typeof PlayerProfile !== 'undefined') PlayerProfile.reset();
    if (typeof AchievementManager !== 'undefined') AchievementManager.resetAll();
    if (typeof Progression !== 'undefined') Progression.reset();
    Settings.bestWave = 0;
    Settings.save();
};

game.confirmDeleteProgress = async function() {
    game.closeDeleteConfirm();
    document.getElementById('settings-panel').style.display = 'none';
    await game.resetAllProgress();
    // Mantiene la sesión iniciada (no llamamos a signOut) y recarga para volver
    // al estado inicial sin ningún dato en memoria desincronizado.
    location.reload();
};

game.openSettings = function(from) {
    this.settingsOrigin = from;
    if (from === 'lobby') hideLobbyScreen(); else document.getElementById('esc-menu').style.display = 'none';
    document.getElementById('settings-panel').style.display = 'flex';
    const sfxSlider = document.getElementById('sfx-vol-slider');
    const musicSlider = document.getElementById('music-vol-slider');
    if(sfxSlider) sfxSlider.value = Settings.sfxVolume;
    if(musicSlider) musicSlider.value = Settings.musicVolume;
    document.getElementById('sfx-vol-value').innerText = Settings.sfxVolume;
    document.getElementById('music-vol-value').innerText = Settings.musicVolume;
    document.querySelectorAll('#graphics-options .option-btn').forEach(b => b.classList.toggle('active', b.dataset.value === Settings.graphics));

    const colorblindToggle = document.getElementById('colorblind-toggle');
    if (colorblindToggle && typeof Accessibility !== 'undefined') colorblindToggle.checked = Accessibility.isColorblindMode();
    if (typeof ConsentManager !== 'undefined') ConsentManager._updateSettingsLabel();
};

game.closeSettings = function() {
    document.getElementById('settings-panel').style.display = 'none';
    if (this.settingsOrigin === 'lobby') showLobbyScreen(); else document.getElementById('esc-menu').style.display = 'flex';
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

game.toggleControls = function(show) {
    if (show) hideLobbyScreen(); else showLobbyScreen();
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
    hideLobbyScreen();
    document.getElementById('credits-screen').style.display = 'flex';
};

game.closeCredits = function() {
    document.getElementById('credits-screen').style.display = 'none';
    showLobbyScreen();
};

// ======================================================================
// ACCESIBILIDAD — modal de reconfiguración de teclas + toggle daltónico.
// Construye el modal dinámicamente (ver #keybind-panel vacío en index.html),
// reutilizando el mismo lenguaje visual (.menu-screen/.menu-panel) del resto
// de pantallas modales.
// ======================================================================
game.toggleColorblindMode = function(checked) {
    if (typeof Accessibility !== 'undefined') Accessibility.setColorblindMode(checked);
};

game.openKeybindPanel = function() {
    document.getElementById('settings-panel').style.display = 'none';
    const panel = document.getElementById('keybind-panel');
    const ACTION_LABELS = {
        moveUp: 'Mover arriba', moveDown: 'Mover abajo', moveLeft: 'Mover izquierda', moveRight: 'Mover derecha',
        dash: 'Dash', reload: 'Recargar', pause: 'Pausa',
        slot1: 'Slot 1', slot2: 'Slot 2', slot3: 'Slot 3', slot4: 'Slot 4', slot5: 'Slot 5'
    };
    const bindings = KeyBindings.load();
    panel.innerHTML = `
        <div class="menu-panel" style="width:460px;">
            <h1 class="menu-title" style="font-size:34px;">CONTROLES</h1>
            <div class="controls-list" id="keybind-rows">
                ${Object.keys(ACTION_LABELS).map(action => `
                    <div class="keybind-row">
                        <span>${ACTION_LABELS[action]}</span>
                        <span class="keybind-key" data-action="${action}">${bindings[action]}</span>
                    </div>
                `).join('')}
            </div>
            <button class="menu-btn" onclick="game.resetKeybinds()">RESTAURAR VALORES POR DEFECTO</button>
            <button class="menu-btn primary" onclick="game.closeKeybindPanel()">VOLVER</button>
        </div>`;
    panel.style.display = 'flex';
    panel.querySelectorAll('.keybind-key').forEach(el => {
        el.addEventListener('click', () => game._listenForRebind(el, el.dataset.action));
    });
};

game._listenForRebind = function(el, action) {
    el.classList.add('listening');
    el.innerText = 'Presioná una tecla...';
    const onKey = (e) => {
        e.preventDefault();
        KeyBindings.rebind(action, e.code);
        el.innerText = e.code;
        el.classList.remove('listening');
        window.removeEventListener('keydown', onKey, true);
    };
    window.addEventListener('keydown', onKey, true);
};

game.resetKeybinds = function() {
    KeyBindings.resetToDefaults();
    game.openKeybindPanel();
};

game.closeKeybindPanel = function() {
    document.getElementById('keybind-panel').style.display = 'none';
    document.getElementById('settings-panel').style.display = 'flex';
};

// ======================================================================
// PRIVACIDAD — reabrir el banner de consentimiento de Analytics desde Ajustes.
// ======================================================================
game.reconsiderConsent = function() {
    if (typeof ConsentManager !== 'undefined') ConsentManager.reconsider();
};
