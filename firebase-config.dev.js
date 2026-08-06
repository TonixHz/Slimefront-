/**
 * FIREBASE-CONFIG.DEV.js — Config del proyecto Firebase de DESARROLLO.
 *
 * Se carga en index.html (versión de desarrollo, con <script> sueltos) ANTES
 * de FirebaseSaveSystem.js. build.js NUNCA copia este archivo al bundle de
 * producción: en su lugar inyecta firebase-config.prod.js, así es imposible
 * publicar en itch.io apuntando por error a la base de datos de desarrollo.
 *
 * Reemplazá estos valores por los de tu propio proyecto Firebase de dev/staging.
 */
window.__FIREBASE_CONFIG__ = {
    apiKey: "AIzaSyCS8jXSpTuSDRRDQO24aGvhR00oKKcbhyY",
    authDomain: "slimefront-dev.firebaseapp.com",
    projectId: "slimefront-dev",
    storageBucket: "slimefront-dev.firebasestorage.app",
    messagingSenderId: "000000000000",
    appId: "1:000000000000:web:0000000000000000000000",
    measurementId: "G-0000000000"
};
window.__FIREBASE_ENV__ = 'development';
