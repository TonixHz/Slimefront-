/**
 * CONSENT.js — Consentimiento para Firebase Analytics.
 *
 * Requisito: Analytics sigue existiendo, pero NUNCA se inicializa hasta que el
 * usuario elige explícitamente. La elección se recuerda (localStorage) y se
 * puede cambiar en cualquier momento desde Ajustes -> Privacidad.
 *
 * Contrato con FirebaseSaveSystem.js:
 *   - FirebaseSaveSystem.js YA NO llama a `firebase.analytics()` directamente.
 *     En su lugar expone `window.__initAnalyticsIfNeeded()`, que:
 *       - crea la instancia de Analytics si `ConsentManager.hasConsent()`
 *       - no hace nada si el usuario rechazó o todavía no respondió
 *   - Este archivo llama a esa función apenas hay consentimiento (al cargar,
 *     si ya había una decisión previa; o al aceptar el banner ahora).
 *
 * La decisión se guarda como:
 *   localStorage['slime_analytics_consent'] = 'accepted' | 'rejected'
 * (ausente = todavía no se preguntó -> se muestra el banner)
 */
const ConsentManager = {
    KEY: 'slime_analytics_consent',

    getDecision() {
        try { return localStorage.getItem(this.KEY); } catch (e) { return null; }
    },

    hasConsent() {
        return this.getDecision() === 'accepted';
    },

    setDecision(value) {
        try { localStorage.setItem(this.KEY, value); } catch (e) { /* modo privado, etc */ }
        if (value === 'accepted' && typeof window.__initAnalyticsIfNeeded === 'function') {
            window.__initAnalyticsIfNeeded();
        }
        this._updateSettingsLabel();
    },

    accept() { this.setDecision('accepted'); this.hideBanner(); },
    reject() { this.setDecision('rejected'); this.hideBanner(); },

    // Permite volver a decidir desde Ajustes -> Privacidad, sin esperar a que
    // se borre localStorage. Reaparece el banner encima de lo que haya abierto.
    reconsider() {
        this.showBanner();
    },

    _updateSettingsLabel() {
        const el = document.getElementById('consent-current-status');
        if (!el) return;
        const decision = this.getDecision();
        el.innerText = decision === 'accepted'
            ? '✅ Estadísticas activadas'
            : (decision === 'rejected' ? '🚫 Estadísticas desactivadas' : '❔ Aún no decidido');
    },

    buildBannerHTML() {
        return `
        <div class="consent-panel">
            <div class="consent-title">${I18N.t('consent.title')}</div>
            <p class="consent-body">${I18N.t('consent.body')}</p>
            <a class="consent-link" href="legal/privacy-policy.html" target="_blank" rel="noopener">${I18N.t('consent.learn_more')}</a>
            <div class="consent-actions">
                <button class="menu-btn" id="consent-reject-btn">${I18N.t('consent.reject')}</button>
                <button class="menu-btn primary" id="consent-accept-btn">${I18N.t('consent.accept')}</button>
            </div>
        </div>`;
    },

    ensureBannerEl() {
        let el = document.getElementById('consent-banner');
        if (!el) {
            el = document.createElement('div');
            el.id = 'consent-banner';
            el.className = 'consent-banner';
            document.body.appendChild(el);
        }
        el.innerHTML = this.buildBannerHTML();
        document.getElementById('consent-accept-btn').addEventListener('click', () => this.accept());
        document.getElementById('consent-reject-btn').addEventListener('click', () => this.reject());
        return el;
    },

    showBanner() {
        const el = this.ensureBannerEl();
        el.style.display = 'flex';
        requestAnimationFrame(() => el.classList.add('show'));
    },

    hideBanner() {
        const el = document.getElementById('consent-banner');
        if (!el) return;
        el.classList.remove('show');
        setTimeout(() => { el.style.display = 'none'; }, 250);
    },

    init() {
        this._updateSettingsLabel();
        const decision = this.getDecision();
        if (decision === 'accepted' && typeof window.__initAnalyticsIfNeeded === 'function') {
            window.__initAnalyticsIfNeeded();
        }
        if (!decision) {
            // Primera vez que se abre el juego: se muestra apenas el DOM está listo,
            // por encima de la pantalla de carga/login (z-index en assets/patch.css).
            this.showBanner();
        }
    }
};

window.addEventListener('DOMContentLoaded', () => ConsentManager.init());

if (typeof module !== 'undefined' && module.exports) module.exports = ConsentManager;
