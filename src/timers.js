/**
 * TIMERS.js — Registro centralizado de setTimeout/setInterval del JUEGO (no de
 * infraestructura como FirebaseSaveSystem, que sincroniza en segundo plano
 * independientemente de si hay una partida en curso).
 *
 * PROBLEMA QUE RESUELVE:
 * Antes, cada archivo (player.js, events.js, achievements.js, level.js, ...)
 * llamaba a setTimeout/setInterval nativos directamente. Si el jugador moría,
 * volvía al menú o arrancaba una partida nueva mientras alguno de esos timers
 * seguía pendiente (ej: la recarga bala-a-bala del Winchester, una ráfaga de
 * FAMAS a mitad de camino, el rayo de la tormenta, un toast por desaparecer),
 * el callback igual se ejecutaba más tarde, potencialmente sobre un
 * `game.player` ya destruido/reemplazado -> errores o efectos fantasma.
 *
 * USO (en cualquier archivo del juego, cargado después de este script):
 *   TimerManager.setTimeout(() => { ... }, 500);
 *   TimerManager.setInterval(() => { ... }, 50);
 *   TimerManager.clearAll();   // cancela TODO lo pendiente registrado acá
 *
 * QUÉ NO PASA POR ACÁ (a propósito):
 * - FirebaseSaveSystem._pushDirty/_scheduleSync: es sincronización en segundo
 *   plano del progreso guardado, independiente de que haya una partida activa.
 *   Cancelarlo al volver al menú arriesgaría perder el último guardado.
 * - MusicManager (fundidos de música / next-on-ended): es un efecto de audio
 *   transversal a menús y partidas, no referencia estado de la partida
 *   (player/enemies), así que no hay riesgo de "callback sobre objeto
 *   destruido" y cancelarlo a mitad de un fundido sonaría mal.
 * - Timers de arranque (boot.js: withTimeout) corren ANTES de que exista
 *   ninguna partida.
 */
const TimerManager = {
    _timeouts: new Set(),
    _intervals: new Set(),

    setTimeout(fn, delay, ...args) {
        const id = globalThis.setTimeout((...a) => {
            this._timeouts.delete(id);
            fn(...a);
        }, delay, ...args);
        this._timeouts.add(id);
        return id;
    },

    setInterval(fn, delay, ...args) {
        const id = globalThis.setInterval(fn, delay, ...args);
        this._intervals.add(id);
        return id;
    },

    clearTimeout(id) {
        globalThis.clearTimeout(id);
        this._timeouts.delete(id);
    },

    clearInterval(id) {
        globalThis.clearInterval(id);
        this._intervals.delete(id);
    },

    // Cancela TODO lo pendiente registrado. Se llama desde:
    //   - game.gameOver (player.js -> Player.takeDamage cuando hp<=0)
    //   - game.goToMainMenu (ui.js)
    //   - game.playAgain / inicio de game.init (main.js)
    clearAll() {
        this._timeouts.forEach(id => globalThis.clearTimeout(id));
        this._timeouts.clear();
        this._intervals.forEach(id => globalThis.clearInterval(id));
        this._intervals.clear();
    },

    // Utilidad de debug/tests: cuántos timers hay pendientes ahora mismo.
    pendingCount() {
        return this._timeouts.size + this._intervals.size;
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = TimerManager;
