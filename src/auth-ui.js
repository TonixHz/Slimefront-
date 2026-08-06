/**
 * AUTH-UI.js
 * Capa fina de interfaz para iniciar/cerrar sesión desde el lobby.
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
