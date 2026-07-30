/**
 * AUTH-UI.js
 * Capa fina de interfaz para iniciar/cerrar sesión desde el lobby.
 * A propósito NO conoce nada de Firebase: solo llama a los métodos públicos que
 * expone SaveSystem (signInWithGoogle / signOut / currentUser), definidos en
 * FirebaseSaveSystem.js, y reacciona a los eventos 'savesystem:login' /
 * 'savesystem:logout' que ese módulo dispara sobre `document`.
 *
 * Debe cargarse DESPUÉS de FirebaseSaveSystem.js (usa SaveSystem) y después de
 * main.js (el botón vive dentro del innerHTML del lobby que arma main.js).
 */
const AuthUI = {
    handleClick() {
        if (SaveSystem.currentUser) SaveSystem.signOut();
        else SaveSystem.signInWithGoogle();
    },

    currentLabel() {
        const u = SaveSystem.currentUser;
        return u ? (u.displayName || u.email || 'Cuenta conectada') : 'Invitado (local)';
    },

    // Repinta el botón/estado del lobby con el estado actual de sesión. Se llama:
    // - al cargar la página (por si Firebase ya tenía sesión guardada)
    // - cada vez que main.js reconstruye el innerHTML del lobby
    // - en los eventos savesystem:login / savesystem:logout
    refresh() {
        const statusEl = document.getElementById('auth-status');
        const btnEl = document.getElementById('auth-btn');
        if (!statusEl || !btnEl) return;
        const u = SaveSystem.currentUser;
        if (u) {
            statusEl.innerText = `✅ Conectado como ${u.displayName || u.email}`;
            btnEl.innerText = '🚪 CERRAR SESIÓN';
        } else {
            statusEl.innerText = '👤 Invitado — tu progreso solo se guarda en este dispositivo';
            btnEl.innerText = '🔑 INICIAR SESIÓN CON GOOGLE';
        }
    }
};

document.addEventListener('savesystem:login', () => AuthUI.refresh());
document.addEventListener('savesystem:logout', () => AuthUI.refresh());
window.addEventListener('DOMContentLoaded', () => AuthUI.refresh());
