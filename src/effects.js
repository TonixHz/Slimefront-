/**
 * AUDIO SYSTEM
 * Rutas relativas a la carpeta Sounds/ (debe estar en la raíz del repo, junto a index.html).
 *
 * NOTA (timers): los timers de MusicManager (fundidos de volumen / duck /
 * resume) se dejan deliberadamente como setInterval/setTimeout nativos, no
 * pasan por TimerManager (src/timers.js). Son efectos de audio transversales
 * a menús y partidas (no referencian game.player/game.enemies), así que no
 * hay riesgo de "callback sobre estado destruido", y cancelarlos a mitad de
 * partida (por ejemplo, cada vez que se abre el menú de pausa) cortaría la
 * música de forma audible. Ver razonamiento completo en src/timers.js.
 */
const SFX = {
    // --- Disparos ---
    shoot_G18: 'Sounds/SFX/Shoots/PISTOLA.ogg',
    shoot_SHOTGUN: 'Sounds/SFX/Shoots/ESCOPETA.wav',
    shoot_SHOTGUN2: 'Sounds/SFX/Shoots/ESCOPETA2.mp3',
    shoot_rifle: 'Sounds/SFX/Shoots/RIFLES.mp3',
    shoot_smg: 'Sounds/SFX/Shoots/SMG.mp3',
    shoot_sniper: 'Sounds/SFX/Shoots/SNIPER.mp3',
    shoot_sniper2: 'Sounds/SFX/Shoots/SNIPER2.mp3',
    shoot_revolver: 'Sounds/SFX/Shoots/REVOLVER.mp3',

// --- Nuevos (UI) ---
    levelup: 'Sounds/SFX/UI/NIVELUP.mp3',
    ui_back: 'Sounds/SFX/UI/BACKBUTTON.mp3',
    ui_click: 'Sounds/SFX/UI/CLICKBUTTON.mp3',
    ui_hover: 'Sounds/SFX/UI/HOVERBUTTON.mp3',
    achievement_unlock: 'Sounds/SFX/UI/LOGRODESBLOQUEADO.mp3',

    // --- Melee ---
    melee: 'Sounds/SFX/Shoots/MEELE.mp3',
    melee2: 'Sounds/SFX/Shoots/MEELE2.mp3',
    melee3: 'Sounds/SFX/Shoots/MEELE3.mp3',
    chainsaw: 'Sounds/SFX/Shoots/CHAINSAW.mp3',
    chainsaw_hit: 'Sounds/SFX/Shoots/CHAINSAWHIT.mp3',

    // --- Especiales ---
    flamethrower: 'Sounds/SFX/Shoots/FLAMETHROWER.mp3',
    rpg_launch: 'Sounds/SFX/Shoots/RPGLAUNCH.mp3',
    rpg_explosion: 'Sounds/SFX/Shoots/RPGEXPLOSION.mp3',

    // --- Variados ---
    kamikaze: 'Sounds/SFX/Variados/KAMIKAZEEXPLOSION.mp3',
    death: 'Sounds/SFX/Variados/SLIMEDEATH.mp3',
    muerte_player: 'Sounds/SFX/Variados/muerteplayer.mp3',

    // --- Genéricos que ya usaba el juego (mapeados a lo más parecido que mandaste) ---
    hit: 'Sounds/SFX/Shoots/MEELE.mp3',
    reload: 'Sounds/SFX/Shoots/PISTOLA.ogg',
    coin: 'Sounds/SFX/Variados/SLIMEDEATH.mp3', // placeholder intencional, no tocar
    explosion: 'Sounds/SFX/Shoots/RPGEXPLOSION.mp3',

    // --- Clima / Eventos ---
    wind: 'Sounds/SFX/Events/liecio-strong-howling-wind-132281.mp3',
    sandstorm: 'Sounds/SFX/Events/soundreality-sandstorm-222741.mp3',
    thunder: 'Sounds/SFX/Events/universfield-loud-thunder-192165.mp3',
    rain: 'Sounds/SFX/Events/soundsforyou-light-rain-ambient-114354.mp3'
};

const sfxPools = {};
const SFX_POOL_SIZE = 14;
const _missingSfxWarned = new Set();

function getSfxPool(key) {
    if (!SFX[key]) {
        if (!_missingSfxWarned.has(key)) {
            console.warn(`[Audio] Clave de sonido inexistente: "${key}"`);
            _missingSfxWarned.add(key);
        }
        return null;
    }
    if (!sfxPools[key]) {
        sfxPools[key] = Array.from({ length: SFX_POOL_SIZE }, () => {
            const a = new Audio(SFX[key]);
            a.preservesPitch = false;
            a.preload = 'auto';
            a.onerror = () => {
                if (!_missingSfxWarned.has(key)) {
                    console.warn(`[Audio] No se pudo cargar el sonido local: ${SFX[key]}`);
                    _missingSfxWarned.add(key);
                }
            };
            a.load();
            return a;
        });
        sfxPools[key].cursor = 0;
    }
    return sfxPools[key];
}

function playSFX(key, volume = 1, pitchVariance = 0) {
    const pool = getSfxPool(key);
    if (!pool) return;

    const a = pool[pool.cursor];
    pool.cursor = (pool.cursor + 1) % pool.length;

    try { a.currentTime = 0; } catch (e) { /* metadata aún no lista: no es fatal */ }

    const generalVol = (typeof Settings !== 'undefined' && typeof Settings.sfxVolume === 'number') ? (Settings.sfxVolume / 100) : 1;
    a.volume = Math.max(0, Math.min(1, volume * generalVol));
    a.playbackRate = pitchVariance > 0 ? (1 + (Math.random() * 2 - 1) * pitchVariance) : 1;

    a.play().catch(() => {});
}

function preloadSFX(onProgress) {
    return new Promise(resolve => {
        const keys = Object.keys(SFX);
        if (keys.length === 0) { resolve(); return; }
        let loaded = 0;
        keys.forEach(key => {
            const pool = getSfxPool(key);
            const a = pool ? pool[0] : null;
            const done = () => {
                loaded++;
                if (onProgress) onProgress(loaded, keys.length, key);
                if (loaded === keys.length) resolve();
            };
            if (!a) { done(); return; }
            if (a.readyState >= 3) { done(); return; }
            let settled = false;
            const finish = () => { if (settled) return; settled = true; done(); };
            a.addEventListener('canplaythrough', finish, { once: true });
            a.addEventListener('error', finish, { once: true });
            setTimeout(finish, 5000);
        });
    });
}

const MUSIC_TRACKS = {
    main: [
        'Sounds/Music/Main/Tetuano - Abyss (freetouse.com).mp3'
    ],
    combat: [
        'Sounds/Music/Combat/Pufino - Digital Mayham (freetouse.com).mp3',
        'Sounds/Music/Combat/Zambolino - Imperator (freetouse.com).mp3',
        'Sounds/Music/Combat/Pufino - Metal Is Trash (freetouse.com).mp3',
        'Sounds/Music/Combat/NewMe.mp3',
        'Sounds/Music/Combat/Buddy.mp3',
        'Sounds/Music/Combat/NoPuedesConmigo.mp3',
        'Sounds/Music/Combat/ImTheBest.mp3'
    ],
    boss: [
        'Sounds/Music/Boss/Horizonte.mp3',
        'Sounds/Music/Boss/Finally.mp3',
        'Sounds/Music/Boss/Punch.mp3'
    ]
};

function preloadMusic(onProgress) {
    return new Promise(resolve => {
        const allTracks = [...MUSIC_TRACKS.main, ...MUSIC_TRACKS.combat, ...MUSIC_TRACKS.boss];
        if (allTracks.length === 0) { resolve(); return; }
        let loaded = 0;
        allTracks.forEach(src => {
            const a = new Audio();
            a.preload = 'auto';
            let settled = false;
            const finish = () => {
                if (settled) return; settled = true;
                loaded++;
                if (onProgress) onProgress(loaded, allTracks.length, src);
                if (loaded === allTracks.length) resolve();
            };
            a.addEventListener('loadedmetadata', finish, { once: true });
            a.addEventListener('error', () => { console.warn(`[Audio] No se pudo precargar la música: ${src}`); finish(); }, { once: true });
            a.src = src;
            setTimeout(finish, 6000);
        });
    });
}

const MusicManager = {
    mainTracks: MUSIC_TRACKS.main,
    combatTracks: MUSIC_TRACKS.combat,
    bossTracks: MUSIC_TRACKS.boss,
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
        this.audio.addEventListener('error', () => {
            if (this.audio.src) console.warn(`[Audio] No se pudo cargar la música: ${this.audio.src}`);
            this.next();
        });
    },
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

const AmbientAudio = {
    audio: null,
    play(key, volume = 0.35) {
        this.stop();
        const src = SFX[key];
        if (!src) { console.warn(`[Audio] Sonido ambiente inexistente: "${key}"`); return; }
        this.audio = new Audio(src);
        this.audio.loop = true;
        this.audio.volume = volume * (Settings.sfxVolume / 100);
        this.audio.onerror = () => console.warn(`[Audio] No se pudo cargar el ambiente: ${src}`);
        this.audio.play().catch(() => {});
    },
    stop() {
        if (this.audio) { this.audio.pause(); this.audio = null; }
    }
};

function isVisible(x, y, radius, cam) {
    const padding = 50;
    return (x + radius + padding > cam.x && x - radius - padding < cam.x + canvas.width &&
            y + radius + padding > cam.y && y - radius - padding < cam.y + canvas.height);
}

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
        
        if (game.fxEnabled && this.shake > 0.1) {
            this.x += (Math.random() - 0.5) * this.shake;
            this.y += (Math.random() - 0.5) * this.shake;
            this.shake *= 0.85; 
        } else {
            this.shake = 0;
        }
    }
}

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

game.explode = function(x, y, radius, dmg) {
    this.enemies.forEach(e => { if(!e.invulnerable && Math.hypot(e.x - x, e.y - y) < radius) this.hitEnemy(e, dmg); });
    if (Math.hypot(this.player.x - x, this.player.y - y) < radius) this.player.takeDamage(dmg * 0.4);
    for(let i=0; i<Math.ceil(24*this.particleScale); i++) this.spawnParticle(x, y, i % 2 === 0 ? '#e67e22' : '#f1c40f', 8, 5, 'normal');
    for(let i=0; i<Math.ceil(6*this.particleScale); i++) this.spawnParticle(x, y, '#555', 3, 6, 'smoke');
    this.camera.shake = 20;
    playSFX('rpg_explosion', 0.5, 0.1);
};
