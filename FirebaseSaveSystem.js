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
        _auth.onAuthStateChanged(async user => {
            this._uid = user ? user.uid : null;
            if (user) {
                await this._pullRemote(user.uid);
                document.dispatchEvent(new CustomEvent('savesystem:login', { detail: { uid: user.uid, user } }));
            } else {
                document.dispatchEvent(new CustomEvent('savesystem:logout'));
            }
        });
        // Último intento de guardar antes de cerrar/recargar la pestaña
        window.addEventListener('beforeunload', () => { this._pushDirty(); });
    }
};

SaveSystem.init();
