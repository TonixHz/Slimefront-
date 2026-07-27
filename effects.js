/**
 * AUDIO SYSTEM
 * Rutas relativas a la carpeta Sounds/ (debe estar en la raíz del repo, junto a index.html).
 * Estructura esperada:
 *   Sounds/SFX/Shoots/...
 *   Sounds/SFX/Variados/...
 *   Sounds/SFX/Events/...
 *   Sounds/Music/Main/...
 *   Sounds/Music/Combat/...
 *   Sounds/Music/Boss/...
 *
 * Todo el audio (SFX puntuales, música y ambiente climático) es 100% local:
 * no hay ninguna URL externa ni fallback a servicios online. Si falta un
 * archivo, se avisa por consola con console.warn y el juego sigue andando.
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

/**
 * POOL DE SFX (un-shot, superponibles: disparos, golpes, monedas, etc.)
 * Cada clave de SFX tiene varias instancias <audio> reutilizables, así reproducir
 * ráfagas de disparos o varios enemigos a la vez no crea un `new Audio()` por evento.
 * Nunca se descarga nada de Internet: si el archivo local no existe, se deja
 * constancia en consola (console.warn) y esa clave queda muda, sin romper el juego.
 */
const sfxPools = {};
const SFX_POOL_SIZE = 14; // varias armas comparten la misma clave de sonido; un pool chico causaba latencia perceptible en oleadas con mucho fuego simultáneo
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
            // Sin fallback online: si el archivo local falta o falla, solo avisamos por consola.
            a.onerror = () => {
                if (!_missingSfxWarned.has(key)) {
                    console.warn(`[Audio] No se pudo cargar el sonido local: ${SFX[key]}`);
                    _missingSfxWarned.add(key);
                }
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
        console.warn('Error precargando SFX:', e);
    }
}

function playSFX(key, vol = 0.3, pitchVar = 0.1) {
    const pool = getSfxPool(key);
    if (!pool) return; // clave inexistente: ya se avisó en getSfxPool, seguimos sin romper nada
    const a = pool[pool.cursor];
    pool.cursor = (pool.cursor + 1) % pool.length;
    a.pause();
    a.currentTime = 0;
    a.volume = vol * (Settings.sfxVolume / 100);
    a.playbackRate = 1 + (Math.random() - 0.5) * pitchVar;
    a.play().catch(() => {});
}

/**
 * MÚSICA
 * Listas de archivos LOCALES por contexto (lobby/combate/jefe). Para agregar canciones
 * nuevas alcanza con sumar rutas a estos arrays; se elige una al azar de la carpeta
 * correspondiente y, al terminar, se encadena automáticamente otra (nunca se queda
 * sin música). Los nombres de archivo abajo siguen los créditos de LICENSE.md —
 * si tus archivos reales tienen otro nombre, solo hay que ajustar estas rutas.
 */
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

const MusicManager = {
    // Se mantienen estos 3 nombres porque otros archivos (world.js) los referencian directamente.
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
            // Nunca sin música: si una pista falla, se intenta con otra del mismo contexto.
            this.next();
        });
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
 * AMBIENTE (lluvia/viento/arena en loop). Reutiliza las MISMAS claves y rutas locales que
 * ya viven en SFX (rain/wind/sandstorm) en vez de mantener una lista de URLs paralela:
 * antes existían dos catálogos de sonido distintos (uno local en SFX y otro con URLs
 * de Google en events.js) para las mismas cosas. Ahora hay un solo dueño de esas rutas.
 * Respeta el volumen general de SFX, pero es independiente del volumen de cada disparo.
 */
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
        
        // Screen shake: único punto que aplica el shake acumulado por armas/explosiones/etc.
        // (todas esas asignaciones directas a game.camera.shake siguen intactas, simplemente
        // no se traducen en desplazamiento de cámara cuando game.fxEnabled está apagado, como
        // ocurre con el preset ULTRA).
        if (game.fxEnabled && this.shake > 0.1) {
            this.x += (Math.random() - 0.5) * this.shake;
            this.y += (Math.random() - 0.5) * this.shake;
            this.shake *= 0.85; 
        } else {
            this.shake = 0;
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
    playSFX('rpg_explosion', 0.5, 0.1); // corregido: 'rpg' no existía en SFX, usaba fallback silencioso
};
