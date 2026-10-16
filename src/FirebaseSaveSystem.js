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
const _changeDiamondsFn = _functions.httpsCallable('changeDiamonds');
const _DIAMOND_QUEUE_KEY = 'slime_diamond_ops';

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
    _clearingProgress: false,
    _remoteListeners: [],
    _diamondQueue: [],
    _diamondQueuePromise: null,
    ready: null,
    _readyResolve: null,

    // Currency operations are queued durably and applied by a Firestore
    // transaction. operationId makes retries idempotent across reconnects.
    changeDiamonds(delta) {
        delta = Math.trunc(Number(delta));
        if (!Number.isSafeInteger(delta) || delta === 0) return Promise.resolve(false);
        // Never attach guest rewards (or another account's pending rewards) to
        // whichever account happens to log in later. Only queue for the active UID.
        if (!this._uid) return Promise.resolve(false);
        const operationId = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID().replace(/-/g, '')
            : ('op' + Date.now().toString(36) + Math.random().toString(36).slice(2, 18));
        this._diamondQueue.push({ operationId, delta, uid: this._uid });
        this._saveDiamondQueue();
        return this._flushDiamondQueue();
    },

    _loadDiamondQueue() {
        try {
            const raw = localStorage.getItem(_DIAMOND_QUEUE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            // Legacy entries have no owner UID and are intentionally discarded:
            // their original account cannot be established safely.
            this._diamondQueue = Array.isArray(parsed) ? parsed.filter(op =>
                op && typeof op.operationId === 'string' &&
                typeof op.uid === 'string' && op.uid.length > 0 &&
                Number.isSafeInteger(op.delta)) : [];
            this._saveDiamondQueue();
        } catch (e) { this._diamondQueue = []; }
    },

    _saveDiamondQueue() {
        try { localStorage.setItem(_DIAMOND_QUEUE_KEY, JSON.stringify(this._diamondQueue)); } catch (e) {}
    },

    async _flushDiamondQueue() {
        if (this._diamondQueuePromise) return this._diamondQueuePromise;
        if (!this._uid || (typeof navigator !== 'undefined' && navigator.onLine === false)) return false;
        this._diamondQueuePromise = (async () => {
            while (this._uid && this._diamondQueue.length &&
                !(typeof navigator !== 'undefined' && navigator.onLine === false)) {
                const uid = this._uid;
                // Skip operations belonging to other accounts instead of letting
                // one stale queue entry block the active account forever.
                const index = this._diamondQueue.findIndex(op => op.uid === uid);
                if (index === -1) break;
                const operation = this._diamondQueue[index];
                try {
                    const response = await _changeDiamondsFn({
                        operationId: operation.operationId,
                        delta: operation.delta
                    });
                    const balance = Number(response && response.data && response.data.balance);
                    if (!Number.isFinite(balance)) throw new Error('El servidor no devolvió el saldo.');
                    // Auth may have changed while the request was in flight. Keep
                    // the item queued; retrying is safe because operationId is idempotent.
                    if (this._uid !== uid) return false;
                    this._diamondQueue.splice(index, 1);
                    this._saveDiamondQueue();
                    const profile = this.get('profile', {});
                    profile.diamonds = balance;
                    this.set('profile', profile);
                    this._notifyRemote(['profile']);
                } catch (e) {
                    console.warn('[FirebaseSaveSystem] Operación de diamantes pendiente; se reintentará:', e.code || e);
                    return false;
                }
            }
            return true;
        })();
        try { return await this._diamondQueuePromise; }
        finally { this._diamondQueuePromise = null; }
    },

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
        if (!this._clearingProgress) this._scheduleSync();
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
        if (this._clearingProgress) return;
        clearTimeout(this._pushTimer);
        // Debounce propio: NO pasa por TimerManager a propósito. Este timer
        // sincroniza progreso con la nube independientemente de que haya una
        // partida en curso; cancelarlo al volver al menú (TimerManager.clearAll)
        // arriesgaría perder el último guardado pendiente. Ver src/timers.js.
        this._pushTimer = setTimeout(() => this._pushDirty(), _SYNC_DEBOUNCE_MS);
    },

    // Evita dos sincronizaciones simultáneas que puedan enviar snapshots viejos
    // y pisar cambios más recientes. Si entran escrituras durante un envío, el
    // finally programa otro ciclo para las keys que sigan dirty.
    async _pushDirty() {
        if (this._pushPromise) return this._pushPromise;
        this._pushPromise = this._pushDirtyImpl();
        try {
            return await this._pushPromise;
        } finally {
            this._pushPromise = null;
            if (!this._clearingProgress && this._uid && this._dirty.size > 0 && !(typeof navigator !== 'undefined' && navigator.onLine === false)) {
                this._scheduleSync();
            }
        }
    },

    async _pushDirtyImpl() {
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
    // Combina progreso local de invitado con el remoto sin perder máximos ni
    // desbloqueos al iniciar sesión en un dispositivo que ya tenía progreso.
    _mergeProgress(key, local, remote) {
        if (!local || typeof local !== 'object') return remote;
        if (!remote || typeof remote !== 'object') return local;
        const mergeMax = (a, b) => Math.max(Number(a) || 0, Number(b) || 0);
        const mergeArrays = (a, b, id) => {
            const result = new Map();
            [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].forEach(item => {
                const key = id(item);
                if (key !== undefined && key !== null) result.set(String(key), item);
            });
            return [...result.values()];
        };

        if (key === 'progression') {
            const levels = { ...(remote.levels || {}) };
            Object.entries(local.levels || {}).forEach(([name, level]) => {
                levels[name] = mergeMax(level, levels[name]);
            });
            return { ...remote, ...local, levels };
        }
        if (key === 'profile') {
            const merged = { ...remote, ...local };
            ['level', 'xp', 'playTimeSec', 'kills', 'deaths', 'shotsFired', 'shotsHit', 'distance', 'bestWave']
                .forEach(field => { merged[field] = mergeMax(local[field], remote[field]); });
            // Currency is not a cumulative statistic: the server balance wins.
            merged.diamonds = Number.isFinite(Number(remote.diamonds))
                ? Math.max(0, Number(remote.diamonds))
                : Math.max(0, Number(local.diamonds) || 0);
            merged.weaponUsage = { ...(remote.weaponUsage || {}) };
            Object.entries(local.weaponUsage || {}).forEach(([name, count]) => {
                merged.weaponUsage[name] = mergeMax(count, merged.weaponUsage[name]);
            });
            merged.unlocks = mergeArrays(local.unlocks, remote.unlocks,
                item => item && [item.level, item.type].join(':'));
            merged.shotsHit = Math.min(merged.shotsHit, merged.shotsFired);
            return merged;
        }
        if (key === 'achv_stats') {
            const merged = { ...remote, ...local };
            Object.keys({ ...remote, ...local }).forEach(field => {
                const a = local[field], b = remote[field];
                if (typeof a === 'number' || typeof b === 'number') merged[field] = mergeMax(a, b);
                else if (Array.isArray(a) || Array.isArray(b)) {
                    merged[field] = mergeArrays(a, b, item => typeof item === 'object' ? JSON.stringify(item) : item);
                } else if (a && typeof a === 'object' && b && typeof b === 'object') {
                    merged[field] = { ...b, ...a };
                    Object.keys({ ...a, ...b }).forEach(k => { merged[field][k] = mergeMax(a[k], b[k]); });
                }
            });
            merged.heavyWeaponPurchased = !!(local.heavyWeaponPurchased || remote.heavyWeaponPurchased);
            return merged;
        }
        if (key === 'achv_state') {
            const merged = { ...remote };
            Object.entries(local).forEach(([id, state]) => {
                merged[id] = {
                    notified: !!(state && state.notified) || !!(merged[id] && merged[id].notified),
                    claimed: !!(state && state.claimed) || !!(merged[id] && merged[id].claimed)
                };
            });
            return merged;
        }
        return remote;
    },

    async _pullRemote(uid) {
        try {
            const snap = await _db.collection(PLAYERS_COLLECTION).doc(uid).get();
            if (!snap.exists) {
                // Documento nuevo confirmado: es seguro subir el progreso local.
                return true;
            }
            const data = snap.data();
            const changedKeys = [];
            Object.keys(data).forEach(k => {
                if (k === '_updatedAt') return;
                const local = this.get(k, undefined);
                const merged = this._mergeProgress(k, local, data[k]);
                this._cache[k] = merged;
                try { localStorage.setItem(_LOCAL_PREFIX + k, JSON.stringify(merged)); } catch (e) {}
                if (JSON.stringify(merged) !== JSON.stringify(data[k])) this._dirty.add(k);
                changedKeys.push(k);
            });
            if (changedKeys.length) this._notifyRemote(changedKeys);
            if (this._dirty.size) this._scheduleSync();
            return true;
        } catch (e) {
            console.warn('[FirebaseSaveSystem] No se pudo descargar el progreso de la nube; se aplaza la sincronización inicial para evitar sobrescribir datos remotos:', e.code || e);
            return false;
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
        const clearingUid = this._uid;
        // Bloquear nuevos timers mientras esperamos y borramos. Si no, el
        // finally de una sincronización pendiente podría subir datos antiguos
        // justo después de que la Cloud Function eliminara el documento.
        this._clearingProgress = true;
        clearTimeout(this._pushTimer);
        try {
            // Esperar cualquier escritura ya iniciada antes de borrar en la nube.
            if (this._pushPromise) {
                try { await this._pushPromise; } catch (e) { /* el borrado remoto decide el resultado final */ }
            }
            clearTimeout(this._pushTimer);

            // If the account changed while an earlier save was finishing, do
            // not clear the newly signed-in account's remote or local progress.
            if (this._uid !== clearingUid) throw new Error('La cuenta cambió durante el borrado. Volvé a intentarlo.');

            // No tocar la copia local hasta confirmar el borrado remoto. Si falla
            // la red, se conserva el progreso local y se puede volver a intentar.
            if (clearingUid) await _clearProgressFn();

            clearTimeout(this._pushTimer);
            // Clear only this account's pending currency operations. A device
            // may have queued work for another signed-in account while offline.
            this._diamondQueue = clearingUid
                ? this._diamondQueue.filter(op => op.uid !== clearingUid)
                : this._diamondQueue;
            this._saveDiamondQueue();
            // The account could switch while the remote deletion was in flight.
            // In that case, preserve the new account's local cache.
            if (this._uid !== clearingUid) return;
            keys.forEach(k => {
                delete this._cache[k];
                this._dirty.delete(k);
                try { localStorage.removeItem(_LOCAL_PREFIX + k); } catch (e) {}
            });
        } catch (e) {
            console.error('[FirebaseSaveSystem] No se pudo borrar el progreso en la nube:', e.code || e);
            throw e;
        } finally {
            this._clearingProgress = false;
            // Si falló el borrado, el progreso local sigue intacto y puede
            // volver a sincronizarse; nunca reintentar tras un borrado exitoso.
            if (this._dirty.size > 0 && this._uid && !(typeof navigator !== 'undefined' && navigator.onLine === false)) {
                this._scheduleSync();
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
            this._loadDiamondQueue();
            if (user) {
                const pulled = await this._pullRemote(user.uid);
                if (pulled) {
                    this._initialSyncPendingUid = null;
                    // Solo subimos el estado local después de confirmar que la
                    // lectura remota funcionó (o que el documento aún no existe).
                    await this._ensureRemoteDocument();
                    await this._flushDiamondQueue();
                } else {
                    // Si falló la lectura, NO subir caché potencialmente vieja.
                    // Se reintentará al recuperar la conexión.
                    this._initialSyncPendingUid = user.uid;
                }
                document.dispatchEvent(new CustomEvent('savesystem:login', { detail: { uid: user.uid, user } }));
            } else {
                document.dispatchEvent(new CustomEvent('savesystem:logout'));
            }
            if (firstCheck) { firstCheck = false; this._readyResolve(); }
        });
        window.addEventListener('beforeunload', () => { this._pushDirty(); });
        // Reintenta apenas vuelve la conexión, en vez de esperar al próximo set().
        window.addEventListener('online', async () => {
            if (this._uid && this._initialSyncPendingUid === this._uid) {
                const uid = this._uid;
                const pulled = await this._pullRemote(uid);
                if (pulled && this._uid === uid) {
                    this._initialSyncPendingUid = null;
                    await this._ensureRemoteDocument();
                    return;
                }
            }
            if (this._dirty.size > 0) this._pushDirty();
            this._flushDiamondQueue();
        });
        window.addEventListener('offline', () => this._setStatus('offline'));
    }
};

SaveSystem.init();
