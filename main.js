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
    started: false, shadowsEnabled: true,
    keys: {}, mouse: { x: 0, y: 0, down: false },
    lastShot: 0, particleScale: 1, lowEnemyMode: false,

    init() {
        this.started = true;
        this.player = new Player();
        this.camera = new Camera();
        const gfx = GRAPHICS_PRESETS[Settings.graphics] || GRAPHICS_PRESETS.PRO;
        this.shadowsEnabled = gfx.shadows;

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

        this.startNextWave();
        this.loop();
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

    loop() {
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

        // Tinte ambiental atardecer
        ctx.fillStyle = 'rgba(230, 126, 34, 0.08)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        EventManager.drawOverlay();
        // UI Updates
        const mobileControls = document.getElementById('mobile-controls');
        if(mobileControls) mobileControls.style.pointerEvents = this.paused ? 'none' : 'auto';
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

        requestAnimationFrame(() => this.loop());
    }
};

window.addEventListener('resize', () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });

window.addEventListener('DOMContentLoaded', () => {
    // === PANTALLA DE CARGA ===
    const loadingScreen = document.getElementById('loading-screen');
    const handleLoadingClick = () => {
        if (!loadingScreen) return;
        loadingScreen.style.display = 'none';
        loadingScreen.style.pointerEvents = 'none';
        const lobbyScreen = document.getElementById('lobby-screen');
        if (lobbyScreen) lobbyScreen.style.display = 'flex';
        // Precarga de SFX y música tras interacción del usuario (necesario en algunos navegadores)
        if (typeof preloadSFX === 'function') preloadSFX();
        if (typeof MusicManager !== 'undefined') {
            MusicManager.init();
            MusicManager.playLobby();
        }
    };
    if (loadingScreen) {
        loadingScreen.addEventListener('click', handleLoadingClick, { once: true });
        loadingScreen.addEventListener('touchstart', handleLoadingClick, { once: true });
        loadingScreen.addEventListener('keydown', handleLoadingClick, { once: true });
    }
    
    // Fallback: si hay timeout, mostrar lobby automáticamente
    setTimeout(() => {
        if (loadingScreen && loadingScreen.style.display !== 'none') handleLoadingClick();
    }, 4000);

    const lobbyScreen = document.getElementById('lobby-screen');
    if (lobbyScreen) {
        lobbyScreen.innerHTML = `
            <div class="menu-panel">
                <h1 class="menu-title">SLIMEFRONT</h1>
                <p class="menu-subtitle">Enhanced Edition</p>
                <button class="menu-btn primary" onclick="game.startFromLobby()">▶ JUGAR</button>
                <button class="menu-btn" onclick="game.openSettings('lobby')">⚙ AJUSTES</button>
                <button class="menu-btn" onclick="game.toggleControls(true)">📖 CONTROLES</button>
                <button class="menu-btn" onclick="game.openCredits()">🎬 CRÉDITOS</button>
                <div style="margin-top:20px; font-size:18px;">
                    <div>RÉCORD: ${Settings.bestWave} OLEADAS</div>
                    <div class="version-tag">v0.9</div>
                </div>
            </div>
        `;
    }

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

    const retryLobbyMusic = () => MusicManager.start();
    window.addEventListener('keydown', retryLobbyMusic, { once: true });
    window.addEventListener('mousedown', retryLobbyMusic, { once: true });
document.addEventListener('click', e => {
    const btn = e.target.closest('.menu-btn, .option-btn, .buy-btn, .sell-btn, .depart-btn, .shop-btn');
    if (!btn) return;
    const isBack = btn.textContent.includes('VOLVER') || btn.onclick?.toString().includes('close');
    playSFX(isBack ? 'ui_back' : 'ui_click', 0.4);
});
document.addEventListener('mouseover', e => {
    const btn = e.target.closest('.menu-btn, .option-btn, .buy-btn, .sell-btn, .depart-btn, .shop-btn');
    if (btn) playSFX('ui_hover', 0.15, 0.05);
});
});   