/**
 * Controles táctiles de SLIMEFRONT.
 * Se carga después de boot.js y no cambia los controles de teclado/ratón en PC.
 */
(() => {
    const touchQuery = window.matchMedia('(pointer: coarse)');
    if (!touchQuery.matches) return;

    const controls = document.getElementById('mobile-controls');
    const joystickZone = document.getElementById('joystick-zone');
    const joystickKnob = document.getElementById('joystick-knob');
    const aimZone = document.getElementById('aim-zone');
    const dashButton = document.getElementById('mobile-dash-btn');
    const reloadButton = document.getElementById('mobile-reload-btn');
    const uiLayer = document.getElementById('ui-layer');
    const gameOverScreen = document.getElementById('gameover-screen');
    const pauseScreen = document.getElementById('esc-menu');
    const shopScreen = document.getElementById('shop-menu');

    // No romper el arranque si se edita el HTML y falta algún elemento.
    if (!controls || !joystickZone || !joystickKnob || !aimZone || !dashButton || !reloadButton || !uiLayer) return;

    let joystickTouchId = null;
    let aimTouchId = null;
    let gameStarted = false;

    function currentGame() {
        return typeof game !== 'undefined' && game && game.player ? game : null;
    }

    function updateVisibility() {
        const g = currentGame();
        const inGame = !!g && g.started && !g.paused && uiLayer.style.display !== 'none' &&
            !document.body.classList.contains('lobby-active') &&
            (!gameOverScreen || gameOverScreen.style.display !== 'flex') &&
            (!pauseScreen || pauseScreen.style.display !== 'flex') &&
            (!shopScreen || shopScreen.style.display !== 'block');
        controls.classList.toggle('is-active', inGame);
        if (!inGame) resetAll();
        gameStarted = inGame;
    }

    function updateJoystick(touch) {
        const g = currentGame();
        if (!g || !gameStarted) return;
        const rect = joystickZone.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let dx = touch.clientX - cx;
        let dy = touch.clientY - cy;
        const maxDist = Math.max(1, rect.width * 0.34);
        const dist = Math.min(Math.hypot(dx, dy), maxDist);
        const angle = Math.atan2(dy, dx);
        const kx = Math.cos(angle) * dist;
        const ky = Math.sin(angle) * dist;
        joystickKnob.style.transform = `translate(${kx}px, ${ky}px)`;
        const threshold = maxDist * 0.22;
        g.keys.KeyW = ky < -threshold;
        g.keys.KeyS = ky > threshold;
        g.keys.KeyA = kx < -threshold;
        g.keys.KeyD = kx > threshold;
    }

    function resetJoystick() {
        joystickKnob.style.transform = 'translate(0px, 0px)';
        const g = currentGame();
        if (g && g.keys) {
            g.keys.KeyW = false;
            g.keys.KeyA = false;
            g.keys.KeyS = false;
            g.keys.KeyD = false;
        }
        joystickTouchId = null;
    }

    function resetAim() {
        const g = currentGame();
        if (g && g.mouse) g.mouse.down = false;
        aimTouchId = null;
    }

    function resetAll() {
        resetJoystick();
        resetAim();
    }

    joystickZone.addEventListener('touchstart', e => {
        const g = currentGame();
        if (!g || g.paused || !gameStarted || joystickTouchId !== null) return;
        e.preventDefault();
        joystickTouchId = e.changedTouches[0].identifier;
        updateJoystick(e.changedTouches[0]);
    }, { passive: false });

    joystickZone.addEventListener('touchmove', e => {
        if (joystickTouchId === null) return;
        e.preventDefault();
        for (const t of e.changedTouches) if (t.identifier === joystickTouchId) updateJoystick(t);
    }, { passive: false });

    const endJoystick = e => {
        for (const t of e.changedTouches) if (t.identifier === joystickTouchId) resetJoystick();
    };
    joystickZone.addEventListener('touchend', endJoystick);
    joystickZone.addEventListener('touchcancel', endJoystick);

    aimZone.addEventListener('touchstart', e => {
        const g = currentGame();
        if (!g || g.paused || !gameStarted || aimTouchId !== null) return;
        e.preventDefault();
        const t = e.changedTouches[0];
        aimTouchId = t.identifier;
        g.mouse.x = t.clientX;
        g.mouse.y = t.clientY;
        g.mouse.down = true;
    }, { passive: false });

    aimZone.addEventListener('touchmove', e => {
        if (aimTouchId === null) return;
        e.preventDefault();
        const g = currentGame();
        if (!g || g.paused) return;
        for (const t of e.changedTouches) {
            if (t.identifier === aimTouchId) {
                g.mouse.x = t.clientX;
                g.mouse.y = t.clientY;
            }
        }
    }, { passive: false });

    const endAim = e => {
        for (const t of e.changedTouches) if (t.identifier === aimTouchId) resetAim();
    };
    aimZone.addEventListener('touchend', endAim);
    aimZone.addEventListener('touchcancel', endAim);

    dashButton.addEventListener('touchstart', e => {
        e.preventDefault();
        const g = currentGame();
        if (g && !g.paused) g.player.dash();
    }, { passive: false });
    reloadButton.addEventListener('touchstart', e => {
        e.preventDefault();
        const g = currentGame();
        if (g && !g.paused) g.reload();
    }, { passive: false });

    // Mantiene el estado sincronizado con los cambios de menú/partida.
    const observer = new MutationObserver(updateVisibility);
    observer.observe(uiLayer, { attributes: true, attributeFilter: ['style', 'class'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('blur', resetAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) resetAll(); });
    updateVisibility();
    window.setInterval(updateVisibility, 500);
})();
