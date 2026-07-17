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
