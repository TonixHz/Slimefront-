/**
 * SAVE-INDICATOR.js — Indicador discreto de estado de guardado en la nube.
 *
 * Escucha el evento `savesystem:status` que dispara FirebaseSaveSystem.js
 * (ver `_setStatus` en ese archivo) con uno de:
 *   'saving' | 'saved' | 'offline' | 'retrying' | 'error'
 *
 * Se muestra como una pequeña píldora en la esquina inferior izquierda (no
 * invasiva, no bloquea clicks: pointer-events solo en el propio elemento) que
 * aparece al cambiar de estado y se desvanece sola tras "guardado" para no
 * quedar siempre encima de la pantalla.
 */
const SaveIndicator = {
    _hideTimer: null,

    ensureEl() {
        let el = document.getElementById('save-status-indicator');
        if (!el) {
            el = document.createElement('div');
            el.id = 'save-status-indicator';
            el.className = 'save-indicator';
            document.body.appendChild(el);
        }
        return el;
    },

    render(status) {
        const el = this.ensureEl();
        const config = {
            saving:   { icon: '☁️', key: 'save.saving',   cls: 'save-saving' },
            saved:    { icon: '✅', key: 'save.saved',    cls: 'save-saved' },
            offline:  { icon: '📡', key: 'save.offline',  cls: 'save-offline' },
            retrying: { icon: '🔄', key: 'save.retrying', cls: 'save-retrying' },
            error:    { icon: '⚠️', key: 'save.error',    cls: 'save-error' }
        }[status];
        if (!config) return;

        el.className = 'save-indicator ' + config.cls;
        el.innerText = `${config.icon} ${typeof I18N !== 'undefined' ? I18N.t(config.key) : status}`;
        el.style.display = 'flex';
        requestAnimationFrame(() => el.classList.add('show'));

        clearTimeout(this._hideTimer);
        if (status === 'saved') {
            this._hideTimer = setTimeout(() => {
                el.classList.remove('show');
                setTimeout(() => { if (!el.classList.contains('show')) el.style.display = 'none'; }, 300);
            }, 2200);
        }
    },

    init() {
        document.addEventListener('savesystem:status', e => this.render(e.detail.status));
        window.addEventListener('offline', () => this.render('offline'));
        window.addEventListener('online', () => this.render('retrying'));
    }
};

window.addEventListener('DOMContentLoaded', () => SaveIndicator.init());
