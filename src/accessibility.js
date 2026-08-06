/**
 * ACCESSIBILITY.js — Base de accesibilidad.
 *
 * 1) KeyBindings: remapeo de teclas. Todas las acciones lógicas del juego
 *    (moveUp/moveDown/moveLeft/moveRight/dash/reload/pause/slot1..5) apuntan
 *    a un `event.code` configurable, guardado en localStorage. El resto del
 *    juego (main.js, player.js) NO debería volver a leer códigos hardcodeados:
 *    consulta `KeyBindings.action(code)` (código físico -> acción lógica) en
 *    el listener de teclado, y guarda flags en `game.keys[ACTION]` en vez de
 *    `game.keys[event.code]`. Esto es un cambio pequeño y localizado en el
 *    listener de main.js y en los `keys['KeyW']` de player.js/mobile.js (ver
 *    INTEGRATION.md para el diff exacto).
 *
 * 2) Modo daltónico: agrega/quita `body.colorblind-mode`. Primera etapa: un
 *    filtro global (deuteranopía, el tipo más común) vía CSS `filter`, que no
 *    requiere retocar cada color hardcodeado del HUD/canvas. Preparado para
 *    reemplazarse a futuro por paletas específicas por tipo de daltonismo
 *    (protanopía/tritanopía) sin cambiar la API pública (`Accessibility.setColorblindMode`).
 *
 * 3) GamepadInput: abstracción mínima pero funcional. Traduce el stick
 *    izquierdo y los botones más comunes al mismo formato que ya consume el
 *    juego (`game.keys[...]`, `game.mouse`), así player.js/main.js no
 *    necesitan saber que existe un gamepad. Se debe llamar a
 *    `GamepadInput.poll()` una vez por frame (ver hook en main.js `_frame`).
 */
const DEFAULT_KEYBINDINGS = {
    moveUp: 'KeyW', moveDown: 'KeyS', moveLeft: 'KeyA', moveRight: 'KeyD',
    dash: 'Space', reload: 'KeyR', pause: 'Escape',
    slot1: 'Digit1', slot2: 'Digit2', slot3: 'Digit3', slot4: 'Digit4', slot5: 'Digit5'
};

const KeyBindings = {
    _bindings: null,

    load() {
        if (this._bindings) return this._bindings;
        try {
            const raw = localStorage.getItem('slime_keybindings');
            this._bindings = raw ? Object.assign({}, DEFAULT_KEYBINDINGS, JSON.parse(raw)) : { ...DEFAULT_KEYBINDINGS };
        } catch (e) {
            this._bindings = { ...DEFAULT_KEYBINDINGS };
        }
        return this._bindings;
    },

    save() {
        try { localStorage.setItem('slime_keybindings', JSON.stringify(this._bindings)); } catch (e) { /* no-op */ }
    },

    // Código físico configurado para una acción lógica (ej: codeFor('dash') -> 'Space')
    codeFor(action) {
        return this.load()[action] || DEFAULT_KEYBINDINGS[action];
    },

    // Acción lógica asociada a un código físico (ej: action('KeyW') -> 'moveUp'),
    // o null si ese código no está atado a ninguna acción remapeable.
    action(code) {
        const b = this.load();
        return Object.keys(b).find(action => b[action] === code) || null;
    },

    rebind(action, newCode) {
        if (!(action in DEFAULT_KEYBINDINGS)) return false;
        this.load()[action] = newCode;
        this.save();
        return true;
    },

    resetToDefaults() {
        this._bindings = { ...DEFAULT_KEYBINDINGS };
        this.save();
    }
};

const Accessibility = {
    setColorblindMode(enabled) {
        document.body.classList.toggle('colorblind-mode', !!enabled);
        try { localStorage.setItem('slime_colorblind', enabled ? '1' : '0'); } catch (e) { /* no-op */ }
    },
    isColorblindMode() {
        try { return localStorage.getItem('slime_colorblind') === '1'; } catch (e) { return false; }
    },
    init() {
        this.setColorblindMode(this.isColorblindMode());
    }
};

/**
 * GamepadInput — mapeo mínimo (Xbox/PlayStation estándar vía Gamepad API):
 *   Stick izquierdo -> movimiento (mismas flags que WASD: game.keys.moveUp, etc.)
 *   Botón A/Cross (0) -> dash
 *   Botón X/Square (2) -> recargar
 *   Gatillo derecho (7) o botón derecho del stick -> disparo (game.mouse.down)
 *   Stick derecho -> apunta relativo (mueve game.mouse.x/y de forma incremental,
 *   ya que no hay una posición absoluta de "mouse" con gamepad)
 *
 * No sustituye mouse/teclado: si hay un gamepad conectado Y el jugador lo
 * mueve, sus valores pisan a los del teclado ese frame (mismo patrón que ya
 * usa mobile.js con el joystick táctil).
 */
const GamepadInput = {
    deadzone: 0.18,
    aimSpeed: 14,

    poll() {
        if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
        const pads = navigator.getGamepads();
        const gp = pads && pads[0];
        if (!gp || typeof game === 'undefined' || game.paused) return;

        const lx = gp.axes[0] || 0, ly = gp.axes[1] || 0;
        if (Math.hypot(lx, ly) > this.deadzone) {
            game.keys[KeyBindings.codeFor('moveLeft')] = lx < -this.deadzone;
            game.keys[KeyBindings.codeFor('moveRight')] = lx > this.deadzone;
            game.keys[KeyBindings.codeFor('moveUp')] = ly < -this.deadzone;
            game.keys[KeyBindings.codeFor('moveDown')] = ly > this.deadzone;
        }

        const rx = gp.axes[2] || 0, ry = gp.axes[3] || 0;
        if (Math.hypot(rx, ry) > this.deadzone) {
            game.mouse.x += rx * this.aimSpeed;
            game.mouse.y += ry * this.aimSpeed;
        }

        game.mouse.down = !!(gp.buttons[7] && gp.buttons[7].pressed);
        if (gp.buttons[0] && gp.buttons[0].pressed && !this._prevDash) game.player && game.player.dash();
        this._prevDash = gp.buttons[0] && gp.buttons[0].pressed;
        if (gp.buttons[2] && gp.buttons[2].pressed && !this._prevReload) game.reload && game.reload();
        this._prevReload = gp.buttons[2] && gp.buttons[2].pressed;
    }
};

window.addEventListener('DOMContentLoaded', () => Accessibility.init());

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { KeyBindings, Accessibility, GamepadInput, DEFAULT_KEYBINDINGS };
}
