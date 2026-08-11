/**
 * BOOT.js — Orquestador único del arranque del juego.
 *
 * NUEVO ORDEN (fix auth/popup-blocked):
 *   1. Pantalla de carga (assets)
 *   2. CLICK PARA EMPEZAR (primer gesto de usuario: desbloquea audio)
 *   3. Recién ahí se muestra Login (si no hay sesión ya persistida)
 *   4. "Continuar con Google" llama a signInWithPopup() DIRECTO, en la misma
 *      línea síncrona del listener de click — sin await, sin setTimeout, sin
 *      pasar por ninguna promesa intermedia — para que el navegador SIEMPRE
 *      lo reconozca como una acción directa del usuario y no bloquee el popup.
 *
 * Ningún otro archivo debe tocar #loading-screen/#login-screen/#clickstart-screen.
 *
 * NOTA (timers): los setTimeout de este archivo son deliberadamente nativos,
 * no pasan por TimerManager (src/timers.js): corren ANTES de que exista
 * ninguna partida, así que no hay ningún estado de juego que puedan referenciar
 * de forma inválida.
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

        // SIEMPRE se pasa primero por "CLICK PARA EMPEZAR", haya o no sesión
        // persistida. Es el único punto de la carga inicial garantizado como
        // gesto de usuario, y de ahí en más cualquier popup (login) cuelga de
        // un click real, nunca de código que corrió solo tras promesas/timers.
        this.showClickStart();
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

    // Desbloquea el <audio> de MusicManager con un play()/pause() síncrono
    // dentro del gesto de usuario. Los navegadores permiten reproducir audio
    // más tarde por código (ej: dentro del .then() del login por Google, que
    // ya NO está atado a un click directo) si ese MISMO elemento <audio> ya
    // reprodujo una vez dentro de un gesto real. No requiere sonido audible:
    // se pausa en el mismo tick en que arranca.
    _unlockAudio() {
        if (typeof MusicManager !== 'undefined' && MusicManager.audio) {
            const p = MusicManager.audio.play();
            if (p && p.then) p.then(() => MusicManager.audio.pause()).catch(() => {});
        }
    },

    // Entra efectivamente al lobby (invitado, o después de un login exitoso).
    unlockAndEnter() {
        const clickstart = document.getElementById('clickstart-screen');
        if (clickstart) clickstart.style.display = 'none';
        const login = document.getElementById('login-screen');
        if (login) login.style.display = 'none';

        if (typeof MusicManager !== 'undefined') MusicManager.playLobby();

        const lobbyScreen = document.getElementById('lobby-screen');
        if (lobbyScreen) lobbyScreen.style.display = 'grid';
        if (typeof AuthUI !== 'undefined') AuthUI.refresh();
        if (typeof game.refreshLobbyPanels === 'function') game.refreshLobbyPanels();
    }
};

window.addEventListener('DOMContentLoaded', () => {
    const googleBtn = document.getElementById('login-google-btn');
    const guestBtn = document.getElementById('login-guest-btn');
    const clickstart = document.getElementById('clickstart-screen');

    // --- CLICK PARA EMPEZAR: primer gesto de usuario de toda la sesión ---
    if (clickstart) {
        clickstart.addEventListener('click', () => {
            BootFlow._unlockAudio(); // desbloqueo de audio dentro del gesto real
            clickstart.style.display = 'none';
            if (SaveSystem.currentUser) {
                // Ya había sesión persistida (Google recordado): entra directo,
                // sin volver a mostrar el login.
                BootFlow.unlockAndEnter();
            } else {
                BootFlow.showLogin();
            }
        }, { once: true });
    }

    // --- LOGIN: botón de Google. signInWithPopup() se llama DIRECTO acá,
    // como primera instrucción del listener, sin await ni setTimeout previos,
    // para que el navegador lo trate siempre como una acción directa del
    // usuario y nunca lo bloquee (fix auth/popup-blocked). ---
    if (googleBtn) {
        googleBtn.addEventListener('click', () => {
            googleBtn.disabled = true;
            const provider = new firebase.auth.GoogleAuthProvider();
            firebase.auth().signInWithPopup(provider)
                .then(() => {
                    googleBtn.disabled = false;
                    BootFlow.unlockAndEnter();
                })
                .catch(err => {
                    console.warn('[Auth] Login con Google falló:', err && (err.code || err));
                    googleBtn.disabled = false;
                    // Si el popup fue bloqueado o cerrado, dejamos al usuario en
                    // la pantalla de login para que pueda reintentar con otro click.
                });
        });
    }

    if (guestBtn) guestBtn.addEventListener('click', () => BootFlow.unlockAndEnter());

    BootFlow.run();
});
