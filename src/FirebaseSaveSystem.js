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
 * === SEGURIDAD ===
 * Las Firestore Rules (firestore.rules) bloquean TODA escritura directa del
 * cliente a /players/{uid} y /leaderboard/{uid}. El único camino de escritura
 * es la Cloud Function `syncProgress` (functions/index.js), que valida cada
 * campo antes de guardarlo. `clearProgress` (borrar progreso) usa el mismo
 * esquema.
 *
* === CONFIGURACIÓN DE FIREBASE ===
 * El objeto de configuración de Firebase YA NO está hardcodeado acá: se lee
 * de `window.__FIREBASE_CONFIG__`, definido en `firebase-config.js` (único
 * archivo de configuración, sin distinción dev/prod). Si no se cargó, este
 * archivo lo avisa fuerte por consola en vez de conectarse en silencio al
 * proyecto equivocado.
 *
 * === CONSENTIMIENTO DE ANALYTICS ===
 * `firebase.analytics()` YA NO se llama automáticamente al cargar la página.
 * Se expone `window.__initAnalyticsIfNeeded()`, que consent.js (ConsentManager)
 * invoca únicamente si el usuario aceptó explícitamente el uso de estadísticas.
 * Si el usuario rechaza o no respondió, Analytics nunca se inicializa: no se
 * crea ninguna instancia ni se manda ningún evento.
 *
 * === ESTADO DE GUARDADO ===
 * Cada sincronización dispara un evento `savesystem:status` sobre `document`
 * con `detail.status` en {'saving','saved','offline','retrying','error'}.
 * save-indicator.js lo escucha para mostrar un indicador discreto al jugador.
 *
 * === FIX: documento no se creaba en Firestore al loguearse ===
 * Antes, el primer documento en /players/{uid} solo se creaba cuando el
 * usuario generaba progreso real (SaveSystem.set() en algún .save()), porque
 * _pushDirty() no hace nada si no hay claves "dirty". Un usuario que entraba,
 * se logueaba y cerraba sin llegar a jugar una oleada, quedaba con cuenta en
 * Firebase Authentication pero SIN documento en Firestore.
 * Ahora, apenas hay sesión activa (nueva o existente), _ensureRemoteDocument()
 * fuerza el guardado inmediato (sin esperar el debounce) de los objetos de
 * progreso ya presentes en memoria (PlayerProfile/Progression/AchievementManager,
 * cargados por level.js/progression.js/achievements.js antes de que este
 * listener asíncrono llegue a ejecutarse), garantizando que el documento
 * exista desde el primer login.
 *
* Debe cargarse:
 *   - DESPUÉS de los <script> del SDK de Firebase (compat) y de
 *     firebase-config.js en index.html.
 */

if (!window.__FIREBASE_CONFIG__) {
    console.error('[FirebaseSaveSystem] No se encontró window.__FIREBASE_CONFIG__. ' +
        'Verificá que index.html cargue firebase-config.js ANTES de este script.');
}
const firebaseConfig = window.__FIREBASE_CONFIG__ || {};

firebase.initializeApp(firebaseConfig);
const _auth = firebase.auth();
const _db = firebase.firestore();
const _functions = firebase.functions();
const _syncProgressFn = _functions.httpsCallable('syncProgress');
const _clearProgressFn = _functions.httpsCallable('clearProgress');

// Analytics: instancia diferida hasta que haya consentimiento explícito (ver
// window.__initAnalyticsIfNeeded más abajo). Antes se llamaba acá mismo sin
// preguntar nada; ahora consent.js decide cuándo (o si) esto pasa.
let _analyticsInstance = null;
window.__initAnalyticsIfNeeded = function () {
    if (_analyticsInstance) return _analyticsInstance; // ya inicializado, no duplicar
    try {
        _analyticsInstance = firebase.analytics();
        console.info('[FirebaseSaveSystem] Analytics inicializado (con consentimiento del usuario).');
    } catch (e) {
        console.warn('[FirebaseSaveSystem] Analytics no disponible:', e);
    }
    return _analyticsInstance;
};

// Caché de Firestore en disco del propio SDK (además de nuestra copia en localStorage).
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
    ready: null,
    _readyResolve: null,

    // ================= LECTURA / ESCRITURA =================

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
    onRemoteData(callback) {
        this._remoteListeners.push(callback);
    },
    _notifyRemote(keys) {
        this._remoteListeners.forEach(cb => {
            try { cb(keys); } catch (e) { console.warn('[FirebaseSaveSystem] Error en listener onRemoteData:', e); }
        });
    },

    // ================= ESTADO DE GUARDADO =================
    // Único punto que emite el evento que escucha save-indicator.js.
    _setStatus(status) {
        document.dispatchEvent(new CustomEvent('savesystem:status', { detail: { status } }));
    },

    // ================= SINCRONIZACIÓN (nunca bloquea, nunca rompe) =================
    _scheduleSync() {
        clearTimeout(this._pushTimer);
        // Debounce propio: NO pasa por TimerManager a propósito. Este timer
        // sincroniza progreso con la nube independientemente de que haya una
        // partida en curso; cancelarlo al volver al menú (TimerManager.clearAll)
        // arriesgaría perder el último guardado pendiente. Ver src/timers.js.
        this._pushTimer = setTimeout(() => this._pushDirty(), _SYNC_DEBOUNCE_MS);
    },

    async _pushDirty() {
        if (!this._uid || this._dirty.size === 0) return;

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            this._setStatus('offline');
            return; // se reintentará en el próximo set() o al volver la conexión (ver online listener abajo)
        }

        const keys = Array.from(this._dirty);
        this._dirty.clear();
        const patch = {};
        keys.forEach(k => {
            try {
                patch[k] = JSON.parse(JSON.stringify(this._cache[k]));
            } catch (e) {
                console.warn(`[FirebaseSaveSystem] No se pudo serializar la key "${k}", se omite este ciclo de sync:`, e);
            }
        });

        this._setStatus(this._retrying ? 'retrying' : 'saving');
        try {
            await _syncProgressFn(patch);
            this._retrying = false;
            this._setStatus('saved');
        } catch (e) {
            console.warn('[FirebaseSaveSystem] No se pudo sincronizar con el servidor, se sigue jugando con la caché local. Reintentará:', e.code || e);
            keys.forEach(k => this._dirty.add(k));
            this._retrying = true;
            this._setStatus('error');
            this._scheduleSync(); // reintento automático tras el mismo debounce
        }
    },

    async flush() {
        clearTimeout(this._pushTimer);
        await this._pushDirty();
    },

    // ================= CARGA INICIAL AL INICIAR SESIÓN =================
    async _pullRemote(uid) {
        try {
            const snap = await _db.collection(PLAYERS_COLLECTION).doc(uid).get();
            if (!snap.exists) return;
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

    // ================= FIX: asegurar que exista el documento remoto =================
    // Se llama SIEMPRE tras un login exitoso (nuevo o existente). Si el
    // usuario nunca generó progreso (o generó progreso mientras jugaba de
    // invitado y recién ahora inicia sesión), fuerza un guardado inmediato
    // de lo que haya en memoria para que /players/{uid} exista desde el
    // primer momento, en vez de esperar al primer .save() real del gameplay.
    async _ensureRemoteDocument() {
        try {
            if (typeof PlayerProfile !== 'undefined' && typeof PlayerProfile.save === 'function') PlayerProfile.save();
            if (typeof Progression !== 'undefined' && typeof Progression.save === 'function') Progression.save();
            if (typeof AchievementManager !== 'undefined') {
                if (typeof AchievementManager.saveStats === 'function') AchievementManager.saveStats();
                if (typeof AchievementManager.saveState === 'function') AchievementManager.saveState();
            }
        } catch (e) {
            console.warn('[FirebaseSaveSystem] No se pudo preparar el guardado inicial:', e);
        }
        // .save() de arriba ya marcó las keys como dirty vía SaveSystem.set();
        // acá forzamos que se empuje YA, sin esperar los 2.5s de debounce.
        await this.flush();
    },

    // ================= BORRADO TOTAL DE PROGRESO =================
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
                // FIX: garantiza que el doc en /players/{uid} exista siempre,
                // aunque el usuario todavía no haya jugado nada.
                await this._ensureRemoteDocument();
                document.dispatchEvent(new CustomEvent('savesystem:login', { detail: { uid: user.uid, user } }));
            } else {
                document.dispatchEvent(new CustomEvent('savesystem:logout'));
            }
            if (firstCheck) { firstCheck = false; this._readyResolve(); }
        });
        window.addEventListener('beforeunload', () => { this._pushDirty(); });
        // Reintenta apenas vuelve la conexión, en vez de esperar al próximo set().
        window.addEventListener('online', () => { if (this._dirty.size > 0) this._pushDirty(); });
        window.addEventListener('offline', () => this._setStatus('offline'));
    }
};

SaveSystem.init();
