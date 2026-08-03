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
 *                                         caché local al toque; el backend se
 *                                         sincroniza solo, en segundo plano, con
 *                                         reintentos)
 *
 * Toda la comunicación real con Firebase (Auth + Firestore + Functions) vive
 * ÚNICAMENTE acá. Ningún otro archivo importa firebase.* directamente.
 *
 * === SEGURIDAD (IMPORTANTE) ===
 * Antes este archivo escribía directamente en Firestore (`_db.collection(...)
 * .doc(uid).set(patch, {merge:true})`), y las Rules solo chequeaban que el uid
 * coincidiera. Eso significa que cualquiera podía abrir la consola del
 * navegador, hacer `SaveSystem.set('profile', {money: 99999999, ...})` y ese
 * valor se subía tal cual a la nube: sin validar tipos, rangos, ni que el
 * cambio tuviera sentido.
 *
 * Ahora las Firestore Rules (firestore.rules) bloquean TODA escritura directa
 * del cliente a /players/{uid} y /leaderboard/{uid} ("allow write: if false").
 * El único camino de escritura es la Cloud Function `syncProgress`
 * (functions/index.js), que corre con el Admin SDK (ignora las Rules) y
 * valida cada campo antes de guardarlo. `clearProgress` (borrar progreso)
 * pasa por el mismo esquema con su propia función `clearProgress`.
 *
 * La estrategia "offline-first" no cambia: localStorage sigue siendo la
 * fuente de verdad inmediata para que el juego nunca se bloquee esperando
 * a la red; lo único que cambió es A DÓNDE va la sincronización remota.
 *
 * ESTRATEGIA "OFFLINE-FIRST":
 *   1. Lectura: primero memoria (this._cache), si no está, localStorage. Firestore
 *      NUNCA se consulta de forma síncrona (no se puede: es una promesa).
 *   2. Escritura: se guarda en memoria + localStorage al instante (el juego sigue
 *      andando igual que con el SaveSystem viejo) y se marca la key como "sucia".
 *      Cada ~2.5s (debounce) se empuja el lote de keys sucias a la Cloud Function
 *      `syncProgress`. Si falla (sin red, función caída, etc.) el error se traga
 *      con un console.warn y las keys quedan pendientes para el próximo intento:
 *      el juego JAMÁS se rompe ni se bloquea por un fallo de red.
 *   3. Login: al iniciar sesión con Google, se descarga el documento del usuario
 *      (players/{uid}) UNA vez y se mergea sobre la caché local + localStorage. Como
 *      PlayerProfile/Progression/AchievementStats/AchievementState ya existen para
 *      ese momento (se construyeron de forma síncrona al cargar el script, antes de
 *      que Firebase resuelva el login), cada módulo se suscribe con
 *      SaveSystem.onRemoteData(cb) para "refrescarse" a sí mismo cuando llegan datos
 *      más nuevos desde la nube.
 *
 * PREPARADO PARA RANKINGS ONLINE A FUTURO:
 *   El leaderboard ahora lo escribe únicamente `syncProgress` (Cloud Function),
 *   a partir del documento de `players/{uid}` ya validado en ese mismo request.
 *   El cliente nunca escribe el leaderboard directamente.
 *
 * NUEVO (boot flow): SaveSystem.ready es una Promise que resuelve cuando Firebase
 * Auth ya resolvió su primer estado (logueado o no) y, si había sesión, ya se bajó
 * el progreso de Firestore. boot.js espera esto antes de mostrar cualquier pantalla.
 *
 * NUEVO: SaveSystem.clearProgress() borra por completo el progreso (local + nube),
 * usado desde Ajustes → Borrar progreso.
 *
 * Debe cargarse:
 *   - DESPUÉS de los <script> del SDK de Firebase (compat, incluyendo
 *     firebase-functions-compat) en index.html.
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
// Solo se usa para LEER el propio documento (players/{uid}) al iniciar sesión.
// Ninguna escritura pasa por acá: ver _syncProgressFn / _clearProgressFn más abajo.
const _functions = firebase.functions();
const _syncProgressFn = _functions.httpsCallable('syncProgress');
const _clearProgressFn = _functions.httpsCallable('clearProgress');

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

    // ================= SINCRONIZACIÓN (nunca bloquea, nunca rompe) =================
    // IMPORTANTE: esto YA NO escribe directo en Firestore. Llama a la Cloud
    // Function `syncProgress`, que valida tipos/rangos/campos permitidos antes
    // de guardar nada (ver functions/index.js). Las Firestore Rules bloquean
    // cualquier otro camino de escritura, así que modificar `this._cache` a
    // mano desde la consola del navegador ya no tiene ningún efecto en la nube.

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
            // La Cloud Function espera datos planos (JSON serializable). Igual
            // que antes, pasamos todo por un ciclo JSON para descartar
            // funciones u otros valores no serializables antes de mandarlos.
            try {
                patch[k] = JSON.parse(JSON.stringify(this._cache[k]));
            } catch (e) {
                console.warn(`[FirebaseSaveSystem] No se pudo serializar la key "${k}", se omite este ciclo de sync:`, e);
            }
        });
        try {
            await _syncProgressFn(patch);
        } catch (e) {
            console.warn('[FirebaseSaveSystem] No se pudo sincronizar con el servidor, se sigue jugando con la caché local. Reintentará:', e.code || e);
            keys.forEach(k => this._dirty.add(k));
        }
    },

    // Fuerza el envío inmediato (se usa al cerrar sesión o al salir de la pestaña)
    async flush() {
        clearTimeout(this._pushTimer);
        await this._pushDirty();
    },

    // ================= CARGA INICIAL AL INICIAR SESIÓN =================
    // Esto sigue siendo una LECTURA directa a Firestore (permitida por las
    // Rules: cada usuario puede leer su propio documento). Ninguna escritura
    // pasa por acá.

    async _pullRemote(uid) {
        try {
            const snap = await _db.collection(PLAYERS_COLLECTION).doc(uid).get();
            if (!snap.exists) return; // usuario nuevo: se queda con lo que ya tenía local (o default)
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

    // ================= BORRADO TOTAL DE PROGRESO =================
    // Borra localStorage + caché en memoria, y pide a la Cloud Function
    // `clearProgress` que borre el documento en Firestore (si hay sesión).
    // NO toca la sesión de auth ni las preferencias de gráficos/volumen
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
                await _clearProgressFn();
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
