const test = require('node:test');
const assert = require('node:assert/strict');
const I18N = require('../../src/i18n.js');

test('I18N.t: devuelve la clave tal cual si no existe en ningún idioma (nunca rompe la UI)', () => {
    assert.equal(I18N.t('clave.que.no.existe'), 'clave.que.no.existe');
});

test('I18N.t: registra y devuelve una traducción simple', () => {
    I18N.register('es', { 'test.hello': 'Hola' });
    assert.equal(I18N.t('test.hello'), 'Hola');
});

test('I18N.t: interpola variables con la sintaxis {var}', () => {
    I18N.register('es', { 'test.wave': 'Oleada {n}' });
    assert.equal(I18N.t('test.wave', { n: 7 }), 'Oleada 7');
});

test('I18N.t: interpola múltiples variables', () => {
    I18N.register('es', { 'test.combo': '{a} y {b}' });
    assert.equal(I18N.t('test.combo', { a: 'uno', b: 'dos' }), 'uno y dos');
});

test('I18N.setLang + fallback: si el idioma activo no tiene la clave, cae al idioma base (es)', () => {
    I18N.register('es', { 'test.only_es': 'Solo en español' });
    I18N.register('fr', {}); // fr existe pero no tiene esta clave
    I18N.lang = 'fr';
    assert.equal(I18N.t('test.only_es'), 'Solo en español');
    I18N.lang = 'es'; // restaurar para no afectar otros tests
});

test('Diccionario base ES: las claves de armazón de UI usadas por el juego existen', () => {
    // src/i18n/es.js es un <script> de navegador: asume que I18N ya es global
    // (así es como lo carga index.html, después de src/i18n.js). Para poder
    // requerirlo tal cual desde un test de Node, exponemos la misma instancia
    // como global antes de cargarlo.
    global.I18N = I18N;
    require('../../src/i18n/es.js');
    ['menu.play', 'menu.settings', 'hud.wave', 'hud.cash', 'save.saved', 'consent.accept'].forEach(key => {
        assert.notEqual(I18N.t(key), key, `Se esperaba una traducción real para "${key}", pero devolvió la clave sin traducir`);
    });
});
