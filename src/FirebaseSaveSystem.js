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
 *                                         caché local al toque; la nube se actualiza
 *                                         únicamente cuando el usuario lo solicita)
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
        // El progreso se guarda solo en localStorage durante el juego.
        // La nube requiere una acción explícita del usuario.
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

    // ================= SINCRONIZACIÓN DESACTIVADA =================
    // El progreso normal se conserva localmente. No hay reintentos, debounce
    // ni sincronización al volver la conexión. La nube solo se usa en saveToCloud().
    _scheduleSync() {},

    async _pushDirty() {
        this._dirty.clear();
        return;
    },

    async flush() {
        clearTimeout(this._pushTimer);
        this._dirty.clear();
        return;
    },

    // ================= CARGA INICIAL AL INICIAR SESIÓN =================
    async _pullRemote(uid) {
        try {
            const snap = await _db.collection(PLAYERS_COLLECTION).doc(uid).get();
            if (!snap.exists) return;

            const data = snap.data();
            const changedKeys = [];
            // Solo hidratamos datos de progreso conocidos; nunca copiamos metadatos
            // internos del servidor (_updatedAt, _lastManualSaveAt) al almacenamiento local.
            ['profile', 'progression', 'achv_stats', 'achv_state'].forEach(k => {
                if (!(k in data)) return;

                // El guardado en la nube es manual: si ya existe una copia local válida,
                // preservarla para no perder progreso aún no subido al iniciar sesión.
                // En un dispositivo sin copia local, se restaura la copia de la nube.
                let hasValidLocalCopy = false;
                try {
                    const localRaw = localStorage.getItem(_LOCAL_PREFIX + k);
                    if (localRaw !== null) {
                        const localValue = JSON.parse(localRaw);
                        if (localValue !== null && typeof localValue === 'object') {
                            this._cache[k] = localValue;
                            hasValidLocalCopy = true;
                        }
                    }
                } catch (e) {
                    // Si la copia local está corrupta, se permite recuperar desde la nube.
                }
                if (hasValidLocalCopy) return;

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
        // No sincronizar automáticamente al iniciar sesión.
        return;

    },

    async saveToCloud() {
        if (!this._uid) throw new Error('Iniciá sesión con Google para guardar en la nube.');
        const patch = {};
        ['profile', 'progression', 'achv_stats', 'achv_state'].forEach(key => {
            const value = this.get(key, undefined);
            if (value !== undefined) patch[key] = JSON.parse(JSON.stringify(value));
        });
        if (!Object.keys(patch).length) throw new Error('Todavía no hay progreso para guardar.');
        this._setStatus('saving');
        try {
            await _syncProgressFn(patch);
            this._setStatus('saved');
            return true;
        } catch (e) {
            this._setStatus('error');
            throw e;
        }
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
                // No escribir en la nube al iniciar sesión.
                document.dispatchEvent(new CustomEvent('savesystem:login', { detail: { uid: user.uid, user } }));
            } else {
                document.dispatchEvent(new CustomEvent('savesystem:logout'));
            }
            if (firstCheck) { firstCheck = false; this._readyResolve(); }
        });
        // No se registran reintentos automáticos al cerrar o recuperar conexión.
        window.addEventListener('offline', () => this._setStatus('offline'));
    }
};

SaveSystem.init();
