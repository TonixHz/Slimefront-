# SLIMEFRONT v0.9

Un juego de defensa en tiempo real contra olas infinitas de zombies slime. ¡Dispara, mejora, sobrevive!

## 🎮 Características

- **Sistema de Combate Dinámico**: 20+ armas con mecánicas únicas (shotgun con perdigones, FAMAS con ráfagas, RPG con explosiones, etc.)
- **Progresión Permanente**: Mejoras entre partidas (Vitalidad, Resistencia, Velocidad, Poder, Fortuna)
- **Sistema de Eventos Dinámicos**: 12+ eventos que modifican la partida (lluvia, tormenta, mutación, invasión, etc.)
- **Logros Desbloqueables**: 50+ logros categorizados con recompensas de XP, dinero y cosméticos
- **Enemigos Variados**: BASIC, FAST, TANK, RANGED, INVISIBLE, KAMIKAZE, GHOST, BOSS (con patrones únicos)
- **Gráficos Configurables**: Presets LOW, MEDIUM, PRO para diferentes capacidades
- **Música Dinámica**: Cambio automático de música según contexto (lobby, combate, jefe)
- **Físicas Optimizadas**: Grid espacial para colisiones eficientes con +200 entities activas

## 🚀 Cómo Jugar

1. Abre `index.html` en un navegador moderno (Chrome, Firefox, Edge)
2. Haz clic en la pantalla de carga
3. Presiona **JUGAR**

### Controles (PC)

- **WASD**: Movimiento
- **MOUSE**: Apuntar y disparar
- **Click**: Disparar (mientras el ratón esté abajo)
- **R**: Recargar
- **SHIFT**: Sprint
- **ESPACIO**: Dash (cambio rápido de posición)
- **ESC**: Pausa / Menú
- **1-5**: Cambiar arma (también con clic en hotbar)

## 🛠️ Estructura del Proyecto

```
├── index.html          # Página principal con meta tags y pantalla de carga
├── style.css           # Estilos CSS modernos y responsive
├── main.js             # Loop principal del juego
├── player.js           # Clase Player y mecánicas de disparo/movimiento
├── enemies.js          # Clases Enemy y Projectile
├── weapons.js          # Base de datos de armas (WEAPONS_DB)
├── level.js            # Sistema de XP/Nivel y perfil del jugador
├── progression.js      # Mejoras permanentes entre partidas
├── achievements.js     # Sistema de logros y estadísticas
├── events.js           # Eventos dinámicos que modifican el juego
├── world.js            # Terreno procedural y tienda de armas
├── effects.js          # Audio (SFX y música), partículas, cámara
├── ui.js               # Menús, ajustes, gráficos
└── mobile.js           # Controles táctiles (deshabilitados en v0.9)
```

## 📊 Datos Clave

- **Olas**: Escalado exponencial, cada ola +8 enemigos base
- **Armas**: 21 armas totales distribuidas en 8 categorías
- **Enemigos**: 8 tipos básicos + BOSS con patrones especiales
- **Eventos**: 12 eventos dinámicos que pueden ocurrir cada ola (~25% probabilidad)
- **Mejoras**: 5 mejoras permanentes, 5 niveles cada una
- **Logros**: 50+ logros en 8 categorías

## 🎵 Créditos

### Música
- Tetuano - Abyss
- Pufino - Metal Is Trash & Digital Mayham
- Zambolino - Imperator
- (Fuente: freetouse.com)

### Efectos de Sonido
- Google Sounds API
- Freesound.org
- Zapsplat.com

### Tipografía
- Teko (Google Fonts)

## ⚙️ Desarrollo

### Requisitos
- Navegador moderno (Chrome 80+, Firefox 75+, Edge 80+)
- No requiere instalación ni servidor

### Optimizaciones Aplicadas (v0.9)
- Object Pooling para partículas, casings, proyectiles
- Grid espacial para colisiones eficientes
- Frame skipping inteligente para IA a larga distancia
- Escalado automático de partículas según carga
- Audios precargados para evitar delay
- CSS variables para temas dinámicos

## 🐛 Problemas Conocidos

- Audios: URLs públicas pueden tener latencia en primeras cargas
- Música: Algunos navegadores requieren interacción del usuario antes de reproducir

## 📝 Cambios v0.9

- ✅ Pantalla de carga interactiva
- ✅ Audios reemplazados con URLs públicas (sin 404)
- ✅ Créditos accesibles desde lobby
- ✅ Meta tags para SEO
- ✅ Favicon dinámico (SVG)
- ✅ Controles móviles deshabilitados (solo PC)
- ✅ Documentación completa

## 📄 Licencia

Proyecto personal. La música y SFX usan fuentes libres de derechos.

---

**SLIMEFRONT v0.9** • Hecho con ❤️ en Canvas 2D
