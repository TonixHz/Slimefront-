const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
const MAP_SIZE = 4000;
const LOW_ENEMY_THRESHOLD = 20;

const game = {
    player: null,
    enemies: [], props: [], floatingTexts: [],
    // Object Pools
    particles: [], casings: [], projectiles: [], trails: [],
    camera: null,
    wave: 1, isWaveActive: false, paused: false,
    started: false, shadowsEnabled: true, fxEnabled: true,
    keys: {}, mouse: { x: 0, y: 0, down: false },
    lastShot: 0, particleScale: 1, lowEnemyMode: false,
    _inputBound: false,
    _loopCrashed: false, // ver showFatalError() / loop(): una vez en true, el
                          // loop deja de reprogramarse a sí mismo con
                          // requestAnimationFrame, así un error no se repite
                          // 60 veces por segundo en la consola.

    init() {
        // Reset completo: init() ahora puede llamarse más de una vez en la misma
        // sesión de página (Jugar de Nuevo / Volver al Menú y volver a jugar), así
        // que hay que vaciar todo lo que antes solo se llenaba una vez.
        this.enemies = []; this.props = []; this.floatingTexts = [];
        this.particles = []; this.casings = []; this.projectiles = []; this.trails = [];
        this.wave = 1; this.isWaveActive = false; this.paused = false;
        if (typeof EventManager !== 'undefined') EventManager.deactivate();

        this.started = true;
        // La partida está en curso: mostramos el HUD (oculto mientras se ve el lobby).
        const uiLayer = document.getElementById('ui-layer');
        if (uiLayer) uiLayer.style.display = 'block';

        this.player = new Player();
        this.camera = new Camera();
        const gfx = GRAPHICS_PRESETS[Settings.graphics] || GRAPHICS_PRESETS.PRO;
        this.shadowsEnabled = gfx.shadows;
        // Bandera global única para el resto de efectos que no pasan por un Object Pool
        // (camera shake, destello de boca, partículas de clima, tinte ambiental). El
        // preset ULTRA es el único que la apaga; ver GRAPHICS_PRESETS en ui.js.
        this.fxEnabled = !gfx.ultra;

        // Pre-alocar arrays para Object Pooling (el tamaño depende del preset gráfico elegido)
        for(let i=0; i<gfx.particles; i++) this.particles.push(new Particle());
        for(let i=0; i<gfx.casings; i++) this.casings.push(new Casing());
        for(let i=0; i<gfx.projectiles; i++) this.projectiles.push(new Projectile());
        for(let i=0; i<gfx.trails; i++) this.trails.push(new Trail());
        this.particles.forEach(p => p.active = false);
        this.casings.forEach(c => c.active = false);
        this.projectiles.forEach(p => p.active = false);
        this.trails.forEach(t => t.active = false);
        for(let i=0; i<40; i++) this.floatingTexts.push(new FloatingText());
        this.floatingTexts.forEach(t => t.active = false);

        // Generar mapa procedural con props variados y balanceados
        const propTypes = ['rock', 'rock_tall', 'rock_split', 'tree', 'tree_pine', 'tree_dead', 'crate', 'bush', 'pebbles'];
        for(let i=0; i<gfx.props; i++) {
            let t = propTypes[Math.floor(Math.random() * propTypes.length)];
            // Más densidad de pasto y arbustos, menos rocas gigantes
            if (Math.random() > 0.6 && ['rock_tall', 'tree', 'tree_pine'].includes(t)) continue; 
            this.props.push(new Prop(t));
        }
        // Ordenar props para renderizar primero los de suelo y luego los altos (Z-sorting estático)
        this.props.sort((a,b) => (a.isSolid ? 1 : 0) - (b.isSolid ? 1 : 0));
        this.buildPropGrid();
        this.startTime = Date.now();

        if (!this._inputBound) {
            this._inputBound = true;
            window.addEventListener('keydown', e => {
                this.keys[e.code] = true;
                if(e.key >= 1 && e.key <= 5) this.player.activeSlot = e.key - 1;
                if(e.code === 'KeyR') this.reload();
                if(e.code === 'Space') {
                    e.preventDefault(); // evita que la página scrollee con la barra espaciadora
                    if(!this.paused) this.player.dash();
                }
                if(e.code === 'Escape') this.toggleEscMenu();
            });
            window.addEventListener('keyup', e => this.keys[e.code] = false);
            window.addEventListener('mousemove', e => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
            window.addEventListener('mousedown', () => this.mouse.down = true);
            window.addEventListener('mouseup', () => this.mouse.down = false);
        }

        this.startNextWave();
    },

    // Sistema de Colisiones Físicas Circulares contra el entorno
    resolveCollision(entity, prop) {
        let dx = entity.x - prop.x;
        let dy = entity.y - prop.y;
        let dist = Math.hypot(dx, dy);
        let min = entity.radius + prop.radius;
        if(dist < min && dist > 0) {
            let force = (min - dist) / dist * (this.knockbackMult || 1);
            entity.x += dx * force;
            entity.y += dy * force;
        }
    },

    /**
     * ÚNICO punto de entrada del ciclo de juego. Envuelve toda la actualización
     * y el dibujado (_frame()) en un try/catch: si una excepción no controlada
     * ocurre en cualquier parte de la lógica o el renderizado, antes el juego
     * simplemente se quedaba congelado en silencio (requestAnimationFrame deja
     * de reprogramarse solo si el callback tira una excepción, sin ningún aviso
     * para quien está jugando).
     *
     * Ahora, ante cualquier error:
     *   1. Se registra en consola con console.error (con el stack completo) para
     *      poder depurarlo.
     *   2. Se marca _loopCrashed = true, así este mismo error no se repite en
     *      bucle intentando seguir el loop en el estado roto.
     *   3. Se muestra una pantalla de error clara (#fatal-error-screen) con un
     *      botón para recargar el juego, en vez de dejar un canvas congelado
     *      sin ninguna explicación.
     */
    loop() {
        if (this._loopCrashed) return;
        try {
            this._frame();
        } catch (err) {
            console.error('[GameLoop] Excepción no controlada, el loop se detiene:', err);
            this._loopCrashed = true;
            this.showFatalError(err);
            return;
        }
        requestAnimationFrame(() => this.loop());
    },

    // Muestra la pantalla de error fatal con el botón de recarga. Si por algún
    // motivo el HTML de esa pantalla no existiera (versión vieja de index.html
    // sin actualizar), cae a un alert() para que el usuario igual se entere.
    showFatalError(err) {
        const el = document.getElementById('fatal-error-screen');
        if (!el) {
            alert('SLIMEFRONT encontró un error inesperado y debe recargarse.');
            return;
        }
        const msgEl = document.getElementById('fatal-error-message');
        if (msgEl) msgEl.innerText = (err && err.message) ? err.message : 'Error desconocido.';
        el.style.display = 'flex';
    },

    // Un solo frame de juego (lógica + dibujado). Separado de loop() para que
    // el try/catch de arriba cubra absolutamente todo lo que pasa en un frame,
    // tanto si hay partida en curso como si solo se está dibujando el lobby.
    _frame() {
        // Mientras no haya partida activa (menú, login, etc.) el loop no actualiza
        // lógica de juego, pero SÍ dibuja la escena viva del lobby (LobbyScene,
        // en lobbyscene.js) directamente sobre este mismo canvas, así el centro
        // de la pantalla nunca se ve en negro/vacío detrás del menú.
        if (!this.started || !this.player || !this.camera) {
            if (typeof LobbyScene !== 'undefined') LobbyScene.render();
            return;
        }

        this.camera.follow(this.player);
        // Tiempo Lento: si el evento está activo, solo la mitad de los frames ejecutan lógica de juego
        this._slowToggle = !this._slowToggle;
        const doStep = this.activeEvent !== 'SLOW_TIME' || this._slowToggle;

        // Distancia jugador-enemigo cacheada una sola vez por frame (la reutilizan la física,
        // el frame-skipping/sueño de IA de más abajo y Enemy.update, en vez de recalcularla cada uno)
        this._frameCount = (this._frameCount || 0) + 1;
        for(let i=0; i<this.enemies.length; i++) {
            this.enemies[i]._dist = Math.hypot(this.enemies[i].x - this.player.x, this.enemies[i].y - this.player.y);
        }
        // Escala global de partículas: baja automáticamente con muchas entidades activas para sostener el framerate
        this.particleScale = this.enemies.length > 150 ? 0.35 : (this.enemies.length > 80 ? 0.6 : 1);
        // Modo "cacería final": quedan pocos enemigos, se desactiva el sueño de IA y el
// frame-skipping para que ninguno quede ignorando al jugador lejos del mapa.
	this.lowEnemyMode = this.enemies.length > 0 && this.enemies.length < LOW_ENEMY_THRESHOLD;

        // Terreno Procedural Optimizado
        ctx.fillStyle = terrainPattern;
        ctx.save();
        ctx.translate(-this.camera.x % 512, -this.camera.y % 512);
        ctx.fillRect(-512, -512, canvas.width + 1024, canvas.height + 1024);
        ctx.restore();

        // Update & Culling Props (Sombras y dibujado)
        if (this.shadowsEnabled) this.props.forEach(p => p.drawShadow(this.camera));

        // Física Ambiental (usando grid espacial: ya no recorre TODOS los props)
        const nearbyPlayerProps = this.getNearbyProps(this.player.x, this.player.y);
        nearbyPlayerProps.forEach(p => this.resolveCollision(this.player, p));
        this.enemies.forEach(e => {
            if (e._dist > 1500) return; // IA dormida: fuera de rango, no necesita física de props
            const nearbyEnemyProps = this.getNearbyProps(e.x, e.y);
            nearbyEnemyProps.forEach(p => {
                if(Math.hypot(e.x - p.x, e.y - p.y) < p.radius + e.radius + 50) this.resolveCollision(e, p);
            });
        });

        // Input & Player Update
        if(!this.paused) {
            if (doStep) { this.player.update(this.keys); if(this.mouse.down) this.shoot(); }
            EventManager.update();
        }

        // Rastro Viscoso
        this.trails.forEach(t => { if(t.active) { t.update(); t.draw(this.camera); } });

        // Dibujo de props (ordenados Z)
        this.props.forEach(p => p.draw(this.camera));

        // Casquillos
        this.casings.forEach(c => { if(c.active) { c.update(); c.draw(this.camera); } });

        // Proyectiles con Object Pooling
        this.projectiles.forEach(p => {
            if(!p.active) return;
            if (doStep) p.update();
            p.draw(this.camera);
            
            // Colisiones Proyectil - Props Sólidos (grid espacial)
            let hitProp = false;
            const nearbyProjProps = this.getNearbyProps(p.x, p.y);
            for(let k=0; k<nearbyProjProps.length; k++) {
                let pr = nearbyProjProps[k];
                if(Math.hypot(p.x - pr.x, p.y - pr.y) < pr.radius + p.radius) {
                    p.active = false; hitProp = true;
                    // Chispas al chocar con terreno
                    for(let i=0; i<Math.ceil(3*this.particleScale); i++) this.spawnParticle(p.x, p.y, '#95a5a6', 2, 2, 'normal');
                    break;
                }
            }
            if(hitProp) return;

            if(p.isEnemy) {
                if(Math.hypot(p.x - this.player.x, p.y - this.player.y) < this.player.radius) {
                    this.player.takeDamage(p.damage); p.active = false;
                }
            } else {
                for(let j = this.enemies.length - 1; j >= 0; j--) {
                    let e = this.enemies[j];
                    if(!e.invulnerable && !p.hitEnemies.has(e) && Math.hypot(p.x - e.x, p.y - e.y) < e.radius) {
                        this.hitEnemy(e, p.damage, { playerShot: true }); // la lógica de muerte/recompensa vive acá ahora
                        p.hitEnemies.add(e);
                        if (p.knockback) { // Shotgun: empuja al enemigo lejos del impacto
                            let ka = Math.atan2(e.y - p.y, e.x - p.x);
                            e.x += Math.cos(ka) * p.knockback * 0.06;
                            e.y += Math.sin(ka) * p.knockback * 0.06;
                        }
                        if (p.burn) { e.burnTicks = 180; e.burnDmg = 3; } // Lanzallamas: aplica quemadura ~3s
                        if (p.explosive) { this.explode(p.x, p.y, p.explosionRadius, p.damage); } // RPG
                        if (p.explosive || p.pierce <= 0) { p.active = false; } else { p.pierce--; }
                        break;
                    }
                }
            }
        });

        // Enemigos y Jugador
        this.enemies.forEach((e, i) => {
            if(!this.paused && doStep) {
                if (this.lowEnemyMode) {
                    // Cacería final: sin sueño de IA ni frame-skipping, persiguen desde cualquier punto del mapa
                    e.update(this.player);
                } else if (e._dist > 1500) {
                    // IA dormida: muy lejos del jugador, no ejecuta lógica hasta que vuelva a acercarse
                } else if (e._dist > 700 && e.type !== 'BOSS' && (this._frameCount + i) % 2 === 0) {
                    // Frame skipping: enemigos a media distancia reparten su update entre frames
                } else {
                    e.update(this.player);
                }
            }
            e.draw(this.camera);
        });
        
        // RENDERIZAR AL JUGADOR (crítico - estaba faltando)
        this.player.draw(this.camera, this.mouse);
        
        // Partículas y Textos
        this.particles.forEach(p => { if(p.active) { p.update(); p.draw(this.camera); } });
        this.floatingTexts.forEach(t => { if(t.active) { t.update(); t.draw(this.camera); } });

        // Tinte ambiental atardecer: puramente cosmético (no aporta información de juego),
        // se apaga en ULTRA para ahorrarse un fillRect de pantalla completa por frame.
        if (this.fxEnabled) {
            ctx.fillStyle = 'rgba(230, 126, 34, 0.08)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        EventManager.drawOverlay();
        // UI Updates
        document.getElementById('health-inner').style.width = (this.player.hp / this.player.maxHp * 100) + "%";
        document.getElementById('health-text').innerText = `${Math.floor(this.player.hp)} / ${this.player.maxHp}`;
        document.getElementById('money-display').innerText = "CASH: $" + this.player.money;
        document.getElementById('wave-display').innerText = "WAVE: " + this.wave;
        
        let w = this.player.weapon;
        document.getElementById('ammo-hud').innerText = w ? (w.ammo === Infinity ? "∞" : w.ammo) : "--";
        if(this.player.isReloading) document.getElementById('ammo-hud').innerText = "RELOAD";

        const hotbar = document.getElementById('hotbar');
        if(hotbar.children.length === 0) {
            for(let i=0; i<5; i++) hotbar.innerHTML += `<div class="slot" id="slot-${i}" onclick="game.player.activeSlot=${i}"><span class="slot-key">${i+1}</span><span class="name"></span><span class="slot-ammo"></span></div>`;
        }
        for(let i=0; i<5; i++) {
            let s = this.player.inventory[i];
            let el = document.getElementById(`slot-${i}`);
            el.className = this.player.activeSlot === i ? "slot active" : "slot";
            el.querySelector('.name').innerText = s ? s.name : "";
            el.querySelector('.slot-ammo').innerText = s ? (s.ammo === Infinity ? "" : s.ammo) : "";
        }

        if(this.isWaveActive && this.enemies.length === 0) {
            this.isWaveActive = false; this.wave++;
            this.paused = true;
            EventManager.deactivate();
            MusicManager.duck();
            this.updateShop();
            document.getElementById('shop-menu').style.display = "block";
        }
    },

    // ======================================================================
    // LOBBY v2 — construcción de las 3 zonas + barra inferior.
    // Se separa del innerHTML estático de index.html porque necesita leer
    // datos "en vivo" (perfil, logros, récord) cada vez que se vuelve a
    // mostrar el lobby (goToMainMenu en ui.js llama a refreshLobbyPanels()).
    // ======================================================================
    buildLobby() {
        const root = document.getElementById('lobby-screen');
        if (!root) return;
        root.innerHTML = `
            <div class="lobby-left">
                <div class="lobby-logo">
                    <div class="lobby-logo-eyebrow">◆ DEFENSA · SUPERVIVENCIA · SLIMES</div>
                    <h1 class="menu-title lobby-logo-title" style="animation:none;">SLIMEFRONT</h1>
                    <p class="lobby-logo-sub">Enhanced Edition · v0.9</p>
                </div>
                <nav class="lobby-nav">
                    <button class="nav-card nav-card-primary" onclick="game.startFromLobby()">
                        <span class="nav-card-icon">▶</span>
                        <span class="nav-card-text">
                            <span class="nav-card-title">Jugar</span>
                            <span class="nav-card-sub">Empieza una nueva incursión</span>
                        </span>
                    </button>
                    <button class="nav-card" onclick="game.openAchievementsFromLobby()">
                        <span class="nav-card-icon">🏆</span>
                        <span class="nav-card-text">
                            <span class="nav-card-title">Logros</span>
                            <span class="nav-card-sub" id="lobby-nav-achv-sub">Cargando...</span>
                        </span>
                    </button>
                    <button class="nav-card" onclick="game.openSettings('lobby')">
                        <span class="nav-card-icon">⚙</span>
                        <span class="nav-card-text">
                            <span class="nav-card-title">Opciones</span>
                            <span class="nav-card-sub">Gráficos, audio y cuenta</span>
                        </span>
                    </button>
                    <button class="nav-card nav-card-danger" onclick="game.openExitConfirm()">
                        <span class="nav-card-icon">⏻</span>
                        <span class="nav-card-text">
                            <span class="nav-card-title">Salir</span>
                            <span class="nav-card-sub">Cerrar SLIMEFRONT</span>
                        </span>
                    </button>
                </nav>
                <div id="auth-box" class="auth-box lobby-auth">
                    <span id="auth-status" class="hud-text"></span>
                    <button id="auth-btn" class="menu-btn" onclick="AuthUI.handleClick()"></button>
                </div>
            </div>

            <div class="lobby-center"></div>

            <div class="lobby-right">
                <div class="glass-panel panel-profile">
                    <div class="panel-eyebrow">PERFIL</div>
                    <div class="profile-panel-head">
                        <div class="pixel-avatar"></div>
                        <div>
                            <div class="profile-panel-name" id="lobby-profile-name">Invitado</div>
                            <div class="profile-panel-lvl" id="lobby-profile-lvl">Nivel 1</div>
                        </div>
                    </div>
                    <div id="lobby-profile-stats"></div>
                </div>

                <div class="glass-panel panel-news">
                    <div class="panel-eyebrow">NOTICIAS</div>
                    <div class="panel-title" style="font-size:20px;">Parche v0.9</div>
                    <div id="lobby-news-list"></div>
                </div>

                <div class="glass-panel panel-daily">
                    <div class="panel-eyebrow">DESAFÍO DIARIO</div>
                    <div class="daily-goal" id="lobby-daily-goal">Cargando...</div>
                    <div class="daily-reward" id="lobby-daily-reward"></div>
                </div>

                <div class="glass-panel panel-stats">
                    <div class="panel-eyebrow">ESTADÍSTICAS</div>
                    <div id="lobby-stats-list"></div>
                </div>
            </div>

            <div class="lobby-bottombar">
                <button class="quickbar-btn" onclick="game.openStorePlaceholder()"><span class="qb-icon">🛒</span>Tienda</button>
                <button class="quickbar-btn" onclick="game.openCollectionPlaceholder()"><span class="qb-icon">📚</span>Colección</button>
                <button class="quickbar-btn" onclick="game.openWorkshopPlaceholder()"><span class="qb-icon">🔧</span>Taller</button>
                <button class="quickbar-btn" onclick="game.toggleControls(true)"><span class="qb-icon">📖</span>Controles</button>
                <button class="quickbar-btn" onclick="game.openCredits()"><span class="qb-icon">🎬</span>Créditos</button>
            </div>
        `;
        if (typeof AuthUI !== 'undefined') AuthUI.refresh();
        this.refreshLobbyPanels();
    },

    // Repinta solo los datos (no reconstruye el DOM) de los paneles derechos +
    // el subtítulo de logros. Se puede llamar tantas veces como haga falta
    // (login, logros desbloqueados, vuelta al menú) sin cortar las animaciones
    // de entrada de las tarjetas.
    refreshLobbyPanels() {
        const p = (typeof PlayerProfile !== 'undefined') ? PlayerProfile : null;

        // --- Perfil ---
        const nameEl = document.getElementById('lobby-profile-name');
        const lvlEl = document.getElementById('lobby-profile-lvl');
        const statsEl = document.getElementById('lobby-profile-stats');
        if (nameEl) nameEl.innerText = (typeof AuthUI !== 'undefined') ? AuthUI.currentLabel() : 'Invitado';
        if (p && lvlEl) lvlEl.innerText = `Nivel ${p.level} · 💎 ${p.diamonds}`;
        if (p && statsEl) {
            statsEl.innerHTML = `
                <div class="lf-stat-row"><span>Mejor oleada</span><span>${Settings.bestWave}</span></div>
                <div class="lf-stat-row"><span>Eliminaciones</span><span>${p.kills.toLocaleString('es-ES')}</span></div>
                <div class="lf-stat-row"><span>Dinero acumulado</span><span>$${(p.diamonds ? p.diamonds : 0)}</span></div>
            `;
        }

        // --- Logros (subtítulo de la tarjeta de navegación) ---
        const achvSub = document.getElementById('lobby-nav-achv-sub');
        if (achvSub && typeof ACHIEVEMENTS_DB !== 'undefined') {
            const defs = Object.values(ACHIEVEMENTS_DB);
            const done = defs.filter(d => d.getValue() >= d.target).length;
            achvSub.innerText = `${done}/${defs.length} desbloqueados`;
        }

        // --- Noticias (contenido estático del parche actual) ---
        const newsList = document.getElementById('lobby-news-list');
        if (newsList) {
            const news = [
                { title: 'Sistema de logros y guardado en la nube', date: 'v0.9' },
                { title: 'Nuevo evento dinámico: Bombardeo', date: 'v0.9' },
                { title: '20 armas balanceadas, del cuchillo al RPG', date: 'v0.9' }
            ];
            newsList.innerHTML = news.map(n => `
                <div class="news-item">
                    <div class="news-item-title">${n.title}</div>
                    <div class="news-item-date">${n.date}</div>
                </div>
            `).join('');
        }

        // --- Desafío diario (rota una vez por día, determinista por fecha) ---
        const goalEl = document.getElementById('lobby-daily-goal');
        const rewardEl = document.getElementById('lobby-daily-reward');
        if (goalEl) {
            const goals = [
                'Sobrevive 10 oleadas usando solo armas cuerpo a cuerpo.',
                'Elimina 150 slimes sin usar el dash.',
                'Llega a la oleada 8 sin comprar munición en la tienda.',
                'Derrota a un jefe con la escopeta recortada.',
                'Completa una oleada entera durante un evento dinámico.'
            ];
            const dayIndex = Math.floor(Date.now() / 86400000) % goals.length;
            goalEl.innerText = goals[dayIndex];
            if (rewardEl) rewardEl.innerText = '🎁 Recompensa informativa — sin seguimiento automático todavía';
        }

        // --- Estadísticas ---
        const statsList = document.getElementById('lobby-stats-list');
        if (p && statsList) {
            const acc = p.shotsFired > 0 ? Math.round(p.shotsHit / p.shotsFired * 100) : 0;
            const liveSec = this.started ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
            const totalSec = p.playTimeSec + liveSec;
            const mm = String(Math.floor(totalSec / 60)).padStart(2, '0'), ss = String(totalSec % 60).padStart(2, '0');
            statsList.innerHTML = `
                <div class="lf-stat-row"><span>Precisión</span><span>${acc}%</span></div>
                <div class="lf-stat-row"><span>Tiempo jugado</span><span>${mm}:${ss}</span></div>
                <div class="lf-stat-row"><span>Distancia recorrida</span><span>${Math.floor(p.distance)} m</span></div>
                <div class="lf-stat-row"><span>Muertes</span><span>${p.deaths}</span></div>
            `;
        }
    },

    openAchievementsFromLobby() {
        this.openProfile();
        this.setProfileTab('achv');
    },

    // ---- Barra inferior: Tienda / Colección / Taller (aún no implementados
    // como sistemas propios; se deja un aviso claro en vez de fingir que
    // hacen algo). ----
    _lobbyToast(msg) {
        const el = document.getElementById('lobby-toast');
        if (!el) return;
        el.innerHTML = `<div class="achv-toast-name">${msg}</div>`;
        el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
        clearTimeout(this._lobbyToastTimer);
        this._lobbyToastTimer = setTimeout(() => el.classList.remove('show'), 2200);
    },
    openStorePlaceholder() { this._lobbyToast('🛒 Tienda: próximamente'); },
    openCollectionPlaceholder() { this._lobbyToast('📚 Colección: próximamente'); },
    openWorkshopPlaceholder() { this._lobbyToast('🔧 Taller: próximamente'); },

    // ---- Salir ----
    openExitConfirm() { document.getElementById('confirm-exit-modal').style.display = 'flex'; },
    closeExitConfirm() { document.getElementById('confirm-exit-modal').style.display = 'none'; },
    confirmExit() {
        // window.close() solo funciona en pestañas abiertas por script; en la
        // mayoría de los navegadores el usuario deberá cerrar la pestaña él
        // mismo. Lo intentamos igual y avisamos si no se pudo.
        window.close();
        setTimeout(() => {
            this.closeExitConfirm();
            this._lobbyToast('Podés cerrar esta pestaña para salir');
        }, 200);
    }
};

window.addEventListener('resize', () => {
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    if (typeof LobbyScene !== 'undefined') LobbyScene.reset();
});

// Arranca el único loop de renderizado del juego. Gracias al guard agregado al
// principio de _frame(), esto no dibuja nada hasta que exista game.player (o sea,
// hasta el primer game.init()), así que es seguro llamarlo ya mismo.
game.loop();

window.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('lobby-active');
    game.buildLobby();

    // Asegúrate de que este panel exista en tu HTML (o créalo dinámicamente)
    const controlsPanel = document.getElementById('controls-panel');
    if (controlsPanel) {
        controlsPanel.innerHTML = `
            <div class="menu-panel">
                <h2 class="menu-title">CONTROLES</h2>
                <div class="controls-list">
                    <div class="control-item"><span>WASD</span><span class="control-key">MOVER</span></div>
                    <div class="control-item"><span>MOUSE</span><span class="control-key">APUNTAR</span></div>
                    <div class="control-item"><span>CLICK</span><span class="control-key">DISPARAR</span></div>
                    <div class="control-item"><span>R</span><span class="control-key">RECARGAR</span></div>
                    <div class="control-item"><span>SHIFT</span><span class="control-key">SPRINT</span></div>
                    <div class="control-item"><span>ESPACIO</span><span class="control-key">DASH</span></div>
                    <div class="control-item"><span>ESC</span><span class="control-key">PAUSA</span></div>
                </div>
                <button class="menu-btn" onclick="game.toggleControls(false)">← VOLVER</button>
            </div>
        `;
    }

    document.addEventListener('click', e => {
        const btn = e.target.closest('.menu-btn, .option-btn, .buy-btn, .sell-btn, .depart-btn, .shop-btn, .nav-card, .quickbar-btn');
        if (!btn) return;
        const isBack = btn.textContent.includes('VOLVER') || btn.onclick?.toString().includes('close');
        playSFX(isBack ? 'ui_back' : 'ui_click', 0.4);
    });
    document.addEventListener('mouseover', e => {
        const btn = e.target.closest('.menu-btn, .option-btn, .buy-btn, .sell-btn, .depart-btn, .shop-btn, .nav-card, .quickbar-btn');
        if (btn) playSFX('ui_hover', 0.15, 0.05);
    });
});
