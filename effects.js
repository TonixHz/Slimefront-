/**
 * AUDIO SYSTEM - URLs públicas para GitHub Pages
 */
const SFX = {
    // Disparos - usando URLs públicas de Freesound/Zapsplat
    shoot_G18: 'https://freesound.org/data/previews/685/685110_16014704-lq.mp3',
    shoot_SHOTGUN: 'https://freesound.org/data/previews/509/509659_4654381-lq.mp3',
    shoot_rifle: 'https://freesound.org/data/previews/520/520775_9441686-lq.mp3',
    shoot_smg: 'https://freesound.org/data/previews/471/471126_9771670-lq.mp3',
    shoot_sniper: 'https://freesound.org/data/previews/425/425427_7033341-lq.mp3',
    shoot_sniper2: 'https://freesound.org/data/previews/425/425427_7033341-lq.mp3',
    shoot_revolver: 'https://freesound.org/data/previews/508/508658_10897131-lq.mp3',
    
    // Melee
    melee: 'https://freesound.org/data/previews/546/546604_2548421-lq.mp3',
    melee2: 'https://freesound.org/data/previews/546/546604_2548421-lq.mp3',
    melee3: 'https://freesound.org/data/previews/546/546604_2548421-lq.mp3',
    chainsaw: 'https://freesound.org/data/previews/346/346110_5121236-lq.mp3',
    chainsaw_hit: 'https://freesound.org/data/previews/346/346110_5121236-lq.mp3',
    
    // Explosiones
    explosion: 'https://freesound.org/data/previews/528/528411_9406502-lq.mp3',
    rpg: 'https://freesound.org/data/previews/528/528411_9406502-lq.mp3',
    kamikaze: 'https://freesound.org/data/previews/528/528411_9406502-lq.mp3',
    
    // Efectos generales
    hit: 'https://freesound.org/data/previews/109/109662_1399837-lq.mp3',
    death: 'https://freesound.org/data/previews/567/567393_12265342-lq.mp3',
    reload: 'https://actions.google.com/sounds/v1/weapons/weapon_cock.ogg',
    coin: 'https://actions.google.com/sounds/v1/water/droplet.ogg',
    flamethrower: 'https://freesound.org/data/previews/511/511947_7091745-lq.mp3',
    
    // Clima
    thunder: 'https://actions.google.com/sounds/v1/weather/heavy_rain_and_thunder.ogg',
    rain: 'https://actions.google.com/sounds/v1/weather/light_rain.ogg',
    wind: 'https://actions.google.com/sounds/v1/weather/wind.ogg',
    sandstorm: 'https://actions.google.com/sounds/v1/weather/wind.ogg'
};

const sfxPools = {};
const SFX_POOL_SIZE = 14; // varias armas comparten la misma clave de sonido; un pool chico causaba latencia perceptible en oleadas con mucho fuego simultáneo

function getSfxPool(key) {
    if (!sfxPools[key]) {
        sfxPools[key] = Array.from({ length: SFX_POOL_SIZE }, () => {
            const a = new Audio(SFX[key] || SFX.shoot_G18);
            a.preservesPitch = false;
            a.preload = 'auto';
            // Fallback a Google Sounds si el archivo local no carga
            a.onerror = () => {
                const fallbackUrl = 'https://actions.google.com/sounds/v1/weapons/gun_shot_single.ogg';
                a.src = fallbackUrl;
                a.load();
            };
            a.load(); // fuerza la descarga/decodificación ahora y no en el primer disparo
            return a;
        });
        sfxPools[key].cursor = 0;
    }
    return sfxPools[key];
}

// Crea todos los pools de sonido de una sola vez al arrancar la página.
// Antes se creaban recién en el primer playSFX() de cada tipo, y esa primera
// creación + decodificación del audio es la que generaba el delay perceptible.
function preloadSFX() {
    try {
        Object.keys(SFX).forEach(key => getSfxPool(key));
    } catch (e) {
        console.warn('Error preloading SFX:', e);
    }
}

function playSFX(key, vol = 0.3, pitchVar = 0.1) {
    const pool = getSfxPool(key);
    const a = pool[pool.cursor];
    pool.cursor = (pool.cursor + 1) % pool.length;
    a.pause();
    a.currentTime = 0;
    a.volume = vol * (Settings.sfxVolume / 100);
    a.playbackRate = 1 + (Math.random() - 0.5) * pitchVar;
    a.play().catch(() => {});
}

const MusicManager = {
    // URLs públicas de música libre de derechos (freetouse.com, incompetech, etc)
    mainTracks: ['https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'],
    combatTracks: [
        'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
        'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3'
    ],
    bossTracks: [
        'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3'
    ],
    tracks: [],
    audio: null,
    currentIndex: -1,
    baseVolume: 0.25,
    fadeTimer: null,
    init() {
        this.audio = new Audio();
        this.audio.volume = 0;
        this.baseVolume = 0.25 * (Settings.musicVolume / 100);
        this.audio.addEventListener('ended', () => this.next());
    },
    // Cambia de categoría de música (main/combate/jefe) solo si es distinta a la actual,
    // así no corta una canción de combate a mitad para volver a poner... la misma categoría.
    switchContext(trackList, fadeMs = 1500) {
        if (this.tracks === trackList) return;
        this.tracks = trackList;
        this.next(fadeMs);
    },
    _fadeTo(target, duration, onComplete) {
        if (!this.audio) return;
        clearInterval(this.fadeTimer);
        const from = this.audio.volume;
        const t0 = performance.now();
        this.fadeTimer = setInterval(() => {
            const t = Math.min(1, (performance.now() - t0) / duration);
            this.audio.volume = from + (target - from) * t;
            if (t >= 1) {
                clearInterval(this.fadeTimer);
                if (onComplete) onComplete();
            }
        }, 50);
    },
    _playFromIndex(idx, fadeMs) {
        this.currentIndex = idx;
        this.audio.src = this.tracks[idx];
        this.audio.volume = 0;
        this.audio.play().then(() => this._fadeTo(this.baseVolume, fadeMs)).catch(() => {});
    },
    playLobby() { this.tracks = this.mainTracks; this.currentIndex = -1; this.start(); },
    start() {
        if (!this.audio || !this.audio.paused || !this.tracks.length) return;
        const idx = this.currentIndex === -1 ? Math.floor(Math.random() * this.tracks.length) : this.currentIndex;
        this._playFromIndex(idx, 1500);
    },
    next(fadeMs = 1500) {
        if (!this.audio || !this.tracks.length) return;
        let idx = Math.floor(Math.random() * this.tracks.length);
        if (this.tracks.length > 1 && idx === this.currentIndex) idx = (idx + 1) % this.tracks.length;
        this._playFromIndex(idx, fadeMs);
    },
    resume(fadeMs = 800) {
        if (!this.audio || !this.audio.paused) return;
        this.audio.volume = 0;
        this.audio.play().then(() => this._fadeTo(this.baseVolume, fadeMs)).catch(() => {});
    },
    duck(duration = 1200) {
        if (!this.audio || this.audio.paused) return;
        this._fadeTo(0, duration, () => this.audio.pause());
    }
};

/**
 * CULLING: Función de optimización para renderizado
 */
function isVisible(x, y, radius, cam) {
    const padding = 50;
    return (x + radius + padding > cam.x && x - radius - padding < cam.x + canvas.width &&
            y + radius + padding > cam.y && y - radius - padding < cam.y + canvas.height);
}

/**
 * ENTIDADES Y EFECTOS
 */
class Trail {
    init(x, y, radius) {
        this.x = x; this.y = y; 
        this.radius = radius * (0.6 + Math.random()*0.4);
        this.life = 1.0; 
        this.active = true;
    }
    update() {
        this.life -= 0.015; 
        if (this.life <= 0) this.active = false;
    }
    draw(cam) {
        if (!isVisible(this.x, this.y, this.radius, cam)) return;
        ctx.globalAlpha = this.life * 0.4;
        ctx.fillStyle = '#a8e6cf';
        ctx.beginPath();
        ctx.arc(this.x - cam.x, this.y - cam.y, this.radius, 0, Math.PI*2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }
}

class Casing {
    init(x, y, dir) {
        this.x = x; this.y = y;
        this.vx = Math.cos(dir + Math.PI/2 + (Math.random()-0.5)) * (2 + Math.random()*3);
        this.vy = Math.sin(dir + Math.PI/2 + (Math.random()-0.5)) * (2 + Math.random()*3);
        this.life = 1.0;
        this.rot = Math.random() * Math.PI;
        this.vRot = (Math.random() - 0.5);
        this.active = true;
    }
    update() {
        this.x += this.vx; this.y += this.vy;
        this.vx *= 0.85; this.vy *= 0.85;
        this.rot += this.vRot;
        if (Math.abs(this.vx) < 0.1) this.life -= 0.01;
        if (this.life <= 0) this.active = false;
    }
    draw(cam) {
        if (!isVisible(this.x, this.y, 4, cam)) return;
        ctx.globalAlpha = Math.max(0, this.life);
        ctx.save();
        ctx.translate(this.x - cam.x, this.y - cam.y);
        ctx.rotate(this.rot);
        ctx.fillStyle = '#f1c40f';
        ctx.fillRect(-2, -1, 4, 2);
        ctx.strokeStyle = '#d35400'; ctx.lineWidth = 1; ctx.strokeRect(-2, -1, 4, 2);
        ctx.restore();
        ctx.globalAlpha = 1;
    }
}

class FloatingText {
    init(x, y, text, color = '#fff', size = 20) {
        this.x = x + (Math.random() - 0.5) * 20; 
        this.y = y + (Math.random() - 0.5) * 20;
        this.text = text; this.color = color; this.size = size;
        this.life = 1.0; this.vy = -1.5;
        this.active = true;
    }
    update() {
        this.y += this.vy;
        this.life -= 0.02;
        if(this.life <= 0) this.active = false;
    }
    draw(cam) {
        if (!isVisible(this.x, this.y, 30, cam)) return;
        ctx.globalAlpha = Math.max(0, this.life);
        ctx.fillStyle = this.color;
        ctx.font = `bold ${this.size}px Teko`;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        ctx.strokeText(this.text, this.x - cam.x, this.y - cam.y);
        ctx.fillText(this.text, this.x - cam.x, this.y - cam.y);
        ctx.globalAlpha = 1;
    }
}

class Particle {
    init(x, y, color, speed = 5, size = 3, type = 'normal') {
        this.x = x; this.y = y; this.color = color; this.type = type;
        const angle = Math.random() * Math.PI * 2;
        const force = Math.random() * speed;
        this.vx = Math.cos(angle) * force;
        this.vy = Math.sin(angle) * force;
        this.life = 1.0;
        this.decay = ((type === 'smoke') ? 0.015 : 0.03 + Math.random() * 0.03) * (game.slowParticleDecay ? 0.5 : 1);
        this.size = size;
        this.active = true;
    }
    update() {
        this.x += this.vx; this.y += this.vy;
        if(this.type === 'smoke') {
            this.size += 0.2;
            this.vx *= 0.92; this.vy *= 0.92;
        } else {
            this.vx *= 0.96; this.vy *= 0.96;
        }
        this.life -= this.decay;
        if (this.life <= 0) this.active = false;
    }
    draw(cam) {
        if (!isVisible(this.x, this.y, this.size, cam)) return;
        ctx.globalAlpha = Math.max(0, this.life);
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x - cam.x, this.y - cam.y, this.size, 0, Math.PI*2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }
}

class Camera {
    constructor() { this.x = 0; this.y = 0; this.shake = 0; }
    follow(target) {
        const destX = target.x - canvas.width / 2;
        const destY = target.y - canvas.height / 2;
        this.x += (destX - this.x) * 0.15;
        this.y += (destY - this.y) * 0.15;
        
        this.x = Math.max(0, Math.min(this.x, MAP_SIZE - canvas.width));
        this.y = Math.max(0, Math.min(this.y, MAP_SIZE - canvas.height));
        
        if (this.shake > 0.1) {
            this.x += (Math.random() - 0.5) * this.shake;
            this.y += (Math.random() - 0.5) * this.shake;
            this.shake *= 0.85; 
        }
    }
}

// Funciones de Pool de Efectos
game.spawnParticle = function(x, y, color, speed, size, type) {
    let p = this.particles.find(p => !p.active);
    if(p) p.init(x, y, color, speed, size, type);
};

game.spawnCasing = function(x, y, dir) {
    let c = this.casings.find(c => !c.active);
    if(c) c.init(x, y, dir);
};

game.spawnTrail = function(x, y, radius) {
    let t = this.trails.find(t => !t.active);
    if(t) t.init(x, y, radius);
};

// Explosión genérica en área (RPG y cualquier arma explosiva futura reutiliza esto)
game.explode = function(x, y, radius, dmg) {
    this.enemies.forEach(e => { if(!e.invulnerable && Math.hypot(e.x - x, e.y - y) < radius) this.hitEnemy(e, dmg); });
    if (Math.hypot(this.player.x - x, this.player.y - y) < radius) this.player.takeDamage(dmg * 0.4);
    for(let i=0; i<Math.ceil(24*this.particleScale); i++) this.spawnParticle(x, y, i % 2 === 0 ? '#e67e22' : '#f1c40f', 8, 5, 'normal');
    for(let i=0; i<Math.ceil(6*this.particleScale); i++) this.spawnParticle(x, y, '#555', 3, 6, 'smoke');
    this.camera.shake = 20;
    playSFX('rpg', 0.5, 0.1);  // Usa RPG launch sound (se puede cambiar a 'kamikaze' si es explosión de kamikaze)
};
