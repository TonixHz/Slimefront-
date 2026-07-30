"use strict";

/* ================= FirebaseSaveSystem.js ================= */
/**
 * FIREBASE SAVE SYSTEM
 * Reemplazo del SaveSystem viejo (localStorage puro, vivía dentro de level.js).
 *
 * OBJETIVO DE DISEÑO: nadie más en el proyecto debería tener que saber que existe
 * Firebase. level.js / progression.js / achievements.js siguen llamando exactamente
 * a las mismas dos funciones de siempre:
 *
 *     SaveSystem.get(key, fallback)   -> SIEMPRE síncrono, nunca bloquea el juego
 *     SaveSystem.set(key, value)      -> SIEMPRE síncrono en apariencia (escribe en
 *                                         caché local al toque; Firestore se sincroniza
 *                                         solo, en segundo plano, con reintentos)
 *
 * Toda la comunicación real con Firebase (Auth + Firestore) vive ÚNICAMENTE acá.
 * Ningún otro archivo importa firebase.* directamente.
 *
 * ESTRATEGIA "OFFLINE-FIRST":
 *   1. Lectura: primero memoria (this._cache), si no está, localStorage. Firestore
 *      NUNCA se consulta de forma síncrona (no se puede: es una promesa).
 *   2. Escritura: se guarda en memoria + localStorage al instante (el juego sigue
 *      andando igual que con el SaveSystem viejo) y se marca la key como "sucia".
 *      Cada ~2.5s (debounce) se empuja el lote de keys sucias a Firestore. Si
 *      Firestore falla (sin red, reglas, etc.) el error se traga con un console.warn
 *      y las keys quedan pendientes para el próximo intento: el juego JAMÁS se rompe
 *      ni se bloquea por un fallo de red.
 *   3. Login: al iniciar sesión con Google, se descarga el documento del usuario
 *      (players/{uid}) UNA vez y se mergea sobre la caché local + localStorage. Como
 *      PlayerProfile/Progression/AchievementStats/AchievementState ya existen para
 *      ese momento (se construyeron de forma síncrona al cargar el script, antes de
 *      que Firebase resuelva el login), cada módulo se suscribe con
 *      SaveSystem.onRemoteData(cb) para "refrescarse" a sí mismo cuando llegan datos
 *      más nuevos desde la nube.
 *
 * PREPARADO PARA RANKINGS ONLINE A FUTURO:
 *   pushLeaderboardEntry() ya deja escrito un documento liviano y consultable en la
 *   colección top-level `leaderboard` (uid, nombre, nivel, mejor oleada, fecha). Hoy
 *   nadie la llama todavía: es la base para una futura pantalla de "Top jugadores"
 *   sin tener que rediseñar nada de este archivo.
 *
 * NUEVO (boot flow): SaveSystem.ready es una Promise que resuelve cuando Firebase
 * Auth ya resolvió su primer estado (logueado o no) y, si había sesión, ya se bajó
 * el progreso de Firestore. boot.js espera esto antes de mostrar cualquier pantalla.
 *
 * NUEVO: SaveSystem.clearProgress() borra por completo el progreso (local + nube),
 * usado desde Ajustes → Borrar progreso.
 *
 * Debe cargarse:
 *   - DESPUÉS de los <script> del SDK de Firebase (compat) en index.html.
 *   - ANTES de level.js / progression.js / achievements.js (que consumen SaveSystem).
 */

const firebaseConfig = {
    apiKey: "AIzaSyCS8jXSpTuSDRRDQO24aGvhR00oKKcbhyY",
    authDomain: "slimefront-f011e.firebaseapp.com",
    projectId: "slimefront-f011e",
    storageBucket: "slimefront-f011e.firebasestorage.app",
    messagingSenderId: "956912162086",
    appId: "1:956912162086:web:273d1a3c73e0fadb659de7",
    measurementId: "G-4R5NPJCSTK"
};

firebase.initializeApp(firebaseConfig);
const _auth = firebase.auth();
const _db = firebase.firestore();

// Analytics es opcional y no debe poder romper el arranque del juego si el navegador
// bloquea el script (adblockers, iOS privado, etc.)
try { firebase.analytics(); } catch (e) { console.warn('[FirebaseSaveSystem] Analytics no disponible:', e); }

// Caché de Firestore en disco del propio SDK (además de nuestra copia en localStorage).
// synchronizeTabs permite tener el juego abierto en 2 pestañas sin que una pise a la otra.
try {
    _db.enablePersistence({ synchronizeTabs: true }).catch(err => {
        console.warn('[FirebaseSaveSystem] Persistencia de Firestore no disponible (multi-pestaña o navegador no soportado):', err.code || err);
    });
} catch (e) { /* SDK viejo sin soporte, no es fatal */ }

const _LOCAL_PREFIX = 'slime_';
const _SYNC_DEBOUNCE_MS = 2500;
const PLAYERS_COLLECTION = 'players';
const LEADERBOARD_COLLECTION = 'leaderboard';

const SaveSystem = {
    _cache: {},
    _uid: null,
    _dirty: new Set(),
    _pushTimer: null,
    _remoteListeners: [],
    ready: null,        // Promise que resuelve cuando Firebase Auth ya resolvió su
                         // primer estado (logueado o no) Y, si había sesión, ya se
                         // bajó el progreso de Firestore. boot.js espera esto antes
                         // de mostrar cualquier pantalla.
    _readyResolve: null,

    // ================= LECTURA / ESCRITURA (misma interfaz que el SaveSystem viejo) =================

    get(key, fallback) {
        if (key in this._cache) return this._cache[key];
        try {
            const raw = localStorage.getItem(_LOCAL_PREFIX + key);
            if (raw !== null) {
                const value = JSON.parse(raw);
                this._cache[key] = value;
                return value;
            }
        } catch (e) { /* localStorage corrupto o deshabilitado: seguimos con el fallback */ }
        return fallback;
    },

    set(key, value) {
        this._cache[key] = value;
        try { localStorage.setItem(_LOCAL_PREFIX + key, JSON.stringify(value)); } catch (e) { /* cuota llena, modo privado, etc. */ }
        this._dirty.add(key);
        this._scheduleSync();
    },

    // ================= SUSCRIPCIÓN A DATOS REMOTOS =================
    // Cualquier módulo (level.js, progression.js, achievements.js) puede registrar un
    // callback acá para enterarse quí keys llegaron/actualizaron desde Firestore
    // DESPUÉS de que sus propios objetos (PlayerProfile, etc.) ya se armaron en frío.
    onRemoteData(callback) {
        this._remoteListeners.push(callback);
    },
    _notifyRemote(keys) {
        this._remoteListeners.forEach(cb => {
            try { cb(keys); } catch (e) { console.warn('[FirebaseSaveSystem] Error en listener onRemoteData:', e); }
        });
    },

    // ================= SINCRONIZACIÓN CON FIRESTORE (nunca bloquea, nunca rompe) =================

    _scheduleSync() {
        clearTimeout(this._pushTimer);
        this._pushTimer = setTimeout(() => this._pushDirty(), _SYNC_DEBOUNCE_MS);
    },

    async _pushDirty() {
        if (!this._uid || this._dirty.size === 0) return;
        const keys = Array.from(this._dirty);
        this._dirty.clear();
        const patch = {};
        keys.forEach(k => {
            // Firestore rechaza con "invalid-argument" cualquier valor no serializable
            // (funciones, undefined, etc.). PlayerProfile, por ejemplo, tiene su propio
            // método .save colgando del mismo objeto que se cachea acá (ver level.js:
            // "PlayerProfile.save = function(){...}"), y localStorage lo tolera porque
            // JSON.stringify ignora funciones en silencio, pero el SDK de Firestore no.
            // Pasamos todo por el mismo ciclo JSON para quedarnos solo con datos planos.
            try {
                patch[k] = JSON.parse(JSON.stringify(this._cache[k]));
            } catch (e) {
                console.warn(`[FirebaseSaveSystem] No se pudo serializar la key "${k}", se omite este ciclo de sync:`, e);
            }
        });
        patch._updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        try {
            await _db.collection(PLAYERS_COLLECTION).doc(this._uid).set(patch, { merge: true });
        } catch (e) {
            console.warn('[FirebaseSaveSystem] Firestore no disponible, se sigue jugando con la caché local. Reintentará:', e.code || e);
            keys.forEach(k => this._dirty.add(k));
        }
    },

    // Fuerza el envío inmediato (se usa al cerrar sesión o al salir de la pestaña)
    async flush() {
        clearTimeout(this._pushTimer);
        await this._pushDirty();
    },

    // ================= CARGA INICIAL AL INICIAR SESIÓN =================

    async _pullRemote(uid) {
        try {
            const snap = await _db.collection(PLAYERS_COLLECTION).doc(uid).get();
            if (!snap.exists) return; // usuario nuevo en Firestore: se queda con lo que ya tenía local (o default)
            const data = snap.data();
            const changedKeys = [];
            Object.keys(data).forEach(k => {
                if (k === '_updatedAt') return;
                this._cache[k] = data[k];
                try { localStorage.setItem(_LOCAL_PREFIX + k, JSON.stringify(data[k])); } catch (e) {}
                changedKeys.push(k);
            });
            if (changedKeys.length) this._notifyRemote(changedKeys);
        } catch (e) {
            console.warn('[FirebaseSaveSystem] No se pudo descargar el progreso de la nube, se sigue con la caché local:', e.code || e);
        }
    },

    // ================= BORRADO TOTAL DE PROGRESO (nuevo) =================
    // Borra localStorage + caché en memoria + el documento en Firestore (si hay
    // sesión). NO toca la sesión de auth ni las preferencias de gráficos/volumen
    // (esas viven aparte, en Settings de ui.js).
    async clearProgress() {
        const keys = ['profile', 'progression', 'achv_stats', 'achv_state'];
        keys.forEach(k => {
            delete this._cache[k];
            this._dirty.delete(k);
            try { localStorage.removeItem(_LOCAL_PREFIX + k); } catch (e) {}
        });
        clearTimeout(this._pushTimer);
        if (this._uid) {
            try {
                // set con merge:false reemplaza el documento entero por uno vacío,
                // borrando cualquier campo viejo que hubiera en la nube.
                await _db.collection(PLAYERS_COLLECTION).doc(this._uid).set({}, { merge: false });
            } catch (e) {
                console.warn('[FirebaseSaveSystem] No se pudo borrar el progreso en la nube:', e.code || e);
            }
        }
    },

    // ================= AUTENTICACIÓN =================

    async signInWithGoogle() {
        const provider = new firebase.auth.GoogleAuthProvider();
        try {
            await _auth.signInWithPopup(provider);
        } catch (e) {
            console.warn('[FirebaseSaveSystem] Login con Google falló:', e.code || e);
        }
    },

    async signOut() {
        await this.flush();
        try { await _auth.signOut(); } catch (e) { console.warn('[FirebaseSaveSystem] Error al cerrar sesión:', e); }
    },

    get currentUser() { return _auth.currentUser; },

    // ================= RANKINGS ONLINE (preparado para el futuro, no se usa aún) =================
    // Documento liviano y fácil de indexar/ordenar en Firestore (nivel, mejor oleada, nombre),
    // separado del documento grande de progreso (players/{uid}) para no tener que leer todo
    // el perfil de cada jugador solo para armar una tabla de posiciones.
    async pushLeaderboardEntry(fields) {
        if (!this._uid) return;
        try {
            await _db.collection(LEADERBOARD_COLLECTION).doc(this._uid).set({
                ...fields,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (e) {
            console.warn('[FirebaseSaveSystem] No se pudo actualizar el leaderboard (no crítico):', e.code || e);
        }
    },

    init() {
        this.ready = new Promise(resolve => { this._readyResolve = resolve; });
        let firstCheck = true;
        _auth.onAuthStateChanged(async user => {
            this._uid = user ? user.uid : null;
            if (user) {
                await this._pullRemote(user.uid);
                document.dispatchEvent(new CustomEvent('savesystem:login', { detail: { uid: user.uid, user } }));
            } else {
                document.dispatchEvent(new CustomEvent('savesystem:logout'));
            }
            if (firstCheck) { firstCheck = false; this._readyResolve(); }
        });
        // Último intento de guardar antes de cerrar/recargar la pestaña
        window.addEventListener('beforeunload', () => { this._pushDirty(); });
    }
};

SaveSystem.init();

//# sourceURL=FirebaseSaveSystem.js

/* ================= main.js ================= */
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
const MAP_SIZE = 4000;
const LOW_ENEMY_THRESHOLD = 20;

const game = {
    player: null,
    enemies: [], props: [], floatingTexts: [],
    // Object Pools
    particles: [], casings: [], projectiles: [], trails: [],
    camera: null,
    wave: 1, isWaveActive: false, paused: false,
    started: false, shadowsEnabled: true, fxEnabled: true,
    keys: {}, mouse: { x: 0, y: 0, down: false },
    lastShot: 0, particleScale: 1, lowEnemyMode: false,
    _inputBound: false,

    init() {
        // Reset completo: init() ahora puede llamarse más de una vez en la misma
        // sesión de página (Jugar de Nuevo / Volver al Menú y volver a jugar), así
        // que hay que vaciar todo lo que antes solo se llenaba una vez.
        this.enemies = []; this.props = []; this.floatingTexts = [];
        this.particles = []; this.casings = []; this.projectiles = []; this.trails = [];
        this.wave = 1; this.isWaveActive = false; this.paused = false;
        if (typeof EventManager !== 'undefined') EventManager.deactivate();

        this.started = true;
        this.player = new Player();
        this.camera = new Camera();
        const gfx = GRAPHICS_PRESETS[Settings.graphics] || GRAPHICS_PRESETS.PRO;
        this.shadowsEnabled = gfx.shadows;
        // Bandera global única para el resto de efectos que no pasan por un Object Pool
        // (camera shake, destello de boca, partículas de clima, tinte ambiental). El
        // preset ULTRA es el único que la apaga; ver GRAPHICS_PRESETS en ui.js.
        this.fxEnabled = !gfx.ultra;

        // Pre-alocar arrays para Object Pooling (el tamaño depende del preset gráfico elegido)
        for(let i=0; i<gfx.particles; i++) this.particles.push(new Particle());
        for(let i=0; i<gfx.casings; i++) this.casings.push(new Casing());
        for(let i=0; i<gfx.projectiles; i++) this.projectiles.push(new Projectile());
        for(let i=0; i<gfx.trails; i++) this.trails.push(new Trail());
        this.particles.forEach(p => p.active = false);
        this.casings.forEach(c => c.active = false);
        this.projectiles.forEach(p => p.active = false);
        this.trails.forEach(t => t.active = false);
        for(let i=0; i<40; i++) this.floatingTexts.push(new FloatingText());
        this.floatingTexts.forEach(t => t.active = false);

        // Generar mapa procedural con props variados y balanceados
        const propTypes = ['rock', 'rock_tall', 'rock_split', 'tree', 'tree_pine', 'tree_dead', 'crate', 'bush', 'pebbles'];
        for(let i=0; i<gfx.props; i++) {
            let t = propTypes[Math.floor(Math.random() * propTypes.length)];
            // Más densidad de pasto y arbustos, menos rocas gigantes
            if (Math.random() > 0.6 && ['rock_tall', 'tree', 'tree_pine'].includes(t)) continue; 
            this.props.push(new Prop(t));
        }
        // Ordenar props para renderizar primero los de suelo y luego los altos (Z-sorting estático)
        this.props.sort((a,b) => (a.isSolid ? 1 : 0) - (b.isSolid ? 1 : 0));
        this.buildPropGrid();
        this.startTime = Date.now();

        if (!this._inputBound) {
            this._inputBound = true;
            window.addEventListener('keydown', e => {
                this.keys[e.code] = true;
                if(e.key >= 1 && e.key <= 5) this.player.activeSlot = e.key - 1;
                if(e.code === 'KeyR') this.reload();
                if(e.code === 'Space') {
                    e.preventDefault(); // evita que la página scrollee con la barra espaciadora
                    if(!this.paused) this.player.dash();
                }
                if(e.code === 'Escape') this.toggleEscMenu();
            });
            window.addEventListener('keyup', e => this.keys[e.code] = false);
            window.addEventListener('mousemove', e => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
            window.addEventListener('mousedown', () => this.mouse.down = true);
            window.addEventListener('mouseup', () => this.mouse.down = false);
        }

        this.startNextWave();
    },

    // Sistema de Colisiones Físicas Circulares contra el entorno
    resolveCollision(entity, prop) {
        let dx = entity.x - prop.x;
        let dy = entity.y - prop.y;
        let dist = Math.hypot(dx, dy);
        let min = entity.radius + prop.radius;
        if(dist < min && dist > 0) {
            let force = (min - dist) / dist * (this.knockbackMult || 1);
            entity.x += dx * force;
            entity.y += dy * force;
        }
    },

    loop() {
        // Mientras no haya partida activa (menú, login, etc.) el loop no dibuja ni
        // actualiza nada — solo se reprograma. Esto permite que exista UN SOLO loop
        // arrancado una sola vez al cargar la página (ver el final de este archivo),
        // en vez de arrancar uno nuevo cada vez que se llama a init().
        if (!this.started || !this.player || !this.camera) {
            requestAnimationFrame(() => this.loop());
            return;
        }

        this.camera.follow(this.player);
        // Tiempo Lento: si el evento está activo, solo la mitad de los frames ejecutan lógica de juego
        this._slowToggle = !this._slowToggle;
        const doStep = this.activeEvent !== 'SLOW_TIME' || this._slowToggle;

        // Distancia jugador-enemigo cacheada una sola vez por frame (la reutilizan la física,
        // el frame-skipping/sueño de IA de más abajo y Enemy.update, en vez de recalcularla cada uno)
        this._frameCount = (this._frameCount || 0) + 1;
        for(let i=0; i<this.enemies.length; i++) {
            this.enemies[i]._dist = Math.hypot(this.enemies[i].x - this.player.x, this.enemies[i].y - this.player.y);
        }
        // Escala global de partículas: baja automáticamente con muchas entidades activas para sostener el framerate
        this.particleScale = this.enemies.length > 150 ? 0.35 : (this.enemies.length > 80 ? 0.6 : 1);
        // Modo "cacería final": quedan pocos enemigos, se desactiva el sueño de IA y el
// frame-skipping para que ninguno quede ignorando al jugador lejos del mapa.
	this.lowEnemyMode = this.enemies.length > 0 && this.enemies.length < LOW_ENEMY_THRESHOLD;

        // Terreno Procedural Optimizado
        ctx.fillStyle = terrainPattern;
        ctx.save();
        ctx.translate(-this.camera.x % 512, -this.camera.y % 512);
        ctx.fillRect(-512, -512, canvas.width + 1024, canvas.height + 1024);
        ctx.restore();

        // Update & Culling Props (Sombras y dibujado)
        if (this.shadowsEnabled) this.props.forEach(p => p.drawShadow(this.camera));

        // Física Ambiental (usando grid espacial: ya no recorre TODOS los props)
        const nearbyPlayerProps = this.getNearbyProps(this.player.x, this.player.y);
        nearbyPlayerProps.forEach(p => this.resolveCollision(this.player, p));
        this.enemies.forEach(e => {
            if (e._dist > 1500) return; // IA dormida: fuera de rango, no necesita física de props
            const nearbyEnemyProps = this.getNearbyProps(e.x, e.y);
            nearbyEnemyProps.forEach(p => {
                if(Math.hypot(e.x - p.x, e.y - p.y) < p.radius + e.radius + 50) this.resolveCollision(e, p);
            });
        });

        // Input & Player Update
        if(!this.paused) {
            if (doStep) { this.player.update(this.keys); if(this.mouse.down) this.shoot(); }
            EventManager.update();
        }

        // Rastro Viscoso
        this.trails.forEach(t => { if(t.active) { t.update(); t.draw(this.camera); } });

        // Dibujo de props (ordenados Z)
        this.props.forEach(p => p.draw(this.camera));

        // Casquillos
        this.casings.forEach(c => { if(c.active) { c.update(); c.draw(this.camera); } });

        // Proyectiles con Object Pooling
        this.projectiles.forEach(p => {
            if(!p.active) return;
            if (doStep) p.update();
            p.draw(this.camera);
            
            // Colisiones Proyectil - Props Sólidos (grid espacial)
            let hitProp = false;
            const nearbyProjProps = this.getNearbyProps(p.x, p.y);
            for(let k=0; k<nearbyProjProps.length; k++) {
                let pr = nearbyProjProps[k];
                if(Math.hypot(p.x - pr.x, p.y - pr.y) < pr.radius + p.radius) {
                    p.active = false; hitProp = true;
                    // Chispas al chocar con terreno
                    for(let i=0; i<Math.ceil(3*this.particleScale); i++) this.spawnParticle(p.x, p.y, '#95a5a6', 2, 2, 'normal');
                    break;
                }
            }
            if(hitProp) return;

            if(p.isEnemy) {
                if(Math.hypot(p.x - this.player.x, p.y - this.player.y) < this.player.radius) {
                    this.player.takeDamage(p.damage); p.active = false;
                }
            } else {
                for(let j = this.enemies.length - 1; j >= 0; j--) {
                    let e = this.enemies[j];
                    if(!e.invulnerable && !p.hitEnemies.has(e) && Math.hypot(p.x - e.x, p.y - e.y) < e.radius) {
                        this.hitEnemy(e, p.damage, { playerShot: true }); // la lógica de muerte/recompensa vive acá ahora
                        p.hitEnemies.add(e);
                        if (p.knockback) { // Shotgun: empuja al enemigo lejos del impacto
                            let ka = Math.atan2(e.y - p.y, e.x - p.x);
                            e.x += Math.cos(ka) * p.knockback * 0.06;
                            e.y += Math.sin(ka) * p.knockback * 0.06;
                        }
                        if (p.burn) { e.burnTicks = 180; e.burnDmg = 3; } // Lanzallamas: aplica quemadura ~3s
                        if (p.explosive) { this.explode(p.x, p.y, p.explosionRadius, p.damage); } // RPG
                        if (p.explosive || p.pierce <= 0) { p.active = false; } else { p.pierce--; }
                        break;
                    }
                }
            }
        });

        // Enemigos y Jugador
        this.enemies.forEach((e, i) => {
            if(!this.paused && doStep) {
                if (this.lowEnemyMode) {
                    // Cacería final: sin sueño de IA ni frame-skipping, persiguen desde cualquier punto del mapa
                    e.update(this.player);
                } else if (e._dist > 1500) {
                    // IA dormida: muy lejos del jugador, no ejecuta lógica hasta que vuelva a acercarse
                } else if (e._dist > 700 && e.type !== 'BOSS' && (this._frameCount + i) % 2 === 0) {
                    // Frame skipping: enemigos a media distancia reparten su update entre frames
                } else {
                    e.update(this.player);
                }
            }
            e.draw(this.camera);
        });
        
        // RENDERIZAR AL JUGADOR (crítico - estaba faltando)
        this.player.draw(this.camera, this.mouse);
        
        // Partículas y Textos
        this.particles.forEach(p => { if(p.active) { p.update(); p.draw(this.camera); } });
        this.floatingTexts.forEach(t => { if(t.active) { t.update(); t.draw(this.camera); } });

        // Tinte ambiental atardecer: puramente cosmético (no aporta información de juego),
        // se apaga en ULTRA para ahorrarse un fillRect de pantalla completa por frame.
        if (this.fxEnabled) {
            ctx.fillStyle = 'rgba(230, 126, 34, 0.08)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        EventManager.drawOverlay();
        // UI Updates
        const mobileControls = document.getElementById('mobile-controls');
        if(mobileControls) mobileControls.style.pointerEvents = this.paused ? 'none' : 'auto';
        document.getElementById('health-inner').style.width = (this.player.hp / this.player.maxHp * 100) + "%";
        document.getElementById('health-text').innerText = `${Math.floor(this.player.hp)} / ${this.player.maxHp}`;
        document.getElementById('money-display').innerText = "CASH: $" + this.player.money;
        document.getElementById('wave-display').innerText = "WAVE: " + this.wave;
        
        let w = this.player.weapon;
        document.getElementById('ammo-hud').innerText = w ? (w.ammo === Infinity ? "∞" : w.ammo) : "--";
        if(this.player.isReloading) document.getElementById('ammo-hud').innerText = "RELOAD";

        const hotbar = document.getElementById('hotbar');
        if(hotbar.children.length === 0) {
            for(let i=0; i<5; i++) hotbar.innerHTML += `<div class="slot" id="slot-${i}" onclick="game.player.activeSlot=${i}"><span class="slot-key">${i+1}</span><span class="name"></span><span class="slot-ammo"></span></div>`;
        }
        for(let i=0; i<5; i++) {
            let s = this.player.inventory[i];
            let el = document.getElementById(`slot-${i}`);
            el.className = this.player.activeSlot === i ? "slot active" : "slot";
            el.querySelector('.name').innerText = s ? s.name : "";
            el.querySelector('.slot-ammo').innerText = s ? (s.ammo === Infinity ? "" : s.ammo) : "";
        }

        if(this.isWaveActive && this.enemies.length === 0) {
            this.isWaveActive = false; this.wave++;
            this.paused = true;
            EventManager.deactivate();
            MusicManager.duck();
            this.updateShop();
            document.getElementById('shop-menu').style.display = "block";
        }

        requestAnimationFrame(() => this.loop());
    }
};

window.addEventListener('resize', () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });

// Arranca el único loop de renderizado del juego. Gracias al guard agregado al
// principio de loop(), esto no dibuja nada hasta que exista game.player (o sea,
// hasta el primer game.init()), así que es seguro llamarlo ya mismo.
game.loop();

window.addEventListener('DOMContentLoaded', () => {
    const lobbyScreen = document.getElementById('lobby-screen');
    if (lobbyScreen) {
        lobbyScreen.innerHTML = `
            <div class="menu-panel">
                <h1 class="menu-title">SLIMEFRONT</h1>
                <p class="menu-subtitle">Enhanced Edition</p>
                <div id="auth-box" class="auth-box">
                    <span id="auth-status" class="hud-text"></span>
                    <button id="auth-btn" class="menu-btn" onclick="AuthUI.handleClick()"></button>
                </div>
                <button class="menu-btn primary" onclick="game.startFromLobby()">▶ JUGAR</button>
                <button class="menu-btn" onclick="game.openSettings('lobby')">⚙ AJUSTES</button>
                <button class="menu-btn" onclick="game.toggleControls(true)">📖 CONTROLES</button>
                <button class="menu-btn" onclick="game.openCredits()">🎬 CRÉDITOS</button>
                <div style="margin-top:20px; font-size:18px;">
                    <div>RÉCORD: ${Settings.bestWave} OLEADAS</div>
                    <div class="version-tag">v0.9</div>
                </div>
            </div>
        `;
        // AuthUI (auth-ui.js) se carga después que este script arma el lobby por primera
        // vez, así que el botón nace vacío y se rellena solo apenas AuthUI exista (su
        // propio listener de DOMContentLoaded llama a refresh() al terminar de cargar).
        if (typeof AuthUI !== 'undefined') AuthUI.refresh();
    }

    // Asegúrate de que este panel exista en tu HTML (o créalo dinámicamente)
    const controlsPanel = document.getElementById('controls-panel');
    if (controlsPanel) {
        controlsPanel.innerHTML = `
            <div class="menu-panel">
                <h2 class="menu-title">CONTROLES</h2>
                <div class="controls-list">
                    <div class="control-item"><span>WASD</span><span class="control-key">MOVER</span></div>
                    <div class="control-item"><span>MOUSE</span><span class="control-key">APUNTAR</span></div>
                    <div class="control-item"><span>CLICK</span><span class="control-key">DISPARAR</span></div>
                    <div class="control-item"><span>R</span><span class="control-key">RECARGAR</span></div>
                    <div class="control-item"><span>SHIFT</span><span class="control-key">SPRINT</span></div>
                    <div class="control-item"><span>ESPACIO</span><span class="control-key">DASH</span></div>
                    <div class="control-item"><span>ESC</span><span class="control-key">PAUSA</span></div>
                </div>
                <button class="menu-btn" onclick="game.toggleControls(false)">← VOLVER</button>
            </div>
        `;
    }

    document.addEventListener('click', e => {
        const btn = e.target.closest('.menu-btn, .option-btn, .buy-btn, .sell-btn, .depart-btn, .shop-btn');
        if (!btn) return;
        const isBack = btn.textContent.includes('VOLVER') || btn.onclick?.toString().includes('close');
        playSFX(isBack ? 'ui_back' : 'ui_click', 0.4);
    });
    document.addEventListener('mouseover', e => {
        const btn = e.target.closest('.menu-btn, .option-btn, .buy-btn, .sell-btn, .depart-btn, .shop-btn');
        if (btn) playSFX('ui_hover', 0.15, 0.05);
    });
});

//# sourceURL=main.js

/* ================= ui.js ================= */
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

    MusicManager.duck(400);
    MusicManager.tracks = MusicManager.mainTracks;
    MusicManager.currentIndex = -1;
    setTimeout(() => { if (!game.started) MusicManager.start(); }, 450);

    document.getElementById('lobby-screen').style.display = 'flex';
};

// Arranca una partida nueva directo desde la pantalla de Game Over (sin pasar
// por el menú principal).
game.playAgain = function() {
    document.getElementById('gameover-screen').style.display = 'none';
    MusicManager.duck(300);
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

//# sourceURL=ui.js

/* ================= effects.js ================= */
/**
 * AUDIO SYSTEM
 * Rutas relativas a la carpeta assets/Sounds/ (debe estar en la raíz del repo, junto a index.html).
 * Estructura esperada:
 *   assets/Sounds/SFX/Shoots/...
 *   assets/Sounds/SFX/Variados/...
 *   assets/Sounds/SFX/Events/...
 *   assets/Sounds/Music/Main/...
 *   assets/Sounds/Music/Combat/...
 *   assets/Sounds/Music/Boss/...
 *
 * Todo el audio (SFX puntuales, música y ambiente climático) es 100% local:
 * no hay ninguna URL externa ni fallback a servicios online. Si falta un
 * archivo, se avisa por consola con console.warn y el juego sigue andando.
 */
const SFX = {
    // --- Disparos ---
    shoot_G18: 'assets/Sounds/SFX/Shoots/PISTOLA.ogg',
    shoot_SHOTGUN: 'assets/Sounds/SFX/Shoots/ESCOPETA.wav',
    shoot_SHOTGUN2: 'assets/Sounds/SFX/Shoots/ESCOPETA2.mp3',
    shoot_rifle: 'assets/Sounds/SFX/Shoots/RIFLES.mp3',
    shoot_smg: 'assets/Sounds/SFX/Shoots/SMG.mp3',
    shoot_sniper: 'assets/Sounds/SFX/Shoots/SNIPER.mp3',
    shoot_sniper2: 'assets/Sounds/SFX/Shoots/SNIPER2.mp3',
    shoot_revolver: 'assets/Sounds/SFX/Shoots/REVOLVER.mp3',

// --- Nuevos (UI) ---
    levelup: 'assets/Sounds/SFX/UI/NIVELUP.mp3',
    ui_back: 'assets/Sounds/SFX/UI/BACKBUTTON.mp3',
    ui_click: 'assets/Sounds/SFX/UI/CLICKBUTTON.mp3',
    ui_hover: 'assets/Sounds/SFX/UI/HOVERBUTTON.mp3',
    achievement_unlock: 'assets/Sounds/SFX/UI/LOGRODESBLOQUEADO.mp3',

    // --- Melee ---
    melee: 'assets/Sounds/SFX/Shoots/MEELE.mp3',
    melee2: 'assets/Sounds/SFX/Shoots/MEELE2.mp3',
    melee3: 'assets/Sounds/SFX/Shoots/MEELE3.mp3',
    chainsaw: 'assets/Sounds/SFX/Shoots/CHAINSAW.mp3',
    chainsaw_hit: 'assets/Sounds/SFX/Shoots/CHAINSAWHIT.mp3',

    // --- Especiales ---
    flamethrower: 'assets/Sounds/SFX/Shoots/FLAMETHROWER.mp3',
    rpg_launch: 'assets/Sounds/SFX/Shoots/RPGLAUNCH.mp3',
    rpg_explosion: 'assets/Sounds/SFX/Shoots/RPGEXPLOSION.mp3',

    // --- Variados ---
    kamikaze: 'assets/Sounds/SFX/Variados/KAMIKAZEEXPLOSION.mp3',
    death: 'assets/Sounds/SFX/Variados/SLIMEDEATH.mp3',
    muerte_player: 'assets/Sounds/SFX/Variados/muerteplayer.mp3',

    // --- Genéricos que ya usaba el juego (mapeados a lo más parecido que mandaste) ---
    hit: 'assets/Sounds/SFX/Shoots/MEELE.mp3',
    reload: 'assets/Sounds/SFX/Shoots/PISTOLA.ogg',
    coin: 'assets/Sounds/SFX/Variados/SLIMEDEATH.mp3', // placeholder intencional, no tocar
    explosion: 'assets/Sounds/SFX/Shoots/RPGEXPLOSION.mp3',

    // --- Clima / Eventos ---
    wind: 'assets/Sounds/SFX/Events/liecio-strong-howling-wind-132281.mp3',
    sandstorm: 'assets/Sounds/SFX/Events/soundreality-sandstorm-222741.mp3',
    thunder: 'assets/Sounds/SFX/Events/universfield-loud-thunder-192165.mp3',
    rain: 'assets/Sounds/SFX/Events/soundsforyou-light-rain-ambient-114354.mp3'
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

/**
 * playSFX(key, volume, pitchVariance)
 * ÚNICO punto del juego que reproduce un efecto de sonido puntual/superponible.
 * Restaurada acá (vivía implícitamente antes de separar el sistema de precarga) para
 * que TODO el código existente (player.js, level.js, achievements.js, progression.js,
 * world.js, main.js, events.js) que ya la llama siga funcionando sin ningún cambio.
 *
 * Firma usada en todo el proyecto:
 *   playSFX('reload')                        -> solo la clave, volumen y pitch por defecto
 *   playSFX('death', 0.5)                    -> clave + volumen relativo (0-1)
 *   playSFX('chainsaw_hit', 0.2, 0.05)       -> clave + volumen + variación de pitch (+/- ese %)
 *
 * - Toma la siguiente instancia <audio> libre del pool (round-robin vía pool.cursor),
 *   así varios disparos/golpes simultáneos con la misma clave no se cortan entre sí.
 * - El volumen final respeta además el volumen general de efectos (Settings.sfxVolume),
 *   igual que ya hace AmbientAudio en este mismo archivo.
 * - Si la clave no existe en SFX, getSfxPool ya deja el warning en consola y acá
 *   simplemente no se reproduce nada (el juego nunca se rompe por un sonido faltante).
 */
function playSFX(key, volume = 1, pitchVariance = 0) {
    const pool = getSfxPool(key);
    if (!pool) return;

    const a = pool[pool.cursor];
    pool.cursor = (pool.cursor + 1) % pool.length;

    try { a.currentTime = 0; } catch (e) { /* metadata aún no lista: no es fatal */ }

    const generalVol = (typeof Settings !== 'undefined' && typeof Settings.sfxVolume === 'number') ? (Settings.sfxVolume / 100) : 1;
    a.volume = Math.max(0, Math.min(1, volume * generalVol));
    a.playbackRate = pitchVariance > 0 ? (1 + (Math.random() * 2 - 1) * pitchVariance) : 1;

    a.play().catch(() => {
        // Bloqueado por autoplay policy o interrumpido por otro play(): no rompe el juego.
    });
}

// Precarga TODOS los sonidos y devuelve una Promise que resuelve cuando cada uno
// terminó de cargar (o falló / venció el timeout de seguridad, para que un sonido
// roto o lento nunca cuelgue el arranque del juego para siempre).
// onProgress(cargados, total, key) se llama por cada sonido que termina.
function preloadSFX(onProgress) {
    return new Promise(resolve => {
        const keys = Object.keys(SFX);
        if (keys.length === 0) { resolve(); return; }
        let loaded = 0;
        keys.forEach(key => {
            const pool = getSfxPool(key); // ya crea y llama .load() en todo el pool
            const a = pool ? pool[0] : null;
            const done = () => {
                loaded++;
                if (onProgress) onProgress(loaded, keys.length, key);
                if (loaded === keys.length) resolve();
            };
            if (!a) { done(); return; }
            if (a.readyState >= 3) { done(); return; } // ya tiene suficiente data
            let settled = false;
            const finish = () => { if (settled) return; settled = true; done(); };
            a.addEventListener('canplaythrough', finish, { once: true });
            a.addEventListener('error', finish, { once: true });
            setTimeout(finish, 5000); // seguridad: nunca bloquear el arranque
        });
    });
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
        'assets/Sounds/Music/Main/Tetuano - Abyss (freetouse.com).mp3'
    ],
    combat: [
        'assets/Sounds/Music/Combat/Pufino - Digital Mayham (freetouse.com).mp3',
        'assets/Sounds/Music/Combat/Zambolino - Imperator (freetouse.com).mp3',
        'assets/Sounds/Music/Combat/Pufino - Metal Is Trash (freetouse.com).mp3',
        'assets/Sounds/Music/Combat/NewMe.mp3',
        'assets/Sounds/Music/Combat/Buddy.mp3',
        'assets/Sounds/Music/Combat/NoPuedesConmigo.mp3',
        'assets/Sounds/Music/Combat/ImTheBest.mp3'
    ],
    boss: [
        'assets/Sounds/Music/Boss/Horizonte.mp3',
        'assets/Sounds/Music/Boss/Finally.mp3',
        'assets/Sounds/Music/Boss/Punch.mp3'
    ]
};

// Precarga (metadata) de todas las canciones de las 3 categorías (main/combat/boss).
// Solo se pide 'loadedmetadata' (no el archivo entero) para no gastar mucho ancho de
// banda antes de jugar, pero sí confirmar que cada pista es alcanzable.
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
 * ya viven en SFX (rain/wind/sandstorm) en vez de mantener un catálogo paralelo.
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

//# sourceURL=effects.js

/* ================= events.js ================= */
/**
 * SISTEMA DE EVENTOS DINÁMICOS
 * Modular: para agregar un evento nuevo alcanza con sumar una entrada a RANDOM_EVENTS
 * (label + onStart/onUpdate/onDraw) y, si necesita un modificador nuevo, leerlo donde
 * corresponda con un "|| 1" / "|| 0" por defecto, tal como ya hacen los existentes.
 */
// AmbientAudio (lluvia/viento/arena en loop) vive ahora en effects.js: reutiliza las
// mismas claves y rutas locales que el resto de los SFX (SFX.rain/wind/sandstorm) en
// vez de mantener una lista de URLs online separada y duplicada.

// --- Partículas de clima: se dibujan en espacio de pantalla (no del mundo), livianas ---
// Pool fijo (mismo patrón que particles/casings/trails) en vez de crear objetos nuevos en cada spawn
const WEATHER_POOL_SIZE = 400;
let weatherParticles = Array.from({ length: WEATHER_POOL_SIZE }, () => ({ active: false }));
let weatherCursor = 0;
function spawnWeatherParticle(kind, color) {
    // Puramente decorativo (no aporta información de juego, a diferencia de los overlays
    // de visión de niebla/oscuridad): se desactiva por completo en el preset ULTRA.
    if (!game.fxEnabled) return;
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

//# sourceURL=events.js

/* ================= world.js ================= */
/**
 * GENERACIÓN DE TERRENO PROCEDURAL (LIGERO)
 */
function createProceduralTerrain() {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = 512; offCanvas.height = 512;
    const oCtx = offCanvas.getContext('2d');
    
    // Base grass
    oCtx.fillStyle = '#3e4a3d';
    oCtx.fillRect(0, 0, 512, 512);

    // Variaciones de pasto
    for(let i=0; i<300; i++) {
        oCtx.fillStyle = Math.random() > 0.5 ? '#455344' : '#384236';
        oCtx.beginPath();
        oCtx.arc(Math.random()*512, Math.random()*512, Math.random()*15, 0, Math.PI*2);
        oCtx.fill();
    }
    // Zonas de tierra
    for(let i=0; i<15; i++) {
        oCtx.fillStyle = 'rgba(92, 64, 51, 0.15)';
        oCtx.beginPath();
        oCtx.arc(Math.random()*512, Math.random()*512, 20 + Math.random()*40, 0, Math.PI*2);
        oCtx.fill();
    }
    // Piedritas y detalles oscuros
    for(let i=0; i<150; i++) {
        oCtx.fillStyle = Math.random() > 0.5 ? '#2c3e50' : '#1e272e';
        oCtx.globalAlpha = 0.4;
        oCtx.beginPath();
        oCtx.arc(Math.random()*512, Math.random()*512, 1 + Math.random()*2, 0, Math.PI*2);
        oCtx.fill();
    }
    oCtx.globalAlpha = 1;
    return ctx.createPattern(offCanvas, 'repeat');
}
const terrainPattern = createProceduralTerrain();

/**
 * PROPS PROCEDURALES CON COLISIONES Y VARIANTES
 */
class Prop {
    constructor(type) {
        this.type = type;
        this.x = Math.random() * MAP_SIZE;
        this.y = Math.random() * MAP_SIZE;
        this.rot = Math.random() * Math.PI * 2;
        this.scale = 0.8 + Math.random() * 0.5;
        
        // Asignación de radios y solidez según tipo
        if (['rock', 'rock_tall', 'rock_split', 'tree', 'tree_pine', 'tree_dead', 'crate'].includes(type)) {
            this.isSolid = true;
            this.radius = type.includes('tree') ? 15 * this.scale : (type === 'crate' ? 25 * this.scale : 20 * this.scale);
        } else {
            this.isSolid = false;
            this.radius = 0;
        }
    }
    drawShadow(cam) {
        if (!isVisible(this.x, this.y, 40, cam)) return;
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.beginPath();
        ctx.ellipse(this.x - cam.x + 15*this.scale, this.y - cam.y + 10*this.scale, 35*this.scale, 20*this.scale, 0, 0, Math.PI*2);
        ctx.fill();
    }
    draw(cam) {
        if (!isVisible(this.x, this.y, 50 * this.scale, cam)) return;
        ctx.save();
        ctx.translate(this.x - cam.x, this.y - cam.y);
        ctx.rotate(this.rot);
        ctx.scale(this.scale, this.scale);
        
        if (this.type.includes('rock')) {
            ctx.fillStyle = '#7f8c8d'; ctx.strokeStyle = '#2c3e50'; ctx.lineWidth = 2;
            ctx.beginPath(); 
            if (this.type === 'rock_tall') {
                ctx.moveTo(-15, 10); ctx.lineTo(-10, -40); ctx.lineTo(10, -35); ctx.lineTo(15, 10);
            } else if (this.type === 'rock_split') {
                ctx.moveTo(-20, -5); ctx.lineTo(-5, -20); ctx.lineTo(0, 0); ctx.lineTo(15, -15); ctx.lineTo(25, 10); ctx.lineTo(-25, 10);
            } else {
                ctx.moveTo(-20, -10); ctx.lineTo(10, -25); ctx.lineTo(30, 5); ctx.lineTo(10, 20); ctx.lineTo(-25, 10);
            }
            ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.beginPath(); ctx.arc(-5, -5, 10, 0, Math.PI); ctx.fill();
        } 
        else if (this.type.includes('tree')) {
            ctx.fillStyle = '#5c4033'; ctx.strokeStyle = '#3e2723'; ctx.lineWidth = 2;
            ctx.fillRect(-5, -10, 10, 20); ctx.strokeRect(-5, -10, 10, 20);
            if (this.type === 'tree_pine') {
                ctx.fillStyle = '#1e8449'; ctx.strokeStyle = '#145a32';
                ctx.beginPath(); ctx.moveTo(0, -50); ctx.lineTo(-25, 0); ctx.lineTo(25, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0, -30); ctx.lineTo(-30, 15); ctx.lineTo(30, 15); ctx.closePath(); ctx.fill(); ctx.stroke();
            } else if (this.type === 'tree') {
                ctx.fillStyle = '#27ae60'; ctx.strokeStyle = '#1e8449';
                for(let i=0; i<4; i++) {
                    ctx.beginPath(); ctx.arc(Math.cos(i*1.5)*15, -15 + Math.sin(i*1.5)*10, 20, 0, Math.PI*2); ctx.fill(); ctx.stroke();
                }
            } else if (this.type === 'tree_dead') {
                ctx.strokeStyle = '#5c4033'; ctx.lineWidth = 3; ctx.lineCap = 'round';
                ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-15, -30); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(15, -25); ctx.stroke();
            }
        }
        else if (this.type === 'crate') {
            ctx.fillStyle = '#d35400'; ctx.strokeStyle = '#873600'; ctx.lineWidth = 3;
            ctx.fillRect(-20, -20, 40, 40); ctx.strokeRect(-20, -20, 40, 40);
            ctx.beginPath(); ctx.moveTo(-20, -20); ctx.lineTo(20, 20); ctx.moveTo(20, -20); ctx.lineTo(-20, 20); ctx.stroke();
            ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(0, -20, 20, 40);
        } else if (this.type === 'bush') {
            ctx.fillStyle = '#1e8449'; ctx.strokeStyle = '#145a32'; ctx.lineWidth = 2;
            for(let i=0; i<3; i++) {
                ctx.beginPath(); ctx.arc(Math.cos(i*2.1)*10, Math.sin(i*2.1)*10, 15, 0, Math.PI*2);
                ctx.fill(); ctx.stroke();
            }
        } else if (this.type === 'pebbles') {
            ctx.fillStyle = '#95a5a6';
            ctx.beginPath(); ctx.arc(-5, -2, 3, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(5, 3, 2, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(0, 5, 4, 0, Math.PI*2); ctx.fill();
        }
        ctx.restore();
    }
}

// Grid espacial: agrupa props sólidos en celdas para no chequear colisión contra TODOS los props
game.buildPropGrid = function() {
    this.propGridSize = 200;
    this.propGrid = new Map();
    // Array reutilizable devuelto por getNearbyProps: se consume siempre de forma
    // síncrona e inmediata en cada call site, así que evitar crear un array nuevo
    // por cada consulta (jugador + cada enemigo cercano + cada proyectil activo,
    // todos los frames) reduce mucho la basura generada para el Garbage Collector.
    this._nearbyPropsScratch = [];
    this.props.forEach(p => {
        if (!p.isSolid) return;
        const key = this.propGridKey(p.x, p.y);
        if (!this.propGrid.has(key)) this.propGrid.set(key, []);
        this.propGrid.get(key).push(p);
    });
};
game.propGridKey = function(x, y) {
    // Clave numérica en vez de template string: mismo resultado (una celda = una
    // clave única), pero sin la asignación de memoria que implica construir un
    // string nuevo en cada llamada (se llama muchas veces por frame).
    return Math.floor(x / this.propGridSize) * 100000 + Math.floor(y / this.propGridSize);
};
// Devuelve solo los props sólidos cercanos (celda actual + 8 vecinas)
game.getNearbyProps = function(x, y) {
    const gx = Math.floor(x / this.propGridSize);
    const gy = Math.floor(y / this.propGridSize);
    const result = this._nearbyPropsScratch;
    result.length = 0;
    for(let dx=-1; dx<=1; dx++) {
        for(let dy=-1; dy<=1; dy++) {
            const arr = this.propGrid.get((gx+dx) * 100000 + (gy+dy));
            if(arr) for(let i=0; i<arr.length; i++) result.push(arr[i]);
        }
    }
    return result;
};

const WEAPON_COSTS = {
    REVOLVER: 500, MACHETE: 400, UZI: 600, CROSSBOW: 700, SHOTGUN: 1000, AK47: 1800, MINIGUN: 2500, SNIPER: 2200,
    MP5: 900, P90: 1300, SAWEDOFF: 1100, AA12: 2000, M4A1: 1600, FAMAS: 1500, SCAR: 2100, WINCHESTER: 1400,
    AWP: 3200, M249: 2600, RPG: 3500, FLAMETHROWER: 2400, CHAINSAW: 1700
};

game.startNextWave = function() {
    document.getElementById('shop-menu').style.display = 'none';
    const eventKey = EventManager.roll();
    if (eventKey) {
        EventManager.showAlert(eventKey, () => {
            EventManager.activate(eventKey);
            this._launchWave();
        });
    } else {
        this._launchWave();
    }
};

game._launchWave = function() {
    this.isWaveActive = true;
    this.paused = false;
    MusicManager.tracks = MusicManager.combatTracks;
    MusicManager.next(1200);
    
    let count = 15 + (this.wave * 8);
    if (this.activeEvent === 'INVASION') count *= 2; // el doble de enemigos durante la invasión
    for(let i=0; i<count; i++) {
        let a = Math.random() * Math.PI * 2;
        let d = 800 + Math.random() * 600;
        let type = this.wave > 6 && Math.random() > 0.85 ? 'GHOST' : (this.wave > 4 && Math.random() > 0.85 ? 'INVISIBLE' : (this.wave > 3 && Math.random() > 0.85 ? 'KAMIKAZE' : (this.wave > 3 && Math.random() > 0.8 ? 'TANK' : (this.wave > 2 && Math.random() > 0.7 ? 'RANGED' : (this.wave > 1 && Math.random() > 0.8 ? 'FAST' : 'BASIC')))));
        let pos = this.findClearSpawn(this.player.x + Math.cos(a)*d, this.player.y + Math.sin(a)*d);
        this.enemies.push(new Enemy(pos.x, pos.y, type));
    }

    // Configurar si aparecerá un jefe en base a la wave
    if (this.wave === 5 || this.wave === 15 || this.wave === 30 || (this.wave > 30 && (this.wave - 30) % 10 === 0)) {
        this.bossPending = true;
    } else {
        this.bossPending = false;
    }
};

game.spawnBoss = function() {
    let a = Math.random() * Math.PI * 2;
    let bossPos = this.findClearSpawn(this.player.x + Math.cos(a)*800, this.player.y + Math.sin(a)*800);
    this.enemies.push(new Enemy(bossPos.x, bossPos.y, 'BOSS'));
    MusicManager.switchContext(MusicManager.bossTracks, 1000);
};

game.findClearSpawn = function(x, y) {
    for(let attempt = 0; attempt < 8; attempt++) {
        let blocked = this.props.some(p => p.isSolid && Math.hypot(x - p.x, y - p.y) < p.radius + 45);
        if(!blocked) return { x, y };
        x += (Math.random() - 0.5) * 200;
        y += (Math.random() - 0.5) * 200;
    }
    return { x, y };
};

// Economía
game.buyAmmo = function() {
    if(this.player.money >= 150) {
        this.player.money -= 150;
        this.player.inventory.forEach(w => { if(w && w.type === 'range') w.ammo = w.capacity; });
        playSFX('reload');
    }
};

game.buyHealth = function() {
    if(this.player.money >= 200 && this.player.hp < this.player.maxHp) {
        this.player.money -= 200; this.player.hp = this.player.maxHp;
        playSFX('coin');
    }
};

game.buyWeapon = function(k) {
    const w = WEAPONS_DB[k];
    const cost = WEAPON_COSTS[k];
    if(this.player.money >= cost) {
        let slot = this.player.inventory.findIndex(s => s === null);
        if(slot !== -1) {
            this.player.money -= cost;
            this.player.inventory[slot] = { ...w, ammo: w.capacity };
            playSFX('reload');
            this.updateShop();
        }
    }
};

game.sellWeapon = function(k) {
    let idx = this.player.inventory.findIndex(i => i && i.name === k);
    if(idx === -1) return;
    const refund = Math.floor(WEAPON_COSTS[k] / 2);
    this.player.money += refund;
    this.player.inventory[idx] = null;
    if(this.player.activeSlot === idx) {
        let fallback = this.player.inventory.findIndex(s => s !== null);
        this.player.activeSlot = fallback !== -1 ? fallback : 0;
    }
    playSFX('coin');
    this.updateShop();
};

//# sourceURL=world.js

/* ================= weapons.js ================= */
/**
 * CONFIGURACIÓN DE ARMAS
 * (Extraído de player.js por organización. Mismo objeto WEAPONS_DB de siempre,
 * ningún valor fue modificado.)
 */
const WEAPONS_DB = {
    // --- MELÉ ---
    KNIFE:    { name: 'KNIFE', damage: 60, fireRate: 250, capacity: Infinity, reloadTime: 0, speed: 5, range: 65, type: 'melee', color: '#bdc3c7', shake: 2, spread: 0 },
    MACHETE:  { name: 'MACHETE', damage: 100, fireRate: 320, capacity: Infinity, reloadTime: 0, speed: 5, range: 95, type: 'melee', color: '#ecf0f1', shake: 4, spread: 0 },
    CHAINSAW: { name: 'CHAINSAW', damage: 9, fireRate: 90, capacity: Infinity, reloadTime: 0, speed: 5, range: 65, type: 'melee', color: '#7f8c8d', shake: 3, spread: 0, fuel: 100, fuelDrain: 2.2, sfx: 'chainsaw' },
    // --- PISTOLAS ---
    G18:      { name: 'G18', damage: 25, fireRate: 200, capacity: 15, reloadTime: 1000, speed: 18, type: 'range', color: '#f1c40f', shake: 3, spread: 0.05, casing: true, smoke: 1, sfx: 'shoot_G18' },
    REVOLVER: { name: 'REVOLVER', damage: 45, fireRate: 500, capacity: 6, reloadTime: 1400, speed: 22, type: 'range', color: '#95a5a6', shake: 5, spread: 0.03, casing: true, smoke: 1, sfx: 'shoot_G18', pierce: 3 },
    // --- SUBFUSILES ---
    UZI:      { name: 'UZI', damage: 15, fireRate: 70, capacity: 40, reloadTime: 1500, speed: 20, type: 'range', color: '#e67e22', shake: 4, spread: 0.15, casing: true, smoke: 2, sfx: 'shoot_G18' },
    MP5:      { name: 'MP5', damage: 22, fireRate: 110, capacity: 30, reloadTime: 1400, speed: 22, type: 'range', color: '#7f8c8d', shake: 2, spread: 0.025, casing: true, smoke: 1, sfx: 'shoot_G18' },
    P90:      { name: 'P90', damage: 18, fireRate: 90, capacity: 50, reloadTime: 1700, speed: 21, type: 'range', color: '#9b59b6', shake: 3, spread: 0.06, casing: true, smoke: 1, sfx: 'shoot_G18', mobility: true },
    // --- ESCOPETAS ---
    SHOTGUN:  { name: 'SHOTGUN', damage: 20, fireRate: 900, capacity: 7, reloadTime: 2200, speed: 15, type: 'range', pellets: 8, color: '#e74c3c', shake: 15, spread: 0.22, casing: true, smoke: 5, sfx: 'shoot_SHOTGUN', knockback: 220 },
    SAWEDOFF: { name: 'SAWEDOFF', damage: 35, fireRate: 1100, capacity: 2, reloadTime: 1800, speed: 14, type: 'range', pellets: 10, color: '#c0392b', shake: 18, spread: 0.35, casing: true, smoke: 6, sfx: 'shoot_SHOTGUN', maxRange: 260, knockback: 260 },
    AA12:     { name: 'AA12', damage: 18, fireRate: 220, capacity: 20, reloadTime: 2200, speed: 15, type: 'range', pellets: 6, color: '#e67e22', shake: 10, spread: 0.2, casing: true, smoke: 3, sfx: 'shoot_SHOTGUN', knockback: 100 },
    // --- RIFLES ---
    AK47:     { name: 'AK47', damage: 40, fireRate: 140, capacity: 30, reloadTime: 1800, speed: 24, type: 'range', color: '#27ae60', shake: 6, spread: 0.08, casing: true, smoke: 3, sfx: 'shoot_G18' },
    M4A1:     { name: 'M4A1', damage: 32, fireRate: 160, capacity: 30, reloadTime: 1600, speed: 23, type: 'range', color: '#2ecc71', shake: 3, spread: 0.015, casing: true, smoke: 2, sfx: 'shoot_G18' },
    FAMAS:    { name: 'FAMAS', damage: 28, fireRate: 550, capacity: 24, reloadTime: 1700, speed: 23, type: 'range', color: '#3498db', shake: 5, spread: 0.04, casing: true, smoke: 2, sfx: 'shoot_G18', burst: 3, burstDelay: 65 },
    SCAR:     { name: 'SCAR', damage: 55, fireRate: 450, capacity: 20, reloadTime: 1900, speed: 25, type: 'range', color: '#16a085', shake: 8, spread: 0.03, casing: true, smoke: 2, sfx: 'shoot_G18' },
    // --- PRECISIÓN ---
    WINCHESTER: { name: 'WINCHESTER', damage: 130, fireRate: 900, capacity: 8, reloadTime: 450, speed: 30, type: 'range', color: '#8e5a2d', shake: 10, spread: 0.01, casing: true, smoke: 2, sfx: 'shoot_G18', singleReload: true },
    AWP:      { name: 'AWP', damage: 260, fireRate: 1700, capacity: 5, reloadTime: 2600, speed: 38, type: 'range', color: '#34495e', shake: 22, spread: 0, casing: true, smoke: 2, sfx: 'shoot_G18', pierce: 4 },
    SNIPER:   { name: 'SNIPER', damage: 220, fireRate: 1500, capacity: 5, reloadTime: 2500, speed: 35, type: 'range', color: '#34495e', shake: 20, spread: 0, casing: true, smoke: 2, sfx: 'shoot_G18' },
    // --- PESADAS ---
    M249:     { name: 'M249', damage: 24, fireRate: 90, capacity: 150, reloadTime: 4000, speed: 22, type: 'range', color: '#556b2f', shake: 5, spread: 0.12, casing: true, smoke: 3, sfx: 'shoot_G18' },
    MINIGUN:  { name: 'MINIGUN', damage: 20, fireRate: 50, capacity: 100, reloadTime: 3000, speed: 22, type: 'range', color: '#c0392b', shake: 8, spread: 0.2, casing: true, smoke: 3, sfx: 'shoot_G18', spinup: true },
    // --- ESPECIALES ---
    RPG:      { name: 'RPG', damage: 85, fireRate: 1400, capacity: 1, reloadTime: 2400, speed: 16, type: 'range', color: '#e67e22', shake: 25, spread: 0, casing: false, smoke: 4, sfx: 'shoot_SHOTGUN', explosive: true, explosionRadius: 140 },
    FLAMETHROWER: { name: 'FLAMETHROWER', damage: 4, fireRate: 45, capacity: 120, reloadTime: 2200, speed: 12, type: 'range', color: '#ff8800', shake: 2, spread: 0.15, casing: false, smoke: 2, sfx: 'flamethrower', maxRange: 260, burn: true, pierce: 2 },
    CROSSBOW: { name: 'CROSSBOW', damage: 90, fireRate: 700, capacity: 1, reloadTime: 1200, speed: 26, type: 'range', color: '#16a085', shake: 4, spread: 0, casing: false, smoke: 0, sfx: 'shoot_G18' }
};

// Posiciones del destello de boca por arma (antes se creaba este objeto literal
// en cada frame dentro de Player.draw; movido acá como constante fija para no
// generar basura/garbage collection en cada disparo).
const WEAPON_MUZZLE_X = { AK47: 45, SHOTGUN: 40, SNIPER: 48, MINIGUN: 30, REVOLVER: 20, CROSSBOW: 15,
    MP5: 26, P90: 29, SAWEDOFF: 20, AA12: 25, M4A1: 42, FAMAS: 32, SCAR: 24, WINCHESTER: 45,
    AWP: 50, M249: 30, RPG: 66, FLAMETHROWER: 35, CHAINSAW: 28 };

//# sourceURL=weapons.js

/* ================= player.js ================= */
/**
 * La base de datos de armas (WEAPONS_DB) y la tabla de posiciones de destello de
 * boca (WEAPON_MUZZLE_X) ahora viven en weapons.js, que se carga antes que este
 * archivo. Nada cambia en tiempo de ejecución: siguen siendo variables globales
 * con exactamente los mismos valores.
 */

// Regeneración/consumo de stamina precalculados una sola vez (antes se hacían
// las mismas divisiones "15/60" y "30/60" en cada frame dentro de update()).
const STAMINA_REGEN_PER_FRAME = 15 / 60;
const SPRINT_STAMINA_DRAIN_PER_FRAME = 30 / 60;

class Player {
    constructor() {
        this.x = MAP_SIZE / 2; this.y = MAP_SIZE / 2;
        this.radius = 24; this.hp = 100; this.maxHp = 100;
        this.money = 0;
        this.inventory = [ { ...WEAPONS_DB.G18, ammo: 15 }, { ...WEAPONS_DB.KNIFE }, null, null, null ];
        this.activeSlot = 0; this.isReloading = false;
        this.tick = 0; this.recoilOffset = 0;
        this.muzzleFlash = 0;
        this.chainsawFuel = 100; this.chainsawActive = false; // CHAINSAW: combustible de uso continuo
        this.minigunSpin = 0; // MINIGUN: 0 = frío, 1 = a máxima velocidad
        this.burstBusy = false; // FAMAS: evita reiniciar una ráfaga en curso

        // Dash y Stamina
        this.stamina = 100; this.maxStamina = 100;
        this.isDashing = false; this.dashTimer = 0; this.dashCooldownTimer = 0;
        this.dashDirX = 0; this.dashDirY = 0;
        
        // Efecto interno gelatinoso
        this.bubbles = Array.from({length: 5}, () => ({
            x: (Math.random()-0.5)*20, y: (Math.random()-0.5)*20, s: 2 + Math.random()*4, offset: Math.random()*Math.PI*2
        }));
    }
    get weapon() { return this.inventory[this.activeSlot]; }

    takeDamage(amt) {
        this.hp = Math.max(0, this.hp - amt);
        game.camera.shake = 10;
        document.getElementById('damage-overlay').style.opacity = "1";
        setTimeout(() => document.getElementById('damage-overlay').style.opacity = "0", 150);
        if(this.hp <= 0) { playSFX('muerte_player', 0.6); game.gameOver(); }
    }

    dash() {
        if(this.dashCooldownTimer > 0 || this.isDashing || this.stamina < 20) return;
        this.stamina -= 20;

        let dx = 0, dy = 0;
        if(game.keys['KeyW']) dy -= 1; if(game.keys['KeyS']) dy += 1;
        if(game.keys['KeyA']) dx -= 1; if(game.keys['KeyD']) dx += 1;
        if(dx === 0 && dy === 0) {
            let angle = Math.atan2(game.mouse.y - (this.y - game.camera.y), game.mouse.x - (this.x - game.camera.x));
            dx = Math.cos(angle); dy = Math.sin(angle);
        } else {
            const len = Math.hypot(dx, dy);
            dx /= len; dy /= len;
        }

        this.dashDirX = dx; this.dashDirY = dy;
        this.isDashing = true;
        this.dashTimer = 8;        // ~0.13s de dash a 60fps
        this.dashCooldownTimer = 45; // ~0.75s de cooldown
        game.camera.shake = 4;
        playSFX('reload', 0.15, 0.4); 
        for(let i=0; i<Math.ceil(10*game.particleScale); i++) game.spawnParticle(this.x, this.y, '#a8e6cf', 3, 3, 'normal');
    }

    update(keys) {
        if(this.dashCooldownTimer > 0) this.dashCooldownTimer--;

        // Regeneración de stamina (15 por segundo)
        this.stamina = Math.min(this.maxStamina, this.stamina + STAMINA_REGEN_PER_FRAME);

        let speedMultiplier = (game.playerSpeedMult || 1);
        if ((keys['ShiftLeft'] || keys['ShiftRight']) && this.stamina > 0.5 && !this.isDashing) {
            speedMultiplier = 1.6 * (game.playerSpeedMult || 1);
            this.stamina -= SPRINT_STAMINA_DRAIN_PER_FRAME; // Gasto por sprintar
        }
        if (this.weapon && this.weapon.mobility) speedMultiplier *= 1.15; // P90: gran movilidad

        if (this.weapon && this.weapon.spinup) { // MINIGUN: rampa de velocidad de disparo
            if (game.mouse.down && !this.isReloading) this.minigunSpin = Math.min(1, this.minigunSpin + 0.02);
            else this.minigunSpin = Math.max(0, this.minigunSpin - 0.015);
        } else if (this.minigunSpin > 0) this.minigunSpin = Math.max(0, this.minigunSpin - 0.03);

        if (this.weapon && this.weapon.fuel !== undefined) { // CHAINSAW: regenera combustible si no está cortando
            if (!this.chainsawActive) this.chainsawFuel = Math.min(this.weapon.fuel, this.chainsawFuel + 0.8);
        }
        this.chainsawActive = false; // se vuelve a marcar true en game.shoot si efectivamente corta este frame

        let vx = 0, vy = 0;
        if(this.isDashing) {
            vx = this.dashDirX * 18; vy = this.dashDirY * 18;
            if(Math.random() > 0.3) game.spawnTrail(this.x, this.y, this.radius * 0.9);
            this.dashTimer--;
            if(this.dashTimer <= 0) this.isDashing = false;
        } else {
            if(keys['KeyW']) vy = -5 * speedMultiplier; if(keys['KeyS']) vy = 5 * speedMultiplier;
            if(keys['KeyA']) vx = -5 * speedMultiplier; if(keys['KeyD']) vx = 5 * speedMultiplier;
            if(vx !== 0 && vy !== 0) { vx *= 0.707; vy *= 0.707; }
        }

        if(vx !== 0 || vy !== 0) {
            this.tick += 0.3;
            if(Math.random() > 0.9) game.spawnParticle(this.x, this.y + this.radius, '#555', 1, 2, 'smoke');
            if(Math.random() > 0.7) game.spawnTrail(this.x, this.y, this.radius * 0.8);
        }
        
        this.x = Math.max(this.radius, Math.min(MAP_SIZE-this.radius, this.x + vx));
        this.y = Math.max(this.radius, Math.min(MAP_SIZE-this.radius, this.y + vy));
        
        if(this.recoilOffset > 0) this.recoilOffset = Math.max(0, this.recoilOffset - 2);
        if(this.muzzleFlash > 0) this.muzzleFlash--;
    }

    draw(cam, mouse) {
        let moving = (game.keys['KeyW'] || game.keys['KeyS'] || game.keys['KeyA'] || game.keys['KeyD']);
        const bounce = moving ? Math.abs(Math.sin(this.tick)) * 6 : 0;
        const stretchX = moving ? 1 - Math.abs(Math.cos(this.tick)) * 0.15 : 1 + (this.recoilOffset*0.02);
        const stretchY = moving ? 1 + Math.abs(Math.cos(this.tick)) * 0.15 : 1 - (this.recoilOffset*0.02);
        
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.beginPath(); ctx.ellipse(this.x - cam.x, this.y - cam.y + 12, 30, 10, 0, 0, Math.PI*2); ctx.fill();

        ctx.save();
        ctx.translate(this.x - cam.x, this.y - cam.y - bounce);
        ctx.scale(stretchX, stretchY); 
        
        ctx.globalAlpha = 0.9;
        let grad = ctx.createRadialGradient(-5, -10, 0, 0, 0, this.radius);
        grad.addColorStop(0, '#a8e6cf'); grad.addColorStop(0.7, '#3b7a57'); grad.addColorStop(1, '#2c3e50');
        ctx.fillStyle = grad; ctx.strokeStyle = '#1e382b'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, this.radius, 0, Math.PI*2); ctx.fill(); ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        this.bubbles.forEach(b => {
            let by = b.y + Math.sin(this.tick * 0.5 + b.offset) * 3;
            ctx.beginPath(); ctx.arc(b.x, by, b.s, 0, Math.PI*2); ctx.fill();
        });

        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(0, 0, this.radius - 6, Math.PI + 0.5, Math.PI * 1.5 - 0.5); ctx.stroke();

        ctx.globalAlpha = 1;

        let angle = Math.atan2(mouse.y - (this.y - cam.y), mouse.x - (this.x - cam.x));
        let eyeOffsetX = Math.cos(angle) * 6; let eyeOffsetY = Math.sin(angle) * 6;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(-8 + eyeOffsetX, -4 + eyeOffsetY, 7, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(8 + eyeOffsetX, -4 + eyeOffsetY, 7, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(-8 + eyeOffsetX + Math.cos(angle)*3, -4 + eyeOffsetY + Math.sin(angle)*3, 3.5, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(8 + eyeOffsetX + Math.cos(angle)*3, -4 + eyeOffsetY + Math.sin(angle)*3, 3.5, 0, Math.PI*2); ctx.fill();

        if(this.weapon) {
            ctx.rotate(angle);
            ctx.translate(this.radius - 5, 0); 
            ctx.translate(-this.recoilOffset, 0); 
            
            // Sombra proyectada del arma: puramente cosmética/postprocesado, se apaga en ULTRA
            if (game.fxEnabled) { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 3; }
            
            if (this.weapon.name === 'AK47') {
                ctx.fillStyle = '#873600'; ctx.fillRect(-10, -3, 15, 6); 
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(5, -4, 20, 8); 
                ctx.fillStyle = '#34495e'; ctx.beginPath(); ctx.moveTo(15, 4); ctx.lineTo(10, 15); ctx.lineTo(20, 15); ctx.lineTo(25, 4); ctx.fill(); 
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(25, -2, 20, 4); 
                ctx.fillStyle = '#bdc3c7'; ctx.fillRect(35, -4, 2, 2); 
            } else if (this.weapon.name === 'SHOTGUN') {
                ctx.fillStyle = '#5c4033'; ctx.fillRect(-5, -4, 15, 8); 
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(10, -4, 30, 8); 
                ctx.fillStyle = '#111'; ctx.fillRect(10, -1, 30, 2); 
                ctx.fillStyle = '#873600'; ctx.fillRect(15, 4, 15, 5); 
            } else if (this.weapon.name === 'UZI') {
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(0, -5, 20, 10);
                ctx.fillStyle = '#34495e'; ctx.fillRect(5, 5, 8, 14); 
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(20, -2, 8, 4); 
            } else if (this.weapon.name === 'G18') {
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(0, -4, 15, 8);
                ctx.fillStyle = '#34495e'; ctx.fillRect(2, 4, 6, 8);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(15, -3, 5, 4); 
            } else if (this.weapon.name === 'REVOLVER') {
                ctx.fillStyle = '#5c4033'; ctx.fillRect(-6, -3, 10, 8); 
                ctx.fillStyle = '#7f8c8d'; ctx.beginPath(); ctx.arc(4, 0, 6, 0, Math.PI*2); ctx.fill(); 
                ctx.fillStyle = '#95a5a6'; ctx.fillRect(8, -3, 16, 6); 
            } else if (this.weapon.name === 'SNIPER') {
                ctx.fillStyle = '#34495e'; ctx.fillRect(-10, -3, 50, 6); 
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(-5, -9, 15, 5); 
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(5, -12, 3, 8); 
            } else if (this.weapon.name === 'MINIGUN') {
                ctx.fillStyle = '#c0392b'; ctx.fillRect(-8, -6, 15, 12); 
                ctx.fillStyle = '#2c3e50';
                for(let i=0; i<4; i++) ctx.fillRect(8, -6 + i*3, 22, 2); 
            } else if (this.weapon.name === 'CROSSBOW') {
                ctx.strokeStyle = '#16a085'; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.moveTo(5,-14); ctx.lineTo(15,0); ctx.lineTo(5,14); ctx.stroke(); 
                ctx.fillStyle = '#5c4033'; ctx.fillRect(-5, -2, 20, 4); 
            } else if (this.weapon.name === 'MP5') {
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(0, -4, 26, 8);
                ctx.fillStyle = '#34495e'; ctx.fillRect(4, 4, 6, 12);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(26, -2, 8, 4);
            } else if (this.weapon.name === 'P90') {
                ctx.fillStyle = '#8e44ad'; ctx.fillRect(-5, -6, 34, 10);
                ctx.fillStyle = '#5e3370'; ctx.fillRect(2, -12, 18, 8);
                ctx.fillStyle = '#34495e'; ctx.fillRect(29, -3, 6, 5);
            } else if (this.weapon.name === 'SAWEDOFF') {
                ctx.fillStyle = '#5c4033'; ctx.fillRect(-8, -4, 14, 8);
                ctx.fillStyle = '#111'; ctx.fillRect(6, -5, 14, 5); ctx.fillRect(6, 1, 14, 4);
            } else if (this.weapon.name === 'AA12') {
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(-5, -5, 30, 10);
                ctx.fillStyle = '#111'; ctx.fillRect(25, -3, 10, 6);
                ctx.fillStyle = '#7f8c8d'; ctx.beginPath(); ctx.arc(0, 8, 6, 0, Math.PI*2); ctx.fill();
            } else if (this.weapon.name === 'M4A1') {
                ctx.fillStyle = '#2ecc71'; ctx.fillRect(0, -4, 20, 8);
                ctx.fillStyle = '#1e8449'; ctx.fillRect(-8, 4, 6, 12);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(20, -3, 22, 4);
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(5, -10, 12, 6);
            } else if (this.weapon.name === 'FAMAS') {
                ctx.fillStyle = '#3498db'; ctx.fillRect(-8, -6, 40, 10);
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(30, -4, 12, 4);
                ctx.fillStyle = '#1a5276'; ctx.fillRect(-8, -12, 14, 6);
            } else if (this.weapon.name === 'SCAR') {
                ctx.fillStyle = '#16a085'; ctx.fillRect(0, -5, 24, 9);
                ctx.fillStyle = '#0e6655'; ctx.fillRect(-9, 3, 7, 13);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(24, -3, 20, 4);
            } else if (this.weapon.name === 'WINCHESTER') {
                ctx.fillStyle = '#8e5a2d'; ctx.fillRect(-10, -3, 55, 6);
                ctx.fillStyle = '#5c4033'; ctx.fillRect(-14, 2, 10, 10);
                ctx.fillStyle = '#c9a86a'; ctx.fillRect(0, -6, 30, 3);
            } else if (this.weapon.name === 'AWP') {
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(-10, -4, 60, 7);
                ctx.fillStyle = '#1a252f'; ctx.fillRect(-6, -11, 18, 6);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(8, -14, 3, 9);
                ctx.fillStyle = '#34495e'; ctx.fillRect(-14, 1, 8, 12);
            } else if (this.weapon.name === 'M249') {
                ctx.fillStyle = '#556b2f'; ctx.fillRect(-5, -6, 30, 12);
                ctx.fillStyle = '#3e4f22'; ctx.beginPath(); ctx.arc(-2, 10, 10, 0, Math.PI*2); ctx.fill();
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(30, -3, 22, 4);
            } else if (this.weapon.name === 'RPG') {
                ctx.fillStyle = '#5c4a1a'; ctx.fillRect(-10, -7, 60, 14);
                ctx.fillStyle = '#2c3e50'; ctx.beginPath(); ctx.moveTo(50, -7); ctx.lineTo(66, 0); ctx.lineTo(50, 7); ctx.fill();
                ctx.fillStyle = '#e67e22'; ctx.fillRect(2, -4, 8, 8);
            } else if (this.weapon.name === 'FLAMETHROWER') {
                ctx.fillStyle = '#7f2b0a'; ctx.fillRect(-5, -6, 40, 12);
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(-10, 2, 12, 16);
                ctx.fillStyle = '#ff8800'; ctx.fillRect(35, -3, 10, 6);
            } else if (this.weapon.name === 'CHAINSAW') {
                ctx.fillStyle = '#e67e22'; ctx.fillRect(-6, -6, 18, 14);
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(10, -4, 34, 8);
                ctx.strokeStyle = '#bdc3c7'; ctx.lineWidth = 2;
                for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(12 + i*5, -4); ctx.lineTo(12 + i*5, 4); ctx.stroke(); }
            } else if (this.weapon.type === 'melee') {
                ctx.fillStyle = '#873600'; ctx.fillRect(0, -3, 10, 6); 
                ctx.fillStyle = '#bdc3c7'; ctx.beginPath(); ctx.moveTo(10, -2); ctx.lineTo(30, 0); ctx.lineTo(10, 2); ctx.fill(); 
                ctx.fillStyle = '#ecf0f1'; ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(28, 0); ctx.lineTo(10, 1); ctx.fill(); 
            } else {
                // Fallback genérico: cualquier arma de fuego futura sin modelo propio no queda invisible
                ctx.fillStyle = this.weapon.color; ctx.fillRect(0, -4, 22, 8);
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(-6, 3, 6, 10);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(22, -2, 10, 4);
            }
            
            ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetY = 0;

            // Destello de boca/glow: efecto puramente cosmético, se apaga por completo en ULTRA
            if (game.fxEnabled && this.muzzleFlash > 0 && this.weapon.type === 'range') {
                ctx.fillStyle = '#f1c40f';
                ctx.globalAlpha = 0.9;
                ctx.beginPath();
                let mX = WEAPON_MUZZLE_X[this.weapon.name] ?? 25;
                ctx.arc(mX, 0, 12 + Math.random()*15, 0, Math.PI*2);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.beginPath(); ctx.arc(mX, 0, 6 + Math.random()*5, 0, Math.PI*2); ctx.fill();
                ctx.globalAlpha = 1;
            }
        }
        ctx.restore();

        // Barra de Stamina
        ctx.fillStyle = 'rgba(0,0,0,0.8)'; 
        ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 10, 40, 5);
        ctx.fillStyle = '#3498db'; 
        ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 10, 40 * (this.stamina/this.maxStamina), 5);

        // Barra secundaria: combustible de la Chainsaw o rampa de la Minigun
        if (this.weapon && this.weapon.fuel !== undefined) {
            ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40, 4);
            ctx.fillStyle = this.chainsawFuel < 25 ? '#e74c3c' : '#f39c12';
            ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40 * (this.chainsawFuel/this.weapon.fuel), 4);
        } else if (this.weapon && this.weapon.spinup) {
            ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40, 4);
            ctx.fillStyle = '#c0392b';
            ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40 * this.minigunSpin, 4);
        }
    }
}

game.reload = function() {
    let w = this.player.weapon;
    if(!w || w.type === 'melee' || this.player.isReloading || w.ammo === w.capacity) return;
    this.player.isReloading = true;
    playSFX('reload');
    if (w.singleReload) { // WINCHESTER: carga bala por bala, se puede interrumpir cambiando de arma
        const step = () => {
            if (this.player.weapon !== w) { this.player.isReloading = false; return; } // cambiaron de arma
            w.ammo = Math.min(w.capacity, w.ammo + 1);
            playSFX('reload', 0.25);
            if (w.ammo < w.capacity) setTimeout(step, w.reloadTime);
            else this.player.isReloading = false;
        };
        setTimeout(step, w.reloadTime);
    } else {
        setTimeout(() => { w.ammo = w.capacity; this.player.isReloading = false; }, w.reloadTime);
    }
};

game.shoot = function() {
    let w = this.player.weapon;
    if(!w || this.player.isReloading) return;
    if (w.fuel !== undefined && this.player.chainsawFuel <= 0) return; // CHAINSAW sin combustible

    let effFireRate = w.fireRate * (game.weaponFireRateMult || 1);
    if (w.spinup) effFireRate *= (1.8 - this.player.minigunSpin * 1.3); // MINIGUN: arranca lenta, acelera con el spin
    if (Date.now() - this.lastShot < effFireRate) return;

    if(w.type === 'melee') {
        // Rastrea si el swing efectivamente conecta con algún enemigo, para elegir
        // el sonido correcto (motor girando en el aire vs. sonido de impacto)
        let hitSomething = false;
        this.enemies.forEach(e => {
            if(!e.invulnerable && Math.hypot(this.player.x - e.x, this.player.y - e.y) < w.range + e.radius) {
                this.hitEnemy(e, w.damage);
                hitSomething = true;
            }
        });
        if (w.fuel !== undefined) { // CHAINSAW: consume combustible mientras corta
            this.player.chainsawFuel = Math.max(0, this.player.chainsawFuel - w.fuelDrain);
            this.player.chainsawActive = true;
            // CHAINSAW = motor girando en el aire, CHAINSAWHIT = conectando con un enemigo
            playSFX(hitSomething ? 'chainsaw_hit' : 'chainsaw', 0.2, 0.05);
        } else {
            // Sonido melee aleatorio para knife/machete
            const meleeVariants = ['melee', 'melee2', 'melee3'];
            playSFX(meleeVariants[Math.floor(Math.random() * meleeVariants.length)], 0.3, 0.1);
        }
        this.lastShot = Date.now();
        return;
    }

    if (w.ammo <= 0) { this.reload(); return; }
    if (w.burst && this.player.burstBusy) return; // FAMAS: ya hay una ráfaga en curso

    const fireOnce = () => {
        // Usar sonido específico del arma, con fallback inteligente
        let soundKey = w.sfx || 'shoot_G18';
        if (soundKey === 'shoot_G18' && w.name === 'REVOLVER') soundKey = 'shoot_revolver';
        else if (soundKey === 'shoot_G18' && ['AK47', 'M4A1', 'FAMAS', 'SCAR'].includes(w.name)) soundKey = 'shoot_rifle';
        else if (soundKey === 'shoot_G18' && ['UZI', 'MP5', 'P90'].includes(w.name)) soundKey = 'shoot_smg';
        else if (soundKey === 'shoot_G18' && ['SNIPER', 'AWP'].includes(w.name)) soundKey = 'shoot_sniper';
        else if (soundKey === 'shoot_G18' && w.name === 'WINCHESTER') soundKey = 'shoot_sniper2';
        
        playSFX(soundKey, 0.4, 0.2);
        this.player.recoilOffset = w.shake * 2;
        this.player.muzzleFlash = 3;
        this.camera.shake = w.shake;

        let angle = Math.atan2(this.mouse.y - (this.player.y - this.camera.y), this.mouse.x - (this.player.x - this.camera.x));

        if(w.casing) this.spawnCasing(this.player.x, this.player.y, angle);
        if(w.smoke) {
            for(let i=0; i<w.smoke; i++) this.spawnParticle(this.player.x + Math.cos(angle)*30, this.player.y + Math.sin(angle)*30, w.name === 'FLAMETHROWER' ? '#ff8800' : '#bdc3c7', 2, 3, 'smoke');
        }

        if(w.pellets) {
            for(let i=0; i<w.pellets; i++) this.spawnProjectile(this.player.x, this.player.y, angle + (Math.random()-0.5)*(w.spread + (game.weaponSpreadBonus || 0)), w);
        } else {
            let s = (Math.random()-0.5) * (w.spread + (game.weaponSpreadBonus || 0));
            this.spawnProjectile(this.player.x, this.player.y, angle + s, w);
        }
        w.ammo--;
    };

    if (w.burst) { // FAMAS: dispara 3 tiros encadenados aunque el jugador haya soltado el click
        this.player.burstBusy = true;
        let shots = 0;
        const nextShot = () => {
            if (w.ammo <= 0 || shots >= w.burst) { this.player.burstBusy = false; return; }
            fireOnce(); shots++;
            if (shots < w.burst && w.ammo > 0) setTimeout(nextShot, w.burstDelay);
            else this.player.burstBusy = false;
        };
        nextShot();
    } else {
        fireOnce();
    }
    this.lastShot = Date.now();
};

game.hitEnemy = function(e, dmg) {
    e.hp -= dmg;
    e.flash = 4;
    // Sin sonido genérico de "hit" acá: cada arma ya reproduce su propio sonido
    // (disparo o swing/chainsaw) en el momento del ataque. Antes esto reutilizaba
    // el sonido de melee (MEELE.mp3) para CUALQUIER impacto, incluyendo balas,
    // por eso se escuchaba el "golpe de cuchillo" al disparar armas de fuego.
    for(let i=0; i<Math.ceil(8*this.particleScale); i++) this.spawnParticle(e.x, e.y, e.color, 4, 3, 'normal'); 
    
    let t = this.floatingTexts.find(t => !t.active);
    if(!t) { t = new FloatingText(); this.floatingTexts.push(t); }
    t.init(e.x, e.y, Math.floor(dmg), '#fff', 20);

    if(e.hp <= 0 && !e.isDying) {
        e.isDying = true;
        playSFX('death', 0.5);
        const REWARDS = { BOSS: 1000, TANK: 80, RANGED: 45, FAST: 25, BASIC: 30, INVISIBLE: 35, KAMIKAZE: 20, GHOST: 45 };
        let reward = Math.floor((REWARDS[e.type] ?? 30) * (game.moneyMult || 1));
        this.player.money += reward;

        let ft = this.floatingTexts.find(ft => !ft.active);
        if(!ft) { ft = new FloatingText(); this.floatingTexts.push(ft); }
        ft.init(e.x, e.y - 20, `+$${reward}`, '#f1c40f', 24);

        for(let n=0; n<Math.ceil(20*this.particleScale); n++) this.spawnParticle(e.x, e.y, e.color, 6, 4, 'normal');
        this.spawnTrail(e.x, e.y, e.radius * 1.5); 

        const idx = this.enemies.indexOf(e);
        if(idx !== -1) this.enemies.splice(idx, 1);
        
        // Aparición del jefe cuando quedan pocos enemigos
        if (this.bossPending && this.enemies.length <= 4) {
            this.spawnBoss();
            this.bossPending = false;
            let bt = this.floatingTexts.find(ft => !ft.active);
            if(!bt) { bt = new FloatingText(); this.floatingTexts.push(bt); }
            bt.init(this.player.x, this.player.y - 60, "BOSS INCOMING!", '#c0392b', 35);
        }
    }
};

//# sourceURL=player.js

/* ================= enemies.js ================= */
class Projectile {
    init(x, y, angle, weapon, isEnemy = false) {
        this.x = x; this.y = y;
        this.vx = Math.cos(angle) * weapon.speed * (game.projectileSpeedMult || 1);
        this.vy = Math.sin(angle) * weapon.speed * (game.projectileSpeedMult || 1);
        this.damage = weapon.damage;
        this.radius = isEnemy ? 6 : 4;
        this.color = isEnemy ? '#ff4d4d' : weapon.color;
        this.active = true; this.isEnemy = isEnemy;
        this.trail = [];
        // Rasgos opcionales de arma (0/undefined = sin efecto, no rompe armas viejas)
        this.pierce = weapon.pierce || 0;
        this.knockback = weapon.knockback || 0;
        this.burn = weapon.burn || false;
        this.explosive = weapon.explosive || false;
        this.explosionRadius = weapon.explosionRadius || 0;
        this.maxRange = weapon.maxRange || 1800; // recicla el proyectil aunque la wapon no defina un rango propio
        this.traveled = 0;
        this.hitEnemies = this.hitEnemies || new Set();
        if (this.hitEnemies.size) this.hitEnemies.clear();
    }
    update() {
        this.trail.push({x: this.x, y: this.y});
        if(this.trail.length > 5) this.trail.shift();
        this.x += this.vx; this.y += this.vy;
        if (this.maxRange) {
            this.traveled += Math.hypot(this.vx, this.vy);
            if (this.traveled > this.maxRange) this.active = false;
        }
        if(this.x < 0 || this.x > MAP_SIZE || this.y < 0 || this.y > MAP_SIZE) this.active = false;
    }
    draw(cam) {
        if (!isVisible(this.x, this.y, 20, cam)) return;
        ctx.beginPath();
        ctx.moveTo(this.x - cam.x, this.y - cam.y);
        for(let i = this.trail.length - 1; i >= 0; i--) { ctx.lineTo(this.trail[i].x - cam.x, this.trail[i].y - cam.y); }
        ctx.strokeStyle = this.color; ctx.lineWidth = this.radius; ctx.lineCap = 'round';
        ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;

        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(this.x - cam.x, this.y - cam.y, this.radius, 0, Math.PI*2); ctx.fill();
    }
}

class Enemy {
    constructor(x, y, type) {
        this.x = x; this.y = y; this.type = type;
        this.flash = 0; this.tick = Math.random() * 100;
        this.isDying = false;
        
        const m = 1 + (game.wave * 0.25);
        if(type === 'TANK') { this.maxHp = 300 * m; this.speed = 1.1; this.radius = 35; this.color = '#2c3e50'; } 
        else if(type === 'FAST') { this.maxHp = 40 * m; this.speed = 4.0; this.radius = 18; this.color = '#e67e22'; } 
        else if(type === 'RANGED') { this.maxHp = 80 * m; this.speed = 1.8; this.radius = 24; this.color = '#8e44ad'; this.lastShot = 0; } 
        else if(type === 'INVISIBLE') { this.maxHp = 60 * m; this.speed = 2.4; this.radius = 22; this.color = '#16a085'; this.invisAlpha = 0; this.onscreenVisibleTimer = 0; this.wasOnScreen = false; }
        else if(type === 'KAMIKAZE') { this.maxHp = 25 * m; this.speed = 2.4 * 1.3; this.radius = 20; this.color = '#e74c3c'; this.baseColor = this.color; this.kamikazeState = 'CHASE'; this.kamikazeTimer = 0; this.explodeScale = 1; }
        else if(type === 'GHOST') { this.maxHp = 90 * m; this.speed = 2.0; this.radius = 22; this.color = '#9b59b6'; this.ghostState = 'GHOST'; this.ghostTimer = 0; this.ghostAlpha = 0.18; this.invulnerable = true; }
        else if(type === 'BOSS') { 
            this.bossWave = game.wave;
            if (this.bossWave >= 30) {
                this.maxHp = (4000 + (this.bossWave - 30) * 500) * m;
            } else if (this.bossWave >= 15) {
                this.maxHp = 2500 * m;
            } else {
                this.maxHp = 1500 * m;
            }
            this.speed = 1.6; this.radius = 70; this.color = '#c0392b'; 
            this.state = 'IDLE'; this.stateTimer = 0; this.summonTimer = 0;
            this.dashTargetAngle = 0; this.shootCount = 0;
        } 
        else { this.maxHp = 70 * m; this.speed = 2.4; this.radius = 22; this.color = '#27ae60'; }
        // Modificadores de eventos dinámicos (Mutación agranda/fortalece, etc. Ver events.js)
        this.speed *= (game.enemySpeedMult || 1);
        if (game.enemySizeMult) this.radius *= game.enemySizeMult;
        if (game.enemyHpMult) this.maxHp *= game.enemyHpMult;
        this.hp = this.maxHp;
    }
    update(player) {
        this.tick += 0.2;
        let d = this._dist !== undefined ? this._dist : Math.hypot(player.x - this.x, player.y - this.y);
        let angle = Math.atan2(player.y - this.y, player.x - this.x);

        if (this.type === 'KAMIKAZE') {
            if (this.kamikazeState === 'CHASE' && d < 120) { this.kamikazeState = 'ARMED'; this.kamikazeTimer = 0; }
            if (this.kamikazeState === 'ARMED') {
                this.kamikazeTimer++;
                this.color = this.kamikazeTimer % 6 < 3 ? '#fff' : this.baseColor;
                this.explodeScale = 1 + Math.min(0.4, (this.kamikazeTimer / 60) * 0.4);
                if (this.kamikazeTimer > 60) { // ~1s de cuenta regresiva antes de explotar
                    const blastRadius = 120;
                    if (d < blastRadius) player.takeDamage(35);
                    game.enemies.forEach(other => {
                        if (other !== this && !other.invulnerable && Math.hypot(other.x - this.x, other.y - this.y) < blastRadius) game.hitEnemy(other, 40);
                    });
                    game.camera.shake = 12;
                    for(let i=0; i<Math.ceil(20*game.particleScale); i++) game.spawnParticle(this.x, this.y, '#e74c3c', 6, 4, 'normal');
                    game.hitEnemy(this, this.hp); // se autodestruye reutilizando la lógica de muerte existente
                }
            }
        }
        if (this.type === 'INVISIBLE') {
            const onScreen = isVisible(this.x, this.y, this.radius, game.camera);
            if (onScreen && !this.wasOnScreen) this.onscreenVisibleTimer = 120; // ~2s a 60fps
            this.wasOnScreen = onScreen;
            if (this.onscreenVisibleTimer > 0) { this.invisAlpha = Math.min(1, this.invisAlpha + 0.08); this.onscreenVisibleTimer--; }
            else this.invisAlpha = Math.max(0, this.invisAlpha - 0.05);
            if (Math.random() > 0.9) game.spawnTrail(this.x, this.y, this.radius * 0.5); // rastro tenue
        }
        if (this.type === 'GHOST') {
            this.ghostTimer++;
            if (this.ghostState === 'GHOST' && this.ghostTimer > 180) { this.ghostState = 'SOLID'; this.ghostTimer = 0; this.invulnerable = false; }
            else if (this.ghostState === 'SOLID' && this.ghostTimer > 120) { this.ghostState = 'GHOST'; this.ghostTimer = 0; this.invulnerable = true; }
            const targetGhostAlpha = this.ghostState === 'GHOST' ? 0.18 : 1;
            this.ghostAlpha += (targetGhostAlpha - this.ghostAlpha) * 0.08; // transición suave
        }

        if (this.type === 'BOSS') {
            this.stateTimer++;
            this.summonTimer++;
            
            // Invocación (Boss Wave 30+)
            if (this.bossWave >= 30 && this.summonTimer > 60 * 12) { // Cada ~12 segundos
                this.summonTimer = 0;
                game.enemies.push(new Enemy(this.x + 100, this.y, 'TANK'));
                game.enemies.push(new Enemy(this.x - 100, this.y, 'TANK'));
                game.enemies.push(new Enemy(this.x, this.y + 100, 'RANGED'));
                game.enemies.push(new Enemy(this.x, this.y - 100, 'RANGED'));
            }

            if (this.state === 'IDLE') {
                this.x += Math.cos(angle) * this.speed;
                this.y += Math.sin(angle) * this.speed;
                
                let limit = this.bossWave >= 30 ? 50 : (this.bossWave >= 15 ? 70 : 100);
                if (this.stateTimer > limit) {
                    this.stateTimer = 0;
                    if (this.bossWave >= 15 && Math.random() < 0.5) {
                        this.state = 'SHOOT';
                        this.shootCount = 0;
                    } else {
                        this.state = 'TELEGRAPH';
                    }
                }
            } else if (this.state === 'TELEGRAPH') {
                // Temblor y cambio de color para avisar que va a dashear
                this.x += (Math.random() - 0.5) * 4;
                this.y += (Math.random() - 0.5) * 4;
                this.color = this.stateTimer % 8 < 4 ? '#fff' : '#c0392b';
                
                let teleTime = this.bossWave >= 30 ? 30 : 50;
                if (this.stateTimer > teleTime) {
                    this.state = 'DASH';
                    this.stateTimer = 0;
                    this.dashTargetAngle = angle;
                    this.dashSpeed = this.bossWave >= 30 ? 25 : 18; // Dash buffeado si es 30+
                    this.color = '#c0392b';
                }
            } else if (this.state === 'DASH') {
                this.x += Math.cos(this.dashTargetAngle) * this.dashSpeed;
                this.y += Math.sin(this.dashTargetAngle) * this.dashSpeed;
                
                if (Math.random() > 0.4) game.spawnTrail(this.x, this.y, this.radius);
                
                if (this.stateTimer > 25) {
                    this.state = 'IDLE';
                    this.stateTimer = 0;
                }
            } else if (this.state === 'SHOOT') {
                this.x += Math.cos(angle) * (this.speed * 0.3);
                this.y += Math.sin(angle) * (this.speed * 0.3);
                
                if (this.stateTimer % 20 === 0) {
                    if (this.bossWave >= 30) {
                        // Muchos más patrones de disparo
                        let offset = this.stateTimer * 0.1;
                        for(let i=0; i<12; i++) {
                            let a = (Math.PI*2/12) * i + offset;
                            game.spawnProjectile(this.x, this.y, a, {speed: 7, damage: 20 * (game.enemyDamageMult || 1), color: '#f39c12'}, true);
                        }
                    } else {
                        // Disparos wave 15
                        for(let i=0; i<6; i++) {
                            let a = (Math.PI*2/6) * i;
                            game.spawnProjectile(this.x, this.y, a, {speed: 5, damage: 15 * (game.enemyDamageMult || 1), color: '#f39c12'}, true);
                        }
                    }
                    this.shootCount++;
                }
                
                let maxShoots = this.bossWave >= 30 ? 6 : 3;
                if (this.shootCount >= maxShoots) {
                    this.state = 'IDLE';
                    this.stateTimer = 0;
                }
            }
        } 
        else if(this.type === 'RANGED' && d < 450) {
            if(d < 350) { this.x -= Math.cos(angle) * this.speed; this.y -= Math.sin(angle) * this.speed; }
            if(Date.now() - this.lastShot > 1500) {
                game.spawnProjectile(this.x, this.y, angle, {speed: 8, damage: 15 * (game.enemyDamageMult || 1), color: '#ff4d4d'}, true);
                this.lastShot = Date.now();
            }
        } else if(this.type === 'KAMIKAZE' && this.kamikazeState === 'ARMED') {
            // Se detiene mientras arma la explosión
        } else {
            this.x += Math.cos(angle) * this.speed; this.y += Math.sin(angle) * this.speed;
        }

        if(d < this.radius + player.radius) player.takeDamage(0.5 * (game.enemyDamageMult || 1));
        if(this.flash > 0) this.flash--;
        // Quemadura (Lanzallamas): tic de daño periódico independiente del flash de golpe
        if (this.burnTicks > 0) {
            this.burnTicks--;
            if (this.burnTicks % 20 === 0 && !this.isDying) {
                game.hitEnemy(this, this.burnDmg || 3);
                if (isVisible(this.x, this.y, this.radius, game.camera)) game.spawnParticle(this.x, this.y - this.radius*0.5, '#ff8800', 2, 3, 'normal');
            }
        }
    }
    draw(cam) {
        if (!isVisible(this.x, this.y, this.radius * 2, cam)) return;

        let typeAlpha = 1;
        if (this.type === 'INVISIBLE') typeAlpha = this.invisAlpha;
        if (this.type === 'GHOST') typeAlpha = this.ghostAlpha;

        const bounce = Math.abs(Math.sin(this.tick)) * (this.speed * 1.5);
        let stretch = 1 + Math.abs(Math.cos(this.tick)) * 0.15;
        if (this.type === 'FAST') stretch *= 1.2;

        if (game.shadowsEnabled) {
            ctx.globalAlpha = typeAlpha;
            ctx.fillStyle = "rgba(0,0,0,0.35)";
            ctx.beginPath(); ctx.ellipse(this.x - cam.x, this.y - cam.y + this.radius*0.8, this.radius * 1.2, this.radius * 0.4, 0, 0, Math.PI*2); ctx.fill();
            ctx.globalAlpha = 1;
        }

        ctx.save();
        ctx.globalAlpha = typeAlpha;
        ctx.translate(this.x - cam.x, this.y - cam.y - bounce);
        
        if (this.type === 'FAST') {
            ctx.scale(1 / stretch, stretch); 
        } else if (this.type === 'TANK') {
            ctx.scale(stretch, 1 / stretch); 
        } else {
            ctx.scale(1 / stretch, stretch);
        }
        
        ctx.fillStyle = this.flash > 0 ? '#fff' : this.color;
        ctx.strokeStyle = '#000'; ctx.lineWidth = 3;

        if (this.type === 'TANK') {
            ctx.beginPath();
            for(let i=0; i<6; i++) {
                ctx.lineTo(Math.cos(i * Math.PI/3) * this.radius, Math.sin(i * Math.PI/3) * this.radius);
            }
            ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(-10, -10); ctx.lineTo(0, 5); ctx.lineTo(15, -5); ctx.stroke();
        } else if (this.type === 'BOSS') {
            ctx.fillStyle = '#922b21';
            ctx.beginPath();
            for(let i=0; i<12; i++) {
                let r = this.radius * (i%2 === 0 ? 1.2 : 0.9);
                ctx.lineTo(Math.cos(i * Math.PI/6) * r, Math.sin(i * Math.PI/6) * r);
            }
            ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.fillStyle = this.flash > 0 ? '#fff' : this.color;
            ctx.beginPath(); ctx.arc(0, 0, this.radius * 0.8, 0, Math.PI*2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#000';
            ctx.beginPath(); ctx.moveTo(-this.radius*0.5, -this.radius*0.7); ctx.lineTo(-this.radius*0.9, -this.radius*1.3); ctx.lineTo(-this.radius*0.2, -this.radius*0.8); ctx.fill();
            ctx.beginPath(); ctx.moveTo(this.radius*0.5, -this.radius*0.7); ctx.lineTo(this.radius*0.9, -this.radius*1.3); ctx.lineTo(this.radius*0.2, -this.radius*0.8); ctx.fill();
        } else if (this.type === 'RANGED') {
            ctx.beginPath(); ctx.arc(0, 0, this.radius, 0, Math.PI*2); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(-10, -this.radius); ctx.lineTo(-20, -this.radius - 15); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(10, -this.radius); ctx.lineTo(20, -this.radius - 15); ctx.stroke();
            ctx.fillStyle = '#f1c40f'; ctx.beginPath(); ctx.arc(-20, -this.radius - 15, 4, 0, Math.PI*2); ctx.fill(); ctx.arc(20, -this.radius - 15, 4, 0, Math.PI*2); ctx.fill();
        } else {
            ctx.beginPath(); ctx.arc(0, 0, this.radius * (this.type === 'KAMIKAZE' ? this.explodeScale : 1), 0, Math.PI*2); ctx.fill(); ctx.stroke();
            if (this.type === 'GHOST' && this.ghostState === 'GHOST') {
                ctx.globalAlpha = 0.7;
                ctx.strokeStyle = '#ecf0f1'; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.arc(0, 0, this.radius + 3, 0, Math.PI*2); ctx.stroke();
                ctx.globalAlpha = typeAlpha;
            }
        }
        
        if (this.type === 'RANGED') {
            ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, -5, 10, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(0, -5, 4, 0, Math.PI*2); ctx.fill();
        } else {
            ctx.fillStyle = this.flash > 0 ? '#e74c3c' : (this.type === 'BOSS' ? '#f1c40f' : '#fff');
            ctx.beginPath();
            if (this.type === 'FAST') {
                ctx.moveTo(-this.radius*0.5, -8); ctx.lineTo(-this.radius*0.1, -2); ctx.lineTo(-this.radius*0.5, 2); 
                ctx.moveTo(this.radius*0.5, -8); ctx.lineTo(this.radius*0.1, -2); ctx.lineTo(this.radius*0.5, 2);
            } else {
                ctx.moveTo(-this.radius*0.4, -5); ctx.lineTo(-this.radius*0.1, 0); ctx.lineTo(-this.radius*0.4, 5); 
                ctx.moveTo(this.radius*0.4, -5); ctx.lineTo(this.radius*0.1, 0); ctx.lineTo(this.radius*0.4, 5); 
            }
            ctx.fill();
            if (this.type === 'BOSS') {
                ctx.strokeStyle = '#000'; ctx.lineWidth = 4;
                ctx.beginPath(); ctx.moveTo(-20, 20); ctx.quadraticCurveTo(0, 40, 20, 20); ctx.stroke();
            }
        }
        // Anillo de brillo del evento MUTACIÓN: puramente decorativo (el efecto real en
        // el juego ya lo aplican los multiplicadores de tamaño/vida/daño del evento, no
        // este anillo), se apaga en ULTRA.
        if (game.fxEnabled && game.activeEvent === 'MUTATION') {
            ctx.globalAlpha = 0.35;
            ctx.strokeStyle = '#39ff14'; ctx.lineWidth = 4;
            ctx.beginPath(); ctx.arc(0, 0, this.radius * 1.15, 0, Math.PI*2); ctx.stroke();
            ctx.globalAlpha = typeAlpha;
        }
        ctx.restore();

        if(this.hp < this.maxHp) {
            ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(this.x - cam.x - 15, this.y - cam.y - this.radius - 15, 30, 5);
            ctx.fillStyle = '#e74c3c'; ctx.fillRect(this.x - cam.x - 15, this.y - cam.y - this.radius - 15, 30 * (this.hp/this.maxHp), 5);
        }
    }
}

game.spawnProjectile = function(x, y, angle, weapon, isEnemy = false) {
    let p = this.projectiles.find(p => !p.active);
    if(p) p.init(x, y, angle, weapon, isEnemy);
};

//# sourceURL=enemies.js

/* ================= level.js ================= */
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
});

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

//# sourceURL=level.js

/* ================= progression.js ================= */
/**
 * SISTEMA DE PROGRESIÓN PERMANENTE (MEJORAS ENTRE PARTIDAS)
 */
const UPGRADES_DB = {
    VITALITY:  { name: 'Vitalidad',    desc: '+10 HP máxima por nivel',        icon: '❤️', maxLevel: 5, baseCost: 250, costGrowth: 1.6 },
    ENDURANCE: { name: 'Resistencia',  desc: '+10 stamina máxima por nivel',   icon: '🏃', maxLevel: 5, baseCost: 250, costGrowth: 1.6 },
    SWIFTNESS: { name: 'Velocidad',    desc: '+2% velocidad de movimiento por nivel', icon: '💨', maxLevel: 5, baseCost: 300, costGrowth: 1.6 },
    POWER:     { name: 'Poder',       desc: '+3% daño de armas por nivel',    icon: '⚔️', maxLevel: 5, baseCost: 350, costGrowth: 1.65 },
    FORTUNE:   { name: 'Fortuna',     desc: '+4% dinero ganado por nivel',     icon: '💰', maxLevel: 5, baseCost: 320, costGrowth: 1.65 }
};

const Progression = Object.assign({ levels: {} }, SaveSystem.get('progression', {}));

Progression.getLevel = function(k) { return this.levels[k] || 0; };

Progression.getCost = function(k) {
    const def = UPGRADES_DB[k];
    if (!def) return Infinity;
    return Math.floor(def.baseCost * Math.pow(def.costGrowth, this.getLevel(k)));
};

Progression.buy = function(k) {
    const def = UPGRADES_DB[k];
    if (!def) return false;
    const lvl = this.getLevel(k);
    if (lvl >= def.maxLevel) return false;
    const cost = this.getCost(k);
    if (!game.player || game.player.money < cost) return false;

    game.player.money -= cost;
    this.levels[k] = lvl + 1;
    this.save();
    this.applyToPlayer(game.player);
    playSFX('coin');
    return true;
};

Progression.save = function() { SaveSystem.set('progression', { levels: this.levels }); };

Progression.reset = function() {
    this.levels = {};
    this.save();
    if (game.player) this.applyToPlayer(game.player);
    if (typeof game.renderUpgrades === 'function') game.renderUpgrades();
};

Progression.applyToPlayer = function(p) {
    if (!p) return;
    const vit = this.getLevel('VITALITY');
    const end = this.getLevel('ENDURANCE');
    const newMaxHp = 100 + vit * 10;
    const newMaxStamina = 100 + end * 10;
    p.hp = Math.min(newMaxHp, p.hp + (newMaxHp - p.maxHp));
    p.maxHp = newMaxHp;
    p.stamina = Math.min(newMaxStamina, p.stamina + (newMaxStamina - p.maxStamina));
    p.maxStamina = newMaxStamina;
};

const _progOrigInit = game.init;
game.init = function() {
    _progOrigInit.call(this);
    Progression.applyToPlayer(this.player);
};

const _progOrigShoot = game.shoot;
game.shoot = function() {
    const w = this.player && this.player.weapon;
    const lvl = Progression.getLevel('POWER');
    if (w && lvl > 0 && this._powerOriginalDamage === undefined) {
        this._powerOriginalDamage = w.damage;
        w.damage = Math.round(this._powerOriginalDamage * (1 + 0.03 * lvl));
    }
    _progOrigShoot.call(this);
    if (this._powerOriginalDamage !== undefined && !(this.player && this.player.burstBusy)) {
        w.damage = this._powerOriginalDamage;
        this._powerOriginalDamage = undefined;
    }
};

const _progOrigPlayerUpdate = Player.prototype.update;
Player.prototype.update = function(keys) {
    const px = this.x, py = this.y;
    _progOrigPlayerUpdate.call(this, keys);
    const lvl = Progression.getLevel('SWIFTNESS');
    if (lvl > 0 && !this.isDashing) {
        const dx = this.x - px, dy = this.y - py;
        if (dx !== 0 || dy !== 0) {
            const bonus = lvl * 0.02;
            this.x = Math.max(this.radius, Math.min(MAP_SIZE - this.radius, this.x + dx * bonus));
            this.y = Math.max(this.radius, Math.min(MAP_SIZE - this.radius, this.y + dy * bonus));
        }
    }
};

const _progOrigHitEnemy = game.hitEnemy;
game.hitEnemy = function(e, dmg, ...rest) {
    const moneyBefore = this.player ? this.player.money : 0;
    _progOrigHitEnemy.call(this, e, dmg, ...rest);
    const lvl = Progression.getLevel('FORTUNE');
    if (lvl > 0 && this.player) {
        const gained = this.player.money - moneyBefore;
        if (gained > 0) this.player.money += Math.floor(gained * (0.04 * lvl));
    }
};

game.renderUpgrades = function() {
    const el = document.getElementById('upgrades-list');
    if (!el) return;
    el.innerHTML = Object.keys(UPGRADES_DB).map(k => {
        const def = UPGRADES_DB[k];
        const lvl = Progression.getLevel(k);
        const maxed = lvl >= def.maxLevel;
        const cost = Progression.getCost(k);
        const action = maxed
            ? '<span class="achv-claimed">MÁXIMO</span>'
            : `<button class="buy-btn" onclick="game.buyUpgrade('${k}')">$${cost}</button>`;
        return `<div class="weapon-row">
            <span class="weapon-row-name">${def.icon} ${def.name} (${lvl}/${def.maxLevel})</span>
            <span class="weapon-row-status">${def.desc}</span>
            ${action}
        </div>`;
    }).join('');
};

game.buyUpgrade = function(k) {
    if (Progression.buy(k)) game.renderUpgrades();
};

const _progOrigOpenProfile = game.openProfile;
game.openProfile = function() {
    _progOrigOpenProfile.call(this);
    game.renderUpgrades();
};

SaveSystem.onRemoteData(function(keys) {
    if (!keys.includes('progression')) return;
    const remote = SaveSystem.get('progression', { levels: {} });
    Progression.levels = remote.levels || {};
    if (game.player) Progression.applyToPlayer(game.player);
    game.renderUpgrades();
});

//# sourceURL=progression.js

/* ================= achievements.js ================= */
/**
 * SISTEMA DE LOGROS
 */

const RARITY = {
    RARO:       { label: 'RARO',        color: '#3498db' },
    SUPER_RARO: { label: 'SÚPER RARO',  color: '#1abc9c' },
    EPICO:      { label: 'ÉPICO',       color: '#9b59b6' },
    MITICO:     { label: 'MÍTICO',      color: '#e74c3c' },
    LEGENDARIO: { label: 'LEGENDARIO',  color: '#f1c40f' }
};

const ACHIEVEMENT_CATEGORIES = {
    COMBAT:      '⚔️ Combate',
    SURVIVAL:    '🛡️ Supervivencia',
    WEAPONS:     '🔫 Armas',
    BOSSES:      '💀 Bosses',
    PROGRESSION: '⭐ Progresión',
    EVENTS:      '🌪️ Eventos',
    EXPLORATION: '🗺️ Exploración',
    SPECIAL:     '🎖️ Especiales'
};

const WEAPON_CATEGORY = {
    KNIFE: 'melee', MACHETE: 'melee', CHAINSAW: 'melee',
    G18: 'pistol', REVOLVER: 'pistol',
    UZI: 'smg', MP5: 'smg', P90: 'smg',
    SHOTGUN: 'shotgun', SAWEDOFF: 'shotgun', AA12: 'shotgun',
    AK47: 'rifle', M4A1: 'rifle', FAMAS: 'rifle', SCAR: 'rifle',
    WINCHESTER: 'sniper', AWP: 'sniper', SNIPER: 'sniper',
    M249: 'heavy', MINIGUN: 'heavy',
    RPG: 'special', FLAMETHROWER: 'special', CROSSBOW: 'special'
};
const TOTAL_WEAPON_COUNT = Object.keys(WEAPON_CATEGORY).length;

const CATEGORY_META = {
    melee:   { icon: '🔪' },
    pistol:  { icon: '🔫' },
    smg:     { icon: '💥' },
    shotgun: { icon: '💢' },
    rifle:   { icon: '🎯' },
    sniper:  { icon: '🔭' },
    heavy:   { icon: '🧱' },
    special: { icon: '🚀' }
};

function fmt(n) { return n.toLocaleString('es-ES'); }

function reward(opts) {
    opts = opts || {};
    const xp = opts.xp || 0, money = opts.money || 0, diamonds = opts.diamonds || 0;
    const cosmetic = opts.cosmetic || null;
    const parts = [];
    if (xp) parts.push(`+${fmt(xp)} XP`);
    if (money) parts.push(`+$${fmt(money)}`);
    if (diamonds) parts.push(`+${fmt(diamonds)} 💎`);
    if (cosmetic && opts.label) parts.push(opts.label);
    return { xp, money, diamonds, label: parts.join('  ') || opts.label || '', cosmetic };
}

const ACHIEVEMENT_STATS_DEFAULTS = {
    bossKills: 0, categoryKills: {}, weaponsUsed: [], reloads: 0,
    killStreakNoDeath: 0, bestKillStreak: 0, meleeBossKills: 0,
    perfectWaves: 0, eventsCompleted: 0, eventTypesCompleted: [],
    weaponsPurchased: 0, heavyWeaponPurchased: false, weaponsSold: 0,
    upgradesBuys: 0, upgradesTouched: [], healthPackUses: 0, dashUses: 0,
    proWavesCleared: 0, moneyEarned: 0, bossWavesDefeated: [], lowHpClears: 0,
    pendingMoney: 0
};
const AchievementStats = Object.assign({}, ACHIEVEMENT_STATS_DEFAULTS, SaveSystem.get('achv_stats', {}));

const AchievementState = SaveSystem.get('achv_state', {});

const ACHIEVEMENTS_DB = {};

function buildChain(idPrefix, category, icon, trigger, nameFn, descFn, getValueFn, stages, hidden) {
    stages.forEach((s, i) => {
        ACHIEVEMENTS_DB[`${idPrefix}_${i + 1}`] = {
            id: `${idPrefix}_${i + 1}`, category, icon, trigger,
            name: nameFn(s.target, i + 1), desc: descFn(s.target, i + 1),
            rarity: s.rarity, target: s.target, getValue: getValueFn,
            reward: reward(s), hidden: !!hidden
        };
    });
}
function buildUnique(id, category, icon, trigger, name, desc, rarity, target, getValue, rewardOpts, hidden) {
    ACHIEVEMENTS_DB[id] = { id, category, icon, trigger, name, desc, rarity, target, getValue, reward: reward(rewardOpts), hidden: !!hidden };
}

buildChain('kills_total', 'COMBAT', '🔫', 'kill',
    t => `Exterminador (${fmt(t)})`, t => `Elimina ${fmt(t)} enemigos en total.`,
    () => PlayerProfile.kills,
    [{ target: 300, rarity: 'RARO', xp: 40, money: 60 }, { target: 5000, rarity: 'SUPER_RARO', xp: 150, money: 350 },
     { target: 50000, rarity: 'EPICO', xp: 500, money: 1500 }, { target: 500000, rarity: 'LEGENDARIO', xp: 1500, money: 6000, diamonds: 100 }]);

buildChain('boss_kills', 'BOSSES', '💀', 'kill',
    t => `Cazador de Bosses (${fmt(t)})`, t => `Derrota a ${fmt(t)} jefes.`,
    () => AchievementStats.bossKills,
    [{ target: 3, rarity: 'RARO', xp: 60, money: 120 }, { target: 15, rarity: 'SUPER_RARO', xp: 200, money: 500 },
     { target: 60, rarity: 'EPICO', xp: 600, money: 1800 }, { target: 200, rarity: 'LEGENDARIO', xp: 2000, money: 7000, diamonds: 120 }]);

buildChain('waves_survived', 'SURVIVAL', '🌊', 'waveClear',
    t => `Superviviente (Oleada ${t})`, t => `Sobrevive hasta la oleada ${t}.`,
    () => PlayerProfile.bestWave,
    [{ target: 15, rarity: 'RARO', xp: 80, money: 180 }, { target: 40, rarity: 'SUPER_RARO', xp: 250, money: 600 },
     { target: 80, rarity: 'EPICO', xp: 700, money: 2200 }, { target: 150, rarity: 'LEGENDARIO', xp: 1800, money: 7000, diamonds: 100 }]);

buildChain('playtime', 'SURVIVAL', '⏱️', 'waveClear',
    t => `Veterano de Guerra (${t} min)`, t => `Acumula ${t} minutos de juego.`,
    () => Math.floor(AchievementManager.getTotalPlaySeconds() / 60),
    [{ target: 60, rarity: 'RARO', xp: 60, money: 120 }, { target: 300, rarity: 'SUPER_RARO', xp: 200, money: 450 },
     { target: 900, rarity: 'EPICO', xp: 550, money: 1400 }, { target: 2400, rarity: 'LEGENDARIO', xp: 1500, money: 5000, diamonds: 80 }]);

buildChain('distance', 'EXPLORATION', '🗺️', 'waveClear',
    t => `Nómada (${fmt(t)} m)`, t => `Recorre ${fmt(t)} metros en total.`,
    () => Math.floor(PlayerProfile.distance),
    [{ target: 15000, rarity: 'RARO', xp: 60, money: 120 }, { target: 75000, rarity: 'SUPER_RARO', xp: 200, money: 450 },
     { target: 400000, rarity: 'EPICO', xp: 550, money: 1400 }, { target: 2000000, rarity: 'LEGENDARIO', xp: 1500, money: 5000, diamonds: 80 }]);

buildChain('accuracy', 'COMBAT', '🎯', 'waveClear',
    t => `Puntería (${t}%)`, t => `Alcanza ${t}% de precisión (mínimo 500 disparos).`,
    () => (PlayerProfile.shotsFired >= 500 ? Math.round(PlayerProfile.shotsHit / PlayerProfile.shotsFired * 100) : 0),
    [{ target: 50, rarity: 'RARO', xp: 80, money: 150 }, { target: 70, rarity: 'SUPER_RARO', xp: 250, money: 500 },
     { target: 85, rarity: 'EPICO', xp: 700, money: 1600 }, { target: 95, rarity: 'LEGENDARIO', xp: 1800, money: 5500, diamonds: 90 }]);

buildChain('deaths', 'SURVIVAL', '☠️', 'death',
    t => `Que no te tiemble el gel (${fmt(t)})`, t => `Muere ${fmt(t)} veces. Nadie dijo que fuera fácil.`,
    () => PlayerProfile.deaths,
    [{ target: 1, rarity: 'RARO', xp: 20, money: 30 }, { target: 25, rarity: 'SUPER_RARO', xp: 80, money: 150 },
     { target: 100, rarity: 'EPICO', xp: 300, money: 600 }, { target: 300, rarity: 'LEGENDARIO', xp: 900, money: 2200 }]);

buildChain('reloads', 'WEAPONS', '🔄', 'reload',
    t => `Manos rápidas (${fmt(t)})`, t => `Recarga tus armas ${fmt(t)} veces.`,
    () => AchievementStats.reloads,
    [{ target: 150, rarity: 'RARO', xp: 40, money: 90 }, { target: 800, rarity: 'SUPER_RARO', xp: 140, money: 280 },
     { target: 4000, rarity: 'EPICO', xp: 450, money: 1000 }, { target: 15000, rarity: 'LEGENDARIO', xp: 1200, money: 3500, diamonds: 60 }]);

buildChain('level', 'PROGRESSION', '⭐', 'levelUp',
    t => `Nivel ${t}`, t => `Alcanza el nivel ${t} de jugador.`,
    () => PlayerProfile.level,
    [{ target: 8, rarity: 'RARO', money: 150 }, { target: 18, rarity: 'SUPER_RARO', money: 400 },
     { target: 35, rarity: 'EPICO', money: 1300 }, { target: 60, rarity: 'LEGENDARIO', money: 5000, diamonds: 150 }]);

buildChain('perfect_waves', 'COMBAT', '🛡️', 'waveClear',
    t => `Impecable (${fmt(t)})`, t => `Completa ${fmt(t)} oleadas sin recibir daño.`,
    () => AchievementStats.perfectWaves,
    [{ target: 5, rarity: 'RARO', xp: 60, money: 120 }, { target: 30, rarity: 'SUPER_RARO', xp: 220, money: 550 },
     { target: 120, rarity: 'EPICO', xp: 700, money: 2200 }, { target: 300, rarity: 'LEGENDARIO', xp: 2200, money: 8000, diamonds: 120 }]);

buildChain('kill_streak', 'COMBAT', '🔥', 'kill',
    t => `Racha letal (${fmt(t)})`, t => `Elimina ${fmt(t)} enemigos seguidos sin morir.`,
    () => AchievementStats.bestKillStreak,
    [{ target: 150, rarity: 'RARO', xp: 80, money: 160 }, { target: 700, rarity: 'EPICO', xp: 350, money: 900 },
     { target: 3000, rarity: 'MITICO', xp: 1200, money: 3500, diamonds: 60 }]);

buildChain('events_completed', 'EVENTS', '🌪️', 'eventComplete',
    t => `Curtido en tormentas (${fmt(t)})`, t => `Supera ${fmt(t)} oleadas con un evento dinámico activo.`,
    () => AchievementStats.eventsCompleted,
    [{ target: 5, rarity: 'RARO', xp: 40, money: 90 }, { target: 40, rarity: 'SUPER_RARO', xp: 180, money: 450 },
     { target: 200, rarity: 'EPICO', xp: 600, money: 1700 }]);

buildChain('weapons_used', 'WEAPONS', '🎒', 'shoot',
    t => `Arsenal (${t}/${TOTAL_WEAPON_COUNT})`, t => `Usa ${t} armas distintas al menos una vez.`,
    () => AchievementStats.weaponsUsed.length,
    [{ target: 5, rarity: 'RARO', xp: 50, money: 100 }, { target: 10, rarity: 'SUPER_RARO', xp: 150, money: 300 },
     { target: 15, rarity: 'EPICO', xp: 450, money: 900 }, { target: TOTAL_WEAPON_COUNT, rarity: 'LEGENDARIO', xp: 1200, money: 3000, diamonds: 60 }]);

buildChain('healthpacks', 'SURVIVAL', '💉', 'healthBuy',
    t => `Adicto a la sanación (${fmt(t)})`, t => `Compra curación en la tienda ${fmt(t)} veces.`,
    () => AchievementStats.healthPackUses,
    [{ target: 25, rarity: 'RARO', xp: 40, money: 80 }, { target: 150, rarity: 'SUPER_RARO', xp: 150, money: 300 },
     { target: 600, rarity: 'EPICO', xp: 450, money: 900 }]);

buildChain('pro_graphics', 'SPECIAL', '🖥️', 'waveClear',
    t => `Sin concesiones (${fmt(t)})`, t => `Completa ${fmt(t)} oleadas con gráficos en PRO.`,
    () => AchievementStats.proWavesCleared,
    [{ target: 25, rarity: 'RARO', xp: 60, money: 100 }, { target: 150, rarity: 'EPICO', xp: 250, money: 500 }]);

buildChain('money_earned', 'PROGRESSION', '💰', 'kill',
    t => `Fortuna acumulada ($${fmt(t)})`, t => `Gana $${fmt(t)} en total eliminando enemigos.`,
    () => AchievementStats.moneyEarned,
    [{ target: 5000, rarity: 'RARO', xp: 60, money: 100 }, { target: 50000, rarity: 'SUPER_RARO', xp: 200, money: 400 },
     { target: 750000, rarity: 'EPICO', xp: 700, money: 1500 }, { target: 10000000, rarity: 'LEGENDARIO', xp: 2000, money: 5000, diamonds: 100 }]);

buildChain('shots_fired', 'WEAPONS', '💥', 'shoot',
    t => `Dedo caliente (${fmt(t)})`, t => `Dispara ${fmt(t)} veces en total.`,
    () => PlayerProfile.shotsFired,
    [{ target: 2000, rarity: 'RARO', xp: 40, money: 80 }, { target: 15000, rarity: 'SUPER_RARO', xp: 140, money: 250 },
     { target: 75000, rarity: 'EPICO', xp: 450, money: 900 }, { target: 400000, rarity: 'LEGENDARIO', xp: 1200, money: 3000, diamonds: 60 }]);

Object.keys(CATEGORY_META).forEach(cat => {
    const meta = CATEGORY_META[cat];
    buildChain(`cat_kills_${cat}`, 'WEAPONS', meta.icon, 'kill',
        t => `Especialista ${cat.toUpperCase()} (${fmt(t)})`, t => `Elimina ${fmt(t)} enemigos usando armas de categoría "${cat}".`,
        () => AchievementStats.categoryKills[cat] || 0,
        [{ target: 400, rarity: 'RARO', xp: 50, money: 100 }, { target: 5000, rarity: 'EPICO', xp: 350, money: 800 }]);
});

[['STORM', '🌩️'], ['SANDSTORM', '🌪️'], ['BLIZZARD', '❄️'], ['RADIOACTIVE', '☢️'], ['INVASION', '💀'], ['DARKNESS', '🌑']].forEach(([key, icon]) => {
    buildUnique(`event_survive_${key}`, 'EVENTS', icon, 'eventSurvive',
        `Superó: ${RANDOM_EVENTS[key].label}`, `Completa una oleada entera con el evento "${RANDOM_EVENTS[key].label}" activo.`,
        'MITICO', 1, () => (AchievementStats.eventTypesCompleted.includes(key) ? 1 : 0), { xp: 250, money: 500, diamonds: 20 });
});

buildUnique('melee_boss_kill', 'SPECIAL', '🔪', 'kill', 'Filo Contra Titanes',
    'Derrota a un jefe usando únicamente un arma cuerpo a cuerpo.', 'LEGENDARIO', 1,
    () => AchievementStats.meleeBossKills, { xp: 1000, money: 2500, diamonds: 80 }, true);

buildUnique('no_buy_weapons_w15', 'SPECIAL', '🎒', 'waveClear', 'Minimalista',
    'Llega a la oleada 15 sin comprar ninguna arma en la tienda.', 'MITICO', 1,
    () => (PlayerProfile.bestWave >= 15 && AchievementStats.weaponsPurchased === 0 ? 1 : 0), { xp: 600, money: 1500, diamonds: 40 }, true);

buildUnique('level_40_rewards', 'PROGRESSION', '🏅', 'levelUp', 'Veterano Condecorado',
    'Alcanza el nivel 60.', 'EPICO', 1, () => (PlayerProfile.level >= 60 ? 1 : 0),
    { money: 2500, cosmetic: 'title', label: 'Título "Veterano"' });

buildUnique('wave_200', 'SURVIVAL', '🏆', 'waveClear', 'Inmortal del Slime',
    'Sobrevive hasta la oleada 200.', 'LEGENDARIO', 200, () => PlayerProfile.bestWave, { xp: 3000, money: 10000, diamonds: 150 });

buildUnique('boss_wave15', 'BOSSES', '👹', 'kill', 'Segundo Contacto',
    'Derrota al jefe de la oleada 15.', 'EPICO', 1, () => (AchievementStats.bossWavesDefeated.includes(15) ? 1 : 0), { xp: 450, money: 1200 });

buildUnique('boss_wave30', 'BOSSES', '👺', 'kill', 'El Verdadero Desafío',
    'Derrota al jefe de la oleada 30.', 'MITICO', 1, () => (AchievementStats.bossWavesDefeated.includes(30) ? 1 : 0), { xp: 900, money: 2500, diamonds: 40 });

buildUnique('heavy_weapon_purchase', 'WEAPONS', '⚙️', 'buyWeapon', 'Artillería Pesada',
    'Compra tu primera arma de categoría pesada o especial.', 'SUPER_RARO', 1,
    () => (AchievementStats.heavyWeaponPurchased ? 1 : 0), { xp: 100, money: 250 });

buildUnique('sell_weapon_first', 'WEAPONS', '💵', 'sellWeapon', 'Reventa Táctica',
    'Vende un arma en la tienda por primera vez.', 'RARO', 1, () => (AchievementStats.weaponsSold >= 1 ? 1 : 0), { xp: 25, money: 60 });

buildUnique('upgrades_all_maxed', 'PROGRESSION', '📈', 'upgradeBuy', 'Mejora Total',
    'Lleva las 5 mejoras permanentes a su nivel máximo.', 'LEGENDARIO', 1,
    () => (Object.keys(UPGRADES_DB).every(k => Progression.getLevel(k) >= UPGRADES_DB[k].maxLevel) ? 1 : 0),
    { money: 4000, diamonds: 100, cosmetic: 'skin', label: 'Skin exclusiva' });

buildUnique('upgrades_each_one', 'PROGRESSION', '🧬', 'upgradeBuy', 'Todoterreno',
    'Compra al menos un nivel de cada mejora permanente.', 'SUPER_RARO', Object.keys(UPGRADES_DB).length,
    () => AchievementStats.upgradesTouched.length, { xp: 120, money: 300 });

buildUnique('dash_master', 'SPECIAL', '💨', 'dash', 'Maestro del Dash',
    'Utiliza el dash 1500 veces.', 'SUPER_RARO', 1500, () => AchievementStats.dashUses, { xp: 150, money: 400 });

buildUnique('low_hp_clear', 'SURVIVAL', '💓', 'waveClear', 'Al Filo de la Muerte',
    'Termina una oleada con menos del 10% de tu vida máxima.', 'EPICO', 1, () => AchievementStats.lowHpClears, { xp: 250, money: 600 }, true);

const _achTriggerIndex = {};
Object.values(ACHIEVEMENTS_DB).forEach(def => {
    (_achTriggerIndex[def.trigger] = _achTriggerIndex[def.trigger] || []).push(def);
});

const AchievementManager = {
    getState(id) {
        if (!AchievementState[id]) AchievementState[id] = { notified: false, claimed: false };
        return AchievementState[id];
    },
    evaluate(trigger) {
        const defs = _achTriggerIndex[trigger];
        if (!defs) return;
        let dirty = false;
        defs.forEach(def => {
            if (def.getValue() < def.target) return;
            const state = this.getState(def.id);
            if (!state.notified) { state.notified = true; this.showToast(def); dirty = true; }
        });
        if (dirty) this.saveState();
    },
    claim(id) {
        const def = ACHIEVEMENTS_DB[id];
        if (!def) return false;
        const state = this.getState(id);
        if (state.claimed || def.getValue() < def.target) return false;
        state.claimed = true;
        this.applyReward(def);
        this.saveState();
        return true;
    },
    applyReward(def) {
        const r = def.reward;
        if (r.xp) game.grantXP(r.xp);
        if (r.diamonds) game.grantDiamonds(r.diamonds);
        if (r.money) {
            if (game.player) game.player.money += r.money;
            else AchievementStats.pendingMoney += r.money;
        }
        if (r.cosmetic) PlayerProfile.unlocks.push({ achievement: def.id, type: r.cosmetic, label: r.label });
        PlayerProfile.save();
        this.saveStats();
    },
    showToast(def) {
        playSFX('achievement_unlock', 0.6, 0.05);
        const el = document.getElementById('achievement-toast');
        if (!el) return;
        const rarity = RARITY[def.rarity];
        el.innerHTML = `<div class="achv-toast-header" style="color:${rarity.color}">🏆 LOGRO DESBLOQUEADO — ${rarity.label}</div><div class="achv-toast-name">${def.icon} ${def.name}</div>`;
        el.style.setProperty('--rarity-color', rarity.color);
        el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
    },
    getTotalPlaySeconds() {
        const live = game.started ? Math.floor((Date.now() - game.startTime) / 1000) : 0;
        return PlayerProfile.playTimeSec + live;
    },
    onWaveClear(waveNum, eventKey) {
        if (!this._tookDamageThisWave) AchievementStats.perfectWaves++;
        this._tookDamageThisWave = false;
        if (eventKey) {
            AchievementStats.eventsCompleted++;
            if (!AchievementStats.eventTypesCompleted.includes(eventKey)) AchievementStats.eventTypesCompleted.push(eventKey);
            this.evaluate('eventComplete');
            this.evaluate('eventSurvive');
        }
        if (Settings.graphics === 'PRO') AchievementStats.proWavesCleared++;
        if (game.player && game.player.hp < game.player.maxHp * 0.1) AchievementStats.lowHpClears++;
        this.evaluate('waveClear');
        this.saveStats();
    },
    saveStats() { SaveSystem.set('achv_stats', AchievementStats); },
    saveState() { SaveSystem.set('achv_state', AchievementState); },
    resetAll() {
        Object.keys(ACHIEVEMENT_STATS_DEFAULTS).forEach(k => {
            const d = ACHIEVEMENT_STATS_DEFAULTS[k];
            AchievementStats[k] = Array.isArray(d) ? [] : (d && typeof d === 'object' ? {} : d);
        });
        Object.keys(AchievementState).forEach(k => delete AchievementState[k]);
        this.saveStats();
        this.saveState();
        if (typeof game.renderAchievements === 'function') game.renderAchievements();
    }
};

const _achOrigHitEnemy = game.hitEnemy;
game.hitEnemy = function(e, dmg, ...rest) {
    const wasAlive = !e.isDying;
    const wasBoss = e.type === 'BOSS';
    const bossWave = e.bossWave;
    const weapon = this.player && this.player.weapon;
    const moneyBefore = this.player ? this.player.money : 0;
    _achOrigHitEnemy.call(this, e, dmg, ...rest);
    if (wasAlive && e.isDying) {
        AchievementStats.killStreakNoDeath++;
        AchievementStats.bestKillStreak = Math.max(AchievementStats.bestKillStreak, AchievementStats.killStreakNoDeath);
        if (weapon) {
            const cat = WEAPON_CATEGORY[weapon.name];
            if (cat) AchievementStats.categoryKills[cat] = (AchievementStats.categoryKills[cat] || 0) + 1;
        }
        if (wasBoss) {
            AchievementStats.bossKills++;
            if (weapon && weapon.type === 'melee') AchievementStats.meleeBossKills++;
            if (bossWave && !AchievementStats.bossWavesDefeated.includes(bossWave)) AchievementStats.bossWavesDefeated.push(bossWave);
        }
        if (this.player) AchievementStats.moneyEarned += Math.max(0, this.player.money - moneyBefore);
        AchievementManager.evaluate('kill');
    }
};

const _achOrigShoot = game.shoot;
game.shoot = function() {
    const w = this.player && this.player.weapon;
    const prevLastShot = this.lastShot;
    _achOrigShoot.call(this);
    if (w && this.lastShot !== prevLastShot) {
        if (!AchievementStats.weaponsUsed.includes(w.name)) AchievementStats.weaponsUsed.push(w.name);
        AchievementManager.evaluate('shoot');
    }
};

const _achOrigReload = game.reload;
game.reload = function() {
    const w = this.player && this.player.weapon;
    const before = w ? w.ammo : null;
    _achOrigReload.call(this);
    if (w && w.type !== 'melee' && before !== null && before !== w.capacity) {
        AchievementStats.reloads++;
        AchievementManager.evaluate('reload');
    }
};

const _achOrigTakeDamage = Player.prototype.takeDamage;
Player.prototype.takeDamage = function(amt) {
    AchievementManager._tookDamageThisWave = true;
    _achOrigTakeDamage.call(this, amt);
};

const _achOrigDash = Player.prototype.dash;
Player.prototype.dash = function() {
    const before = this.isDashing;
    _achOrigDash.call(this);
    if (!before && this.isDashing) { AchievementStats.dashUses++; AchievementManager.evaluate('dash'); }
};

const _achOrigLoop = game.loop;
game.loop = function() {
    const waveBefore = this.wave;
    const eventBefore = this.activeEvent;
    _achOrigLoop.call(this);
    if (this.wave !== waveBefore) AchievementManager.onWaveClear(waveBefore, eventBefore);
};

const _achOrigShowLevelUp = game.showLevelUp;
game.showLevelUp = function(level) {
    _achOrigShowLevelUp.call(this, level);
    AchievementManager.evaluate('levelUp');
};

const _achOrigGameOver = game.gameOver;
game.gameOver = function() {
    _achOrigGameOver.call(this);
    AchievementStats.killStreakNoDeath = 0;
    AchievementManager.evaluate('death');
    AchievementManager.saveStats();
};

const _achOrigBuyWeapon = game.buyWeapon;
game.buyWeapon = function(k) {
    const before = this.player.inventory.some(s => s && s.name === k);
    _achOrigBuyWeapon.call(this, k);
    const after = this.player.inventory.some(s => s && s.name === k);
    if (!before && after) {
        AchievementStats.weaponsPurchased++;
        const cat = WEAPON_CATEGORY[k];
        if (cat === 'heavy' || cat === 'special') AchievementStats.heavyWeaponPurchased = true;
        AchievementManager.evaluate('buyWeapon');
        AchievementManager.saveStats();
    }
};
const _achOrigSellWeapon = game.sellWeapon;
game.sellWeapon = function(k) {
    _achOrigSellWeapon.call(this, k);
    AchievementStats.weaponsSold++;
    AchievementManager.evaluate('sellWeapon');
    AchievementManager.saveStats();
};

const _achOrigBuyHealth = game.buyHealth;
game.buyHealth = function() {
    const before = this.player.money;
    _achOrigBuyHealth.call(this);
    if (this.player.money < before) { AchievementStats.healthPackUses++; AchievementManager.evaluate('healthBuy'); }
};

const _achOrigProgBuy = Progression.buy;
Progression.buy = function(k) {
    const result = _achOrigProgBuy.call(this, k);
    if (result) {
        AchievementStats.upgradesBuys++;
        if (!AchievementStats.upgradesTouched.includes(k)) AchievementStats.upgradesTouched.push(k);
        AchievementManager.evaluate('upgradeBuy');
        AchievementManager.saveStats();
    }
    return result;
};

const _achOrigInit = game.init;
game.init = function() {
    _achOrigInit.call(this);
    if (AchievementStats.pendingMoney) {
        this.player.money += AchievementStats.pendingMoney;
        AchievementStats.pendingMoney = 0;
        AchievementManager.saveStats();
    }
};

window.addEventListener('beforeunload', () => AchievementManager.saveStats());

SaveSystem.onRemoteData(function(keys) {
    let changed = false;
    if (keys.includes('achv_stats')) { Object.assign(AchievementStats, SaveSystem.get('achv_stats', {})); changed = true; }
    if (keys.includes('achv_state')) { Object.assign(AchievementState, SaveSystem.get('achv_state', {})); changed = true; }
    if (changed && typeof game.renderAchievements === 'function') game.renderAchievements();
});

const _achOrigOpenProfile = game.openProfile;
game.openProfile = function() {
    _achOrigOpenProfile.call(this);
    game.setProfileTab('stats');
};

game.setProfileTab = function(tab) {
    const statsTab = document.getElementById('profile-tab-stats');
    const achvTab = document.getElementById('profile-tab-achv');
    const btnStats = document.getElementById('tab-btn-stats');
    const btnAchv = document.getElementById('tab-btn-achv');
    if (!statsTab || !achvTab) return;
    statsTab.style.display = tab === 'stats' ? 'block' : 'none';
    achvTab.style.display = tab === 'achv' ? 'block' : 'none';
    if (btnStats) btnStats.classList.toggle('active', tab === 'stats');
    if (btnAchv) btnAchv.classList.toggle('active', tab === 'achv');
    if (tab === 'achv') game.renderAchievements();
};

game.claimAchievement = function(id) {
    if (AchievementManager.claim(id)) { playSFX('coin'); game.renderAchievements(); }
};

game.renderAchievements = function() {
    const listEl = document.getElementById('achv-list');
    const summaryEl = document.getElementById('achv-summary');
    if (!listEl) return;
    const searchEl = document.getElementById('achv-search');
    const catEl = document.getElementById('achv-category-filter');
    const statusEl = document.getElementById('achv-status-filter');
    const search = searchEl ? searchEl.value.trim().toLowerCase() : '';
    const catFilter = catEl ? catEl.value : 'ALL';
    const statusFilter = statusEl ? statusEl.value : 'ALL';

    let total = 0, completedCount = 0;
    const cards = [];
    Object.values(ACHIEVEMENTS_DB).forEach(def => {
        total++;
        const value = def.getValue();
        const isCompleted = value >= def.target;
        if (isCompleted) completedCount++;
        const state = AchievementManager.getState(def.id);

        if (catFilter !== 'ALL' && def.category !== catFilter) return;
        if (statusFilter === 'COMPLETED' && !isCompleted) return;
        if (statusFilter === 'UNCLAIMED' && !(isCompleted && !state.claimed)) return;
        if (statusFilter === 'LOCKED' && isCompleted) return;

        const showHidden = def.hidden && !isCompleted;
        const name = showHidden ? '???' : def.name;
        const desc = showHidden ? 'Logro secreto. Descúbrelo jugando.' : def.desc;
        if (search && !name.toLowerCase().includes(search) && !desc.toLowerCase().includes(search)) return;

        const rarity = RARITY[def.rarity];
        const pct = Math.min(100, Math.floor(value / def.target * 100));
        const cardClasses = ['achv-card'];
        if (isCompleted) cardClasses.push('completed');
        if (isCompleted && def.rarity === 'LEGENDARIO') cardClasses.push('legendary-glow');

        let actionHtml;
        if (state.claimed) actionHtml = '<span class="achv-claimed">RECLAMADO</span>';
        else if (isCompleted) actionHtml = `<button class="buy-btn" onclick="game.claimAchievement('${def.id}')">RECLAMAR</button>`;
        else actionHtml = '<span class="achv-locked">🔒</span>';

        cards.push(`<div class="${cardClasses.join(' ')}" style="--rarity-color:${rarity.color}">
            <div class="achv-icon">${showHidden ? '❓' : def.icon}</div>
            <div class="achv-info">
                <div class="achv-name">${name} <span class="achv-rarity" style="color:${rarity.color}">${rarity.label}</span></div>
                <div class="achv-desc">${desc}</div>
                <div class="achv-progress-bar"><div class="achv-progress-inner" style="width:${pct}%; background:${rarity.color}"></div></div>
                <div class="achv-progress-text">${Math.min(value, def.target)} / ${def.target} — ${pct}%</div>
                <div class="achv-reward">🎁 ${def.reward.label || 'Recompensa cosmética'}</div>
            </div>
            <div class="achv-action">${actionHtml}</div>
        </div>`);
    });

    listEl.innerHTML = cards.join('') || '<p style="color:#888;">No hay logros que coincidan con el filtro.</p>';
    if (summaryEl) summaryEl.innerHTML = `<div class="hud-text">Progreso total: ${completedCount} / ${total} (${Math.floor(completedCount / total * 100)}%)</div>`;
};

window.addEventListener('DOMContentLoaded', () => {
    const catSelect = document.getElementById('achv-category-filter');
    if (catSelect) {
        Object.entries(ACHIEVEMENT_CATEGORIES).forEach(([key, label]) => {
            const opt = document.createElement('option');
            opt.value = key; opt.textContent = label;
            catSelect.appendChild(opt);
        });
    }
});

//# sourceURL=achievements.js

/* ================= auth-ui.js ================= */
/**
 * AUTH-UI.js
 * Capa fina de interfaz para iniciar/cerrar sesión desde el lobby.
 * A propósito NO conoce nada de Firebase: solo llama a los métodos públicos que
 * expone SaveSystem (signInWithGoogle / signOut / currentUser), definidos en
 * FirebaseSaveSystem.js, y reacciona a los eventos 'savesystem:login' /
 * 'savesystem:logout' que ese módulo dispara sobre `document`.
 *
 * Debe cargarse DESPUÉS de FirebaseSaveSystem.js (usa SaveSystem) y después de
 * main.js (el botón vive dentro del innerHTML del lobby que arma main.js).
 */
const AuthUI = {
    handleClick() {
        if (SaveSystem.currentUser) SaveSystem.signOut();
        else SaveSystem.signInWithGoogle();
    },

    currentLabel() {
        const u = SaveSystem.currentUser;
        return u ? (u.displayName || u.email || 'Cuenta conectada') : 'Invitado (local)';
    },

    // Repinta el botón/estado del lobby con el estado actual de sesión. Se llama:
    // - al cargar la página (por si Firebase ya tenía sesión guardada)
    // - cada vez que main.js reconstruye el innerHTML del lobby
    // - en los eventos savesystem:login / savesystem:logout
    refresh() {
        const statusEl = document.getElementById('auth-status');
        const btnEl = document.getElementById('auth-btn');
        if (!statusEl || !btnEl) return;
        const u = SaveSystem.currentUser;
        if (u) {
            statusEl.innerText = `✅ Conectado como ${u.displayName || u.email}`;
            btnEl.innerText = '🚪 CERRAR SESIÓN';
        } else {
            statusEl.innerText = '👤 Invitado — tu progreso solo se guarda en este dispositivo';
            btnEl.innerText = '🔑 INICIAR SESIÓN CON GOOGLE';
        }
    }
};

document.addEventListener('savesystem:login', () => AuthUI.refresh());
document.addEventListener('savesystem:logout', () => AuthUI.refresh());
window.addEventListener('DOMContentLoaded', () => AuthUI.refresh());

//# sourceURL=auth-ui.js

/* ================= mobile.js ================= */
/**
 * CONTROLES TÁCTILES (solo se activan en dispositivos con pantalla táctil,
 * en PC esto no hace nada y los controles siguen siendo teclado + mouse)
 */
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

if (isTouchDevice) {
    const joystickZone = document.getElementById('joystick-zone');
    const joystickKnob = document.getElementById('joystick-knob');
    const aimZone = document.getElementById('aim-zone');
    let joystickTouchId = null;
    let aimTouchId = null;

    function updateJoystick(touch) {
        const rect = joystickZone.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let dx = touch.clientX - cx;
        let dy = touch.clientY - cy;
        const maxDist = rect.width / 2;
        const dist = Math.min(Math.hypot(dx, dy), maxDist);
        const angle = Math.atan2(dy, dx);
        const kx = Math.cos(angle) * dist;
        const ky = Math.sin(angle) * dist;
        joystickKnob.style.transform = `translate(${kx}px, ${ky}px)`;

        // Traducimos la posición del joystick a las mismas teclas que usa el juego (WASD)
        const threshold = maxDist * 0.25;
        game.keys['KeyW'] = ky < -threshold;
        game.keys['KeyS'] = ky > threshold;
        game.keys['KeyA'] = kx < -threshold;
        game.keys['KeyD'] = kx > threshold;
    }

    function resetJoystick() {
        joystickKnob.style.transform = 'translate(0px, 0px)';
        game.keys['KeyW'] = game.keys['KeyS'] = game.keys['KeyA'] = game.keys['KeyD'] = false;
    }

    joystickZone.addEventListener('touchstart', e => {
        if (game.paused) return;
        e.preventDefault();
        joystickTouchId = e.changedTouches[0].identifier;
        updateJoystick(e.changedTouches[0]);
    });
    joystickZone.addEventListener('touchmove', e => {
        if (game.paused) return;
        e.preventDefault();
        for (const t of e.changedTouches) if (t.identifier === joystickTouchId) updateJoystick(t);
    });
    joystickZone.addEventListener('touchend', e => {
        for (const t of e.changedTouches) if (t.identifier === joystickTouchId) { joystickTouchId = null; resetJoystick(); }
    });

    // Zona derecha: arrastrar para apuntar, mientras se toca se dispara
    aimZone.addEventListener('touchstart', e => {
        if (game.paused) return;
        e.preventDefault();
        const t = e.changedTouches[0];
        aimTouchId = t.identifier;
        game.mouse.x = t.clientX; game.mouse.y = t.clientY;
        game.mouse.down = true;
    });
    aimZone.addEventListener('touchmove', e => {
        if (game.paused) return;
        e.preventDefault();
        for (const t of e.changedTouches) if (t.identifier === aimTouchId) { game.mouse.x = t.clientX; game.mouse.y = t.clientY; }
    });
    aimZone.addEventListener('touchend', e => {
        for (const t of e.changedTouches) if (t.identifier === aimTouchId) { aimTouchId = null; game.mouse.down = false; }
    });

    document.getElementById('mobile-dash-btn').addEventListener('touchstart', e => {
        e.preventDefault();
        if (!game.paused && game.player) game.player.dash();
    });
    document.getElementById('mobile-reload-btn').addEventListener('touchstart', e => {
        e.preventDefault();
        if (!game.paused) game.reload();
    });
}

//# sourceURL=mobile.js

/* ================= boot.js ================= */
/**
 * BOOT.js — Orquestador único del arranque del juego.
 * Orden real: assets -> login -> click para empezar (desbloquea audio) -> lobby.
 * Ningún otro archivo debe tocar #loading-screen/#login-screen/#clickstart-screen.
 *
 * Nota sobre "imágenes": este juego no usa archivos de imagen (todo el arte se
 * dibuja con canvas/vectores), así que ese paso se traduce en preparar
 * tipografía/gráficos, que es el recurso visual real que hace falta cargar.
 */
function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);
}

const BootFlow = {
    async run() {
        const fill = document.getElementById('boot-progress-fill');
        const pct = document.getElementById('boot-progress-pct');
        const label = document.getElementById('boot-progress-label');
        const loadingScreen = document.getElementById('loading-screen');

        const steps = [
            { label: 'Conectando con el servidor...', weight: 1, run: (p) => { p(0.2); return withTimeout(SaveSystem.ready, 8000).then(() => p(1)); } },
            { label: 'Sincronizando progreso...', weight: 1, run: (p) => { p(1); return Promise.resolve(); } },
            { label: 'Cargando sonidos...', weight: 3, run: (p) => preloadSFX((l, t) => p(l / t)) },
            { label: 'Cargando música...', weight: 3, run: (p) => preloadMusic((l, t) => p(l / t)) },
            { label: 'Cargando recursos gráficos...', weight: 1, run: (p) => {
                p(0.3);
                const fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
                return withTimeout(fontsReady, 3000).then(() => p(1));
            } },
            { label: 'Inicializando sistemas...', weight: 1, run: (p) => {
                if (typeof MusicManager !== 'undefined') MusicManager.init();
                p(1);
                return Promise.resolve();
            } }
        ];

        const totalWeight = steps.reduce((s, st) => s + st.weight, 0);
        let doneWeight = 0;
        const updateBar = (extra) => {
            const total = Math.min(totalWeight, doneWeight + extra);
            const p = Math.round((total / totalWeight) * 100);
            if (fill) fill.style.width = p + '%';
            if (pct) pct.innerText = p + '%';
        };

        for (const step of steps) {
            if (label) label.innerText = step.label;
            await step.run((frac) => updateBar(step.weight * Math.max(0, Math.min(1, frac))));
            doneWeight += step.weight;
            updateBar(0);
        }

        if (label) label.innerText = '¡Listo!';
        await new Promise(r => setTimeout(r, 250));

        if (loadingScreen) loadingScreen.style.display = 'none';
        this.goToLoginOrStart();
    },

    goToLoginOrStart() {
        if (SaveSystem.currentUser) this.showClickStart();
        else this.showLogin();
    },

    showLogin() {
        const el = document.getElementById('login-screen');
        if (el) el.style.display = 'flex';
    },

    showClickStart() {
        const login = document.getElementById('login-screen');
        if (login) login.style.display = 'none';
        const el = document.getElementById('clickstart-screen');
        if (el) el.style.display = 'flex';
    },

    unlockAndEnter() {
        const clickstart = document.getElementById('clickstart-screen');
        if (clickstart) clickstart.style.display = 'none';

        // Único punto del juego donde se reproduce audio por primera vez: siempre
        // detrás de una interacción real del usuario (este click).
        if (typeof MusicManager !== 'undefined') MusicManager.playLobby();

        const lobbyScreen = document.getElementById('lobby-screen');
        if (lobbyScreen) lobbyScreen.style.display = 'flex';
        if (typeof AuthUI !== 'undefined') AuthUI.refresh();
    }
};

window.addEventListener('DOMContentLoaded', () => {
    const googleBtn = document.getElementById('login-google-btn');
    const guestBtn = document.getElementById('login-guest-btn');
    const clickstart = document.getElementById('clickstart-screen');

    if (googleBtn) {
        googleBtn.addEventListener('click', async () => {
            googleBtn.disabled = true;
            await SaveSystem.signInWithGoogle();
            googleBtn.disabled = false;
            BootFlow.showClickStart();
        });
    }
    if (guestBtn) guestBtn.addEventListener('click', () => BootFlow.showClickStart());
    if (clickstart) clickstart.addEventListener('click', () => BootFlow.unlockAndEnter(), { once: true });

    BootFlow.run();
});

//# sourceURL=boot.js
