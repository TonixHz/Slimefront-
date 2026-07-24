/**
 * SISTEMA DE EVENTOS DINÁMICOS
 * Modular: para agregar un evento nuevo alcanza con sumar una entrada a RANDOM_EVENTS
 * (label + onStart/onUpdate/onDraw) y, si necesita un modificador nuevo, leerlo donde
 * corresponda con un "|| 1" / "|| 0" por defecto, tal como ya hacen los existentes.
 */
const AmbientSFX = {
    rain: 'https://actions.google.com/sounds/v1/weather/light_rain.ogg',
    wind: 'https://actions.google.com/sounds/v1/weather/wind.ogg',
    sandstorm: 'https://actions.google.com/sounds/v1/weather/wind.ogg' // reutilizar wind para sandstorm
};

// Canal de audio ambiente en loop, separado del pooling de SFX (que no soporta loop)
const AmbientAudio = {
    audio: null,
    play(key, volume = 0.35) {
        this.stop();
        if (!AmbientSFX[key]) return;
        this.audio = new Audio(AmbientSFX[key]);
        this.audio.loop = true;
        this.audio.volume = volume * (Settings.sfxVolume / 100);
        this.audio.play().catch(() => {});
    },
    stop() {
        if (this.audio) { this.audio.pause(); this.audio = null; }
    }
};

// --- Partículas de clima: se dibujan en espacio de pantalla (no del mundo), livianas ---
// Pool fijo (mismo patrón que particles/casings/trails) en vez de crear objetos nuevos en cada spawn
const WEATHER_POOL_SIZE = 400;
let weatherParticles = Array.from({ length: WEATHER_POOL_SIZE }, () => ({ active: false }));
let weatherCursor = 0;
function spawnWeatherParticle(kind, color) {
    if (Math.random() > (game.particleScale || 1)) return; // reduce automáticamente el spawn con mucha carga activa
    const p = weatherParticles[weatherCursor];
    weatherCursor = (weatherCursor + 1) % weatherParticles.length;
    p.kind = kind; p.color = color; p.active = true;
    if (kind === 'rain' || kind === 'blood') {
        p.x = Math.random() * canvas.width; p.y = -20;
        p.vx = -1.5; p.vy = 14 + Math.random() * 6;
    } else if (kind === 'snow') {
        p.x = Math.random() * canvas.width; p.y = -10;
        p.vx = (Math.random() - 0.5) * 1.5; p.vy = 1.5 + Math.random() * 1.5;
        p.size = 2 + Math.random() * 3;
    } else if (kind === 'sand') {
        p.x = -20; p.y = Math.random() * canvas.height;
        p.vx = 6 + Math.random() * 4; p.vy = (Math.random() - 0.5) * 2;
        p.size = 2 + Math.random() * 2;
    } else { // fog
        p.x = Math.random() * canvas.width; p.y = Math.random() * canvas.height;
        p.vx = 0.3 + Math.random() * 0.3; p.vy = 0;
        p.size = 60 + Math.random() * 80;
    }
    p.life = 1;
}
function updateAndDrawWeatherParticles() {
    for (let i = 0; i < weatherParticles.length; i++) {
        const p = weatherParticles[i];
        if (!p.active) continue;
        p.x += p.vx; p.y += p.vy;
        p.life -= (p.kind === 'fog') ? 0.003 : 0.01;
        if (p.y > canvas.height + 30 || p.x > canvas.width + 80 || p.x < -80 || p.life <= 0) { p.active = false; continue; }
        ctx.globalAlpha = Math.max(0, p.life) * (p.kind === 'fog' ? 0.18 : (p.kind === 'sand' ? 0.35 : 0.6));
        ctx.fillStyle = p.color;
        if (p.kind === 'rain' || p.kind === 'blood') { ctx.fillRect(p.x, p.y, 2, 14); }
        else { ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
}

function drawFlatTint(color) { ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height); }
function drawVisionOverlay(clearRadius, color) {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const grad = ctx.createRadialGradient(cx, cy, clearRadius * 0.35, cx, cy, clearRadius);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// Rayo de la tormenta eléctrica: avisa con sonido y golpea una zona aleatoria del mapa
function triggerLightningStrike() {
    const x = Math.random() * MAP_SIZE, y = Math.random() * MAP_SIZE;
    const dmg = 30;
    if (Math.hypot(game.player.x - x, game.player.y - y) < 100) game.player.takeDamage(dmg);
    game.enemies.forEach(e => { if (!e.invulnerable && Math.hypot(e.x - x, e.y - y) < 100) game.hitEnemy(e, dmg); });
    if (isVisible(x, y, 100, game.camera)) {
        for (let i = 0; i < Math.ceil(15*game.particleScale); i++) game.spawnParticle(x, y, '#fff', 8, 4, 'normal');
        game.camera.shake = 15;
    }
}
// Bombardeo: explosión aleatoria cerca del jugador
function triggerBombardment() {
    const a = Math.random() * Math.PI * 2, d = Math.random() * 500;
    const x = game.player.x + Math.cos(a) * d, y = game.player.y + Math.sin(a) * d;
    const radius = 110, dmg = 25;
    if (Math.hypot(game.player.x - x, game.player.y - y) < radius) game.player.takeDamage(dmg);
    game.enemies.forEach(e => { if (!e.invulnerable && Math.hypot(e.x - x, e.y - y) < radius) game.hitEnemy(e, dmg); });
    for (let i = 0; i < Math.ceil(20*game.particleScale); i++) game.spawnParticle(x, y, '#e67e22', 7, 4, 'normal');
    if (isVisible(x, y, radius, game.camera)) game.camera.shake = 14;
}

const RANDOM_EVENTS = {
    RAIN: {
        label: '☔ LLUVIA', ambient: 'rain',
        onStart() { game.enemySpeedMult = 1.10; game.weaponSpreadBonus = 0.05; },
        onUpdate() { if (Math.random() > 0.3) spawnWeatherParticle('rain', '#7fa8d9'); },
        onDraw() { drawFlatTint('rgba(15,25,45,0.15)'); }
    },
    STORM: {
        label: '🌩️ TORMENTA ELÉCTRICA', ambient: 'rain',
        onStart() { game.enemySpeedMult = 1.10; game._lightningTimer = 200 + Math.random() * 200; },
        onUpdate() {
            if (Math.random() > 0.25) spawnWeatherParticle('rain', '#aab8ff');
            game._lightningTimer--;
            if (game._lightningTimer <= 0) {
                playSFX('thunder', 0.6, 0.1);
                game._lightningTimer = 300 + Math.random() * 300;
                setTimeout(() => { if (game.activeEvent === 'STORM') triggerLightningStrike(); }, 1200);
            }
        },
        onDraw() { drawFlatTint('rgba(5,5,15,0.35)'); }
    },
    FOG: {
        label: '🌫️ NIEBLA',
        onStart() {},
        onUpdate() { if (Math.random() > 0.6) spawnWeatherParticle('fog', 'rgba(200,200,210,0.5)'); },
        onDraw() { drawVisionOverlay(260, 'rgba(180,182,190,0.92)'); }
    },
    BLIZZARD: {
        label: '❄️ VENTISCA', ambient: 'wind',
        onStart() { game.playerSpeedMult = 0.75; },
        onUpdate() { if (Math.random() > 0.3) spawnWeatherParticle('snow', Math.random() > 0.5 ? '#eaf6ff' : '#aee3ff'); },
        onDraw() { drawFlatTint('rgba(140,190,255,0.12)'); }
    },
    HEATWAVE: {
        label: '🔥 OLA DE CALOR',
        onStart() { game.slowParticleDecay = true; },
        onUpdate() {},
        onDraw() { drawFlatTint(`rgba(230,90,20,${0.12 + Math.sin(Date.now() / 300) * 0.03})`); }
    },
    SANDSTORM: {
        label: '🌪️ TORMENTA DE ARENA', ambient: 'sandstorm',
        onStart() { game.projectileSpeedMult = 0.8; },
        onUpdate() { if (Math.random() > 0.2) spawnWeatherParticle('sand', '#c9a86a'); },
        onDraw() { drawVisionOverlay(230, 'rgba(150,130,50,0.92)'); }
    },
    RADIOACTIVE: {
        label: '☢️ LLUVIA RADIACTIVA', ambient: 'rain',
        onStart() { game.moneyMult = 1.5; game._dotTimer = 0; },
        onUpdate() {
            if (Math.random() > 0.3) spawnWeatherParticle('rain', '#39ff14');
            game._dotTimer++;
            if (game._dotTimer > 50) {
                game._dotTimer = 0;
                game.player.takeDamage(2);
                game.enemies.forEach(e => { if (!e.invulnerable) game.hitEnemy(e, 2); });
            }
        },
        onDraw() { drawFlatTint('rgba(20,90,20,0.18)'); }
    },
    MUTATION: {
        label: '🧪 MUTACIÓN',
        onStart() { game.enemySizeMult = 1.3; game.enemyHpMult = 1.5; game.enemyDamageMult = 1.4; },
        onUpdate() {},
        onDraw() { drawFlatTint('rgba(20,60,20,0.08)'); }
    },
    INVASION: {
        label: '💀 INVASIÓN',
        onStart() {}, onUpdate() {}, onDraw() {}
    },
    FRENZY: {
        label: '🩸 FRENESÍ', ambient: 'rain',
        onStart() { game.enemySpeedMult = 1.4; },
        onUpdate() { if (Math.random() > 0.3) spawnWeatherParticle('blood', '#c0392b'); },
        onDraw() { drawFlatTint('rgba(120,0,0,0.15)'); }
    },
    BOMBARDMENT: {
        label: '💣 BOMBARDEO',
        onStart() { game._bombTimer = 120 + Math.random() * 120; },
        onUpdate() {
            game._bombTimer--;
            if (game._bombTimer <= 0) { triggerBombardment(); game._bombTimer = 150 + Math.random() * 200; }
        },
        onDraw() {}
    },
    DARKNESS: {
        label: '🌑 OSCURIDAD TOTAL',
        onStart() {}, onUpdate() {},
        onDraw() { drawVisionOverlay(150, 'rgba(0,0,0,0.97)'); }
    },
    LOW_GRAVITY: {
        label: '🌀 GRAVEDAD BAJA',
        onStart() { game.knockbackMult = 3.5; }, onUpdate() {}, onDraw() {}
    },
    SLOW_TIME: {
        label: '⏱️ TIEMPO LENTO',
        onStart() {}, onUpdate() {},
        onDraw() { drawFlatTint('rgba(70,80,120,0.08)'); }
    },
    OVERCHARGE: {
        label: '⚡ SOBRECARGA',
        onStart() { game.weaponFireRateMult = 0.5; }, onUpdate() {}, onDraw() {}
    }
};

const EventManager = {
    // Vuelve todos los modificadores a su valor por defecto (se llama al activar y al terminar)
    reset() {
        game.enemySpeedMult = 1; game.enemySizeMult = 1; game.enemyHpMult = 1; game.enemyDamageMult = 1;
        game.playerSpeedMult = 1; game.weaponSpreadBonus = 0; game.weaponFireRateMult = 1;
        game.projectileSpeedMult = 1; game.knockbackMult = 1; game.moneyMult = 1;
        game.slowParticleDecay = false;
        weatherParticles.forEach(p => p.active = false);
    },
    // ~25% de probabilidad, nunca repite el evento inmediatamente anterior
    roll() {
        if (Math.random() > 0.25) return null;
        const keys = Object.keys(RANDOM_EVENTS).filter(k => k !== game.lastEventKey);
        return keys[Math.floor(Math.random() * keys.length)];
    },
    // Muestra la alerta grande ~5s con el juego pausado, y al terminar ejecuta onComplete
    showAlert(key, onComplete) {
        game.paused = true;
        const def = RANDOM_EVENTS[key];
        const alertEl = document.getElementById('event-alert');
        if (alertEl) {
            alertEl.querySelector('.event-alert-title').innerText = def.label;
            alertEl.style.display = 'flex';
        }
        setTimeout(() => {
            if (alertEl) alertEl.style.display = 'none';
            onComplete();
        }, 5000);
    },
    activate(key) {
        this.reset();
        game.activeEvent = key;
        game.lastEventKey = key;
        const def = RANDOM_EVENTS[key];
        if (def.ambient) AmbientAudio.play(def.ambient);
        if (def.onStart) def.onStart();
        const badge = document.getElementById('event-badge');
        if (badge) { badge.innerText = def.label; badge.style.display = 'block'; }
    },
    deactivate() {
        if (!game.activeEvent) return;
        AmbientAudio.stop();
        game.activeEvent = null;
        this.reset();
        const badge = document.getElementById('event-badge');
        if (badge) badge.style.display = 'none';
    },
    update() {
        if (!game.activeEvent) return;
        const def = RANDOM_EVENTS[game.activeEvent];
        if (def.onUpdate) def.onUpdate();
    },
    drawOverlay() {
        updateAndDrawWeatherParticles();
        if (!game.activeEvent) return;
        const def = RANDOM_EVENTS[game.activeEvent];
        if (def.onDraw) def.onDraw();
    }
};
