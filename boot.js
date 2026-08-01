/**
 * BOOT.js — Orquestador único del arranque del juego.
 * Orden real: assets -> login -> click para empezar (desbloquea audio) -> lobby.
 * Ningún otro archivo debe tocar #loading-screen/#login-screen/#clickstart-screen.
 *
 * Nota sobre "imágenes": este juego no usa archivos de imagen (todo el arte se
 * dibuja con canvas/vectores), así que ese paso se traduce en preparar
 * tipografía/gráficos, que es el recurso visual real que hace falta cargar.
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
        this.goToLoginOrStart();
    },

    goToLoginOrStart() {
        if (SaveSystem.currentUser) this.showClickStart();
        else this.showLogin();
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

    unlockAndEnter() {
        const clickstart = document.getElementById('clickstart-screen');
        if (clickstart) clickstart.style.display = 'none';

        // Único punto del juego donde se reproduce audio por primera vez: siempre
        // detrás de una interacción real del usuario (este click).
        if (typeof MusicManager !== 'undefined') MusicManager.playLobby();

        const lobbyScreen = document.getElementById('lobby-screen');
        if (lobbyScreen) lobbyScreen.style.display = 'flex';
        if (typeof AuthUI !== 'undefined') AuthUI.refresh();
    }
};

window.addEventListener('DOMContentLoaded', () => {
    const googleBtn = document.getElementById('login-google-btn');
    const guestBtn = document.getElementById('login-guest-btn');
    const clickstart = document.getElementById('clickstart-screen');

    if (googleBtn) {
        googleBtn.addEventListener('click', async () => {
            googleBtn.disabled = true;
            await SaveSystem.signInWithGoogle();
            googleBtn.disabled = false;
            BootFlow.showClickStart();
        });
    }
    if (guestBtn) guestBtn.addEventListener('click', () => BootFlow.showClickStart());
    if (clickstart) clickstart.addEventListener('click', () => BootFlow.unlockAndEnter(), { once: true });

    BootFlow.run();
});
