/**
 * I18N.js — Sistema centralizado de traducciones.
 *
 * Objetivo de esta primera etapa: NO traducir el juego todavía (sigue 100% en
 * español), sino sacar los textos visibles de la UI de estar hardcodeados y
 * repartidos por HTML/JS, y dejarlos en un único diccionario por idioma
 * (src/i18n/es.js), para que agregar un idioma nuevo en el futuro sea:
 *
 *   1. Crear src/i18n/en.js con I18N.register('en', {...mismas claves...})
 *   2. Agregar <script src="src/i18n/en.js"></script> en index.html
 *   3. Agregar el idioma al selector (I18N.setLang('en'))
 *
 * y NO tocar ningún otro archivo del juego.
 *
 * USO:
 *   I18N.t('menu.play')                       -> "Jugar"
 *   I18N.t('hud.wave', { n: 3 })               -> reemplaza {n} en la plantilla
 *   <button data-i18n="menu.play">Jugar</button>  -> I18N.applyDOM() lo completa
 *   <input data-i18n-placeholder="search.placeholder">
 *
 * Si una clave no existe en el idioma activo, cae al español (idioma base) y,
 * si tampoco existe ahí, devuelve la clave tal cual (nunca rompe la UI ni deja
 * "undefined" visible).
 */
const I18N = {
    lang: (typeof localStorage !== 'undefined' && localStorage.getItem('slime_lang')) || 'es',
    fallbackLang: 'es',
    dict: {},

    register(lang, strings) {
        this.dict[lang] = Object.assign(this.dict[lang] || {}, strings);
    },

    setLang(lang) {
        this.lang = lang;
        try { localStorage.setItem('slime_lang', lang); } catch (e) { /* no-op */ }
        this.applyDOM();
    },

    t(key, vars) {
        let str = (this.dict[this.lang] && this.dict[this.lang][key]);
        if (str === undefined) str = (this.dict[this.fallbackLang] && this.dict[this.fallbackLang][key]);
        if (str === undefined) str = key; // último recurso: nunca romper la UI
        if (vars) {
            Object.keys(vars).forEach(k => {
                str = str.split(`{${k}}`).join(vars[k]);
            });
        }
        return str;
    },

    // Recorre el DOM buscando data-i18n / data-i18n-placeholder / data-i18n-title
    // y completa el texto. Se llama una vez al cargar y cada vez que se
    // reconstruye HTML dinámico (ej: game.buildLobby en main.js).
    applyDOM(root) {
        const scope = root || (typeof document !== 'undefined' ? document : null);
        if (!scope) return;
        scope.querySelectorAll('[data-i18n]').forEach(el => {
            el.innerText = this.t(el.getAttribute('data-i18n'));
        });
        scope.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            el.setAttribute('placeholder', this.t(el.getAttribute('data-i18n-placeholder')));
        });
        scope.querySelectorAll('[data-i18n-title]').forEach(el => {
            el.setAttribute('title', this.t(el.getAttribute('data-i18n-title')));
        });
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = I18N;
if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => I18N.applyDOM());
}
