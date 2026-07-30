"use strict";
const firebaseConfig = {
  apiKey: "AIzaSyCS8jXSpTuSDRRDQO24aGvhR00oKKcbhyY",
  authDomain: "slimefront-f011e.firebaseapp.com",
  projectId: "slimefront-f011e",
  storageBucket: "slimefront-f011e.firebasestorage.app",
  messagingSenderId: "956912162086",
  appId: "1:956912162086:web:273d1a3c73e0fadb659de7",
  measurementId: "G-4R5NPJCSTK"
};
firebase.initializeApp(firebaseConfig);
const _auth = firebase.auth();
const _db = firebase.firestore();
try {
  firebase.analytics();
} catch (e) {
  console.warn("[FirebaseSaveSystem] Analytics no disponible:", e);
}
try {
  _db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
    console.warn("[FirebaseSaveSystem] Persistencia de Firestore no disponible (multi-pesta\xF1a o navegador no soportado):", err.code || err);
  });
} catch (e) {
}
const _LOCAL_PREFIX = "slime_";
const _SYNC_DEBOUNCE_MS = 2500;
const PLAYERS_COLLECTION = "players";
const LEADERBOARD_COLLECTION = "leaderboard";
const SaveSystem = {
  _cache: {},
  _uid: null,
  _dirty: /* @__PURE__ */ new Set(),
  _pushTimer: null,
  _remoteListeners: [],
  ready: null,
  // Promise que resuelve cuando Firebase Auth ya resolvió su
  // primer estado (logueado o no) Y, si había sesión, ya se
  // bajó el progreso de Firestore. boot.js espera esto antes
  // de mostrar cualquier pantalla.
  _readyResolve: null,
  // ================= LECTURA / ESCRITURA (misma interfaz que el SaveSystem viejo) =================
  get(key, fallback) {
    if (key in this._cache) return this._cache[key];
    try {
      const raw = localStorage.getItem(_LOCAL_PREFIX + key);
      if (raw !== null) {
        const value = JSON.parse(raw);
        this._cache[key] = value;
        return value;
      }
    } catch (e) {
    }
    return fallback;
  },
  set(key, value) {
    this._cache[key] = value;
    try {
      localStorage.setItem(_LOCAL_PREFIX + key, JSON.stringify(value));
    } catch (e) {
    }
    this._dirty.add(key);
    this._scheduleSync();
  },
  // ================= SUSCRIPCIÓN A DATOS REMOTOS =================
  // Cualquier módulo (level.js, progression.js, achievements.js) puede registrar un
  // callback acá para enterarse quí keys llegaron/actualizaron desde Firestore
  // DESPUÉS de que sus propios objetos (PlayerProfile, etc.) ya se armaron en frío.
  onRemoteData(callback) {
    this._remoteListeners.push(callback);
  },
  _notifyRemote(keys) {
    this._remoteListeners.forEach((cb) => {
      try {
        cb(keys);
      } catch (e) {
        console.warn("[FirebaseSaveSystem] Error en listener onRemoteData:", e);
      }
    });
  },
  // ================= SINCRONIZACIÓN CON FIRESTORE (nunca bloquea, nunca rompe) =================
  _scheduleSync() {
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this._pushDirty(), _SYNC_DEBOUNCE_MS);
  },
  async _pushDirty() {
    if (!this._uid || this._dirty.size === 0) return;
    const keys = Array.from(this._dirty);
    this._dirty.clear();
    const patch = {};
    keys.forEach((k) => {
      try {
        patch[k] = JSON.parse(JSON.stringify(this._cache[k]));
      } catch (e) {
        console.warn(`[FirebaseSaveSystem] No se pudo serializar la key "${k}", se omite este ciclo de sync:`, e);
      }
    });
    patch._updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    try {
      await _db.collection(PLAYERS_COLLECTION).doc(this._uid).set(patch, { merge: true });
    } catch (e) {
      console.warn("[FirebaseSaveSystem] Firestore no disponible, se sigue jugando con la cach\xE9 local. Reintentar\xE1:", e.code || e);
      keys.forEach((k) => this._dirty.add(k));
    }
  },
  // Fuerza el envío inmediato (se usa al cerrar sesión o al salir de la pestaña)
  async flush() {
    clearTimeout(this._pushTimer);
    await this._pushDirty();
  },
  // ================= CARGA INICIAL AL INICIAR SESIÓN =================
  async _pullRemote(uid) {
    try {
      const snap = await _db.collection(PLAYERS_COLLECTION).doc(uid).get();
      if (!snap.exists) return;
      const data = snap.data();
      const changedKeys = [];
      Object.keys(data).forEach((k) => {
        if (k === "_updatedAt") return;
        this._cache[k] = data[k];
        try {
          localStorage.setItem(_LOCAL_PREFIX + k, JSON.stringify(data[k]));
        } catch (e) {
        }
        changedKeys.push(k);
      });
      if (changedKeys.length) this._notifyRemote(changedKeys);
    } catch (e) {
      console.warn("[FirebaseSaveSystem] No se pudo descargar el progreso de la nube, se sigue con la cach\xE9 local:", e.code || e);
    }
  },
  // ================= BORRADO TOTAL DE PROGRESO (nuevo) =================
  // Borra localStorage + caché en memoria + el documento en Firestore (si hay
  // sesión). NO toca la sesión de auth ni las preferencias de gráficos/volumen
  // (esas viven aparte, en Settings de ui.js).
  async clearProgress() {
    const keys = ["profile", "progression", "achv_stats", "achv_state"];
    keys.forEach((k) => {
      delete this._cache[k];
      this._dirty.delete(k);
      try {
        localStorage.removeItem(_LOCAL_PREFIX + k);
      } catch (e) {
      }
    });
    clearTimeout(this._pushTimer);
    if (this._uid) {
      try {
        await _db.collection(PLAYERS_COLLECTION).doc(this._uid).set({}, { merge: false });
      } catch (e) {
        console.warn("[FirebaseSaveSystem] No se pudo borrar el progreso en la nube:", e.code || e);
      }
    }
  },
  // ================= AUTENTICACIÓN =================
  async signInWithGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await _auth.signInWithPopup(provider);
    } catch (e) {
      console.warn("[FirebaseSaveSystem] Login con Google fall\xF3:", e.code || e);
    }
  },
  async signOut() {
    await this.flush();
    try {
      await _auth.signOut();
    } catch (e) {
      console.warn("[FirebaseSaveSystem] Error al cerrar sesi\xF3n:", e);
    }
  },
  get currentUser() {
    return _auth.currentUser;
  },
  // ================= RANKINGS ONLINE (preparado para el futuro, no se usa aún) =================
  // Documento liviano y fácil de indexar/ordenar en Firestore (nivel, mejor oleada, nombre),
  // separado del documento grande de progreso (players/{uid}) para no tener que leer todo
  // el perfil de cada jugador solo para armar una tabla de posiciones.
  async pushLeaderboardEntry(fields) {
    if (!this._uid) return;
    try {
      await _db.collection(LEADERBOARD_COLLECTION).doc(this._uid).set({
        ...fields,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn("[FirebaseSaveSystem] No se pudo actualizar el leaderboard (no cr\xEDtico):", e.code || e);
    }
  },
  init() {
    this.ready = new Promise((resolve) => {
      this._readyResolve = resolve;
    });
    let firstCheck = true;
    _auth.onAuthStateChanged(async (user) => {
      this._uid = user ? user.uid : null;
      if (user) {
        await this._pullRemote(user.uid);
        document.dispatchEvent(new CustomEvent("savesystem:login", { detail: { uid: user.uid, user } }));
      } else {
        document.dispatchEvent(new CustomEvent("savesystem:logout"));
      }
      if (firstCheck) {
        firstCheck = false;
        this._readyResolve();
      }
    });
    window.addEventListener("beforeunload", () => {
      this._pushDirty();
    });
  }
};
SaveSystem.init();
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
const MAP_SIZE = 4e3;
const LOW_ENEMY_THRESHOLD = 20;
const game = {
  player: null,
  enemies: [],
  props: [],
  floatingTexts: [],
  // Object Pools
  particles: [],
  casings: [],
  projectiles: [],
  trails: [],
  camera: null,
  wave: 1,
  isWaveActive: false,
  paused: false,
  started: false,
  shadowsEnabled: true,
  fxEnabled: true,
  keys: {},
  mouse: { x: 0, y: 0, down: false },
  lastShot: 0,
  particleScale: 1,
  lowEnemyMode: false,
  _inputBound: false,
  init() {
    this.enemies = [];
    this.props = [];
    this.floatingTexts = [];
    this.particles = [];
    this.casings = [];
    this.projectiles = [];
    this.trails = [];
    this.wave = 1;
    this.isWaveActive = false;
    this.paused = false;
    if (typeof EventManager !== "undefined") EventManager.deactivate();
    this.started = true;
    this.player = new Player();
    this.camera = new Camera();
    const gfx = GRAPHICS_PRESETS[Settings.graphics] || GRAPHICS_PRESETS.PRO;
    this.shadowsEnabled = gfx.shadows;
    this.fxEnabled = !gfx.ultra;
    for (let i = 0; i < gfx.particles; i++) this.particles.push(new Particle());
    for (let i = 0; i < gfx.casings; i++) this.casings.push(new Casing());
    for (let i = 0; i < gfx.projectiles; i++) this.projectiles.push(new Projectile());
    for (let i = 0; i < gfx.trails; i++) this.trails.push(new Trail());
    this.particles.forEach((p) => p.active = false);
    this.casings.forEach((c) => c.active = false);
    this.projectiles.forEach((p) => p.active = false);
    this.trails.forEach((t) => t.active = false);
    for (let i = 0; i < 40; i++) this.floatingTexts.push(new FloatingText());
    this.floatingTexts.forEach((t) => t.active = false);
    const propTypes = ["rock", "rock_tall", "rock_split", "tree", "tree_pine", "tree_dead", "crate", "bush", "pebbles"];
    for (let i = 0; i < gfx.props; i++) {
      let t = propTypes[Math.floor(Math.random() * propTypes.length)];
      if (Math.random() > 0.6 && ["rock_tall", "tree", "tree_pine"].includes(t)) continue;
      this.props.push(new Prop(t));
    }
    this.props.sort((a, b) => (a.isSolid ? 1 : 0) - (b.isSolid ? 1 : 0));
    this.buildPropGrid();
    this.startTime = Date.now();
    if (!this._inputBound) {
      this._inputBound = true;
      window.addEventListener("keydown", (e) => {
        this.keys[e.code] = true;
        if (e.key >= 1 && e.key <= 5) this.player.activeSlot = e.key - 1;
        if (e.code === "KeyR") this.reload();
        if (e.code === "Space") {
          e.preventDefault();
          if (!this.paused) this.player.dash();
        }
        if (e.code === "Escape") this.toggleEscMenu();
      });
      window.addEventListener("keyup", (e) => this.keys[e.code] = false);
      window.addEventListener("mousemove", (e) => {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
      });
      window.addEventListener("mousedown", () => this.mouse.down = true);
      window.addEventListener("mouseup", () => this.mouse.down = false);
    }
    this.startNextWave();
  },
  // Sistema de Colisiones Físicas Circulares contra el entorno
  resolveCollision(entity, prop) {
    let dx = entity.x - prop.x;
    let dy = entity.y - prop.y;
    let dist = Math.hypot(dx, dy);
    let min = entity.radius + prop.radius;
    if (dist < min && dist > 0) {
      let force = (min - dist) / dist * (this.knockbackMult || 1);
      entity.x += dx * force;
      entity.y += dy * force;
    }
  },
  loop() {
    if (!this.started || !this.player || !this.camera) {
      requestAnimationFrame(() => this.loop());
      return;
    }
    this.camera.follow(this.player);
    this._slowToggle = !this._slowToggle;
    const doStep = this.activeEvent !== "SLOW_TIME" || this._slowToggle;
    this._frameCount = (this._frameCount || 0) + 1;
    for (let i = 0; i < this.enemies.length; i++) {
      this.enemies[i]._dist = Math.hypot(this.enemies[i].x - this.player.x, this.enemies[i].y - this.player.y);
    }
    this.particleScale = this.enemies.length > 150 ? 0.35 : this.enemies.length > 80 ? 0.6 : 1;
    this.lowEnemyMode = this.enemies.length > 0 && this.enemies.length < LOW_ENEMY_THRESHOLD;
    ctx.fillStyle = terrainPattern;
    ctx.save();
    ctx.translate(-this.camera.x % 512, -this.camera.y % 512);
    ctx.fillRect(-512, -512, canvas.width + 1024, canvas.height + 1024);
    ctx.restore();
    if (this.shadowsEnabled) this.props.forEach((p) => p.drawShadow(this.camera));
    const nearbyPlayerProps = this.getNearbyProps(this.player.x, this.player.y);
    nearbyPlayerProps.forEach((p) => this.resolveCollision(this.player, p));
    this.enemies.forEach((e) => {
      if (e._dist > 1500) return;
      const nearbyEnemyProps = this.getNearbyProps(e.x, e.y);
      nearbyEnemyProps.forEach((p) => {
        if (Math.hypot(e.x - p.x, e.y - p.y) < p.radius + e.radius + 50) this.resolveCollision(e, p);
      });
    });
    if (!this.paused) {
      if (doStep) {
        this.player.update(this.keys);
        if (this.mouse.down) this.shoot();
      }
      EventManager.update();
    }
    this.trails.forEach((t) => {
      if (t.active) {
        t.update();
        t.draw(this.camera);
      }
    });
    this.props.forEach((p) => p.draw(this.camera));
    this.casings.forEach((c) => {
      if (c.active) {
        c.update();
        c.draw(this.camera);
      }
    });
    this.projectiles.forEach((p) => {
      if (!p.active) return;
      if (doStep) p.update();
      p.draw(this.camera);
      let hitProp = false;
      const nearbyProjProps = this.getNearbyProps(p.x, p.y);
      for (let k = 0; k < nearbyProjProps.length; k++) {
        let pr = nearbyProjProps[k];
        if (Math.hypot(p.x - pr.x, p.y - pr.y) < pr.radius + p.radius) {
          p.active = false;
          hitProp = true;
          for (let i = 0; i < Math.ceil(3 * this.particleScale); i++) this.spawnParticle(p.x, p.y, "#95a5a6", 2, 2, "normal");
          break;
        }
      }
      if (hitProp) return;
      if (p.isEnemy) {
        if (Math.hypot(p.x - this.player.x, p.y - this.player.y) < this.player.radius) {
          this.player.takeDamage(p.damage);
          p.active = false;
        }
      } else {
        for (let j = this.enemies.length - 1; j >= 0; j--) {
          let e = this.enemies[j];
          if (!e.invulnerable && !p.hitEnemies.has(e) && Math.hypot(p.x - e.x, p.y - e.y) < e.radius) {
            this.hitEnemy(e, p.damage, { playerShot: true });
            p.hitEnemies.add(e);
            if (p.knockback) {
              let ka = Math.atan2(e.y - p.y, e.x - p.x);
              e.x += Math.cos(ka) * p.knockback * 0.06;
              e.y += Math.sin(ka) * p.knockback * 0.06;
            }
            if (p.burn) {
              e.burnTicks = 180;
              e.burnDmg = 3;
            }
            if (p.explosive) {
              this.explode(p.x, p.y, p.explosionRadius, p.damage);
            }
            if (p.explosive || p.pierce <= 0) {
              p.active = false;
            } else {
              p.pierce--;
            }
            break;
          }
        }
      }
    });
    this.enemies.forEach((e, i) => {
      if (!this.paused && doStep) {
        if (this.lowEnemyMode) {
          e.update(this.player);
        } else if (e._dist > 1500) {
        } else if (e._dist > 700 && e.type !== "BOSS" && (this._frameCount + i) % 2 === 0) {
        } else {
          e.update(this.player);
        }
      }
      e.draw(this.camera);
    });
    this.player.draw(this.camera, this.mouse);
    this.particles.forEach((p) => {
      if (p.active) {
        p.update();
        p.draw(this.camera);
      }
    });
    this.floatingTexts.forEach((t) => {
      if (t.active) {
        t.update();
        t.draw(this.camera);
      }
    });
    if (this.fxEnabled) {
      ctx.fillStyle = "rgba(230, 126, 34, 0.08)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    EventManager.drawOverlay();
    const mobileControls = document.getElementById("mobile-controls");
    if (mobileControls) mobileControls.style.pointerEvents = this.paused ? "none" : "auto";
    document.getElementById("health-inner").style.width = this.player.hp / this.player.maxHp * 100 + "%";
    document.getElementById("health-text").innerText = `${Math.floor(this.player.hp)} / ${this.player.maxHp}`;
    document.getElementById("money-display").innerText = "CASH: $" + this.player.money;
    document.getElementById("wave-display").innerText = "WAVE: " + this.wave;
    let w = this.player.weapon;
    document.getElementById("ammo-hud").innerText = w ? w.ammo === Infinity ? "\u221E" : w.ammo : "--";
    if (this.player.isReloading) document.getElementById("ammo-hud").innerText = "RELOAD";
    const hotbar = document.getElementById("hotbar");
    if (hotbar.children.length === 0) {
      for (let i = 0; i < 5; i++) hotbar.innerHTML += `<div class="slot" id="slot-${i}" onclick="game.player.activeSlot=${i}"><span class="slot-key">${i + 1}</span><span class="name"></span><span class="slot-ammo"></span></div>`;
    }
    for (let i = 0; i < 5; i++) {
      let s = this.player.inventory[i];
      let el = document.getElementById(`slot-${i}`);
      el.className = this.player.activeSlot === i ? "slot active" : "slot";
      el.querySelector(".name").innerText = s ? s.name : "";
      el.querySelector(".slot-ammo").innerText = s ? s.ammo === Infinity ? "" : s.ammo : "";
    }
    if (this.isWaveActive && this.enemies.length === 0) {
      this.isWaveActive = false;
      this.wave++;
      this.paused = true;
      EventManager.deactivate();
      MusicManager.duck();
      this.updateShop();
      document.getElementById("shop-menu").style.display = "block";
    }
    requestAnimationFrame(() => this.loop());
  }
};
window.addEventListener("resize", () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});
game.loop();
window.addEventListener("DOMContentLoaded", () => {
  const lobbyScreen = document.getElementById("lobby-screen");
  if (lobbyScreen) {
    lobbyScreen.innerHTML = `
            <div class="menu-panel">
                <h1 class="menu-title">SLIMEFRONT</h1>
                <p class="menu-subtitle">Enhanced Edition</p>
                <div id="auth-box" class="auth-box">
                    <span id="auth-status" class="hud-text"></span>
                    <button id="auth-btn" class="menu-btn" onclick="AuthUI.handleClick()"></button>
                </div>
                <button class="menu-btn primary" onclick="game.startFromLobby()">\u25B6 JUGAR</button>
                <button class="menu-btn" onclick="game.openSettings('lobby')">\u2699 AJUSTES</button>
                <button class="menu-btn" onclick="game.toggleControls(true)">\u{1F4D6} CONTROLES</button>
                <button class="menu-btn" onclick="game.openCredits()">\u{1F3AC} CR\xC9DITOS</button>
                <div style="margin-top:20px; font-size:18px;">
                    <div>R\xC9CORD: ${Settings.bestWave} OLEADAS</div>
                    <div class="version-tag">v0.9</div>
                </div>
            </div>
        `;
    if (typeof AuthUI !== "undefined") AuthUI.refresh();
  }
  const controlsPanel = document.getElementById("controls-panel");
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
                <button class="menu-btn" onclick="game.toggleControls(false)">\u2190 VOLVER</button>
            </div>
        `;
  }
  document.addEventListener("click", (e) => {
    var _a;
    const btn = e.target.closest(".menu-btn, .option-btn, .buy-btn, .sell-btn, .depart-btn, .shop-btn");
    if (!btn) return;
    const isBack = btn.textContent.includes("VOLVER") || ((_a = btn.onclick) == null ? void 0 : _a.toString().includes("close"));
    playSFX(isBack ? "ui_back" : "ui_click", 0.4);
  });
  document.addEventListener("mouseover", (e) => {
    const btn = e.target.closest(".menu-btn, .option-btn, .buy-btn, .sell-btn, .depart-btn, .shop-btn");
    if (btn) playSFX("ui_hover", 0.15, 0.05);
  });
});
const GRAPHICS_PRESETS = {
  LOW: { props: 100, particles: 100, casings: 30, projectiles: 60, trails: 60, shadows: false },
  MEDIUM: { props: 200, particles: 200, casings: 60, projectiles: 100, trails: 120, shadows: true },
  PRO: { props: 300, particles: 300, casings: 100, projectiles: 150, trails: 200, shadows: true },
  ULTRA: { props: 50, particles: 0, casings: 0, projectiles: 80, trails: 0, shadows: false, ultra: true }
};
function applyPerfClass() {
  if (document.body) document.body.classList.toggle("ultra-mode", Settings.graphics === "ULTRA");
}
const Settings = {
  graphics: localStorage.getItem("slime_graphics") || "PRO",
  sfxVolume: localStorage.getItem("slime_sfxVolume") !== null ? parseInt(localStorage.getItem("slime_sfxVolume")) : 100,
  musicVolume: localStorage.getItem("slime_musicVolume") !== null ? parseInt(localStorage.getItem("slime_musicVolume")) : 100,
  hudSize: localStorage.getItem("slime_hudSize") !== null ? parseInt(localStorage.getItem("slime_hudSize")) : 2,
  bestWave: parseInt(localStorage.getItem("slime_bestWave")) || 0,
  save() {
    localStorage.setItem("slime_graphics", this.graphics);
    localStorage.setItem("slime_sfxVolume", this.sfxVolume);
    localStorage.setItem("slime_musicVolume", this.musicVolume);
    localStorage.setItem("slime_hudSize", this.hudSize);
    localStorage.setItem("slime_bestWave", this.bestWave);
  }
};
applyPerfClass();
game.startFromLobby = function() {
  document.getElementById("lobby-screen").style.display = "none";
  MusicManager.duck(500);
  MusicManager.tracks = MusicManager.combatTracks;
  MusicManager.currentIndex = -1;
  this.init();
};
game.toggleEscMenu = function() {
  if (!this.started) return;
  if (document.getElementById("shop-menu").style.display === "block") return;
  const menu = document.getElementById("esc-menu");
  const isOpen = menu.style.display === "flex";
  if (isOpen) this.closeEscMenu();
  else {
    menu.style.display = "flex";
    this.paused = true;
    MusicManager.duck(400);
  }
};
game.closeEscMenu = function() {
  document.getElementById("esc-menu").style.display = "none";
  this.paused = false;
  MusicManager.resume(600);
};
game.goToMainMenu = function() {
  document.getElementById("gameover-screen").style.display = "none";
  document.getElementById("esc-menu").style.display = "none";
  document.getElementById("shop-menu").style.display = "none";
  this.started = false;
  this.paused = true;
  this.isWaveActive = false;
  this.enemies = [];
  if (this.particles) this.particles.forEach((p) => p.active = false);
  if (this.casings) this.casings.forEach((c) => c.active = false);
  if (this.projectiles) this.projectiles.forEach((p) => p.active = false);
  if (this.trails) this.trails.forEach((t) => t.active = false);
  if (this.floatingTexts) this.floatingTexts.forEach((t) => t.active = false);
  if (typeof EventManager !== "undefined") EventManager.deactivate();
  MusicManager.duck(400);
  MusicManager.tracks = MusicManager.mainTracks;
  MusicManager.currentIndex = -1;
  setTimeout(() => {
    if (!game.started) MusicManager.start();
  }, 450);
  document.getElementById("lobby-screen").style.display = "flex";
};
game.playAgain = function() {
  document.getElementById("gameover-screen").style.display = "none";
  MusicManager.duck(300);
  this.init();
};
game.openLogoutConfirm = function() {
  document.getElementById("confirm-logout-modal").style.display = "flex";
};
game.closeLogoutConfirm = function() {
  document.getElementById("confirm-logout-modal").style.display = "none";
};
game.confirmLogout = async function() {
  game.closeLogoutConfirm();
  document.getElementById("settings-panel").style.display = "none";
  await SaveSystem.signOut();
  location.reload();
};
game.openDeleteConfirm = function() {
  document.getElementById("confirm-delete-modal").style.display = "flex";
};
game.closeDeleteConfirm = function() {
  document.getElementById("confirm-delete-modal").style.display = "none";
};
game.resetAllProgress = async function() {
  if (typeof SaveSystem.clearProgress === "function") await SaveSystem.clearProgress();
  if (typeof PlayerProfile !== "undefined") PlayerProfile.reset();
  if (typeof AchievementManager !== "undefined") AchievementManager.resetAll();
  if (typeof Progression !== "undefined") Progression.reset();
  Settings.bestWave = 0;
  Settings.save();
};
game.confirmDeleteProgress = async function() {
  game.closeDeleteConfirm();
  document.getElementById("settings-panel").style.display = "none";
  await game.resetAllProgress();
  location.reload();
};
game.openSettings = function(from) {
  this.settingsOrigin = from;
  document.getElementById(from === "lobby" ? "lobby-screen" : "esc-menu").style.display = "none";
  document.getElementById("settings-panel").style.display = "flex";
  const sfxSlider = document.getElementById("sfx-vol-slider");
  const musicSlider = document.getElementById("music-vol-slider");
  if (sfxSlider) sfxSlider.value = Settings.sfxVolume;
  if (musicSlider) musicSlider.value = Settings.musicVolume;
  document.getElementById("sfx-vol-value").innerText = Settings.sfxVolume;
  document.getElementById("music-vol-value").innerText = Settings.musicVolume;
  document.querySelectorAll("#graphics-options .option-btn").forEach((b) => b.classList.toggle("active", b.dataset.value === Settings.graphics));
};
game.closeSettings = function() {
  document.getElementById("settings-panel").style.display = "none";
  document.getElementById(this.settingsOrigin === "lobby" ? "lobby-screen" : "esc-menu").style.display = "flex";
};
game.setGraphics = function(tier) {
  Settings.graphics = tier;
  Settings.save();
  document.querySelectorAll("#graphics-options .option-btn").forEach((b) => b.classList.toggle("active", b.dataset.value === tier));
  applyPerfClass();
};
game.setSfxVolume = function(v) {
  Settings.sfxVolume = parseInt(v);
  Settings.save();
  document.getElementById("sfx-vol-value").innerText = v;
};
game.setMusicVolume = function(v) {
  Settings.musicVolume = parseInt(v);
  Settings.save();
  document.getElementById("music-vol-value").innerText = v;
  MusicManager.baseVolume = 0.25 * (Settings.musicVolume / 100);
  if (MusicManager.audio && !MusicManager.audio.paused) MusicManager.audio.volume = MusicManager.baseVolume;
};
game.toggleControls = function(show) {
  document.getElementById("lobby-screen").style.display = show ? "none" : "flex";
  const panel = document.getElementById("controls-panel");
  if (panel) panel.style.display = show ? "flex" : "none";
};
game.updateShop = function() {
  const list = document.getElementById("shop-items");
  list.innerHTML = "";
  ["G18", "KNIFE"].forEach((k) => {
    list.innerHTML += `<div class="weapon-row"><span class="weapon-row-name">${k}</span><span class="weapon-row-status owned">ADQUIRIDA</span></div>`;
  });
  Object.keys(WEAPON_COSTS).forEach((k) => {
    const owned = this.player.inventory.some((i) => i && i.name === k);
    const cost = WEAPON_COSTS[k];
    if (owned) {
      const refund = Math.floor(cost / 2);
      list.innerHTML += `<div class="weapon-row"><span class="weapon-row-name">${k}</span><span class="weapon-row-status owned">ADQUIRIDA</span><button class="sell-btn" onclick="game.sellWeapon('${k}')">VENDER ($${refund})</button></div>`;
    } else {
      list.innerHTML += `<div class="weapon-row"><span class="weapon-row-name">${k}</span><span class="weapon-row-status">$${cost}</span><button class="buy-btn" onclick="game.buyWeapon('${k}')">COMPRAR</button></div>`;
    }
  });
};
game.gameOver = function() {
  const wavesSurvived = this.wave - 1;
  const elapsedSec = Math.floor((Date.now() - this.startTime) / 1e3);
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  let recordText = "";
  if (wavesSurvived > Settings.bestWave) {
    Settings.bestWave = wavesSurvived;
    Settings.save();
    recordText = "\xA1NUEVO R\xC9CORD!";
  }
  this.paused = true;
  MusicManager.duck(600);
  document.getElementById("go-waves").innerText = wavesSurvived;
  document.getElementById("go-time").innerText = `${mm}:${ss}`;
  document.getElementById("go-record").innerText = recordText;
  document.getElementById("gameover-screen").style.display = "flex";
};
game.openCredits = function() {
  document.getElementById("lobby-screen").style.display = "none";
  document.getElementById("credits-screen").style.display = "flex";
};
game.closeCredits = function() {
  document.getElementById("credits-screen").style.display = "none";
  document.getElementById("lobby-screen").style.display = "flex";
};
const SFX = {
  // --- Disparos ---
  shoot_G18: "assets/Sounds/SFX/Shoots/PISTOLA.ogg",
  shoot_SHOTGUN: "assets/Sounds/SFX/Shoots/ESCOPETA.wav",
  shoot_SHOTGUN2: "assets/Sounds/SFX/Shoots/ESCOPETA2.mp3",
  shoot_rifle: "assets/Sounds/SFX/Shoots/RIFLES.mp3",
  shoot_smg: "assets/Sounds/SFX/Shoots/SMG.mp3",
  shoot_sniper: "assets/Sounds/SFX/Shoots/SNIPER.mp3",
  shoot_sniper2: "assets/Sounds/SFX/Shoots/SNIPER2.mp3",
  shoot_revolver: "assets/Sounds/SFX/Shoots/REVOLVER.mp3",
  // --- Nuevos (UI) ---
  levelup: "assets/Sounds/SFX/UI/NIVELUP.mp3",
  ui_back: "assets/Sounds/SFX/UI/BACKBUTTON.mp3",
  ui_click: "assets/Sounds/SFX/UI/CLICKBUTTON.mp3",
  ui_hover: "assets/Sounds/SFX/UI/HOVERBUTTON.mp3",
  achievement_unlock: "assets/Sounds/SFX/UI/LOGRODESBLOQUEADO.mp3",
  // --- Melee ---
  melee: "assets/Sounds/SFX/Shoots/MEELE.mp3",
  melee2: "assets/Sounds/SFX/Shoots/MEELE2.mp3",
  melee3: "assets/Sounds/SFX/Shoots/MEELE3.mp3",
  chainsaw: "assets/Sounds/SFX/Shoots/CHAINSAW.mp3",
  chainsaw_hit: "assets/Sounds/SFX/Shoots/CHAINSAWHIT.mp3",
  // --- Especiales ---
  flamethrower: "assets/Sounds/SFX/Shoots/FLAMETHROWER.mp3",
  rpg_launch: "assets/Sounds/SFX/Shoots/RPGLAUNCH.mp3",
  rpg_explosion: "assets/Sounds/SFX/Shoots/RPGEXPLOSION.mp3",
  // --- Variados ---
  kamikaze: "assets/Sounds/SFX/Variados/KAMIKAZEEXPLOSION.mp3",
  death: "assets/Sounds/SFX/Variados/SLIMEDEATH.mp3",
  muerte_player: "assets/Sounds/SFX/Variados/muerteplayer.mp3",
  // --- Genéricos que ya usaba el juego (mapeados a lo más parecido que mandaste) ---
  hit: "assets/Sounds/SFX/Shoots/MEELE.mp3",
  reload: "assets/Sounds/SFX/Shoots/PISTOLA.ogg",
  coin: "assets/Sounds/SFX/Variados/SLIMEDEATH.mp3",
  // placeholder intencional, no tocar
  explosion: "assets/Sounds/SFX/Shoots/RPGEXPLOSION.mp3",
  // --- Clima / Eventos ---
  wind: "assets/Sounds/SFX/Events/liecio-strong-howling-wind-132281.mp3",
  sandstorm: "assets/Sounds/SFX/Events/soundreality-sandstorm-222741.mp3",
  thunder: "assets/Sounds/SFX/Events/universfield-loud-thunder-192165.mp3",
  rain: "assets/Sounds/SFX/Events/soundsforyou-light-rain-ambient-114354.mp3"
};
const sfxPools = {};
const SFX_POOL_SIZE = 14;
const _missingSfxWarned = /* @__PURE__ */ new Set();
function getSfxPool(key) {
  if (!SFX[key]) {
    if (!_missingSfxWarned.has(key)) {
      console.warn(`[Audio] Clave de sonido inexistente: "${key}"`);
      _missingSfxWarned.add(key);
    }
    return null;
  }
  if (!sfxPools[key]) {
    sfxPools[key] = Array.from({ length: SFX_POOL_SIZE }, () => {
      const a = new Audio(SFX[key]);
      a.preservesPitch = false;
      a.preload = "auto";
      a.onerror = () => {
        if (!_missingSfxWarned.has(key)) {
          console.warn(`[Audio] No se pudo cargar el sonido local: ${SFX[key]}`);
          _missingSfxWarned.add(key);
        }
      };
      a.load();
      return a;
    });
    sfxPools[key].cursor = 0;
  }
  return sfxPools[key];
}
function playSFX(key, volume = 1, pitchVariance = 0) {
  const pool = getSfxPool(key);
  if (!pool) return;
  const a = pool[pool.cursor];
  pool.cursor = (pool.cursor + 1) % pool.length;
  try {
    a.currentTime = 0;
  } catch (e) {
  }
  const generalVol = typeof Settings !== "undefined" && typeof Settings.sfxVolume === "number" ? Settings.sfxVolume / 100 : 1;
  a.volume = Math.max(0, Math.min(1, volume * generalVol));
  a.playbackRate = pitchVariance > 0 ? 1 + (Math.random() * 2 - 1) * pitchVariance : 1;
  a.play().catch(() => {
  });
}
function preloadSFX(onProgress) {
  return new Promise((resolve) => {
    const keys = Object.keys(SFX);
    if (keys.length === 0) {
      resolve();
      return;
    }
    let loaded = 0;
    keys.forEach((key) => {
      const pool = getSfxPool(key);
      const a = pool ? pool[0] : null;
      const done = () => {
        loaded++;
        if (onProgress) onProgress(loaded, keys.length, key);
        if (loaded === keys.length) resolve();
      };
      if (!a) {
        done();
        return;
      }
      if (a.readyState >= 3) {
        done();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        done();
      };
      a.addEventListener("canplaythrough", finish, { once: true });
      a.addEventListener("error", finish, { once: true });
      setTimeout(finish, 5e3);
    });
  });
}
const MUSIC_TRACKS = {
  main: [
    "assets/Sounds/Music/Main/Tetuano - Abyss (freetouse.com).mp3"
  ],
  combat: [
    "assets/Sounds/Music/Combat/Pufino - Digital Mayham (freetouse.com).mp3",
    "assets/Sounds/Music/Combat/Zambolino - Imperator (freetouse.com).mp3",
    "assets/Sounds/Music/Combat/Pufino - Metal Is Trash (freetouse.com).mp3",
    "assets/Sounds/Music/Combat/NewMe.mp3",
    "assets/Sounds/Music/Combat/Buddy.mp3",
    "assets/Sounds/Music/Combat/NoPuedesConmigo.mp3",
    "assets/Sounds/Music/Combat/ImTheBest.mp3"
  ],
  boss: [
    "assets/Sounds/Music/Boss/Horizonte.mp3",
    "assets/Sounds/Music/Boss/Finally.mp3",
    "assets/Sounds/Music/Boss/Punch.mp3"
  ]
};
function preloadMusic(onProgress) {
  return new Promise((resolve) => {
    const allTracks = [...MUSIC_TRACKS.main, ...MUSIC_TRACKS.combat, ...MUSIC_TRACKS.boss];
    if (allTracks.length === 0) {
      resolve();
      return;
    }
    let loaded = 0;
    allTracks.forEach((src) => {
      const a = new Audio();
      a.preload = "auto";
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        loaded++;
        if (onProgress) onProgress(loaded, allTracks.length, src);
        if (loaded === allTracks.length) resolve();
      };
      a.addEventListener("loadedmetadata", finish, { once: true });
      a.addEventListener("error", () => {
        console.warn(`[Audio] No se pudo precargar la m\xFAsica: ${src}`);
        finish();
      }, { once: true });
      a.src = src;
      setTimeout(finish, 6e3);
    });
  });
}
const MusicManager = {
  // Se mantienen estos 3 nombres porque otros archivos (world.js) los referencian directamente.
  mainTracks: MUSIC_TRACKS.main,
  combatTracks: MUSIC_TRACKS.combat,
  bossTracks: MUSIC_TRACKS.boss,
  tracks: [],
  audio: null,
  currentIndex: -1,
  baseVolume: 0.25,
  fadeTimer: null,
  init() {
    this.audio = new Audio();
    this.audio.volume = 0;
    this.baseVolume = 0.25 * (Settings.musicVolume / 100);
    this.audio.addEventListener("ended", () => this.next());
    this.audio.addEventListener("error", () => {
      if (this.audio.src) console.warn(`[Audio] No se pudo cargar la m\xFAsica: ${this.audio.src}`);
      this.next();
    });
  },
  // Cambia de categoría de música (main/combate/jefe) solo si es distinta a la actual,
  // así no corta una canción de combate a mitad para volver a poner... la misma categoría.
  switchContext(trackList, fadeMs = 1500) {
    if (this.tracks === trackList) return;
    this.tracks = trackList;
    this.next(fadeMs);
  },
  _fadeTo(target, duration, onComplete) {
    if (!this.audio) return;
    clearInterval(this.fadeTimer);
    const from = this.audio.volume;
    const t0 = performance.now();
    this.fadeTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - t0) / duration);
      this.audio.volume = from + (target - from) * t;
      if (t >= 1) {
        clearInterval(this.fadeTimer);
        if (onComplete) onComplete();
      }
    }, 50);
  },
  _playFromIndex(idx, fadeMs) {
    this.currentIndex = idx;
    this.audio.src = this.tracks[idx];
    this.audio.volume = 0;
    this.audio.play().then(() => this._fadeTo(this.baseVolume, fadeMs)).catch(() => {
    });
  },
  playLobby() {
    this.tracks = this.mainTracks;
    this.currentIndex = -1;
    this.start();
  },
  start() {
    if (!this.audio || !this.audio.paused || !this.tracks.length) return;
    const idx = this.currentIndex === -1 ? Math.floor(Math.random() * this.tracks.length) : this.currentIndex;
    this._playFromIndex(idx, 1500);
  },
  next(fadeMs = 1500) {
    if (!this.audio || !this.tracks.length) return;
    let idx = Math.floor(Math.random() * this.tracks.length);
    if (this.tracks.length > 1 && idx === this.currentIndex) idx = (idx + 1) % this.tracks.length;
    this._playFromIndex(idx, fadeMs);
  },
  resume(fadeMs = 800) {
    if (!this.audio || !this.audio.paused) return;
    this.audio.volume = 0;
    this.audio.play().then(() => this._fadeTo(this.baseVolume, fadeMs)).catch(() => {
    });
  },
  duck(duration = 1200) {
    if (!this.audio || this.audio.paused) return;
    this._fadeTo(0, duration, () => this.audio.pause());
  }
};
const AmbientAudio = {
  audio: null,
  play(key, volume = 0.35) {
    this.stop();
    const src = SFX[key];
    if (!src) {
      console.warn(`[Audio] Sonido ambiente inexistente: "${key}"`);
      return;
    }
    this.audio = new Audio(src);
    this.audio.loop = true;
    this.audio.volume = volume * (Settings.sfxVolume / 100);
    this.audio.onerror = () => console.warn(`[Audio] No se pudo cargar el ambiente: ${src}`);
    this.audio.play().catch(() => {
    });
  },
  stop() {
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
  }
};
function isVisible(x, y, radius, cam) {
  const padding = 50;
  return x + radius + padding > cam.x && x - radius - padding < cam.x + canvas.width && y + radius + padding > cam.y && y - radius - padding < cam.y + canvas.height;
}
class Trail {
  init(x, y, radius) {
    this.x = x;
    this.y = y;
    this.radius = radius * (0.6 + Math.random() * 0.4);
    this.life = 1;
    this.active = true;
  }
  update() {
    this.life -= 0.015;
    if (this.life <= 0) this.active = false;
  }
  draw(cam) {
    if (!isVisible(this.x, this.y, this.radius, cam)) return;
    ctx.globalAlpha = this.life * 0.4;
    ctx.fillStyle = "#a8e6cf";
    ctx.beginPath();
    ctx.arc(this.x - cam.x, this.y - cam.y, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}
class Casing {
  init(x, y, dir) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(dir + Math.PI / 2 + (Math.random() - 0.5)) * (2 + Math.random() * 3);
    this.vy = Math.sin(dir + Math.PI / 2 + (Math.random() - 0.5)) * (2 + Math.random() * 3);
    this.life = 1;
    this.rot = Math.random() * Math.PI;
    this.vRot = Math.random() - 0.5;
    this.active = true;
  }
  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.vx *= 0.85;
    this.vy *= 0.85;
    this.rot += this.vRot;
    if (Math.abs(this.vx) < 0.1) this.life -= 0.01;
    if (this.life <= 0) this.active = false;
  }
  draw(cam) {
    if (!isVisible(this.x, this.y, 4, cam)) return;
    ctx.globalAlpha = Math.max(0, this.life);
    ctx.save();
    ctx.translate(this.x - cam.x, this.y - cam.y);
    ctx.rotate(this.rot);
    ctx.fillStyle = "#f1c40f";
    ctx.fillRect(-2, -1, 4, 2);
    ctx.strokeStyle = "#d35400";
    ctx.lineWidth = 1;
    ctx.strokeRect(-2, -1, 4, 2);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
class FloatingText {
  init(x, y, text, color = "#fff", size = 20) {
    this.x = x + (Math.random() - 0.5) * 20;
    this.y = y + (Math.random() - 0.5) * 20;
    this.text = text;
    this.color = color;
    this.size = size;
    this.life = 1;
    this.vy = -1.5;
    this.active = true;
  }
  update() {
    this.y += this.vy;
    this.life -= 0.02;
    if (this.life <= 0) this.active = false;
  }
  draw(cam) {
    if (!isVisible(this.x, this.y, 30, cam)) return;
    ctx.globalAlpha = Math.max(0, this.life);
    ctx.fillStyle = this.color;
    ctx.font = `bold ${this.size}px Teko`;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 3;
    ctx.strokeText(this.text, this.x - cam.x, this.y - cam.y);
    ctx.fillText(this.text, this.x - cam.x, this.y - cam.y);
    ctx.globalAlpha = 1;
  }
}
class Particle {
  init(x, y, color, speed = 5, size = 3, type = "normal") {
    this.x = x;
    this.y = y;
    this.color = color;
    this.type = type;
    const angle = Math.random() * Math.PI * 2;
    const force = Math.random() * speed;
    this.vx = Math.cos(angle) * force;
    this.vy = Math.sin(angle) * force;
    this.life = 1;
    this.decay = (type === "smoke" ? 0.015 : 0.03 + Math.random() * 0.03) * (game.slowParticleDecay ? 0.5 : 1);
    this.size = size;
    this.active = true;
  }
  update() {
    this.x += this.vx;
    this.y += this.vy;
    if (this.type === "smoke") {
      this.size += 0.2;
      this.vx *= 0.92;
      this.vy *= 0.92;
    } else {
      this.vx *= 0.96;
      this.vy *= 0.96;
    }
    this.life -= this.decay;
    if (this.life <= 0) this.active = false;
  }
  draw(cam) {
    if (!isVisible(this.x, this.y, this.size, cam)) return;
    ctx.globalAlpha = Math.max(0, this.life);
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x - cam.x, this.y - cam.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}
class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.shake = 0;
  }
  follow(target) {
    const destX = target.x - canvas.width / 2;
    const destY = target.y - canvas.height / 2;
    this.x += (destX - this.x) * 0.15;
    this.y += (destY - this.y) * 0.15;
    this.x = Math.max(0, Math.min(this.x, MAP_SIZE - canvas.width));
    this.y = Math.max(0, Math.min(this.y, MAP_SIZE - canvas.height));
    if (game.fxEnabled && this.shake > 0.1) {
      this.x += (Math.random() - 0.5) * this.shake;
      this.y += (Math.random() - 0.5) * this.shake;
      this.shake *= 0.85;
    } else {
      this.shake = 0;
    }
  }
}
game.spawnParticle = function(x, y, color, speed, size, type) {
  let p = this.particles.find((p2) => !p2.active);
  if (p) p.init(x, y, color, speed, size, type);
};
game.spawnCasing = function(x, y, dir) {
  let c = this.casings.find((c2) => !c2.active);
  if (c) c.init(x, y, dir);
};
game.spawnTrail = function(x, y, radius) {
  let t = this.trails.find((t2) => !t2.active);
  if (t) t.init(x, y, radius);
};
game.explode = function(x, y, radius, dmg) {
  this.enemies.forEach((e) => {
    if (!e.invulnerable && Math.hypot(e.x - x, e.y - y) < radius) this.hitEnemy(e, dmg);
  });
  if (Math.hypot(this.player.x - x, this.player.y - y) < radius) this.player.takeDamage(dmg * 0.4);
  for (let i = 0; i < Math.ceil(24 * this.particleScale); i++) this.spawnParticle(x, y, i % 2 === 0 ? "#e67e22" : "#f1c40f", 8, 5, "normal");
  for (let i = 0; i < Math.ceil(6 * this.particleScale); i++) this.spawnParticle(x, y, "#555", 3, 6, "smoke");
  this.camera.shake = 20;
  playSFX("rpg_explosion", 0.5, 0.1);
};
const WEATHER_POOL_SIZE = 400;
let weatherParticles = Array.from({ length: WEATHER_POOL_SIZE }, () => ({ active: false }));
let weatherCursor = 0;
function spawnWeatherParticle(kind, color) {
  if (!game.fxEnabled) return;
  if (Math.random() > (game.particleScale || 1)) return;
  const p = weatherParticles[weatherCursor];
  weatherCursor = (weatherCursor + 1) % weatherParticles.length;
  p.kind = kind;
  p.color = color;
  p.active = true;
  if (kind === "rain" || kind === "blood") {
    p.x = Math.random() * canvas.width;
    p.y = -20;
    p.vx = -1.5;
    p.vy = 14 + Math.random() * 6;
  } else if (kind === "snow") {
    p.x = Math.random() * canvas.width;
    p.y = -10;
    p.vx = (Math.random() - 0.5) * 1.5;
    p.vy = 1.5 + Math.random() * 1.5;
    p.size = 2 + Math.random() * 3;
  } else if (kind === "sand") {
    p.x = -20;
    p.y = Math.random() * canvas.height;
    p.vx = 6 + Math.random() * 4;
    p.vy = (Math.random() - 0.5) * 2;
    p.size = 2 + Math.random() * 2;
  } else {
    p.x = Math.random() * canvas.width;
    p.y = Math.random() * canvas.height;
    p.vx = 0.3 + Math.random() * 0.3;
    p.vy = 0;
    p.size = 60 + Math.random() * 80;
  }
  p.life = 1;
}
function updateAndDrawWeatherParticles() {
  for (let i = 0; i < weatherParticles.length; i++) {
    const p = weatherParticles[i];
    if (!p.active) continue;
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.kind === "fog" ? 3e-3 : 0.01;
    if (p.y > canvas.height + 30 || p.x > canvas.width + 80 || p.x < -80 || p.life <= 0) {
      p.active = false;
      continue;
    }
    ctx.globalAlpha = Math.max(0, p.life) * (p.kind === "fog" ? 0.18 : p.kind === "sand" ? 0.35 : 0.6);
    ctx.fillStyle = p.color;
    if (p.kind === "rain" || p.kind === "blood") {
      ctx.fillRect(p.x, p.y, 2, 14);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
function drawFlatTint(color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
function drawVisionOverlay(clearRadius, color) {
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const grad = ctx.createRadialGradient(cx, cy, clearRadius * 0.35, cx, cy, clearRadius);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
function triggerLightningStrike() {
  const x = Math.random() * MAP_SIZE, y = Math.random() * MAP_SIZE;
  const dmg = 30;
  if (Math.hypot(game.player.x - x, game.player.y - y) < 100) game.player.takeDamage(dmg);
  game.enemies.forEach((e) => {
    if (!e.invulnerable && Math.hypot(e.x - x, e.y - y) < 100) game.hitEnemy(e, dmg);
  });
  if (isVisible(x, y, 100, game.camera)) {
    for (let i = 0; i < Math.ceil(15 * game.particleScale); i++) game.spawnParticle(x, y, "#fff", 8, 4, "normal");
    game.camera.shake = 15;
  }
}
function triggerBombardment() {
  const a = Math.random() * Math.PI * 2, d = Math.random() * 500;
  const x = game.player.x + Math.cos(a) * d, y = game.player.y + Math.sin(a) * d;
  const radius = 110, dmg = 25;
  if (Math.hypot(game.player.x - x, game.player.y - y) < radius) game.player.takeDamage(dmg);
  game.enemies.forEach((e) => {
    if (!e.invulnerable && Math.hypot(e.x - x, e.y - y) < radius) game.hitEnemy(e, dmg);
  });
  for (let i = 0; i < Math.ceil(20 * game.particleScale); i++) game.spawnParticle(x, y, "#e67e22", 7, 4, "normal");
  if (isVisible(x, y, radius, game.camera)) game.camera.shake = 14;
}
const RANDOM_EVENTS = {
  RAIN: {
    label: "\u2614 LLUVIA",
    ambient: "rain",
    onStart() {
      game.enemySpeedMult = 1.1;
      game.weaponSpreadBonus = 0.05;
    },
    onUpdate() {
      if (Math.random() > 0.3) spawnWeatherParticle("rain", "#7fa8d9");
    },
    onDraw() {
      drawFlatTint("rgba(15,25,45,0.15)");
    }
  },
  STORM: {
    label: "\u{1F329}\uFE0F TORMENTA EL\xC9CTRICA",
    ambient: "rain",
    onStart() {
      game.enemySpeedMult = 1.1;
      game._lightningTimer = 200 + Math.random() * 200;
    },
    onUpdate() {
      if (Math.random() > 0.25) spawnWeatherParticle("rain", "#aab8ff");
      game._lightningTimer--;
      if (game._lightningTimer <= 0) {
        playSFX("thunder", 0.6, 0.1);
        game._lightningTimer = 300 + Math.random() * 300;
        setTimeout(() => {
          if (game.activeEvent === "STORM") triggerLightningStrike();
        }, 1200);
      }
    },
    onDraw() {
      drawFlatTint("rgba(5,5,15,0.35)");
    }
  },
  FOG: {
    label: "\u{1F32B}\uFE0F NIEBLA",
    onStart() {
    },
    onUpdate() {
      if (Math.random() > 0.6) spawnWeatherParticle("fog", "rgba(200,200,210,0.5)");
    },
    onDraw() {
      drawVisionOverlay(260, "rgba(180,182,190,0.92)");
    }
  },
  BLIZZARD: {
    label: "\u2744\uFE0F VENTISCA",
    ambient: "wind",
    onStart() {
      game.playerSpeedMult = 0.75;
    },
    onUpdate() {
      if (Math.random() > 0.3) spawnWeatherParticle("snow", Math.random() > 0.5 ? "#eaf6ff" : "#aee3ff");
    },
    onDraw() {
      drawFlatTint("rgba(140,190,255,0.12)");
    }
  },
  HEATWAVE: {
    label: "\u{1F525} OLA DE CALOR",
    onStart() {
      game.slowParticleDecay = true;
    },
    onUpdate() {
    },
    onDraw() {
      drawFlatTint(`rgba(230,90,20,${0.12 + Math.sin(Date.now() / 300) * 0.03})`);
    }
  },
  SANDSTORM: {
    label: "\u{1F32A}\uFE0F TORMENTA DE ARENA",
    ambient: "sandstorm",
    onStart() {
      game.projectileSpeedMult = 0.8;
    },
    onUpdate() {
      if (Math.random() > 0.2) spawnWeatherParticle("sand", "#c9a86a");
    },
    onDraw() {
      drawVisionOverlay(230, "rgba(150,130,50,0.92)");
    }
  },
  RADIOACTIVE: {
    label: "\u2622\uFE0F LLUVIA RADIACTIVA",
    ambient: "rain",
    onStart() {
      game.moneyMult = 1.5;
      game._dotTimer = 0;
    },
    onUpdate() {
      if (Math.random() > 0.3) spawnWeatherParticle("rain", "#39ff14");
      game._dotTimer++;
      if (game._dotTimer > 50) {
        game._dotTimer = 0;
        game.player.takeDamage(2);
        game.enemies.forEach((e) => {
          if (!e.invulnerable) game.hitEnemy(e, 2);
        });
      }
    },
    onDraw() {
      drawFlatTint("rgba(20,90,20,0.18)");
    }
  },
  MUTATION: {
    label: "\u{1F9EA} MUTACI\xD3N",
    onStart() {
      game.enemySizeMult = 1.3;
      game.enemyHpMult = 1.5;
      game.enemyDamageMult = 1.4;
    },
    onUpdate() {
    },
    onDraw() {
      drawFlatTint("rgba(20,60,20,0.08)");
    }
  },
  INVASION: {
    label: "\u{1F480} INVASI\xD3N",
    onStart() {
    },
    onUpdate() {
    },
    onDraw() {
    }
  },
  FRENZY: {
    label: "\u{1FA78} FRENES\xCD",
    ambient: "rain",
    onStart() {
      game.enemySpeedMult = 1.4;
    },
    onUpdate() {
      if (Math.random() > 0.3) spawnWeatherParticle("blood", "#c0392b");
    },
    onDraw() {
      drawFlatTint("rgba(120,0,0,0.15)");
    }
  },
  BOMBARDMENT: {
    label: "\u{1F4A3} BOMBARDEO",
    onStart() {
      game._bombTimer = 120 + Math.random() * 120;
    },
    onUpdate() {
      game._bombTimer--;
      if (game._bombTimer <= 0) {
        triggerBombardment();
        game._bombTimer = 150 + Math.random() * 200;
      }
    },
    onDraw() {
    }
  },
  DARKNESS: {
    label: "\u{1F311} OSCURIDAD TOTAL",
    onStart() {
    },
    onUpdate() {
    },
    onDraw() {
      drawVisionOverlay(150, "rgba(0,0,0,0.97)");
    }
  },
  LOW_GRAVITY: {
    label: "\u{1F300} GRAVEDAD BAJA",
    onStart() {
      game.knockbackMult = 3.5;
    },
    onUpdate() {
    },
    onDraw() {
    }
  },
  SLOW_TIME: {
    label: "\u23F1\uFE0F TIEMPO LENTO",
    onStart() {
    },
    onUpdate() {
    },
    onDraw() {
      drawFlatTint("rgba(70,80,120,0.08)");
    }
  },
  OVERCHARGE: {
    label: "\u26A1 SOBRECARGA",
    onStart() {
      game.weaponFireRateMult = 0.5;
    },
    onUpdate() {
    },
    onDraw() {
    }
  }
};
const EventManager = {
  // Vuelve todos los modificadores a su valor por defecto (se llama al activar y al terminar)
  reset() {
    game.enemySpeedMult = 1;
    game.enemySizeMult = 1;
    game.enemyHpMult = 1;
    game.enemyDamageMult = 1;
    game.playerSpeedMult = 1;
    game.weaponSpreadBonus = 0;
    game.weaponFireRateMult = 1;
    game.projectileSpeedMult = 1;
    game.knockbackMult = 1;
    game.moneyMult = 1;
    game.slowParticleDecay = false;
    weatherParticles.forEach((p) => p.active = false);
  },
  // ~25% de probabilidad, nunca repite el evento inmediatamente anterior
  roll() {
    if (Math.random() > 0.25) return null;
    const keys = Object.keys(RANDOM_EVENTS).filter((k) => k !== game.lastEventKey);
    return keys[Math.floor(Math.random() * keys.length)];
  },
  // Muestra la alerta grande ~5s con el juego pausado, y al terminar ejecuta onComplete
  showAlert(key, onComplete) {
    game.paused = true;
    const def = RANDOM_EVENTS[key];
    const alertEl = document.getElementById("event-alert");
    if (alertEl) {
      alertEl.querySelector(".event-alert-title").innerText = def.label;
      alertEl.style.display = "flex";
    }
    setTimeout(() => {
      if (alertEl) alertEl.style.display = "none";
      onComplete();
    }, 5e3);
  },
  activate(key) {
    this.reset();
    game.activeEvent = key;
    game.lastEventKey = key;
    const def = RANDOM_EVENTS[key];
    if (def.ambient) AmbientAudio.play(def.ambient);
    if (def.onStart) def.onStart();
    const badge = document.getElementById("event-badge");
    if (badge) {
      badge.innerText = def.label;
      badge.style.display = "block";
    }
  },
  deactivate() {
    if (!game.activeEvent) return;
    AmbientAudio.stop();
    game.activeEvent = null;
    this.reset();
    const badge = document.getElementById("event-badge");
    if (badge) badge.style.display = "none";
  },
  update() {
    if (!game.activeEvent) return;
    const def = RANDOM_EVENTS[game.activeEvent];
    if (def.onUpdate) def.onUpdate();
  },
  drawOverlay() {
    updateAndDrawWeatherParticles();
    if (!game.activeEvent) return;
    const def = RANDOM_EVENTS[game.activeEvent];
    if (def.onDraw) def.onDraw();
  }
};
function createProceduralTerrain() {
  const offCanvas = document.createElement("canvas");
  offCanvas.width = 512;
  offCanvas.height = 512;
  const oCtx = offCanvas.getContext("2d");
  oCtx.fillStyle = "#3e4a3d";
  oCtx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 300; i++) {
    oCtx.fillStyle = Math.random() > 0.5 ? "#455344" : "#384236";
    oCtx.beginPath();
    oCtx.arc(Math.random() * 512, Math.random() * 512, Math.random() * 15, 0, Math.PI * 2);
    oCtx.fill();
  }
  for (let i = 0; i < 15; i++) {
    oCtx.fillStyle = "rgba(92, 64, 51, 0.15)";
    oCtx.beginPath();
    oCtx.arc(Math.random() * 512, Math.random() * 512, 20 + Math.random() * 40, 0, Math.PI * 2);
    oCtx.fill();
  }
  for (let i = 0; i < 150; i++) {
    oCtx.fillStyle = Math.random() > 0.5 ? "#2c3e50" : "#1e272e";
    oCtx.globalAlpha = 0.4;
    oCtx.beginPath();
    oCtx.arc(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 2, 0, Math.PI * 2);
    oCtx.fill();
  }
  oCtx.globalAlpha = 1;
  return ctx.createPattern(offCanvas, "repeat");
}
const terrainPattern = createProceduralTerrain();
class Prop {
  constructor(type) {
    this.type = type;
    this.x = Math.random() * MAP_SIZE;
    this.y = Math.random() * MAP_SIZE;
    this.rot = Math.random() * Math.PI * 2;
    this.scale = 0.8 + Math.random() * 0.5;
    if (["rock", "rock_tall", "rock_split", "tree", "tree_pine", "tree_dead", "crate"].includes(type)) {
      this.isSolid = true;
      this.radius = type.includes("tree") ? 15 * this.scale : type === "crate" ? 25 * this.scale : 20 * this.scale;
    } else {
      this.isSolid = false;
      this.radius = 0;
    }
  }
  drawShadow(cam) {
    if (!isVisible(this.x, this.y, 40, cam)) return;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(this.x - cam.x + 15 * this.scale, this.y - cam.y + 10 * this.scale, 35 * this.scale, 20 * this.scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  draw(cam) {
    if (!isVisible(this.x, this.y, 50 * this.scale, cam)) return;
    ctx.save();
    ctx.translate(this.x - cam.x, this.y - cam.y);
    ctx.rotate(this.rot);
    ctx.scale(this.scale, this.scale);
    if (this.type.includes("rock")) {
      ctx.fillStyle = "#7f8c8d";
      ctx.strokeStyle = "#2c3e50";
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (this.type === "rock_tall") {
        ctx.moveTo(-15, 10);
        ctx.lineTo(-10, -40);
        ctx.lineTo(10, -35);
        ctx.lineTo(15, 10);
      } else if (this.type === "rock_split") {
        ctx.moveTo(-20, -5);
        ctx.lineTo(-5, -20);
        ctx.lineTo(0, 0);
        ctx.lineTo(15, -15);
        ctx.lineTo(25, 10);
        ctx.lineTo(-25, 10);
      } else {
        ctx.moveTo(-20, -10);
        ctx.lineTo(10, -25);
        ctx.lineTo(30, 5);
        ctx.lineTo(10, 20);
        ctx.lineTo(-25, 10);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.beginPath();
      ctx.arc(-5, -5, 10, 0, Math.PI);
      ctx.fill();
    } else if (this.type.includes("tree")) {
      ctx.fillStyle = "#5c4033";
      ctx.strokeStyle = "#3e2723";
      ctx.lineWidth = 2;
      ctx.fillRect(-5, -10, 10, 20);
      ctx.strokeRect(-5, -10, 10, 20);
      if (this.type === "tree_pine") {
        ctx.fillStyle = "#1e8449";
        ctx.strokeStyle = "#145a32";
        ctx.beginPath();
        ctx.moveTo(0, -50);
        ctx.lineTo(-25, 0);
        ctx.lineTo(25, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -30);
        ctx.lineTo(-30, 15);
        ctx.lineTo(30, 15);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (this.type === "tree") {
        ctx.fillStyle = "#27ae60";
        ctx.strokeStyle = "#1e8449";
        for (let i = 0; i < 4; i++) {
          ctx.beginPath();
          ctx.arc(Math.cos(i * 1.5) * 15, -15 + Math.sin(i * 1.5) * 10, 20, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else if (this.type === "tree_dead") {
        ctx.strokeStyle = "#5c4033";
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-15, -30);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(15, -25);
        ctx.stroke();
      }
    } else if (this.type === "crate") {
      ctx.fillStyle = "#d35400";
      ctx.strokeStyle = "#873600";
      ctx.lineWidth = 3;
      ctx.fillRect(-20, -20, 40, 40);
      ctx.strokeRect(-20, -20, 40, 40);
      ctx.beginPath();
      ctx.moveTo(-20, -20);
      ctx.lineTo(20, 20);
      ctx.moveTo(20, -20);
      ctx.lineTo(-20, 20);
      ctx.stroke();
      ctx.fillStyle = "rgba(0,0,0,0.2)";
      ctx.fillRect(0, -20, 20, 40);
    } else if (this.type === "bush") {
      ctx.fillStyle = "#1e8449";
      ctx.strokeStyle = "#145a32";
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(Math.cos(i * 2.1) * 10, Math.sin(i * 2.1) * 10, 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    } else if (this.type === "pebbles") {
      ctx.fillStyle = "#95a5a6";
      ctx.beginPath();
      ctx.arc(-5, -2, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(5, 3, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 5, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
game.buildPropGrid = function() {
  this.propGridSize = 200;
  this.propGrid = /* @__PURE__ */ new Map();
  this._nearbyPropsScratch = [];
  this.props.forEach((p) => {
    if (!p.isSolid) return;
    const key = this.propGridKey(p.x, p.y);
    if (!this.propGrid.has(key)) this.propGrid.set(key, []);
    this.propGrid.get(key).push(p);
  });
};
game.propGridKey = function(x, y) {
  return Math.floor(x / this.propGridSize) * 1e5 + Math.floor(y / this.propGridSize);
};
game.getNearbyProps = function(x, y) {
  const gx = Math.floor(x / this.propGridSize);
  const gy = Math.floor(y / this.propGridSize);
  const result = this._nearbyPropsScratch;
  result.length = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const arr = this.propGrid.get((gx + dx) * 1e5 + (gy + dy));
      if (arr) for (let i = 0; i < arr.length; i++) result.push(arr[i]);
    }
  }
  return result;
};
const WEAPON_COSTS = {
  REVOLVER: 500,
  MACHETE: 400,
  UZI: 600,
  CROSSBOW: 700,
  SHOTGUN: 1e3,
  AK47: 1800,
  MINIGUN: 2500,
  SNIPER: 2200,
  MP5: 900,
  P90: 1300,
  SAWEDOFF: 1100,
  AA12: 2e3,
  M4A1: 1600,
  FAMAS: 1500,
  SCAR: 2100,
  WINCHESTER: 1400,
  AWP: 3200,
  M249: 2600,
  RPG: 3500,
  FLAMETHROWER: 2400,
  CHAINSAW: 1700
};
game.startNextWave = function() {
  document.getElementById("shop-menu").style.display = "none";
  const eventKey = EventManager.roll();
  if (eventKey) {
    EventManager.showAlert(eventKey, () => {
      EventManager.activate(eventKey);
      this._launchWave();
    });
  } else {
    this._launchWave();
  }
};
game._launchWave = function() {
  this.isWaveActive = true;
  this.paused = false;
  MusicManager.tracks = MusicManager.combatTracks;
  MusicManager.next(1200);
  let count = 15 + this.wave * 8;
  if (this.activeEvent === "INVASION") count *= 2;
  for (let i = 0; i < count; i++) {
    let a = Math.random() * Math.PI * 2;
    let d = 800 + Math.random() * 600;
    let type = this.wave > 6 && Math.random() > 0.85 ? "GHOST" : this.wave > 4 && Math.random() > 0.85 ? "INVISIBLE" : this.wave > 3 && Math.random() > 0.85 ? "KAMIKAZE" : this.wave > 3 && Math.random() > 0.8 ? "TANK" : this.wave > 2 && Math.random() > 0.7 ? "RANGED" : this.wave > 1 && Math.random() > 0.8 ? "FAST" : "BASIC";
    let pos = this.findClearSpawn(this.player.x + Math.cos(a) * d, this.player.y + Math.sin(a) * d);
    this.enemies.push(new Enemy(pos.x, pos.y, type));
  }
  if (this.wave === 5 || this.wave === 15 || this.wave === 30 || this.wave > 30 && (this.wave - 30) % 10 === 0) {
    this.bossPending = true;
  } else {
    this.bossPending = false;
  }
};
game.spawnBoss = function() {
  let a = Math.random() * Math.PI * 2;
  let bossPos = this.findClearSpawn(this.player.x + Math.cos(a) * 800, this.player.y + Math.sin(a) * 800);
  this.enemies.push(new Enemy(bossPos.x, bossPos.y, "BOSS"));
  MusicManager.switchContext(MusicManager.bossTracks, 1e3);
};
game.findClearSpawn = function(x, y) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let blocked = this.props.some((p) => p.isSolid && Math.hypot(x - p.x, y - p.y) < p.radius + 45);
    if (!blocked) return { x, y };
    x += (Math.random() - 0.5) * 200;
    y += (Math.random() - 0.5) * 200;
  }
  return { x, y };
};
game.buyAmmo = function() {
  if (this.player.money >= 150) {
    this.player.money -= 150;
    this.player.inventory.forEach((w) => {
      if (w && w.type === "range") w.ammo = w.capacity;
    });
    playSFX("reload");
  }
};
game.buyHealth = function() {
  if (this.player.money >= 200 && this.player.hp < this.player.maxHp) {
    this.player.money -= 200;
    this.player.hp = this.player.maxHp;
    playSFX("coin");
  }
};
game.buyWeapon = function(k) {
  const w = WEAPONS_DB[k];
  const cost = WEAPON_COSTS[k];
  if (this.player.money >= cost) {
    let slot = this.player.inventory.findIndex((s) => s === null);
    if (slot !== -1) {
      this.player.money -= cost;
      this.player.inventory[slot] = { ...w, ammo: w.capacity };
      playSFX("reload");
      this.updateShop();
    }
  }
};
game.sellWeapon = function(k) {
  let idx = this.player.inventory.findIndex((i) => i && i.name === k);
  if (idx === -1) return;
  const refund = Math.floor(WEAPON_COSTS[k] / 2);
  this.player.money += refund;
  this.player.inventory[idx] = null;
  if (this.player.activeSlot === idx) {
    let fallback = this.player.inventory.findIndex((s) => s !== null);
    this.player.activeSlot = fallback !== -1 ? fallback : 0;
  }
  playSFX("coin");
  this.updateShop();
};
const WEAPONS_DB = {
  // --- MELÉ ---
  KNIFE: { name: "KNIFE", damage: 60, fireRate: 250, capacity: Infinity, reloadTime: 0, speed: 5, range: 65, type: "melee", color: "#bdc3c7", shake: 2, spread: 0 },
  MACHETE: { name: "MACHETE", damage: 100, fireRate: 320, capacity: Infinity, reloadTime: 0, speed: 5, range: 95, type: "melee", color: "#ecf0f1", shake: 4, spread: 0 },
  CHAINSAW: { name: "CHAINSAW", damage: 9, fireRate: 90, capacity: Infinity, reloadTime: 0, speed: 5, range: 65, type: "melee", color: "#7f8c8d", shake: 3, spread: 0, fuel: 100, fuelDrain: 2.2, sfx: "chainsaw" },
  // --- PISTOLAS ---
  G18: { name: "G18", damage: 25, fireRate: 200, capacity: 15, reloadTime: 1e3, speed: 18, type: "range", color: "#f1c40f", shake: 3, spread: 0.05, casing: true, smoke: 1, sfx: "shoot_G18" },
  REVOLVER: { name: "REVOLVER", damage: 45, fireRate: 500, capacity: 6, reloadTime: 1400, speed: 22, type: "range", color: "#95a5a6", shake: 5, spread: 0.03, casing: true, smoke: 1, sfx: "shoot_G18", pierce: 3 },
  // --- SUBFUSILES ---
  UZI: { name: "UZI", damage: 15, fireRate: 70, capacity: 40, reloadTime: 1500, speed: 20, type: "range", color: "#e67e22", shake: 4, spread: 0.15, casing: true, smoke: 2, sfx: "shoot_G18" },
  MP5: { name: "MP5", damage: 22, fireRate: 110, capacity: 30, reloadTime: 1400, speed: 22, type: "range", color: "#7f8c8d", shake: 2, spread: 0.025, casing: true, smoke: 1, sfx: "shoot_G18" },
  P90: { name: "P90", damage: 18, fireRate: 90, capacity: 50, reloadTime: 1700, speed: 21, type: "range", color: "#9b59b6", shake: 3, spread: 0.06, casing: true, smoke: 1, sfx: "shoot_G18", mobility: true },
  // --- ESCOPETAS ---
  SHOTGUN: { name: "SHOTGUN", damage: 20, fireRate: 900, capacity: 7, reloadTime: 2200, speed: 15, type: "range", pellets: 8, color: "#e74c3c", shake: 15, spread: 0.22, casing: true, smoke: 5, sfx: "shoot_SHOTGUN", knockback: 220 },
  SAWEDOFF: { name: "SAWEDOFF", damage: 35, fireRate: 1100, capacity: 2, reloadTime: 1800, speed: 14, type: "range", pellets: 10, color: "#c0392b", shake: 18, spread: 0.35, casing: true, smoke: 6, sfx: "shoot_SHOTGUN", maxRange: 260, knockback: 260 },
  AA12: { name: "AA12", damage: 18, fireRate: 220, capacity: 20, reloadTime: 2200, speed: 15, type: "range", pellets: 6, color: "#e67e22", shake: 10, spread: 0.2, casing: true, smoke: 3, sfx: "shoot_SHOTGUN", knockback: 100 },
  // --- RIFLES ---
  AK47: { name: "AK47", damage: 40, fireRate: 140, capacity: 30, reloadTime: 1800, speed: 24, type: "range", color: "#27ae60", shake: 6, spread: 0.08, casing: true, smoke: 3, sfx: "shoot_G18" },
  M4A1: { name: "M4A1", damage: 32, fireRate: 160, capacity: 30, reloadTime: 1600, speed: 23, type: "range", color: "#2ecc71", shake: 3, spread: 0.015, casing: true, smoke: 2, sfx: "shoot_G18" },
  FAMAS: { name: "FAMAS", damage: 28, fireRate: 550, capacity: 24, reloadTime: 1700, speed: 23, type: "range", color: "#3498db", shake: 5, spread: 0.04, casing: true, smoke: 2, sfx: "shoot_G18", burst: 3, burstDelay: 65 },
  SCAR: { name: "SCAR", damage: 55, fireRate: 450, capacity: 20, reloadTime: 1900, speed: 25, type: "range", color: "#16a085", shake: 8, spread: 0.03, casing: true, smoke: 2, sfx: "shoot_G18" },
  // --- PRECISIÓN ---
  WINCHESTER: { name: "WINCHESTER", damage: 130, fireRate: 900, capacity: 8, reloadTime: 450, speed: 30, type: "range", color: "#8e5a2d", shake: 10, spread: 0.01, casing: true, smoke: 2, sfx: "shoot_G18", singleReload: true },
  AWP: { name: "AWP", damage: 260, fireRate: 1700, capacity: 5, reloadTime: 2600, speed: 38, type: "range", color: "#34495e", shake: 22, spread: 0, casing: true, smoke: 2, sfx: "shoot_G18", pierce: 4 },
  SNIPER: { name: "SNIPER", damage: 220, fireRate: 1500, capacity: 5, reloadTime: 2500, speed: 35, type: "range", color: "#34495e", shake: 20, spread: 0, casing: true, smoke: 2, sfx: "shoot_G18" },
  // --- PESADAS ---
  M249: { name: "M249", damage: 24, fireRate: 90, capacity: 150, reloadTime: 4e3, speed: 22, type: "range", color: "#556b2f", shake: 5, spread: 0.12, casing: true, smoke: 3, sfx: "shoot_G18" },
  MINIGUN: { name: "MINIGUN", damage: 20, fireRate: 50, capacity: 100, reloadTime: 3e3, speed: 22, type: "range", color: "#c0392b", shake: 8, spread: 0.2, casing: true, smoke: 3, sfx: "shoot_G18", spinup: true },
  // --- ESPECIALES ---
  RPG: { name: "RPG", damage: 85, fireRate: 1400, capacity: 1, reloadTime: 2400, speed: 16, type: "range", color: "#e67e22", shake: 25, spread: 0, casing: false, smoke: 4, sfx: "shoot_SHOTGUN", explosive: true, explosionRadius: 140 },
  FLAMETHROWER: { name: "FLAMETHROWER", damage: 4, fireRate: 45, capacity: 120, reloadTime: 2200, speed: 12, type: "range", color: "#ff8800", shake: 2, spread: 0.15, casing: false, smoke: 2, sfx: "flamethrower", maxRange: 260, burn: true, pierce: 2 },
  CROSSBOW: { name: "CROSSBOW", damage: 90, fireRate: 700, capacity: 1, reloadTime: 1200, speed: 26, type: "range", color: "#16a085", shake: 4, spread: 0, casing: false, smoke: 0, sfx: "shoot_G18" }
};
const WEAPON_MUZZLE_X = {
  AK47: 45,
  SHOTGUN: 40,
  SNIPER: 48,
  MINIGUN: 30,
  REVOLVER: 20,
  CROSSBOW: 15,
  MP5: 26,
  P90: 29,
  SAWEDOFF: 20,
  AA12: 25,
  M4A1: 42,
  FAMAS: 32,
  SCAR: 24,
  WINCHESTER: 45,
  AWP: 50,
  M249: 30,
  RPG: 66,
  FLAMETHROWER: 35,
  CHAINSAW: 28
};
const STAMINA_REGEN_PER_FRAME = 15 / 60;
const SPRINT_STAMINA_DRAIN_PER_FRAME = 30 / 60;
class Player {
  constructor() {
    this.x = MAP_SIZE / 2;
    this.y = MAP_SIZE / 2;
    this.radius = 24;
    this.hp = 100;
    this.maxHp = 100;
    this.money = 0;
    this.inventory = [{ ...WEAPONS_DB.G18, ammo: 15 }, { ...WEAPONS_DB.KNIFE }, null, null, null];
    this.activeSlot = 0;
    this.isReloading = false;
    this.tick = 0;
    this.recoilOffset = 0;
    this.muzzleFlash = 0;
    this.chainsawFuel = 100;
    this.chainsawActive = false;
    this.minigunSpin = 0;
    this.burstBusy = false;
    this.stamina = 100;
    this.maxStamina = 100;
    this.isDashing = false;
    this.dashTimer = 0;
    this.dashCooldownTimer = 0;
    this.dashDirX = 0;
    this.dashDirY = 0;
    this.bubbles = Array.from({ length: 5 }, () => ({
      x: (Math.random() - 0.5) * 20,
      y: (Math.random() - 0.5) * 20,
      s: 2 + Math.random() * 4,
      offset: Math.random() * Math.PI * 2
    }));
  }
  get weapon() {
    return this.inventory[this.activeSlot];
  }
  takeDamage(amt) {
    this.hp = Math.max(0, this.hp - amt);
    game.camera.shake = 10;
    document.getElementById("damage-overlay").style.opacity = "1";
    setTimeout(() => document.getElementById("damage-overlay").style.opacity = "0", 150);
    if (this.hp <= 0) {
      playSFX("muerte_player", 0.6);
      game.gameOver();
    }
  }
  dash() {
    if (this.dashCooldownTimer > 0 || this.isDashing || this.stamina < 20) return;
    this.stamina -= 20;
    let dx = 0, dy = 0;
    if (game.keys["KeyW"]) dy -= 1;
    if (game.keys["KeyS"]) dy += 1;
    if (game.keys["KeyA"]) dx -= 1;
    if (game.keys["KeyD"]) dx += 1;
    if (dx === 0 && dy === 0) {
      let angle = Math.atan2(game.mouse.y - (this.y - game.camera.y), game.mouse.x - (this.x - game.camera.x));
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    } else {
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
    }
    this.dashDirX = dx;
    this.dashDirY = dy;
    this.isDashing = true;
    this.dashTimer = 8;
    this.dashCooldownTimer = 45;
    game.camera.shake = 4;
    playSFX("reload", 0.15, 0.4);
    for (let i = 0; i < Math.ceil(10 * game.particleScale); i++) game.spawnParticle(this.x, this.y, "#a8e6cf", 3, 3, "normal");
  }
  update(keys) {
    if (this.dashCooldownTimer > 0) this.dashCooldownTimer--;
    this.stamina = Math.min(this.maxStamina, this.stamina + STAMINA_REGEN_PER_FRAME);
    let speedMultiplier = game.playerSpeedMult || 1;
    if ((keys["ShiftLeft"] || keys["ShiftRight"]) && this.stamina > 0.5 && !this.isDashing) {
      speedMultiplier = 1.6 * (game.playerSpeedMult || 1);
      this.stamina -= SPRINT_STAMINA_DRAIN_PER_FRAME;
    }
    if (this.weapon && this.weapon.mobility) speedMultiplier *= 1.15;
    if (this.weapon && this.weapon.spinup) {
      if (game.mouse.down && !this.isReloading) this.minigunSpin = Math.min(1, this.minigunSpin + 0.02);
      else this.minigunSpin = Math.max(0, this.minigunSpin - 0.015);
    } else if (this.minigunSpin > 0) this.minigunSpin = Math.max(0, this.minigunSpin - 0.03);
    if (this.weapon && this.weapon.fuel !== void 0) {
      if (!this.chainsawActive) this.chainsawFuel = Math.min(this.weapon.fuel, this.chainsawFuel + 0.8);
    }
    this.chainsawActive = false;
    let vx = 0, vy = 0;
    if (this.isDashing) {
      vx = this.dashDirX * 18;
      vy = this.dashDirY * 18;
      if (Math.random() > 0.3) game.spawnTrail(this.x, this.y, this.radius * 0.9);
      this.dashTimer--;
      if (this.dashTimer <= 0) this.isDashing = false;
    } else {
      if (keys["KeyW"]) vy = -5 * speedMultiplier;
      if (keys["KeyS"]) vy = 5 * speedMultiplier;
      if (keys["KeyA"]) vx = -5 * speedMultiplier;
      if (keys["KeyD"]) vx = 5 * speedMultiplier;
      if (vx !== 0 && vy !== 0) {
        vx *= 0.707;
        vy *= 0.707;
      }
    }
    if (vx !== 0 || vy !== 0) {
      this.tick += 0.3;
      if (Math.random() > 0.9) game.spawnParticle(this.x, this.y + this.radius, "#555", 1, 2, "smoke");
      if (Math.random() > 0.7) game.spawnTrail(this.x, this.y, this.radius * 0.8);
    }
    this.x = Math.max(this.radius, Math.min(MAP_SIZE - this.radius, this.x + vx));
    this.y = Math.max(this.radius, Math.min(MAP_SIZE - this.radius, this.y + vy));
    if (this.recoilOffset > 0) this.recoilOffset = Math.max(0, this.recoilOffset - 2);
    if (this.muzzleFlash > 0) this.muzzleFlash--;
  }
  draw(cam, mouse) {
    var _a;
    let moving = game.keys["KeyW"] || game.keys["KeyS"] || game.keys["KeyA"] || game.keys["KeyD"];
    const bounce = moving ? Math.abs(Math.sin(this.tick)) * 6 : 0;
    const stretchX = moving ? 1 - Math.abs(Math.cos(this.tick)) * 0.15 : 1 + this.recoilOffset * 0.02;
    const stretchY = moving ? 1 + Math.abs(Math.cos(this.tick)) * 0.15 : 1 - this.recoilOffset * 0.02;
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.ellipse(this.x - cam.x, this.y - cam.y + 12, 30, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(this.x - cam.x, this.y - cam.y - bounce);
    ctx.scale(stretchX, stretchY);
    ctx.globalAlpha = 0.9;
    let grad = ctx.createRadialGradient(-5, -10, 0, 0, 0, this.radius);
    grad.addColorStop(0, "#a8e6cf");
    grad.addColorStop(0.7, "#3b7a57");
    grad.addColorStop(1, "#2c3e50");
    ctx.fillStyle = grad;
    ctx.strokeStyle = "#1e382b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    this.bubbles.forEach((b) => {
      let by = b.y + Math.sin(this.tick * 0.5 + b.offset) * 3;
      ctx.beginPath();
      ctx.arc(b.x, by, b.s, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, 0, this.radius - 6, Math.PI + 0.5, Math.PI * 1.5 - 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    let angle = Math.atan2(mouse.y - (this.y - cam.y), mouse.x - (this.x - cam.x));
    let eyeOffsetX = Math.cos(angle) * 6;
    let eyeOffsetY = Math.sin(angle) * 6;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(-8 + eyeOffsetX, -4 + eyeOffsetY, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(8 + eyeOffsetX, -4 + eyeOffsetY, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(-8 + eyeOffsetX + Math.cos(angle) * 3, -4 + eyeOffsetY + Math.sin(angle) * 3, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(8 + eyeOffsetX + Math.cos(angle) * 3, -4 + eyeOffsetY + Math.sin(angle) * 3, 3.5, 0, Math.PI * 2);
    ctx.fill();
    if (this.weapon) {
      ctx.rotate(angle);
      ctx.translate(this.radius - 5, 0);
      ctx.translate(-this.recoilOffset, 0);
      if (game.fxEnabled) {
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 5;
        ctx.shadowOffsetY = 3;
      }
      if (this.weapon.name === "AK47") {
        ctx.fillStyle = "#873600";
        ctx.fillRect(-10, -3, 15, 6);
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(5, -4, 20, 8);
        ctx.fillStyle = "#34495e";
        ctx.beginPath();
        ctx.moveTo(15, 4);
        ctx.lineTo(10, 15);
        ctx.lineTo(20, 15);
        ctx.lineTo(25, 4);
        ctx.fill();
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(25, -2, 20, 4);
        ctx.fillStyle = "#bdc3c7";
        ctx.fillRect(35, -4, 2, 2);
      } else if (this.weapon.name === "SHOTGUN") {
        ctx.fillStyle = "#5c4033";
        ctx.fillRect(-5, -4, 15, 8);
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(10, -4, 30, 8);
        ctx.fillStyle = "#111";
        ctx.fillRect(10, -1, 30, 2);
        ctx.fillStyle = "#873600";
        ctx.fillRect(15, 4, 15, 5);
      } else if (this.weapon.name === "UZI") {
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(0, -5, 20, 10);
        ctx.fillStyle = "#34495e";
        ctx.fillRect(5, 5, 8, 14);
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(20, -2, 8, 4);
      } else if (this.weapon.name === "G18") {
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(0, -4, 15, 8);
        ctx.fillStyle = "#34495e";
        ctx.fillRect(2, 4, 6, 8);
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(15, -3, 5, 4);
      } else if (this.weapon.name === "REVOLVER") {
        ctx.fillStyle = "#5c4033";
        ctx.fillRect(-6, -3, 10, 8);
        ctx.fillStyle = "#7f8c8d";
        ctx.beginPath();
        ctx.arc(4, 0, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#95a5a6";
        ctx.fillRect(8, -3, 16, 6);
      } else if (this.weapon.name === "SNIPER") {
        ctx.fillStyle = "#34495e";
        ctx.fillRect(-10, -3, 50, 6);
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(-5, -9, 15, 5);
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(5, -12, 3, 8);
      } else if (this.weapon.name === "MINIGUN") {
        ctx.fillStyle = "#c0392b";
        ctx.fillRect(-8, -6, 15, 12);
        ctx.fillStyle = "#2c3e50";
        for (let i = 0; i < 4; i++) ctx.fillRect(8, -6 + i * 3, 22, 2);
      } else if (this.weapon.name === "CROSSBOW") {
        ctx.strokeStyle = "#16a085";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(5, -14);
        ctx.lineTo(15, 0);
        ctx.lineTo(5, 14);
        ctx.stroke();
        ctx.fillStyle = "#5c4033";
        ctx.fillRect(-5, -2, 20, 4);
      } else if (this.weapon.name === "MP5") {
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(0, -4, 26, 8);
        ctx.fillStyle = "#34495e";
        ctx.fillRect(4, 4, 6, 12);
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(26, -2, 8, 4);
      } else if (this.weapon.name === "P90") {
        ctx.fillStyle = "#8e44ad";
        ctx.fillRect(-5, -6, 34, 10);
        ctx.fillStyle = "#5e3370";
        ctx.fillRect(2, -12, 18, 8);
        ctx.fillStyle = "#34495e";
        ctx.fillRect(29, -3, 6, 5);
      } else if (this.weapon.name === "SAWEDOFF") {
        ctx.fillStyle = "#5c4033";
        ctx.fillRect(-8, -4, 14, 8);
        ctx.fillStyle = "#111";
        ctx.fillRect(6, -5, 14, 5);
        ctx.fillRect(6, 1, 14, 4);
      } else if (this.weapon.name === "AA12") {
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(-5, -5, 30, 10);
        ctx.fillStyle = "#111";
        ctx.fillRect(25, -3, 10, 6);
        ctx.fillStyle = "#7f8c8d";
        ctx.beginPath();
        ctx.arc(0, 8, 6, 0, Math.PI * 2);
        ctx.fill();
      } else if (this.weapon.name === "M4A1") {
        ctx.fillStyle = "#2ecc71";
        ctx.fillRect(0, -4, 20, 8);
        ctx.fillStyle = "#1e8449";
        ctx.fillRect(-8, 4, 6, 12);
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(20, -3, 22, 4);
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(5, -10, 12, 6);
      } else if (this.weapon.name === "FAMAS") {
        ctx.fillStyle = "#3498db";
        ctx.fillRect(-8, -6, 40, 10);
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(30, -4, 12, 4);
        ctx.fillStyle = "#1a5276";
        ctx.fillRect(-8, -12, 14, 6);
      } else if (this.weapon.name === "SCAR") {
        ctx.fillStyle = "#16a085";
        ctx.fillRect(0, -5, 24, 9);
        ctx.fillStyle = "#0e6655";
        ctx.fillRect(-9, 3, 7, 13);
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(24, -3, 20, 4);
      } else if (this.weapon.name === "WINCHESTER") {
        ctx.fillStyle = "#8e5a2d";
        ctx.fillRect(-10, -3, 55, 6);
        ctx.fillStyle = "#5c4033";
        ctx.fillRect(-14, 2, 10, 10);
        ctx.fillStyle = "#c9a86a";
        ctx.fillRect(0, -6, 30, 3);
      } else if (this.weapon.name === "AWP") {
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(-10, -4, 60, 7);
        ctx.fillStyle = "#1a252f";
        ctx.fillRect(-6, -11, 18, 6);
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(8, -14, 3, 9);
        ctx.fillStyle = "#34495e";
        ctx.fillRect(-14, 1, 8, 12);
      } else if (this.weapon.name === "M249") {
        ctx.fillStyle = "#556b2f";
        ctx.fillRect(-5, -6, 30, 12);
        ctx.fillStyle = "#3e4f22";
        ctx.beginPath();
        ctx.arc(-2, 10, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(30, -3, 22, 4);
      } else if (this.weapon.name === "RPG") {
        ctx.fillStyle = "#5c4a1a";
        ctx.fillRect(-10, -7, 60, 14);
        ctx.fillStyle = "#2c3e50";
        ctx.beginPath();
        ctx.moveTo(50, -7);
        ctx.lineTo(66, 0);
        ctx.lineTo(50, 7);
        ctx.fill();
        ctx.fillStyle = "#e67e22";
        ctx.fillRect(2, -4, 8, 8);
      } else if (this.weapon.name === "FLAMETHROWER") {
        ctx.fillStyle = "#7f2b0a";
        ctx.fillRect(-5, -6, 40, 12);
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(-10, 2, 12, 16);
        ctx.fillStyle = "#ff8800";
        ctx.fillRect(35, -3, 10, 6);
      } else if (this.weapon.name === "CHAINSAW") {
        ctx.fillStyle = "#e67e22";
        ctx.fillRect(-6, -6, 18, 14);
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(10, -4, 34, 8);
        ctx.strokeStyle = "#bdc3c7";
        ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          ctx.beginPath();
          ctx.moveTo(12 + i * 5, -4);
          ctx.lineTo(12 + i * 5, 4);
          ctx.stroke();
        }
      } else if (this.weapon.type === "melee") {
        ctx.fillStyle = "#873600";
        ctx.fillRect(0, -3, 10, 6);
        ctx.fillStyle = "#bdc3c7";
        ctx.beginPath();
        ctx.moveTo(10, -2);
        ctx.lineTo(30, 0);
        ctx.lineTo(10, 2);
        ctx.fill();
        ctx.fillStyle = "#ecf0f1";
        ctx.beginPath();
        ctx.moveTo(10, 0);
        ctx.lineTo(28, 0);
        ctx.lineTo(10, 1);
        ctx.fill();
      } else {
        ctx.fillStyle = this.weapon.color;
        ctx.fillRect(0, -4, 22, 8);
        ctx.fillStyle = "#2c3e50";
        ctx.fillRect(-6, 3, 6, 10);
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(22, -2, 10, 4);
      }
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
      ctx.shadowOffsetY = 0;
      if (game.fxEnabled && this.muzzleFlash > 0 && this.weapon.type === "range") {
        ctx.fillStyle = "#f1c40f";
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        let mX = (_a = WEAPON_MUZZLE_X[this.weapon.name]) != null ? _a : 25;
        ctx.arc(mX, 0, 12 + Math.random() * 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(mX, 0, 6 + Math.random() * 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
    ctx.fillStyle = "rgba(0,0,0,0.8)";
    ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 10, 40, 5);
    ctx.fillStyle = "#3498db";
    ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 10, 40 * (this.stamina / this.maxStamina), 5);
    if (this.weapon && this.weapon.fuel !== void 0) {
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40, 4);
      ctx.fillStyle = this.chainsawFuel < 25 ? "#e74c3c" : "#f39c12";
      ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40 * (this.chainsawFuel / this.weapon.fuel), 4);
    } else if (this.weapon && this.weapon.spinup) {
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40, 4);
      ctx.fillStyle = "#c0392b";
      ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40 * this.minigunSpin, 4);
    }
  }
}
game.reload = function() {
  let w = this.player.weapon;
  if (!w || w.type === "melee" || this.player.isReloading || w.ammo === w.capacity) return;
  this.player.isReloading = true;
  playSFX("reload");
  if (w.singleReload) {
    const step = () => {
      if (this.player.weapon !== w) {
        this.player.isReloading = false;
        return;
      }
      w.ammo = Math.min(w.capacity, w.ammo + 1);
      playSFX("reload", 0.25);
      if (w.ammo < w.capacity) setTimeout(step, w.reloadTime);
      else this.player.isReloading = false;
    };
    setTimeout(step, w.reloadTime);
  } else {
    setTimeout(() => {
      w.ammo = w.capacity;
      this.player.isReloading = false;
    }, w.reloadTime);
  }
};
game.shoot = function() {
  let w = this.player.weapon;
  if (!w || this.player.isReloading) return;
  if (w.fuel !== void 0 && this.player.chainsawFuel <= 0) return;
  let effFireRate = w.fireRate * (game.weaponFireRateMult || 1);
  if (w.spinup) effFireRate *= 1.8 - this.player.minigunSpin * 1.3;
  if (Date.now() - this.lastShot < effFireRate) return;
  if (w.type === "melee") {
    let hitSomething = false;
    this.enemies.forEach((e) => {
      if (!e.invulnerable && Math.hypot(this.player.x - e.x, this.player.y - e.y) < w.range + e.radius) {
        this.hitEnemy(e, w.damage);
        hitSomething = true;
      }
    });
    if (w.fuel !== void 0) {
      this.player.chainsawFuel = Math.max(0, this.player.chainsawFuel - w.fuelDrain);
      this.player.chainsawActive = true;
      playSFX(hitSomething ? "chainsaw_hit" : "chainsaw", 0.2, 0.05);
    } else {
      const meleeVariants = ["melee", "melee2", "melee3"];
      playSFX(meleeVariants[Math.floor(Math.random() * meleeVariants.length)], 0.3, 0.1);
    }
    this.lastShot = Date.now();
    return;
  }
  if (w.ammo <= 0) {
    this.reload();
    return;
  }
  if (w.burst && this.player.burstBusy) return;
  const fireOnce = () => {
    let soundKey = w.sfx || "shoot_G18";
    if (soundKey === "shoot_G18" && w.name === "REVOLVER") soundKey = "shoot_revolver";
    else if (soundKey === "shoot_G18" && ["AK47", "M4A1", "FAMAS", "SCAR"].includes(w.name)) soundKey = "shoot_rifle";
    else if (soundKey === "shoot_G18" && ["UZI", "MP5", "P90"].includes(w.name)) soundKey = "shoot_smg";
    else if (soundKey === "shoot_G18" && ["SNIPER", "AWP"].includes(w.name)) soundKey = "shoot_sniper";
    else if (soundKey === "shoot_G18" && w.name === "WINCHESTER") soundKey = "shoot_sniper2";
    playSFX(soundKey, 0.4, 0.2);
    this.player.recoilOffset = w.shake * 2;
    this.player.muzzleFlash = 3;
    this.camera.shake = w.shake;
    let angle = Math.atan2(this.mouse.y - (this.player.y - this.camera.y), this.mouse.x - (this.player.x - this.camera.x));
    if (w.casing) this.spawnCasing(this.player.x, this.player.y, angle);
    if (w.smoke) {
      for (let i = 0; i < w.smoke; i++) this.spawnParticle(this.player.x + Math.cos(angle) * 30, this.player.y + Math.sin(angle) * 30, w.name === "FLAMETHROWER" ? "#ff8800" : "#bdc3c7", 2, 3, "smoke");
    }
    if (w.pellets) {
      for (let i = 0; i < w.pellets; i++) this.spawnProjectile(this.player.x, this.player.y, angle + (Math.random() - 0.5) * (w.spread + (game.weaponSpreadBonus || 0)), w);
    } else {
      let s = (Math.random() - 0.5) * (w.spread + (game.weaponSpreadBonus || 0));
      this.spawnProjectile(this.player.x, this.player.y, angle + s, w);
    }
    w.ammo--;
  };
  if (w.burst) {
    this.player.burstBusy = true;
    let shots = 0;
    const nextShot = () => {
      if (w.ammo <= 0 || shots >= w.burst) {
        this.player.burstBusy = false;
        return;
      }
      fireOnce();
      shots++;
      if (shots < w.burst && w.ammo > 0) setTimeout(nextShot, w.burstDelay);
      else this.player.burstBusy = false;
    };
    nextShot();
  } else {
    fireOnce();
  }
  this.lastShot = Date.now();
};
game.hitEnemy = function(e, dmg) {
  var _a;
  e.hp -= dmg;
  e.flash = 4;
  for (let i = 0; i < Math.ceil(8 * this.particleScale); i++) this.spawnParticle(e.x, e.y, e.color, 4, 3, "normal");
  let t = this.floatingTexts.find((t2) => !t2.active);
  if (!t) {
    t = new FloatingText();
    this.floatingTexts.push(t);
  }
  t.init(e.x, e.y, Math.floor(dmg), "#fff", 20);
  if (e.hp <= 0 && !e.isDying) {
    e.isDying = true;
    playSFX("death", 0.5);
    const REWARDS = { BOSS: 1e3, TANK: 80, RANGED: 45, FAST: 25, BASIC: 30, INVISIBLE: 35, KAMIKAZE: 20, GHOST: 45 };
    let reward2 = Math.floor(((_a = REWARDS[e.type]) != null ? _a : 30) * (game.moneyMult || 1));
    this.player.money += reward2;
    let ft = this.floatingTexts.find((ft2) => !ft2.active);
    if (!ft) {
      ft = new FloatingText();
      this.floatingTexts.push(ft);
    }
    ft.init(e.x, e.y - 20, `+$${reward2}`, "#f1c40f", 24);
    for (let n = 0; n < Math.ceil(20 * this.particleScale); n++) this.spawnParticle(e.x, e.y, e.color, 6, 4, "normal");
    this.spawnTrail(e.x, e.y, e.radius * 1.5);
    const idx = this.enemies.indexOf(e);
    if (idx !== -1) this.enemies.splice(idx, 1);
    if (this.bossPending && this.enemies.length <= 4) {
      this.spawnBoss();
      this.bossPending = false;
      let bt = this.floatingTexts.find((ft2) => !ft2.active);
      if (!bt) {
        bt = new FloatingText();
        this.floatingTexts.push(bt);
      }
      bt.init(this.player.x, this.player.y - 60, "BOSS INCOMING!", "#c0392b", 35);
    }
  }
};
class Projectile {
  init(x, y, angle, weapon, isEnemy = false) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * weapon.speed * (game.projectileSpeedMult || 1);
    this.vy = Math.sin(angle) * weapon.speed * (game.projectileSpeedMult || 1);
    this.damage = weapon.damage;
    this.radius = isEnemy ? 6 : 4;
    this.color = isEnemy ? "#ff4d4d" : weapon.color;
    this.active = true;
    this.isEnemy = isEnemy;
    this.trail = [];
    this.pierce = weapon.pierce || 0;
    this.knockback = weapon.knockback || 0;
    this.burn = weapon.burn || false;
    this.explosive = weapon.explosive || false;
    this.explosionRadius = weapon.explosionRadius || 0;
    this.maxRange = weapon.maxRange || 1800;
    this.traveled = 0;
    this.hitEnemies = this.hitEnemies || /* @__PURE__ */ new Set();
    if (this.hitEnemies.size) this.hitEnemies.clear();
  }
  update() {
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 5) this.trail.shift();
    this.x += this.vx;
    this.y += this.vy;
    if (this.maxRange) {
      this.traveled += Math.hypot(this.vx, this.vy);
      if (this.traveled > this.maxRange) this.active = false;
    }
    if (this.x < 0 || this.x > MAP_SIZE || this.y < 0 || this.y > MAP_SIZE) this.active = false;
  }
  draw(cam) {
    if (!isVisible(this.x, this.y, 20, cam)) return;
    ctx.beginPath();
    ctx.moveTo(this.x - cam.x, this.y - cam.y);
    for (let i = this.trail.length - 1; i >= 0; i--) {
      ctx.lineTo(this.trail[i].x - cam.x, this.trail[i].y - cam.y);
    }
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.radius;
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(this.x - cam.x, this.y - cam.y, this.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}
class Enemy {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.flash = 0;
    this.tick = Math.random() * 100;
    this.isDying = false;
    const m = 1 + game.wave * 0.25;
    if (type === "TANK") {
      this.maxHp = 300 * m;
      this.speed = 1.1;
      this.radius = 35;
      this.color = "#2c3e50";
    } else if (type === "FAST") {
      this.maxHp = 40 * m;
      this.speed = 4;
      this.radius = 18;
      this.color = "#e67e22";
    } else if (type === "RANGED") {
      this.maxHp = 80 * m;
      this.speed = 1.8;
      this.radius = 24;
      this.color = "#8e44ad";
      this.lastShot = 0;
    } else if (type === "INVISIBLE") {
      this.maxHp = 60 * m;
      this.speed = 2.4;
      this.radius = 22;
      this.color = "#16a085";
      this.invisAlpha = 0;
      this.onscreenVisibleTimer = 0;
      this.wasOnScreen = false;
    } else if (type === "KAMIKAZE") {
      this.maxHp = 25 * m;
      this.speed = 2.4 * 1.3;
      this.radius = 20;
      this.color = "#e74c3c";
      this.baseColor = this.color;
      this.kamikazeState = "CHASE";
      this.kamikazeTimer = 0;
      this.explodeScale = 1;
    } else if (type === "GHOST") {
      this.maxHp = 90 * m;
      this.speed = 2;
      this.radius = 22;
      this.color = "#9b59b6";
      this.ghostState = "GHOST";
      this.ghostTimer = 0;
      this.ghostAlpha = 0.18;
      this.invulnerable = true;
    } else if (type === "BOSS") {
      this.bossWave = game.wave;
      if (this.bossWave >= 30) {
        this.maxHp = (4e3 + (this.bossWave - 30) * 500) * m;
      } else if (this.bossWave >= 15) {
        this.maxHp = 2500 * m;
      } else {
        this.maxHp = 1500 * m;
      }
      this.speed = 1.6;
      this.radius = 70;
      this.color = "#c0392b";
      this.state = "IDLE";
      this.stateTimer = 0;
      this.summonTimer = 0;
      this.dashTargetAngle = 0;
      this.shootCount = 0;
    } else {
      this.maxHp = 70 * m;
      this.speed = 2.4;
      this.radius = 22;
      this.color = "#27ae60";
    }
    this.speed *= game.enemySpeedMult || 1;
    if (game.enemySizeMult) this.radius *= game.enemySizeMult;
    if (game.enemyHpMult) this.maxHp *= game.enemyHpMult;
    this.hp = this.maxHp;
  }
  update(player) {
    this.tick += 0.2;
    let d = this._dist !== void 0 ? this._dist : Math.hypot(player.x - this.x, player.y - this.y);
    let angle = Math.atan2(player.y - this.y, player.x - this.x);
    if (this.type === "KAMIKAZE") {
      if (this.kamikazeState === "CHASE" && d < 120) {
        this.kamikazeState = "ARMED";
        this.kamikazeTimer = 0;
      }
      if (this.kamikazeState === "ARMED") {
        this.kamikazeTimer++;
        this.color = this.kamikazeTimer % 6 < 3 ? "#fff" : this.baseColor;
        this.explodeScale = 1 + Math.min(0.4, this.kamikazeTimer / 60 * 0.4);
        if (this.kamikazeTimer > 60) {
          const blastRadius = 120;
          if (d < blastRadius) player.takeDamage(35);
          game.enemies.forEach((other) => {
            if (other !== this && !other.invulnerable && Math.hypot(other.x - this.x, other.y - this.y) < blastRadius) game.hitEnemy(other, 40);
          });
          game.camera.shake = 12;
          for (let i = 0; i < Math.ceil(20 * game.particleScale); i++) game.spawnParticle(this.x, this.y, "#e74c3c", 6, 4, "normal");
          game.hitEnemy(this, this.hp);
        }
      }
    }
    if (this.type === "INVISIBLE") {
      const onScreen = isVisible(this.x, this.y, this.radius, game.camera);
      if (onScreen && !this.wasOnScreen) this.onscreenVisibleTimer = 120;
      this.wasOnScreen = onScreen;
      if (this.onscreenVisibleTimer > 0) {
        this.invisAlpha = Math.min(1, this.invisAlpha + 0.08);
        this.onscreenVisibleTimer--;
      } else this.invisAlpha = Math.max(0, this.invisAlpha - 0.05);
      if (Math.random() > 0.9) game.spawnTrail(this.x, this.y, this.radius * 0.5);
    }
    if (this.type === "GHOST") {
      this.ghostTimer++;
      if (this.ghostState === "GHOST" && this.ghostTimer > 180) {
        this.ghostState = "SOLID";
        this.ghostTimer = 0;
        this.invulnerable = false;
      } else if (this.ghostState === "SOLID" && this.ghostTimer > 120) {
        this.ghostState = "GHOST";
        this.ghostTimer = 0;
        this.invulnerable = true;
      }
      const targetGhostAlpha = this.ghostState === "GHOST" ? 0.18 : 1;
      this.ghostAlpha += (targetGhostAlpha - this.ghostAlpha) * 0.08;
    }
    if (this.type === "BOSS") {
      this.stateTimer++;
      this.summonTimer++;
      if (this.bossWave >= 30 && this.summonTimer > 60 * 12) {
        this.summonTimer = 0;
        game.enemies.push(new Enemy(this.x + 100, this.y, "TANK"));
        game.enemies.push(new Enemy(this.x - 100, this.y, "TANK"));
        game.enemies.push(new Enemy(this.x, this.y + 100, "RANGED"));
        game.enemies.push(new Enemy(this.x, this.y - 100, "RANGED"));
      }
      if (this.state === "IDLE") {
        this.x += Math.cos(angle) * this.speed;
        this.y += Math.sin(angle) * this.speed;
        let limit = this.bossWave >= 30 ? 50 : this.bossWave >= 15 ? 70 : 100;
        if (this.stateTimer > limit) {
          this.stateTimer = 0;
          if (this.bossWave >= 15 && Math.random() < 0.5) {
            this.state = "SHOOT";
            this.shootCount = 0;
          } else {
            this.state = "TELEGRAPH";
          }
        }
      } else if (this.state === "TELEGRAPH") {
        this.x += (Math.random() - 0.5) * 4;
        this.y += (Math.random() - 0.5) * 4;
        this.color = this.stateTimer % 8 < 4 ? "#fff" : "#c0392b";
        let teleTime = this.bossWave >= 30 ? 30 : 50;
        if (this.stateTimer > teleTime) {
          this.state = "DASH";
          this.stateTimer = 0;
          this.dashTargetAngle = angle;
          this.dashSpeed = this.bossWave >= 30 ? 25 : 18;
          this.color = "#c0392b";
        }
      } else if (this.state === "DASH") {
        this.x += Math.cos(this.dashTargetAngle) * this.dashSpeed;
        this.y += Math.sin(this.dashTargetAngle) * this.dashSpeed;
        if (Math.random() > 0.4) game.spawnTrail(this.x, this.y, this.radius);
        if (this.stateTimer > 25) {
          this.state = "IDLE";
          this.stateTimer = 0;
        }
      } else if (this.state === "SHOOT") {
        this.x += Math.cos(angle) * (this.speed * 0.3);
        this.y += Math.sin(angle) * (this.speed * 0.3);
        if (this.stateTimer % 20 === 0) {
          if (this.bossWave >= 30) {
            let offset = this.stateTimer * 0.1;
            for (let i = 0; i < 12; i++) {
              let a = Math.PI * 2 / 12 * i + offset;
              game.spawnProjectile(this.x, this.y, a, { speed: 7, damage: 20 * (game.enemyDamageMult || 1), color: "#f39c12" }, true);
            }
          } else {
            for (let i = 0; i < 6; i++) {
              let a = Math.PI * 2 / 6 * i;
              game.spawnProjectile(this.x, this.y, a, { speed: 5, damage: 15 * (game.enemyDamageMult || 1), color: "#f39c12" }, true);
            }
          }
          this.shootCount++;
        }
        let maxShoots = this.bossWave >= 30 ? 6 : 3;
        if (this.shootCount >= maxShoots) {
          this.state = "IDLE";
          this.stateTimer = 0;
        }
      }
    } else if (this.type === "RANGED" && d < 450) {
      if (d < 350) {
        this.x -= Math.cos(angle) * this.speed;
        this.y -= Math.sin(angle) * this.speed;
      }
      if (Date.now() - this.lastShot > 1500) {
        game.spawnProjectile(this.x, this.y, angle, { speed: 8, damage: 15 * (game.enemyDamageMult || 1), color: "#ff4d4d" }, true);
        this.lastShot = Date.now();
      }
    } else if (this.type === "KAMIKAZE" && this.kamikazeState === "ARMED") {
    } else {
      this.x += Math.cos(angle) * this.speed;
      this.y += Math.sin(angle) * this.speed;
    }
    if (d < this.radius + player.radius) player.takeDamage(0.5 * (game.enemyDamageMult || 1));
    if (this.flash > 0) this.flash--;
    if (this.burnTicks > 0) {
      this.burnTicks--;
      if (this.burnTicks % 20 === 0 && !this.isDying) {
        game.hitEnemy(this, this.burnDmg || 3);
        if (isVisible(this.x, this.y, this.radius, game.camera)) game.spawnParticle(this.x, this.y - this.radius * 0.5, "#ff8800", 2, 3, "normal");
      }
    }
  }
  draw(cam) {
    if (!isVisible(this.x, this.y, this.radius * 2, cam)) return;
    let typeAlpha = 1;
    if (this.type === "INVISIBLE") typeAlpha = this.invisAlpha;
    if (this.type === "GHOST") typeAlpha = this.ghostAlpha;
    const bounce = Math.abs(Math.sin(this.tick)) * (this.speed * 1.5);
    let stretch = 1 + Math.abs(Math.cos(this.tick)) * 0.15;
    if (this.type === "FAST") stretch *= 1.2;
    if (game.shadowsEnabled) {
      ctx.globalAlpha = typeAlpha;
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.ellipse(this.x - cam.x, this.y - cam.y + this.radius * 0.8, this.radius * 1.2, this.radius * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.save();
    ctx.globalAlpha = typeAlpha;
    ctx.translate(this.x - cam.x, this.y - cam.y - bounce);
    if (this.type === "FAST") {
      ctx.scale(1 / stretch, stretch);
    } else if (this.type === "TANK") {
      ctx.scale(stretch, 1 / stretch);
    } else {
      ctx.scale(1 / stretch, stretch);
    }
    ctx.fillStyle = this.flash > 0 ? "#fff" : this.color;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 3;
    if (this.type === "TANK") {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        ctx.lineTo(Math.cos(i * Math.PI / 3) * this.radius, Math.sin(i * Math.PI / 3) * this.radius);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-10, -10);
      ctx.lineTo(0, 5);
      ctx.lineTo(15, -5);
      ctx.stroke();
    } else if (this.type === "BOSS") {
      ctx.fillStyle = "#922b21";
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        let r = this.radius * (i % 2 === 0 ? 1.2 : 0.9);
        ctx.lineTo(Math.cos(i * Math.PI / 6) * r, Math.sin(i * Math.PI / 6) * r);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = this.flash > 0 ? "#fff" : this.color;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.moveTo(-this.radius * 0.5, -this.radius * 0.7);
      ctx.lineTo(-this.radius * 0.9, -this.radius * 1.3);
      ctx.lineTo(-this.radius * 0.2, -this.radius * 0.8);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(this.radius * 0.5, -this.radius * 0.7);
      ctx.lineTo(this.radius * 0.9, -this.radius * 1.3);
      ctx.lineTo(this.radius * 0.2, -this.radius * 0.8);
      ctx.fill();
    } else if (this.type === "RANGED") {
      ctx.beginPath();
      ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-10, -this.radius);
      ctx.lineTo(-20, -this.radius - 15);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(10, -this.radius);
      ctx.lineTo(20, -this.radius - 15);
      ctx.stroke();
      ctx.fillStyle = "#f1c40f";
      ctx.beginPath();
      ctx.arc(-20, -this.radius - 15, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.arc(20, -this.radius - 15, 4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * (this.type === "KAMIKAZE" ? this.explodeScale : 1), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (this.type === "GHOST" && this.ghostState === "GHOST") {
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = "#ecf0f1";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, this.radius + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = typeAlpha;
      }
    }
    if (this.type === "RANGED") {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(0, -5, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(0, -5, 4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = this.flash > 0 ? "#e74c3c" : this.type === "BOSS" ? "#f1c40f" : "#fff";
      ctx.beginPath();
      if (this.type === "FAST") {
        ctx.moveTo(-this.radius * 0.5, -8);
        ctx.lineTo(-this.radius * 0.1, -2);
        ctx.lineTo(-this.radius * 0.5, 2);
        ctx.moveTo(this.radius * 0.5, -8);
        ctx.lineTo(this.radius * 0.1, -2);
        ctx.lineTo(this.radius * 0.5, 2);
      } else {
        ctx.moveTo(-this.radius * 0.4, -5);
        ctx.lineTo(-this.radius * 0.1, 0);
        ctx.lineTo(-this.radius * 0.4, 5);
        ctx.moveTo(this.radius * 0.4, -5);
        ctx.lineTo(this.radius * 0.1, 0);
        ctx.lineTo(this.radius * 0.4, 5);
      }
      ctx.fill();
      if (this.type === "BOSS") {
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-20, 20);
        ctx.quadraticCurveTo(0, 40, 20, 20);
        ctx.stroke();
      }
    }
    if (game.fxEnabled && game.activeEvent === "MUTATION") {
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "#39ff14";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 1.15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = typeAlpha;
    }
    ctx.restore();
    if (this.hp < this.maxHp) {
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      ctx.fillRect(this.x - cam.x - 15, this.y - cam.y - this.radius - 15, 30, 5);
      ctx.fillStyle = "#e74c3c";
      ctx.fillRect(this.x - cam.x - 15, this.y - cam.y - this.radius - 15, 30 * (this.hp / this.maxHp), 5);
    }
  }
}
game.spawnProjectile = function(x, y, angle, weapon, isEnemy = false) {
  let p = this.projectiles.find((p2) => !p2.active);
  if (p) p.init(x, y, angle, weapon, isEnemy);
};
const XP_CONFIG = {
  curveBase: 150,
  curveGrowth: 1.22,
  perKill: { BOSS: 40, TANK: 3, RANGED: 2, FAST: 1, BASIC: 1, INVISIBLE: 2, KAMIKAZE: 1, GHOST: 2 },
  perKillDefault: 1,
  waveClearBase: 8,
  waveClearPerWave: 2
};
function xpToNextLevel(level) {
  return Math.floor(XP_CONFIG.curveBase * Math.pow(XP_CONFIG.curveGrowth, level - 1));
}
const XP_PER_KILL = XP_CONFIG.perKill;
const XP_PER_KILL_DEFAULT = XP_CONFIG.perKillDefault;
function xpForWaveClear(wave) {
  return XP_CONFIG.waveClearBase + wave * XP_CONFIG.waveClearPerWave;
}
const LEVEL_REWARDS = {
  5: { type: "money", amount: 300, label: "+$300" },
  10: { type: "diamonds", amount: 20, label: "+20 \u{1F48E}" },
  15: { type: "box", label: "Caja" },
  20: { type: "money", amount: 800, label: "+$800" },
  25: { type: "diamonds", amount: 50, label: "+50 \u{1F48E}" },
  30: { type: "skin", label: "Skin" },
  40: { type: "title", label: "T\xEDtulo" },
  50: { type: "diamonds", amount: 100, label: "+100 \u{1F48E}" }
};
const PLAYER_PROFILE_DEFAULTS = {
  level: 1,
  xp: 0,
  playTimeSec: 0,
  kills: 0,
  deaths: 0,
  shotsFired: 0,
  shotsHit: 0,
  weaponUsage: {},
  distance: 0,
  bestWave: 0,
  unlocks: [],
  diamonds: 0
};
const PlayerProfile = Object.assign({}, PLAYER_PROFILE_DEFAULTS, SaveSystem.get("profile", {}));
PlayerProfile.save = function() {
  SaveSystem.set("profile", this);
};
PlayerProfile.reset = function() {
  Object.keys(PLAYER_PROFILE_DEFAULTS).forEach((k) => {
    const d = PLAYER_PROFILE_DEFAULTS[k];
    this[k] = Array.isArray(d) ? [] : d && typeof d === "object" ? {} : d;
  });
  this.save();
  if (typeof game !== "undefined" && game.updateLevelHUD) game.updateLevelHUD();
};
game.grantXP = function(amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return;
  PlayerProfile.xp += amount;
  let leveledUp = false;
  while (PlayerProfile.xp >= xpToNextLevel(PlayerProfile.level)) {
    PlayerProfile.xp -= xpToNextLevel(PlayerProfile.level);
    PlayerProfile.level++;
    leveledUp = true;
    game.applyLevelReward(PlayerProfile.level);
  }
  if (leveledUp) game.showLevelUp(PlayerProfile.level);
  PlayerProfile.save();
};
game.grantDiamonds = function(amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return;
  PlayerProfile.diamonds += amount;
  PlayerProfile.save();
};
game.applyLevelReward = function(level) {
  const reward2 = LEVEL_REWARDS[level];
  if (!reward2) return;
  if (reward2.type === "money" && game.player) game.player.money += reward2.amount;
  if (reward2.type === "diamonds") game.grantDiamonds(reward2.amount);
  PlayerProfile.unlocks.push({ level, type: reward2.type, label: reward2.label });
};
game.showLevelUp = function(level) {
  playSFX("levelup", 0.7, 0.05);
  const el = document.getElementById("levelup-toast");
  if (!el) return;
  const reward2 = LEVEL_REWARDS[level];
  el.innerHTML = `\xA1NIVEL ${level}!` + (reward2 ? `<span>${reward2.label}</span>` : "");
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(game._levelupToastTimer);
  game._levelupToastTimer = setTimeout(() => el.classList.remove("show"), 2400);
};
game.updateLevelHUD = function() {
  const lvlEl = document.getElementById("level-display");
  const xpEl = document.getElementById("xp-inner");
  if (!lvlEl || !xpEl) return;
  lvlEl.innerText = "NIVEL " + PlayerProfile.level;
  xpEl.style.width = Math.min(100, PlayerProfile.xp / xpToNextLevel(PlayerProfile.level) * 100) + "%";
};
game.openProfile = function() {
  document.getElementById("lobby-screen").style.display = "none";
  const p = PlayerProfile;
  const acc = p.shotsFired > 0 ? Math.min(100, Math.round(p.shotsHit / p.shotsFired * 100)) : 0;
  const favEntry = Object.entries(p.weaponUsage).sort((a, b) => b[1] - a[1])[0];
  const favWeapon = favEntry ? favEntry[0] : "--";
  const liveSec = this.started ? Math.floor((Date.now() - this.startTime) / 1e3) : 0;
  const totalSec = p.playTimeSec + liveSec;
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0"), ss = String(totalSec % 60).padStart(2, "0");
  const rows = [
    ["Cuenta", typeof AuthUI !== "undefined" ? AuthUI.currentLabel() : "Invitado (local)"],
    ["Nivel", p.level],
    ["XP", `${p.xp} / ${xpToNextLevel(p.level)}`],
    ["Diamantes", "\u{1F48E} " + p.diamonds],
    ["Tiempo jugado", `${mm}:${ss}`],
    ["Zombies eliminados", p.kills],
    ["Precisi\xF3n", acc + "%"],
    ["Arma favorita", favWeapon],
    ["Distancia recorrida", Math.floor(p.distance) + " m"],
    ["Mayor oleada", p.bestWave],
    ["Muertes", p.deaths]
  ];
  document.getElementById("profile-stats").innerHTML = rows.map(
    ([label, val]) => `<div class="upgrade-row"><span class="upgrade-name">${label}</span><span class="hud-text">${val}</span></div>`
  ).join("");
  document.getElementById("profile-screen").style.display = "flex";
};
game.closeProfile = function() {
  document.getElementById("profile-screen").style.display = "none";
  document.getElementById("lobby-screen").style.display = "flex";
};
const _levelOrigHitEnemy = game.hitEnemy;
game.hitEnemy = function(e, dmg, meta) {
  var _a;
  const wasAlive = !e.isDying;
  _levelOrigHitEnemy.call(this, e, dmg);
  if (meta && meta.playerShot && !this._shotHitRegistered) {
    PlayerProfile.shotsHit++;
    this._shotHitRegistered = true;
  }
  if (wasAlive && e.isDying) {
    PlayerProfile.kills++;
    const w = this.player && this.player.weapon;
    if (w) PlayerProfile.weaponUsage[w.name] = (PlayerProfile.weaponUsage[w.name] || 0) + 1;
    game.grantXP((_a = XP_PER_KILL[e.type]) != null ? _a : XP_PER_KILL_DEFAULT);
  }
};
const _levelOrigShoot = game.shoot;
game.shoot = function() {
  const w = this.player && this.player.weapon;
  const prevLastShot = this.lastShot;
  _levelOrigShoot.call(this);
  if (w && this.lastShot !== prevLastShot && w.type !== "melee") {
    PlayerProfile.shotsFired++;
    this._shotHitRegistered = false;
  }
};
const _levelOrigPlayerUpdate = Player.prototype.update;
Player.prototype.update = function(keys) {
  const px = this.x, py = this.y;
  _levelOrigPlayerUpdate.call(this, keys);
  const d = Math.hypot(this.x - px, this.y - py);
  if (d > 0) PlayerProfile.distance += d;
};
const _levelOrigLoop = game.loop;
game.loop = function() {
  const waveBefore = this.wave;
  _levelOrigLoop.call(this);
  if (this.wave !== waveBefore) {
    game.grantXP(xpForWaveClear(waveBefore));
    PlayerProfile.bestWave = Math.max(PlayerProfile.bestWave, waveBefore);
    PlayerProfile.save();
  }
  game.updateLevelHUD();
};
const _levelOrigGameOver = game.gameOver;
game.gameOver = function() {
  PlayerProfile.deaths++;
  PlayerProfile.playTimeSec += Math.floor((Date.now() - this.startTime) / 1e3);
  PlayerProfile.bestWave = Math.max(PlayerProfile.bestWave, this.wave - 1);
  PlayerProfile.save();
  _levelOrigGameOver.call(this);
};
window.addEventListener("beforeunload", () => PlayerProfile.save());
SaveSystem.onRemoteData(function(keys) {
  if (!keys.includes("profile")) return;
  Object.assign(PlayerProfile, SaveSystem.get("profile", {}));
  game.updateLevelHUD();
});
window.addEventListener("DOMContentLoaded", () => {
  const panel = document.querySelector("#lobby-screen .menu-panel");
  if (panel) {
    const btn = document.createElement("button");
    btn.className = "menu-btn";
    btn.textContent = "\u{1FAAA} PERFIL";
    btn.onclick = () => game.openProfile();
    panel.appendChild(btn);
  }
  game.updateLevelHUD();
});
const UPGRADES_DB = {
  VITALITY: { name: "Vitalidad", desc: "+10 HP m\xE1xima por nivel", icon: "\u2764\uFE0F", maxLevel: 5, baseCost: 250, costGrowth: 1.6 },
  ENDURANCE: { name: "Resistencia", desc: "+10 stamina m\xE1xima por nivel", icon: "\u{1F3C3}", maxLevel: 5, baseCost: 250, costGrowth: 1.6 },
  SWIFTNESS: { name: "Velocidad", desc: "+2% velocidad de movimiento por nivel", icon: "\u{1F4A8}", maxLevel: 5, baseCost: 300, costGrowth: 1.6 },
  POWER: { name: "Poder", desc: "+3% da\xF1o de armas por nivel", icon: "\u2694\uFE0F", maxLevel: 5, baseCost: 350, costGrowth: 1.65 },
  FORTUNE: { name: "Fortuna", desc: "+4% dinero ganado por nivel", icon: "\u{1F4B0}", maxLevel: 5, baseCost: 320, costGrowth: 1.65 }
};
const Progression = Object.assign({ levels: {} }, SaveSystem.get("progression", {}));
Progression.getLevel = function(k) {
  return this.levels[k] || 0;
};
Progression.getCost = function(k) {
  const def = UPGRADES_DB[k];
  if (!def) return Infinity;
  return Math.floor(def.baseCost * Math.pow(def.costGrowth, this.getLevel(k)));
};
Progression.buy = function(k) {
  const def = UPGRADES_DB[k];
  if (!def) return false;
  const lvl = this.getLevel(k);
  if (lvl >= def.maxLevel) return false;
  const cost = this.getCost(k);
  if (!game.player || game.player.money < cost) return false;
  game.player.money -= cost;
  this.levels[k] = lvl + 1;
  this.save();
  this.applyToPlayer(game.player);
  playSFX("coin");
  return true;
};
Progression.save = function() {
  SaveSystem.set("progression", { levels: this.levels });
};
Progression.reset = function() {
  this.levels = {};
  this.save();
  if (game.player) this.applyToPlayer(game.player);
  if (typeof game.renderUpgrades === "function") game.renderUpgrades();
};
Progression.applyToPlayer = function(p) {
  if (!p) return;
  const vit = this.getLevel("VITALITY");
  const end = this.getLevel("ENDURANCE");
  const newMaxHp = 100 + vit * 10;
  const newMaxStamina = 100 + end * 10;
  p.hp = Math.min(newMaxHp, p.hp + (newMaxHp - p.maxHp));
  p.maxHp = newMaxHp;
  p.stamina = Math.min(newMaxStamina, p.stamina + (newMaxStamina - p.maxStamina));
  p.maxStamina = newMaxStamina;
};
const _progOrigInit = game.init;
game.init = function() {
  _progOrigInit.call(this);
  Progression.applyToPlayer(this.player);
};
const _progOrigShoot = game.shoot;
game.shoot = function() {
  const w = this.player && this.player.weapon;
  const lvl = Progression.getLevel("POWER");
  if (w && lvl > 0 && this._powerOriginalDamage === void 0) {
    this._powerOriginalDamage = w.damage;
    w.damage = Math.round(this._powerOriginalDamage * (1 + 0.03 * lvl));
  }
  _progOrigShoot.call(this);
  if (this._powerOriginalDamage !== void 0 && !(this.player && this.player.burstBusy)) {
    w.damage = this._powerOriginalDamage;
    this._powerOriginalDamage = void 0;
  }
};
const _progOrigPlayerUpdate = Player.prototype.update;
Player.prototype.update = function(keys) {
  const px = this.x, py = this.y;
  _progOrigPlayerUpdate.call(this, keys);
  const lvl = Progression.getLevel("SWIFTNESS");
  if (lvl > 0 && !this.isDashing) {
    const dx = this.x - px, dy = this.y - py;
    if (dx !== 0 || dy !== 0) {
      const bonus = lvl * 0.02;
      this.x = Math.max(this.radius, Math.min(MAP_SIZE - this.radius, this.x + dx * bonus));
      this.y = Math.max(this.radius, Math.min(MAP_SIZE - this.radius, this.y + dy * bonus));
    }
  }
};
const _progOrigHitEnemy = game.hitEnemy;
game.hitEnemy = function(e, dmg, ...rest) {
  const moneyBefore = this.player ? this.player.money : 0;
  _progOrigHitEnemy.call(this, e, dmg, ...rest);
  const lvl = Progression.getLevel("FORTUNE");
  if (lvl > 0 && this.player) {
    const gained = this.player.money - moneyBefore;
    if (gained > 0) this.player.money += Math.floor(gained * (0.04 * lvl));
  }
};
game.renderUpgrades = function() {
  const el = document.getElementById("upgrades-list");
  if (!el) return;
  el.innerHTML = Object.keys(UPGRADES_DB).map((k) => {
    const def = UPGRADES_DB[k];
    const lvl = Progression.getLevel(k);
    const maxed = lvl >= def.maxLevel;
    const cost = Progression.getCost(k);
    const action = maxed ? '<span class="achv-claimed">M\xC1XIMO</span>' : `<button class="buy-btn" onclick="game.buyUpgrade('${k}')">$${cost}</button>`;
    return `<div class="weapon-row">
            <span class="weapon-row-name">${def.icon} ${def.name} (${lvl}/${def.maxLevel})</span>
            <span class="weapon-row-status">${def.desc}</span>
            ${action}
        </div>`;
  }).join("");
};
game.buyUpgrade = function(k) {
  if (Progression.buy(k)) game.renderUpgrades();
};
const _progOrigOpenProfile = game.openProfile;
game.openProfile = function() {
  _progOrigOpenProfile.call(this);
  game.renderUpgrades();
};
SaveSystem.onRemoteData(function(keys) {
  if (!keys.includes("progression")) return;
  const remote = SaveSystem.get("progression", { levels: {} });
  Progression.levels = remote.levels || {};
  if (game.player) Progression.applyToPlayer(game.player);
  game.renderUpgrades();
});
const RARITY = {
  RARO: { label: "RARO", color: "#3498db" },
  SUPER_RARO: { label: "S\xDAPER RARO", color: "#1abc9c" },
  EPICO: { label: "\xC9PICO", color: "#9b59b6" },
  MITICO: { label: "M\xCDTICO", color: "#e74c3c" },
  LEGENDARIO: { label: "LEGENDARIO", color: "#f1c40f" }
};
const ACHIEVEMENT_CATEGORIES = {
  COMBAT: "\u2694\uFE0F Combate",
  SURVIVAL: "\u{1F6E1}\uFE0F Supervivencia",
  WEAPONS: "\u{1F52B} Armas",
  BOSSES: "\u{1F480} Bosses",
  PROGRESSION: "\u2B50 Progresi\xF3n",
  EVENTS: "\u{1F32A}\uFE0F Eventos",
  EXPLORATION: "\u{1F5FA}\uFE0F Exploraci\xF3n",
  SPECIAL: "\u{1F396}\uFE0F Especiales"
};
const WEAPON_CATEGORY = {
  KNIFE: "melee",
  MACHETE: "melee",
  CHAINSAW: "melee",
  G18: "pistol",
  REVOLVER: "pistol",
  UZI: "smg",
  MP5: "smg",
  P90: "smg",
  SHOTGUN: "shotgun",
  SAWEDOFF: "shotgun",
  AA12: "shotgun",
  AK47: "rifle",
  M4A1: "rifle",
  FAMAS: "rifle",
  SCAR: "rifle",
  WINCHESTER: "sniper",
  AWP: "sniper",
  SNIPER: "sniper",
  M249: "heavy",
  MINIGUN: "heavy",
  RPG: "special",
  FLAMETHROWER: "special",
  CROSSBOW: "special"
};
const TOTAL_WEAPON_COUNT = Object.keys(WEAPON_CATEGORY).length;
const CATEGORY_META = {
  melee: { icon: "\u{1F52A}" },
  pistol: { icon: "\u{1F52B}" },
  smg: { icon: "\u{1F4A5}" },
  shotgun: { icon: "\u{1F4A2}" },
  rifle: { icon: "\u{1F3AF}" },
  sniper: { icon: "\u{1F52D}" },
  heavy: { icon: "\u{1F9F1}" },
  special: { icon: "\u{1F680}" }
};
function fmt(n) {
  return n.toLocaleString("es-ES");
}
function reward(opts) {
  opts = opts || {};
  const xp = opts.xp || 0, money = opts.money || 0, diamonds = opts.diamonds || 0;
  const cosmetic = opts.cosmetic || null;
  const parts = [];
  if (xp) parts.push(`+${fmt(xp)} XP`);
  if (money) parts.push(`+$${fmt(money)}`);
  if (diamonds) parts.push(`+${fmt(diamonds)} \u{1F48E}`);
  if (cosmetic && opts.label) parts.push(opts.label);
  return { xp, money, diamonds, label: parts.join("  ") || opts.label || "", cosmetic };
}
const ACHIEVEMENT_STATS_DEFAULTS = {
  bossKills: 0,
  categoryKills: {},
  weaponsUsed: [],
  reloads: 0,
  killStreakNoDeath: 0,
  bestKillStreak: 0,
  meleeBossKills: 0,
  perfectWaves: 0,
  eventsCompleted: 0,
  eventTypesCompleted: [],
  weaponsPurchased: 0,
  heavyWeaponPurchased: false,
  weaponsSold: 0,
  upgradesBuys: 0,
  upgradesTouched: [],
  healthPackUses: 0,
  dashUses: 0,
  proWavesCleared: 0,
  moneyEarned: 0,
  bossWavesDefeated: [],
  lowHpClears: 0,
  pendingMoney: 0
};
const AchievementStats = Object.assign({}, ACHIEVEMENT_STATS_DEFAULTS, SaveSystem.get("achv_stats", {}));
const AchievementState = SaveSystem.get("achv_state", {});
const ACHIEVEMENTS_DB = {};
function buildChain(idPrefix, category, icon, trigger, nameFn, descFn, getValueFn, stages, hidden) {
  stages.forEach((s, i) => {
    ACHIEVEMENTS_DB[`${idPrefix}_${i + 1}`] = {
      id: `${idPrefix}_${i + 1}`,
      category,
      icon,
      trigger,
      name: nameFn(s.target, i + 1),
      desc: descFn(s.target, i + 1),
      rarity: s.rarity,
      target: s.target,
      getValue: getValueFn,
      reward: reward(s),
      hidden: !!hidden
    };
  });
}
function buildUnique(id, category, icon, trigger, name, desc, rarity, target, getValue, rewardOpts, hidden) {
  ACHIEVEMENTS_DB[id] = { id, category, icon, trigger, name, desc, rarity, target, getValue, reward: reward(rewardOpts), hidden: !!hidden };
}
buildChain(
  "kills_total",
  "COMBAT",
  "\u{1F52B}",
  "kill",
  (t) => `Exterminador (${fmt(t)})`,
  (t) => `Elimina ${fmt(t)} enemigos en total.`,
  () => PlayerProfile.kills,
  [
    { target: 300, rarity: "RARO", xp: 40, money: 60 },
    { target: 5e3, rarity: "SUPER_RARO", xp: 150, money: 350 },
    { target: 5e4, rarity: "EPICO", xp: 500, money: 1500 },
    { target: 5e5, rarity: "LEGENDARIO", xp: 1500, money: 6e3, diamonds: 100 }
  ]
);
buildChain(
  "boss_kills",
  "BOSSES",
  "\u{1F480}",
  "kill",
  (t) => `Cazador de Bosses (${fmt(t)})`,
  (t) => `Derrota a ${fmt(t)} jefes.`,
  () => AchievementStats.bossKills,
  [
    { target: 3, rarity: "RARO", xp: 60, money: 120 },
    { target: 15, rarity: "SUPER_RARO", xp: 200, money: 500 },
    { target: 60, rarity: "EPICO", xp: 600, money: 1800 },
    { target: 200, rarity: "LEGENDARIO", xp: 2e3, money: 7e3, diamonds: 120 }
  ]
);
buildChain(
  "waves_survived",
  "SURVIVAL",
  "\u{1F30A}",
  "waveClear",
  (t) => `Superviviente (Oleada ${t})`,
  (t) => `Sobrevive hasta la oleada ${t}.`,
  () => PlayerProfile.bestWave,
  [
    { target: 15, rarity: "RARO", xp: 80, money: 180 },
    { target: 40, rarity: "SUPER_RARO", xp: 250, money: 600 },
    { target: 80, rarity: "EPICO", xp: 700, money: 2200 },
    { target: 150, rarity: "LEGENDARIO", xp: 1800, money: 7e3, diamonds: 100 }
  ]
);
buildChain(
  "playtime",
  "SURVIVAL",
  "\u23F1\uFE0F",
  "waveClear",
  (t) => `Veterano de Guerra (${t} min)`,
  (t) => `Acumula ${t} minutos de juego.`,
  () => Math.floor(AchievementManager.getTotalPlaySeconds() / 60),
  [
    { target: 60, rarity: "RARO", xp: 60, money: 120 },
    { target: 300, rarity: "SUPER_RARO", xp: 200, money: 450 },
    { target: 900, rarity: "EPICO", xp: 550, money: 1400 },
    { target: 2400, rarity: "LEGENDARIO", xp: 1500, money: 5e3, diamonds: 80 }
  ]
);
buildChain(
  "distance",
  "EXPLORATION",
  "\u{1F5FA}\uFE0F",
  "waveClear",
  (t) => `N\xF3mada (${fmt(t)} m)`,
  (t) => `Recorre ${fmt(t)} metros en total.`,
  () => Math.floor(PlayerProfile.distance),
  [
    { target: 15e3, rarity: "RARO", xp: 60, money: 120 },
    { target: 75e3, rarity: "SUPER_RARO", xp: 200, money: 450 },
    { target: 4e5, rarity: "EPICO", xp: 550, money: 1400 },
    { target: 2e6, rarity: "LEGENDARIO", xp: 1500, money: 5e3, diamonds: 80 }
  ]
);
buildChain(
  "accuracy",
  "COMBAT",
  "\u{1F3AF}",
  "waveClear",
  (t) => `Punter\xEDa (${t}%)`,
  (t) => `Alcanza ${t}% de precisi\xF3n (m\xEDnimo 500 disparos).`,
  () => PlayerProfile.shotsFired >= 500 ? Math.round(PlayerProfile.shotsHit / PlayerProfile.shotsFired * 100) : 0,
  [
    { target: 50, rarity: "RARO", xp: 80, money: 150 },
    { target: 70, rarity: "SUPER_RARO", xp: 250, money: 500 },
    { target: 85, rarity: "EPICO", xp: 700, money: 1600 },
    { target: 95, rarity: "LEGENDARIO", xp: 1800, money: 5500, diamonds: 90 }
  ]
);
buildChain(
  "deaths",
  "SURVIVAL",
  "\u2620\uFE0F",
  "death",
  (t) => `Que no te tiemble el gel (${fmt(t)})`,
  (t) => `Muere ${fmt(t)} veces. Nadie dijo que fuera f\xE1cil.`,
  () => PlayerProfile.deaths,
  [
    { target: 1, rarity: "RARO", xp: 20, money: 30 },
    { target: 25, rarity: "SUPER_RARO", xp: 80, money: 150 },
    { target: 100, rarity: "EPICO", xp: 300, money: 600 },
    { target: 300, rarity: "LEGENDARIO", xp: 900, money: 2200 }
  ]
);
buildChain(
  "reloads",
  "WEAPONS",
  "\u{1F504}",
  "reload",
  (t) => `Manos r\xE1pidas (${fmt(t)})`,
  (t) => `Recarga tus armas ${fmt(t)} veces.`,
  () => AchievementStats.reloads,
  [
    { target: 150, rarity: "RARO", xp: 40, money: 90 },
    { target: 800, rarity: "SUPER_RARO", xp: 140, money: 280 },
    { target: 4e3, rarity: "EPICO", xp: 450, money: 1e3 },
    { target: 15e3, rarity: "LEGENDARIO", xp: 1200, money: 3500, diamonds: 60 }
  ]
);
buildChain(
  "level",
  "PROGRESSION",
  "\u2B50",
  "levelUp",
  (t) => `Nivel ${t}`,
  (t) => `Alcanza el nivel ${t} de jugador.`,
  () => PlayerProfile.level,
  [
    { target: 8, rarity: "RARO", money: 150 },
    { target: 18, rarity: "SUPER_RARO", money: 400 },
    { target: 35, rarity: "EPICO", money: 1300 },
    { target: 60, rarity: "LEGENDARIO", money: 5e3, diamonds: 150 }
  ]
);
buildChain(
  "perfect_waves",
  "COMBAT",
  "\u{1F6E1}\uFE0F",
  "waveClear",
  (t) => `Impecable (${fmt(t)})`,
  (t) => `Completa ${fmt(t)} oleadas sin recibir da\xF1o.`,
  () => AchievementStats.perfectWaves,
  [
    { target: 5, rarity: "RARO", xp: 60, money: 120 },
    { target: 30, rarity: "SUPER_RARO", xp: 220, money: 550 },
    { target: 120, rarity: "EPICO", xp: 700, money: 2200 },
    { target: 300, rarity: "LEGENDARIO", xp: 2200, money: 8e3, diamonds: 120 }
  ]
);
buildChain(
  "kill_streak",
  "COMBAT",
  "\u{1F525}",
  "kill",
  (t) => `Racha letal (${fmt(t)})`,
  (t) => `Elimina ${fmt(t)} enemigos seguidos sin morir.`,
  () => AchievementStats.bestKillStreak,
  [
    { target: 150, rarity: "RARO", xp: 80, money: 160 },
    { target: 700, rarity: "EPICO", xp: 350, money: 900 },
    { target: 3e3, rarity: "MITICO", xp: 1200, money: 3500, diamonds: 60 }
  ]
);
buildChain(
  "events_completed",
  "EVENTS",
  "\u{1F32A}\uFE0F",
  "eventComplete",
  (t) => `Curtido en tormentas (${fmt(t)})`,
  (t) => `Supera ${fmt(t)} oleadas con un evento din\xE1mico activo.`,
  () => AchievementStats.eventsCompleted,
  [
    { target: 5, rarity: "RARO", xp: 40, money: 90 },
    { target: 40, rarity: "SUPER_RARO", xp: 180, money: 450 },
    { target: 200, rarity: "EPICO", xp: 600, money: 1700 }
  ]
);
buildChain(
  "weapons_used",
  "WEAPONS",
  "\u{1F392}",
  "shoot",
  (t) => `Arsenal (${t}/${TOTAL_WEAPON_COUNT})`,
  (t) => `Usa ${t} armas distintas al menos una vez.`,
  () => AchievementStats.weaponsUsed.length,
  [
    { target: 5, rarity: "RARO", xp: 50, money: 100 },
    { target: 10, rarity: "SUPER_RARO", xp: 150, money: 300 },
    { target: 15, rarity: "EPICO", xp: 450, money: 900 },
    { target: TOTAL_WEAPON_COUNT, rarity: "LEGENDARIO", xp: 1200, money: 3e3, diamonds: 60 }
  ]
);
buildChain(
  "healthpacks",
  "SURVIVAL",
  "\u{1F489}",
  "healthBuy",
  (t) => `Adicto a la sanaci\xF3n (${fmt(t)})`,
  (t) => `Compra curaci\xF3n en la tienda ${fmt(t)} veces.`,
  () => AchievementStats.healthPackUses,
  [
    { target: 25, rarity: "RARO", xp: 40, money: 80 },
    { target: 150, rarity: "SUPER_RARO", xp: 150, money: 300 },
    { target: 600, rarity: "EPICO", xp: 450, money: 900 }
  ]
);
buildChain(
  "pro_graphics",
  "SPECIAL",
  "\u{1F5A5}\uFE0F",
  "waveClear",
  (t) => `Sin concesiones (${fmt(t)})`,
  (t) => `Completa ${fmt(t)} oleadas con gr\xE1ficos en PRO.`,
  () => AchievementStats.proWavesCleared,
  [{ target: 25, rarity: "RARO", xp: 60, money: 100 }, { target: 150, rarity: "EPICO", xp: 250, money: 500 }]
);
buildChain(
  "money_earned",
  "PROGRESSION",
  "\u{1F4B0}",
  "kill",
  (t) => `Fortuna acumulada ($${fmt(t)})`,
  (t) => `Gana $${fmt(t)} en total eliminando enemigos.`,
  () => AchievementStats.moneyEarned,
  [
    { target: 5e3, rarity: "RARO", xp: 60, money: 100 },
    { target: 5e4, rarity: "SUPER_RARO", xp: 200, money: 400 },
    { target: 75e4, rarity: "EPICO", xp: 700, money: 1500 },
    { target: 1e7, rarity: "LEGENDARIO", xp: 2e3, money: 5e3, diamonds: 100 }
  ]
);
buildChain(
  "shots_fired",
  "WEAPONS",
  "\u{1F4A5}",
  "shoot",
  (t) => `Dedo caliente (${fmt(t)})`,
  (t) => `Dispara ${fmt(t)} veces en total.`,
  () => PlayerProfile.shotsFired,
  [
    { target: 2e3, rarity: "RARO", xp: 40, money: 80 },
    { target: 15e3, rarity: "SUPER_RARO", xp: 140, money: 250 },
    { target: 75e3, rarity: "EPICO", xp: 450, money: 900 },
    { target: 4e5, rarity: "LEGENDARIO", xp: 1200, money: 3e3, diamonds: 60 }
  ]
);
Object.keys(CATEGORY_META).forEach((cat) => {
  const meta = CATEGORY_META[cat];
  buildChain(
    `cat_kills_${cat}`,
    "WEAPONS",
    meta.icon,
    "kill",
    (t) => `Especialista ${cat.toUpperCase()} (${fmt(t)})`,
    (t) => `Elimina ${fmt(t)} enemigos usando armas de categor\xEDa "${cat}".`,
    () => AchievementStats.categoryKills[cat] || 0,
    [{ target: 400, rarity: "RARO", xp: 50, money: 100 }, { target: 5e3, rarity: "EPICO", xp: 350, money: 800 }]
  );
});
[["STORM", "\u{1F329}\uFE0F"], ["SANDSTORM", "\u{1F32A}\uFE0F"], ["BLIZZARD", "\u2744\uFE0F"], ["RADIOACTIVE", "\u2622\uFE0F"], ["INVASION", "\u{1F480}"], ["DARKNESS", "\u{1F311}"]].forEach(([key, icon]) => {
  buildUnique(
    `event_survive_${key}`,
    "EVENTS",
    icon,
    "eventSurvive",
    `Super\xF3: ${RANDOM_EVENTS[key].label}`,
    `Completa una oleada entera con el evento "${RANDOM_EVENTS[key].label}" activo.`,
    "MITICO",
    1,
    () => AchievementStats.eventTypesCompleted.includes(key) ? 1 : 0,
    { xp: 250, money: 500, diamonds: 20 }
  );
});
buildUnique(
  "melee_boss_kill",
  "SPECIAL",
  "\u{1F52A}",
  "kill",
  "Filo Contra Titanes",
  "Derrota a un jefe usando \xFAnicamente un arma cuerpo a cuerpo.",
  "LEGENDARIO",
  1,
  () => AchievementStats.meleeBossKills,
  { xp: 1e3, money: 2500, diamonds: 80 },
  true
);
buildUnique(
  "no_buy_weapons_w15",
  "SPECIAL",
  "\u{1F392}",
  "waveClear",
  "Minimalista",
  "Llega a la oleada 15 sin comprar ninguna arma en la tienda.",
  "MITICO",
  1,
  () => PlayerProfile.bestWave >= 15 && AchievementStats.weaponsPurchased === 0 ? 1 : 0,
  { xp: 600, money: 1500, diamonds: 40 },
  true
);
buildUnique(
  "level_40_rewards",
  "PROGRESSION",
  "\u{1F3C5}",
  "levelUp",
  "Veterano Condecorado",
  "Alcanza el nivel 60.",
  "EPICO",
  1,
  () => PlayerProfile.level >= 60 ? 1 : 0,
  { money: 2500, cosmetic: "title", label: 'T\xEDtulo "Veterano"' }
);
buildUnique(
  "wave_200",
  "SURVIVAL",
  "\u{1F3C6}",
  "waveClear",
  "Inmortal del Slime",
  "Sobrevive hasta la oleada 200.",
  "LEGENDARIO",
  200,
  () => PlayerProfile.bestWave,
  { xp: 3e3, money: 1e4, diamonds: 150 }
);
buildUnique(
  "boss_wave15",
  "BOSSES",
  "\u{1F479}",
  "kill",
  "Segundo Contacto",
  "Derrota al jefe de la oleada 15.",
  "EPICO",
  1,
  () => AchievementStats.bossWavesDefeated.includes(15) ? 1 : 0,
  { xp: 450, money: 1200 }
);
buildUnique(
  "boss_wave30",
  "BOSSES",
  "\u{1F47A}",
  "kill",
  "El Verdadero Desaf\xEDo",
  "Derrota al jefe de la oleada 30.",
  "MITICO",
  1,
  () => AchievementStats.bossWavesDefeated.includes(30) ? 1 : 0,
  { xp: 900, money: 2500, diamonds: 40 }
);
buildUnique(
  "heavy_weapon_purchase",
  "WEAPONS",
  "\u2699\uFE0F",
  "buyWeapon",
  "Artiller\xEDa Pesada",
  "Compra tu primera arma de categor\xEDa pesada o especial.",
  "SUPER_RARO",
  1,
  () => AchievementStats.heavyWeaponPurchased ? 1 : 0,
  { xp: 100, money: 250 }
);
buildUnique(
  "sell_weapon_first",
  "WEAPONS",
  "\u{1F4B5}",
  "sellWeapon",
  "Reventa T\xE1ctica",
  "Vende un arma en la tienda por primera vez.",
  "RARO",
  1,
  () => AchievementStats.weaponsSold >= 1 ? 1 : 0,
  { xp: 25, money: 60 }
);
buildUnique(
  "upgrades_all_maxed",
  "PROGRESSION",
  "\u{1F4C8}",
  "upgradeBuy",
  "Mejora Total",
  "Lleva las 5 mejoras permanentes a su nivel m\xE1ximo.",
  "LEGENDARIO",
  1,
  () => Object.keys(UPGRADES_DB).every((k) => Progression.getLevel(k) >= UPGRADES_DB[k].maxLevel) ? 1 : 0,
  { money: 4e3, diamonds: 100, cosmetic: "skin", label: "Skin exclusiva" }
);
buildUnique(
  "upgrades_each_one",
  "PROGRESSION",
  "\u{1F9EC}",
  "upgradeBuy",
  "Todoterreno",
  "Compra al menos un nivel de cada mejora permanente.",
  "SUPER_RARO",
  Object.keys(UPGRADES_DB).length,
  () => AchievementStats.upgradesTouched.length,
  { xp: 120, money: 300 }
);
buildUnique(
  "dash_master",
  "SPECIAL",
  "\u{1F4A8}",
  "dash",
  "Maestro del Dash",
  "Utiliza el dash 1500 veces.",
  "SUPER_RARO",
  1500,
  () => AchievementStats.dashUses,
  { xp: 150, money: 400 }
);
buildUnique(
  "low_hp_clear",
  "SURVIVAL",
  "\u{1F493}",
  "waveClear",
  "Al Filo de la Muerte",
  "Termina una oleada con menos del 10% de tu vida m\xE1xima.",
  "EPICO",
  1,
  () => AchievementStats.lowHpClears,
  { xp: 250, money: 600 },
  true
);
const _achTriggerIndex = {};
Object.values(ACHIEVEMENTS_DB).forEach((def) => {
  (_achTriggerIndex[def.trigger] = _achTriggerIndex[def.trigger] || []).push(def);
});
const AchievementManager = {
  getState(id) {
    if (!AchievementState[id]) AchievementState[id] = { notified: false, claimed: false };
    return AchievementState[id];
  },
  evaluate(trigger) {
    const defs = _achTriggerIndex[trigger];
    if (!defs) return;
    let dirty = false;
    defs.forEach((def) => {
      if (def.getValue() < def.target) return;
      const state = this.getState(def.id);
      if (!state.notified) {
        state.notified = true;
        this.showToast(def);
        dirty = true;
      }
    });
    if (dirty) this.saveState();
  },
  claim(id) {
    const def = ACHIEVEMENTS_DB[id];
    if (!def) return false;
    const state = this.getState(id);
    if (state.claimed || def.getValue() < def.target) return false;
    state.claimed = true;
    this.applyReward(def);
    this.saveState();
    return true;
  },
  applyReward(def) {
    const r = def.reward;
    if (r.xp) game.grantXP(r.xp);
    if (r.diamonds) game.grantDiamonds(r.diamonds);
    if (r.money) {
      if (game.player) game.player.money += r.money;
      else AchievementStats.pendingMoney += r.money;
    }
    if (r.cosmetic) PlayerProfile.unlocks.push({ achievement: def.id, type: r.cosmetic, label: r.label });
    PlayerProfile.save();
    this.saveStats();
  },
  showToast(def) {
    playSFX("achievement_unlock", 0.6, 0.05);
    const el = document.getElementById("achievement-toast");
    if (!el) return;
    const rarity = RARITY[def.rarity];
    el.innerHTML = `<div class="achv-toast-header" style="color:${rarity.color}">\u{1F3C6} LOGRO DESBLOQUEADO \u2014 ${rarity.label}</div><div class="achv-toast-name">${def.icon} ${def.name}</div>`;
    el.style.setProperty("--rarity-color", rarity.color);
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove("show"), 3800);
  },
  getTotalPlaySeconds() {
    const live = game.started ? Math.floor((Date.now() - game.startTime) / 1e3) : 0;
    return PlayerProfile.playTimeSec + live;
  },
  onWaveClear(waveNum, eventKey) {
    if (!this._tookDamageThisWave) AchievementStats.perfectWaves++;
    this._tookDamageThisWave = false;
    if (eventKey) {
      AchievementStats.eventsCompleted++;
      if (!AchievementStats.eventTypesCompleted.includes(eventKey)) AchievementStats.eventTypesCompleted.push(eventKey);
      this.evaluate("eventComplete");
      this.evaluate("eventSurvive");
    }
    if (Settings.graphics === "PRO") AchievementStats.proWavesCleared++;
    if (game.player && game.player.hp < game.player.maxHp * 0.1) AchievementStats.lowHpClears++;
    this.evaluate("waveClear");
    this.saveStats();
  },
  saveStats() {
    SaveSystem.set("achv_stats", AchievementStats);
  },
  saveState() {
    SaveSystem.set("achv_state", AchievementState);
  },
  resetAll() {
    Object.keys(ACHIEVEMENT_STATS_DEFAULTS).forEach((k) => {
      const d = ACHIEVEMENT_STATS_DEFAULTS[k];
      AchievementStats[k] = Array.isArray(d) ? [] : d && typeof d === "object" ? {} : d;
    });
    Object.keys(AchievementState).forEach((k) => delete AchievementState[k]);
    this.saveStats();
    this.saveState();
    if (typeof game.renderAchievements === "function") game.renderAchievements();
  }
};
const _achOrigHitEnemy = game.hitEnemy;
game.hitEnemy = function(e, dmg, ...rest) {
  const wasAlive = !e.isDying;
  const wasBoss = e.type === "BOSS";
  const bossWave = e.bossWave;
  const weapon = this.player && this.player.weapon;
  const moneyBefore = this.player ? this.player.money : 0;
  _achOrigHitEnemy.call(this, e, dmg, ...rest);
  if (wasAlive && e.isDying) {
    AchievementStats.killStreakNoDeath++;
    AchievementStats.bestKillStreak = Math.max(AchievementStats.bestKillStreak, AchievementStats.killStreakNoDeath);
    if (weapon) {
      const cat = WEAPON_CATEGORY[weapon.name];
      if (cat) AchievementStats.categoryKills[cat] = (AchievementStats.categoryKills[cat] || 0) + 1;
    }
    if (wasBoss) {
      AchievementStats.bossKills++;
      if (weapon && weapon.type === "melee") AchievementStats.meleeBossKills++;
      if (bossWave && !AchievementStats.bossWavesDefeated.includes(bossWave)) AchievementStats.bossWavesDefeated.push(bossWave);
    }
    if (this.player) AchievementStats.moneyEarned += Math.max(0, this.player.money - moneyBefore);
    AchievementManager.evaluate("kill");
  }
};
const _achOrigShoot = game.shoot;
game.shoot = function() {
  const w = this.player && this.player.weapon;
  const prevLastShot = this.lastShot;
  _achOrigShoot.call(this);
  if (w && this.lastShot !== prevLastShot) {
    if (!AchievementStats.weaponsUsed.includes(w.name)) AchievementStats.weaponsUsed.push(w.name);
    AchievementManager.evaluate("shoot");
  }
};
const _achOrigReload = game.reload;
game.reload = function() {
  const w = this.player && this.player.weapon;
  const before = w ? w.ammo : null;
  _achOrigReload.call(this);
  if (w && w.type !== "melee" && before !== null && before !== w.capacity) {
    AchievementStats.reloads++;
    AchievementManager.evaluate("reload");
  }
};
const _achOrigTakeDamage = Player.prototype.takeDamage;
Player.prototype.takeDamage = function(amt) {
  AchievementManager._tookDamageThisWave = true;
  _achOrigTakeDamage.call(this, amt);
};
const _achOrigDash = Player.prototype.dash;
Player.prototype.dash = function() {
  const before = this.isDashing;
  _achOrigDash.call(this);
  if (!before && this.isDashing) {
    AchievementStats.dashUses++;
    AchievementManager.evaluate("dash");
  }
};
const _achOrigLoop = game.loop;
game.loop = function() {
  const waveBefore = this.wave;
  const eventBefore = this.activeEvent;
  _achOrigLoop.call(this);
  if (this.wave !== waveBefore) AchievementManager.onWaveClear(waveBefore, eventBefore);
};
const _achOrigShowLevelUp = game.showLevelUp;
game.showLevelUp = function(level) {
  _achOrigShowLevelUp.call(this, level);
  AchievementManager.evaluate("levelUp");
};
const _achOrigGameOver = game.gameOver;
game.gameOver = function() {
  _achOrigGameOver.call(this);
  AchievementStats.killStreakNoDeath = 0;
  AchievementManager.evaluate("death");
  AchievementManager.saveStats();
};
const _achOrigBuyWeapon = game.buyWeapon;
game.buyWeapon = function(k) {
  const before = this.player.inventory.some((s) => s && s.name === k);
  _achOrigBuyWeapon.call(this, k);
  const after = this.player.inventory.some((s) => s && s.name === k);
  if (!before && after) {
    AchievementStats.weaponsPurchased++;
    const cat = WEAPON_CATEGORY[k];
    if (cat === "heavy" || cat === "special") AchievementStats.heavyWeaponPurchased = true;
    AchievementManager.evaluate("buyWeapon");
    AchievementManager.saveStats();
  }
};
const _achOrigSellWeapon = game.sellWeapon;
game.sellWeapon = function(k) {
  _achOrigSellWeapon.call(this, k);
  AchievementStats.weaponsSold++;
  AchievementManager.evaluate("sellWeapon");
  AchievementManager.saveStats();
};
const _achOrigBuyHealth = game.buyHealth;
game.buyHealth = function() {
  const before = this.player.money;
  _achOrigBuyHealth.call(this);
  if (this.player.money < before) {
    AchievementStats.healthPackUses++;
    AchievementManager.evaluate("healthBuy");
  }
};
const _achOrigProgBuy = Progression.buy;
Progression.buy = function(k) {
  const result = _achOrigProgBuy.call(this, k);
  if (result) {
    AchievementStats.upgradesBuys++;
    if (!AchievementStats.upgradesTouched.includes(k)) AchievementStats.upgradesTouched.push(k);
    AchievementManager.evaluate("upgradeBuy");
    AchievementManager.saveStats();
  }
  return result;
};
const _achOrigInit = game.init;
game.init = function() {
  _achOrigInit.call(this);
  if (AchievementStats.pendingMoney) {
    this.player.money += AchievementStats.pendingMoney;
    AchievementStats.pendingMoney = 0;
    AchievementManager.saveStats();
  }
};
window.addEventListener("beforeunload", () => AchievementManager.saveStats());
SaveSystem.onRemoteData(function(keys) {
  let changed = false;
  if (keys.includes("achv_stats")) {
    Object.assign(AchievementStats, SaveSystem.get("achv_stats", {}));
    changed = true;
  }
  if (keys.includes("achv_state")) {
    Object.assign(AchievementState, SaveSystem.get("achv_state", {}));
    changed = true;
  }
  if (changed && typeof game.renderAchievements === "function") game.renderAchievements();
});
const _achOrigOpenProfile = game.openProfile;
game.openProfile = function() {
  _achOrigOpenProfile.call(this);
  game.setProfileTab("stats");
};
game.setProfileTab = function(tab) {
  const statsTab = document.getElementById("profile-tab-stats");
  const achvTab = document.getElementById("profile-tab-achv");
  const btnStats = document.getElementById("tab-btn-stats");
  const btnAchv = document.getElementById("tab-btn-achv");
  if (!statsTab || !achvTab) return;
  statsTab.style.display = tab === "stats" ? "block" : "none";
  achvTab.style.display = tab === "achv" ? "block" : "none";
  if (btnStats) btnStats.classList.toggle("active", tab === "stats");
  if (btnAchv) btnAchv.classList.toggle("active", tab === "achv");
  if (tab === "achv") game.renderAchievements();
};
game.claimAchievement = function(id) {
  if (AchievementManager.claim(id)) {
    playSFX("coin");
    game.renderAchievements();
  }
};
game.renderAchievements = function() {
  const listEl = document.getElementById("achv-list");
  const summaryEl = document.getElementById("achv-summary");
  if (!listEl) return;
  const searchEl = document.getElementById("achv-search");
  const catEl = document.getElementById("achv-category-filter");
  const statusEl = document.getElementById("achv-status-filter");
  const search = searchEl ? searchEl.value.trim().toLowerCase() : "";
  const catFilter = catEl ? catEl.value : "ALL";
  const statusFilter = statusEl ? statusEl.value : "ALL";
  let total = 0, completedCount = 0;
  const cards = [];
  Object.values(ACHIEVEMENTS_DB).forEach((def) => {
    total++;
    const value = def.getValue();
    const isCompleted = value >= def.target;
    if (isCompleted) completedCount++;
    const state = AchievementManager.getState(def.id);
    if (catFilter !== "ALL" && def.category !== catFilter) return;
    if (statusFilter === "COMPLETED" && !isCompleted) return;
    if (statusFilter === "UNCLAIMED" && !(isCompleted && !state.claimed)) return;
    if (statusFilter === "LOCKED" && isCompleted) return;
    const showHidden = def.hidden && !isCompleted;
    const name = showHidden ? "???" : def.name;
    const desc = showHidden ? "Logro secreto. Desc\xFAbrelo jugando." : def.desc;
    if (search && !name.toLowerCase().includes(search) && !desc.toLowerCase().includes(search)) return;
    const rarity = RARITY[def.rarity];
    const pct = Math.min(100, Math.floor(value / def.target * 100));
    const cardClasses = ["achv-card"];
    if (isCompleted) cardClasses.push("completed");
    if (isCompleted && def.rarity === "LEGENDARIO") cardClasses.push("legendary-glow");
    let actionHtml;
    if (state.claimed) actionHtml = '<span class="achv-claimed">RECLAMADO</span>';
    else if (isCompleted) actionHtml = `<button class="buy-btn" onclick="game.claimAchievement('${def.id}')">RECLAMAR</button>`;
    else actionHtml = '<span class="achv-locked">\u{1F512}</span>';
    cards.push(`<div class="${cardClasses.join(" ")}" style="--rarity-color:${rarity.color}">
            <div class="achv-icon">${showHidden ? "\u2753" : def.icon}</div>
            <div class="achv-info">
                <div class="achv-name">${name} <span class="achv-rarity" style="color:${rarity.color}">${rarity.label}</span></div>
                <div class="achv-desc">${desc}</div>
                <div class="achv-progress-bar"><div class="achv-progress-inner" style="width:${pct}%; background:${rarity.color}"></div></div>
                <div class="achv-progress-text">${Math.min(value, def.target)} / ${def.target} \u2014 ${pct}%</div>
                <div class="achv-reward">\u{1F381} ${def.reward.label || "Recompensa cosm\xE9tica"}</div>
            </div>
            <div class="achv-action">${actionHtml}</div>
        </div>`);
  });
  listEl.innerHTML = cards.join("") || '<p style="color:#888;">No hay logros que coincidan con el filtro.</p>';
  if (summaryEl) summaryEl.innerHTML = `<div class="hud-text">Progreso total: ${completedCount} / ${total} (${Math.floor(completedCount / total * 100)}%)</div>`;
};
window.addEventListener("DOMContentLoaded", () => {
  const catSelect = document.getElementById("achv-category-filter");
  if (catSelect) {
    Object.entries(ACHIEVEMENT_CATEGORIES).forEach(([key, label]) => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = label;
      catSelect.appendChild(opt);
    });
  }
});
const AuthUI = {
  handleClick() {
    if (SaveSystem.currentUser) SaveSystem.signOut();
    else SaveSystem.signInWithGoogle();
  },
  currentLabel() {
    const u = SaveSystem.currentUser;
    return u ? u.displayName || u.email || "Cuenta conectada" : "Invitado (local)";
  },
  // Repinta el botón/estado del lobby con el estado actual de sesión. Se llama:
  // - al cargar la página (por si Firebase ya tenía sesión guardada)
  // - cada vez que main.js reconstruye el innerHTML del lobby
  // - en los eventos savesystem:login / savesystem:logout
  refresh() {
    const statusEl = document.getElementById("auth-status");
    const btnEl = document.getElementById("auth-btn");
    if (!statusEl || !btnEl) return;
    const u = SaveSystem.currentUser;
    if (u) {
      statusEl.innerText = `\u2705 Conectado como ${u.displayName || u.email}`;
      btnEl.innerText = "\u{1F6AA} CERRAR SESI\xD3N";
    } else {
      statusEl.innerText = "\u{1F464} Invitado \u2014 tu progreso solo se guarda en este dispositivo";
      btnEl.innerText = "\u{1F511} INICIAR SESI\xD3N CON GOOGLE";
    }
  }
};
document.addEventListener("savesystem:login", () => AuthUI.refresh());
document.addEventListener("savesystem:logout", () => AuthUI.refresh());
window.addEventListener("DOMContentLoaded", () => AuthUI.refresh());
const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;
if (isTouchDevice) {
  let updateJoystick = function(touch) {
    const rect = joystickZone.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = touch.clientX - cx;
    let dy = touch.clientY - cy;
    const maxDist = rect.width / 2;
    const dist = Math.min(Math.hypot(dx, dy), maxDist);
    const angle = Math.atan2(dy, dx);
    const kx = Math.cos(angle) * dist;
    const ky = Math.sin(angle) * dist;
    joystickKnob.style.transform = `translate(${kx}px, ${ky}px)`;
    const threshold = maxDist * 0.25;
    game.keys["KeyW"] = ky < -threshold;
    game.keys["KeyS"] = ky > threshold;
    game.keys["KeyA"] = kx < -threshold;
    game.keys["KeyD"] = kx > threshold;
  }, resetJoystick = function() {
    joystickKnob.style.transform = "translate(0px, 0px)";
    game.keys["KeyW"] = game.keys["KeyS"] = game.keys["KeyA"] = game.keys["KeyD"] = false;
  };
  const joystickZone = document.getElementById("joystick-zone");
  const joystickKnob = document.getElementById("joystick-knob");
  const aimZone = document.getElementById("aim-zone");
  let joystickTouchId = null;
  let aimTouchId = null;
  joystickZone.addEventListener("touchstart", (e) => {
    if (game.paused) return;
    e.preventDefault();
    joystickTouchId = e.changedTouches[0].identifier;
    updateJoystick(e.changedTouches[0]);
  });
  joystickZone.addEventListener("touchmove", (e) => {
    if (game.paused) return;
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === joystickTouchId) updateJoystick(t);
  });
  joystickZone.addEventListener("touchend", (e) => {
    for (const t of e.changedTouches) if (t.identifier === joystickTouchId) {
      joystickTouchId = null;
      resetJoystick();
    }
  });
  aimZone.addEventListener("touchstart", (e) => {
    if (game.paused) return;
    e.preventDefault();
    const t = e.changedTouches[0];
    aimTouchId = t.identifier;
    game.mouse.x = t.clientX;
    game.mouse.y = t.clientY;
    game.mouse.down = true;
  });
  aimZone.addEventListener("touchmove", (e) => {
    if (game.paused) return;
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === aimTouchId) {
      game.mouse.x = t.clientX;
      game.mouse.y = t.clientY;
    }
  });
  aimZone.addEventListener("touchend", (e) => {
    for (const t of e.changedTouches) if (t.identifier === aimTouchId) {
      aimTouchId = null;
      game.mouse.down = false;
    }
  });
  document.getElementById("mobile-dash-btn").addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (!game.paused && game.player) game.player.dash();
  });
  document.getElementById("mobile-reload-btn").addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (!game.paused) game.reload();
  });
}
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}
const BootFlow = {
  async run() {
    const fill = document.getElementById("boot-progress-fill");
    const pct = document.getElementById("boot-progress-pct");
    const label = document.getElementById("boot-progress-label");
    const loadingScreen = document.getElementById("loading-screen");
    const steps = [
      { label: "Conectando con el servidor...", weight: 1, run: (p) => {
        p(0.2);
        return withTimeout(SaveSystem.ready, 8e3).then(() => p(1));
      } },
      { label: "Sincronizando progreso...", weight: 1, run: (p) => {
        p(1);
        return Promise.resolve();
      } },
      { label: "Cargando sonidos...", weight: 3, run: (p) => preloadSFX((l, t) => p(l / t)) },
      { label: "Cargando m\xFAsica...", weight: 3, run: (p) => preloadMusic((l, t) => p(l / t)) },
      { label: "Cargando recursos gr\xE1ficos...", weight: 1, run: (p) => {
        p(0.3);
        const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
        return withTimeout(fontsReady, 3e3).then(() => p(1));
      } },
      { label: "Inicializando sistemas...", weight: 1, run: (p) => {
        if (typeof MusicManager !== "undefined") MusicManager.init();
        p(1);
        return Promise.resolve();
      } }
    ];
    const totalWeight = steps.reduce((s, st) => s + st.weight, 0);
    let doneWeight = 0;
    const updateBar = (extra) => {
      const total = Math.min(totalWeight, doneWeight + extra);
      const p = Math.round(total / totalWeight * 100);
      if (fill) fill.style.width = p + "%";
      if (pct) pct.innerText = p + "%";
    };
    for (const step of steps) {
      if (label) label.innerText = step.label;
      await step.run((frac) => updateBar(step.weight * Math.max(0, Math.min(1, frac))));
      doneWeight += step.weight;
      updateBar(0);
    }
    if (label) label.innerText = "\xA1Listo!";
    await new Promise((r) => setTimeout(r, 250));
    if (loadingScreen) loadingScreen.style.display = "none";
    this.goToLoginOrStart();
  },
  goToLoginOrStart() {
    if (SaveSystem.currentUser) this.showClickStart();
    else this.showLogin();
  },
  showLogin() {
    const el = document.getElementById("login-screen");
    if (el) el.style.display = "flex";
  },
  showClickStart() {
    const login = document.getElementById("login-screen");
    if (login) login.style.display = "none";
    const el = document.getElementById("clickstart-screen");
    if (el) el.style.display = "flex";
  },
  unlockAndEnter() {
    const clickstart = document.getElementById("clickstart-screen");
    if (clickstart) clickstart.style.display = "none";
    if (typeof MusicManager !== "undefined") MusicManager.playLobby();
    const lobbyScreen = document.getElementById("lobby-screen");
    if (lobbyScreen) lobbyScreen.style.display = "flex";
    if (typeof AuthUI !== "undefined") AuthUI.refresh();
  }
};
window.addEventListener("DOMContentLoaded", () => {
  const googleBtn = document.getElementById("login-google-btn");
  const guestBtn = document.getElementById("login-guest-btn");
  const clickstart = document.getElementById("clickstart-screen");
  if (googleBtn) {
    googleBtn.addEventListener("click", async () => {
      googleBtn.disabled = true;
      await SaveSystem.signInWithGoogle();
      googleBtn.disabled = false;
      BootFlow.showClickStart();
    });
  }
  if (guestBtn) guestBtn.addEventListener("click", () => BootFlow.showClickStart());
  if (clickstart) clickstart.addEventListener("click", () => BootFlow.unlockAndEnter(), { once: true });
  BootFlow.run();
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLmNvbWJpbmVkLmpzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJcInVzZSBzdHJpY3RcIjtcblxuLyogPT09PT09PT09PT09PT09PT0gRmlyZWJhc2VTYXZlU3lzdGVtLmpzID09PT09PT09PT09PT09PT09ICovXG4vKipcbiAqIEZJUkVCQVNFIFNBVkUgU1lTVEVNXG4gKiBSZWVtcGxhem8gZGVsIFNhdmVTeXN0ZW0gdmllam8gKGxvY2FsU3RvcmFnZSBwdXJvLCB2aXZcdTAwRURhIGRlbnRybyBkZSBsZXZlbC5qcykuXG4gKlxuICogT0JKRVRJVk8gREUgRElTRVx1MDBEMU86IG5hZGllIG1cdTAwRTFzIGVuIGVsIHByb3llY3RvIGRlYmVyXHUwMEVEYSB0ZW5lciBxdWUgc2FiZXIgcXVlIGV4aXN0ZVxuICogRmlyZWJhc2UuIGxldmVsLmpzIC8gcHJvZ3Jlc3Npb24uanMgLyBhY2hpZXZlbWVudHMuanMgc2lndWVuIGxsYW1hbmRvIGV4YWN0YW1lbnRlXG4gKiBhIGxhcyBtaXNtYXMgZG9zIGZ1bmNpb25lcyBkZSBzaWVtcHJlOlxuICpcbiAqICAgICBTYXZlU3lzdGVtLmdldChrZXksIGZhbGxiYWNrKSAgIC0+IFNJRU1QUkUgc1x1MDBFRG5jcm9ubywgbnVuY2EgYmxvcXVlYSBlbCBqdWVnb1xuICogICAgIFNhdmVTeXN0ZW0uc2V0KGtleSwgdmFsdWUpICAgICAgLT4gU0lFTVBSRSBzXHUwMEVEbmNyb25vIGVuIGFwYXJpZW5jaWEgKGVzY3JpYmUgZW5cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWNoXHUwMEU5IGxvY2FsIGFsIHRvcXVlOyBGaXJlc3RvcmUgc2Ugc2luY3Jvbml6YVxuICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNvbG8sIGVuIHNlZ3VuZG8gcGxhbm8sIGNvbiByZWludGVudG9zKVxuICpcbiAqIFRvZGEgbGEgY29tdW5pY2FjaVx1MDBGM24gcmVhbCBjb24gRmlyZWJhc2UgKEF1dGggKyBGaXJlc3RvcmUpIHZpdmUgXHUwMERBTklDQU1FTlRFIGFjXHUwMEUxLlxuICogTmluZ1x1MDBGQW4gb3RybyBhcmNoaXZvIGltcG9ydGEgZmlyZWJhc2UuKiBkaXJlY3RhbWVudGUuXG4gKlxuICogRVNUUkFURUdJQSBcIk9GRkxJTkUtRklSU1RcIjpcbiAqICAgMS4gTGVjdHVyYTogcHJpbWVybyBtZW1vcmlhICh0aGlzLl9jYWNoZSksIHNpIG5vIGVzdFx1MDBFMSwgbG9jYWxTdG9yYWdlLiBGaXJlc3RvcmVcbiAqICAgICAgTlVOQ0Egc2UgY29uc3VsdGEgZGUgZm9ybWEgc1x1MDBFRG5jcm9uYSAobm8gc2UgcHVlZGU6IGVzIHVuYSBwcm9tZXNhKS5cbiAqICAgMi4gRXNjcml0dXJhOiBzZSBndWFyZGEgZW4gbWVtb3JpYSArIGxvY2FsU3RvcmFnZSBhbCBpbnN0YW50ZSAoZWwganVlZ28gc2lndWVcbiAqICAgICAgYW5kYW5kbyBpZ3VhbCBxdWUgY29uIGVsIFNhdmVTeXN0ZW0gdmllam8pIHkgc2UgbWFyY2EgbGEga2V5IGNvbW8gXCJzdWNpYVwiLlxuICogICAgICBDYWRhIH4yLjVzIChkZWJvdW5jZSkgc2UgZW1wdWphIGVsIGxvdGUgZGUga2V5cyBzdWNpYXMgYSBGaXJlc3RvcmUuIFNpXG4gKiAgICAgIEZpcmVzdG9yZSBmYWxsYSAoc2luIHJlZCwgcmVnbGFzLCBldGMuKSBlbCBlcnJvciBzZSB0cmFnYSBjb24gdW4gY29uc29sZS53YXJuXG4gKiAgICAgIHkgbGFzIGtleXMgcXVlZGFuIHBlbmRpZW50ZXMgcGFyYSBlbCBwclx1MDBGM3hpbW8gaW50ZW50bzogZWwganVlZ28gSkFNXHUwMEMxUyBzZSByb21wZVxuICogICAgICBuaSBzZSBibG9xdWVhIHBvciB1biBmYWxsbyBkZSByZWQuXG4gKiAgIDMuIExvZ2luOiBhbCBpbmljaWFyIHNlc2lcdTAwRjNuIGNvbiBHb29nbGUsIHNlIGRlc2NhcmdhIGVsIGRvY3VtZW50byBkZWwgdXN1YXJpb1xuICogICAgICAocGxheWVycy97dWlkfSkgVU5BIHZleiB5IHNlIG1lcmdlYSBzb2JyZSBsYSBjYWNoXHUwMEU5IGxvY2FsICsgbG9jYWxTdG9yYWdlLiBDb21vXG4gKiAgICAgIFBsYXllclByb2ZpbGUvUHJvZ3Jlc3Npb24vQWNoaWV2ZW1lbnRTdGF0cy9BY2hpZXZlbWVudFN0YXRlIHlhIGV4aXN0ZW4gcGFyYVxuICogICAgICBlc2UgbW9tZW50byAoc2UgY29uc3RydXllcm9uIGRlIGZvcm1hIHNcdTAwRURuY3JvbmEgYWwgY2FyZ2FyIGVsIHNjcmlwdCwgYW50ZXMgZGVcbiAqICAgICAgcXVlIEZpcmViYXNlIHJlc3VlbHZhIGVsIGxvZ2luKSwgY2FkYSBtXHUwMEYzZHVsbyBzZSBzdXNjcmliZSBjb25cbiAqICAgICAgU2F2ZVN5c3RlbS5vblJlbW90ZURhdGEoY2IpIHBhcmEgXCJyZWZyZXNjYXJzZVwiIGEgc1x1MDBFRCBtaXNtbyBjdWFuZG8gbGxlZ2FuIGRhdG9zXG4gKiAgICAgIG1cdTAwRTFzIG51ZXZvcyBkZXNkZSBsYSBudWJlLlxuICpcbiAqIFBSRVBBUkFETyBQQVJBIFJBTktJTkdTIE9OTElORSBBIEZVVFVSTzpcbiAqICAgcHVzaExlYWRlcmJvYXJkRW50cnkoKSB5YSBkZWphIGVzY3JpdG8gdW4gZG9jdW1lbnRvIGxpdmlhbm8geSBjb25zdWx0YWJsZSBlbiBsYVxuICogICBjb2xlY2NpXHUwMEYzbiB0b3AtbGV2ZWwgYGxlYWRlcmJvYXJkYCAodWlkLCBub21icmUsIG5pdmVsLCBtZWpvciBvbGVhZGEsIGZlY2hhKS4gSG95XG4gKiAgIG5hZGllIGxhIGxsYW1hIHRvZGF2XHUwMEVEYTogZXMgbGEgYmFzZSBwYXJhIHVuYSBmdXR1cmEgcGFudGFsbGEgZGUgXCJUb3AganVnYWRvcmVzXCJcbiAqICAgc2luIHRlbmVyIHF1ZSByZWRpc2VcdTAwRjFhciBuYWRhIGRlIGVzdGUgYXJjaGl2by5cbiAqXG4gKiBOVUVWTyAoYm9vdCBmbG93KTogU2F2ZVN5c3RlbS5yZWFkeSBlcyB1bmEgUHJvbWlzZSBxdWUgcmVzdWVsdmUgY3VhbmRvIEZpcmViYXNlXG4gKiBBdXRoIHlhIHJlc29sdmlcdTAwRjMgc3UgcHJpbWVyIGVzdGFkbyAobG9ndWVhZG8gbyBubykgeSwgc2kgaGFiXHUwMEVEYSBzZXNpXHUwMEYzbiwgeWEgc2UgYmFqXHUwMEYzXG4gKiBlbCBwcm9ncmVzbyBkZSBGaXJlc3RvcmUuIGJvb3QuanMgZXNwZXJhIGVzdG8gYW50ZXMgZGUgbW9zdHJhciBjdWFscXVpZXIgcGFudGFsbGEuXG4gKlxuICogTlVFVk86IFNhdmVTeXN0ZW0uY2xlYXJQcm9ncmVzcygpIGJvcnJhIHBvciBjb21wbGV0byBlbCBwcm9ncmVzbyAobG9jYWwgKyBudWJlKSxcbiAqIHVzYWRvIGRlc2RlIEFqdXN0ZXMgXHUyMTkyIEJvcnJhciBwcm9ncmVzby5cbiAqXG4gKiBEZWJlIGNhcmdhcnNlOlxuICogICAtIERFU1BVXHUwMEM5UyBkZSBsb3MgPHNjcmlwdD4gZGVsIFNESyBkZSBGaXJlYmFzZSAoY29tcGF0KSBlbiBpbmRleC5odG1sLlxuICogICAtIEFOVEVTIGRlIGxldmVsLmpzIC8gcHJvZ3Jlc3Npb24uanMgLyBhY2hpZXZlbWVudHMuanMgKHF1ZSBjb25zdW1lbiBTYXZlU3lzdGVtKS5cbiAqL1xuXG5jb25zdCBmaXJlYmFzZUNvbmZpZyA9IHtcbiAgICBhcGlLZXk6IFwiQUl6YVN5Q1M4alhTcFR1U0RSUkRRTzI0YUd2aFIwMG9LS2NiaHlZXCIsXG4gICAgYXV0aERvbWFpbjogXCJzbGltZWZyb250LWYwMTFlLmZpcmViYXNlYXBwLmNvbVwiLFxuICAgIHByb2plY3RJZDogXCJzbGltZWZyb250LWYwMTFlXCIsXG4gICAgc3RvcmFnZUJ1Y2tldDogXCJzbGltZWZyb250LWYwMTFlLmZpcmViYXNlc3RvcmFnZS5hcHBcIixcbiAgICBtZXNzYWdpbmdTZW5kZXJJZDogXCI5NTY5MTIxNjIwODZcIixcbiAgICBhcHBJZDogXCIxOjk1NjkxMjE2MjA4Njp3ZWI6MjczZDFhM2M3M2UwZmFkYjY1OWRlN1wiLFxuICAgIG1lYXN1cmVtZW50SWQ6IFwiRy00UjVOUEpDU1RLXCJcbn07XG5cbmZpcmViYXNlLmluaXRpYWxpemVBcHAoZmlyZWJhc2VDb25maWcpO1xuY29uc3QgX2F1dGggPSBmaXJlYmFzZS5hdXRoKCk7XG5jb25zdCBfZGIgPSBmaXJlYmFzZS5maXJlc3RvcmUoKTtcblxuLy8gQW5hbHl0aWNzIGVzIG9wY2lvbmFsIHkgbm8gZGViZSBwb2RlciByb21wZXIgZWwgYXJyYW5xdWUgZGVsIGp1ZWdvIHNpIGVsIG5hdmVnYWRvclxuLy8gYmxvcXVlYSBlbCBzY3JpcHQgKGFkYmxvY2tlcnMsIGlPUyBwcml2YWRvLCBldGMuKVxudHJ5IHsgZmlyZWJhc2UuYW5hbHl0aWNzKCk7IH0gY2F0Y2ggKGUpIHsgY29uc29sZS53YXJuKCdbRmlyZWJhc2VTYXZlU3lzdGVtXSBBbmFseXRpY3Mgbm8gZGlzcG9uaWJsZTonLCBlKTsgfVxuXG4vLyBDYWNoXHUwMEU5IGRlIEZpcmVzdG9yZSBlbiBkaXNjbyBkZWwgcHJvcGlvIFNESyAoYWRlbVx1MDBFMXMgZGUgbnVlc3RyYSBjb3BpYSBlbiBsb2NhbFN0b3JhZ2UpLlxuLy8gc3luY2hyb25pemVUYWJzIHBlcm1pdGUgdGVuZXIgZWwganVlZ28gYWJpZXJ0byBlbiAyIHBlc3RhXHUwMEYxYXMgc2luIHF1ZSB1bmEgcGlzZSBhIGxhIG90cmEuXG50cnkge1xuICAgIF9kYi5lbmFibGVQZXJzaXN0ZW5jZSh7IHN5bmNocm9uaXplVGFiczogdHJ1ZSB9KS5jYXRjaChlcnIgPT4ge1xuICAgICAgICBjb25zb2xlLndhcm4oJ1tGaXJlYmFzZVNhdmVTeXN0ZW1dIFBlcnNpc3RlbmNpYSBkZSBGaXJlc3RvcmUgbm8gZGlzcG9uaWJsZSAobXVsdGktcGVzdGFcdTAwRjFhIG8gbmF2ZWdhZG9yIG5vIHNvcG9ydGFkbyk6JywgZXJyLmNvZGUgfHwgZXJyKTtcbiAgICB9KTtcbn0gY2F0Y2ggKGUpIHsgLyogU0RLIHZpZWpvIHNpbiBzb3BvcnRlLCBubyBlcyBmYXRhbCAqLyB9XG5cbmNvbnN0IF9MT0NBTF9QUkVGSVggPSAnc2xpbWVfJztcbmNvbnN0IF9TWU5DX0RFQk9VTkNFX01TID0gMjUwMDtcbmNvbnN0IFBMQVlFUlNfQ09MTEVDVElPTiA9ICdwbGF5ZXJzJztcbmNvbnN0IExFQURFUkJPQVJEX0NPTExFQ1RJT04gPSAnbGVhZGVyYm9hcmQnO1xuXG5jb25zdCBTYXZlU3lzdGVtID0ge1xuICAgIF9jYWNoZToge30sXG4gICAgX3VpZDogbnVsbCxcbiAgICBfZGlydHk6IG5ldyBTZXQoKSxcbiAgICBfcHVzaFRpbWVyOiBudWxsLFxuICAgIF9yZW1vdGVMaXN0ZW5lcnM6IFtdLFxuICAgIHJlYWR5OiBudWxsLCAgICAgICAgLy8gUHJvbWlzZSBxdWUgcmVzdWVsdmUgY3VhbmRvIEZpcmViYXNlIEF1dGggeWEgcmVzb2x2aVx1MDBGMyBzdVxuICAgICAgICAgICAgICAgICAgICAgICAgIC8vIHByaW1lciBlc3RhZG8gKGxvZ3VlYWRvIG8gbm8pIFksIHNpIGhhYlx1MDBFRGEgc2VzaVx1MDBGM24sIHlhIHNlXG4gICAgICAgICAgICAgICAgICAgICAgICAgLy8gYmFqXHUwMEYzIGVsIHByb2dyZXNvIGRlIEZpcmVzdG9yZS4gYm9vdC5qcyBlc3BlcmEgZXN0byBhbnRlc1xuICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGRlIG1vc3RyYXIgY3VhbHF1aWVyIHBhbnRhbGxhLlxuICAgIF9yZWFkeVJlc29sdmU6IG51bGwsXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PSBMRUNUVVJBIC8gRVNDUklUVVJBIChtaXNtYSBpbnRlcmZheiBxdWUgZWwgU2F2ZVN5c3RlbSB2aWVqbykgPT09PT09PT09PT09PT09PT1cblxuICAgIGdldChrZXksIGZhbGxiYWNrKSB7XG4gICAgICAgIGlmIChrZXkgaW4gdGhpcy5fY2FjaGUpIHJldHVybiB0aGlzLl9jYWNoZVtrZXldO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmF3ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oX0xPQ0FMX1BSRUZJWCArIGtleSk7XG4gICAgICAgICAgICBpZiAocmF3ICE9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBKU09OLnBhcnNlKHJhdyk7XG4gICAgICAgICAgICAgICAgdGhpcy5fY2FjaGVba2V5XSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZSkgeyAvKiBsb2NhbFN0b3JhZ2UgY29ycnVwdG8gbyBkZXNoYWJpbGl0YWRvOiBzZWd1aW1vcyBjb24gZWwgZmFsbGJhY2sgKi8gfVxuICAgICAgICByZXR1cm4gZmFsbGJhY2s7XG4gICAgfSxcblxuICAgIHNldChrZXksIHZhbHVlKSB7XG4gICAgICAgIHRoaXMuX2NhY2hlW2tleV0gPSB2YWx1ZTtcbiAgICAgICAgdHJ5IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oX0xPQ0FMX1BSRUZJWCArIGtleSwgSlNPTi5zdHJpbmdpZnkodmFsdWUpKTsgfSBjYXRjaCAoZSkgeyAvKiBjdW90YSBsbGVuYSwgbW9kbyBwcml2YWRvLCBldGMuICovIH1cbiAgICAgICAgdGhpcy5fZGlydHkuYWRkKGtleSk7XG4gICAgICAgIHRoaXMuX3NjaGVkdWxlU3luYygpO1xuICAgIH0sXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PSBTVVNDUklQQ0lcdTAwRDNOIEEgREFUT1MgUkVNT1RPUyA9PT09PT09PT09PT09PT09PVxuICAgIC8vIEN1YWxxdWllciBtXHUwMEYzZHVsbyAobGV2ZWwuanMsIHByb2dyZXNzaW9uLmpzLCBhY2hpZXZlbWVudHMuanMpIHB1ZWRlIHJlZ2lzdHJhciB1blxuICAgIC8vIGNhbGxiYWNrIGFjXHUwMEUxIHBhcmEgZW50ZXJhcnNlIHF1XHUwMEVEIGtleXMgbGxlZ2Fyb24vYWN0dWFsaXphcm9uIGRlc2RlIEZpcmVzdG9yZVxuICAgIC8vIERFU1BVXHUwMEM5UyBkZSBxdWUgc3VzIHByb3Bpb3Mgb2JqZXRvcyAoUGxheWVyUHJvZmlsZSwgZXRjLikgeWEgc2UgYXJtYXJvbiBlbiBmclx1MDBFRG8uXG4gICAgb25SZW1vdGVEYXRhKGNhbGxiYWNrKSB7XG4gICAgICAgIHRoaXMuX3JlbW90ZUxpc3RlbmVycy5wdXNoKGNhbGxiYWNrKTtcbiAgICB9LFxuICAgIF9ub3RpZnlSZW1vdGUoa2V5cykge1xuICAgICAgICB0aGlzLl9yZW1vdGVMaXN0ZW5lcnMuZm9yRWFjaChjYiA9PiB7XG4gICAgICAgICAgICB0cnkgeyBjYihrZXlzKTsgfSBjYXRjaCAoZSkgeyBjb25zb2xlLndhcm4oJ1tGaXJlYmFzZVNhdmVTeXN0ZW1dIEVycm9yIGVuIGxpc3RlbmVyIG9uUmVtb3RlRGF0YTonLCBlKTsgfVxuICAgICAgICB9KTtcbiAgICB9LFxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT0gU0lOQ1JPTklaQUNJXHUwMEQzTiBDT04gRklSRVNUT1JFIChudW5jYSBibG9xdWVhLCBudW5jYSByb21wZSkgPT09PT09PT09PT09PT09PT1cblxuICAgIF9zY2hlZHVsZVN5bmMoKSB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aGlzLl9wdXNoVGltZXIpO1xuICAgICAgICB0aGlzLl9wdXNoVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHRoaXMuX3B1c2hEaXJ0eSgpLCBfU1lOQ19ERUJPVU5DRV9NUyk7XG4gICAgfSxcblxuICAgIGFzeW5jIF9wdXNoRGlydHkoKSB7XG4gICAgICAgIGlmICghdGhpcy5fdWlkIHx8IHRoaXMuX2RpcnR5LnNpemUgPT09IDApIHJldHVybjtcbiAgICAgICAgY29uc3Qga2V5cyA9IEFycmF5LmZyb20odGhpcy5fZGlydHkpO1xuICAgICAgICB0aGlzLl9kaXJ0eS5jbGVhcigpO1xuICAgICAgICBjb25zdCBwYXRjaCA9IHt9O1xuICAgICAgICBrZXlzLmZvckVhY2goayA9PiB7XG4gICAgICAgICAgICAvLyBGaXJlc3RvcmUgcmVjaGF6YSBjb24gXCJpbnZhbGlkLWFyZ3VtZW50XCIgY3VhbHF1aWVyIHZhbG9yIG5vIHNlcmlhbGl6YWJsZVxuICAgICAgICAgICAgLy8gKGZ1bmNpb25lcywgdW5kZWZpbmVkLCBldGMuKS4gUGxheWVyUHJvZmlsZSwgcG9yIGVqZW1wbG8sIHRpZW5lIHN1IHByb3Bpb1xuICAgICAgICAgICAgLy8gbVx1MDBFOXRvZG8gLnNhdmUgY29sZ2FuZG8gZGVsIG1pc21vIG9iamV0byBxdWUgc2UgY2FjaGVhIGFjXHUwMEUxICh2ZXIgbGV2ZWwuanM6XG4gICAgICAgICAgICAvLyBcIlBsYXllclByb2ZpbGUuc2F2ZSA9IGZ1bmN0aW9uKCl7Li4ufVwiKSwgeSBsb2NhbFN0b3JhZ2UgbG8gdG9sZXJhIHBvcnF1ZVxuICAgICAgICAgICAgLy8gSlNPTi5zdHJpbmdpZnkgaWdub3JhIGZ1bmNpb25lcyBlbiBzaWxlbmNpbywgcGVybyBlbCBTREsgZGUgRmlyZXN0b3JlIG5vLlxuICAgICAgICAgICAgLy8gUGFzYW1vcyB0b2RvIHBvciBlbCBtaXNtbyBjaWNsbyBKU09OIHBhcmEgcXVlZGFybm9zIHNvbG8gY29uIGRhdG9zIHBsYW5vcy5cbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcGF0Y2hba10gPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KHRoaXMuX2NhY2hlW2tdKSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS53YXJuKGBbRmlyZWJhc2VTYXZlU3lzdGVtXSBObyBzZSBwdWRvIHNlcmlhbGl6YXIgbGEga2V5IFwiJHtrfVwiLCBzZSBvbWl0ZSBlc3RlIGNpY2xvIGRlIHN5bmM6YCwgZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBwYXRjaC5fdXBkYXRlZEF0ID0gZmlyZWJhc2UuZmlyZXN0b3JlLkZpZWxkVmFsdWUuc2VydmVyVGltZXN0YW1wKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBfZGIuY29sbGVjdGlvbihQTEFZRVJTX0NPTExFQ1RJT04pLmRvYyh0aGlzLl91aWQpLnNldChwYXRjaCwgeyBtZXJnZTogdHJ1ZSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKCdbRmlyZWJhc2VTYXZlU3lzdGVtXSBGaXJlc3RvcmUgbm8gZGlzcG9uaWJsZSwgc2Ugc2lndWUganVnYW5kbyBjb24gbGEgY2FjaFx1MDBFOSBsb2NhbC4gUmVpbnRlbnRhclx1MDBFMTonLCBlLmNvZGUgfHwgZSk7XG4gICAgICAgICAgICBrZXlzLmZvckVhY2goayA9PiB0aGlzLl9kaXJ0eS5hZGQoaykpO1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIC8vIEZ1ZXJ6YSBlbCBlbnZcdTAwRURvIGlubWVkaWF0byAoc2UgdXNhIGFsIGNlcnJhciBzZXNpXHUwMEYzbiBvIGFsIHNhbGlyIGRlIGxhIHBlc3RhXHUwMEYxYSlcbiAgICBhc3luYyBmbHVzaCgpIHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuX3B1c2hUaW1lcik7XG4gICAgICAgIGF3YWl0IHRoaXMuX3B1c2hEaXJ0eSgpO1xuICAgIH0sXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PSBDQVJHQSBJTklDSUFMIEFMIElOSUNJQVIgU0VTSVx1MDBEM04gPT09PT09PT09PT09PT09PT1cblxuICAgIGFzeW5jIF9wdWxsUmVtb3RlKHVpZCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgc25hcCA9IGF3YWl0IF9kYi5jb2xsZWN0aW9uKFBMQVlFUlNfQ09MTEVDVElPTikuZG9jKHVpZCkuZ2V0KCk7XG4gICAgICAgICAgICBpZiAoIXNuYXAuZXhpc3RzKSByZXR1cm47IC8vIHVzdWFyaW8gbnVldm8gZW4gRmlyZXN0b3JlOiBzZSBxdWVkYSBjb24gbG8gcXVlIHlhIHRlblx1MDBFRGEgbG9jYWwgKG8gZGVmYXVsdClcbiAgICAgICAgICAgIGNvbnN0IGRhdGEgPSBzbmFwLmRhdGEoKTtcbiAgICAgICAgICAgIGNvbnN0IGNoYW5nZWRLZXlzID0gW107XG4gICAgICAgICAgICBPYmplY3Qua2V5cyhkYXRhKS5mb3JFYWNoKGsgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChrID09PSAnX3VwZGF0ZWRBdCcpIHJldHVybjtcbiAgICAgICAgICAgICAgICB0aGlzLl9jYWNoZVtrXSA9IGRhdGFba107XG4gICAgICAgICAgICAgICAgdHJ5IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oX0xPQ0FMX1BSRUZJWCArIGssIEpTT04uc3RyaW5naWZ5KGRhdGFba10pKTsgfSBjYXRjaCAoZSkge31cbiAgICAgICAgICAgICAgICBjaGFuZ2VkS2V5cy5wdXNoKGspO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBpZiAoY2hhbmdlZEtleXMubGVuZ3RoKSB0aGlzLl9ub3RpZnlSZW1vdGUoY2hhbmdlZEtleXMpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oJ1tGaXJlYmFzZVNhdmVTeXN0ZW1dIE5vIHNlIHB1ZG8gZGVzY2FyZ2FyIGVsIHByb2dyZXNvIGRlIGxhIG51YmUsIHNlIHNpZ3VlIGNvbiBsYSBjYWNoXHUwMEU5IGxvY2FsOicsIGUuY29kZSB8fCBlKTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PSBCT1JSQURPIFRPVEFMIERFIFBST0dSRVNPIChudWV2bykgPT09PT09PT09PT09PT09PT1cbiAgICAvLyBCb3JyYSBsb2NhbFN0b3JhZ2UgKyBjYWNoXHUwMEU5IGVuIG1lbW9yaWEgKyBlbCBkb2N1bWVudG8gZW4gRmlyZXN0b3JlIChzaSBoYXlcbiAgICAvLyBzZXNpXHUwMEYzbikuIE5PIHRvY2EgbGEgc2VzaVx1MDBGM24gZGUgYXV0aCBuaSBsYXMgcHJlZmVyZW5jaWFzIGRlIGdyXHUwMEUxZmljb3Mvdm9sdW1lblxuICAgIC8vIChlc2FzIHZpdmVuIGFwYXJ0ZSwgZW4gU2V0dGluZ3MgZGUgdWkuanMpLlxuICAgIGFzeW5jIGNsZWFyUHJvZ3Jlc3MoKSB7XG4gICAgICAgIGNvbnN0IGtleXMgPSBbJ3Byb2ZpbGUnLCAncHJvZ3Jlc3Npb24nLCAnYWNodl9zdGF0cycsICdhY2h2X3N0YXRlJ107XG4gICAgICAgIGtleXMuZm9yRWFjaChrID0+IHtcbiAgICAgICAgICAgIGRlbGV0ZSB0aGlzLl9jYWNoZVtrXTtcbiAgICAgICAgICAgIHRoaXMuX2RpcnR5LmRlbGV0ZShrKTtcbiAgICAgICAgICAgIHRyeSB7IGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKF9MT0NBTF9QUkVGSVggKyBrKTsgfSBjYXRjaCAoZSkge31cbiAgICAgICAgfSk7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aGlzLl9wdXNoVGltZXIpO1xuICAgICAgICBpZiAodGhpcy5fdWlkKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIC8vIHNldCBjb24gbWVyZ2U6ZmFsc2UgcmVlbXBsYXphIGVsIGRvY3VtZW50byBlbnRlcm8gcG9yIHVubyB2YWNcdTAwRURvLFxuICAgICAgICAgICAgICAgIC8vIGJvcnJhbmRvIGN1YWxxdWllciBjYW1wbyB2aWVqbyBxdWUgaHViaWVyYSBlbiBsYSBudWJlLlxuICAgICAgICAgICAgICAgIGF3YWl0IF9kYi5jb2xsZWN0aW9uKFBMQVlFUlNfQ09MTEVDVElPTikuZG9jKHRoaXMuX3VpZCkuc2V0KHt9LCB7IG1lcmdlOiBmYWxzZSB9KTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4oJ1tGaXJlYmFzZVNhdmVTeXN0ZW1dIE5vIHNlIHB1ZG8gYm9ycmFyIGVsIHByb2dyZXNvIGVuIGxhIG51YmU6JywgZS5jb2RlIHx8IGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIC8vID09PT09PT09PT09PT09PT09IEFVVEVOVElDQUNJXHUwMEQzTiA9PT09PT09PT09PT09PT09PVxuXG4gICAgYXN5bmMgc2lnbkluV2l0aEdvb2dsZSgpIHtcbiAgICAgICAgY29uc3QgcHJvdmlkZXIgPSBuZXcgZmlyZWJhc2UuYXV0aC5Hb29nbGVBdXRoUHJvdmlkZXIoKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IF9hdXRoLnNpZ25JbldpdGhQb3B1cChwcm92aWRlcik7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGNvbnNvbGUud2FybignW0ZpcmViYXNlU2F2ZVN5c3RlbV0gTG9naW4gY29uIEdvb2dsZSBmYWxsXHUwMEYzOicsIGUuY29kZSB8fCBlKTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICBhc3luYyBzaWduT3V0KCkge1xuICAgICAgICBhd2FpdCB0aGlzLmZsdXNoKCk7XG4gICAgICAgIHRyeSB7IGF3YWl0IF9hdXRoLnNpZ25PdXQoKTsgfSBjYXRjaCAoZSkgeyBjb25zb2xlLndhcm4oJ1tGaXJlYmFzZVNhdmVTeXN0ZW1dIEVycm9yIGFsIGNlcnJhciBzZXNpXHUwMEYzbjonLCBlKTsgfVxuICAgIH0sXG5cbiAgICBnZXQgY3VycmVudFVzZXIoKSB7IHJldHVybiBfYXV0aC5jdXJyZW50VXNlcjsgfSxcblxuICAgIC8vID09PT09PT09PT09PT09PT09IFJBTktJTkdTIE9OTElORSAocHJlcGFyYWRvIHBhcmEgZWwgZnV0dXJvLCBubyBzZSB1c2EgYVx1MDBGQW4pID09PT09PT09PT09PT09PT09XG4gICAgLy8gRG9jdW1lbnRvIGxpdmlhbm8geSBmXHUwMEUxY2lsIGRlIGluZGV4YXIvb3JkZW5hciBlbiBGaXJlc3RvcmUgKG5pdmVsLCBtZWpvciBvbGVhZGEsIG5vbWJyZSksXG4gICAgLy8gc2VwYXJhZG8gZGVsIGRvY3VtZW50byBncmFuZGUgZGUgcHJvZ3Jlc28gKHBsYXllcnMve3VpZH0pIHBhcmEgbm8gdGVuZXIgcXVlIGxlZXIgdG9kb1xuICAgIC8vIGVsIHBlcmZpbCBkZSBjYWRhIGp1Z2Fkb3Igc29sbyBwYXJhIGFybWFyIHVuYSB0YWJsYSBkZSBwb3NpY2lvbmVzLlxuICAgIGFzeW5jIHB1c2hMZWFkZXJib2FyZEVudHJ5KGZpZWxkcykge1xuICAgICAgICBpZiAoIXRoaXMuX3VpZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgX2RiLmNvbGxlY3Rpb24oTEVBREVSQk9BUkRfQ09MTEVDVElPTikuZG9jKHRoaXMuX3VpZCkuc2V0KHtcbiAgICAgICAgICAgICAgICAuLi5maWVsZHMsXG4gICAgICAgICAgICAgICAgdXBkYXRlZEF0OiBmaXJlYmFzZS5maXJlc3RvcmUuRmllbGRWYWx1ZS5zZXJ2ZXJUaW1lc3RhbXAoKVxuICAgICAgICAgICAgfSwgeyBtZXJnZTogdHJ1ZSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKCdbRmlyZWJhc2VTYXZlU3lzdGVtXSBObyBzZSBwdWRvIGFjdHVhbGl6YXIgZWwgbGVhZGVyYm9hcmQgKG5vIGNyXHUwMEVEdGljbyk6JywgZS5jb2RlIHx8IGUpO1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIGluaXQoKSB7XG4gICAgICAgIHRoaXMucmVhZHkgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHsgdGhpcy5fcmVhZHlSZXNvbHZlID0gcmVzb2x2ZTsgfSk7XG4gICAgICAgIGxldCBmaXJzdENoZWNrID0gdHJ1ZTtcbiAgICAgICAgX2F1dGgub25BdXRoU3RhdGVDaGFuZ2VkKGFzeW5jIHVzZXIgPT4ge1xuICAgICAgICAgICAgdGhpcy5fdWlkID0gdXNlciA/IHVzZXIudWlkIDogbnVsbDtcbiAgICAgICAgICAgIGlmICh1c2VyKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHVsbFJlbW90ZSh1c2VyLnVpZCk7XG4gICAgICAgICAgICAgICAgZG9jdW1lbnQuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ3NhdmVzeXN0ZW06bG9naW4nLCB7IGRldGFpbDogeyB1aWQ6IHVzZXIudWlkLCB1c2VyIH0gfSkpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBkb2N1bWVudC5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudCgnc2F2ZXN5c3RlbTpsb2dvdXQnKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoZmlyc3RDaGVjaykgeyBmaXJzdENoZWNrID0gZmFsc2U7IHRoaXMuX3JlYWR5UmVzb2x2ZSgpOyB9XG4gICAgICAgIH0pO1xuICAgICAgICAvLyBcdTAwREFsdGltbyBpbnRlbnRvIGRlIGd1YXJkYXIgYW50ZXMgZGUgY2VycmFyL3JlY2FyZ2FyIGxhIHBlc3RhXHUwMEYxYVxuICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignYmVmb3JldW5sb2FkJywgKCkgPT4geyB0aGlzLl9wdXNoRGlydHkoKTsgfSk7XG4gICAgfVxufTtcblxuU2F2ZVN5c3RlbS5pbml0KCk7XG5cbi8vIyBzb3VyY2VVUkw9RmlyZWJhc2VTYXZlU3lzdGVtLmpzXG5cbi8qID09PT09PT09PT09PT09PT09IG1haW4uanMgPT09PT09PT09PT09PT09PT0gKi9cbmNvbnN0IGNhbnZhcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnYW1lQ2FudmFzJyk7XG5jb25zdCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dCgnMmQnKTtcbmNhbnZhcy53aWR0aCA9IHdpbmRvdy5pbm5lcldpZHRoO1xuY2FudmFzLmhlaWdodCA9IHdpbmRvdy5pbm5lckhlaWdodDtcbmNvbnN0IE1BUF9TSVpFID0gNDAwMDtcbmNvbnN0IExPV19FTkVNWV9USFJFU0hPTEQgPSAyMDtcblxuY29uc3QgZ2FtZSA9IHtcbiAgICBwbGF5ZXI6IG51bGwsXG4gICAgZW5lbWllczogW10sIHByb3BzOiBbXSwgZmxvYXRpbmdUZXh0czogW10sXG4gICAgLy8gT2JqZWN0IFBvb2xzXG4gICAgcGFydGljbGVzOiBbXSwgY2FzaW5nczogW10sIHByb2plY3RpbGVzOiBbXSwgdHJhaWxzOiBbXSxcbiAgICBjYW1lcmE6IG51bGwsXG4gICAgd2F2ZTogMSwgaXNXYXZlQWN0aXZlOiBmYWxzZSwgcGF1c2VkOiBmYWxzZSxcbiAgICBzdGFydGVkOiBmYWxzZSwgc2hhZG93c0VuYWJsZWQ6IHRydWUsIGZ4RW5hYmxlZDogdHJ1ZSxcbiAgICBrZXlzOiB7fSwgbW91c2U6IHsgeDogMCwgeTogMCwgZG93bjogZmFsc2UgfSxcbiAgICBsYXN0U2hvdDogMCwgcGFydGljbGVTY2FsZTogMSwgbG93RW5lbXlNb2RlOiBmYWxzZSxcbiAgICBfaW5wdXRCb3VuZDogZmFsc2UsXG5cbiAgICBpbml0KCkge1xuICAgICAgICAvLyBSZXNldCBjb21wbGV0bzogaW5pdCgpIGFob3JhIHB1ZWRlIGxsYW1hcnNlIG1cdTAwRTFzIGRlIHVuYSB2ZXogZW4gbGEgbWlzbWFcbiAgICAgICAgLy8gc2VzaVx1MDBGM24gZGUgcFx1MDBFMWdpbmEgKEp1Z2FyIGRlIE51ZXZvIC8gVm9sdmVyIGFsIE1lblx1MDBGQSB5IHZvbHZlciBhIGp1Z2FyKSwgYXNcdTAwRURcbiAgICAgICAgLy8gcXVlIGhheSBxdWUgdmFjaWFyIHRvZG8gbG8gcXVlIGFudGVzIHNvbG8gc2UgbGxlbmFiYSB1bmEgdmV6LlxuICAgICAgICB0aGlzLmVuZW1pZXMgPSBbXTsgdGhpcy5wcm9wcyA9IFtdOyB0aGlzLmZsb2F0aW5nVGV4dHMgPSBbXTtcbiAgICAgICAgdGhpcy5wYXJ0aWNsZXMgPSBbXTsgdGhpcy5jYXNpbmdzID0gW107IHRoaXMucHJvamVjdGlsZXMgPSBbXTsgdGhpcy50cmFpbHMgPSBbXTtcbiAgICAgICAgdGhpcy53YXZlID0gMTsgdGhpcy5pc1dhdmVBY3RpdmUgPSBmYWxzZTsgdGhpcy5wYXVzZWQgPSBmYWxzZTtcbiAgICAgICAgaWYgKHR5cGVvZiBFdmVudE1hbmFnZXIgIT09ICd1bmRlZmluZWQnKSBFdmVudE1hbmFnZXIuZGVhY3RpdmF0ZSgpO1xuXG4gICAgICAgIHRoaXMuc3RhcnRlZCA9IHRydWU7XG4gICAgICAgIHRoaXMucGxheWVyID0gbmV3IFBsYXllcigpO1xuICAgICAgICB0aGlzLmNhbWVyYSA9IG5ldyBDYW1lcmEoKTtcbiAgICAgICAgY29uc3QgZ2Z4ID0gR1JBUEhJQ1NfUFJFU0VUU1tTZXR0aW5ncy5ncmFwaGljc10gfHwgR1JBUEhJQ1NfUFJFU0VUUy5QUk87XG4gICAgICAgIHRoaXMuc2hhZG93c0VuYWJsZWQgPSBnZnguc2hhZG93cztcbiAgICAgICAgLy8gQmFuZGVyYSBnbG9iYWwgXHUwMEZBbmljYSBwYXJhIGVsIHJlc3RvIGRlIGVmZWN0b3MgcXVlIG5vIHBhc2FuIHBvciB1biBPYmplY3QgUG9vbFxuICAgICAgICAvLyAoY2FtZXJhIHNoYWtlLCBkZXN0ZWxsbyBkZSBib2NhLCBwYXJ0XHUwMEVEY3VsYXMgZGUgY2xpbWEsIHRpbnRlIGFtYmllbnRhbCkuIEVsXG4gICAgICAgIC8vIHByZXNldCBVTFRSQSBlcyBlbCBcdTAwRkFuaWNvIHF1ZSBsYSBhcGFnYTsgdmVyIEdSQVBISUNTX1BSRVNFVFMgZW4gdWkuanMuXG4gICAgICAgIHRoaXMuZnhFbmFibGVkID0gIWdmeC51bHRyYTtcblxuICAgICAgICAvLyBQcmUtYWxvY2FyIGFycmF5cyBwYXJhIE9iamVjdCBQb29saW5nIChlbCB0YW1hXHUwMEYxbyBkZXBlbmRlIGRlbCBwcmVzZXQgZ3JcdTAwRTFmaWNvIGVsZWdpZG8pXG4gICAgICAgIGZvcihsZXQgaT0wOyBpPGdmeC5wYXJ0aWNsZXM7IGkrKykgdGhpcy5wYXJ0aWNsZXMucHVzaChuZXcgUGFydGljbGUoKSk7XG4gICAgICAgIGZvcihsZXQgaT0wOyBpPGdmeC5jYXNpbmdzOyBpKyspIHRoaXMuY2FzaW5ncy5wdXNoKG5ldyBDYXNpbmcoKSk7XG4gICAgICAgIGZvcihsZXQgaT0wOyBpPGdmeC5wcm9qZWN0aWxlczsgaSsrKSB0aGlzLnByb2plY3RpbGVzLnB1c2gobmV3IFByb2plY3RpbGUoKSk7XG4gICAgICAgIGZvcihsZXQgaT0wOyBpPGdmeC50cmFpbHM7IGkrKykgdGhpcy50cmFpbHMucHVzaChuZXcgVHJhaWwoKSk7XG4gICAgICAgIHRoaXMucGFydGljbGVzLmZvckVhY2gocCA9PiBwLmFjdGl2ZSA9IGZhbHNlKTtcbiAgICAgICAgdGhpcy5jYXNpbmdzLmZvckVhY2goYyA9PiBjLmFjdGl2ZSA9IGZhbHNlKTtcbiAgICAgICAgdGhpcy5wcm9qZWN0aWxlcy5mb3JFYWNoKHAgPT4gcC5hY3RpdmUgPSBmYWxzZSk7XG4gICAgICAgIHRoaXMudHJhaWxzLmZvckVhY2godCA9PiB0LmFjdGl2ZSA9IGZhbHNlKTtcbiAgICAgICAgZm9yKGxldCBpPTA7IGk8NDA7IGkrKykgdGhpcy5mbG9hdGluZ1RleHRzLnB1c2gobmV3IEZsb2F0aW5nVGV4dCgpKTtcbiAgICAgICAgdGhpcy5mbG9hdGluZ1RleHRzLmZvckVhY2godCA9PiB0LmFjdGl2ZSA9IGZhbHNlKTtcblxuICAgICAgICAvLyBHZW5lcmFyIG1hcGEgcHJvY2VkdXJhbCBjb24gcHJvcHMgdmFyaWFkb3MgeSBiYWxhbmNlYWRvc1xuICAgICAgICBjb25zdCBwcm9wVHlwZXMgPSBbJ3JvY2snLCAncm9ja190YWxsJywgJ3JvY2tfc3BsaXQnLCAndHJlZScsICd0cmVlX3BpbmUnLCAndHJlZV9kZWFkJywgJ2NyYXRlJywgJ2J1c2gnLCAncGViYmxlcyddO1xuICAgICAgICBmb3IobGV0IGk9MDsgaTxnZngucHJvcHM7IGkrKykge1xuICAgICAgICAgICAgbGV0IHQgPSBwcm9wVHlwZXNbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogcHJvcFR5cGVzLmxlbmd0aCldO1xuICAgICAgICAgICAgLy8gTVx1MDBFMXMgZGVuc2lkYWQgZGUgcGFzdG8geSBhcmJ1c3RvcywgbWVub3Mgcm9jYXMgZ2lnYW50ZXNcbiAgICAgICAgICAgIGlmIChNYXRoLnJhbmRvbSgpID4gMC42ICYmIFsncm9ja190YWxsJywgJ3RyZWUnLCAndHJlZV9waW5lJ10uaW5jbHVkZXModCkpIGNvbnRpbnVlOyBcbiAgICAgICAgICAgIHRoaXMucHJvcHMucHVzaChuZXcgUHJvcCh0KSk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gT3JkZW5hciBwcm9wcyBwYXJhIHJlbmRlcml6YXIgcHJpbWVybyBsb3MgZGUgc3VlbG8geSBsdWVnbyBsb3MgYWx0b3MgKFotc29ydGluZyBlc3RcdTAwRTF0aWNvKVxuICAgICAgICB0aGlzLnByb3BzLnNvcnQoKGEsYikgPT4gKGEuaXNTb2xpZCA/IDEgOiAwKSAtIChiLmlzU29saWQgPyAxIDogMCkpO1xuICAgICAgICB0aGlzLmJ1aWxkUHJvcEdyaWQoKTtcbiAgICAgICAgdGhpcy5zdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuXG4gICAgICAgIGlmICghdGhpcy5faW5wdXRCb3VuZCkge1xuICAgICAgICAgICAgdGhpcy5faW5wdXRCb3VuZCA9IHRydWU7XG4gICAgICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIGUgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMua2V5c1tlLmNvZGVdID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBpZihlLmtleSA+PSAxICYmIGUua2V5IDw9IDUpIHRoaXMucGxheWVyLmFjdGl2ZVNsb3QgPSBlLmtleSAtIDE7XG4gICAgICAgICAgICAgICAgaWYoZS5jb2RlID09PSAnS2V5UicpIHRoaXMucmVsb2FkKCk7XG4gICAgICAgICAgICAgICAgaWYoZS5jb2RlID09PSAnU3BhY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTsgLy8gZXZpdGEgcXVlIGxhIHBcdTAwRTFnaW5hIHNjcm9sbGVlIGNvbiBsYSBiYXJyYSBlc3BhY2lhZG9yYVxuICAgICAgICAgICAgICAgICAgICBpZighdGhpcy5wYXVzZWQpIHRoaXMucGxheWVyLmRhc2goKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYoZS5jb2RlID09PSAnRXNjYXBlJykgdGhpcy50b2dnbGVFc2NNZW51KCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdrZXl1cCcsIGUgPT4gdGhpcy5rZXlzW2UuY29kZV0gPSBmYWxzZSk7XG4gICAgICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgZSA9PiB7IHRoaXMubW91c2UueCA9IGUuY2xpZW50WDsgdGhpcy5tb3VzZS55ID0gZS5jbGllbnRZOyB9KTtcbiAgICAgICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWRvd24nLCAoKSA9PiB0aGlzLm1vdXNlLmRvd24gPSB0cnVlKTtcbiAgICAgICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdtb3VzZXVwJywgKCkgPT4gdGhpcy5tb3VzZS5kb3duID0gZmFsc2UpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5zdGFydE5leHRXYXZlKCk7XG4gICAgfSxcblxuICAgIC8vIFNpc3RlbWEgZGUgQ29saXNpb25lcyBGXHUwMEVEc2ljYXMgQ2lyY3VsYXJlcyBjb250cmEgZWwgZW50b3Jub1xuICAgIHJlc29sdmVDb2xsaXNpb24oZW50aXR5LCBwcm9wKSB7XG4gICAgICAgIGxldCBkeCA9IGVudGl0eS54IC0gcHJvcC54O1xuICAgICAgICBsZXQgZHkgPSBlbnRpdHkueSAtIHByb3AueTtcbiAgICAgICAgbGV0IGRpc3QgPSBNYXRoLmh5cG90KGR4LCBkeSk7XG4gICAgICAgIGxldCBtaW4gPSBlbnRpdHkucmFkaXVzICsgcHJvcC5yYWRpdXM7XG4gICAgICAgIGlmKGRpc3QgPCBtaW4gJiYgZGlzdCA+IDApIHtcbiAgICAgICAgICAgIGxldCBmb3JjZSA9IChtaW4gLSBkaXN0KSAvIGRpc3QgKiAodGhpcy5rbm9ja2JhY2tNdWx0IHx8IDEpO1xuICAgICAgICAgICAgZW50aXR5LnggKz0gZHggKiBmb3JjZTtcbiAgICAgICAgICAgIGVudGl0eS55ICs9IGR5ICogZm9yY2U7XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgbG9vcCgpIHtcbiAgICAgICAgLy8gTWllbnRyYXMgbm8gaGF5YSBwYXJ0aWRhIGFjdGl2YSAobWVuXHUwMEZBLCBsb2dpbiwgZXRjLikgZWwgbG9vcCBubyBkaWJ1amEgbmlcbiAgICAgICAgLy8gYWN0dWFsaXphIG5hZGEgXHUyMDE0IHNvbG8gc2UgcmVwcm9ncmFtYS4gRXN0byBwZXJtaXRlIHF1ZSBleGlzdGEgVU4gU09MTyBsb29wXG4gICAgICAgIC8vIGFycmFuY2FkbyB1bmEgc29sYSB2ZXogYWwgY2FyZ2FyIGxhIHBcdTAwRTFnaW5hICh2ZXIgZWwgZmluYWwgZGUgZXN0ZSBhcmNoaXZvKSxcbiAgICAgICAgLy8gZW4gdmV6IGRlIGFycmFuY2FyIHVubyBudWV2byBjYWRhIHZleiBxdWUgc2UgbGxhbWEgYSBpbml0KCkuXG4gICAgICAgIGlmICghdGhpcy5zdGFydGVkIHx8ICF0aGlzLnBsYXllciB8fCAhdGhpcy5jYW1lcmEpIHtcbiAgICAgICAgICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB0aGlzLmxvb3AoKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmNhbWVyYS5mb2xsb3codGhpcy5wbGF5ZXIpO1xuICAgICAgICAvLyBUaWVtcG8gTGVudG86IHNpIGVsIGV2ZW50byBlc3RcdTAwRTEgYWN0aXZvLCBzb2xvIGxhIG1pdGFkIGRlIGxvcyBmcmFtZXMgZWplY3V0YW4gbFx1MDBGM2dpY2EgZGUganVlZ29cbiAgICAgICAgdGhpcy5fc2xvd1RvZ2dsZSA9ICF0aGlzLl9zbG93VG9nZ2xlO1xuICAgICAgICBjb25zdCBkb1N0ZXAgPSB0aGlzLmFjdGl2ZUV2ZW50ICE9PSAnU0xPV19USU1FJyB8fCB0aGlzLl9zbG93VG9nZ2xlO1xuXG4gICAgICAgIC8vIERpc3RhbmNpYSBqdWdhZG9yLWVuZW1pZ28gY2FjaGVhZGEgdW5hIHNvbGEgdmV6IHBvciBmcmFtZSAobGEgcmV1dGlsaXphbiBsYSBmXHUwMEVEc2ljYSxcbiAgICAgICAgLy8gZWwgZnJhbWUtc2tpcHBpbmcvc3VlXHUwMEYxbyBkZSBJQSBkZSBtXHUwMEUxcyBhYmFqbyB5IEVuZW15LnVwZGF0ZSwgZW4gdmV6IGRlIHJlY2FsY3VsYXJsYSBjYWRhIHVubylcbiAgICAgICAgdGhpcy5fZnJhbWVDb3VudCA9ICh0aGlzLl9mcmFtZUNvdW50IHx8IDApICsgMTtcbiAgICAgICAgZm9yKGxldCBpPTA7IGk8dGhpcy5lbmVtaWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICB0aGlzLmVuZW1pZXNbaV0uX2Rpc3QgPSBNYXRoLmh5cG90KHRoaXMuZW5lbWllc1tpXS54IC0gdGhpcy5wbGF5ZXIueCwgdGhpcy5lbmVtaWVzW2ldLnkgLSB0aGlzLnBsYXllci55KTtcbiAgICAgICAgfVxuICAgICAgICAvLyBFc2NhbGEgZ2xvYmFsIGRlIHBhcnRcdTAwRURjdWxhczogYmFqYSBhdXRvbVx1MDBFMXRpY2FtZW50ZSBjb24gbXVjaGFzIGVudGlkYWRlcyBhY3RpdmFzIHBhcmEgc29zdGVuZXIgZWwgZnJhbWVyYXRlXG4gICAgICAgIHRoaXMucGFydGljbGVTY2FsZSA9IHRoaXMuZW5lbWllcy5sZW5ndGggPiAxNTAgPyAwLjM1IDogKHRoaXMuZW5lbWllcy5sZW5ndGggPiA4MCA/IDAuNiA6IDEpO1xuICAgICAgICAvLyBNb2RvIFwiY2FjZXJcdTAwRURhIGZpbmFsXCI6IHF1ZWRhbiBwb2NvcyBlbmVtaWdvcywgc2UgZGVzYWN0aXZhIGVsIHN1ZVx1MDBGMW8gZGUgSUEgeSBlbFxuLy8gZnJhbWUtc2tpcHBpbmcgcGFyYSBxdWUgbmluZ3VubyBxdWVkZSBpZ25vcmFuZG8gYWwganVnYWRvciBsZWpvcyBkZWwgbWFwYS5cblx0dGhpcy5sb3dFbmVteU1vZGUgPSB0aGlzLmVuZW1pZXMubGVuZ3RoID4gMCAmJiB0aGlzLmVuZW1pZXMubGVuZ3RoIDwgTE9XX0VORU1ZX1RIUkVTSE9MRDtcblxuICAgICAgICAvLyBUZXJyZW5vIFByb2NlZHVyYWwgT3B0aW1pemFkb1xuICAgICAgICBjdHguZmlsbFN0eWxlID0gdGVycmFpblBhdHRlcm47XG4gICAgICAgIGN0eC5zYXZlKCk7XG4gICAgICAgIGN0eC50cmFuc2xhdGUoLXRoaXMuY2FtZXJhLnggJSA1MTIsIC10aGlzLmNhbWVyYS55ICUgNTEyKTtcbiAgICAgICAgY3R4LmZpbGxSZWN0KC01MTIsIC01MTIsIGNhbnZhcy53aWR0aCArIDEwMjQsIGNhbnZhcy5oZWlnaHQgKyAxMDI0KTtcbiAgICAgICAgY3R4LnJlc3RvcmUoKTtcblxuICAgICAgICAvLyBVcGRhdGUgJiBDdWxsaW5nIFByb3BzIChTb21icmFzIHkgZGlidWphZG8pXG4gICAgICAgIGlmICh0aGlzLnNoYWRvd3NFbmFibGVkKSB0aGlzLnByb3BzLmZvckVhY2gocCA9PiBwLmRyYXdTaGFkb3codGhpcy5jYW1lcmEpKTtcblxuICAgICAgICAvLyBGXHUwMEVEc2ljYSBBbWJpZW50YWwgKHVzYW5kbyBncmlkIGVzcGFjaWFsOiB5YSBubyByZWNvcnJlIFRPRE9TIGxvcyBwcm9wcylcbiAgICAgICAgY29uc3QgbmVhcmJ5UGxheWVyUHJvcHMgPSB0aGlzLmdldE5lYXJieVByb3BzKHRoaXMucGxheWVyLngsIHRoaXMucGxheWVyLnkpO1xuICAgICAgICBuZWFyYnlQbGF5ZXJQcm9wcy5mb3JFYWNoKHAgPT4gdGhpcy5yZXNvbHZlQ29sbGlzaW9uKHRoaXMucGxheWVyLCBwKSk7XG4gICAgICAgIHRoaXMuZW5lbWllcy5mb3JFYWNoKGUgPT4ge1xuICAgICAgICAgICAgaWYgKGUuX2Rpc3QgPiAxNTAwKSByZXR1cm47IC8vIElBIGRvcm1pZGE6IGZ1ZXJhIGRlIHJhbmdvLCBubyBuZWNlc2l0YSBmXHUwMEVEc2ljYSBkZSBwcm9wc1xuICAgICAgICAgICAgY29uc3QgbmVhcmJ5RW5lbXlQcm9wcyA9IHRoaXMuZ2V0TmVhcmJ5UHJvcHMoZS54LCBlLnkpO1xuICAgICAgICAgICAgbmVhcmJ5RW5lbXlQcm9wcy5mb3JFYWNoKHAgPT4ge1xuICAgICAgICAgICAgICAgIGlmKE1hdGguaHlwb3QoZS54IC0gcC54LCBlLnkgLSBwLnkpIDwgcC5yYWRpdXMgKyBlLnJhZGl1cyArIDUwKSB0aGlzLnJlc29sdmVDb2xsaXNpb24oZSwgcCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gSW5wdXQgJiBQbGF5ZXIgVXBkYXRlXG4gICAgICAgIGlmKCF0aGlzLnBhdXNlZCkge1xuICAgICAgICAgICAgaWYgKGRvU3RlcCkgeyB0aGlzLnBsYXllci51cGRhdGUodGhpcy5rZXlzKTsgaWYodGhpcy5tb3VzZS5kb3duKSB0aGlzLnNob290KCk7IH1cbiAgICAgICAgICAgIEV2ZW50TWFuYWdlci51cGRhdGUoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFJhc3RybyBWaXNjb3NvXG4gICAgICAgIHRoaXMudHJhaWxzLmZvckVhY2godCA9PiB7IGlmKHQuYWN0aXZlKSB7IHQudXBkYXRlKCk7IHQuZHJhdyh0aGlzLmNhbWVyYSk7IH0gfSk7XG5cbiAgICAgICAgLy8gRGlidWpvIGRlIHByb3BzIChvcmRlbmFkb3MgWilcbiAgICAgICAgdGhpcy5wcm9wcy5mb3JFYWNoKHAgPT4gcC5kcmF3KHRoaXMuY2FtZXJhKSk7XG5cbiAgICAgICAgLy8gQ2FzcXVpbGxvc1xuICAgICAgICB0aGlzLmNhc2luZ3MuZm9yRWFjaChjID0+IHsgaWYoYy5hY3RpdmUpIHsgYy51cGRhdGUoKTsgYy5kcmF3KHRoaXMuY2FtZXJhKTsgfSB9KTtcblxuICAgICAgICAvLyBQcm95ZWN0aWxlcyBjb24gT2JqZWN0IFBvb2xpbmdcbiAgICAgICAgdGhpcy5wcm9qZWN0aWxlcy5mb3JFYWNoKHAgPT4ge1xuICAgICAgICAgICAgaWYoIXAuYWN0aXZlKSByZXR1cm47XG4gICAgICAgICAgICBpZiAoZG9TdGVwKSBwLnVwZGF0ZSgpO1xuICAgICAgICAgICAgcC5kcmF3KHRoaXMuY2FtZXJhKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gQ29saXNpb25lcyBQcm95ZWN0aWwgLSBQcm9wcyBTXHUwMEYzbGlkb3MgKGdyaWQgZXNwYWNpYWwpXG4gICAgICAgICAgICBsZXQgaGl0UHJvcCA9IGZhbHNlO1xuICAgICAgICAgICAgY29uc3QgbmVhcmJ5UHJvalByb3BzID0gdGhpcy5nZXROZWFyYnlQcm9wcyhwLngsIHAueSk7XG4gICAgICAgICAgICBmb3IobGV0IGs9MDsgazxuZWFyYnlQcm9qUHJvcHMubGVuZ3RoOyBrKyspIHtcbiAgICAgICAgICAgICAgICBsZXQgcHIgPSBuZWFyYnlQcm9qUHJvcHNba107XG4gICAgICAgICAgICAgICAgaWYoTWF0aC5oeXBvdChwLnggLSBwci54LCBwLnkgLSBwci55KSA8IHByLnJhZGl1cyArIHAucmFkaXVzKSB7XG4gICAgICAgICAgICAgICAgICAgIHAuYWN0aXZlID0gZmFsc2U7IGhpdFByb3AgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAvLyBDaGlzcGFzIGFsIGNob2NhciBjb24gdGVycmVub1xuICAgICAgICAgICAgICAgICAgICBmb3IobGV0IGk9MDsgaTxNYXRoLmNlaWwoMyp0aGlzLnBhcnRpY2xlU2NhbGUpOyBpKyspIHRoaXMuc3Bhd25QYXJ0aWNsZShwLngsIHAueSwgJyM5NWE1YTYnLCAyLCAyLCAnbm9ybWFsJyk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmKGhpdFByb3ApIHJldHVybjtcblxuICAgICAgICAgICAgaWYocC5pc0VuZW15KSB7XG4gICAgICAgICAgICAgICAgaWYoTWF0aC5oeXBvdChwLnggLSB0aGlzLnBsYXllci54LCBwLnkgLSB0aGlzLnBsYXllci55KSA8IHRoaXMucGxheWVyLnJhZGl1cykge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnBsYXllci50YWtlRGFtYWdlKHAuZGFtYWdlKTsgcC5hY3RpdmUgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGZvcihsZXQgaiA9IHRoaXMuZW5lbWllcy5sZW5ndGggLSAxOyBqID49IDA7IGotLSkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgZSA9IHRoaXMuZW5lbWllc1tqXTtcbiAgICAgICAgICAgICAgICAgICAgaWYoIWUuaW52dWxuZXJhYmxlICYmICFwLmhpdEVuZW1pZXMuaGFzKGUpICYmIE1hdGguaHlwb3QocC54IC0gZS54LCBwLnkgLSBlLnkpIDwgZS5yYWRpdXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuaGl0RW5lbXkoZSwgcC5kYW1hZ2UsIHsgcGxheWVyU2hvdDogdHJ1ZSB9KTsgLy8gbGEgbFx1MDBGM2dpY2EgZGUgbXVlcnRlL3JlY29tcGVuc2Egdml2ZSBhY1x1MDBFMSBhaG9yYVxuICAgICAgICAgICAgICAgICAgICAgICAgcC5oaXRFbmVtaWVzLmFkZChlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChwLmtub2NrYmFjaykgeyAvLyBTaG90Z3VuOiBlbXB1amEgYWwgZW5lbWlnbyBsZWpvcyBkZWwgaW1wYWN0b1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBrYSA9IE1hdGguYXRhbjIoZS55IC0gcC55LCBlLnggLSBwLngpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGUueCArPSBNYXRoLmNvcyhrYSkgKiBwLmtub2NrYmFjayAqIDAuMDY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZS55ICs9IE1hdGguc2luKGthKSAqIHAua25vY2tiYWNrICogMC4wNjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChwLmJ1cm4pIHsgZS5idXJuVGlja3MgPSAxODA7IGUuYnVybkRtZyA9IDM7IH0gLy8gTGFuemFsbGFtYXM6IGFwbGljYSBxdWVtYWR1cmEgfjNzXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAocC5leHBsb3NpdmUpIHsgdGhpcy5leHBsb2RlKHAueCwgcC55LCBwLmV4cGxvc2lvblJhZGl1cywgcC5kYW1hZ2UpOyB9IC8vIFJQR1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHAuZXhwbG9zaXZlIHx8IHAucGllcmNlIDw9IDApIHsgcC5hY3RpdmUgPSBmYWxzZTsgfSBlbHNlIHsgcC5waWVyY2UtLTsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEVuZW1pZ29zIHkgSnVnYWRvclxuICAgICAgICB0aGlzLmVuZW1pZXMuZm9yRWFjaCgoZSwgaSkgPT4ge1xuICAgICAgICAgICAgaWYoIXRoaXMucGF1c2VkICYmIGRvU3RlcCkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLmxvd0VuZW15TW9kZSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBDYWNlclx1MDBFRGEgZmluYWw6IHNpbiBzdWVcdTAwRjFvIGRlIElBIG5pIGZyYW1lLXNraXBwaW5nLCBwZXJzaWd1ZW4gZGVzZGUgY3VhbHF1aWVyIHB1bnRvIGRlbCBtYXBhXG4gICAgICAgICAgICAgICAgICAgIGUudXBkYXRlKHRoaXMucGxheWVyKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGUuX2Rpc3QgPiAxNTAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIElBIGRvcm1pZGE6IG11eSBsZWpvcyBkZWwganVnYWRvciwgbm8gZWplY3V0YSBsXHUwMEYzZ2ljYSBoYXN0YSBxdWUgdnVlbHZhIGEgYWNlcmNhcnNlXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChlLl9kaXN0ID4gNzAwICYmIGUudHlwZSAhPT0gJ0JPU1MnICYmICh0aGlzLl9mcmFtZUNvdW50ICsgaSkgJSAyID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIEZyYW1lIHNraXBwaW5nOiBlbmVtaWdvcyBhIG1lZGlhIGRpc3RhbmNpYSByZXBhcnRlbiBzdSB1cGRhdGUgZW50cmUgZnJhbWVzXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgZS51cGRhdGUodGhpcy5wbGF5ZXIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGUuZHJhdyh0aGlzLmNhbWVyYSk7XG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgLy8gUkVOREVSSVpBUiBBTCBKVUdBRE9SIChjclx1MDBFRHRpY28gLSBlc3RhYmEgZmFsdGFuZG8pXG4gICAgICAgIHRoaXMucGxheWVyLmRyYXcodGhpcy5jYW1lcmEsIHRoaXMubW91c2UpO1xuICAgICAgICBcbiAgICAgICAgLy8gUGFydFx1MDBFRGN1bGFzIHkgVGV4dG9zXG4gICAgICAgIHRoaXMucGFydGljbGVzLmZvckVhY2gocCA9PiB7IGlmKHAuYWN0aXZlKSB7IHAudXBkYXRlKCk7IHAuZHJhdyh0aGlzLmNhbWVyYSk7IH0gfSk7XG4gICAgICAgIHRoaXMuZmxvYXRpbmdUZXh0cy5mb3JFYWNoKHQgPT4geyBpZih0LmFjdGl2ZSkgeyB0LnVwZGF0ZSgpOyB0LmRyYXcodGhpcy5jYW1lcmEpOyB9IH0pO1xuXG4gICAgICAgIC8vIFRpbnRlIGFtYmllbnRhbCBhdGFyZGVjZXI6IHB1cmFtZW50ZSBjb3NtXHUwMEU5dGljbyAobm8gYXBvcnRhIGluZm9ybWFjaVx1MDBGM24gZGUganVlZ28pLFxuICAgICAgICAvLyBzZSBhcGFnYSBlbiBVTFRSQSBwYXJhIGFob3JyYXJzZSB1biBmaWxsUmVjdCBkZSBwYW50YWxsYSBjb21wbGV0YSBwb3IgZnJhbWUuXG4gICAgICAgIGlmICh0aGlzLmZ4RW5hYmxlZCkge1xuICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICdyZ2JhKDIzMCwgMTI2LCAzNCwgMC4wOCknO1xuICAgICAgICAgICAgY3R4LmZpbGxSZWN0KDAsIDAsIGNhbnZhcy53aWR0aCwgY2FudmFzLmhlaWdodCk7XG4gICAgICAgIH1cbiAgICAgICAgRXZlbnRNYW5hZ2VyLmRyYXdPdmVybGF5KCk7XG4gICAgICAgIC8vIFVJIFVwZGF0ZXNcbiAgICAgICAgY29uc3QgbW9iaWxlQ29udHJvbHMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbW9iaWxlLWNvbnRyb2xzJyk7XG4gICAgICAgIGlmKG1vYmlsZUNvbnRyb2xzKSBtb2JpbGVDb250cm9scy5zdHlsZS5wb2ludGVyRXZlbnRzID0gdGhpcy5wYXVzZWQgPyAnbm9uZScgOiAnYXV0byc7XG4gICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoZWFsdGgtaW5uZXInKS5zdHlsZS53aWR0aCA9ICh0aGlzLnBsYXllci5ocCAvIHRoaXMucGxheWVyLm1heEhwICogMTAwKSArIFwiJVwiO1xuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGVhbHRoLXRleHQnKS5pbm5lclRleHQgPSBgJHtNYXRoLmZsb29yKHRoaXMucGxheWVyLmhwKX0gLyAke3RoaXMucGxheWVyLm1heEhwfWA7XG4gICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtb25leS1kaXNwbGF5JykuaW5uZXJUZXh0ID0gXCJDQVNIOiAkXCIgKyB0aGlzLnBsYXllci5tb25leTtcbiAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3dhdmUtZGlzcGxheScpLmlubmVyVGV4dCA9IFwiV0FWRTogXCIgKyB0aGlzLndhdmU7XG4gICAgICAgIFxuICAgICAgICBsZXQgdyA9IHRoaXMucGxheWVyLndlYXBvbjtcbiAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FtbW8taHVkJykuaW5uZXJUZXh0ID0gdyA/ICh3LmFtbW8gPT09IEluZmluaXR5ID8gXCJcdTIyMUVcIiA6IHcuYW1tbykgOiBcIi0tXCI7XG4gICAgICAgIGlmKHRoaXMucGxheWVyLmlzUmVsb2FkaW5nKSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYW1tby1odWQnKS5pbm5lclRleHQgPSBcIlJFTE9BRFwiO1xuXG4gICAgICAgIGNvbnN0IGhvdGJhciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdob3RiYXInKTtcbiAgICAgICAgaWYoaG90YmFyLmNoaWxkcmVuLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgZm9yKGxldCBpPTA7IGk8NTsgaSsrKSBob3RiYXIuaW5uZXJIVE1MICs9IGA8ZGl2IGNsYXNzPVwic2xvdFwiIGlkPVwic2xvdC0ke2l9XCIgb25jbGljaz1cImdhbWUucGxheWVyLmFjdGl2ZVNsb3Q9JHtpfVwiPjxzcGFuIGNsYXNzPVwic2xvdC1rZXlcIj4ke2krMX08L3NwYW4+PHNwYW4gY2xhc3M9XCJuYW1lXCI+PC9zcGFuPjxzcGFuIGNsYXNzPVwic2xvdC1hbW1vXCI+PC9zcGFuPjwvZGl2PmA7XG4gICAgICAgIH1cbiAgICAgICAgZm9yKGxldCBpPTA7IGk8NTsgaSsrKSB7XG4gICAgICAgICAgICBsZXQgcyA9IHRoaXMucGxheWVyLmludmVudG9yeVtpXTtcbiAgICAgICAgICAgIGxldCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGBzbG90LSR7aX1gKTtcbiAgICAgICAgICAgIGVsLmNsYXNzTmFtZSA9IHRoaXMucGxheWVyLmFjdGl2ZVNsb3QgPT09IGkgPyBcInNsb3QgYWN0aXZlXCIgOiBcInNsb3RcIjtcbiAgICAgICAgICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJy5uYW1lJykuaW5uZXJUZXh0ID0gcyA/IHMubmFtZSA6IFwiXCI7XG4gICAgICAgICAgICBlbC5xdWVyeVNlbGVjdG9yKCcuc2xvdC1hbW1vJykuaW5uZXJUZXh0ID0gcyA/IChzLmFtbW8gPT09IEluZmluaXR5ID8gXCJcIiA6IHMuYW1tbykgOiBcIlwiO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYodGhpcy5pc1dhdmVBY3RpdmUgJiYgdGhpcy5lbmVtaWVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgdGhpcy5pc1dhdmVBY3RpdmUgPSBmYWxzZTsgdGhpcy53YXZlKys7XG4gICAgICAgICAgICB0aGlzLnBhdXNlZCA9IHRydWU7XG4gICAgICAgICAgICBFdmVudE1hbmFnZXIuZGVhY3RpdmF0ZSgpO1xuICAgICAgICAgICAgTXVzaWNNYW5hZ2VyLmR1Y2soKTtcbiAgICAgICAgICAgIHRoaXMudXBkYXRlU2hvcCgpO1xuICAgICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Nob3AtbWVudScpLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gICAgICAgIH1cblxuICAgICAgICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdGhpcy5sb29wKCkpO1xuICAgIH1cbn07XG5cbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdyZXNpemUnLCAoKSA9PiB7IGNhbnZhcy53aWR0aCA9IHdpbmRvdy5pbm5lcldpZHRoOyBjYW52YXMuaGVpZ2h0ID0gd2luZG93LmlubmVySGVpZ2h0OyB9KTtcblxuLy8gQXJyYW5jYSBlbCBcdTAwRkFuaWNvIGxvb3AgZGUgcmVuZGVyaXphZG8gZGVsIGp1ZWdvLiBHcmFjaWFzIGFsIGd1YXJkIGFncmVnYWRvIGFsXG4vLyBwcmluY2lwaW8gZGUgbG9vcCgpLCBlc3RvIG5vIGRpYnVqYSBuYWRhIGhhc3RhIHF1ZSBleGlzdGEgZ2FtZS5wbGF5ZXIgKG8gc2VhLFxuLy8gaGFzdGEgZWwgcHJpbWVyIGdhbWUuaW5pdCgpKSwgYXNcdTAwRUQgcXVlIGVzIHNlZ3VybyBsbGFtYXJsbyB5YSBtaXNtby5cbmdhbWUubG9vcCgpO1xuXG53aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignRE9NQ29udGVudExvYWRlZCcsICgpID0+IHtcbiAgICBjb25zdCBsb2JieVNjcmVlbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2JieS1zY3JlZW4nKTtcbiAgICBpZiAobG9iYnlTY3JlZW4pIHtcbiAgICAgICAgbG9iYnlTY3JlZW4uaW5uZXJIVE1MID0gYFxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cIm1lbnUtcGFuZWxcIj5cbiAgICAgICAgICAgICAgICA8aDEgY2xhc3M9XCJtZW51LXRpdGxlXCI+U0xJTUVGUk9OVDwvaDE+XG4gICAgICAgICAgICAgICAgPHAgY2xhc3M9XCJtZW51LXN1YnRpdGxlXCI+RW5oYW5jZWQgRWRpdGlvbjwvcD5cbiAgICAgICAgICAgICAgICA8ZGl2IGlkPVwiYXV0aC1ib3hcIiBjbGFzcz1cImF1dGgtYm94XCI+XG4gICAgICAgICAgICAgICAgICAgIDxzcGFuIGlkPVwiYXV0aC1zdGF0dXNcIiBjbGFzcz1cImh1ZC10ZXh0XCI+PC9zcGFuPlxuICAgICAgICAgICAgICAgICAgICA8YnV0dG9uIGlkPVwiYXV0aC1idG5cIiBjbGFzcz1cIm1lbnUtYnRuXCIgb25jbGljaz1cIkF1dGhVSS5oYW5kbGVDbGljaygpXCI+PC9idXR0b24+XG4gICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cIm1lbnUtYnRuIHByaW1hcnlcIiBvbmNsaWNrPVwiZ2FtZS5zdGFydEZyb21Mb2JieSgpXCI+XHUyNUI2IEpVR0FSPC9idXR0b24+XG4gICAgICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cIm1lbnUtYnRuXCIgb25jbGljaz1cImdhbWUub3BlblNldHRpbmdzKCdsb2JieScpXCI+XHUyNjk5IEFKVVNURVM8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwibWVudS1idG5cIiBvbmNsaWNrPVwiZ2FtZS50b2dnbGVDb250cm9scyh0cnVlKVwiPlx1RDgzRFx1RENENiBDT05UUk9MRVM8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwibWVudS1idG5cIiBvbmNsaWNrPVwiZ2FtZS5vcGVuQ3JlZGl0cygpXCI+XHVEODNDXHVERkFDIENSXHUwMEM5RElUT1M8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICA8ZGl2IHN0eWxlPVwibWFyZ2luLXRvcDoyMHB4OyBmb250LXNpemU6MThweDtcIj5cbiAgICAgICAgICAgICAgICAgICAgPGRpdj5SXHUwMEM5Q09SRDogJHtTZXR0aW5ncy5iZXN0V2F2ZX0gT0xFQURBUzwvZGl2PlxuICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwidmVyc2lvbi10YWdcIj52MC45PC9kaXY+XG4gICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgYDtcbiAgICAgICAgLy8gQXV0aFVJIChhdXRoLXVpLmpzKSBzZSBjYXJnYSBkZXNwdVx1MDBFOXMgcXVlIGVzdGUgc2NyaXB0IGFybWEgZWwgbG9iYnkgcG9yIHByaW1lcmFcbiAgICAgICAgLy8gdmV6LCBhc1x1MDBFRCBxdWUgZWwgYm90XHUwMEYzbiBuYWNlIHZhY1x1MDBFRG8geSBzZSByZWxsZW5hIHNvbG8gYXBlbmFzIEF1dGhVSSBleGlzdGEgKHN1XG4gICAgICAgIC8vIHByb3BpbyBsaXN0ZW5lciBkZSBET01Db250ZW50TG9hZGVkIGxsYW1hIGEgcmVmcmVzaCgpIGFsIHRlcm1pbmFyIGRlIGNhcmdhcikuXG4gICAgICAgIGlmICh0eXBlb2YgQXV0aFVJICE9PSAndW5kZWZpbmVkJykgQXV0aFVJLnJlZnJlc2goKTtcbiAgICB9XG5cbiAgICAvLyBBc2VnXHUwMEZBcmF0ZSBkZSBxdWUgZXN0ZSBwYW5lbCBleGlzdGEgZW4gdHUgSFRNTCAobyBjclx1MDBFOWFsbyBkaW5cdTAwRTFtaWNhbWVudGUpXG4gICAgY29uc3QgY29udHJvbHNQYW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb250cm9scy1wYW5lbCcpO1xuICAgIGlmIChjb250cm9sc1BhbmVsKSB7XG4gICAgICAgIGNvbnRyb2xzUGFuZWwuaW5uZXJIVE1MID0gYFxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cIm1lbnUtcGFuZWxcIj5cbiAgICAgICAgICAgICAgICA8aDIgY2xhc3M9XCJtZW51LXRpdGxlXCI+Q09OVFJPTEVTPC9oMj5cbiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwiY29udHJvbHMtbGlzdFwiPlxuICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwiY29udHJvbC1pdGVtXCI+PHNwYW4+V0FTRDwvc3Bhbj48c3BhbiBjbGFzcz1cImNvbnRyb2wta2V5XCI+TU9WRVI8L3NwYW4+PC9kaXY+XG4gICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJjb250cm9sLWl0ZW1cIj48c3Bhbj5NT1VTRTwvc3Bhbj48c3BhbiBjbGFzcz1cImNvbnRyb2wta2V5XCI+QVBVTlRBUjwvc3Bhbj48L2Rpdj5cbiAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cImNvbnRyb2wtaXRlbVwiPjxzcGFuPkNMSUNLPC9zcGFuPjxzcGFuIGNsYXNzPVwiY29udHJvbC1rZXlcIj5ESVNQQVJBUjwvc3Bhbj48L2Rpdj5cbiAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cImNvbnRyb2wtaXRlbVwiPjxzcGFuPlI8L3NwYW4+PHNwYW4gY2xhc3M9XCJjb250cm9sLWtleVwiPlJFQ0FSR0FSPC9zcGFuPjwvZGl2PlxuICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwiY29udHJvbC1pdGVtXCI+PHNwYW4+U0hJRlQ8L3NwYW4+PHNwYW4gY2xhc3M9XCJjb250cm9sLWtleVwiPlNQUklOVDwvc3Bhbj48L2Rpdj5cbiAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cImNvbnRyb2wtaXRlbVwiPjxzcGFuPkVTUEFDSU88L3NwYW4+PHNwYW4gY2xhc3M9XCJjb250cm9sLWtleVwiPkRBU0g8L3NwYW4+PC9kaXY+XG4gICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJjb250cm9sLWl0ZW1cIj48c3Bhbj5FU0M8L3NwYW4+PHNwYW4gY2xhc3M9XCJjb250cm9sLWtleVwiPlBBVVNBPC9zcGFuPjwvZGl2PlxuICAgICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICAgIDxidXR0b24gY2xhc3M9XCJtZW51LWJ0blwiIG9uY2xpY2s9XCJnYW1lLnRvZ2dsZUNvbnRyb2xzKGZhbHNlKVwiPlx1MjE5MCBWT0xWRVI8L2J1dHRvbj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICBgO1xuICAgIH1cblxuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZSA9PiB7XG4gICAgICAgIGNvbnN0IGJ0biA9IGUudGFyZ2V0LmNsb3Nlc3QoJy5tZW51LWJ0biwgLm9wdGlvbi1idG4sIC5idXktYnRuLCAuc2VsbC1idG4sIC5kZXBhcnQtYnRuLCAuc2hvcC1idG4nKTtcbiAgICAgICAgaWYgKCFidG4pIHJldHVybjtcbiAgICAgICAgY29uc3QgaXNCYWNrID0gYnRuLnRleHRDb250ZW50LmluY2x1ZGVzKCdWT0xWRVInKSB8fCBidG4ub25jbGljaz8udG9TdHJpbmcoKS5pbmNsdWRlcygnY2xvc2UnKTtcbiAgICAgICAgcGxheVNGWChpc0JhY2sgPyAndWlfYmFjaycgOiAndWlfY2xpY2snLCAwLjQpO1xuICAgIH0pO1xuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlb3ZlcicsIGUgPT4ge1xuICAgICAgICBjb25zdCBidG4gPSBlLnRhcmdldC5jbG9zZXN0KCcubWVudS1idG4sIC5vcHRpb24tYnRuLCAuYnV5LWJ0biwgLnNlbGwtYnRuLCAuZGVwYXJ0LWJ0biwgLnNob3AtYnRuJyk7XG4gICAgICAgIGlmIChidG4pIHBsYXlTRlgoJ3VpX2hvdmVyJywgMC4xNSwgMC4wNSk7XG4gICAgfSk7XG59KTtcblxuLy8jIHNvdXJjZVVSTD1tYWluLmpzXG5cbi8qID09PT09PT09PT09PT09PT09IHVpLmpzID09PT09PT09PT09PT09PT09ICovXG4vKipcbiAqIEFKVVNURVMgREVMIEpVR0FET1JcbiAqL1xuY29uc3QgR1JBUEhJQ1NfUFJFU0VUUyA9IHtcbiAgICBMT1c6ICAgIHsgcHJvcHM6IDEwMCwgcGFydGljbGVzOiAxMDAsIGNhc2luZ3M6IDMwLCAgcHJvamVjdGlsZXM6IDYwLCAgdHJhaWxzOiA2MCwgIHNoYWRvd3M6IGZhbHNlIH0sXG4gICAgTUVESVVNOiB7IHByb3BzOiAyMDAsIHBhcnRpY2xlczogMjAwLCBjYXNpbmdzOiA2MCwgIHByb2plY3RpbGVzOiAxMDAsIHRyYWlsczogMTIwLCBzaGFkb3dzOiB0cnVlIH0sXG4gICAgUFJPOiAgICB7IHByb3BzOiAzMDAsIHBhcnRpY2xlczogMzAwLCBjYXNpbmdzOiAxMDAsIHByb2plY3RpbGVzOiAxNTAsIHRyYWlsczogMjAwLCBzaGFkb3dzOiB0cnVlIH0sXG4gICAgVUxUUkE6ICB7IHByb3BzOiA1MCwgIHBhcnRpY2xlczogMCwgICBjYXNpbmdzOiAwLCAgIHByb2plY3RpbGVzOiA4MCwgIHRyYWlsczogMCwgICBzaGFkb3dzOiBmYWxzZSwgdWx0cmE6IHRydWUgfVxufTtcblxuZnVuY3Rpb24gYXBwbHlQZXJmQ2xhc3MoKSB7XG4gICAgaWYgKGRvY3VtZW50LmJvZHkpIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZSgndWx0cmEtbW9kZScsIFNldHRpbmdzLmdyYXBoaWNzID09PSAnVUxUUkEnKTtcbn1cblxuY29uc3QgU2V0dGluZ3MgPSB7XG4gICAgZ3JhcGhpY3M6IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdzbGltZV9ncmFwaGljcycpIHx8ICdQUk8nLFxuICAgIHNmeFZvbHVtZTogbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NsaW1lX3NmeFZvbHVtZScpICE9PSBudWxsID8gcGFyc2VJbnQobG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NsaW1lX3NmeFZvbHVtZScpKSA6IDEwMCxcbiAgICBtdXNpY1ZvbHVtZTogbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NsaW1lX211c2ljVm9sdW1lJykgIT09IG51bGwgPyBwYXJzZUludChsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnc2xpbWVfbXVzaWNWb2x1bWUnKSkgOiAxMDAsXG4gICAgaHVkU2l6ZTogbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NsaW1lX2h1ZFNpemUnKSAhPT0gbnVsbCA/IHBhcnNlSW50KGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdzbGltZV9odWRTaXplJykpIDogMixcbiAgICBiZXN0V2F2ZTogcGFyc2VJbnQobG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NsaW1lX2Jlc3RXYXZlJykpIHx8IDAsXG4gICAgc2F2ZSgpIHtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NsaW1lX2dyYXBoaWNzJywgdGhpcy5ncmFwaGljcyk7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzbGltZV9zZnhWb2x1bWUnLCB0aGlzLnNmeFZvbHVtZSk7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzbGltZV9tdXNpY1ZvbHVtZScsIHRoaXMubXVzaWNWb2x1bWUpO1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc2xpbWVfaHVkU2l6ZScsIHRoaXMuaHVkU2l6ZSk7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzbGltZV9iZXN0V2F2ZScsIHRoaXMuYmVzdFdhdmUpO1xuICAgIH1cbn07XG5hcHBseVBlcmZDbGFzcygpO1xuXG5nYW1lLnN0YXJ0RnJvbUxvYmJ5ID0gZnVuY3Rpb24oKSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvYmJ5LXNjcmVlbicpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgTXVzaWNNYW5hZ2VyLmR1Y2soNTAwKTtcbiAgICBNdXNpY01hbmFnZXIudHJhY2tzID0gTXVzaWNNYW5hZ2VyLmNvbWJhdFRyYWNrcztcbiAgICBNdXNpY01hbmFnZXIuY3VycmVudEluZGV4ID0gLTE7XG4gICAgdGhpcy5pbml0KCk7XG59O1xuXG5nYW1lLnRvZ2dsZUVzY01lbnUgPSBmdW5jdGlvbigpIHtcbiAgICBpZighdGhpcy5zdGFydGVkKSByZXR1cm47XG4gICAgaWYoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Nob3AtbWVudScpLnN0eWxlLmRpc3BsYXkgPT09ICdibG9jaycpIHJldHVybjtcbiAgICBjb25zdCBtZW51ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2VzYy1tZW51Jyk7XG4gICAgY29uc3QgaXNPcGVuID0gbWVudS5zdHlsZS5kaXNwbGF5ID09PSAnZmxleCc7XG4gICAgaWYoaXNPcGVuKSB0aGlzLmNsb3NlRXNjTWVudSgpO1xuICAgIGVsc2Uge1xuICAgICAgICBtZW51LnN0eWxlLmRpc3BsYXkgPSAnZmxleCc7XG4gICAgICAgIHRoaXMucGF1c2VkID0gdHJ1ZTtcbiAgICAgICAgTXVzaWNNYW5hZ2VyLmR1Y2soNDAwKTtcbiAgICB9XG59O1xuXG5nYW1lLmNsb3NlRXNjTWVudSA9IGZ1bmN0aW9uKCkge1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlc2MtbWVudScpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgdGhpcy5wYXVzZWQgPSBmYWxzZTtcbiAgICBNdXNpY01hbmFnZXIucmVzdW1lKDYwMCk7XG59O1xuXG4vLyBWdWVsdmUgYWwgbWVuXHUwMEZBIFNJTiByZWNhcmdhciBsYSBwXHUwMEUxZ2luYTogcGF1c2EvbGltcGlhIGxhIHBhcnRpZGEgZW4gY3Vyc28geVxuLy8gbXVlc3RyYSBlbCBsb2JieS4gU2lydmUgdGFudG8gZGVzZGUgZWwgbWVuXHUwMEZBIGRlIHBhdXNhIChFU0MpIGNvbW8gZGVzZGUgbGFcbi8vIHBhbnRhbGxhIGRlIEdhbWUgT3Zlci5cbmdhbWUuZ29Ub01haW5NZW51ID0gZnVuY3Rpb24oKSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2dhbWVvdmVyLXNjcmVlbicpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2VzYy1tZW51Jykuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2hvcC1tZW51Jykuc3R5bGUuZGlzcGxheSA9ICdub25lJztcblxuICAgIHRoaXMuc3RhcnRlZCA9IGZhbHNlOyAvLyBlbCBsb29wIFx1MDBGQW5pY28gZGUgbWFpbi5qcyBkZWphIGRlIGRpYnVqYXIgZW4gZWwgcHJcdTAwRjN4aW1vIGZyYW1lXG4gICAgdGhpcy5wYXVzZWQgPSB0cnVlO1xuICAgIHRoaXMuaXNXYXZlQWN0aXZlID0gZmFsc2U7XG4gICAgdGhpcy5lbmVtaWVzID0gW107XG4gICAgaWYgKHRoaXMucGFydGljbGVzKSB0aGlzLnBhcnRpY2xlcy5mb3JFYWNoKHAgPT4gcC5hY3RpdmUgPSBmYWxzZSk7XG4gICAgaWYgKHRoaXMuY2FzaW5ncykgdGhpcy5jYXNpbmdzLmZvckVhY2goYyA9PiBjLmFjdGl2ZSA9IGZhbHNlKTtcbiAgICBpZiAodGhpcy5wcm9qZWN0aWxlcykgdGhpcy5wcm9qZWN0aWxlcy5mb3JFYWNoKHAgPT4gcC5hY3RpdmUgPSBmYWxzZSk7XG4gICAgaWYgKHRoaXMudHJhaWxzKSB0aGlzLnRyYWlscy5mb3JFYWNoKHQgPT4gdC5hY3RpdmUgPSBmYWxzZSk7XG4gICAgaWYgKHRoaXMuZmxvYXRpbmdUZXh0cykgdGhpcy5mbG9hdGluZ1RleHRzLmZvckVhY2godCA9PiB0LmFjdGl2ZSA9IGZhbHNlKTtcbiAgICBpZiAodHlwZW9mIEV2ZW50TWFuYWdlciAhPT0gJ3VuZGVmaW5lZCcpIEV2ZW50TWFuYWdlci5kZWFjdGl2YXRlKCk7XG5cbiAgICBNdXNpY01hbmFnZXIuZHVjayg0MDApO1xuICAgIE11c2ljTWFuYWdlci50cmFja3MgPSBNdXNpY01hbmFnZXIubWFpblRyYWNrcztcbiAgICBNdXNpY01hbmFnZXIuY3VycmVudEluZGV4ID0gLTE7XG4gICAgc2V0VGltZW91dCgoKSA9PiB7IGlmICghZ2FtZS5zdGFydGVkKSBNdXNpY01hbmFnZXIuc3RhcnQoKTsgfSwgNDUwKTtcblxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2JieS1zY3JlZW4nKS5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnO1xufTtcblxuLy8gQXJyYW5jYSB1bmEgcGFydGlkYSBudWV2YSBkaXJlY3RvIGRlc2RlIGxhIHBhbnRhbGxhIGRlIEdhbWUgT3ZlciAoc2luIHBhc2FyXG4vLyBwb3IgZWwgbWVuXHUwMEZBIHByaW5jaXBhbCkuXG5nYW1lLnBsYXlBZ2FpbiA9IGZ1bmN0aW9uKCkge1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnYW1lb3Zlci1zY3JlZW4nKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgIE11c2ljTWFuYWdlci5kdWNrKDMwMCk7XG4gICAgdGhpcy5pbml0KCk7XG59O1xuXG4vLyAtLS0tIEN1ZW50YTogY2VycmFyIHNlc2lcdTAwRjNuIC8gYm9ycmFyIHByb2dyZXNvIChBanVzdGVzKSAtLS0tXG5nYW1lLm9wZW5Mb2dvdXRDb25maXJtID0gZnVuY3Rpb24oKSB7IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb25maXJtLWxvZ291dC1tb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnZmxleCc7IH07XG5nYW1lLmNsb3NlTG9nb3V0Q29uZmlybSA9IGZ1bmN0aW9uKCkgeyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29uZmlybS1sb2dvdXQtbW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOyB9O1xuZ2FtZS5jb25maXJtTG9nb3V0ID0gYXN5bmMgZnVuY3Rpb24oKSB7XG4gICAgZ2FtZS5jbG9zZUxvZ291dENvbmZpcm0oKTtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2V0dGluZ3MtcGFuZWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgIGF3YWl0IFNhdmVTeXN0ZW0uc2lnbk91dCgpO1xuICAgIC8vIFJlY2FyZ2FyIGVzIGxhIGZvcm1hIG1cdTAwRTFzIHNpbXBsZSBkZSBnYXJhbnRpemFyIHF1ZSBubyBxdWVkZSBuaW5nXHUwMEZBbiBlc3RhZG8gZGVcbiAgICAvLyBwYXJ0aWRhIGNvbGdhZG87IGJvb3QuanMgZGV0ZWN0YSBxdWUgbm8gaGF5IHNlc2lcdTAwRjNuIHkgbXVlc3RyYSBlbCBsb2dpbi5cbiAgICBsb2NhdGlvbi5yZWxvYWQoKTtcbn07XG5cbmdhbWUub3BlbkRlbGV0ZUNvbmZpcm0gPSBmdW5jdGlvbigpIHsgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbmZpcm0tZGVsZXRlLW1vZGFsJykuc3R5bGUuZGlzcGxheSA9ICdmbGV4JzsgfTtcbmdhbWUuY2xvc2VEZWxldGVDb25maXJtID0gZnVuY3Rpb24oKSB7IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb25maXJtLWRlbGV0ZS1tb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7IH07XG5cbmdhbWUucmVzZXRBbGxQcm9ncmVzcyA9IGFzeW5jIGZ1bmN0aW9uKCkge1xuICAgIGlmICh0eXBlb2YgU2F2ZVN5c3RlbS5jbGVhclByb2dyZXNzID09PSAnZnVuY3Rpb24nKSBhd2FpdCBTYXZlU3lzdGVtLmNsZWFyUHJvZ3Jlc3MoKTtcbiAgICBpZiAodHlwZW9mIFBsYXllclByb2ZpbGUgIT09ICd1bmRlZmluZWQnKSBQbGF5ZXJQcm9maWxlLnJlc2V0KCk7XG4gICAgaWYgKHR5cGVvZiBBY2hpZXZlbWVudE1hbmFnZXIgIT09ICd1bmRlZmluZWQnKSBBY2hpZXZlbWVudE1hbmFnZXIucmVzZXRBbGwoKTtcbiAgICBpZiAodHlwZW9mIFByb2dyZXNzaW9uICE9PSAndW5kZWZpbmVkJykgUHJvZ3Jlc3Npb24ucmVzZXQoKTtcbiAgICBTZXR0aW5ncy5iZXN0V2F2ZSA9IDA7XG4gICAgU2V0dGluZ3Muc2F2ZSgpO1xufTtcblxuZ2FtZS5jb25maXJtRGVsZXRlUHJvZ3Jlc3MgPSBhc3luYyBmdW5jdGlvbigpIHtcbiAgICBnYW1lLmNsb3NlRGVsZXRlQ29uZmlybSgpO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZXR0aW5ncy1wYW5lbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgYXdhaXQgZ2FtZS5yZXNldEFsbFByb2dyZXNzKCk7XG4gICAgLy8gTWFudGllbmUgbGEgc2VzaVx1MDBGM24gaW5pY2lhZGEgKG5vIGxsYW1hbW9zIGEgc2lnbk91dCkgeSByZWNhcmdhIHBhcmEgdm9sdmVyXG4gICAgLy8gYWwgZXN0YWRvIGluaWNpYWwgc2luIG5pbmdcdTAwRkFuIGRhdG8gZW4gbWVtb3JpYSBkZXNpbmNyb25pemFkby5cbiAgICBsb2NhdGlvbi5yZWxvYWQoKTtcbn07XG5cbmdhbWUub3BlblNldHRpbmdzID0gZnVuY3Rpb24oZnJvbSkge1xuICAgIHRoaXMuc2V0dGluZ3NPcmlnaW4gPSBmcm9tO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGZyb20gPT09ICdsb2JieScgPyAnbG9iYnktc2NyZWVuJyA6ICdlc2MtbWVudScpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NldHRpbmdzLXBhbmVsJykuc3R5bGUuZGlzcGxheSA9ICdmbGV4JztcbiAgICBjb25zdCBzZnhTbGlkZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2Z4LXZvbC1zbGlkZXInKTtcbiAgICBjb25zdCBtdXNpY1NsaWRlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtdXNpYy12b2wtc2xpZGVyJyk7XG4gICAgaWYoc2Z4U2xpZGVyKSBzZnhTbGlkZXIudmFsdWUgPSBTZXR0aW5ncy5zZnhWb2x1bWU7XG4gICAgaWYobXVzaWNTbGlkZXIpIG11c2ljU2xpZGVyLnZhbHVlID0gU2V0dGluZ3MubXVzaWNWb2x1bWU7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NmeC12b2wtdmFsdWUnKS5pbm5lclRleHQgPSBTZXR0aW5ncy5zZnhWb2x1bWU7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ211c2ljLXZvbC12YWx1ZScpLmlubmVyVGV4dCA9IFNldHRpbmdzLm11c2ljVm9sdW1lO1xuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJyNncmFwaGljcy1vcHRpb25zIC5vcHRpb24tYnRuJykuZm9yRWFjaChiID0+IGIuY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgYi5kYXRhc2V0LnZhbHVlID09PSBTZXR0aW5ncy5ncmFwaGljcykpO1xufTtcblxuZ2FtZS5jbG9zZVNldHRpbmdzID0gZnVuY3Rpb24oKSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NldHRpbmdzLXBhbmVsJykuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCh0aGlzLnNldHRpbmdzT3JpZ2luID09PSAnbG9iYnknID8gJ2xvYmJ5LXNjcmVlbicgOiAnZXNjLW1lbnUnKS5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnO1xufTtcblxuZ2FtZS5zZXRHcmFwaGljcyA9IGZ1bmN0aW9uKHRpZXIpIHtcbiAgICBTZXR0aW5ncy5ncmFwaGljcyA9IHRpZXI7XG4gICAgU2V0dGluZ3Muc2F2ZSgpO1xuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJyNncmFwaGljcy1vcHRpb25zIC5vcHRpb24tYnRuJykuZm9yRWFjaChiID0+IGIuY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgYi5kYXRhc2V0LnZhbHVlID09PSB0aWVyKSk7XG4gICAgYXBwbHlQZXJmQ2xhc3MoKTtcbn07XG5cbmdhbWUuc2V0U2Z4Vm9sdW1lID0gZnVuY3Rpb24odikgeyBTZXR0aW5ncy5zZnhWb2x1bWUgPSBwYXJzZUludCh2KTsgU2V0dGluZ3Muc2F2ZSgpOyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2Z4LXZvbC12YWx1ZScpLmlubmVyVGV4dCA9IHY7IH07XG5nYW1lLnNldE11c2ljVm9sdW1lID0gZnVuY3Rpb24odikgeyBcbiAgICBTZXR0aW5ncy5tdXNpY1ZvbHVtZSA9IHBhcnNlSW50KHYpOyBcbiAgICBTZXR0aW5ncy5zYXZlKCk7IFxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtdXNpYy12b2wtdmFsdWUnKS5pbm5lclRleHQgPSB2O1xuICAgIE11c2ljTWFuYWdlci5iYXNlVm9sdW1lID0gMC4yNSAqIChTZXR0aW5ncy5tdXNpY1ZvbHVtZSAvIDEwMCk7XG4gICAgaWYoTXVzaWNNYW5hZ2VyLmF1ZGlvICYmICFNdXNpY01hbmFnZXIuYXVkaW8ucGF1c2VkKSBNdXNpY01hbmFnZXIuYXVkaW8udm9sdW1lID0gTXVzaWNNYW5hZ2VyLmJhc2VWb2x1bWU7XG59O1xuXG5nYW1lLnRvZ2dsZUNvbnRyb2xzID0gZnVuY3Rpb24oc2hvdykge1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2JieS1zY3JlZW4nKS5zdHlsZS5kaXNwbGF5ID0gc2hvdyA/ICdub25lJyA6ICdmbGV4JztcbiAgICBjb25zdCBwYW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb250cm9scy1wYW5lbCcpO1xuICAgIGlmIChwYW5lbCkgcGFuZWwuc3R5bGUuZGlzcGxheSA9IHNob3cgPyAnZmxleCcgOiAnbm9uZSc7XG59O1xuXG5nYW1lLnVwZGF0ZVNob3AgPSBmdW5jdGlvbigpIHtcbiAgICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Nob3AtaXRlbXMnKTtcbiAgICBsaXN0LmlubmVySFRNTCA9IFwiXCI7XG4gICAgWydHMTgnLCAnS05JRkUnXS5mb3JFYWNoKGsgPT4ge1xuICAgICAgICBsaXN0LmlubmVySFRNTCArPSBgPGRpdiBjbGFzcz1cIndlYXBvbi1yb3dcIj48c3BhbiBjbGFzcz1cIndlYXBvbi1yb3ctbmFtZVwiPiR7a308L3NwYW4+PHNwYW4gY2xhc3M9XCJ3ZWFwb24tcm93LXN0YXR1cyBvd25lZFwiPkFEUVVJUklEQTwvc3Bhbj48L2Rpdj5gO1xuICAgIH0pO1xuICAgIE9iamVjdC5rZXlzKFdFQVBPTl9DT1NUUykuZm9yRWFjaChrID0+IHtcbiAgICAgICAgY29uc3Qgb3duZWQgPSB0aGlzLnBsYXllci5pbnZlbnRvcnkuc29tZShpID0+IGkgJiYgaS5uYW1lID09PSBrKTtcbiAgICAgICAgY29uc3QgY29zdCA9IFdFQVBPTl9DT1NUU1trXTtcbiAgICAgICAgaWYob3duZWQpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlZnVuZCA9IE1hdGguZmxvb3IoY29zdCAvIDIpO1xuICAgICAgICAgICAgbGlzdC5pbm5lckhUTUwgKz0gYDxkaXYgY2xhc3M9XCJ3ZWFwb24tcm93XCI+PHNwYW4gY2xhc3M9XCJ3ZWFwb24tcm93LW5hbWVcIj4ke2t9PC9zcGFuPjxzcGFuIGNsYXNzPVwid2VhcG9uLXJvdy1zdGF0dXMgb3duZWRcIj5BRFFVSVJJREE8L3NwYW4+PGJ1dHRvbiBjbGFzcz1cInNlbGwtYnRuXCIgb25jbGljaz1cImdhbWUuc2VsbFdlYXBvbignJHtrfScpXCI+VkVOREVSICgkJHtyZWZ1bmR9KTwvYnV0dG9uPjwvZGl2PmA7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsaXN0LmlubmVySFRNTCArPSBgPGRpdiBjbGFzcz1cIndlYXBvbi1yb3dcIj48c3BhbiBjbGFzcz1cIndlYXBvbi1yb3ctbmFtZVwiPiR7a308L3NwYW4+PHNwYW4gY2xhc3M9XCJ3ZWFwb24tcm93LXN0YXR1c1wiPiQke2Nvc3R9PC9zcGFuPjxidXR0b24gY2xhc3M9XCJidXktYnRuXCIgb25jbGljaz1cImdhbWUuYnV5V2VhcG9uKCcke2t9JylcIj5DT01QUkFSPC9idXR0b24+PC9kaXY+YDtcbiAgICAgICAgfVxuICAgIH0pO1xufTtcblxuZ2FtZS5nYW1lT3ZlciA9IGZ1bmN0aW9uKCkge1xuICAgIGNvbnN0IHdhdmVzU3Vydml2ZWQgPSB0aGlzLndhdmUgLSAxO1xuICAgIGNvbnN0IGVsYXBzZWRTZWMgPSBNYXRoLmZsb29yKChEYXRlLm5vdygpIC0gdGhpcy5zdGFydFRpbWUpIC8gMTAwMCk7XG4gICAgY29uc3QgbW0gPSBTdHJpbmcoTWF0aC5mbG9vcihlbGFwc2VkU2VjIC8gNjApKS5wYWRTdGFydCgyLCAnMCcpO1xuICAgIGNvbnN0IHNzID0gU3RyaW5nKGVsYXBzZWRTZWMgJSA2MCkucGFkU3RhcnQoMiwgJzAnKTtcblxuICAgIGxldCByZWNvcmRUZXh0ID0gXCJcIjtcbiAgICBpZiAod2F2ZXNTdXJ2aXZlZCA+IFNldHRpbmdzLmJlc3RXYXZlKSB7XG4gICAgICAgIFNldHRpbmdzLmJlc3RXYXZlID0gd2F2ZXNTdXJ2aXZlZDtcbiAgICAgICAgU2V0dGluZ3Muc2F2ZSgpO1xuICAgICAgICByZWNvcmRUZXh0ID0gXCJcdTAwQTFOVUVWTyBSXHUwMEM5Q09SRCFcIjtcbiAgICB9XG5cbiAgICB0aGlzLnBhdXNlZCA9IHRydWU7XG4gICAgTXVzaWNNYW5hZ2VyLmR1Y2soNjAwKTtcblxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnby13YXZlcycpLmlubmVyVGV4dCA9IHdhdmVzU3Vydml2ZWQ7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2dvLXRpbWUnKS5pbm5lclRleHQgPSBgJHttbX06JHtzc31gO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnby1yZWNvcmQnKS5pbm5lclRleHQgPSByZWNvcmRUZXh0O1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnYW1lb3Zlci1zY3JlZW4nKS5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnO1xufTtcblxuLy8gPT09IENSXHUwMEM5RElUT1MgPT09XG5nYW1lLm9wZW5DcmVkaXRzID0gZnVuY3Rpb24oKSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvYmJ5LXNjcmVlbicpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NyZWRpdHMtc2NyZWVuJykuc3R5bGUuZGlzcGxheSA9ICdmbGV4Jztcbn07XG5cbmdhbWUuY2xvc2VDcmVkaXRzID0gZnVuY3Rpb24oKSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NyZWRpdHMtc2NyZWVuJykuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9iYnktc2NyZWVuJykuc3R5bGUuZGlzcGxheSA9ICdmbGV4Jztcbn07XG5cbi8vIyBzb3VyY2VVUkw9dWkuanNcblxuLyogPT09PT09PT09PT09PT09PT0gZWZmZWN0cy5qcyA9PT09PT09PT09PT09PT09PSAqL1xuLyoqXG4gKiBBVURJTyBTWVNURU1cbiAqIFJ1dGFzIHJlbGF0aXZhcyBhIGxhIGNhcnBldGEgYXNzZXRzL1NvdW5kcy8gKGRlYmUgZXN0YXIgZW4gbGEgcmFcdTAwRUR6IGRlbCByZXBvLCBqdW50byBhIGluZGV4Lmh0bWwpLlxuICogRXN0cnVjdHVyYSBlc3BlcmFkYTpcbiAqICAgYXNzZXRzL1NvdW5kcy9TRlgvU2hvb3RzLy4uLlxuICogICBhc3NldHMvU291bmRzL1NGWC9WYXJpYWRvcy8uLi5cbiAqICAgYXNzZXRzL1NvdW5kcy9TRlgvRXZlbnRzLy4uLlxuICogICBhc3NldHMvU291bmRzL011c2ljL01haW4vLi4uXG4gKiAgIGFzc2V0cy9Tb3VuZHMvTXVzaWMvQ29tYmF0Ly4uLlxuICogICBhc3NldHMvU291bmRzL011c2ljL0Jvc3MvLi4uXG4gKlxuICogVG9kbyBlbCBhdWRpbyAoU0ZYIHB1bnR1YWxlcywgbVx1MDBGQXNpY2EgeSBhbWJpZW50ZSBjbGltXHUwMEUxdGljbykgZXMgMTAwJSBsb2NhbDpcbiAqIG5vIGhheSBuaW5ndW5hIFVSTCBleHRlcm5hIG5pIGZhbGxiYWNrIGEgc2VydmljaW9zIG9ubGluZS4gU2kgZmFsdGEgdW5cbiAqIGFyY2hpdm8sIHNlIGF2aXNhIHBvciBjb25zb2xhIGNvbiBjb25zb2xlLndhcm4geSBlbCBqdWVnbyBzaWd1ZSBhbmRhbmRvLlxuICovXG5jb25zdCBTRlggPSB7XG4gICAgLy8gLS0tIERpc3Bhcm9zIC0tLVxuICAgIHNob290X0cxODogJ2Fzc2V0cy9Tb3VuZHMvU0ZYL1Nob290cy9QSVNUT0xBLm9nZycsXG4gICAgc2hvb3RfU0hPVEdVTjogJ2Fzc2V0cy9Tb3VuZHMvU0ZYL1Nob290cy9FU0NPUEVUQS53YXYnLFxuICAgIHNob290X1NIT1RHVU4yOiAnYXNzZXRzL1NvdW5kcy9TRlgvU2hvb3RzL0VTQ09QRVRBMi5tcDMnLFxuICAgIHNob290X3JpZmxlOiAnYXNzZXRzL1NvdW5kcy9TRlgvU2hvb3RzL1JJRkxFUy5tcDMnLFxuICAgIHNob290X3NtZzogJ2Fzc2V0cy9Tb3VuZHMvU0ZYL1Nob290cy9TTUcubXAzJyxcbiAgICBzaG9vdF9zbmlwZXI6ICdhc3NldHMvU291bmRzL1NGWC9TaG9vdHMvU05JUEVSLm1wMycsXG4gICAgc2hvb3Rfc25pcGVyMjogJ2Fzc2V0cy9Tb3VuZHMvU0ZYL1Nob290cy9TTklQRVIyLm1wMycsXG4gICAgc2hvb3RfcmV2b2x2ZXI6ICdhc3NldHMvU291bmRzL1NGWC9TaG9vdHMvUkVWT0xWRVIubXAzJyxcblxuLy8gLS0tIE51ZXZvcyAoVUkpIC0tLVxuICAgIGxldmVsdXA6ICdhc3NldHMvU291bmRzL1NGWC9VSS9OSVZFTFVQLm1wMycsXG4gICAgdWlfYmFjazogJ2Fzc2V0cy9Tb3VuZHMvU0ZYL1VJL0JBQ0tCVVRUT04ubXAzJyxcbiAgICB1aV9jbGljazogJ2Fzc2V0cy9Tb3VuZHMvU0ZYL1VJL0NMSUNLQlVUVE9OLm1wMycsXG4gICAgdWlfaG92ZXI6ICdhc3NldHMvU291bmRzL1NGWC9VSS9IT1ZFUkJVVFRPTi5tcDMnLFxuICAgIGFjaGlldmVtZW50X3VubG9jazogJ2Fzc2V0cy9Tb3VuZHMvU0ZYL1VJL0xPR1JPREVTQkxPUVVFQURPLm1wMycsXG5cbiAgICAvLyAtLS0gTWVsZWUgLS0tXG4gICAgbWVsZWU6ICdhc3NldHMvU291bmRzL1NGWC9TaG9vdHMvTUVFTEUubXAzJyxcbiAgICBtZWxlZTI6ICdhc3NldHMvU291bmRzL1NGWC9TaG9vdHMvTUVFTEUyLm1wMycsXG4gICAgbWVsZWUzOiAnYXNzZXRzL1NvdW5kcy9TRlgvU2hvb3RzL01FRUxFMy5tcDMnLFxuICAgIGNoYWluc2F3OiAnYXNzZXRzL1NvdW5kcy9TRlgvU2hvb3RzL0NIQUlOU0FXLm1wMycsXG4gICAgY2hhaW5zYXdfaGl0OiAnYXNzZXRzL1NvdW5kcy9TRlgvU2hvb3RzL0NIQUlOU0FXSElULm1wMycsXG5cbiAgICAvLyAtLS0gRXNwZWNpYWxlcyAtLS1cbiAgICBmbGFtZXRocm93ZXI6ICdhc3NldHMvU291bmRzL1NGWC9TaG9vdHMvRkxBTUVUSFJPV0VSLm1wMycsXG4gICAgcnBnX2xhdW5jaDogJ2Fzc2V0cy9Tb3VuZHMvU0ZYL1Nob290cy9SUEdMQVVOQ0gubXAzJyxcbiAgICBycGdfZXhwbG9zaW9uOiAnYXNzZXRzL1NvdW5kcy9TRlgvU2hvb3RzL1JQR0VYUExPU0lPTi5tcDMnLFxuXG4gICAgLy8gLS0tIFZhcmlhZG9zIC0tLVxuICAgIGthbWlrYXplOiAnYXNzZXRzL1NvdW5kcy9TRlgvVmFyaWFkb3MvS0FNSUtBWkVFWFBMT1NJT04ubXAzJyxcbiAgICBkZWF0aDogJ2Fzc2V0cy9Tb3VuZHMvU0ZYL1ZhcmlhZG9zL1NMSU1FREVBVEgubXAzJyxcbiAgICBtdWVydGVfcGxheWVyOiAnYXNzZXRzL1NvdW5kcy9TRlgvVmFyaWFkb3MvbXVlcnRlcGxheWVyLm1wMycsXG5cbiAgICAvLyAtLS0gR2VuXHUwMEU5cmljb3MgcXVlIHlhIHVzYWJhIGVsIGp1ZWdvIChtYXBlYWRvcyBhIGxvIG1cdTAwRTFzIHBhcmVjaWRvIHF1ZSBtYW5kYXN0ZSkgLS0tXG4gICAgaGl0OiAnYXNzZXRzL1NvdW5kcy9TRlgvU2hvb3RzL01FRUxFLm1wMycsXG4gICAgcmVsb2FkOiAnYXNzZXRzL1NvdW5kcy9TRlgvU2hvb3RzL1BJU1RPTEEub2dnJyxcbiAgICBjb2luOiAnYXNzZXRzL1NvdW5kcy9TRlgvVmFyaWFkb3MvU0xJTUVERUFUSC5tcDMnLCAvLyBwbGFjZWhvbGRlciBpbnRlbmNpb25hbCwgbm8gdG9jYXJcbiAgICBleHBsb3Npb246ICdhc3NldHMvU291bmRzL1NGWC9TaG9vdHMvUlBHRVhQTE9TSU9OLm1wMycsXG5cbiAgICAvLyAtLS0gQ2xpbWEgLyBFdmVudG9zIC0tLVxuICAgIHdpbmQ6ICdhc3NldHMvU291bmRzL1NGWC9FdmVudHMvbGllY2lvLXN0cm9uZy1ob3dsaW5nLXdpbmQtMTMyMjgxLm1wMycsXG4gICAgc2FuZHN0b3JtOiAnYXNzZXRzL1NvdW5kcy9TRlgvRXZlbnRzL3NvdW5kcmVhbGl0eS1zYW5kc3Rvcm0tMjIyNzQxLm1wMycsXG4gICAgdGh1bmRlcjogJ2Fzc2V0cy9Tb3VuZHMvU0ZYL0V2ZW50cy91bml2ZXJzZmllbGQtbG91ZC10aHVuZGVyLTE5MjE2NS5tcDMnLFxuICAgIHJhaW46ICdhc3NldHMvU291bmRzL1NGWC9FdmVudHMvc291bmRzZm9yeW91LWxpZ2h0LXJhaW4tYW1iaWVudC0xMTQzNTQubXAzJ1xufTtcblxuLyoqXG4gKiBQT09MIERFIFNGWCAodW4tc2hvdCwgc3VwZXJwb25pYmxlczogZGlzcGFyb3MsIGdvbHBlcywgbW9uZWRhcywgZXRjLilcbiAqIENhZGEgY2xhdmUgZGUgU0ZYIHRpZW5lIHZhcmlhcyBpbnN0YW5jaWFzIDxhdWRpbz4gcmV1dGlsaXphYmxlcywgYXNcdTAwRUQgcmVwcm9kdWNpclxuICogclx1MDBFMWZhZ2FzIGRlIGRpc3Bhcm9zIG8gdmFyaW9zIGVuZW1pZ29zIGEgbGEgdmV6IG5vIGNyZWEgdW4gYG5ldyBBdWRpbygpYCBwb3IgZXZlbnRvLlxuICogTnVuY2Egc2UgZGVzY2FyZ2EgbmFkYSBkZSBJbnRlcm5ldDogc2kgZWwgYXJjaGl2byBsb2NhbCBubyBleGlzdGUsIHNlIGRlamFcbiAqIGNvbnN0YW5jaWEgZW4gY29uc29sYSAoY29uc29sZS53YXJuKSB5IGVzYSBjbGF2ZSBxdWVkYSBtdWRhLCBzaW4gcm9tcGVyIGVsIGp1ZWdvLlxuICovXG5jb25zdCBzZnhQb29scyA9IHt9O1xuY29uc3QgU0ZYX1BPT0xfU0laRSA9IDE0OyAvLyB2YXJpYXMgYXJtYXMgY29tcGFydGVuIGxhIG1pc21hIGNsYXZlIGRlIHNvbmlkbzsgdW4gcG9vbCBjaGljbyBjYXVzYWJhIGxhdGVuY2lhIHBlcmNlcHRpYmxlIGVuIG9sZWFkYXMgY29uIG11Y2hvIGZ1ZWdvIHNpbXVsdFx1MDBFMW5lb1xuY29uc3QgX21pc3NpbmdTZnhXYXJuZWQgPSBuZXcgU2V0KCk7XG5cbmZ1bmN0aW9uIGdldFNmeFBvb2woa2V5KSB7XG4gICAgaWYgKCFTRlhba2V5XSkge1xuICAgICAgICBpZiAoIV9taXNzaW5nU2Z4V2FybmVkLmhhcyhrZXkpKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFtBdWRpb10gQ2xhdmUgZGUgc29uaWRvIGluZXhpc3RlbnRlOiBcIiR7a2V5fVwiYCk7XG4gICAgICAgICAgICBfbWlzc2luZ1NmeFdhcm5lZC5hZGQoa2V5KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgaWYgKCFzZnhQb29sc1trZXldKSB7XG4gICAgICAgIHNmeFBvb2xzW2tleV0gPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiBTRlhfUE9PTF9TSVpFIH0sICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGEgPSBuZXcgQXVkaW8oU0ZYW2tleV0pO1xuICAgICAgICAgICAgYS5wcmVzZXJ2ZXNQaXRjaCA9IGZhbHNlO1xuICAgICAgICAgICAgYS5wcmVsb2FkID0gJ2F1dG8nO1xuICAgICAgICAgICAgLy8gU2luIGZhbGxiYWNrIG9ubGluZTogc2kgZWwgYXJjaGl2byBsb2NhbCBmYWx0YSBvIGZhbGxhLCBzb2xvIGF2aXNhbW9zIHBvciBjb25zb2xhLlxuICAgICAgICAgICAgYS5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmICghX21pc3NpbmdTZnhXYXJuZWQuaGFzKGtleSkpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS53YXJuKGBbQXVkaW9dIE5vIHNlIHB1ZG8gY2FyZ2FyIGVsIHNvbmlkbyBsb2NhbDogJHtTRlhba2V5XX1gKTtcbiAgICAgICAgICAgICAgICAgICAgX21pc3NpbmdTZnhXYXJuZWQuYWRkKGtleSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGEubG9hZCgpOyAvLyBmdWVyemEgbGEgZGVzY2FyZ2EvZGVjb2RpZmljYWNpXHUwMEYzbiBhaG9yYSB5IG5vIGVuIGVsIHByaW1lciBkaXNwYXJvXG4gICAgICAgICAgICByZXR1cm4gYTtcbiAgICAgICAgfSk7XG4gICAgICAgIHNmeFBvb2xzW2tleV0uY3Vyc29yID0gMDtcbiAgICB9XG4gICAgcmV0dXJuIHNmeFBvb2xzW2tleV07XG59XG5cbi8qKlxuICogcGxheVNGWChrZXksIHZvbHVtZSwgcGl0Y2hWYXJpYW5jZSlcbiAqIFx1MDBEQU5JQ08gcHVudG8gZGVsIGp1ZWdvIHF1ZSByZXByb2R1Y2UgdW4gZWZlY3RvIGRlIHNvbmlkbyBwdW50dWFsL3N1cGVycG9uaWJsZS5cbiAqIFJlc3RhdXJhZGEgYWNcdTAwRTEgKHZpdlx1MDBFRGEgaW1wbFx1MDBFRGNpdGFtZW50ZSBhbnRlcyBkZSBzZXBhcmFyIGVsIHNpc3RlbWEgZGUgcHJlY2FyZ2EpIHBhcmFcbiAqIHF1ZSBUT0RPIGVsIGNcdTAwRjNkaWdvIGV4aXN0ZW50ZSAocGxheWVyLmpzLCBsZXZlbC5qcywgYWNoaWV2ZW1lbnRzLmpzLCBwcm9ncmVzc2lvbi5qcyxcbiAqIHdvcmxkLmpzLCBtYWluLmpzLCBldmVudHMuanMpIHF1ZSB5YSBsYSBsbGFtYSBzaWdhIGZ1bmNpb25hbmRvIHNpbiBuaW5nXHUwMEZBbiBjYW1iaW8uXG4gKlxuICogRmlybWEgdXNhZGEgZW4gdG9kbyBlbCBwcm95ZWN0bzpcbiAqICAgcGxheVNGWCgncmVsb2FkJykgICAgICAgICAgICAgICAgICAgICAgICAtPiBzb2xvIGxhIGNsYXZlLCB2b2x1bWVuIHkgcGl0Y2ggcG9yIGRlZmVjdG9cbiAqICAgcGxheVNGWCgnZGVhdGgnLCAwLjUpICAgICAgICAgICAgICAgICAgICAtPiBjbGF2ZSArIHZvbHVtZW4gcmVsYXRpdm8gKDAtMSlcbiAqICAgcGxheVNGWCgnY2hhaW5zYXdfaGl0JywgMC4yLCAwLjA1KSAgICAgICAtPiBjbGF2ZSArIHZvbHVtZW4gKyB2YXJpYWNpXHUwMEYzbiBkZSBwaXRjaCAoKy8tIGVzZSAlKVxuICpcbiAqIC0gVG9tYSBsYSBzaWd1aWVudGUgaW5zdGFuY2lhIDxhdWRpbz4gbGlicmUgZGVsIHBvb2wgKHJvdW5kLXJvYmluIHZcdTAwRURhIHBvb2wuY3Vyc29yKSxcbiAqICAgYXNcdTAwRUQgdmFyaW9zIGRpc3Bhcm9zL2dvbHBlcyBzaW11bHRcdTAwRTFuZW9zIGNvbiBsYSBtaXNtYSBjbGF2ZSBubyBzZSBjb3J0YW4gZW50cmUgc1x1MDBFRC5cbiAqIC0gRWwgdm9sdW1lbiBmaW5hbCByZXNwZXRhIGFkZW1cdTAwRTFzIGVsIHZvbHVtZW4gZ2VuZXJhbCBkZSBlZmVjdG9zIChTZXR0aW5ncy5zZnhWb2x1bWUpLFxuICogICBpZ3VhbCBxdWUgeWEgaGFjZSBBbWJpZW50QXVkaW8gZW4gZXN0ZSBtaXNtbyBhcmNoaXZvLlxuICogLSBTaSBsYSBjbGF2ZSBubyBleGlzdGUgZW4gU0ZYLCBnZXRTZnhQb29sIHlhIGRlamEgZWwgd2FybmluZyBlbiBjb25zb2xhIHkgYWNcdTAwRTFcbiAqICAgc2ltcGxlbWVudGUgbm8gc2UgcmVwcm9kdWNlIG5hZGEgKGVsIGp1ZWdvIG51bmNhIHNlIHJvbXBlIHBvciB1biBzb25pZG8gZmFsdGFudGUpLlxuICovXG5mdW5jdGlvbiBwbGF5U0ZYKGtleSwgdm9sdW1lID0gMSwgcGl0Y2hWYXJpYW5jZSA9IDApIHtcbiAgICBjb25zdCBwb29sID0gZ2V0U2Z4UG9vbChrZXkpO1xuICAgIGlmICghcG9vbCkgcmV0dXJuO1xuXG4gICAgY29uc3QgYSA9IHBvb2xbcG9vbC5jdXJzb3JdO1xuICAgIHBvb2wuY3Vyc29yID0gKHBvb2wuY3Vyc29yICsgMSkgJSBwb29sLmxlbmd0aDtcblxuICAgIHRyeSB7IGEuY3VycmVudFRpbWUgPSAwOyB9IGNhdGNoIChlKSB7IC8qIG1ldGFkYXRhIGFcdTAwRkFuIG5vIGxpc3RhOiBubyBlcyBmYXRhbCAqLyB9XG5cbiAgICBjb25zdCBnZW5lcmFsVm9sID0gKHR5cGVvZiBTZXR0aW5ncyAhPT0gJ3VuZGVmaW5lZCcgJiYgdHlwZW9mIFNldHRpbmdzLnNmeFZvbHVtZSA9PT0gJ251bWJlcicpID8gKFNldHRpbmdzLnNmeFZvbHVtZSAvIDEwMCkgOiAxO1xuICAgIGEudm9sdW1lID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgdm9sdW1lICogZ2VuZXJhbFZvbCkpO1xuICAgIGEucGxheWJhY2tSYXRlID0gcGl0Y2hWYXJpYW5jZSA+IDAgPyAoMSArIChNYXRoLnJhbmRvbSgpICogMiAtIDEpICogcGl0Y2hWYXJpYW5jZSkgOiAxO1xuXG4gICAgYS5wbGF5KCkuY2F0Y2goKCkgPT4ge1xuICAgICAgICAvLyBCbG9xdWVhZG8gcG9yIGF1dG9wbGF5IHBvbGljeSBvIGludGVycnVtcGlkbyBwb3Igb3RybyBwbGF5KCk6IG5vIHJvbXBlIGVsIGp1ZWdvLlxuICAgIH0pO1xufVxuXG4vLyBQcmVjYXJnYSBUT0RPUyBsb3Mgc29uaWRvcyB5IGRldnVlbHZlIHVuYSBQcm9taXNlIHF1ZSByZXN1ZWx2ZSBjdWFuZG8gY2FkYSB1bm9cbi8vIHRlcm1pblx1MDBGMyBkZSBjYXJnYXIgKG8gZmFsbFx1MDBGMyAvIHZlbmNpXHUwMEYzIGVsIHRpbWVvdXQgZGUgc2VndXJpZGFkLCBwYXJhIHF1ZSB1biBzb25pZG9cbi8vIHJvdG8gbyBsZW50byBudW5jYSBjdWVsZ3VlIGVsIGFycmFucXVlIGRlbCBqdWVnbyBwYXJhIHNpZW1wcmUpLlxuLy8gb25Qcm9ncmVzcyhjYXJnYWRvcywgdG90YWwsIGtleSkgc2UgbGxhbWEgcG9yIGNhZGEgc29uaWRvIHF1ZSB0ZXJtaW5hLlxuZnVuY3Rpb24gcHJlbG9hZFNGWChvblByb2dyZXNzKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXMoU0ZYKTtcbiAgICAgICAgaWYgKGtleXMubGVuZ3RoID09PSAwKSB7IHJlc29sdmUoKTsgcmV0dXJuOyB9XG4gICAgICAgIGxldCBsb2FkZWQgPSAwO1xuICAgICAgICBrZXlzLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHBvb2wgPSBnZXRTZnhQb29sKGtleSk7IC8vIHlhIGNyZWEgeSBsbGFtYSAubG9hZCgpIGVuIHRvZG8gZWwgcG9vbFxuICAgICAgICAgICAgY29uc3QgYSA9IHBvb2wgPyBwb29sWzBdIDogbnVsbDtcbiAgICAgICAgICAgIGNvbnN0IGRvbmUgPSAoKSA9PiB7XG4gICAgICAgICAgICAgICAgbG9hZGVkKys7XG4gICAgICAgICAgICAgICAgaWYgKG9uUHJvZ3Jlc3MpIG9uUHJvZ3Jlc3MobG9hZGVkLCBrZXlzLmxlbmd0aCwga2V5KTtcbiAgICAgICAgICAgICAgICBpZiAobG9hZGVkID09PSBrZXlzLmxlbmd0aCkgcmVzb2x2ZSgpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGlmICghYSkgeyBkb25lKCk7IHJldHVybjsgfVxuICAgICAgICAgICAgaWYgKGEucmVhZHlTdGF0ZSA+PSAzKSB7IGRvbmUoKTsgcmV0dXJuOyB9IC8vIHlhIHRpZW5lIHN1ZmljaWVudGUgZGF0YVxuICAgICAgICAgICAgbGV0IHNldHRsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHsgaWYgKHNldHRsZWQpIHJldHVybjsgc2V0dGxlZCA9IHRydWU7IGRvbmUoKTsgfTtcbiAgICAgICAgICAgIGEuYWRkRXZlbnRMaXN0ZW5lcignY2FucGxheXRocm91Z2gnLCBmaW5pc2gsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgICAgICAgIGEuYWRkRXZlbnRMaXN0ZW5lcignZXJyb3InLCBmaW5pc2gsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgICAgICAgIHNldFRpbWVvdXQoZmluaXNoLCA1MDAwKTsgLy8gc2VndXJpZGFkOiBudW5jYSBibG9xdWVhciBlbCBhcnJhbnF1ZVxuICAgICAgICB9KTtcbiAgICB9KTtcbn1cblxuLyoqXG4gKiBNXHUwMERBU0lDQVxuICogTGlzdGFzIGRlIGFyY2hpdm9zIExPQ0FMRVMgcG9yIGNvbnRleHRvIChsb2JieS9jb21iYXRlL2plZmUpLiBQYXJhIGFncmVnYXIgY2FuY2lvbmVzXG4gKiBudWV2YXMgYWxjYW56YSBjb24gc3VtYXIgcnV0YXMgYSBlc3RvcyBhcnJheXM7IHNlIGVsaWdlIHVuYSBhbCBhemFyIGRlIGxhIGNhcnBldGFcbiAqIGNvcnJlc3BvbmRpZW50ZSB5LCBhbCB0ZXJtaW5hciwgc2UgZW5jYWRlbmEgYXV0b21cdTAwRTF0aWNhbWVudGUgb3RyYSAobnVuY2Egc2UgcXVlZGFcbiAqIHNpbiBtXHUwMEZBc2ljYSkuIExvcyBub21icmVzIGRlIGFyY2hpdm8gYWJham8gc2lndWVuIGxvcyBjclx1MDBFOWRpdG9zIGRlIExJQ0VOU0UubWQgXHUyMDE0XG4gKiBzaSB0dXMgYXJjaGl2b3MgcmVhbGVzIHRpZW5lbiBvdHJvIG5vbWJyZSwgc29sbyBoYXkgcXVlIGFqdXN0YXIgZXN0YXMgcnV0YXMuXG4gKi9cbmNvbnN0IE1VU0lDX1RSQUNLUyA9IHtcbiAgICBtYWluOiBbXG4gICAgICAgICdhc3NldHMvU291bmRzL011c2ljL01haW4vVGV0dWFubyAtIEFieXNzIChmcmVldG91c2UuY29tKS5tcDMnXG4gICAgXSxcbiAgICBjb21iYXQ6IFtcbiAgICAgICAgJ2Fzc2V0cy9Tb3VuZHMvTXVzaWMvQ29tYmF0L1B1ZmlubyAtIERpZ2l0YWwgTWF5aGFtIChmcmVldG91c2UuY29tKS5tcDMnLFxuICAgICAgICAnYXNzZXRzL1NvdW5kcy9NdXNpYy9Db21iYXQvWmFtYm9saW5vIC0gSW1wZXJhdG9yIChmcmVldG91c2UuY29tKS5tcDMnLFxuICAgICAgICAnYXNzZXRzL1NvdW5kcy9NdXNpYy9Db21iYXQvUHVmaW5vIC0gTWV0YWwgSXMgVHJhc2ggKGZyZWV0b3VzZS5jb20pLm1wMycsXG4gICAgICAgICdhc3NldHMvU291bmRzL011c2ljL0NvbWJhdC9OZXdNZS5tcDMnLFxuICAgICAgICAnYXNzZXRzL1NvdW5kcy9NdXNpYy9Db21iYXQvQnVkZHkubXAzJyxcbiAgICAgICAgJ2Fzc2V0cy9Tb3VuZHMvTXVzaWMvQ29tYmF0L05vUHVlZGVzQ29ubWlnby5tcDMnLFxuICAgICAgICAnYXNzZXRzL1NvdW5kcy9NdXNpYy9Db21iYXQvSW1UaGVCZXN0Lm1wMydcbiAgICBdLFxuICAgIGJvc3M6IFtcbiAgICAgICAgJ2Fzc2V0cy9Tb3VuZHMvTXVzaWMvQm9zcy9Ib3Jpem9udGUubXAzJyxcbiAgICAgICAgJ2Fzc2V0cy9Tb3VuZHMvTXVzaWMvQm9zcy9GaW5hbGx5Lm1wMycsXG4gICAgICAgICdhc3NldHMvU291bmRzL011c2ljL0Jvc3MvUHVuY2gubXAzJ1xuICAgIF1cbn07XG5cbi8vIFByZWNhcmdhIChtZXRhZGF0YSkgZGUgdG9kYXMgbGFzIGNhbmNpb25lcyBkZSBsYXMgMyBjYXRlZ29yXHUwMEVEYXMgKG1haW4vY29tYmF0L2Jvc3MpLlxuLy8gU29sbyBzZSBwaWRlICdsb2FkZWRtZXRhZGF0YScgKG5vIGVsIGFyY2hpdm8gZW50ZXJvKSBwYXJhIG5vIGdhc3RhciBtdWNobyBhbmNobyBkZVxuLy8gYmFuZGEgYW50ZXMgZGUganVnYXIsIHBlcm8gc1x1MDBFRCBjb25maXJtYXIgcXVlIGNhZGEgcGlzdGEgZXMgYWxjYW56YWJsZS5cbmZ1bmN0aW9uIHByZWxvYWRNdXNpYyhvblByb2dyZXNzKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgICBjb25zdCBhbGxUcmFja3MgPSBbLi4uTVVTSUNfVFJBQ0tTLm1haW4sIC4uLk1VU0lDX1RSQUNLUy5jb21iYXQsIC4uLk1VU0lDX1RSQUNLUy5ib3NzXTtcbiAgICAgICAgaWYgKGFsbFRyYWNrcy5sZW5ndGggPT09IDApIHsgcmVzb2x2ZSgpOyByZXR1cm47IH1cbiAgICAgICAgbGV0IGxvYWRlZCA9IDA7XG4gICAgICAgIGFsbFRyYWNrcy5mb3JFYWNoKHNyYyA9PiB7XG4gICAgICAgICAgICBjb25zdCBhID0gbmV3IEF1ZGlvKCk7XG4gICAgICAgICAgICBhLnByZWxvYWQgPSAnYXV0byc7XG4gICAgICAgICAgICBsZXQgc2V0dGxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgY29uc3QgZmluaXNoID0gKCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzZXR0bGVkKSByZXR1cm47IHNldHRsZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGxvYWRlZCsrO1xuICAgICAgICAgICAgICAgIGlmIChvblByb2dyZXNzKSBvblByb2dyZXNzKGxvYWRlZCwgYWxsVHJhY2tzLmxlbmd0aCwgc3JjKTtcbiAgICAgICAgICAgICAgICBpZiAobG9hZGVkID09PSBhbGxUcmFja3MubGVuZ3RoKSByZXNvbHZlKCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgYS5hZGRFdmVudExpc3RlbmVyKCdsb2FkZWRtZXRhZGF0YScsIGZpbmlzaCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgICAgICAgYS5hZGRFdmVudExpc3RlbmVyKCdlcnJvcicsICgpID0+IHsgY29uc29sZS53YXJuKGBbQXVkaW9dIE5vIHNlIHB1ZG8gcHJlY2FyZ2FyIGxhIG1cdTAwRkFzaWNhOiAke3NyY31gKTsgZmluaXNoKCk7IH0sIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgICAgICAgIGEuc3JjID0gc3JjO1xuICAgICAgICAgICAgc2V0VGltZW91dChmaW5pc2gsIDYwMDApO1xuICAgICAgICB9KTtcbiAgICB9KTtcbn1cblxuY29uc3QgTXVzaWNNYW5hZ2VyID0ge1xuICAgIC8vIFNlIG1hbnRpZW5lbiBlc3RvcyAzIG5vbWJyZXMgcG9ycXVlIG90cm9zIGFyY2hpdm9zICh3b3JsZC5qcykgbG9zIHJlZmVyZW5jaWFuIGRpcmVjdGFtZW50ZS5cbiAgICBtYWluVHJhY2tzOiBNVVNJQ19UUkFDS1MubWFpbixcbiAgICBjb21iYXRUcmFja3M6IE1VU0lDX1RSQUNLUy5jb21iYXQsXG4gICAgYm9zc1RyYWNrczogTVVTSUNfVFJBQ0tTLmJvc3MsXG4gICAgdHJhY2tzOiBbXSxcbiAgICBhdWRpbzogbnVsbCxcbiAgICBjdXJyZW50SW5kZXg6IC0xLFxuICAgIGJhc2VWb2x1bWU6IDAuMjUsXG4gICAgZmFkZVRpbWVyOiBudWxsLFxuICAgIGluaXQoKSB7XG4gICAgICAgIHRoaXMuYXVkaW8gPSBuZXcgQXVkaW8oKTtcbiAgICAgICAgdGhpcy5hdWRpby52b2x1bWUgPSAwO1xuICAgICAgICB0aGlzLmJhc2VWb2x1bWUgPSAwLjI1ICogKFNldHRpbmdzLm11c2ljVm9sdW1lIC8gMTAwKTtcbiAgICAgICAgdGhpcy5hdWRpby5hZGRFdmVudExpc3RlbmVyKCdlbmRlZCcsICgpID0+IHRoaXMubmV4dCgpKTtcbiAgICAgICAgdGhpcy5hdWRpby5hZGRFdmVudExpc3RlbmVyKCdlcnJvcicsICgpID0+IHtcbiAgICAgICAgICAgIGlmICh0aGlzLmF1ZGlvLnNyYykgY29uc29sZS53YXJuKGBbQXVkaW9dIE5vIHNlIHB1ZG8gY2FyZ2FyIGxhIG1cdTAwRkFzaWNhOiAke3RoaXMuYXVkaW8uc3JjfWApO1xuICAgICAgICAgICAgLy8gTnVuY2Egc2luIG1cdTAwRkFzaWNhOiBzaSB1bmEgcGlzdGEgZmFsbGEsIHNlIGludGVudGEgY29uIG90cmEgZGVsIG1pc21vIGNvbnRleHRvLlxuICAgICAgICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICAgIH0pO1xuICAgIH0sXG4gICAgLy8gQ2FtYmlhIGRlIGNhdGVnb3JcdTAwRURhIGRlIG1cdTAwRkFzaWNhIChtYWluL2NvbWJhdGUvamVmZSkgc29sbyBzaSBlcyBkaXN0aW50YSBhIGxhIGFjdHVhbCxcbiAgICAvLyBhc1x1MDBFRCBubyBjb3J0YSB1bmEgY2FuY2lcdTAwRjNuIGRlIGNvbWJhdGUgYSBtaXRhZCBwYXJhIHZvbHZlciBhIHBvbmVyLi4uIGxhIG1pc21hIGNhdGVnb3JcdTAwRURhLlxuICAgIHN3aXRjaENvbnRleHQodHJhY2tMaXN0LCBmYWRlTXMgPSAxNTAwKSB7XG4gICAgICAgIGlmICh0aGlzLnRyYWNrcyA9PT0gdHJhY2tMaXN0KSByZXR1cm47XG4gICAgICAgIHRoaXMudHJhY2tzID0gdHJhY2tMaXN0O1xuICAgICAgICB0aGlzLm5leHQoZmFkZU1zKTtcbiAgICB9LFxuICAgIF9mYWRlVG8odGFyZ2V0LCBkdXJhdGlvbiwgb25Db21wbGV0ZSkge1xuICAgICAgICBpZiAoIXRoaXMuYXVkaW8pIHJldHVybjtcbiAgICAgICAgY2xlYXJJbnRlcnZhbCh0aGlzLmZhZGVUaW1lcik7XG4gICAgICAgIGNvbnN0IGZyb20gPSB0aGlzLmF1ZGlvLnZvbHVtZTtcbiAgICAgICAgY29uc3QgdDAgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgICAgICAgdGhpcy5mYWRlVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0ID0gTWF0aC5taW4oMSwgKHBlcmZvcm1hbmNlLm5vdygpIC0gdDApIC8gZHVyYXRpb24pO1xuICAgICAgICAgICAgdGhpcy5hdWRpby52b2x1bWUgPSBmcm9tICsgKHRhcmdldCAtIGZyb20pICogdDtcbiAgICAgICAgICAgIGlmICh0ID49IDEpIHtcbiAgICAgICAgICAgICAgICBjbGVhckludGVydmFsKHRoaXMuZmFkZVRpbWVyKTtcbiAgICAgICAgICAgICAgICBpZiAob25Db21wbGV0ZSkgb25Db21wbGV0ZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LCA1MCk7XG4gICAgfSxcbiAgICBfcGxheUZyb21JbmRleChpZHgsIGZhZGVNcykge1xuICAgICAgICB0aGlzLmN1cnJlbnRJbmRleCA9IGlkeDtcbiAgICAgICAgdGhpcy5hdWRpby5zcmMgPSB0aGlzLnRyYWNrc1tpZHhdO1xuICAgICAgICB0aGlzLmF1ZGlvLnZvbHVtZSA9IDA7XG4gICAgICAgIHRoaXMuYXVkaW8ucGxheSgpLnRoZW4oKCkgPT4gdGhpcy5fZmFkZVRvKHRoaXMuYmFzZVZvbHVtZSwgZmFkZU1zKSkuY2F0Y2goKCkgPT4ge30pO1xuICAgIH0sXG4gICAgcGxheUxvYmJ5KCkgeyB0aGlzLnRyYWNrcyA9IHRoaXMubWFpblRyYWNrczsgdGhpcy5jdXJyZW50SW5kZXggPSAtMTsgdGhpcy5zdGFydCgpOyB9LFxuICAgIHN0YXJ0KCkge1xuICAgICAgICBpZiAoIXRoaXMuYXVkaW8gfHwgIXRoaXMuYXVkaW8ucGF1c2VkIHx8ICF0aGlzLnRyYWNrcy5sZW5ndGgpIHJldHVybjtcbiAgICAgICAgY29uc3QgaWR4ID0gdGhpcy5jdXJyZW50SW5kZXggPT09IC0xID8gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogdGhpcy50cmFja3MubGVuZ3RoKSA6IHRoaXMuY3VycmVudEluZGV4O1xuICAgICAgICB0aGlzLl9wbGF5RnJvbUluZGV4KGlkeCwgMTUwMCk7XG4gICAgfSxcbiAgICBuZXh0KGZhZGVNcyA9IDE1MDApIHtcbiAgICAgICAgaWYgKCF0aGlzLmF1ZGlvIHx8ICF0aGlzLnRyYWNrcy5sZW5ndGgpIHJldHVybjtcbiAgICAgICAgbGV0IGlkeCA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIHRoaXMudHJhY2tzLmxlbmd0aCk7XG4gICAgICAgIGlmICh0aGlzLnRyYWNrcy5sZW5ndGggPiAxICYmIGlkeCA9PT0gdGhpcy5jdXJyZW50SW5kZXgpIGlkeCA9IChpZHggKyAxKSAlIHRoaXMudHJhY2tzLmxlbmd0aDtcbiAgICAgICAgdGhpcy5fcGxheUZyb21JbmRleChpZHgsIGZhZGVNcyk7XG4gICAgfSxcbiAgICByZXN1bWUoZmFkZU1zID0gODAwKSB7XG4gICAgICAgIGlmICghdGhpcy5hdWRpbyB8fCAhdGhpcy5hdWRpby5wYXVzZWQpIHJldHVybjtcbiAgICAgICAgdGhpcy5hdWRpby52b2x1bWUgPSAwO1xuICAgICAgICB0aGlzLmF1ZGlvLnBsYXkoKS50aGVuKCgpID0+IHRoaXMuX2ZhZGVUbyh0aGlzLmJhc2VWb2x1bWUsIGZhZGVNcykpLmNhdGNoKCgpID0+IHt9KTtcbiAgICB9LFxuICAgIGR1Y2soZHVyYXRpb24gPSAxMjAwKSB7XG4gICAgICAgIGlmICghdGhpcy5hdWRpbyB8fCB0aGlzLmF1ZGlvLnBhdXNlZCkgcmV0dXJuO1xuICAgICAgICB0aGlzLl9mYWRlVG8oMCwgZHVyYXRpb24sICgpID0+IHRoaXMuYXVkaW8ucGF1c2UoKSk7XG4gICAgfVxufTtcblxuLyoqXG4gKiBBTUJJRU5URSAobGx1dmlhL3ZpZW50by9hcmVuYSBlbiBsb29wKS4gUmV1dGlsaXphIGxhcyBNSVNNQVMgY2xhdmVzIHkgcnV0YXMgbG9jYWxlcyBxdWVcbiAqIHlhIHZpdmVuIGVuIFNGWCAocmFpbi93aW5kL3NhbmRzdG9ybSkgZW4gdmV6IGRlIG1hbnRlbmVyIHVuIGNhdFx1MDBFMWxvZ28gcGFyYWxlbG8uXG4gKiBSZXNwZXRhIGVsIHZvbHVtZW4gZ2VuZXJhbCBkZSBTRlgsIHBlcm8gZXMgaW5kZXBlbmRpZW50ZSBkZWwgdm9sdW1lbiBkZSBjYWRhIGRpc3Bhcm8uXG4gKi9cbmNvbnN0IEFtYmllbnRBdWRpbyA9IHtcbiAgICBhdWRpbzogbnVsbCxcbiAgICBwbGF5KGtleSwgdm9sdW1lID0gMC4zNSkge1xuICAgICAgICB0aGlzLnN0b3AoKTtcbiAgICAgICAgY29uc3Qgc3JjID0gU0ZYW2tleV07XG4gICAgICAgIGlmICghc3JjKSB7IGNvbnNvbGUud2FybihgW0F1ZGlvXSBTb25pZG8gYW1iaWVudGUgaW5leGlzdGVudGU6IFwiJHtrZXl9XCJgKTsgcmV0dXJuOyB9XG4gICAgICAgIHRoaXMuYXVkaW8gPSBuZXcgQXVkaW8oc3JjKTtcbiAgICAgICAgdGhpcy5hdWRpby5sb29wID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hdWRpby52b2x1bWUgPSB2b2x1bWUgKiAoU2V0dGluZ3Muc2Z4Vm9sdW1lIC8gMTAwKTtcbiAgICAgICAgdGhpcy5hdWRpby5vbmVycm9yID0gKCkgPT4gY29uc29sZS53YXJuKGBbQXVkaW9dIE5vIHNlIHB1ZG8gY2FyZ2FyIGVsIGFtYmllbnRlOiAke3NyY31gKTtcbiAgICAgICAgdGhpcy5hdWRpby5wbGF5KCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIH0sXG4gICAgc3RvcCgpIHtcbiAgICAgICAgaWYgKHRoaXMuYXVkaW8pIHsgdGhpcy5hdWRpby5wYXVzZSgpOyB0aGlzLmF1ZGlvID0gbnVsbDsgfVxuICAgIH1cbn07XG5cbi8qKlxuICogQ1VMTElORzogRnVuY2lcdTAwRjNuIGRlIG9wdGltaXphY2lcdTAwRjNuIHBhcmEgcmVuZGVyaXphZG9cbiAqL1xuZnVuY3Rpb24gaXNWaXNpYmxlKHgsIHksIHJhZGl1cywgY2FtKSB7XG4gICAgY29uc3QgcGFkZGluZyA9IDUwO1xuICAgIHJldHVybiAoeCArIHJhZGl1cyArIHBhZGRpbmcgPiBjYW0ueCAmJiB4IC0gcmFkaXVzIC0gcGFkZGluZyA8IGNhbS54ICsgY2FudmFzLndpZHRoICYmXG4gICAgICAgICAgICB5ICsgcmFkaXVzICsgcGFkZGluZyA+IGNhbS55ICYmIHkgLSByYWRpdXMgLSBwYWRkaW5nIDwgY2FtLnkgKyBjYW52YXMuaGVpZ2h0KTtcbn1cblxuLyoqXG4gKiBFTlRJREFERVMgWSBFRkVDVE9TXG4gKi9cbmNsYXNzIFRyYWlsIHtcbiAgICBpbml0KHgsIHksIHJhZGl1cykge1xuICAgICAgICB0aGlzLnggPSB4OyB0aGlzLnkgPSB5OyBcbiAgICAgICAgdGhpcy5yYWRpdXMgPSByYWRpdXMgKiAoMC42ICsgTWF0aC5yYW5kb20oKSowLjQpO1xuICAgICAgICB0aGlzLmxpZmUgPSAxLjA7IFxuICAgICAgICB0aGlzLmFjdGl2ZSA9IHRydWU7XG4gICAgfVxuICAgIHVwZGF0ZSgpIHtcbiAgICAgICAgdGhpcy5saWZlIC09IDAuMDE1OyBcbiAgICAgICAgaWYgKHRoaXMubGlmZSA8PSAwKSB0aGlzLmFjdGl2ZSA9IGZhbHNlO1xuICAgIH1cbiAgICBkcmF3KGNhbSkge1xuICAgICAgICBpZiAoIWlzVmlzaWJsZSh0aGlzLngsIHRoaXMueSwgdGhpcy5yYWRpdXMsIGNhbSkpIHJldHVybjtcbiAgICAgICAgY3R4Lmdsb2JhbEFscGhhID0gdGhpcy5saWZlICogMC40O1xuICAgICAgICBjdHguZmlsbFN0eWxlID0gJyNhOGU2Y2YnO1xuICAgICAgICBjdHguYmVnaW5QYXRoKCk7XG4gICAgICAgIGN0eC5hcmModGhpcy54IC0gY2FtLngsIHRoaXMueSAtIGNhbS55LCB0aGlzLnJhZGl1cywgMCwgTWF0aC5QSSoyKTtcbiAgICAgICAgY3R4LmZpbGwoKTtcbiAgICAgICAgY3R4Lmdsb2JhbEFscGhhID0gMTtcbiAgICB9XG59XG5cbmNsYXNzIENhc2luZyB7XG4gICAgaW5pdCh4LCB5LCBkaXIpIHtcbiAgICAgICAgdGhpcy54ID0geDsgdGhpcy55ID0geTtcbiAgICAgICAgdGhpcy52eCA9IE1hdGguY29zKGRpciArIE1hdGguUEkvMiArIChNYXRoLnJhbmRvbSgpLTAuNSkpICogKDIgKyBNYXRoLnJhbmRvbSgpKjMpO1xuICAgICAgICB0aGlzLnZ5ID0gTWF0aC5zaW4oZGlyICsgTWF0aC5QSS8yICsgKE1hdGgucmFuZG9tKCktMC41KSkgKiAoMiArIE1hdGgucmFuZG9tKCkqMyk7XG4gICAgICAgIHRoaXMubGlmZSA9IDEuMDtcbiAgICAgICAgdGhpcy5yb3QgPSBNYXRoLnJhbmRvbSgpICogTWF0aC5QSTtcbiAgICAgICAgdGhpcy52Um90ID0gKE1hdGgucmFuZG9tKCkgLSAwLjUpO1xuICAgICAgICB0aGlzLmFjdGl2ZSA9IHRydWU7XG4gICAgfVxuICAgIHVwZGF0ZSgpIHtcbiAgICAgICAgdGhpcy54ICs9IHRoaXMudng7IHRoaXMueSArPSB0aGlzLnZ5O1xuICAgICAgICB0aGlzLnZ4ICo9IDAuODU7IHRoaXMudnkgKj0gMC44NTtcbiAgICAgICAgdGhpcy5yb3QgKz0gdGhpcy52Um90O1xuICAgICAgICBpZiAoTWF0aC5hYnModGhpcy52eCkgPCAwLjEpIHRoaXMubGlmZSAtPSAwLjAxO1xuICAgICAgICBpZiAodGhpcy5saWZlIDw9IDApIHRoaXMuYWN0aXZlID0gZmFsc2U7XG4gICAgfVxuICAgIGRyYXcoY2FtKSB7XG4gICAgICAgIGlmICghaXNWaXNpYmxlKHRoaXMueCwgdGhpcy55LCA0LCBjYW0pKSByZXR1cm47XG4gICAgICAgIGN0eC5nbG9iYWxBbHBoYSA9IE1hdGgubWF4KDAsIHRoaXMubGlmZSk7XG4gICAgICAgIGN0eC5zYXZlKCk7XG4gICAgICAgIGN0eC50cmFuc2xhdGUodGhpcy54IC0gY2FtLngsIHRoaXMueSAtIGNhbS55KTtcbiAgICAgICAgY3R4LnJvdGF0ZSh0aGlzLnJvdCk7XG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSAnI2YxYzQwZic7XG4gICAgICAgIGN0eC5maWxsUmVjdCgtMiwgLTEsIDQsIDIpO1xuICAgICAgICBjdHguc3Ryb2tlU3R5bGUgPSAnI2QzNTQwMCc7IGN0eC5saW5lV2lkdGggPSAxOyBjdHguc3Ryb2tlUmVjdCgtMiwgLTEsIDQsIDIpO1xuICAgICAgICBjdHgucmVzdG9yZSgpO1xuICAgICAgICBjdHguZ2xvYmFsQWxwaGEgPSAxO1xuICAgIH1cbn1cblxuY2xhc3MgRmxvYXRpbmdUZXh0IHtcbiAgICBpbml0KHgsIHksIHRleHQsIGNvbG9yID0gJyNmZmYnLCBzaXplID0gMjApIHtcbiAgICAgICAgdGhpcy54ID0geCArIChNYXRoLnJhbmRvbSgpIC0gMC41KSAqIDIwOyBcbiAgICAgICAgdGhpcy55ID0geSArIChNYXRoLnJhbmRvbSgpIC0gMC41KSAqIDIwO1xuICAgICAgICB0aGlzLnRleHQgPSB0ZXh0OyB0aGlzLmNvbG9yID0gY29sb3I7IHRoaXMuc2l6ZSA9IHNpemU7XG4gICAgICAgIHRoaXMubGlmZSA9IDEuMDsgdGhpcy52eSA9IC0xLjU7XG4gICAgICAgIHRoaXMuYWN0aXZlID0gdHJ1ZTtcbiAgICB9XG4gICAgdXBkYXRlKCkge1xuICAgICAgICB0aGlzLnkgKz0gdGhpcy52eTtcbiAgICAgICAgdGhpcy5saWZlIC09IDAuMDI7XG4gICAgICAgIGlmKHRoaXMubGlmZSA8PSAwKSB0aGlzLmFjdGl2ZSA9IGZhbHNlO1xuICAgIH1cbiAgICBkcmF3KGNhbSkge1xuICAgICAgICBpZiAoIWlzVmlzaWJsZSh0aGlzLngsIHRoaXMueSwgMzAsIGNhbSkpIHJldHVybjtcbiAgICAgICAgY3R4Lmdsb2JhbEFscGhhID0gTWF0aC5tYXgoMCwgdGhpcy5saWZlKTtcbiAgICAgICAgY3R4LmZpbGxTdHlsZSA9IHRoaXMuY29sb3I7XG4gICAgICAgIGN0eC5mb250ID0gYGJvbGQgJHt0aGlzLnNpemV9cHggVGVrb2A7XG4gICAgICAgIGN0eC5zdHJva2VTdHlsZSA9ICcjMDAwJztcbiAgICAgICAgY3R4LmxpbmVXaWR0aCA9IDM7XG4gICAgICAgIGN0eC5zdHJva2VUZXh0KHRoaXMudGV4dCwgdGhpcy54IC0gY2FtLngsIHRoaXMueSAtIGNhbS55KTtcbiAgICAgICAgY3R4LmZpbGxUZXh0KHRoaXMudGV4dCwgdGhpcy54IC0gY2FtLngsIHRoaXMueSAtIGNhbS55KTtcbiAgICAgICAgY3R4Lmdsb2JhbEFscGhhID0gMTtcbiAgICB9XG59XG5cbmNsYXNzIFBhcnRpY2xlIHtcbiAgICBpbml0KHgsIHksIGNvbG9yLCBzcGVlZCA9IDUsIHNpemUgPSAzLCB0eXBlID0gJ25vcm1hbCcpIHtcbiAgICAgICAgdGhpcy54ID0geDsgdGhpcy55ID0geTsgdGhpcy5jb2xvciA9IGNvbG9yOyB0aGlzLnR5cGUgPSB0eXBlO1xuICAgICAgICBjb25zdCBhbmdsZSA9IE1hdGgucmFuZG9tKCkgKiBNYXRoLlBJICogMjtcbiAgICAgICAgY29uc3QgZm9yY2UgPSBNYXRoLnJhbmRvbSgpICogc3BlZWQ7XG4gICAgICAgIHRoaXMudnggPSBNYXRoLmNvcyhhbmdsZSkgKiBmb3JjZTtcbiAgICAgICAgdGhpcy52eSA9IE1hdGguc2luKGFuZ2xlKSAqIGZvcmNlO1xuICAgICAgICB0aGlzLmxpZmUgPSAxLjA7XG4gICAgICAgIHRoaXMuZGVjYXkgPSAoKHR5cGUgPT09ICdzbW9rZScpID8gMC4wMTUgOiAwLjAzICsgTWF0aC5yYW5kb20oKSAqIDAuMDMpICogKGdhbWUuc2xvd1BhcnRpY2xlRGVjYXkgPyAwLjUgOiAxKTtcbiAgICAgICAgdGhpcy5zaXplID0gc2l6ZTtcbiAgICAgICAgdGhpcy5hY3RpdmUgPSB0cnVlO1xuICAgIH1cbiAgICB1cGRhdGUoKSB7XG4gICAgICAgIHRoaXMueCArPSB0aGlzLnZ4OyB0aGlzLnkgKz0gdGhpcy52eTtcbiAgICAgICAgaWYodGhpcy50eXBlID09PSAnc21va2UnKSB7XG4gICAgICAgICAgICB0aGlzLnNpemUgKz0gMC4yO1xuICAgICAgICAgICAgdGhpcy52eCAqPSAwLjkyOyB0aGlzLnZ5ICo9IDAuOTI7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLnZ4ICo9IDAuOTY7IHRoaXMudnkgKj0gMC45NjtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmxpZmUgLT0gdGhpcy5kZWNheTtcbiAgICAgICAgaWYgKHRoaXMubGlmZSA8PSAwKSB0aGlzLmFjdGl2ZSA9IGZhbHNlO1xuICAgIH1cbiAgICBkcmF3KGNhbSkge1xuICAgICAgICBpZiAoIWlzVmlzaWJsZSh0aGlzLngsIHRoaXMueSwgdGhpcy5zaXplLCBjYW0pKSByZXR1cm47XG4gICAgICAgIGN0eC5nbG9iYWxBbHBoYSA9IE1hdGgubWF4KDAsIHRoaXMubGlmZSk7XG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSB0aGlzLmNvbG9yO1xuICAgICAgICBjdHguYmVnaW5QYXRoKCk7XG4gICAgICAgIGN0eC5hcmModGhpcy54IC0gY2FtLngsIHRoaXMueSAtIGNhbS55LCB0aGlzLnNpemUsIDAsIE1hdGguUEkqMik7XG4gICAgICAgIGN0eC5maWxsKCk7XG4gICAgICAgIGN0eC5nbG9iYWxBbHBoYSA9IDE7XG4gICAgfVxufVxuXG5jbGFzcyBDYW1lcmEge1xuICAgIGNvbnN0cnVjdG9yKCkgeyB0aGlzLnggPSAwOyB0aGlzLnkgPSAwOyB0aGlzLnNoYWtlID0gMDsgfVxuICAgIGZvbGxvdyh0YXJnZXQpIHtcbiAgICAgICAgY29uc3QgZGVzdFggPSB0YXJnZXQueCAtIGNhbnZhcy53aWR0aCAvIDI7XG4gICAgICAgIGNvbnN0IGRlc3RZID0gdGFyZ2V0LnkgLSBjYW52YXMuaGVpZ2h0IC8gMjtcbiAgICAgICAgdGhpcy54ICs9IChkZXN0WCAtIHRoaXMueCkgKiAwLjE1O1xuICAgICAgICB0aGlzLnkgKz0gKGRlc3RZIC0gdGhpcy55KSAqIDAuMTU7XG4gICAgICAgIFxuICAgICAgICB0aGlzLnggPSBNYXRoLm1heCgwLCBNYXRoLm1pbih0aGlzLngsIE1BUF9TSVpFIC0gY2FudmFzLndpZHRoKSk7XG4gICAgICAgIHRoaXMueSA9IE1hdGgubWF4KDAsIE1hdGgubWluKHRoaXMueSwgTUFQX1NJWkUgLSBjYW52YXMuaGVpZ2h0KSk7XG4gICAgICAgIFxuICAgICAgICAvLyBTY3JlZW4gc2hha2U6IFx1MDBGQW5pY28gcHVudG8gcXVlIGFwbGljYSBlbCBzaGFrZSBhY3VtdWxhZG8gcG9yIGFybWFzL2V4cGxvc2lvbmVzL2V0Yy5cbiAgICAgICAgLy8gKHRvZGFzIGVzYXMgYXNpZ25hY2lvbmVzIGRpcmVjdGFzIGEgZ2FtZS5jYW1lcmEuc2hha2Ugc2lndWVuIGludGFjdGFzLCBzaW1wbGVtZW50ZVxuICAgICAgICAvLyBubyBzZSB0cmFkdWNlbiBlbiBkZXNwbGF6YW1pZW50byBkZSBjXHUwMEUxbWFyYSBjdWFuZG8gZ2FtZS5meEVuYWJsZWQgZXN0XHUwMEUxIGFwYWdhZG8sIGNvbW9cbiAgICAgICAgLy8gb2N1cnJlIGNvbiBlbCBwcmVzZXQgVUxUUkEpLlxuICAgICAgICBpZiAoZ2FtZS5meEVuYWJsZWQgJiYgdGhpcy5zaGFrZSA+IDAuMSkge1xuICAgICAgICAgICAgdGhpcy54ICs9IChNYXRoLnJhbmRvbSgpIC0gMC41KSAqIHRoaXMuc2hha2U7XG4gICAgICAgICAgICB0aGlzLnkgKz0gKE1hdGgucmFuZG9tKCkgLSAwLjUpICogdGhpcy5zaGFrZTtcbiAgICAgICAgICAgIHRoaXMuc2hha2UgKj0gMC44NTsgXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLnNoYWtlID0gMDtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLy8gRnVuY2lvbmVzIGRlIFBvb2wgZGUgRWZlY3Rvc1xuZ2FtZS5zcGF3blBhcnRpY2xlID0gZnVuY3Rpb24oeCwgeSwgY29sb3IsIHNwZWVkLCBzaXplLCB0eXBlKSB7XG4gICAgbGV0IHAgPSB0aGlzLnBhcnRpY2xlcy5maW5kKHAgPT4gIXAuYWN0aXZlKTtcbiAgICBpZihwKSBwLmluaXQoeCwgeSwgY29sb3IsIHNwZWVkLCBzaXplLCB0eXBlKTtcbn07XG5cbmdhbWUuc3Bhd25DYXNpbmcgPSBmdW5jdGlvbih4LCB5LCBkaXIpIHtcbiAgICBsZXQgYyA9IHRoaXMuY2FzaW5ncy5maW5kKGMgPT4gIWMuYWN0aXZlKTtcbiAgICBpZihjKSBjLmluaXQoeCwgeSwgZGlyKTtcbn07XG5cbmdhbWUuc3Bhd25UcmFpbCA9IGZ1bmN0aW9uKHgsIHksIHJhZGl1cykge1xuICAgIGxldCB0ID0gdGhpcy50cmFpbHMuZmluZCh0ID0+ICF0LmFjdGl2ZSk7XG4gICAgaWYodCkgdC5pbml0KHgsIHksIHJhZGl1cyk7XG59O1xuXG4vLyBFeHBsb3NpXHUwMEYzbiBnZW5cdTAwRTlyaWNhIGVuIFx1MDBFMXJlYSAoUlBHIHkgY3VhbHF1aWVyIGFybWEgZXhwbG9zaXZhIGZ1dHVyYSByZXV0aWxpemEgZXN0bylcbmdhbWUuZXhwbG9kZSA9IGZ1bmN0aW9uKHgsIHksIHJhZGl1cywgZG1nKSB7XG4gICAgdGhpcy5lbmVtaWVzLmZvckVhY2goZSA9PiB7IGlmKCFlLmludnVsbmVyYWJsZSAmJiBNYXRoLmh5cG90KGUueCAtIHgsIGUueSAtIHkpIDwgcmFkaXVzKSB0aGlzLmhpdEVuZW15KGUsIGRtZyk7IH0pO1xuICAgIGlmIChNYXRoLmh5cG90KHRoaXMucGxheWVyLnggLSB4LCB0aGlzLnBsYXllci55IC0geSkgPCByYWRpdXMpIHRoaXMucGxheWVyLnRha2VEYW1hZ2UoZG1nICogMC40KTtcbiAgICBmb3IobGV0IGk9MDsgaTxNYXRoLmNlaWwoMjQqdGhpcy5wYXJ0aWNsZVNjYWxlKTsgaSsrKSB0aGlzLnNwYXduUGFydGljbGUoeCwgeSwgaSAlIDIgPT09IDAgPyAnI2U2N2UyMicgOiAnI2YxYzQwZicsIDgsIDUsICdub3JtYWwnKTtcbiAgICBmb3IobGV0IGk9MDsgaTxNYXRoLmNlaWwoNip0aGlzLnBhcnRpY2xlU2NhbGUpOyBpKyspIHRoaXMuc3Bhd25QYXJ0aWNsZSh4LCB5LCAnIzU1NScsIDMsIDYsICdzbW9rZScpO1xuICAgIHRoaXMuY2FtZXJhLnNoYWtlID0gMjA7XG4gICAgcGxheVNGWCgncnBnX2V4cGxvc2lvbicsIDAuNSwgMC4xKTsgLy8gY29ycmVnaWRvOiAncnBnJyBubyBleGlzdFx1MDBFRGEgZW4gU0ZYLCB1c2FiYSBmYWxsYmFjayBzaWxlbmNpb3NvXG59O1xuXG4vLyMgc291cmNlVVJMPWVmZmVjdHMuanNcblxuLyogPT09PT09PT09PT09PT09PT0gZXZlbnRzLmpzID09PT09PT09PT09PT09PT09ICovXG4vKipcclxuICogU0lTVEVNQSBERSBFVkVOVE9TIERJTlx1MDBDMU1JQ09TXHJcbiAqIE1vZHVsYXI6IHBhcmEgYWdyZWdhciB1biBldmVudG8gbnVldm8gYWxjYW56YSBjb24gc3VtYXIgdW5hIGVudHJhZGEgYSBSQU5ET01fRVZFTlRTXHJcbiAqIChsYWJlbCArIG9uU3RhcnQvb25VcGRhdGUvb25EcmF3KSB5LCBzaSBuZWNlc2l0YSB1biBtb2RpZmljYWRvciBudWV2bywgbGVlcmxvIGRvbmRlXHJcbiAqIGNvcnJlc3BvbmRhIGNvbiB1biBcInx8IDFcIiAvIFwifHwgMFwiIHBvciBkZWZlY3RvLCB0YWwgY29tbyB5YSBoYWNlbiBsb3MgZXhpc3RlbnRlcy5cclxuICovXHJcbi8vIEFtYmllbnRBdWRpbyAobGx1dmlhL3ZpZW50by9hcmVuYSBlbiBsb29wKSB2aXZlIGFob3JhIGVuIGVmZmVjdHMuanM6IHJldXRpbGl6YSBsYXNcclxuLy8gbWlzbWFzIGNsYXZlcyB5IHJ1dGFzIGxvY2FsZXMgcXVlIGVsIHJlc3RvIGRlIGxvcyBTRlggKFNGWC5yYWluL3dpbmQvc2FuZHN0b3JtKSBlblxyXG4vLyB2ZXogZGUgbWFudGVuZXIgdW5hIGxpc3RhIGRlIFVSTHMgb25saW5lIHNlcGFyYWRhIHkgZHVwbGljYWRhLlxyXG5cclxuLy8gLS0tIFBhcnRcdTAwRURjdWxhcyBkZSBjbGltYTogc2UgZGlidWphbiBlbiBlc3BhY2lvIGRlIHBhbnRhbGxhIChubyBkZWwgbXVuZG8pLCBsaXZpYW5hcyAtLS1cclxuLy8gUG9vbCBmaWpvIChtaXNtbyBwYXRyXHUwMEYzbiBxdWUgcGFydGljbGVzL2Nhc2luZ3MvdHJhaWxzKSBlbiB2ZXogZGUgY3JlYXIgb2JqZXRvcyBudWV2b3MgZW4gY2FkYSBzcGF3blxyXG5jb25zdCBXRUFUSEVSX1BPT0xfU0laRSA9IDQwMDtcclxubGV0IHdlYXRoZXJQYXJ0aWNsZXMgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiBXRUFUSEVSX1BPT0xfU0laRSB9LCAoKSA9PiAoeyBhY3RpdmU6IGZhbHNlIH0pKTtcclxubGV0IHdlYXRoZXJDdXJzb3IgPSAwO1xyXG5mdW5jdGlvbiBzcGF3bldlYXRoZXJQYXJ0aWNsZShraW5kLCBjb2xvcikge1xyXG4gICAgLy8gUHVyYW1lbnRlIGRlY29yYXRpdm8gKG5vIGFwb3J0YSBpbmZvcm1hY2lcdTAwRjNuIGRlIGp1ZWdvLCBhIGRpZmVyZW5jaWEgZGUgbG9zIG92ZXJsYXlzXHJcbiAgICAvLyBkZSB2aXNpXHUwMEYzbiBkZSBuaWVibGEvb3NjdXJpZGFkKTogc2UgZGVzYWN0aXZhIHBvciBjb21wbGV0byBlbiBlbCBwcmVzZXQgVUxUUkEuXHJcbiAgICBpZiAoIWdhbWUuZnhFbmFibGVkKSByZXR1cm47XHJcbiAgICBpZiAoTWF0aC5yYW5kb20oKSA+IChnYW1lLnBhcnRpY2xlU2NhbGUgfHwgMSkpIHJldHVybjsgLy8gcmVkdWNlIGF1dG9tXHUwMEUxdGljYW1lbnRlIGVsIHNwYXduIGNvbiBtdWNoYSBjYXJnYSBhY3RpdmFcclxuICAgIGNvbnN0IHAgPSB3ZWF0aGVyUGFydGljbGVzW3dlYXRoZXJDdXJzb3JdO1xyXG4gICAgd2VhdGhlckN1cnNvciA9ICh3ZWF0aGVyQ3Vyc29yICsgMSkgJSB3ZWF0aGVyUGFydGljbGVzLmxlbmd0aDtcclxuICAgIHAua2luZCA9IGtpbmQ7IHAuY29sb3IgPSBjb2xvcjsgcC5hY3RpdmUgPSB0cnVlO1xyXG4gICAgaWYgKGtpbmQgPT09ICdyYWluJyB8fCBraW5kID09PSAnYmxvb2QnKSB7XHJcbiAgICAgICAgcC54ID0gTWF0aC5yYW5kb20oKSAqIGNhbnZhcy53aWR0aDsgcC55ID0gLTIwO1xyXG4gICAgICAgIHAudnggPSAtMS41OyBwLnZ5ID0gMTQgKyBNYXRoLnJhbmRvbSgpICogNjtcclxuICAgIH0gZWxzZSBpZiAoa2luZCA9PT0gJ3Nub3cnKSB7XHJcbiAgICAgICAgcC54ID0gTWF0aC5yYW5kb20oKSAqIGNhbnZhcy53aWR0aDsgcC55ID0gLTEwO1xyXG4gICAgICAgIHAudnggPSAoTWF0aC5yYW5kb20oKSAtIDAuNSkgKiAxLjU7IHAudnkgPSAxLjUgKyBNYXRoLnJhbmRvbSgpICogMS41O1xyXG4gICAgICAgIHAuc2l6ZSA9IDIgKyBNYXRoLnJhbmRvbSgpICogMztcclxuICAgIH0gZWxzZSBpZiAoa2luZCA9PT0gJ3NhbmQnKSB7XHJcbiAgICAgICAgcC54ID0gLTIwOyBwLnkgPSBNYXRoLnJhbmRvbSgpICogY2FudmFzLmhlaWdodDtcclxuICAgICAgICBwLnZ4ID0gNiArIE1hdGgucmFuZG9tKCkgKiA0OyBwLnZ5ID0gKE1hdGgucmFuZG9tKCkgLSAwLjUpICogMjtcclxuICAgICAgICBwLnNpemUgPSAyICsgTWF0aC5yYW5kb20oKSAqIDI7XHJcbiAgICB9IGVsc2UgeyAvLyBmb2dcclxuICAgICAgICBwLnggPSBNYXRoLnJhbmRvbSgpICogY2FudmFzLndpZHRoOyBwLnkgPSBNYXRoLnJhbmRvbSgpICogY2FudmFzLmhlaWdodDtcclxuICAgICAgICBwLnZ4ID0gMC4zICsgTWF0aC5yYW5kb20oKSAqIDAuMzsgcC52eSA9IDA7XHJcbiAgICAgICAgcC5zaXplID0gNjAgKyBNYXRoLnJhbmRvbSgpICogODA7XHJcbiAgICB9XHJcbiAgICBwLmxpZmUgPSAxO1xyXG59XHJcbmZ1bmN0aW9uIHVwZGF0ZUFuZERyYXdXZWF0aGVyUGFydGljbGVzKCkge1xyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCB3ZWF0aGVyUGFydGljbGVzLmxlbmd0aDsgaSsrKSB7XHJcbiAgICAgICAgY29uc3QgcCA9IHdlYXRoZXJQYXJ0aWNsZXNbaV07XHJcbiAgICAgICAgaWYgKCFwLmFjdGl2ZSkgY29udGludWU7XHJcbiAgICAgICAgcC54ICs9IHAudng7IHAueSArPSBwLnZ5O1xyXG4gICAgICAgIHAubGlmZSAtPSAocC5raW5kID09PSAnZm9nJykgPyAwLjAwMyA6IDAuMDE7XHJcbiAgICAgICAgaWYgKHAueSA+IGNhbnZhcy5oZWlnaHQgKyAzMCB8fCBwLnggPiBjYW52YXMud2lkdGggKyA4MCB8fCBwLnggPCAtODAgfHwgcC5saWZlIDw9IDApIHsgcC5hY3RpdmUgPSBmYWxzZTsgY29udGludWU7IH1cclxuICAgICAgICBjdHguZ2xvYmFsQWxwaGEgPSBNYXRoLm1heCgwLCBwLmxpZmUpICogKHAua2luZCA9PT0gJ2ZvZycgPyAwLjE4IDogKHAua2luZCA9PT0gJ3NhbmQnID8gMC4zNSA6IDAuNikpO1xyXG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSBwLmNvbG9yO1xyXG4gICAgICAgIGlmIChwLmtpbmQgPT09ICdyYWluJyB8fCBwLmtpbmQgPT09ICdibG9vZCcpIHsgY3R4LmZpbGxSZWN0KHAueCwgcC55LCAyLCAxNCk7IH1cclxuICAgICAgICBlbHNlIHsgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKHAueCwgcC55LCBwLnNpemUsIDAsIE1hdGguUEkgKiAyKTsgY3R4LmZpbGwoKTsgfVxyXG4gICAgfVxyXG4gICAgY3R4Lmdsb2JhbEFscGhhID0gMTtcclxufVxyXG5cclxuZnVuY3Rpb24gZHJhd0ZsYXRUaW50KGNvbG9yKSB7IGN0eC5maWxsU3R5bGUgPSBjb2xvcjsgY3R4LmZpbGxSZWN0KDAsIDAsIGNhbnZhcy53aWR0aCwgY2FudmFzLmhlaWdodCk7IH1cclxuZnVuY3Rpb24gZHJhd1Zpc2lvbk92ZXJsYXkoY2xlYXJSYWRpdXMsIGNvbG9yKSB7XHJcbiAgICBjb25zdCBjeCA9IGNhbnZhcy53aWR0aCAvIDIsIGN5ID0gY2FudmFzLmhlaWdodCAvIDI7XHJcbiAgICBjb25zdCBncmFkID0gY3R4LmNyZWF0ZVJhZGlhbEdyYWRpZW50KGN4LCBjeSwgY2xlYXJSYWRpdXMgKiAwLjM1LCBjeCwgY3ksIGNsZWFyUmFkaXVzKTtcclxuICAgIGdyYWQuYWRkQ29sb3JTdG9wKDAsICdyZ2JhKDAsMCwwLDApJyk7XHJcbiAgICBncmFkLmFkZENvbG9yU3RvcCgxLCBjb2xvcik7XHJcbiAgICBjdHguZmlsbFN0eWxlID0gZ3JhZDtcclxuICAgIGN0eC5maWxsUmVjdCgwLCAwLCBjYW52YXMud2lkdGgsIGNhbnZhcy5oZWlnaHQpO1xyXG59XHJcblxyXG4vLyBSYXlvIGRlIGxhIHRvcm1lbnRhIGVsXHUwMEU5Y3RyaWNhOiBhdmlzYSBjb24gc29uaWRvIHkgZ29scGVhIHVuYSB6b25hIGFsZWF0b3JpYSBkZWwgbWFwYVxyXG5mdW5jdGlvbiB0cmlnZ2VyTGlnaHRuaW5nU3RyaWtlKCkge1xyXG4gICAgY29uc3QgeCA9IE1hdGgucmFuZG9tKCkgKiBNQVBfU0laRSwgeSA9IE1hdGgucmFuZG9tKCkgKiBNQVBfU0laRTtcclxuICAgIGNvbnN0IGRtZyA9IDMwO1xyXG4gICAgaWYgKE1hdGguaHlwb3QoZ2FtZS5wbGF5ZXIueCAtIHgsIGdhbWUucGxheWVyLnkgLSB5KSA8IDEwMCkgZ2FtZS5wbGF5ZXIudGFrZURhbWFnZShkbWcpO1xyXG4gICAgZ2FtZS5lbmVtaWVzLmZvckVhY2goZSA9PiB7IGlmICghZS5pbnZ1bG5lcmFibGUgJiYgTWF0aC5oeXBvdChlLnggLSB4LCBlLnkgLSB5KSA8IDEwMCkgZ2FtZS5oaXRFbmVteShlLCBkbWcpOyB9KTtcclxuICAgIGlmIChpc1Zpc2libGUoeCwgeSwgMTAwLCBnYW1lLmNhbWVyYSkpIHtcclxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IE1hdGguY2VpbCgxNSpnYW1lLnBhcnRpY2xlU2NhbGUpOyBpKyspIGdhbWUuc3Bhd25QYXJ0aWNsZSh4LCB5LCAnI2ZmZicsIDgsIDQsICdub3JtYWwnKTtcclxuICAgICAgICBnYW1lLmNhbWVyYS5zaGFrZSA9IDE1O1xyXG4gICAgfVxyXG59XHJcbi8vIEJvbWJhcmRlbzogZXhwbG9zaVx1MDBGM24gYWxlYXRvcmlhIGNlcmNhIGRlbCBqdWdhZG9yXHJcbmZ1bmN0aW9uIHRyaWdnZXJCb21iYXJkbWVudCgpIHtcclxuICAgIGNvbnN0IGEgPSBNYXRoLnJhbmRvbSgpICogTWF0aC5QSSAqIDIsIGQgPSBNYXRoLnJhbmRvbSgpICogNTAwO1xyXG4gICAgY29uc3QgeCA9IGdhbWUucGxheWVyLnggKyBNYXRoLmNvcyhhKSAqIGQsIHkgPSBnYW1lLnBsYXllci55ICsgTWF0aC5zaW4oYSkgKiBkO1xyXG4gICAgY29uc3QgcmFkaXVzID0gMTEwLCBkbWcgPSAyNTtcclxuICAgIGlmIChNYXRoLmh5cG90KGdhbWUucGxheWVyLnggLSB4LCBnYW1lLnBsYXllci55IC0geSkgPCByYWRpdXMpIGdhbWUucGxheWVyLnRha2VEYW1hZ2UoZG1nKTtcclxuICAgIGdhbWUuZW5lbWllcy5mb3JFYWNoKGUgPT4geyBpZiAoIWUuaW52dWxuZXJhYmxlICYmIE1hdGguaHlwb3QoZS54IC0geCwgZS55IC0geSkgPCByYWRpdXMpIGdhbWUuaGl0RW5lbXkoZSwgZG1nKTsgfSk7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IE1hdGguY2VpbCgyMCpnYW1lLnBhcnRpY2xlU2NhbGUpOyBpKyspIGdhbWUuc3Bhd25QYXJ0aWNsZSh4LCB5LCAnI2U2N2UyMicsIDcsIDQsICdub3JtYWwnKTtcclxuICAgIGlmIChpc1Zpc2libGUoeCwgeSwgcmFkaXVzLCBnYW1lLmNhbWVyYSkpIGdhbWUuY2FtZXJhLnNoYWtlID0gMTQ7XHJcbn1cclxuXHJcbmNvbnN0IFJBTkRPTV9FVkVOVFMgPSB7XHJcbiAgICBSQUlOOiB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTI2MTQgTExVVklBJywgYW1iaWVudDogJ3JhaW4nLFxyXG4gICAgICAgIG9uU3RhcnQoKSB7IGdhbWUuZW5lbXlTcGVlZE11bHQgPSAxLjEwOyBnYW1lLndlYXBvblNwcmVhZEJvbnVzID0gMC4wNTsgfSxcclxuICAgICAgICBvblVwZGF0ZSgpIHsgaWYgKE1hdGgucmFuZG9tKCkgPiAwLjMpIHNwYXduV2VhdGhlclBhcnRpY2xlKCdyYWluJywgJyM3ZmE4ZDknKTsgfSxcclxuICAgICAgICBvbkRyYXcoKSB7IGRyYXdGbGF0VGludCgncmdiYSgxNSwyNSw0NSwwLjE1KScpOyB9XHJcbiAgICB9LFxyXG4gICAgU1RPUk06IHtcclxuICAgICAgICBsYWJlbDogJ1x1RDgzQ1x1REYyOVx1RkUwRiBUT1JNRU5UQSBFTFx1MDBDOUNUUklDQScsIGFtYmllbnQ6ICdyYWluJyxcclxuICAgICAgICBvblN0YXJ0KCkgeyBnYW1lLmVuZW15U3BlZWRNdWx0ID0gMS4xMDsgZ2FtZS5fbGlnaHRuaW5nVGltZXIgPSAyMDAgKyBNYXRoLnJhbmRvbSgpICogMjAwOyB9LFxyXG4gICAgICAgIG9uVXBkYXRlKCkge1xyXG4gICAgICAgICAgICBpZiAoTWF0aC5yYW5kb20oKSA+IDAuMjUpIHNwYXduV2VhdGhlclBhcnRpY2xlKCdyYWluJywgJyNhYWI4ZmYnKTtcclxuICAgICAgICAgICAgZ2FtZS5fbGlnaHRuaW5nVGltZXItLTtcclxuICAgICAgICAgICAgaWYgKGdhbWUuX2xpZ2h0bmluZ1RpbWVyIDw9IDApIHtcclxuICAgICAgICAgICAgICAgIHBsYXlTRlgoJ3RodW5kZXInLCAwLjYsIDAuMSk7XHJcbiAgICAgICAgICAgICAgICBnYW1lLl9saWdodG5pbmdUaW1lciA9IDMwMCArIE1hdGgucmFuZG9tKCkgKiAzMDA7XHJcbiAgICAgICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHsgaWYgKGdhbWUuYWN0aXZlRXZlbnQgPT09ICdTVE9STScpIHRyaWdnZXJMaWdodG5pbmdTdHJpa2UoKTsgfSwgMTIwMCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9LFxyXG4gICAgICAgIG9uRHJhdygpIHsgZHJhd0ZsYXRUaW50KCdyZ2JhKDUsNSwxNSwwLjM1KScpOyB9XHJcbiAgICB9LFxyXG4gICAgRk9HOiB7XHJcbiAgICAgICAgbGFiZWw6ICdcdUQ4M0NcdURGMkJcdUZFMEYgTklFQkxBJyxcclxuICAgICAgICBvblN0YXJ0KCkge30sXHJcbiAgICAgICAgb25VcGRhdGUoKSB7IGlmIChNYXRoLnJhbmRvbSgpID4gMC42KSBzcGF3bldlYXRoZXJQYXJ0aWNsZSgnZm9nJywgJ3JnYmEoMjAwLDIwMCwyMTAsMC41KScpOyB9LFxyXG4gICAgICAgIG9uRHJhdygpIHsgZHJhd1Zpc2lvbk92ZXJsYXkoMjYwLCAncmdiYSgxODAsMTgyLDE5MCwwLjkyKScpOyB9XHJcbiAgICB9LFxyXG4gICAgQkxJWlpBUkQ6IHtcclxuICAgICAgICBsYWJlbDogJ1x1Mjc0NFx1RkUwRiBWRU5USVNDQScsIGFtYmllbnQ6ICd3aW5kJyxcclxuICAgICAgICBvblN0YXJ0KCkgeyBnYW1lLnBsYXllclNwZWVkTXVsdCA9IDAuNzU7IH0sXHJcbiAgICAgICAgb25VcGRhdGUoKSB7IGlmIChNYXRoLnJhbmRvbSgpID4gMC4zKSBzcGF3bldlYXRoZXJQYXJ0aWNsZSgnc25vdycsIE1hdGgucmFuZG9tKCkgPiAwLjUgPyAnI2VhZjZmZicgOiAnI2FlZTNmZicpOyB9LFxyXG4gICAgICAgIG9uRHJhdygpIHsgZHJhd0ZsYXRUaW50KCdyZ2JhKDE0MCwxOTAsMjU1LDAuMTIpJyk7IH1cclxuICAgIH0sXHJcbiAgICBIRUFUV0FWRToge1xyXG4gICAgICAgIGxhYmVsOiAnXHVEODNEXHVERDI1IE9MQSBERSBDQUxPUicsXHJcbiAgICAgICAgb25TdGFydCgpIHsgZ2FtZS5zbG93UGFydGljbGVEZWNheSA9IHRydWU7IH0sXHJcbiAgICAgICAgb25VcGRhdGUoKSB7fSxcclxuICAgICAgICBvbkRyYXcoKSB7IGRyYXdGbGF0VGludChgcmdiYSgyMzAsOTAsMjAsJHswLjEyICsgTWF0aC5zaW4oRGF0ZS5ub3coKSAvIDMwMCkgKiAwLjAzfSlgKTsgfVxyXG4gICAgfSxcclxuICAgIFNBTkRTVE9STToge1xyXG4gICAgICAgIGxhYmVsOiAnXHVEODNDXHVERjJBXHVGRTBGIFRPUk1FTlRBIERFIEFSRU5BJywgYW1iaWVudDogJ3NhbmRzdG9ybScsXHJcbiAgICAgICAgb25TdGFydCgpIHsgZ2FtZS5wcm9qZWN0aWxlU3BlZWRNdWx0ID0gMC44OyB9LFxyXG4gICAgICAgIG9uVXBkYXRlKCkgeyBpZiAoTWF0aC5yYW5kb20oKSA+IDAuMikgc3Bhd25XZWF0aGVyUGFydGljbGUoJ3NhbmQnLCAnI2M5YTg2YScpOyB9LFxyXG4gICAgICAgIG9uRHJhdygpIHsgZHJhd1Zpc2lvbk92ZXJsYXkoMjMwLCAncmdiYSgxNTAsMTMwLDUwLDAuOTIpJyk7IH1cclxuICAgIH0sXHJcbiAgICBSQURJT0FDVElWRToge1xyXG4gICAgICAgIGxhYmVsOiAnXHUyNjIyXHVGRTBGIExMVVZJQSBSQURJQUNUSVZBJywgYW1iaWVudDogJ3JhaW4nLFxyXG4gICAgICAgIG9uU3RhcnQoKSB7IGdhbWUubW9uZXlNdWx0ID0gMS41OyBnYW1lLl9kb3RUaW1lciA9IDA7IH0sXHJcbiAgICAgICAgb25VcGRhdGUoKSB7XHJcbiAgICAgICAgICAgIGlmIChNYXRoLnJhbmRvbSgpID4gMC4zKSBzcGF3bldlYXRoZXJQYXJ0aWNsZSgncmFpbicsICcjMzlmZjE0Jyk7XHJcbiAgICAgICAgICAgIGdhbWUuX2RvdFRpbWVyKys7XHJcbiAgICAgICAgICAgIGlmIChnYW1lLl9kb3RUaW1lciA+IDUwKSB7XHJcbiAgICAgICAgICAgICAgICBnYW1lLl9kb3RUaW1lciA9IDA7XHJcbiAgICAgICAgICAgICAgICBnYW1lLnBsYXllci50YWtlRGFtYWdlKDIpO1xyXG4gICAgICAgICAgICAgICAgZ2FtZS5lbmVtaWVzLmZvckVhY2goZSA9PiB7IGlmICghZS5pbnZ1bG5lcmFibGUpIGdhbWUuaGl0RW5lbXkoZSwgMik7IH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSxcclxuICAgICAgICBvbkRyYXcoKSB7IGRyYXdGbGF0VGludCgncmdiYSgyMCw5MCwyMCwwLjE4KScpOyB9XHJcbiAgICB9LFxyXG4gICAgTVVUQVRJT046IHtcclxuICAgICAgICBsYWJlbDogJ1x1RDgzRVx1RERFQSBNVVRBQ0lcdTAwRDNOJyxcclxuICAgICAgICBvblN0YXJ0KCkgeyBnYW1lLmVuZW15U2l6ZU11bHQgPSAxLjM7IGdhbWUuZW5lbXlIcE11bHQgPSAxLjU7IGdhbWUuZW5lbXlEYW1hZ2VNdWx0ID0gMS40OyB9LFxyXG4gICAgICAgIG9uVXBkYXRlKCkge30sXHJcbiAgICAgICAgb25EcmF3KCkgeyBkcmF3RmxhdFRpbnQoJ3JnYmEoMjAsNjAsMjAsMC4wOCknKTsgfVxyXG4gICAgfSxcclxuICAgIElOVkFTSU9OOiB7XHJcbiAgICAgICAgbGFiZWw6ICdcdUQ4M0RcdURDODAgSU5WQVNJXHUwMEQzTicsXHJcbiAgICAgICAgb25TdGFydCgpIHt9LCBvblVwZGF0ZSgpIHt9LCBvbkRyYXcoKSB7fVxyXG4gICAgfSxcclxuICAgIEZSRU5aWToge1xyXG4gICAgICAgIGxhYmVsOiAnXHVEODNFXHVERTc4IEZSRU5FU1x1MDBDRCcsIGFtYmllbnQ6ICdyYWluJyxcclxuICAgICAgICBvblN0YXJ0KCkgeyBnYW1lLmVuZW15U3BlZWRNdWx0ID0gMS40OyB9LFxyXG4gICAgICAgIG9uVXBkYXRlKCkgeyBpZiAoTWF0aC5yYW5kb20oKSA+IDAuMykgc3Bhd25XZWF0aGVyUGFydGljbGUoJ2Jsb29kJywgJyNjMDM5MmInKTsgfSxcclxuICAgICAgICBvbkRyYXcoKSB7IGRyYXdGbGF0VGludCgncmdiYSgxMjAsMCwwLDAuMTUpJyk7IH1cclxuICAgIH0sXHJcbiAgICBCT01CQVJETUVOVDoge1xyXG4gICAgICAgIGxhYmVsOiAnXHVEODNEXHVEQ0EzIEJPTUJBUkRFTycsXHJcbiAgICAgICAgb25TdGFydCgpIHsgZ2FtZS5fYm9tYlRpbWVyID0gMTIwICsgTWF0aC5yYW5kb20oKSAqIDEyMDsgfSxcclxuICAgICAgICBvblVwZGF0ZSgpIHtcclxuICAgICAgICAgICAgZ2FtZS5fYm9tYlRpbWVyLS07XHJcbiAgICAgICAgICAgIGlmIChnYW1lLl9ib21iVGltZXIgPD0gMCkgeyB0cmlnZ2VyQm9tYmFyZG1lbnQoKTsgZ2FtZS5fYm9tYlRpbWVyID0gMTUwICsgTWF0aC5yYW5kb20oKSAqIDIwMDsgfVxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgb25EcmF3KCkge31cclxuICAgIH0sXHJcbiAgICBEQVJLTkVTUzoge1xyXG4gICAgICAgIGxhYmVsOiAnXHVEODNDXHVERjExIE9TQ1VSSURBRCBUT1RBTCcsXHJcbiAgICAgICAgb25TdGFydCgpIHt9LCBvblVwZGF0ZSgpIHt9LFxyXG4gICAgICAgIG9uRHJhdygpIHsgZHJhd1Zpc2lvbk92ZXJsYXkoMTUwLCAncmdiYSgwLDAsMCwwLjk3KScpOyB9XHJcbiAgICB9LFxyXG4gICAgTE9XX0dSQVZJVFk6IHtcclxuICAgICAgICBsYWJlbDogJ1x1RDgzQ1x1REYwMCBHUkFWRURBRCBCQUpBJyxcclxuICAgICAgICBvblN0YXJ0KCkgeyBnYW1lLmtub2NrYmFja011bHQgPSAzLjU7IH0sIG9uVXBkYXRlKCkge30sIG9uRHJhdygpIHt9XHJcbiAgICB9LFxyXG4gICAgU0xPV19USU1FOiB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTIzRjFcdUZFMEYgVElFTVBPIExFTlRPJyxcclxuICAgICAgICBvblN0YXJ0KCkge30sIG9uVXBkYXRlKCkge30sXHJcbiAgICAgICAgb25EcmF3KCkgeyBkcmF3RmxhdFRpbnQoJ3JnYmEoNzAsODAsMTIwLDAuMDgpJyk7IH1cclxuICAgIH0sXHJcbiAgICBPVkVSQ0hBUkdFOiB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTI2QTEgU09CUkVDQVJHQScsXHJcbiAgICAgICAgb25TdGFydCgpIHsgZ2FtZS53ZWFwb25GaXJlUmF0ZU11bHQgPSAwLjU7IH0sIG9uVXBkYXRlKCkge30sIG9uRHJhdygpIHt9XHJcbiAgICB9XHJcbn07XHJcblxyXG5jb25zdCBFdmVudE1hbmFnZXIgPSB7XHJcbiAgICAvLyBWdWVsdmUgdG9kb3MgbG9zIG1vZGlmaWNhZG9yZXMgYSBzdSB2YWxvciBwb3IgZGVmZWN0byAoc2UgbGxhbWEgYWwgYWN0aXZhciB5IGFsIHRlcm1pbmFyKVxyXG4gICAgcmVzZXQoKSB7XHJcbiAgICAgICAgZ2FtZS5lbmVteVNwZWVkTXVsdCA9IDE7IGdhbWUuZW5lbXlTaXplTXVsdCA9IDE7IGdhbWUuZW5lbXlIcE11bHQgPSAxOyBnYW1lLmVuZW15RGFtYWdlTXVsdCA9IDE7XHJcbiAgICAgICAgZ2FtZS5wbGF5ZXJTcGVlZE11bHQgPSAxOyBnYW1lLndlYXBvblNwcmVhZEJvbnVzID0gMDsgZ2FtZS53ZWFwb25GaXJlUmF0ZU11bHQgPSAxO1xyXG4gICAgICAgIGdhbWUucHJvamVjdGlsZVNwZWVkTXVsdCA9IDE7IGdhbWUua25vY2tiYWNrTXVsdCA9IDE7IGdhbWUubW9uZXlNdWx0ID0gMTtcclxuICAgICAgICBnYW1lLnNsb3dQYXJ0aWNsZURlY2F5ID0gZmFsc2U7XHJcbiAgICAgICAgd2VhdGhlclBhcnRpY2xlcy5mb3JFYWNoKHAgPT4gcC5hY3RpdmUgPSBmYWxzZSk7XHJcbiAgICB9LFxyXG4gICAgLy8gfjI1JSBkZSBwcm9iYWJpbGlkYWQsIG51bmNhIHJlcGl0ZSBlbCBldmVudG8gaW5tZWRpYXRhbWVudGUgYW50ZXJpb3JcclxuICAgIHJvbGwoKSB7XHJcbiAgICAgICAgaWYgKE1hdGgucmFuZG9tKCkgPiAwLjI1KSByZXR1cm4gbnVsbDtcclxuICAgICAgICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXMoUkFORE9NX0VWRU5UUykuZmlsdGVyKGsgPT4gayAhPT0gZ2FtZS5sYXN0RXZlbnRLZXkpO1xyXG4gICAgICAgIHJldHVybiBrZXlzW01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGtleXMubGVuZ3RoKV07XHJcbiAgICB9LFxyXG4gICAgLy8gTXVlc3RyYSBsYSBhbGVydGEgZ3JhbmRlIH41cyBjb24gZWwganVlZ28gcGF1c2FkbywgeSBhbCB0ZXJtaW5hciBlamVjdXRhIG9uQ29tcGxldGVcclxuICAgIHNob3dBbGVydChrZXksIG9uQ29tcGxldGUpIHtcclxuICAgICAgICBnYW1lLnBhdXNlZCA9IHRydWU7XHJcbiAgICAgICAgY29uc3QgZGVmID0gUkFORE9NX0VWRU5UU1trZXldO1xyXG4gICAgICAgIGNvbnN0IGFsZXJ0RWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXZlbnQtYWxlcnQnKTtcclxuICAgICAgICBpZiAoYWxlcnRFbCkge1xyXG4gICAgICAgICAgICBhbGVydEVsLnF1ZXJ5U2VsZWN0b3IoJy5ldmVudC1hbGVydC10aXRsZScpLmlubmVyVGV4dCA9IGRlZi5sYWJlbDtcclxuICAgICAgICAgICAgYWxlcnRFbC5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgaWYgKGFsZXJ0RWwpIGFsZXJ0RWwuc3R5bGUuZGlzcGxheSA9ICdub25lJztcclxuICAgICAgICAgICAgb25Db21wbGV0ZSgpO1xyXG4gICAgICAgIH0sIDUwMDApO1xyXG4gICAgfSxcclxuICAgIGFjdGl2YXRlKGtleSkge1xyXG4gICAgICAgIHRoaXMucmVzZXQoKTtcclxuICAgICAgICBnYW1lLmFjdGl2ZUV2ZW50ID0ga2V5O1xyXG4gICAgICAgIGdhbWUubGFzdEV2ZW50S2V5ID0ga2V5O1xyXG4gICAgICAgIGNvbnN0IGRlZiA9IFJBTkRPTV9FVkVOVFNba2V5XTtcclxuICAgICAgICBpZiAoZGVmLmFtYmllbnQpIEFtYmllbnRBdWRpby5wbGF5KGRlZi5hbWJpZW50KTtcclxuICAgICAgICBpZiAoZGVmLm9uU3RhcnQpIGRlZi5vblN0YXJ0KCk7XHJcbiAgICAgICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXZlbnQtYmFkZ2UnKTtcclxuICAgICAgICBpZiAoYmFkZ2UpIHsgYmFkZ2UuaW5uZXJUZXh0ID0gZGVmLmxhYmVsOyBiYWRnZS5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJzsgfVxyXG4gICAgfSxcclxuICAgIGRlYWN0aXZhdGUoKSB7XHJcbiAgICAgICAgaWYgKCFnYW1lLmFjdGl2ZUV2ZW50KSByZXR1cm47XHJcbiAgICAgICAgQW1iaWVudEF1ZGlvLnN0b3AoKTtcclxuICAgICAgICBnYW1lLmFjdGl2ZUV2ZW50ID0gbnVsbDtcclxuICAgICAgICB0aGlzLnJlc2V0KCk7XHJcbiAgICAgICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXZlbnQtYmFkZ2UnKTtcclxuICAgICAgICBpZiAoYmFkZ2UpIGJhZGdlLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XHJcbiAgICB9LFxyXG4gICAgdXBkYXRlKCkge1xyXG4gICAgICAgIGlmICghZ2FtZS5hY3RpdmVFdmVudCkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGRlZiA9IFJBTkRPTV9FVkVOVFNbZ2FtZS5hY3RpdmVFdmVudF07XHJcbiAgICAgICAgaWYgKGRlZi5vblVwZGF0ZSkgZGVmLm9uVXBkYXRlKCk7XHJcbiAgICB9LFxyXG4gICAgZHJhd092ZXJsYXkoKSB7XHJcbiAgICAgICAgdXBkYXRlQW5kRHJhd1dlYXRoZXJQYXJ0aWNsZXMoKTtcclxuICAgICAgICBpZiAoIWdhbWUuYWN0aXZlRXZlbnQpIHJldHVybjtcclxuICAgICAgICBjb25zdCBkZWYgPSBSQU5ET01fRVZFTlRTW2dhbWUuYWN0aXZlRXZlbnRdO1xyXG4gICAgICAgIGlmIChkZWYub25EcmF3KSBkZWYub25EcmF3KCk7XHJcbiAgICB9XHJcbn07XHJcblxuLy8jIHNvdXJjZVVSTD1ldmVudHMuanNcblxuLyogPT09PT09PT09PT09PT09PT0gd29ybGQuanMgPT09PT09PT09PT09PT09PT0gKi9cbi8qKlxyXG4gKiBHRU5FUkFDSVx1MDBEM04gREUgVEVSUkVOTyBQUk9DRURVUkFMIChMSUdFUk8pXHJcbiAqL1xyXG5mdW5jdGlvbiBjcmVhdGVQcm9jZWR1cmFsVGVycmFpbigpIHtcclxuICAgIGNvbnN0IG9mZkNhbnZhcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpO1xyXG4gICAgb2ZmQ2FudmFzLndpZHRoID0gNTEyOyBvZmZDYW52YXMuaGVpZ2h0ID0gNTEyO1xyXG4gICAgY29uc3Qgb0N0eCA9IG9mZkNhbnZhcy5nZXRDb250ZXh0KCcyZCcpO1xyXG4gICAgXHJcbiAgICAvLyBCYXNlIGdyYXNzXHJcbiAgICBvQ3R4LmZpbGxTdHlsZSA9ICcjM2U0YTNkJztcclxuICAgIG9DdHguZmlsbFJlY3QoMCwgMCwgNTEyLCA1MTIpO1xyXG5cclxuICAgIC8vIFZhcmlhY2lvbmVzIGRlIHBhc3RvXHJcbiAgICBmb3IobGV0IGk9MDsgaTwzMDA7IGkrKykge1xyXG4gICAgICAgIG9DdHguZmlsbFN0eWxlID0gTWF0aC5yYW5kb20oKSA+IDAuNSA/ICcjNDU1MzQ0JyA6ICcjMzg0MjM2JztcclxuICAgICAgICBvQ3R4LmJlZ2luUGF0aCgpO1xyXG4gICAgICAgIG9DdHguYXJjKE1hdGgucmFuZG9tKCkqNTEyLCBNYXRoLnJhbmRvbSgpKjUxMiwgTWF0aC5yYW5kb20oKSoxNSwgMCwgTWF0aC5QSSoyKTtcclxuICAgICAgICBvQ3R4LmZpbGwoKTtcclxuICAgIH1cclxuICAgIC8vIFpvbmFzIGRlIHRpZXJyYVxyXG4gICAgZm9yKGxldCBpPTA7IGk8MTU7IGkrKykge1xyXG4gICAgICAgIG9DdHguZmlsbFN0eWxlID0gJ3JnYmEoOTIsIDY0LCA1MSwgMC4xNSknO1xyXG4gICAgICAgIG9DdHguYmVnaW5QYXRoKCk7XHJcbiAgICAgICAgb0N0eC5hcmMoTWF0aC5yYW5kb20oKSo1MTIsIE1hdGgucmFuZG9tKCkqNTEyLCAyMCArIE1hdGgucmFuZG9tKCkqNDAsIDAsIE1hdGguUEkqMik7XHJcbiAgICAgICAgb0N0eC5maWxsKCk7XHJcbiAgICB9XHJcbiAgICAvLyBQaWVkcml0YXMgeSBkZXRhbGxlcyBvc2N1cm9zXHJcbiAgICBmb3IobGV0IGk9MDsgaTwxNTA7IGkrKykge1xyXG4gICAgICAgIG9DdHguZmlsbFN0eWxlID0gTWF0aC5yYW5kb20oKSA+IDAuNSA/ICcjMmMzZTUwJyA6ICcjMWUyNzJlJztcclxuICAgICAgICBvQ3R4Lmdsb2JhbEFscGhhID0gMC40O1xyXG4gICAgICAgIG9DdHguYmVnaW5QYXRoKCk7XHJcbiAgICAgICAgb0N0eC5hcmMoTWF0aC5yYW5kb20oKSo1MTIsIE1hdGgucmFuZG9tKCkqNTEyLCAxICsgTWF0aC5yYW5kb20oKSoyLCAwLCBNYXRoLlBJKjIpO1xyXG4gICAgICAgIG9DdHguZmlsbCgpO1xyXG4gICAgfVxyXG4gICAgb0N0eC5nbG9iYWxBbHBoYSA9IDE7XHJcbiAgICByZXR1cm4gY3R4LmNyZWF0ZVBhdHRlcm4ob2ZmQ2FudmFzLCAncmVwZWF0Jyk7XHJcbn1cclxuY29uc3QgdGVycmFpblBhdHRlcm4gPSBjcmVhdGVQcm9jZWR1cmFsVGVycmFpbigpO1xyXG5cclxuLyoqXHJcbiAqIFBST1BTIFBST0NFRFVSQUxFUyBDT04gQ09MSVNJT05FUyBZIFZBUklBTlRFU1xyXG4gKi9cclxuY2xhc3MgUHJvcCB7XHJcbiAgICBjb25zdHJ1Y3Rvcih0eXBlKSB7XHJcbiAgICAgICAgdGhpcy50eXBlID0gdHlwZTtcclxuICAgICAgICB0aGlzLnggPSBNYXRoLnJhbmRvbSgpICogTUFQX1NJWkU7XHJcbiAgICAgICAgdGhpcy55ID0gTWF0aC5yYW5kb20oKSAqIE1BUF9TSVpFO1xyXG4gICAgICAgIHRoaXMucm90ID0gTWF0aC5yYW5kb20oKSAqIE1hdGguUEkgKiAyO1xyXG4gICAgICAgIHRoaXMuc2NhbGUgPSAwLjggKyBNYXRoLnJhbmRvbSgpICogMC41O1xyXG4gICAgICAgIFxyXG4gICAgICAgIC8vIEFzaWduYWNpXHUwMEYzbiBkZSByYWRpb3MgeSBzb2xpZGV6IHNlZ1x1MDBGQW4gdGlwb1xyXG4gICAgICAgIGlmIChbJ3JvY2snLCAncm9ja190YWxsJywgJ3JvY2tfc3BsaXQnLCAndHJlZScsICd0cmVlX3BpbmUnLCAndHJlZV9kZWFkJywgJ2NyYXRlJ10uaW5jbHVkZXModHlwZSkpIHtcclxuICAgICAgICAgICAgdGhpcy5pc1NvbGlkID0gdHJ1ZTtcclxuICAgICAgICAgICAgdGhpcy5yYWRpdXMgPSB0eXBlLmluY2x1ZGVzKCd0cmVlJykgPyAxNSAqIHRoaXMuc2NhbGUgOiAodHlwZSA9PT0gJ2NyYXRlJyA/IDI1ICogdGhpcy5zY2FsZSA6IDIwICogdGhpcy5zY2FsZSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGhpcy5pc1NvbGlkID0gZmFsc2U7XHJcbiAgICAgICAgICAgIHRoaXMucmFkaXVzID0gMDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBkcmF3U2hhZG93KGNhbSkge1xyXG4gICAgICAgIGlmICghaXNWaXNpYmxlKHRoaXMueCwgdGhpcy55LCA0MCwgY2FtKSkgcmV0dXJuO1xyXG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSBcInJnYmEoMCwwLDAsMC4zNSlcIjtcclxuICAgICAgICBjdHguYmVnaW5QYXRoKCk7XHJcbiAgICAgICAgY3R4LmVsbGlwc2UodGhpcy54IC0gY2FtLnggKyAxNSp0aGlzLnNjYWxlLCB0aGlzLnkgLSBjYW0ueSArIDEwKnRoaXMuc2NhbGUsIDM1KnRoaXMuc2NhbGUsIDIwKnRoaXMuc2NhbGUsIDAsIDAsIE1hdGguUEkqMik7XHJcbiAgICAgICAgY3R4LmZpbGwoKTtcclxuICAgIH1cclxuICAgIGRyYXcoY2FtKSB7XHJcbiAgICAgICAgaWYgKCFpc1Zpc2libGUodGhpcy54LCB0aGlzLnksIDUwICogdGhpcy5zY2FsZSwgY2FtKSkgcmV0dXJuO1xyXG4gICAgICAgIGN0eC5zYXZlKCk7XHJcbiAgICAgICAgY3R4LnRyYW5zbGF0ZSh0aGlzLnggLSBjYW0ueCwgdGhpcy55IC0gY2FtLnkpO1xyXG4gICAgICAgIGN0eC5yb3RhdGUodGhpcy5yb3QpO1xyXG4gICAgICAgIGN0eC5zY2FsZSh0aGlzLnNjYWxlLCB0aGlzLnNjYWxlKTtcclxuICAgICAgICBcclxuICAgICAgICBpZiAodGhpcy50eXBlLmluY2x1ZGVzKCdyb2NrJykpIHtcclxuICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjN2Y4YzhkJzsgY3R4LnN0cm9rZVN0eWxlID0gJyMyYzNlNTAnOyBjdHgubGluZVdpZHRoID0gMjtcclxuICAgICAgICAgICAgY3R4LmJlZ2luUGF0aCgpOyBcclxuICAgICAgICAgICAgaWYgKHRoaXMudHlwZSA9PT0gJ3JvY2tfdGFsbCcpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5tb3ZlVG8oLTE1LCAxMCk7IGN0eC5saW5lVG8oLTEwLCAtNDApOyBjdHgubGluZVRvKDEwLCAtMzUpOyBjdHgubGluZVRvKDE1LCAxMCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy50eXBlID09PSAncm9ja19zcGxpdCcpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5tb3ZlVG8oLTIwLCAtNSk7IGN0eC5saW5lVG8oLTUsIC0yMCk7IGN0eC5saW5lVG8oMCwgMCk7IGN0eC5saW5lVG8oMTUsIC0xNSk7IGN0eC5saW5lVG8oMjUsIDEwKTsgY3R4LmxpbmVUbygtMjUsIDEwKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGN0eC5tb3ZlVG8oLTIwLCAtMTApOyBjdHgubGluZVRvKDEwLCAtMjUpOyBjdHgubGluZVRvKDMwLCA1KTsgY3R4LmxpbmVUbygxMCwgMjApOyBjdHgubGluZVRvKC0yNSwgMTApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGN0eC5jbG9zZVBhdGgoKTsgY3R4LmZpbGwoKTsgY3R4LnN0cm9rZSgpO1xyXG4gICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJ3JnYmEoMjU1LDI1NSwyNTUsMC4xKSc7IGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYygtNSwgLTUsIDEwLCAwLCBNYXRoLlBJKTsgY3R4LmZpbGwoKTtcclxuICAgICAgICB9IFxyXG4gICAgICAgIGVsc2UgaWYgKHRoaXMudHlwZS5pbmNsdWRlcygndHJlZScpKSB7XHJcbiAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzVjNDAzMyc7IGN0eC5zdHJva2VTdHlsZSA9ICcjM2UyNzIzJzsgY3R4LmxpbmVXaWR0aCA9IDI7XHJcbiAgICAgICAgICAgIGN0eC5maWxsUmVjdCgtNSwgLTEwLCAxMCwgMjApOyBjdHguc3Ryb2tlUmVjdCgtNSwgLTEwLCAxMCwgMjApO1xyXG4gICAgICAgICAgICBpZiAodGhpcy50eXBlID09PSAndHJlZV9waW5lJykge1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMWU4NDQ5JzsgY3R4LnN0cm9rZVN0eWxlID0gJyMxNDVhMzInO1xyXG4gICAgICAgICAgICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRvKDAsIC01MCk7IGN0eC5saW5lVG8oLTI1LCAwKTsgY3R4LmxpbmVUbygyNSwgMCk7IGN0eC5jbG9zZVBhdGgoKTsgY3R4LmZpbGwoKTsgY3R4LnN0cm9rZSgpO1xyXG4gICAgICAgICAgICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRvKDAsIC0zMCk7IGN0eC5saW5lVG8oLTMwLCAxNSk7IGN0eC5saW5lVG8oMzAsIDE1KTsgY3R4LmNsb3NlUGF0aCgpOyBjdHguZmlsbCgpOyBjdHguc3Ryb2tlKCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy50eXBlID09PSAndHJlZScpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzI3YWU2MCc7IGN0eC5zdHJva2VTdHlsZSA9ICcjMWU4NDQ5JztcclxuICAgICAgICAgICAgICAgIGZvcihsZXQgaT0wOyBpPDQ7IGkrKykge1xyXG4gICAgICAgICAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYyhNYXRoLmNvcyhpKjEuNSkqMTUsIC0xNSArIE1hdGguc2luKGkqMS41KSoxMCwgMjAsIDAsIE1hdGguUEkqMik7IGN0eC5maWxsKCk7IGN0eC5zdHJva2UoKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLnR5cGUgPT09ICd0cmVlX2RlYWQnKSB7XHJcbiAgICAgICAgICAgICAgICBjdHguc3Ryb2tlU3R5bGUgPSAnIzVjNDAzMyc7IGN0eC5saW5lV2lkdGggPSAzOyBjdHgubGluZUNhcCA9ICdyb3VuZCc7XHJcbiAgICAgICAgICAgICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8oMCwwKTsgY3R4LmxpbmVUbygtMTUsIC0zMCk7IGN0eC5zdHJva2UoKTtcclxuICAgICAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbygwLDApOyBjdHgubGluZVRvKDE1LCAtMjUpOyBjdHguc3Ryb2tlKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgZWxzZSBpZiAodGhpcy50eXBlID09PSAnY3JhdGUnKSB7XHJcbiAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnI2QzNTQwMCc7IGN0eC5zdHJva2VTdHlsZSA9ICcjODczNjAwJzsgY3R4LmxpbmVXaWR0aCA9IDM7XHJcbiAgICAgICAgICAgIGN0eC5maWxsUmVjdCgtMjAsIC0yMCwgNDAsIDQwKTsgY3R4LnN0cm9rZVJlY3QoLTIwLCAtMjAsIDQwLCA0MCk7XHJcbiAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbygtMjAsIC0yMCk7IGN0eC5saW5lVG8oMjAsIDIwKTsgY3R4Lm1vdmVUbygyMCwgLTIwKTsgY3R4LmxpbmVUbygtMjAsIDIwKTsgY3R4LnN0cm9rZSgpO1xyXG4gICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJ3JnYmEoMCwwLDAsMC4yKSc7IGN0eC5maWxsUmVjdCgwLCAtMjAsIDIwLCA0MCk7XHJcbiAgICAgICAgfSBlbHNlIGlmICh0aGlzLnR5cGUgPT09ICdidXNoJykge1xyXG4gICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMxZTg0NDknOyBjdHguc3Ryb2tlU3R5bGUgPSAnIzE0NWEzMic7IGN0eC5saW5lV2lkdGggPSAyO1xyXG4gICAgICAgICAgICBmb3IobGV0IGk9MDsgaTwzOyBpKyspIHtcclxuICAgICAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYyhNYXRoLmNvcyhpKjIuMSkqMTAsIE1hdGguc2luKGkqMi4xKSoxMCwgMTUsIDAsIE1hdGguUEkqMik7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbCgpOyBjdHguc3Ryb2tlKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2UgaWYgKHRoaXMudHlwZSA9PT0gJ3BlYmJsZXMnKSB7XHJcbiAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzk1YTVhNic7XHJcbiAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYygtNSwgLTIsIDMsIDAsIE1hdGguUEkqMik7IGN0eC5maWxsKCk7XHJcbiAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYyg1LCAzLCAyLCAwLCBNYXRoLlBJKjIpOyBjdHguZmlsbCgpO1xyXG4gICAgICAgICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmMoMCwgNSwgNCwgMCwgTWF0aC5QSSoyKTsgY3R4LmZpbGwoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY3R4LnJlc3RvcmUoKTtcclxuICAgIH1cclxufVxyXG5cclxuLy8gR3JpZCBlc3BhY2lhbDogYWdydXBhIHByb3BzIHNcdTAwRjNsaWRvcyBlbiBjZWxkYXMgcGFyYSBubyBjaGVxdWVhciBjb2xpc2lcdTAwRjNuIGNvbnRyYSBUT0RPUyBsb3MgcHJvcHNcclxuZ2FtZS5idWlsZFByb3BHcmlkID0gZnVuY3Rpb24oKSB7XHJcbiAgICB0aGlzLnByb3BHcmlkU2l6ZSA9IDIwMDtcclxuICAgIHRoaXMucHJvcEdyaWQgPSBuZXcgTWFwKCk7XHJcbiAgICAvLyBBcnJheSByZXV0aWxpemFibGUgZGV2dWVsdG8gcG9yIGdldE5lYXJieVByb3BzOiBzZSBjb25zdW1lIHNpZW1wcmUgZGUgZm9ybWFcclxuICAgIC8vIHNcdTAwRURuY3JvbmEgZSBpbm1lZGlhdGEgZW4gY2FkYSBjYWxsIHNpdGUsIGFzXHUwMEVEIHF1ZSBldml0YXIgY3JlYXIgdW4gYXJyYXkgbnVldm9cclxuICAgIC8vIHBvciBjYWRhIGNvbnN1bHRhIChqdWdhZG9yICsgY2FkYSBlbmVtaWdvIGNlcmNhbm8gKyBjYWRhIHByb3llY3RpbCBhY3Rpdm8sXHJcbiAgICAvLyB0b2RvcyBsb3MgZnJhbWVzKSByZWR1Y2UgbXVjaG8gbGEgYmFzdXJhIGdlbmVyYWRhIHBhcmEgZWwgR2FyYmFnZSBDb2xsZWN0b3IuXHJcbiAgICB0aGlzLl9uZWFyYnlQcm9wc1NjcmF0Y2ggPSBbXTtcclxuICAgIHRoaXMucHJvcHMuZm9yRWFjaChwID0+IHtcclxuICAgICAgICBpZiAoIXAuaXNTb2xpZCkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGtleSA9IHRoaXMucHJvcEdyaWRLZXkocC54LCBwLnkpO1xyXG4gICAgICAgIGlmICghdGhpcy5wcm9wR3JpZC5oYXMoa2V5KSkgdGhpcy5wcm9wR3JpZC5zZXQoa2V5LCBbXSk7XHJcbiAgICAgICAgdGhpcy5wcm9wR3JpZC5nZXQoa2V5KS5wdXNoKHApO1xyXG4gICAgfSk7XHJcbn07XHJcbmdhbWUucHJvcEdyaWRLZXkgPSBmdW5jdGlvbih4LCB5KSB7XHJcbiAgICAvLyBDbGF2ZSBudW1cdTAwRTlyaWNhIGVuIHZleiBkZSB0ZW1wbGF0ZSBzdHJpbmc6IG1pc21vIHJlc3VsdGFkbyAodW5hIGNlbGRhID0gdW5hXHJcbiAgICAvLyBjbGF2ZSBcdTAwRkFuaWNhKSwgcGVybyBzaW4gbGEgYXNpZ25hY2lcdTAwRjNuIGRlIG1lbW9yaWEgcXVlIGltcGxpY2EgY29uc3RydWlyIHVuXHJcbiAgICAvLyBzdHJpbmcgbnVldm8gZW4gY2FkYSBsbGFtYWRhIChzZSBsbGFtYSBtdWNoYXMgdmVjZXMgcG9yIGZyYW1lKS5cclxuICAgIHJldHVybiBNYXRoLmZsb29yKHggLyB0aGlzLnByb3BHcmlkU2l6ZSkgKiAxMDAwMDAgKyBNYXRoLmZsb29yKHkgLyB0aGlzLnByb3BHcmlkU2l6ZSk7XHJcbn07XHJcbi8vIERldnVlbHZlIHNvbG8gbG9zIHByb3BzIHNcdTAwRjNsaWRvcyBjZXJjYW5vcyAoY2VsZGEgYWN0dWFsICsgOCB2ZWNpbmFzKVxyXG5nYW1lLmdldE5lYXJieVByb3BzID0gZnVuY3Rpb24oeCwgeSkge1xyXG4gICAgY29uc3QgZ3ggPSBNYXRoLmZsb29yKHggLyB0aGlzLnByb3BHcmlkU2l6ZSk7XHJcbiAgICBjb25zdCBneSA9IE1hdGguZmxvb3IoeSAvIHRoaXMucHJvcEdyaWRTaXplKTtcclxuICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuX25lYXJieVByb3BzU2NyYXRjaDtcclxuICAgIHJlc3VsdC5sZW5ndGggPSAwO1xyXG4gICAgZm9yKGxldCBkeD0tMTsgZHg8PTE7IGR4KyspIHtcclxuICAgICAgICBmb3IobGV0IGR5PS0xOyBkeTw9MTsgZHkrKykge1xyXG4gICAgICAgICAgICBjb25zdCBhcnIgPSB0aGlzLnByb3BHcmlkLmdldCgoZ3grZHgpICogMTAwMDAwICsgKGd5K2R5KSk7XHJcbiAgICAgICAgICAgIGlmKGFycikgZm9yKGxldCBpPTA7IGk8YXJyLmxlbmd0aDsgaSsrKSByZXN1bHQucHVzaChhcnJbaV0pO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn07XHJcblxyXG5jb25zdCBXRUFQT05fQ09TVFMgPSB7XHJcbiAgICBSRVZPTFZFUjogNTAwLCBNQUNIRVRFOiA0MDAsIFVaSTogNjAwLCBDUk9TU0JPVzogNzAwLCBTSE9UR1VOOiAxMDAwLCBBSzQ3OiAxODAwLCBNSU5JR1VOOiAyNTAwLCBTTklQRVI6IDIyMDAsXHJcbiAgICBNUDU6IDkwMCwgUDkwOiAxMzAwLCBTQVdFRE9GRjogMTEwMCwgQUExMjogMjAwMCwgTTRBMTogMTYwMCwgRkFNQVM6IDE1MDAsIFNDQVI6IDIxMDAsIFdJTkNIRVNURVI6IDE0MDAsXHJcbiAgICBBV1A6IDMyMDAsIE0yNDk6IDI2MDAsIFJQRzogMzUwMCwgRkxBTUVUSFJPV0VSOiAyNDAwLCBDSEFJTlNBVzogMTcwMFxyXG59O1xyXG5cclxuZ2FtZS5zdGFydE5leHRXYXZlID0gZnVuY3Rpb24oKSB7XHJcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2hvcC1tZW51Jykuc3R5bGUuZGlzcGxheSA9ICdub25lJztcclxuICAgIGNvbnN0IGV2ZW50S2V5ID0gRXZlbnRNYW5hZ2VyLnJvbGwoKTtcclxuICAgIGlmIChldmVudEtleSkge1xyXG4gICAgICAgIEV2ZW50TWFuYWdlci5zaG93QWxlcnQoZXZlbnRLZXksICgpID0+IHtcclxuICAgICAgICAgICAgRXZlbnRNYW5hZ2VyLmFjdGl2YXRlKGV2ZW50S2V5KTtcclxuICAgICAgICAgICAgdGhpcy5fbGF1bmNoV2F2ZSgpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICB0aGlzLl9sYXVuY2hXYXZlKCk7XHJcbiAgICB9XHJcbn07XHJcblxyXG5nYW1lLl9sYXVuY2hXYXZlID0gZnVuY3Rpb24oKSB7XHJcbiAgICB0aGlzLmlzV2F2ZUFjdGl2ZSA9IHRydWU7XHJcbiAgICB0aGlzLnBhdXNlZCA9IGZhbHNlO1xyXG4gICAgTXVzaWNNYW5hZ2VyLnRyYWNrcyA9IE11c2ljTWFuYWdlci5jb21iYXRUcmFja3M7XHJcbiAgICBNdXNpY01hbmFnZXIubmV4dCgxMjAwKTtcclxuICAgIFxyXG4gICAgbGV0IGNvdW50ID0gMTUgKyAodGhpcy53YXZlICogOCk7XHJcbiAgICBpZiAodGhpcy5hY3RpdmVFdmVudCA9PT0gJ0lOVkFTSU9OJykgY291bnQgKj0gMjsgLy8gZWwgZG9ibGUgZGUgZW5lbWlnb3MgZHVyYW50ZSBsYSBpbnZhc2lcdTAwRjNuXHJcbiAgICBmb3IobGV0IGk9MDsgaTxjb3VudDsgaSsrKSB7XHJcbiAgICAgICAgbGV0IGEgPSBNYXRoLnJhbmRvbSgpICogTWF0aC5QSSAqIDI7XHJcbiAgICAgICAgbGV0IGQgPSA4MDAgKyBNYXRoLnJhbmRvbSgpICogNjAwO1xyXG4gICAgICAgIGxldCB0eXBlID0gdGhpcy53YXZlID4gNiAmJiBNYXRoLnJhbmRvbSgpID4gMC44NSA/ICdHSE9TVCcgOiAodGhpcy53YXZlID4gNCAmJiBNYXRoLnJhbmRvbSgpID4gMC44NSA/ICdJTlZJU0lCTEUnIDogKHRoaXMud2F2ZSA+IDMgJiYgTWF0aC5yYW5kb20oKSA+IDAuODUgPyAnS0FNSUtBWkUnIDogKHRoaXMud2F2ZSA+IDMgJiYgTWF0aC5yYW5kb20oKSA+IDAuOCA/ICdUQU5LJyA6ICh0aGlzLndhdmUgPiAyICYmIE1hdGgucmFuZG9tKCkgPiAwLjcgPyAnUkFOR0VEJyA6ICh0aGlzLndhdmUgPiAxICYmIE1hdGgucmFuZG9tKCkgPiAwLjggPyAnRkFTVCcgOiAnQkFTSUMnKSkpKSk7XHJcbiAgICAgICAgbGV0IHBvcyA9IHRoaXMuZmluZENsZWFyU3Bhd24odGhpcy5wbGF5ZXIueCArIE1hdGguY29zKGEpKmQsIHRoaXMucGxheWVyLnkgKyBNYXRoLnNpbihhKSpkKTtcclxuICAgICAgICB0aGlzLmVuZW1pZXMucHVzaChuZXcgRW5lbXkocG9zLngsIHBvcy55LCB0eXBlKSk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQ29uZmlndXJhciBzaSBhcGFyZWNlclx1MDBFMSB1biBqZWZlIGVuIGJhc2UgYSBsYSB3YXZlXHJcbiAgICBpZiAodGhpcy53YXZlID09PSA1IHx8IHRoaXMud2F2ZSA9PT0gMTUgfHwgdGhpcy53YXZlID09PSAzMCB8fCAodGhpcy53YXZlID4gMzAgJiYgKHRoaXMud2F2ZSAtIDMwKSAlIDEwID09PSAwKSkge1xyXG4gICAgICAgIHRoaXMuYm9zc1BlbmRpbmcgPSB0cnVlO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICB0aGlzLmJvc3NQZW5kaW5nID0gZmFsc2U7XHJcbiAgICB9XHJcbn07XHJcblxyXG5nYW1lLnNwYXduQm9zcyA9IGZ1bmN0aW9uKCkge1xyXG4gICAgbGV0IGEgPSBNYXRoLnJhbmRvbSgpICogTWF0aC5QSSAqIDI7XHJcbiAgICBsZXQgYm9zc1BvcyA9IHRoaXMuZmluZENsZWFyU3Bhd24odGhpcy5wbGF5ZXIueCArIE1hdGguY29zKGEpKjgwMCwgdGhpcy5wbGF5ZXIueSArIE1hdGguc2luKGEpKjgwMCk7XHJcbiAgICB0aGlzLmVuZW1pZXMucHVzaChuZXcgRW5lbXkoYm9zc1Bvcy54LCBib3NzUG9zLnksICdCT1NTJykpO1xyXG4gICAgTXVzaWNNYW5hZ2VyLnN3aXRjaENvbnRleHQoTXVzaWNNYW5hZ2VyLmJvc3NUcmFja3MsIDEwMDApO1xyXG59O1xyXG5cclxuZ2FtZS5maW5kQ2xlYXJTcGF3biA9IGZ1bmN0aW9uKHgsIHkpIHtcclxuICAgIGZvcihsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCA4OyBhdHRlbXB0KyspIHtcclxuICAgICAgICBsZXQgYmxvY2tlZCA9IHRoaXMucHJvcHMuc29tZShwID0+IHAuaXNTb2xpZCAmJiBNYXRoLmh5cG90KHggLSBwLngsIHkgLSBwLnkpIDwgcC5yYWRpdXMgKyA0NSk7XHJcbiAgICAgICAgaWYoIWJsb2NrZWQpIHJldHVybiB7IHgsIHkgfTtcclxuICAgICAgICB4ICs9IChNYXRoLnJhbmRvbSgpIC0gMC41KSAqIDIwMDtcclxuICAgICAgICB5ICs9IChNYXRoLnJhbmRvbSgpIC0gMC41KSAqIDIwMDtcclxuICAgIH1cclxuICAgIHJldHVybiB7IHgsIHkgfTtcclxufTtcclxuXHJcbi8vIEVjb25vbVx1MDBFRGFcclxuZ2FtZS5idXlBbW1vID0gZnVuY3Rpb24oKSB7XHJcbiAgICBpZih0aGlzLnBsYXllci5tb25leSA+PSAxNTApIHtcclxuICAgICAgICB0aGlzLnBsYXllci5tb25leSAtPSAxNTA7XHJcbiAgICAgICAgdGhpcy5wbGF5ZXIuaW52ZW50b3J5LmZvckVhY2godyA9PiB7IGlmKHcgJiYgdy50eXBlID09PSAncmFuZ2UnKSB3LmFtbW8gPSB3LmNhcGFjaXR5OyB9KTtcclxuICAgICAgICBwbGF5U0ZYKCdyZWxvYWQnKTtcclxuICAgIH1cclxufTtcclxuXHJcbmdhbWUuYnV5SGVhbHRoID0gZnVuY3Rpb24oKSB7XHJcbiAgICBpZih0aGlzLnBsYXllci5tb25leSA+PSAyMDAgJiYgdGhpcy5wbGF5ZXIuaHAgPCB0aGlzLnBsYXllci5tYXhIcCkge1xyXG4gICAgICAgIHRoaXMucGxheWVyLm1vbmV5IC09IDIwMDsgdGhpcy5wbGF5ZXIuaHAgPSB0aGlzLnBsYXllci5tYXhIcDtcclxuICAgICAgICBwbGF5U0ZYKCdjb2luJyk7XHJcbiAgICB9XHJcbn07XHJcblxyXG5nYW1lLmJ1eVdlYXBvbiA9IGZ1bmN0aW9uKGspIHtcclxuICAgIGNvbnN0IHcgPSBXRUFQT05TX0RCW2tdO1xyXG4gICAgY29uc3QgY29zdCA9IFdFQVBPTl9DT1NUU1trXTtcclxuICAgIGlmKHRoaXMucGxheWVyLm1vbmV5ID49IGNvc3QpIHtcclxuICAgICAgICBsZXQgc2xvdCA9IHRoaXMucGxheWVyLmludmVudG9yeS5maW5kSW5kZXgocyA9PiBzID09PSBudWxsKTtcclxuICAgICAgICBpZihzbG90ICE9PSAtMSkge1xyXG4gICAgICAgICAgICB0aGlzLnBsYXllci5tb25leSAtPSBjb3N0O1xyXG4gICAgICAgICAgICB0aGlzLnBsYXllci5pbnZlbnRvcnlbc2xvdF0gPSB7IC4uLncsIGFtbW86IHcuY2FwYWNpdHkgfTtcclxuICAgICAgICAgICAgcGxheVNGWCgncmVsb2FkJyk7XHJcbiAgICAgICAgICAgIHRoaXMudXBkYXRlU2hvcCgpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufTtcclxuXHJcbmdhbWUuc2VsbFdlYXBvbiA9IGZ1bmN0aW9uKGspIHtcclxuICAgIGxldCBpZHggPSB0aGlzLnBsYXllci5pbnZlbnRvcnkuZmluZEluZGV4KGkgPT4gaSAmJiBpLm5hbWUgPT09IGspO1xyXG4gICAgaWYoaWR4ID09PSAtMSkgcmV0dXJuO1xyXG4gICAgY29uc3QgcmVmdW5kID0gTWF0aC5mbG9vcihXRUFQT05fQ09TVFNba10gLyAyKTtcclxuICAgIHRoaXMucGxheWVyLm1vbmV5ICs9IHJlZnVuZDtcclxuICAgIHRoaXMucGxheWVyLmludmVudG9yeVtpZHhdID0gbnVsbDtcclxuICAgIGlmKHRoaXMucGxheWVyLmFjdGl2ZVNsb3QgPT09IGlkeCkge1xyXG4gICAgICAgIGxldCBmYWxsYmFjayA9IHRoaXMucGxheWVyLmludmVudG9yeS5maW5kSW5kZXgocyA9PiBzICE9PSBudWxsKTtcclxuICAgICAgICB0aGlzLnBsYXllci5hY3RpdmVTbG90ID0gZmFsbGJhY2sgIT09IC0xID8gZmFsbGJhY2sgOiAwO1xyXG4gICAgfVxyXG4gICAgcGxheVNGWCgnY29pbicpO1xyXG4gICAgdGhpcy51cGRhdGVTaG9wKCk7XHJcbn07XHJcblxuLy8jIHNvdXJjZVVSTD13b3JsZC5qc1xuXG4vKiA9PT09PT09PT09PT09PT09PSB3ZWFwb25zLmpzID09PT09PT09PT09PT09PT09ICovXG4vKipcclxuICogQ09ORklHVVJBQ0lcdTAwRDNOIERFIEFSTUFTXHJcbiAqIChFeHRyYVx1MDBFRGRvIGRlIHBsYXllci5qcyBwb3Igb3JnYW5pemFjaVx1MDBGM24uIE1pc21vIG9iamV0byBXRUFQT05TX0RCIGRlIHNpZW1wcmUsXHJcbiAqIG5pbmdcdTAwRkFuIHZhbG9yIGZ1ZSBtb2RpZmljYWRvLilcclxuICovXHJcbmNvbnN0IFdFQVBPTlNfREIgPSB7XHJcbiAgICAvLyAtLS0gTUVMXHUwMEM5IC0tLVxyXG4gICAgS05JRkU6ICAgIHsgbmFtZTogJ0tOSUZFJywgZGFtYWdlOiA2MCwgZmlyZVJhdGU6IDI1MCwgY2FwYWNpdHk6IEluZmluaXR5LCByZWxvYWRUaW1lOiAwLCBzcGVlZDogNSwgcmFuZ2U6IDY1LCB0eXBlOiAnbWVsZWUnLCBjb2xvcjogJyNiZGMzYzcnLCBzaGFrZTogMiwgc3ByZWFkOiAwIH0sXHJcbiAgICBNQUNIRVRFOiAgeyBuYW1lOiAnTUFDSEVURScsIGRhbWFnZTogMTAwLCBmaXJlUmF0ZTogMzIwLCBjYXBhY2l0eTogSW5maW5pdHksIHJlbG9hZFRpbWU6IDAsIHNwZWVkOiA1LCByYW5nZTogOTUsIHR5cGU6ICdtZWxlZScsIGNvbG9yOiAnI2VjZjBmMScsIHNoYWtlOiA0LCBzcHJlYWQ6IDAgfSxcclxuICAgIENIQUlOU0FXOiB7IG5hbWU6ICdDSEFJTlNBVycsIGRhbWFnZTogOSwgZmlyZVJhdGU6IDkwLCBjYXBhY2l0eTogSW5maW5pdHksIHJlbG9hZFRpbWU6IDAsIHNwZWVkOiA1LCByYW5nZTogNjUsIHR5cGU6ICdtZWxlZScsIGNvbG9yOiAnIzdmOGM4ZCcsIHNoYWtlOiAzLCBzcHJlYWQ6IDAsIGZ1ZWw6IDEwMCwgZnVlbERyYWluOiAyLjIsIHNmeDogJ2NoYWluc2F3JyB9LFxyXG4gICAgLy8gLS0tIFBJU1RPTEFTIC0tLVxyXG4gICAgRzE4OiAgICAgIHsgbmFtZTogJ0cxOCcsIGRhbWFnZTogMjUsIGZpcmVSYXRlOiAyMDAsIGNhcGFjaXR5OiAxNSwgcmVsb2FkVGltZTogMTAwMCwgc3BlZWQ6IDE4LCB0eXBlOiAncmFuZ2UnLCBjb2xvcjogJyNmMWM0MGYnLCBzaGFrZTogMywgc3ByZWFkOiAwLjA1LCBjYXNpbmc6IHRydWUsIHNtb2tlOiAxLCBzZng6ICdzaG9vdF9HMTgnIH0sXHJcbiAgICBSRVZPTFZFUjogeyBuYW1lOiAnUkVWT0xWRVInLCBkYW1hZ2U6IDQ1LCBmaXJlUmF0ZTogNTAwLCBjYXBhY2l0eTogNiwgcmVsb2FkVGltZTogMTQwMCwgc3BlZWQ6IDIyLCB0eXBlOiAncmFuZ2UnLCBjb2xvcjogJyM5NWE1YTYnLCBzaGFrZTogNSwgc3ByZWFkOiAwLjAzLCBjYXNpbmc6IHRydWUsIHNtb2tlOiAxLCBzZng6ICdzaG9vdF9HMTgnLCBwaWVyY2U6IDMgfSxcclxuICAgIC8vIC0tLSBTVUJGVVNJTEVTIC0tLVxyXG4gICAgVVpJOiAgICAgIHsgbmFtZTogJ1VaSScsIGRhbWFnZTogMTUsIGZpcmVSYXRlOiA3MCwgY2FwYWNpdHk6IDQwLCByZWxvYWRUaW1lOiAxNTAwLCBzcGVlZDogMjAsIHR5cGU6ICdyYW5nZScsIGNvbG9yOiAnI2U2N2UyMicsIHNoYWtlOiA0LCBzcHJlYWQ6IDAuMTUsIGNhc2luZzogdHJ1ZSwgc21va2U6IDIsIHNmeDogJ3Nob290X0cxOCcgfSxcclxuICAgIE1QNTogICAgICB7IG5hbWU6ICdNUDUnLCBkYW1hZ2U6IDIyLCBmaXJlUmF0ZTogMTEwLCBjYXBhY2l0eTogMzAsIHJlbG9hZFRpbWU6IDE0MDAsIHNwZWVkOiAyMiwgdHlwZTogJ3JhbmdlJywgY29sb3I6ICcjN2Y4YzhkJywgc2hha2U6IDIsIHNwcmVhZDogMC4wMjUsIGNhc2luZzogdHJ1ZSwgc21va2U6IDEsIHNmeDogJ3Nob290X0cxOCcgfSxcclxuICAgIFA5MDogICAgICB7IG5hbWU6ICdQOTAnLCBkYW1hZ2U6IDE4LCBmaXJlUmF0ZTogOTAsIGNhcGFjaXR5OiA1MCwgcmVsb2FkVGltZTogMTcwMCwgc3BlZWQ6IDIxLCB0eXBlOiAncmFuZ2UnLCBjb2xvcjogJyM5YjU5YjYnLCBzaGFrZTogMywgc3ByZWFkOiAwLjA2LCBjYXNpbmc6IHRydWUsIHNtb2tlOiAxLCBzZng6ICdzaG9vdF9HMTgnLCBtb2JpbGl0eTogdHJ1ZSB9LFxyXG4gICAgLy8gLS0tIEVTQ09QRVRBUyAtLS1cclxuICAgIFNIT1RHVU46ICB7IG5hbWU6ICdTSE9UR1VOJywgZGFtYWdlOiAyMCwgZmlyZVJhdGU6IDkwMCwgY2FwYWNpdHk6IDcsIHJlbG9hZFRpbWU6IDIyMDAsIHNwZWVkOiAxNSwgdHlwZTogJ3JhbmdlJywgcGVsbGV0czogOCwgY29sb3I6ICcjZTc0YzNjJywgc2hha2U6IDE1LCBzcHJlYWQ6IDAuMjIsIGNhc2luZzogdHJ1ZSwgc21va2U6IDUsIHNmeDogJ3Nob290X1NIT1RHVU4nLCBrbm9ja2JhY2s6IDIyMCB9LFxyXG4gICAgU0FXRURPRkY6IHsgbmFtZTogJ1NBV0VET0ZGJywgZGFtYWdlOiAzNSwgZmlyZVJhdGU6IDExMDAsIGNhcGFjaXR5OiAyLCByZWxvYWRUaW1lOiAxODAwLCBzcGVlZDogMTQsIHR5cGU6ICdyYW5nZScsIHBlbGxldHM6IDEwLCBjb2xvcjogJyNjMDM5MmInLCBzaGFrZTogMTgsIHNwcmVhZDogMC4zNSwgY2FzaW5nOiB0cnVlLCBzbW9rZTogNiwgc2Z4OiAnc2hvb3RfU0hPVEdVTicsIG1heFJhbmdlOiAyNjAsIGtub2NrYmFjazogMjYwIH0sXHJcbiAgICBBQTEyOiAgICAgeyBuYW1lOiAnQUExMicsIGRhbWFnZTogMTgsIGZpcmVSYXRlOiAyMjAsIGNhcGFjaXR5OiAyMCwgcmVsb2FkVGltZTogMjIwMCwgc3BlZWQ6IDE1LCB0eXBlOiAncmFuZ2UnLCBwZWxsZXRzOiA2LCBjb2xvcjogJyNlNjdlMjInLCBzaGFrZTogMTAsIHNwcmVhZDogMC4yLCBjYXNpbmc6IHRydWUsIHNtb2tlOiAzLCBzZng6ICdzaG9vdF9TSE9UR1VOJywga25vY2tiYWNrOiAxMDAgfSxcclxuICAgIC8vIC0tLSBSSUZMRVMgLS0tXHJcbiAgICBBSzQ3OiAgICAgeyBuYW1lOiAnQUs0NycsIGRhbWFnZTogNDAsIGZpcmVSYXRlOiAxNDAsIGNhcGFjaXR5OiAzMCwgcmVsb2FkVGltZTogMTgwMCwgc3BlZWQ6IDI0LCB0eXBlOiAncmFuZ2UnLCBjb2xvcjogJyMyN2FlNjAnLCBzaGFrZTogNiwgc3ByZWFkOiAwLjA4LCBjYXNpbmc6IHRydWUsIHNtb2tlOiAzLCBzZng6ICdzaG9vdF9HMTgnIH0sXHJcbiAgICBNNEExOiAgICAgeyBuYW1lOiAnTTRBMScsIGRhbWFnZTogMzIsIGZpcmVSYXRlOiAxNjAsIGNhcGFjaXR5OiAzMCwgcmVsb2FkVGltZTogMTYwMCwgc3BlZWQ6IDIzLCB0eXBlOiAncmFuZ2UnLCBjb2xvcjogJyMyZWNjNzEnLCBzaGFrZTogMywgc3ByZWFkOiAwLjAxNSwgY2FzaW5nOiB0cnVlLCBzbW9rZTogMiwgc2Z4OiAnc2hvb3RfRzE4JyB9LFxyXG4gICAgRkFNQVM6ICAgIHsgbmFtZTogJ0ZBTUFTJywgZGFtYWdlOiAyOCwgZmlyZVJhdGU6IDU1MCwgY2FwYWNpdHk6IDI0LCByZWxvYWRUaW1lOiAxNzAwLCBzcGVlZDogMjMsIHR5cGU6ICdyYW5nZScsIGNvbG9yOiAnIzM0OThkYicsIHNoYWtlOiA1LCBzcHJlYWQ6IDAuMDQsIGNhc2luZzogdHJ1ZSwgc21va2U6IDIsIHNmeDogJ3Nob290X0cxOCcsIGJ1cnN0OiAzLCBidXJzdERlbGF5OiA2NSB9LFxyXG4gICAgU0NBUjogICAgIHsgbmFtZTogJ1NDQVInLCBkYW1hZ2U6IDU1LCBmaXJlUmF0ZTogNDUwLCBjYXBhY2l0eTogMjAsIHJlbG9hZFRpbWU6IDE5MDAsIHNwZWVkOiAyNSwgdHlwZTogJ3JhbmdlJywgY29sb3I6ICcjMTZhMDg1Jywgc2hha2U6IDgsIHNwcmVhZDogMC4wMywgY2FzaW5nOiB0cnVlLCBzbW9rZTogMiwgc2Z4OiAnc2hvb3RfRzE4JyB9LFxyXG4gICAgLy8gLS0tIFBSRUNJU0lcdTAwRDNOIC0tLVxyXG4gICAgV0lOQ0hFU1RFUjogeyBuYW1lOiAnV0lOQ0hFU1RFUicsIGRhbWFnZTogMTMwLCBmaXJlUmF0ZTogOTAwLCBjYXBhY2l0eTogOCwgcmVsb2FkVGltZTogNDUwLCBzcGVlZDogMzAsIHR5cGU6ICdyYW5nZScsIGNvbG9yOiAnIzhlNWEyZCcsIHNoYWtlOiAxMCwgc3ByZWFkOiAwLjAxLCBjYXNpbmc6IHRydWUsIHNtb2tlOiAyLCBzZng6ICdzaG9vdF9HMTgnLCBzaW5nbGVSZWxvYWQ6IHRydWUgfSxcclxuICAgIEFXUDogICAgICB7IG5hbWU6ICdBV1AnLCBkYW1hZ2U6IDI2MCwgZmlyZVJhdGU6IDE3MDAsIGNhcGFjaXR5OiA1LCByZWxvYWRUaW1lOiAyNjAwLCBzcGVlZDogMzgsIHR5cGU6ICdyYW5nZScsIGNvbG9yOiAnIzM0NDk1ZScsIHNoYWtlOiAyMiwgc3ByZWFkOiAwLCBjYXNpbmc6IHRydWUsIHNtb2tlOiAyLCBzZng6ICdzaG9vdF9HMTgnLCBwaWVyY2U6IDQgfSxcclxuICAgIFNOSVBFUjogICB7IG5hbWU6ICdTTklQRVInLCBkYW1hZ2U6IDIyMCwgZmlyZVJhdGU6IDE1MDAsIGNhcGFjaXR5OiA1LCByZWxvYWRUaW1lOiAyNTAwLCBzcGVlZDogMzUsIHR5cGU6ICdyYW5nZScsIGNvbG9yOiAnIzM0NDk1ZScsIHNoYWtlOiAyMCwgc3ByZWFkOiAwLCBjYXNpbmc6IHRydWUsIHNtb2tlOiAyLCBzZng6ICdzaG9vdF9HMTgnIH0sXHJcbiAgICAvLyAtLS0gUEVTQURBUyAtLS1cclxuICAgIE0yNDk6ICAgICB7IG5hbWU6ICdNMjQ5JywgZGFtYWdlOiAyNCwgZmlyZVJhdGU6IDkwLCBjYXBhY2l0eTogMTUwLCByZWxvYWRUaW1lOiA0MDAwLCBzcGVlZDogMjIsIHR5cGU6ICdyYW5nZScsIGNvbG9yOiAnIzU1NmIyZicsIHNoYWtlOiA1LCBzcHJlYWQ6IDAuMTIsIGNhc2luZzogdHJ1ZSwgc21va2U6IDMsIHNmeDogJ3Nob290X0cxOCcgfSxcclxuICAgIE1JTklHVU46ICB7IG5hbWU6ICdNSU5JR1VOJywgZGFtYWdlOiAyMCwgZmlyZVJhdGU6IDUwLCBjYXBhY2l0eTogMTAwLCByZWxvYWRUaW1lOiAzMDAwLCBzcGVlZDogMjIsIHR5cGU6ICdyYW5nZScsIGNvbG9yOiAnI2MwMzkyYicsIHNoYWtlOiA4LCBzcHJlYWQ6IDAuMiwgY2FzaW5nOiB0cnVlLCBzbW9rZTogMywgc2Z4OiAnc2hvb3RfRzE4Jywgc3BpbnVwOiB0cnVlIH0sXHJcbiAgICAvLyAtLS0gRVNQRUNJQUxFUyAtLS1cclxuICAgIFJQRzogICAgICB7IG5hbWU6ICdSUEcnLCBkYW1hZ2U6IDg1LCBmaXJlUmF0ZTogMTQwMCwgY2FwYWNpdHk6IDEsIHJlbG9hZFRpbWU6IDI0MDAsIHNwZWVkOiAxNiwgdHlwZTogJ3JhbmdlJywgY29sb3I6ICcjZTY3ZTIyJywgc2hha2U6IDI1LCBzcHJlYWQ6IDAsIGNhc2luZzogZmFsc2UsIHNtb2tlOiA0LCBzZng6ICdzaG9vdF9TSE9UR1VOJywgZXhwbG9zaXZlOiB0cnVlLCBleHBsb3Npb25SYWRpdXM6IDE0MCB9LFxyXG4gICAgRkxBTUVUSFJPV0VSOiB7IG5hbWU6ICdGTEFNRVRIUk9XRVInLCBkYW1hZ2U6IDQsIGZpcmVSYXRlOiA0NSwgY2FwYWNpdHk6IDEyMCwgcmVsb2FkVGltZTogMjIwMCwgc3BlZWQ6IDEyLCB0eXBlOiAncmFuZ2UnLCBjb2xvcjogJyNmZjg4MDAnLCBzaGFrZTogMiwgc3ByZWFkOiAwLjE1LCBjYXNpbmc6IGZhbHNlLCBzbW9rZTogMiwgc2Z4OiAnZmxhbWV0aHJvd2VyJywgbWF4UmFuZ2U6IDI2MCwgYnVybjogdHJ1ZSwgcGllcmNlOiAyIH0sXHJcbiAgICBDUk9TU0JPVzogeyBuYW1lOiAnQ1JPU1NCT1cnLCBkYW1hZ2U6IDkwLCBmaXJlUmF0ZTogNzAwLCBjYXBhY2l0eTogMSwgcmVsb2FkVGltZTogMTIwMCwgc3BlZWQ6IDI2LCB0eXBlOiAncmFuZ2UnLCBjb2xvcjogJyMxNmEwODUnLCBzaGFrZTogNCwgc3ByZWFkOiAwLCBjYXNpbmc6IGZhbHNlLCBzbW9rZTogMCwgc2Z4OiAnc2hvb3RfRzE4JyB9XHJcbn07XHJcblxyXG4vLyBQb3NpY2lvbmVzIGRlbCBkZXN0ZWxsbyBkZSBib2NhIHBvciBhcm1hIChhbnRlcyBzZSBjcmVhYmEgZXN0ZSBvYmpldG8gbGl0ZXJhbFxyXG4vLyBlbiBjYWRhIGZyYW1lIGRlbnRybyBkZSBQbGF5ZXIuZHJhdzsgbW92aWRvIGFjXHUwMEUxIGNvbW8gY29uc3RhbnRlIGZpamEgcGFyYSBub1xyXG4vLyBnZW5lcmFyIGJhc3VyYS9nYXJiYWdlIGNvbGxlY3Rpb24gZW4gY2FkYSBkaXNwYXJvKS5cclxuY29uc3QgV0VBUE9OX01VWlpMRV9YID0geyBBSzQ3OiA0NSwgU0hPVEdVTjogNDAsIFNOSVBFUjogNDgsIE1JTklHVU46IDMwLCBSRVZPTFZFUjogMjAsIENST1NTQk9XOiAxNSxcclxuICAgIE1QNTogMjYsIFA5MDogMjksIFNBV0VET0ZGOiAyMCwgQUExMjogMjUsIE00QTE6IDQyLCBGQU1BUzogMzIsIFNDQVI6IDI0LCBXSU5DSEVTVEVSOiA0NSxcclxuICAgIEFXUDogNTAsIE0yNDk6IDMwLCBSUEc6IDY2LCBGTEFNRVRIUk9XRVI6IDM1LCBDSEFJTlNBVzogMjggfTtcclxuXG4vLyMgc291cmNlVVJMPXdlYXBvbnMuanNcblxuLyogPT09PT09PT09PT09PT09PT0gcGxheWVyLmpzID09PT09PT09PT09PT09PT09ICovXG4vKipcclxuICogTGEgYmFzZSBkZSBkYXRvcyBkZSBhcm1hcyAoV0VBUE9OU19EQikgeSBsYSB0YWJsYSBkZSBwb3NpY2lvbmVzIGRlIGRlc3RlbGxvIGRlXHJcbiAqIGJvY2EgKFdFQVBPTl9NVVpaTEVfWCkgYWhvcmEgdml2ZW4gZW4gd2VhcG9ucy5qcywgcXVlIHNlIGNhcmdhIGFudGVzIHF1ZSBlc3RlXHJcbiAqIGFyY2hpdm8uIE5hZGEgY2FtYmlhIGVuIHRpZW1wbyBkZSBlamVjdWNpXHUwMEYzbjogc2lndWVuIHNpZW5kbyB2YXJpYWJsZXMgZ2xvYmFsZXNcclxuICogY29uIGV4YWN0YW1lbnRlIGxvcyBtaXNtb3MgdmFsb3Jlcy5cclxuICovXHJcblxyXG4vLyBSZWdlbmVyYWNpXHUwMEYzbi9jb25zdW1vIGRlIHN0YW1pbmEgcHJlY2FsY3VsYWRvcyB1bmEgc29sYSB2ZXogKGFudGVzIHNlIGhhY1x1MDBFRGFuXHJcbi8vIGxhcyBtaXNtYXMgZGl2aXNpb25lcyBcIjE1LzYwXCIgeSBcIjMwLzYwXCIgZW4gY2FkYSBmcmFtZSBkZW50cm8gZGUgdXBkYXRlKCkpLlxyXG5jb25zdCBTVEFNSU5BX1JFR0VOX1BFUl9GUkFNRSA9IDE1IC8gNjA7XHJcbmNvbnN0IFNQUklOVF9TVEFNSU5BX0RSQUlOX1BFUl9GUkFNRSA9IDMwIC8gNjA7XHJcblxyXG5jbGFzcyBQbGF5ZXIge1xyXG4gICAgY29uc3RydWN0b3IoKSB7XHJcbiAgICAgICAgdGhpcy54ID0gTUFQX1NJWkUgLyAyOyB0aGlzLnkgPSBNQVBfU0laRSAvIDI7XHJcbiAgICAgICAgdGhpcy5yYWRpdXMgPSAyNDsgdGhpcy5ocCA9IDEwMDsgdGhpcy5tYXhIcCA9IDEwMDtcclxuICAgICAgICB0aGlzLm1vbmV5ID0gMDtcclxuICAgICAgICB0aGlzLmludmVudG9yeSA9IFsgeyAuLi5XRUFQT05TX0RCLkcxOCwgYW1tbzogMTUgfSwgeyAuLi5XRUFQT05TX0RCLktOSUZFIH0sIG51bGwsIG51bGwsIG51bGwgXTtcclxuICAgICAgICB0aGlzLmFjdGl2ZVNsb3QgPSAwOyB0aGlzLmlzUmVsb2FkaW5nID0gZmFsc2U7XHJcbiAgICAgICAgdGhpcy50aWNrID0gMDsgdGhpcy5yZWNvaWxPZmZzZXQgPSAwO1xyXG4gICAgICAgIHRoaXMubXV6emxlRmxhc2ggPSAwO1xyXG4gICAgICAgIHRoaXMuY2hhaW5zYXdGdWVsID0gMTAwOyB0aGlzLmNoYWluc2F3QWN0aXZlID0gZmFsc2U7IC8vIENIQUlOU0FXOiBjb21idXN0aWJsZSBkZSB1c28gY29udGludW9cclxuICAgICAgICB0aGlzLm1pbmlndW5TcGluID0gMDsgLy8gTUlOSUdVTjogMCA9IGZyXHUwMEVEbywgMSA9IGEgbVx1MDBFMXhpbWEgdmVsb2NpZGFkXHJcbiAgICAgICAgdGhpcy5idXJzdEJ1c3kgPSBmYWxzZTsgLy8gRkFNQVM6IGV2aXRhIHJlaW5pY2lhciB1bmEgclx1MDBFMWZhZ2EgZW4gY3Vyc29cclxuXHJcbiAgICAgICAgLy8gRGFzaCB5IFN0YW1pbmFcclxuICAgICAgICB0aGlzLnN0YW1pbmEgPSAxMDA7IHRoaXMubWF4U3RhbWluYSA9IDEwMDtcclxuICAgICAgICB0aGlzLmlzRGFzaGluZyA9IGZhbHNlOyB0aGlzLmRhc2hUaW1lciA9IDA7IHRoaXMuZGFzaENvb2xkb3duVGltZXIgPSAwO1xyXG4gICAgICAgIHRoaXMuZGFzaERpclggPSAwOyB0aGlzLmRhc2hEaXJZID0gMDtcclxuICAgICAgICBcclxuICAgICAgICAvLyBFZmVjdG8gaW50ZXJubyBnZWxhdGlub3NvXHJcbiAgICAgICAgdGhpcy5idWJibGVzID0gQXJyYXkuZnJvbSh7bGVuZ3RoOiA1fSwgKCkgPT4gKHtcclxuICAgICAgICAgICAgeDogKE1hdGgucmFuZG9tKCktMC41KSoyMCwgeTogKE1hdGgucmFuZG9tKCktMC41KSoyMCwgczogMiArIE1hdGgucmFuZG9tKCkqNCwgb2Zmc2V0OiBNYXRoLnJhbmRvbSgpKk1hdGguUEkqMlxyXG4gICAgICAgIH0pKTtcclxuICAgIH1cclxuICAgIGdldCB3ZWFwb24oKSB7IHJldHVybiB0aGlzLmludmVudG9yeVt0aGlzLmFjdGl2ZVNsb3RdOyB9XHJcblxyXG4gICAgdGFrZURhbWFnZShhbXQpIHtcclxuICAgICAgICB0aGlzLmhwID0gTWF0aC5tYXgoMCwgdGhpcy5ocCAtIGFtdCk7XHJcbiAgICAgICAgZ2FtZS5jYW1lcmEuc2hha2UgPSAxMDtcclxuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZGFtYWdlLW92ZXJsYXknKS5zdHlsZS5vcGFjaXR5ID0gXCIxXCI7XHJcbiAgICAgICAgc2V0VGltZW91dCgoKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZGFtYWdlLW92ZXJsYXknKS5zdHlsZS5vcGFjaXR5ID0gXCIwXCIsIDE1MCk7XHJcbiAgICAgICAgaWYodGhpcy5ocCA8PSAwKSB7IHBsYXlTRlgoJ211ZXJ0ZV9wbGF5ZXInLCAwLjYpOyBnYW1lLmdhbWVPdmVyKCk7IH1cclxuICAgIH1cclxuXHJcbiAgICBkYXNoKCkge1xyXG4gICAgICAgIGlmKHRoaXMuZGFzaENvb2xkb3duVGltZXIgPiAwIHx8IHRoaXMuaXNEYXNoaW5nIHx8IHRoaXMuc3RhbWluYSA8IDIwKSByZXR1cm47XHJcbiAgICAgICAgdGhpcy5zdGFtaW5hIC09IDIwO1xyXG5cclxuICAgICAgICBsZXQgZHggPSAwLCBkeSA9IDA7XHJcbiAgICAgICAgaWYoZ2FtZS5rZXlzWydLZXlXJ10pIGR5IC09IDE7IGlmKGdhbWUua2V5c1snS2V5UyddKSBkeSArPSAxO1xyXG4gICAgICAgIGlmKGdhbWUua2V5c1snS2V5QSddKSBkeCAtPSAxOyBpZihnYW1lLmtleXNbJ0tleUQnXSkgZHggKz0gMTtcclxuICAgICAgICBpZihkeCA9PT0gMCAmJiBkeSA9PT0gMCkge1xyXG4gICAgICAgICAgICBsZXQgYW5nbGUgPSBNYXRoLmF0YW4yKGdhbWUubW91c2UueSAtICh0aGlzLnkgLSBnYW1lLmNhbWVyYS55KSwgZ2FtZS5tb3VzZS54IC0gKHRoaXMueCAtIGdhbWUuY2FtZXJhLngpKTtcclxuICAgICAgICAgICAgZHggPSBNYXRoLmNvcyhhbmdsZSk7IGR5ID0gTWF0aC5zaW4oYW5nbGUpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGxlbiA9IE1hdGguaHlwb3QoZHgsIGR5KTtcclxuICAgICAgICAgICAgZHggLz0gbGVuOyBkeSAvPSBsZW47XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICB0aGlzLmRhc2hEaXJYID0gZHg7IHRoaXMuZGFzaERpclkgPSBkeTtcclxuICAgICAgICB0aGlzLmlzRGFzaGluZyA9IHRydWU7XHJcbiAgICAgICAgdGhpcy5kYXNoVGltZXIgPSA4OyAgICAgICAgLy8gfjAuMTNzIGRlIGRhc2ggYSA2MGZwc1xyXG4gICAgICAgIHRoaXMuZGFzaENvb2xkb3duVGltZXIgPSA0NTsgLy8gfjAuNzVzIGRlIGNvb2xkb3duXHJcbiAgICAgICAgZ2FtZS5jYW1lcmEuc2hha2UgPSA0O1xyXG4gICAgICAgIHBsYXlTRlgoJ3JlbG9hZCcsIDAuMTUsIDAuNCk7IFxyXG4gICAgICAgIGZvcihsZXQgaT0wOyBpPE1hdGguY2VpbCgxMCpnYW1lLnBhcnRpY2xlU2NhbGUpOyBpKyspIGdhbWUuc3Bhd25QYXJ0aWNsZSh0aGlzLngsIHRoaXMueSwgJyNhOGU2Y2YnLCAzLCAzLCAnbm9ybWFsJyk7XHJcbiAgICB9XHJcblxyXG4gICAgdXBkYXRlKGtleXMpIHtcclxuICAgICAgICBpZih0aGlzLmRhc2hDb29sZG93blRpbWVyID4gMCkgdGhpcy5kYXNoQ29vbGRvd25UaW1lci0tO1xyXG5cclxuICAgICAgICAvLyBSZWdlbmVyYWNpXHUwMEYzbiBkZSBzdGFtaW5hICgxNSBwb3Igc2VndW5kbylcclxuICAgICAgICB0aGlzLnN0YW1pbmEgPSBNYXRoLm1pbih0aGlzLm1heFN0YW1pbmEsIHRoaXMuc3RhbWluYSArIFNUQU1JTkFfUkVHRU5fUEVSX0ZSQU1FKTtcclxuXHJcbiAgICAgICAgbGV0IHNwZWVkTXVsdGlwbGllciA9IChnYW1lLnBsYXllclNwZWVkTXVsdCB8fCAxKTtcclxuICAgICAgICBpZiAoKGtleXNbJ1NoaWZ0TGVmdCddIHx8IGtleXNbJ1NoaWZ0UmlnaHQnXSkgJiYgdGhpcy5zdGFtaW5hID4gMC41ICYmICF0aGlzLmlzRGFzaGluZykge1xyXG4gICAgICAgICAgICBzcGVlZE11bHRpcGxpZXIgPSAxLjYgKiAoZ2FtZS5wbGF5ZXJTcGVlZE11bHQgfHwgMSk7XHJcbiAgICAgICAgICAgIHRoaXMuc3RhbWluYSAtPSBTUFJJTlRfU1RBTUlOQV9EUkFJTl9QRVJfRlJBTUU7IC8vIEdhc3RvIHBvciBzcHJpbnRhclxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodGhpcy53ZWFwb24gJiYgdGhpcy53ZWFwb24ubW9iaWxpdHkpIHNwZWVkTXVsdGlwbGllciAqPSAxLjE1OyAvLyBQOTA6IGdyYW4gbW92aWxpZGFkXHJcblxyXG4gICAgICAgIGlmICh0aGlzLndlYXBvbiAmJiB0aGlzLndlYXBvbi5zcGludXApIHsgLy8gTUlOSUdVTjogcmFtcGEgZGUgdmVsb2NpZGFkIGRlIGRpc3Bhcm9cclxuICAgICAgICAgICAgaWYgKGdhbWUubW91c2UuZG93biAmJiAhdGhpcy5pc1JlbG9hZGluZykgdGhpcy5taW5pZ3VuU3BpbiA9IE1hdGgubWluKDEsIHRoaXMubWluaWd1blNwaW4gKyAwLjAyKTtcclxuICAgICAgICAgICAgZWxzZSB0aGlzLm1pbmlndW5TcGluID0gTWF0aC5tYXgoMCwgdGhpcy5taW5pZ3VuU3BpbiAtIDAuMDE1KTtcclxuICAgICAgICB9IGVsc2UgaWYgKHRoaXMubWluaWd1blNwaW4gPiAwKSB0aGlzLm1pbmlndW5TcGluID0gTWF0aC5tYXgoMCwgdGhpcy5taW5pZ3VuU3BpbiAtIDAuMDMpO1xyXG5cclxuICAgICAgICBpZiAodGhpcy53ZWFwb24gJiYgdGhpcy53ZWFwb24uZnVlbCAhPT0gdW5kZWZpbmVkKSB7IC8vIENIQUlOU0FXOiByZWdlbmVyYSBjb21idXN0aWJsZSBzaSBubyBlc3RcdTAwRTEgY29ydGFuZG9cclxuICAgICAgICAgICAgaWYgKCF0aGlzLmNoYWluc2F3QWN0aXZlKSB0aGlzLmNoYWluc2F3RnVlbCA9IE1hdGgubWluKHRoaXMud2VhcG9uLmZ1ZWwsIHRoaXMuY2hhaW5zYXdGdWVsICsgMC44KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhpcy5jaGFpbnNhd0FjdGl2ZSA9IGZhbHNlOyAvLyBzZSB2dWVsdmUgYSBtYXJjYXIgdHJ1ZSBlbiBnYW1lLnNob290IHNpIGVmZWN0aXZhbWVudGUgY29ydGEgZXN0ZSBmcmFtZVxyXG5cclxuICAgICAgICBsZXQgdnggPSAwLCB2eSA9IDA7XHJcbiAgICAgICAgaWYodGhpcy5pc0Rhc2hpbmcpIHtcclxuICAgICAgICAgICAgdnggPSB0aGlzLmRhc2hEaXJYICogMTg7IHZ5ID0gdGhpcy5kYXNoRGlyWSAqIDE4O1xyXG4gICAgICAgICAgICBpZihNYXRoLnJhbmRvbSgpID4gMC4zKSBnYW1lLnNwYXduVHJhaWwodGhpcy54LCB0aGlzLnksIHRoaXMucmFkaXVzICogMC45KTtcclxuICAgICAgICAgICAgdGhpcy5kYXNoVGltZXItLTtcclxuICAgICAgICAgICAgaWYodGhpcy5kYXNoVGltZXIgPD0gMCkgdGhpcy5pc0Rhc2hpbmcgPSBmYWxzZTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBpZihrZXlzWydLZXlXJ10pIHZ5ID0gLTUgKiBzcGVlZE11bHRpcGxpZXI7IGlmKGtleXNbJ0tleVMnXSkgdnkgPSA1ICogc3BlZWRNdWx0aXBsaWVyO1xyXG4gICAgICAgICAgICBpZihrZXlzWydLZXlBJ10pIHZ4ID0gLTUgKiBzcGVlZE11bHRpcGxpZXI7IGlmKGtleXNbJ0tleUQnXSkgdnggPSA1ICogc3BlZWRNdWx0aXBsaWVyO1xyXG4gICAgICAgICAgICBpZih2eCAhPT0gMCAmJiB2eSAhPT0gMCkgeyB2eCAqPSAwLjcwNzsgdnkgKj0gMC43MDc7IH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmKHZ4ICE9PSAwIHx8IHZ5ICE9PSAwKSB7XHJcbiAgICAgICAgICAgIHRoaXMudGljayArPSAwLjM7XHJcbiAgICAgICAgICAgIGlmKE1hdGgucmFuZG9tKCkgPiAwLjkpIGdhbWUuc3Bhd25QYXJ0aWNsZSh0aGlzLngsIHRoaXMueSArIHRoaXMucmFkaXVzLCAnIzU1NScsIDEsIDIsICdzbW9rZScpO1xyXG4gICAgICAgICAgICBpZihNYXRoLnJhbmRvbSgpID4gMC43KSBnYW1lLnNwYXduVHJhaWwodGhpcy54LCB0aGlzLnksIHRoaXMucmFkaXVzICogMC44KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgXHJcbiAgICAgICAgdGhpcy54ID0gTWF0aC5tYXgodGhpcy5yYWRpdXMsIE1hdGgubWluKE1BUF9TSVpFLXRoaXMucmFkaXVzLCB0aGlzLnggKyB2eCkpO1xyXG4gICAgICAgIHRoaXMueSA9IE1hdGgubWF4KHRoaXMucmFkaXVzLCBNYXRoLm1pbihNQVBfU0laRS10aGlzLnJhZGl1cywgdGhpcy55ICsgdnkpKTtcclxuICAgICAgICBcclxuICAgICAgICBpZih0aGlzLnJlY29pbE9mZnNldCA+IDApIHRoaXMucmVjb2lsT2Zmc2V0ID0gTWF0aC5tYXgoMCwgdGhpcy5yZWNvaWxPZmZzZXQgLSAyKTtcclxuICAgICAgICBpZih0aGlzLm11enpsZUZsYXNoID4gMCkgdGhpcy5tdXp6bGVGbGFzaC0tO1xyXG4gICAgfVxyXG5cclxuICAgIGRyYXcoY2FtLCBtb3VzZSkge1xyXG4gICAgICAgIGxldCBtb3ZpbmcgPSAoZ2FtZS5rZXlzWydLZXlXJ10gfHwgZ2FtZS5rZXlzWydLZXlTJ10gfHwgZ2FtZS5rZXlzWydLZXlBJ10gfHwgZ2FtZS5rZXlzWydLZXlEJ10pO1xyXG4gICAgICAgIGNvbnN0IGJvdW5jZSA9IG1vdmluZyA/IE1hdGguYWJzKE1hdGguc2luKHRoaXMudGljaykpICogNiA6IDA7XHJcbiAgICAgICAgY29uc3Qgc3RyZXRjaFggPSBtb3ZpbmcgPyAxIC0gTWF0aC5hYnMoTWF0aC5jb3ModGhpcy50aWNrKSkgKiAwLjE1IDogMSArICh0aGlzLnJlY29pbE9mZnNldCowLjAyKTtcclxuICAgICAgICBjb25zdCBzdHJldGNoWSA9IG1vdmluZyA/IDEgKyBNYXRoLmFicyhNYXRoLmNvcyh0aGlzLnRpY2spKSAqIDAuMTUgOiAxIC0gKHRoaXMucmVjb2lsT2Zmc2V0KjAuMDIpO1xyXG4gICAgICAgIFxyXG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSBcInJnYmEoMCwwLDAsMC40KVwiO1xyXG4gICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmVsbGlwc2UodGhpcy54IC0gY2FtLngsIHRoaXMueSAtIGNhbS55ICsgMTIsIDMwLCAxMCwgMCwgMCwgTWF0aC5QSSoyKTsgY3R4LmZpbGwoKTtcclxuXHJcbiAgICAgICAgY3R4LnNhdmUoKTtcclxuICAgICAgICBjdHgudHJhbnNsYXRlKHRoaXMueCAtIGNhbS54LCB0aGlzLnkgLSBjYW0ueSAtIGJvdW5jZSk7XHJcbiAgICAgICAgY3R4LnNjYWxlKHN0cmV0Y2hYLCBzdHJldGNoWSk7IFxyXG4gICAgICAgIFxyXG4gICAgICAgIGN0eC5nbG9iYWxBbHBoYSA9IDAuOTtcclxuICAgICAgICBsZXQgZ3JhZCA9IGN0eC5jcmVhdGVSYWRpYWxHcmFkaWVudCgtNSwgLTEwLCAwLCAwLCAwLCB0aGlzLnJhZGl1cyk7XHJcbiAgICAgICAgZ3JhZC5hZGRDb2xvclN0b3AoMCwgJyNhOGU2Y2YnKTsgZ3JhZC5hZGRDb2xvclN0b3AoMC43LCAnIzNiN2E1NycpOyBncmFkLmFkZENvbG9yU3RvcCgxLCAnIzJjM2U1MCcpO1xyXG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSBncmFkOyBjdHguc3Ryb2tlU3R5bGUgPSAnIzFlMzgyYic7IGN0eC5saW5lV2lkdGggPSAzO1xyXG4gICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYygwLCAwLCB0aGlzLnJhZGl1cywgMCwgTWF0aC5QSSoyKTsgY3R4LmZpbGwoKTsgY3R4LnN0cm9rZSgpO1xyXG5cclxuICAgICAgICBjdHguZmlsbFN0eWxlID0gJ3JnYmEoMjU1LDI1NSwyNTUsMC4zKSc7XHJcbiAgICAgICAgdGhpcy5idWJibGVzLmZvckVhY2goYiA9PiB7XHJcbiAgICAgICAgICAgIGxldCBieSA9IGIueSArIE1hdGguc2luKHRoaXMudGljayAqIDAuNSArIGIub2Zmc2V0KSAqIDM7XHJcbiAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYyhiLngsIGJ5LCBiLnMsIDAsIE1hdGguUEkqMik7IGN0eC5maWxsKCk7XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIGN0eC5zdHJva2VTdHlsZSA9ICdyZ2JhKDI1NSwyNTUsMjU1LDAuNSknO1xyXG4gICAgICAgIGN0eC5saW5lV2lkdGggPSAzOyBjdHgubGluZUNhcCA9ICdyb3VuZCc7XHJcbiAgICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKDAsIDAsIHRoaXMucmFkaXVzIC0gNiwgTWF0aC5QSSArIDAuNSwgTWF0aC5QSSAqIDEuNSAtIDAuNSk7IGN0eC5zdHJva2UoKTtcclxuXHJcbiAgICAgICAgY3R4Lmdsb2JhbEFscGhhID0gMTtcclxuXHJcbiAgICAgICAgbGV0IGFuZ2xlID0gTWF0aC5hdGFuMihtb3VzZS55IC0gKHRoaXMueSAtIGNhbS55KSwgbW91c2UueCAtICh0aGlzLnggLSBjYW0ueCkpO1xyXG4gICAgICAgIGxldCBleWVPZmZzZXRYID0gTWF0aC5jb3MoYW5nbGUpICogNjsgbGV0IGV5ZU9mZnNldFkgPSBNYXRoLnNpbihhbmdsZSkgKiA2O1xyXG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSAnI2ZmZic7XHJcbiAgICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKC04ICsgZXllT2Zmc2V0WCwgLTQgKyBleWVPZmZzZXRZLCA3LCAwLCBNYXRoLlBJKjIpOyBjdHguZmlsbCgpO1xyXG4gICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYyg4ICsgZXllT2Zmc2V0WCwgLTQgKyBleWVPZmZzZXRZLCA3LCAwLCBNYXRoLlBJKjIpOyBjdHguZmlsbCgpO1xyXG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzAwMCc7XHJcbiAgICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKC04ICsgZXllT2Zmc2V0WCArIE1hdGguY29zKGFuZ2xlKSozLCAtNCArIGV5ZU9mZnNldFkgKyBNYXRoLnNpbihhbmdsZSkqMywgMy41LCAwLCBNYXRoLlBJKjIpOyBjdHguZmlsbCgpO1xyXG4gICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYyg4ICsgZXllT2Zmc2V0WCArIE1hdGguY29zKGFuZ2xlKSozLCAtNCArIGV5ZU9mZnNldFkgKyBNYXRoLnNpbihhbmdsZSkqMywgMy41LCAwLCBNYXRoLlBJKjIpOyBjdHguZmlsbCgpO1xyXG5cclxuICAgICAgICBpZih0aGlzLndlYXBvbikge1xyXG4gICAgICAgICAgICBjdHgucm90YXRlKGFuZ2xlKTtcclxuICAgICAgICAgICAgY3R4LnRyYW5zbGF0ZSh0aGlzLnJhZGl1cyAtIDUsIDApOyBcclxuICAgICAgICAgICAgY3R4LnRyYW5zbGF0ZSgtdGhpcy5yZWNvaWxPZmZzZXQsIDApOyBcclxuICAgICAgICAgICAgXHJcbiAgICAgICAgICAgIC8vIFNvbWJyYSBwcm95ZWN0YWRhIGRlbCBhcm1hOiBwdXJhbWVudGUgY29zbVx1MDBFOXRpY2EvcG9zdHByb2Nlc2Fkbywgc2UgYXBhZ2EgZW4gVUxUUkFcclxuICAgICAgICAgICAgaWYgKGdhbWUuZnhFbmFibGVkKSB7IGN0eC5zaGFkb3dDb2xvciA9ICdyZ2JhKDAsMCwwLDAuNSknOyBjdHguc2hhZG93Qmx1ciA9IDU7IGN0eC5zaGFkb3dPZmZzZXRZID0gMzsgfVxyXG4gICAgICAgICAgICBcclxuICAgICAgICAgICAgaWYgKHRoaXMud2VhcG9uLm5hbWUgPT09ICdBSzQ3Jykge1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjODczNjAwJzsgY3R4LmZpbGxSZWN0KC0xMCwgLTMsIDE1LCA2KTsgXHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMyYzNlNTAnOyBjdHguZmlsbFJlY3QoNSwgLTQsIDIwLCA4KTsgXHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMzNDQ5NWUnOyBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8oMTUsIDQpOyBjdHgubGluZVRvKDEwLCAxNSk7IGN0eC5saW5lVG8oMjAsIDE1KTsgY3R4LmxpbmVUbygyNSwgNCk7IGN0eC5maWxsKCk7IFxyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjN2Y4YzhkJzsgY3R4LmZpbGxSZWN0KDI1LCAtMiwgMjAsIDQpOyBcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnI2JkYzNjNyc7IGN0eC5maWxsUmVjdCgzNSwgLTQsIDIsIDIpOyBcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLndlYXBvbi5uYW1lID09PSAnU0hPVEdVTicpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzVjNDAzMyc7IGN0eC5maWxsUmVjdCgtNSwgLTQsIDE1LCA4KTsgXHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMyYzNlNTAnOyBjdHguZmlsbFJlY3QoMTAsIC00LCAzMCwgOCk7IFxyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMTExJzsgY3R4LmZpbGxSZWN0KDEwLCAtMSwgMzAsIDIpOyBcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzg3MzYwMCc7IGN0eC5maWxsUmVjdCgxNSwgNCwgMTUsIDUpOyBcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLndlYXBvbi5uYW1lID09PSAnVVpJJykge1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMmMzZTUwJzsgY3R4LmZpbGxSZWN0KDAsIC01LCAyMCwgMTApO1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMzQ0OTVlJzsgY3R4LmZpbGxSZWN0KDUsIDUsIDgsIDE0KTsgXHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyM3ZjhjOGQnOyBjdHguZmlsbFJlY3QoMjAsIC0yLCA4LCA0KTsgXHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy53ZWFwb24ubmFtZSA9PT0gJ0cxOCcpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzJjM2U1MCc7IGN0eC5maWxsUmVjdCgwLCAtNCwgMTUsIDgpO1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMzQ0OTVlJzsgY3R4LmZpbGxSZWN0KDIsIDQsIDYsIDgpO1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjN2Y4YzhkJzsgY3R4LmZpbGxSZWN0KDE1LCAtMywgNSwgNCk7IFxyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMud2VhcG9uLm5hbWUgPT09ICdSRVZPTFZFUicpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzVjNDAzMyc7IGN0eC5maWxsUmVjdCgtNiwgLTMsIDEwLCA4KTsgXHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyM3ZjhjOGQnOyBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmMoNCwgMCwgNiwgMCwgTWF0aC5QSSoyKTsgY3R4LmZpbGwoKTsgXHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyM5NWE1YTYnOyBjdHguZmlsbFJlY3QoOCwgLTMsIDE2LCA2KTsgXHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy53ZWFwb24ubmFtZSA9PT0gJ1NOSVBFUicpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzM0NDk1ZSc7IGN0eC5maWxsUmVjdCgtMTAsIC0zLCA1MCwgNik7IFxyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMmMzZTUwJzsgY3R4LmZpbGxSZWN0KC01LCAtOSwgMTUsIDUpOyBcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzdmOGM4ZCc7IGN0eC5maWxsUmVjdCg1LCAtMTIsIDMsIDgpOyBcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLndlYXBvbi5uYW1lID09PSAnTUlOSUdVTicpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnI2MwMzkyYic7IGN0eC5maWxsUmVjdCgtOCwgLTYsIDE1LCAxMik7IFxyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMmMzZTUwJztcclxuICAgICAgICAgICAgICAgIGZvcihsZXQgaT0wOyBpPDQ7IGkrKykgY3R4LmZpbGxSZWN0KDgsIC02ICsgaSozLCAyMiwgMik7IFxyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMud2VhcG9uLm5hbWUgPT09ICdDUk9TU0JPVycpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5zdHJva2VTdHlsZSA9ICcjMTZhMDg1JzsgY3R4LmxpbmVXaWR0aCA9IDM7XHJcbiAgICAgICAgICAgICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8oNSwtMTQpOyBjdHgubGluZVRvKDE1LDApOyBjdHgubGluZVRvKDUsMTQpOyBjdHguc3Ryb2tlKCk7IFxyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjNWM0MDMzJzsgY3R4LmZpbGxSZWN0KC01LCAtMiwgMjAsIDQpOyBcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLndlYXBvbi5uYW1lID09PSAnTVA1Jykge1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMmMzZTUwJzsgY3R4LmZpbGxSZWN0KDAsIC00LCAyNiwgOCk7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMzNDQ5NWUnOyBjdHguZmlsbFJlY3QoNCwgNCwgNiwgMTIpO1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjN2Y4YzhkJzsgY3R4LmZpbGxSZWN0KDI2LCAtMiwgOCwgNCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy53ZWFwb24ubmFtZSA9PT0gJ1A5MCcpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzhlNDRhZCc7IGN0eC5maWxsUmVjdCgtNSwgLTYsIDM0LCAxMCk7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyM1ZTMzNzAnOyBjdHguZmlsbFJlY3QoMiwgLTEyLCAxOCwgOCk7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMzNDQ5NWUnOyBjdHguZmlsbFJlY3QoMjksIC0zLCA2LCA1KTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLndlYXBvbi5uYW1lID09PSAnU0FXRURPRkYnKSB7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyM1YzQwMzMnOyBjdHguZmlsbFJlY3QoLTgsIC00LCAxNCwgOCk7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMxMTEnOyBjdHguZmlsbFJlY3QoNiwgLTUsIDE0LCA1KTsgY3R4LmZpbGxSZWN0KDYsIDEsIDE0LCA0KTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLndlYXBvbi5uYW1lID09PSAnQUExMicpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzJjM2U1MCc7IGN0eC5maWxsUmVjdCgtNSwgLTUsIDMwLCAxMCk7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMxMTEnOyBjdHguZmlsbFJlY3QoMjUsIC0zLCAxMCwgNik7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyM3ZjhjOGQnOyBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmMoMCwgOCwgNiwgMCwgTWF0aC5QSSoyKTsgY3R4LmZpbGwoKTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLndlYXBvbi5uYW1lID09PSAnTTRBMScpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzJlY2M3MSc7IGN0eC5maWxsUmVjdCgwLCAtNCwgMjAsIDgpO1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMWU4NDQ5JzsgY3R4LmZpbGxSZWN0KC04LCA0LCA2LCAxMik7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyM3ZjhjOGQnOyBjdHguZmlsbFJlY3QoMjAsIC0zLCAyMiwgNCk7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMyYzNlNTAnOyBjdHguZmlsbFJlY3QoNSwgLTEwLCAxMiwgNik7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy53ZWFwb24ubmFtZSA9PT0gJ0ZBTUFTJykge1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMzQ5OGRiJzsgY3R4LmZpbGxSZWN0KC04LCAtNiwgNDAsIDEwKTtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzJjM2U1MCc7IGN0eC5maWxsUmVjdCgzMCwgLTQsIDEyLCA0KTtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzFhNTI3Nic7IGN0eC5maWxsUmVjdCgtOCwgLTEyLCAxNCwgNik7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy53ZWFwb24ubmFtZSA9PT0gJ1NDQVInKSB7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMxNmEwODUnOyBjdHguZmlsbFJlY3QoMCwgLTUsIDI0LCA5KTtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzBlNjY1NSc7IGN0eC5maWxsUmVjdCgtOSwgMywgNywgMTMpO1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjN2Y4YzhkJzsgY3R4LmZpbGxSZWN0KDI0LCAtMywgMjAsIDQpO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMud2VhcG9uLm5hbWUgPT09ICdXSU5DSEVTVEVSJykge1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjOGU1YTJkJzsgY3R4LmZpbGxSZWN0KC0xMCwgLTMsIDU1LCA2KTtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzVjNDAzMyc7IGN0eC5maWxsUmVjdCgtMTQsIDIsIDEwLCAxMCk7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyNjOWE4NmEnOyBjdHguZmlsbFJlY3QoMCwgLTYsIDMwLCAzKTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLndlYXBvbi5uYW1lID09PSAnQVdQJykge1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMmMzZTUwJzsgY3R4LmZpbGxSZWN0KC0xMCwgLTQsIDYwLCA3KTtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzFhMjUyZic7IGN0eC5maWxsUmVjdCgtNiwgLTExLCAxOCwgNik7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyM3ZjhjOGQnOyBjdHguZmlsbFJlY3QoOCwgLTE0LCAzLCA5KTtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzM0NDk1ZSc7IGN0eC5maWxsUmVjdCgtMTQsIDEsIDgsIDEyKTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLndlYXBvbi5uYW1lID09PSAnTTI0OScpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzU1NmIyZic7IGN0eC5maWxsUmVjdCgtNSwgLTYsIDMwLCAxMik7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMzZTRmMjInOyBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmMoLTIsIDEwLCAxMCwgMCwgTWF0aC5QSSoyKTsgY3R4LmZpbGwoKTtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzdmOGM4ZCc7IGN0eC5maWxsUmVjdCgzMCwgLTMsIDIyLCA0KTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLndlYXBvbi5uYW1lID09PSAnUlBHJykge1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjNWM0YTFhJzsgY3R4LmZpbGxSZWN0KC0xMCwgLTcsIDYwLCAxNCk7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMyYzNlNTAnOyBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8oNTAsIC03KTsgY3R4LmxpbmVUbyg2NiwgMCk7IGN0eC5saW5lVG8oNTAsIDcpOyBjdHguZmlsbCgpO1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjZTY3ZTIyJzsgY3R4LmZpbGxSZWN0KDIsIC00LCA4LCA4KTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLndlYXBvbi5uYW1lID09PSAnRkxBTUVUSFJPV0VSJykge1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjN2YyYjBhJzsgY3R4LmZpbGxSZWN0KC01LCAtNiwgNDAsIDEyKTtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzJjM2U1MCc7IGN0eC5maWxsUmVjdCgtMTAsIDIsIDEyLCAxNik7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyNmZjg4MDAnOyBjdHguZmlsbFJlY3QoMzUsIC0zLCAxMCwgNik7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy53ZWFwb24ubmFtZSA9PT0gJ0NIQUlOU0FXJykge1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjZTY3ZTIyJzsgY3R4LmZpbGxSZWN0KC02LCAtNiwgMTgsIDE0KTtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzJjM2U1MCc7IGN0eC5maWxsUmVjdCgxMCwgLTQsIDM0LCA4KTtcclxuICAgICAgICAgICAgICAgIGN0eC5zdHJva2VTdHlsZSA9ICcjYmRjM2M3JzsgY3R4LmxpbmVXaWR0aCA9IDI7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDY7IGkrKykgeyBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8oMTIgKyBpKjUsIC00KTsgY3R4LmxpbmVUbygxMiArIGkqNSwgNCk7IGN0eC5zdHJva2UoKTsgfVxyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMud2VhcG9uLnR5cGUgPT09ICdtZWxlZScpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzg3MzYwMCc7IGN0eC5maWxsUmVjdCgwLCAtMywgMTAsIDYpOyBcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnI2JkYzNjNyc7IGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbygxMCwgLTIpOyBjdHgubGluZVRvKDMwLCAwKTsgY3R4LmxpbmVUbygxMCwgMik7IGN0eC5maWxsKCk7IFxyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjZWNmMGYxJzsgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRvKDEwLCAwKTsgY3R4LmxpbmVUbygyOCwgMCk7IGN0eC5saW5lVG8oMTAsIDEpOyBjdHguZmlsbCgpOyBcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIC8vIEZhbGxiYWNrIGdlblx1MDBFOXJpY286IGN1YWxxdWllciBhcm1hIGRlIGZ1ZWdvIGZ1dHVyYSBzaW4gbW9kZWxvIHByb3BpbyBubyBxdWVkYSBpbnZpc2libGVcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSB0aGlzLndlYXBvbi5jb2xvcjsgY3R4LmZpbGxSZWN0KDAsIC00LCAyMiwgOCk7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMyYzNlNTAnOyBjdHguZmlsbFJlY3QoLTYsIDMsIDYsIDEwKTtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzdmOGM4ZCc7IGN0eC5maWxsUmVjdCgyMiwgLTIsIDEwLCA0KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBcclxuICAgICAgICAgICAgY3R4LnNoYWRvd0JsdXIgPSAwOyBjdHguc2hhZG93Q29sb3IgPSAndHJhbnNwYXJlbnQnOyBjdHguc2hhZG93T2Zmc2V0WSA9IDA7XHJcblxyXG4gICAgICAgICAgICAvLyBEZXN0ZWxsbyBkZSBib2NhL2dsb3c6IGVmZWN0byBwdXJhbWVudGUgY29zbVx1MDBFOXRpY28sIHNlIGFwYWdhIHBvciBjb21wbGV0byBlbiBVTFRSQVxyXG4gICAgICAgICAgICBpZiAoZ2FtZS5meEVuYWJsZWQgJiYgdGhpcy5tdXp6bGVGbGFzaCA+IDAgJiYgdGhpcy53ZWFwb24udHlwZSA9PT0gJ3JhbmdlJykge1xyXG4gICAgICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjZjFjNDBmJztcclxuICAgICAgICAgICAgICAgIGN0eC5nbG9iYWxBbHBoYSA9IDAuOTtcclxuICAgICAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTtcclxuICAgICAgICAgICAgICAgIGxldCBtWCA9IFdFQVBPTl9NVVpaTEVfWFt0aGlzLndlYXBvbi5uYW1lXSA/PyAyNTtcclxuICAgICAgICAgICAgICAgIGN0eC5hcmMobVgsIDAsIDEyICsgTWF0aC5yYW5kb20oKSoxNSwgMCwgTWF0aC5QSSoyKTtcclxuICAgICAgICAgICAgICAgIGN0eC5maWxsKCk7XHJcbiAgICAgICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyNmZmYnO1xyXG4gICAgICAgICAgICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKG1YLCAwLCA2ICsgTWF0aC5yYW5kb20oKSo1LCAwLCBNYXRoLlBJKjIpOyBjdHguZmlsbCgpO1xyXG4gICAgICAgICAgICAgICAgY3R4Lmdsb2JhbEFscGhhID0gMTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBjdHgucmVzdG9yZSgpO1xyXG5cclxuICAgICAgICAvLyBCYXJyYSBkZSBTdGFtaW5hXHJcbiAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICdyZ2JhKDAsMCwwLDAuOCknOyBcclxuICAgICAgICBjdHguZmlsbFJlY3QodGhpcy54IC0gY2FtLnggLSAyMCwgdGhpcy55IC0gY2FtLnkgKyB0aGlzLnJhZGl1cyArIDEwLCA0MCwgNSk7XHJcbiAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMzQ5OGRiJzsgXHJcbiAgICAgICAgY3R4LmZpbGxSZWN0KHRoaXMueCAtIGNhbS54IC0gMjAsIHRoaXMueSAtIGNhbS55ICsgdGhpcy5yYWRpdXMgKyAxMCwgNDAgKiAodGhpcy5zdGFtaW5hL3RoaXMubWF4U3RhbWluYSksIDUpO1xyXG5cclxuICAgICAgICAvLyBCYXJyYSBzZWN1bmRhcmlhOiBjb21idXN0aWJsZSBkZSBsYSBDaGFpbnNhdyBvIHJhbXBhIGRlIGxhIE1pbmlndW5cclxuICAgICAgICBpZiAodGhpcy53ZWFwb24gJiYgdGhpcy53ZWFwb24uZnVlbCAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAncmdiYSgwLDAsMCwwLjgpJzsgY3R4LmZpbGxSZWN0KHRoaXMueCAtIGNhbS54IC0gMjAsIHRoaXMueSAtIGNhbS55ICsgdGhpcy5yYWRpdXMgKyAxNywgNDAsIDQpO1xyXG4gICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gdGhpcy5jaGFpbnNhd0Z1ZWwgPCAyNSA/ICcjZTc0YzNjJyA6ICcjZjM5YzEyJztcclxuICAgICAgICAgICAgY3R4LmZpbGxSZWN0KHRoaXMueCAtIGNhbS54IC0gMjAsIHRoaXMueSAtIGNhbS55ICsgdGhpcy5yYWRpdXMgKyAxNywgNDAgKiAodGhpcy5jaGFpbnNhd0Z1ZWwvdGhpcy53ZWFwb24uZnVlbCksIDQpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAodGhpcy53ZWFwb24gJiYgdGhpcy53ZWFwb24uc3BpbnVwKSB7XHJcbiAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAncmdiYSgwLDAsMCwwLjgpJzsgY3R4LmZpbGxSZWN0KHRoaXMueCAtIGNhbS54IC0gMjAsIHRoaXMueSAtIGNhbS55ICsgdGhpcy5yYWRpdXMgKyAxNywgNDAsIDQpO1xyXG4gICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyNjMDM5MmInO1xyXG4gICAgICAgICAgICBjdHguZmlsbFJlY3QodGhpcy54IC0gY2FtLnggLSAyMCwgdGhpcy55IC0gY2FtLnkgKyB0aGlzLnJhZGl1cyArIDE3LCA0MCAqIHRoaXMubWluaWd1blNwaW4sIDQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZ2FtZS5yZWxvYWQgPSBmdW5jdGlvbigpIHtcclxuICAgIGxldCB3ID0gdGhpcy5wbGF5ZXIud2VhcG9uO1xyXG4gICAgaWYoIXcgfHwgdy50eXBlID09PSAnbWVsZWUnIHx8IHRoaXMucGxheWVyLmlzUmVsb2FkaW5nIHx8IHcuYW1tbyA9PT0gdy5jYXBhY2l0eSkgcmV0dXJuO1xyXG4gICAgdGhpcy5wbGF5ZXIuaXNSZWxvYWRpbmcgPSB0cnVlO1xyXG4gICAgcGxheVNGWCgncmVsb2FkJyk7XHJcbiAgICBpZiAody5zaW5nbGVSZWxvYWQpIHsgLy8gV0lOQ0hFU1RFUjogY2FyZ2EgYmFsYSBwb3IgYmFsYSwgc2UgcHVlZGUgaW50ZXJydW1waXIgY2FtYmlhbmRvIGRlIGFybWFcclxuICAgICAgICBjb25zdCBzdGVwID0gKCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAodGhpcy5wbGF5ZXIud2VhcG9uICE9PSB3KSB7IHRoaXMucGxheWVyLmlzUmVsb2FkaW5nID0gZmFsc2U7IHJldHVybjsgfSAvLyBjYW1iaWFyb24gZGUgYXJtYVxyXG4gICAgICAgICAgICB3LmFtbW8gPSBNYXRoLm1pbih3LmNhcGFjaXR5LCB3LmFtbW8gKyAxKTtcclxuICAgICAgICAgICAgcGxheVNGWCgncmVsb2FkJywgMC4yNSk7XHJcbiAgICAgICAgICAgIGlmICh3LmFtbW8gPCB3LmNhcGFjaXR5KSBzZXRUaW1lb3V0KHN0ZXAsIHcucmVsb2FkVGltZSk7XHJcbiAgICAgICAgICAgIGVsc2UgdGhpcy5wbGF5ZXIuaXNSZWxvYWRpbmcgPSBmYWxzZTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHNldFRpbWVvdXQoc3RlcCwgdy5yZWxvYWRUaW1lKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7IHcuYW1tbyA9IHcuY2FwYWNpdHk7IHRoaXMucGxheWVyLmlzUmVsb2FkaW5nID0gZmFsc2U7IH0sIHcucmVsb2FkVGltZSk7XHJcbiAgICB9XHJcbn07XHJcblxyXG5nYW1lLnNob290ID0gZnVuY3Rpb24oKSB7XHJcbiAgICBsZXQgdyA9IHRoaXMucGxheWVyLndlYXBvbjtcclxuICAgIGlmKCF3IHx8IHRoaXMucGxheWVyLmlzUmVsb2FkaW5nKSByZXR1cm47XHJcbiAgICBpZiAody5mdWVsICE9PSB1bmRlZmluZWQgJiYgdGhpcy5wbGF5ZXIuY2hhaW5zYXdGdWVsIDw9IDApIHJldHVybjsgLy8gQ0hBSU5TQVcgc2luIGNvbWJ1c3RpYmxlXHJcblxyXG4gICAgbGV0IGVmZkZpcmVSYXRlID0gdy5maXJlUmF0ZSAqIChnYW1lLndlYXBvbkZpcmVSYXRlTXVsdCB8fCAxKTtcclxuICAgIGlmICh3LnNwaW51cCkgZWZmRmlyZVJhdGUgKj0gKDEuOCAtIHRoaXMucGxheWVyLm1pbmlndW5TcGluICogMS4zKTsgLy8gTUlOSUdVTjogYXJyYW5jYSBsZW50YSwgYWNlbGVyYSBjb24gZWwgc3BpblxyXG4gICAgaWYgKERhdGUubm93KCkgLSB0aGlzLmxhc3RTaG90IDwgZWZmRmlyZVJhdGUpIHJldHVybjtcclxuXHJcbiAgICBpZih3LnR5cGUgPT09ICdtZWxlZScpIHtcclxuICAgICAgICAvLyBSYXN0cmVhIHNpIGVsIHN3aW5nIGVmZWN0aXZhbWVudGUgY29uZWN0YSBjb24gYWxnXHUwMEZBbiBlbmVtaWdvLCBwYXJhIGVsZWdpclxyXG4gICAgICAgIC8vIGVsIHNvbmlkbyBjb3JyZWN0byAobW90b3IgZ2lyYW5kbyBlbiBlbCBhaXJlIHZzLiBzb25pZG8gZGUgaW1wYWN0bylcclxuICAgICAgICBsZXQgaGl0U29tZXRoaW5nID0gZmFsc2U7XHJcbiAgICAgICAgdGhpcy5lbmVtaWVzLmZvckVhY2goZSA9PiB7XHJcbiAgICAgICAgICAgIGlmKCFlLmludnVsbmVyYWJsZSAmJiBNYXRoLmh5cG90KHRoaXMucGxheWVyLnggLSBlLngsIHRoaXMucGxheWVyLnkgLSBlLnkpIDwgdy5yYW5nZSArIGUucmFkaXVzKSB7XHJcbiAgICAgICAgICAgICAgICB0aGlzLmhpdEVuZW15KGUsIHcuZGFtYWdlKTtcclxuICAgICAgICAgICAgICAgIGhpdFNvbWV0aGluZyA9IHRydWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAody5mdWVsICE9PSB1bmRlZmluZWQpIHsgLy8gQ0hBSU5TQVc6IGNvbnN1bWUgY29tYnVzdGlibGUgbWllbnRyYXMgY29ydGFcclxuICAgICAgICAgICAgdGhpcy5wbGF5ZXIuY2hhaW5zYXdGdWVsID0gTWF0aC5tYXgoMCwgdGhpcy5wbGF5ZXIuY2hhaW5zYXdGdWVsIC0gdy5mdWVsRHJhaW4pO1xyXG4gICAgICAgICAgICB0aGlzLnBsYXllci5jaGFpbnNhd0FjdGl2ZSA9IHRydWU7XHJcbiAgICAgICAgICAgIC8vIENIQUlOU0FXID0gbW90b3IgZ2lyYW5kbyBlbiBlbCBhaXJlLCBDSEFJTlNBV0hJVCA9IGNvbmVjdGFuZG8gY29uIHVuIGVuZW1pZ29cclxuICAgICAgICAgICAgcGxheVNGWChoaXRTb21ldGhpbmcgPyAnY2hhaW5zYXdfaGl0JyA6ICdjaGFpbnNhdycsIDAuMiwgMC4wNSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgLy8gU29uaWRvIG1lbGVlIGFsZWF0b3JpbyBwYXJhIGtuaWZlL21hY2hldGVcclxuICAgICAgICAgICAgY29uc3QgbWVsZWVWYXJpYW50cyA9IFsnbWVsZWUnLCAnbWVsZWUyJywgJ21lbGVlMyddO1xyXG4gICAgICAgICAgICBwbGF5U0ZYKG1lbGVlVmFyaWFudHNbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogbWVsZWVWYXJpYW50cy5sZW5ndGgpXSwgMC4zLCAwLjEpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0aGlzLmxhc3RTaG90ID0gRGF0ZS5ub3coKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKHcuYW1tbyA8PSAwKSB7IHRoaXMucmVsb2FkKCk7IHJldHVybjsgfVxyXG4gICAgaWYgKHcuYnVyc3QgJiYgdGhpcy5wbGF5ZXIuYnVyc3RCdXN5KSByZXR1cm47IC8vIEZBTUFTOiB5YSBoYXkgdW5hIHJcdTAwRTFmYWdhIGVuIGN1cnNvXHJcblxyXG4gICAgY29uc3QgZmlyZU9uY2UgPSAoKSA9PiB7XHJcbiAgICAgICAgLy8gVXNhciBzb25pZG8gZXNwZWNcdTAwRURmaWNvIGRlbCBhcm1hLCBjb24gZmFsbGJhY2sgaW50ZWxpZ2VudGVcclxuICAgICAgICBsZXQgc291bmRLZXkgPSB3LnNmeCB8fCAnc2hvb3RfRzE4JztcclxuICAgICAgICBpZiAoc291bmRLZXkgPT09ICdzaG9vdF9HMTgnICYmIHcubmFtZSA9PT0gJ1JFVk9MVkVSJykgc291bmRLZXkgPSAnc2hvb3RfcmV2b2x2ZXInO1xyXG4gICAgICAgIGVsc2UgaWYgKHNvdW5kS2V5ID09PSAnc2hvb3RfRzE4JyAmJiBbJ0FLNDcnLCAnTTRBMScsICdGQU1BUycsICdTQ0FSJ10uaW5jbHVkZXMody5uYW1lKSkgc291bmRLZXkgPSAnc2hvb3RfcmlmbGUnO1xyXG4gICAgICAgIGVsc2UgaWYgKHNvdW5kS2V5ID09PSAnc2hvb3RfRzE4JyAmJiBbJ1VaSScsICdNUDUnLCAnUDkwJ10uaW5jbHVkZXMody5uYW1lKSkgc291bmRLZXkgPSAnc2hvb3Rfc21nJztcclxuICAgICAgICBlbHNlIGlmIChzb3VuZEtleSA9PT0gJ3Nob290X0cxOCcgJiYgWydTTklQRVInLCAnQVdQJ10uaW5jbHVkZXMody5uYW1lKSkgc291bmRLZXkgPSAnc2hvb3Rfc25pcGVyJztcclxuICAgICAgICBlbHNlIGlmIChzb3VuZEtleSA9PT0gJ3Nob290X0cxOCcgJiYgdy5uYW1lID09PSAnV0lOQ0hFU1RFUicpIHNvdW5kS2V5ID0gJ3Nob290X3NuaXBlcjInO1xyXG4gICAgICAgIFxyXG4gICAgICAgIHBsYXlTRlgoc291bmRLZXksIDAuNCwgMC4yKTtcclxuICAgICAgICB0aGlzLnBsYXllci5yZWNvaWxPZmZzZXQgPSB3LnNoYWtlICogMjtcclxuICAgICAgICB0aGlzLnBsYXllci5tdXp6bGVGbGFzaCA9IDM7XHJcbiAgICAgICAgdGhpcy5jYW1lcmEuc2hha2UgPSB3LnNoYWtlO1xyXG5cclxuICAgICAgICBsZXQgYW5nbGUgPSBNYXRoLmF0YW4yKHRoaXMubW91c2UueSAtICh0aGlzLnBsYXllci55IC0gdGhpcy5jYW1lcmEueSksIHRoaXMubW91c2UueCAtICh0aGlzLnBsYXllci54IC0gdGhpcy5jYW1lcmEueCkpO1xyXG5cclxuICAgICAgICBpZih3LmNhc2luZykgdGhpcy5zcGF3bkNhc2luZyh0aGlzLnBsYXllci54LCB0aGlzLnBsYXllci55LCBhbmdsZSk7XHJcbiAgICAgICAgaWYody5zbW9rZSkge1xyXG4gICAgICAgICAgICBmb3IobGV0IGk9MDsgaTx3LnNtb2tlOyBpKyspIHRoaXMuc3Bhd25QYXJ0aWNsZSh0aGlzLnBsYXllci54ICsgTWF0aC5jb3MoYW5nbGUpKjMwLCB0aGlzLnBsYXllci55ICsgTWF0aC5zaW4oYW5nbGUpKjMwLCB3Lm5hbWUgPT09ICdGTEFNRVRIUk9XRVInID8gJyNmZjg4MDAnIDogJyNiZGMzYzcnLCAyLCAzLCAnc21va2UnKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmKHcucGVsbGV0cykge1xyXG4gICAgICAgICAgICBmb3IobGV0IGk9MDsgaTx3LnBlbGxldHM7IGkrKykgdGhpcy5zcGF3blByb2plY3RpbGUodGhpcy5wbGF5ZXIueCwgdGhpcy5wbGF5ZXIueSwgYW5nbGUgKyAoTWF0aC5yYW5kb20oKS0wLjUpKih3LnNwcmVhZCArIChnYW1lLndlYXBvblNwcmVhZEJvbnVzIHx8IDApKSwgdyk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgbGV0IHMgPSAoTWF0aC5yYW5kb20oKS0wLjUpICogKHcuc3ByZWFkICsgKGdhbWUud2VhcG9uU3ByZWFkQm9udXMgfHwgMCkpO1xyXG4gICAgICAgICAgICB0aGlzLnNwYXduUHJvamVjdGlsZSh0aGlzLnBsYXllci54LCB0aGlzLnBsYXllci55LCBhbmdsZSArIHMsIHcpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB3LmFtbW8tLTtcclxuICAgIH07XHJcblxyXG4gICAgaWYgKHcuYnVyc3QpIHsgLy8gRkFNQVM6IGRpc3BhcmEgMyB0aXJvcyBlbmNhZGVuYWRvcyBhdW5xdWUgZWwganVnYWRvciBoYXlhIHNvbHRhZG8gZWwgY2xpY2tcclxuICAgICAgICB0aGlzLnBsYXllci5idXJzdEJ1c3kgPSB0cnVlO1xyXG4gICAgICAgIGxldCBzaG90cyA9IDA7XHJcbiAgICAgICAgY29uc3QgbmV4dFNob3QgPSAoKSA9PiB7XHJcbiAgICAgICAgICAgIGlmICh3LmFtbW8gPD0gMCB8fCBzaG90cyA+PSB3LmJ1cnN0KSB7IHRoaXMucGxheWVyLmJ1cnN0QnVzeSA9IGZhbHNlOyByZXR1cm47IH1cclxuICAgICAgICAgICAgZmlyZU9uY2UoKTsgc2hvdHMrKztcclxuICAgICAgICAgICAgaWYgKHNob3RzIDwgdy5idXJzdCAmJiB3LmFtbW8gPiAwKSBzZXRUaW1lb3V0KG5leHRTaG90LCB3LmJ1cnN0RGVsYXkpO1xyXG4gICAgICAgICAgICBlbHNlIHRoaXMucGxheWVyLmJ1cnN0QnVzeSA9IGZhbHNlO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgbmV4dFNob3QoKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZmlyZU9uY2UoKTtcclxuICAgIH1cclxuICAgIHRoaXMubGFzdFNob3QgPSBEYXRlLm5vdygpO1xyXG59O1xyXG5cclxuZ2FtZS5oaXRFbmVteSA9IGZ1bmN0aW9uKGUsIGRtZykge1xyXG4gICAgZS5ocCAtPSBkbWc7XHJcbiAgICBlLmZsYXNoID0gNDtcclxuICAgIC8vIFNpbiBzb25pZG8gZ2VuXHUwMEU5cmljbyBkZSBcImhpdFwiIGFjXHUwMEUxOiBjYWRhIGFybWEgeWEgcmVwcm9kdWNlIHN1IHByb3BpbyBzb25pZG9cclxuICAgIC8vIChkaXNwYXJvIG8gc3dpbmcvY2hhaW5zYXcpIGVuIGVsIG1vbWVudG8gZGVsIGF0YXF1ZS4gQW50ZXMgZXN0byByZXV0aWxpemFiYVxyXG4gICAgLy8gZWwgc29uaWRvIGRlIG1lbGVlIChNRUVMRS5tcDMpIHBhcmEgQ1VBTFFVSUVSIGltcGFjdG8sIGluY2x1eWVuZG8gYmFsYXMsXHJcbiAgICAvLyBwb3IgZXNvIHNlIGVzY3VjaGFiYSBlbCBcImdvbHBlIGRlIGN1Y2hpbGxvXCIgYWwgZGlzcGFyYXIgYXJtYXMgZGUgZnVlZ28uXHJcbiAgICBmb3IobGV0IGk9MDsgaTxNYXRoLmNlaWwoOCp0aGlzLnBhcnRpY2xlU2NhbGUpOyBpKyspIHRoaXMuc3Bhd25QYXJ0aWNsZShlLngsIGUueSwgZS5jb2xvciwgNCwgMywgJ25vcm1hbCcpOyBcclxuICAgIFxyXG4gICAgbGV0IHQgPSB0aGlzLmZsb2F0aW5nVGV4dHMuZmluZCh0ID0+ICF0LmFjdGl2ZSk7XHJcbiAgICBpZighdCkgeyB0ID0gbmV3IEZsb2F0aW5nVGV4dCgpOyB0aGlzLmZsb2F0aW5nVGV4dHMucHVzaCh0KTsgfVxyXG4gICAgdC5pbml0KGUueCwgZS55LCBNYXRoLmZsb29yKGRtZyksICcjZmZmJywgMjApO1xyXG5cclxuICAgIGlmKGUuaHAgPD0gMCAmJiAhZS5pc0R5aW5nKSB7XHJcbiAgICAgICAgZS5pc0R5aW5nID0gdHJ1ZTtcclxuICAgICAgICBwbGF5U0ZYKCdkZWF0aCcsIDAuNSk7XHJcbiAgICAgICAgY29uc3QgUkVXQVJEUyA9IHsgQk9TUzogMTAwMCwgVEFOSzogODAsIFJBTkdFRDogNDUsIEZBU1Q6IDI1LCBCQVNJQzogMzAsIElOVklTSUJMRTogMzUsIEtBTUlLQVpFOiAyMCwgR0hPU1Q6IDQ1IH07XHJcbiAgICAgICAgbGV0IHJld2FyZCA9IE1hdGguZmxvb3IoKFJFV0FSRFNbZS50eXBlXSA/PyAzMCkgKiAoZ2FtZS5tb25leU11bHQgfHwgMSkpO1xyXG4gICAgICAgIHRoaXMucGxheWVyLm1vbmV5ICs9IHJld2FyZDtcclxuXHJcbiAgICAgICAgbGV0IGZ0ID0gdGhpcy5mbG9hdGluZ1RleHRzLmZpbmQoZnQgPT4gIWZ0LmFjdGl2ZSk7XHJcbiAgICAgICAgaWYoIWZ0KSB7IGZ0ID0gbmV3IEZsb2F0aW5nVGV4dCgpOyB0aGlzLmZsb2F0aW5nVGV4dHMucHVzaChmdCk7IH1cclxuICAgICAgICBmdC5pbml0KGUueCwgZS55IC0gMjAsIGArJCR7cmV3YXJkfWAsICcjZjFjNDBmJywgMjQpO1xyXG5cclxuICAgICAgICBmb3IobGV0IG49MDsgbjxNYXRoLmNlaWwoMjAqdGhpcy5wYXJ0aWNsZVNjYWxlKTsgbisrKSB0aGlzLnNwYXduUGFydGljbGUoZS54LCBlLnksIGUuY29sb3IsIDYsIDQsICdub3JtYWwnKTtcclxuICAgICAgICB0aGlzLnNwYXduVHJhaWwoZS54LCBlLnksIGUucmFkaXVzICogMS41KTsgXHJcblxyXG4gICAgICAgIGNvbnN0IGlkeCA9IHRoaXMuZW5lbWllcy5pbmRleE9mKGUpO1xyXG4gICAgICAgIGlmKGlkeCAhPT0gLTEpIHRoaXMuZW5lbWllcy5zcGxpY2UoaWR4LCAxKTtcclxuICAgICAgICBcclxuICAgICAgICAvLyBBcGFyaWNpXHUwMEYzbiBkZWwgamVmZSBjdWFuZG8gcXVlZGFuIHBvY29zIGVuZW1pZ29zXHJcbiAgICAgICAgaWYgKHRoaXMuYm9zc1BlbmRpbmcgJiYgdGhpcy5lbmVtaWVzLmxlbmd0aCA8PSA0KSB7XHJcbiAgICAgICAgICAgIHRoaXMuc3Bhd25Cb3NzKCk7XHJcbiAgICAgICAgICAgIHRoaXMuYm9zc1BlbmRpbmcgPSBmYWxzZTtcclxuICAgICAgICAgICAgbGV0IGJ0ID0gdGhpcy5mbG9hdGluZ1RleHRzLmZpbmQoZnQgPT4gIWZ0LmFjdGl2ZSk7XHJcbiAgICAgICAgICAgIGlmKCFidCkgeyBidCA9IG5ldyBGbG9hdGluZ1RleHQoKTsgdGhpcy5mbG9hdGluZ1RleHRzLnB1c2goYnQpOyB9XHJcbiAgICAgICAgICAgIGJ0LmluaXQodGhpcy5wbGF5ZXIueCwgdGhpcy5wbGF5ZXIueSAtIDYwLCBcIkJPU1MgSU5DT01JTkchXCIsICcjYzAzOTJiJywgMzUpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufTtcclxuXG4vLyMgc291cmNlVVJMPXBsYXllci5qc1xuXG4vKiA9PT09PT09PT09PT09PT09PSBlbmVtaWVzLmpzID09PT09PT09PT09PT09PT09ICovXG5jbGFzcyBQcm9qZWN0aWxlIHtcclxuICAgIGluaXQoeCwgeSwgYW5nbGUsIHdlYXBvbiwgaXNFbmVteSA9IGZhbHNlKSB7XHJcbiAgICAgICAgdGhpcy54ID0geDsgdGhpcy55ID0geTtcclxuICAgICAgICB0aGlzLnZ4ID0gTWF0aC5jb3MoYW5nbGUpICogd2VhcG9uLnNwZWVkICogKGdhbWUucHJvamVjdGlsZVNwZWVkTXVsdCB8fCAxKTtcclxuICAgICAgICB0aGlzLnZ5ID0gTWF0aC5zaW4oYW5nbGUpICogd2VhcG9uLnNwZWVkICogKGdhbWUucHJvamVjdGlsZVNwZWVkTXVsdCB8fCAxKTtcclxuICAgICAgICB0aGlzLmRhbWFnZSA9IHdlYXBvbi5kYW1hZ2U7XHJcbiAgICAgICAgdGhpcy5yYWRpdXMgPSBpc0VuZW15ID8gNiA6IDQ7XHJcbiAgICAgICAgdGhpcy5jb2xvciA9IGlzRW5lbXkgPyAnI2ZmNGQ0ZCcgOiB3ZWFwb24uY29sb3I7XHJcbiAgICAgICAgdGhpcy5hY3RpdmUgPSB0cnVlOyB0aGlzLmlzRW5lbXkgPSBpc0VuZW15O1xyXG4gICAgICAgIHRoaXMudHJhaWwgPSBbXTtcclxuICAgICAgICAvLyBSYXNnb3Mgb3BjaW9uYWxlcyBkZSBhcm1hICgwL3VuZGVmaW5lZCA9IHNpbiBlZmVjdG8sIG5vIHJvbXBlIGFybWFzIHZpZWphcylcclxuICAgICAgICB0aGlzLnBpZXJjZSA9IHdlYXBvbi5waWVyY2UgfHwgMDtcclxuICAgICAgICB0aGlzLmtub2NrYmFjayA9IHdlYXBvbi5rbm9ja2JhY2sgfHwgMDtcclxuICAgICAgICB0aGlzLmJ1cm4gPSB3ZWFwb24uYnVybiB8fCBmYWxzZTtcclxuICAgICAgICB0aGlzLmV4cGxvc2l2ZSA9IHdlYXBvbi5leHBsb3NpdmUgfHwgZmFsc2U7XHJcbiAgICAgICAgdGhpcy5leHBsb3Npb25SYWRpdXMgPSB3ZWFwb24uZXhwbG9zaW9uUmFkaXVzIHx8IDA7XHJcbiAgICAgICAgdGhpcy5tYXhSYW5nZSA9IHdlYXBvbi5tYXhSYW5nZSB8fCAxODAwOyAvLyByZWNpY2xhIGVsIHByb3llY3RpbCBhdW5xdWUgbGEgd2Fwb24gbm8gZGVmaW5hIHVuIHJhbmdvIHByb3Bpb1xyXG4gICAgICAgIHRoaXMudHJhdmVsZWQgPSAwO1xyXG4gICAgICAgIHRoaXMuaGl0RW5lbWllcyA9IHRoaXMuaGl0RW5lbWllcyB8fCBuZXcgU2V0KCk7XHJcbiAgICAgICAgaWYgKHRoaXMuaGl0RW5lbWllcy5zaXplKSB0aGlzLmhpdEVuZW1pZXMuY2xlYXIoKTtcclxuICAgIH1cclxuICAgIHVwZGF0ZSgpIHtcclxuICAgICAgICB0aGlzLnRyYWlsLnB1c2goe3g6IHRoaXMueCwgeTogdGhpcy55fSk7XHJcbiAgICAgICAgaWYodGhpcy50cmFpbC5sZW5ndGggPiA1KSB0aGlzLnRyYWlsLnNoaWZ0KCk7XHJcbiAgICAgICAgdGhpcy54ICs9IHRoaXMudng7IHRoaXMueSArPSB0aGlzLnZ5O1xyXG4gICAgICAgIGlmICh0aGlzLm1heFJhbmdlKSB7XHJcbiAgICAgICAgICAgIHRoaXMudHJhdmVsZWQgKz0gTWF0aC5oeXBvdCh0aGlzLnZ4LCB0aGlzLnZ5KTtcclxuICAgICAgICAgICAgaWYgKHRoaXMudHJhdmVsZWQgPiB0aGlzLm1heFJhbmdlKSB0aGlzLmFjdGl2ZSA9IGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZih0aGlzLnggPCAwIHx8IHRoaXMueCA+IE1BUF9TSVpFIHx8IHRoaXMueSA8IDAgfHwgdGhpcy55ID4gTUFQX1NJWkUpIHRoaXMuYWN0aXZlID0gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBkcmF3KGNhbSkge1xyXG4gICAgICAgIGlmICghaXNWaXNpYmxlKHRoaXMueCwgdGhpcy55LCAyMCwgY2FtKSkgcmV0dXJuO1xyXG4gICAgICAgIGN0eC5iZWdpblBhdGgoKTtcclxuICAgICAgICBjdHgubW92ZVRvKHRoaXMueCAtIGNhbS54LCB0aGlzLnkgLSBjYW0ueSk7XHJcbiAgICAgICAgZm9yKGxldCBpID0gdGhpcy50cmFpbC5sZW5ndGggLSAxOyBpID49IDA7IGktLSkgeyBjdHgubGluZVRvKHRoaXMudHJhaWxbaV0ueCAtIGNhbS54LCB0aGlzLnRyYWlsW2ldLnkgLSBjYW0ueSk7IH1cclxuICAgICAgICBjdHguc3Ryb2tlU3R5bGUgPSB0aGlzLmNvbG9yOyBjdHgubGluZVdpZHRoID0gdGhpcy5yYWRpdXM7IGN0eC5saW5lQ2FwID0gJ3JvdW5kJztcclxuICAgICAgICBjdHguZ2xvYmFsQWxwaGEgPSAwLjU7IGN0eC5zdHJva2UoKTsgY3R4Lmdsb2JhbEFscGhhID0gMTtcclxuXHJcbiAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjZmZmJztcclxuICAgICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmModGhpcy54IC0gY2FtLngsIHRoaXMueSAtIGNhbS55LCB0aGlzLnJhZGl1cywgMCwgTWF0aC5QSSoyKTsgY3R4LmZpbGwoKTtcclxuICAgIH1cclxufVxyXG5cclxuY2xhc3MgRW5lbXkge1xyXG4gICAgY29uc3RydWN0b3IoeCwgeSwgdHlwZSkge1xyXG4gICAgICAgIHRoaXMueCA9IHg7IHRoaXMueSA9IHk7IHRoaXMudHlwZSA9IHR5cGU7XHJcbiAgICAgICAgdGhpcy5mbGFzaCA9IDA7IHRoaXMudGljayA9IE1hdGgucmFuZG9tKCkgKiAxMDA7XHJcbiAgICAgICAgdGhpcy5pc0R5aW5nID0gZmFsc2U7XHJcbiAgICAgICAgXHJcbiAgICAgICAgY29uc3QgbSA9IDEgKyAoZ2FtZS53YXZlICogMC4yNSk7XHJcbiAgICAgICAgaWYodHlwZSA9PT0gJ1RBTksnKSB7IHRoaXMubWF4SHAgPSAzMDAgKiBtOyB0aGlzLnNwZWVkID0gMS4xOyB0aGlzLnJhZGl1cyA9IDM1OyB0aGlzLmNvbG9yID0gJyMyYzNlNTAnOyB9IFxyXG4gICAgICAgIGVsc2UgaWYodHlwZSA9PT0gJ0ZBU1QnKSB7IHRoaXMubWF4SHAgPSA0MCAqIG07IHRoaXMuc3BlZWQgPSA0LjA7IHRoaXMucmFkaXVzID0gMTg7IHRoaXMuY29sb3IgPSAnI2U2N2UyMic7IH0gXHJcbiAgICAgICAgZWxzZSBpZih0eXBlID09PSAnUkFOR0VEJykgeyB0aGlzLm1heEhwID0gODAgKiBtOyB0aGlzLnNwZWVkID0gMS44OyB0aGlzLnJhZGl1cyA9IDI0OyB0aGlzLmNvbG9yID0gJyM4ZTQ0YWQnOyB0aGlzLmxhc3RTaG90ID0gMDsgfSBcclxuICAgICAgICBlbHNlIGlmKHR5cGUgPT09ICdJTlZJU0lCTEUnKSB7IHRoaXMubWF4SHAgPSA2MCAqIG07IHRoaXMuc3BlZWQgPSAyLjQ7IHRoaXMucmFkaXVzID0gMjI7IHRoaXMuY29sb3IgPSAnIzE2YTA4NSc7IHRoaXMuaW52aXNBbHBoYSA9IDA7IHRoaXMub25zY3JlZW5WaXNpYmxlVGltZXIgPSAwOyB0aGlzLndhc09uU2NyZWVuID0gZmFsc2U7IH1cclxuICAgICAgICBlbHNlIGlmKHR5cGUgPT09ICdLQU1JS0FaRScpIHsgdGhpcy5tYXhIcCA9IDI1ICogbTsgdGhpcy5zcGVlZCA9IDIuNCAqIDEuMzsgdGhpcy5yYWRpdXMgPSAyMDsgdGhpcy5jb2xvciA9ICcjZTc0YzNjJzsgdGhpcy5iYXNlQ29sb3IgPSB0aGlzLmNvbG9yOyB0aGlzLmthbWlrYXplU3RhdGUgPSAnQ0hBU0UnOyB0aGlzLmthbWlrYXplVGltZXIgPSAwOyB0aGlzLmV4cGxvZGVTY2FsZSA9IDE7IH1cclxuICAgICAgICBlbHNlIGlmKHR5cGUgPT09ICdHSE9TVCcpIHsgdGhpcy5tYXhIcCA9IDkwICogbTsgdGhpcy5zcGVlZCA9IDIuMDsgdGhpcy5yYWRpdXMgPSAyMjsgdGhpcy5jb2xvciA9ICcjOWI1OWI2JzsgdGhpcy5naG9zdFN0YXRlID0gJ0dIT1NUJzsgdGhpcy5naG9zdFRpbWVyID0gMDsgdGhpcy5naG9zdEFscGhhID0gMC4xODsgdGhpcy5pbnZ1bG5lcmFibGUgPSB0cnVlOyB9XHJcbiAgICAgICAgZWxzZSBpZih0eXBlID09PSAnQk9TUycpIHsgXHJcbiAgICAgICAgICAgIHRoaXMuYm9zc1dhdmUgPSBnYW1lLndhdmU7XHJcbiAgICAgICAgICAgIGlmICh0aGlzLmJvc3NXYXZlID49IDMwKSB7XHJcbiAgICAgICAgICAgICAgICB0aGlzLm1heEhwID0gKDQwMDAgKyAodGhpcy5ib3NzV2F2ZSAtIDMwKSAqIDUwMCkgKiBtO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuYm9zc1dhdmUgPj0gMTUpIHtcclxuICAgICAgICAgICAgICAgIHRoaXMubWF4SHAgPSAyNTAwICogbTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHRoaXMubWF4SHAgPSAxNTAwICogbTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB0aGlzLnNwZWVkID0gMS42OyB0aGlzLnJhZGl1cyA9IDcwOyB0aGlzLmNvbG9yID0gJyNjMDM5MmInOyBcclxuICAgICAgICAgICAgdGhpcy5zdGF0ZSA9ICdJRExFJzsgdGhpcy5zdGF0ZVRpbWVyID0gMDsgdGhpcy5zdW1tb25UaW1lciA9IDA7XHJcbiAgICAgICAgICAgIHRoaXMuZGFzaFRhcmdldEFuZ2xlID0gMDsgdGhpcy5zaG9vdENvdW50ID0gMDtcclxuICAgICAgICB9IFxyXG4gICAgICAgIGVsc2UgeyB0aGlzLm1heEhwID0gNzAgKiBtOyB0aGlzLnNwZWVkID0gMi40OyB0aGlzLnJhZGl1cyA9IDIyOyB0aGlzLmNvbG9yID0gJyMyN2FlNjAnOyB9XHJcbiAgICAgICAgLy8gTW9kaWZpY2Fkb3JlcyBkZSBldmVudG9zIGRpblx1MDBFMW1pY29zIChNdXRhY2lcdTAwRjNuIGFncmFuZGEvZm9ydGFsZWNlLCBldGMuIFZlciBldmVudHMuanMpXHJcbiAgICAgICAgdGhpcy5zcGVlZCAqPSAoZ2FtZS5lbmVteVNwZWVkTXVsdCB8fCAxKTtcclxuICAgICAgICBpZiAoZ2FtZS5lbmVteVNpemVNdWx0KSB0aGlzLnJhZGl1cyAqPSBnYW1lLmVuZW15U2l6ZU11bHQ7XHJcbiAgICAgICAgaWYgKGdhbWUuZW5lbXlIcE11bHQpIHRoaXMubWF4SHAgKj0gZ2FtZS5lbmVteUhwTXVsdDtcclxuICAgICAgICB0aGlzLmhwID0gdGhpcy5tYXhIcDtcclxuICAgIH1cclxuICAgIHVwZGF0ZShwbGF5ZXIpIHtcclxuICAgICAgICB0aGlzLnRpY2sgKz0gMC4yO1xyXG4gICAgICAgIGxldCBkID0gdGhpcy5fZGlzdCAhPT0gdW5kZWZpbmVkID8gdGhpcy5fZGlzdCA6IE1hdGguaHlwb3QocGxheWVyLnggLSB0aGlzLngsIHBsYXllci55IC0gdGhpcy55KTtcclxuICAgICAgICBsZXQgYW5nbGUgPSBNYXRoLmF0YW4yKHBsYXllci55IC0gdGhpcy55LCBwbGF5ZXIueCAtIHRoaXMueCk7XHJcblxyXG4gICAgICAgIGlmICh0aGlzLnR5cGUgPT09ICdLQU1JS0FaRScpIHtcclxuICAgICAgICAgICAgaWYgKHRoaXMua2FtaWthemVTdGF0ZSA9PT0gJ0NIQVNFJyAmJiBkIDwgMTIwKSB7IHRoaXMua2FtaWthemVTdGF0ZSA9ICdBUk1FRCc7IHRoaXMua2FtaWthemVUaW1lciA9IDA7IH1cclxuICAgICAgICAgICAgaWYgKHRoaXMua2FtaWthemVTdGF0ZSA9PT0gJ0FSTUVEJykge1xyXG4gICAgICAgICAgICAgICAgdGhpcy5rYW1pa2F6ZVRpbWVyKys7XHJcbiAgICAgICAgICAgICAgICB0aGlzLmNvbG9yID0gdGhpcy5rYW1pa2F6ZVRpbWVyICUgNiA8IDMgPyAnI2ZmZicgOiB0aGlzLmJhc2VDb2xvcjtcclxuICAgICAgICAgICAgICAgIHRoaXMuZXhwbG9kZVNjYWxlID0gMSArIE1hdGgubWluKDAuNCwgKHRoaXMua2FtaWthemVUaW1lciAvIDYwKSAqIDAuNCk7XHJcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5rYW1pa2F6ZVRpbWVyID4gNjApIHsgLy8gfjFzIGRlIGN1ZW50YSByZWdyZXNpdmEgYW50ZXMgZGUgZXhwbG90YXJcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBibGFzdFJhZGl1cyA9IDEyMDtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoZCA8IGJsYXN0UmFkaXVzKSBwbGF5ZXIudGFrZURhbWFnZSgzNSk7XHJcbiAgICAgICAgICAgICAgICAgICAgZ2FtZS5lbmVtaWVzLmZvckVhY2gob3RoZXIgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAob3RoZXIgIT09IHRoaXMgJiYgIW90aGVyLmludnVsbmVyYWJsZSAmJiBNYXRoLmh5cG90KG90aGVyLnggLSB0aGlzLngsIG90aGVyLnkgLSB0aGlzLnkpIDwgYmxhc3RSYWRpdXMpIGdhbWUuaGl0RW5lbXkob3RoZXIsIDQwKTtcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBnYW1lLmNhbWVyYS5zaGFrZSA9IDEyO1xyXG4gICAgICAgICAgICAgICAgICAgIGZvcihsZXQgaT0wOyBpPE1hdGguY2VpbCgyMCpnYW1lLnBhcnRpY2xlU2NhbGUpOyBpKyspIGdhbWUuc3Bhd25QYXJ0aWNsZSh0aGlzLngsIHRoaXMueSwgJyNlNzRjM2MnLCA2LCA0LCAnbm9ybWFsJyk7XHJcbiAgICAgICAgICAgICAgICAgICAgZ2FtZS5oaXRFbmVteSh0aGlzLCB0aGlzLmhwKTsgLy8gc2UgYXV0b2Rlc3RydXllIHJldXRpbGl6YW5kbyBsYSBsXHUwMEYzZ2ljYSBkZSBtdWVydGUgZXhpc3RlbnRlXHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRoaXMudHlwZSA9PT0gJ0lOVklTSUJMRScpIHtcclxuICAgICAgICAgICAgY29uc3Qgb25TY3JlZW4gPSBpc1Zpc2libGUodGhpcy54LCB0aGlzLnksIHRoaXMucmFkaXVzLCBnYW1lLmNhbWVyYSk7XHJcbiAgICAgICAgICAgIGlmIChvblNjcmVlbiAmJiAhdGhpcy53YXNPblNjcmVlbikgdGhpcy5vbnNjcmVlblZpc2libGVUaW1lciA9IDEyMDsgLy8gfjJzIGEgNjBmcHNcclxuICAgICAgICAgICAgdGhpcy53YXNPblNjcmVlbiA9IG9uU2NyZWVuO1xyXG4gICAgICAgICAgICBpZiAodGhpcy5vbnNjcmVlblZpc2libGVUaW1lciA+IDApIHsgdGhpcy5pbnZpc0FscGhhID0gTWF0aC5taW4oMSwgdGhpcy5pbnZpc0FscGhhICsgMC4wOCk7IHRoaXMub25zY3JlZW5WaXNpYmxlVGltZXItLTsgfVxyXG4gICAgICAgICAgICBlbHNlIHRoaXMuaW52aXNBbHBoYSA9IE1hdGgubWF4KDAsIHRoaXMuaW52aXNBbHBoYSAtIDAuMDUpO1xyXG4gICAgICAgICAgICBpZiAoTWF0aC5yYW5kb20oKSA+IDAuOSkgZ2FtZS5zcGF3blRyYWlsKHRoaXMueCwgdGhpcy55LCB0aGlzLnJhZGl1cyAqIDAuNSk7IC8vIHJhc3RybyB0ZW51ZVxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodGhpcy50eXBlID09PSAnR0hPU1QnKSB7XHJcbiAgICAgICAgICAgIHRoaXMuZ2hvc3RUaW1lcisrO1xyXG4gICAgICAgICAgICBpZiAodGhpcy5naG9zdFN0YXRlID09PSAnR0hPU1QnICYmIHRoaXMuZ2hvc3RUaW1lciA+IDE4MCkgeyB0aGlzLmdob3N0U3RhdGUgPSAnU09MSUQnOyB0aGlzLmdob3N0VGltZXIgPSAwOyB0aGlzLmludnVsbmVyYWJsZSA9IGZhbHNlOyB9XHJcbiAgICAgICAgICAgIGVsc2UgaWYgKHRoaXMuZ2hvc3RTdGF0ZSA9PT0gJ1NPTElEJyAmJiB0aGlzLmdob3N0VGltZXIgPiAxMjApIHsgdGhpcy5naG9zdFN0YXRlID0gJ0dIT1NUJzsgdGhpcy5naG9zdFRpbWVyID0gMDsgdGhpcy5pbnZ1bG5lcmFibGUgPSB0cnVlOyB9XHJcbiAgICAgICAgICAgIGNvbnN0IHRhcmdldEdob3N0QWxwaGEgPSB0aGlzLmdob3N0U3RhdGUgPT09ICdHSE9TVCcgPyAwLjE4IDogMTtcclxuICAgICAgICAgICAgdGhpcy5naG9zdEFscGhhICs9ICh0YXJnZXRHaG9zdEFscGhhIC0gdGhpcy5naG9zdEFscGhhKSAqIDAuMDg7IC8vIHRyYW5zaWNpXHUwMEYzbiBzdWF2ZVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKHRoaXMudHlwZSA9PT0gJ0JPU1MnKSB7XHJcbiAgICAgICAgICAgIHRoaXMuc3RhdGVUaW1lcisrO1xyXG4gICAgICAgICAgICB0aGlzLnN1bW1vblRpbWVyKys7XHJcbiAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAvLyBJbnZvY2FjaVx1MDBGM24gKEJvc3MgV2F2ZSAzMCspXHJcbiAgICAgICAgICAgIGlmICh0aGlzLmJvc3NXYXZlID49IDMwICYmIHRoaXMuc3VtbW9uVGltZXIgPiA2MCAqIDEyKSB7IC8vIENhZGEgfjEyIHNlZ3VuZG9zXHJcbiAgICAgICAgICAgICAgICB0aGlzLnN1bW1vblRpbWVyID0gMDtcclxuICAgICAgICAgICAgICAgIGdhbWUuZW5lbWllcy5wdXNoKG5ldyBFbmVteSh0aGlzLnggKyAxMDAsIHRoaXMueSwgJ1RBTksnKSk7XHJcbiAgICAgICAgICAgICAgICBnYW1lLmVuZW1pZXMucHVzaChuZXcgRW5lbXkodGhpcy54IC0gMTAwLCB0aGlzLnksICdUQU5LJykpO1xyXG4gICAgICAgICAgICAgICAgZ2FtZS5lbmVtaWVzLnB1c2gobmV3IEVuZW15KHRoaXMueCwgdGhpcy55ICsgMTAwLCAnUkFOR0VEJykpO1xyXG4gICAgICAgICAgICAgICAgZ2FtZS5lbmVtaWVzLnB1c2gobmV3IEVuZW15KHRoaXMueCwgdGhpcy55IC0gMTAwLCAnUkFOR0VEJykpO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBpZiAodGhpcy5zdGF0ZSA9PT0gJ0lETEUnKSB7XHJcbiAgICAgICAgICAgICAgICB0aGlzLnggKz0gTWF0aC5jb3MoYW5nbGUpICogdGhpcy5zcGVlZDtcclxuICAgICAgICAgICAgICAgIHRoaXMueSArPSBNYXRoLnNpbihhbmdsZSkgKiB0aGlzLnNwZWVkO1xyXG4gICAgICAgICAgICAgICAgXHJcbiAgICAgICAgICAgICAgICBsZXQgbGltaXQgPSB0aGlzLmJvc3NXYXZlID49IDMwID8gNTAgOiAodGhpcy5ib3NzV2F2ZSA+PSAxNSA/IDcwIDogMTAwKTtcclxuICAgICAgICAgICAgICAgIGlmICh0aGlzLnN0YXRlVGltZXIgPiBsaW1pdCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc3RhdGVUaW1lciA9IDA7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuYm9zc1dhdmUgPj0gMTUgJiYgTWF0aC5yYW5kb20oKSA8IDAuNSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnN0YXRlID0gJ1NIT09UJztcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zaG9vdENvdW50ID0gMDtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnN0YXRlID0gJ1RFTEVHUkFQSCc7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuc3RhdGUgPT09ICdURUxFR1JBUEgnKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBUZW1ibG9yIHkgY2FtYmlvIGRlIGNvbG9yIHBhcmEgYXZpc2FyIHF1ZSB2YSBhIGRhc2hlYXJcclxuICAgICAgICAgICAgICAgIHRoaXMueCArPSAoTWF0aC5yYW5kb20oKSAtIDAuNSkgKiA0O1xyXG4gICAgICAgICAgICAgICAgdGhpcy55ICs9IChNYXRoLnJhbmRvbSgpIC0gMC41KSAqIDQ7XHJcbiAgICAgICAgICAgICAgICB0aGlzLmNvbG9yID0gdGhpcy5zdGF0ZVRpbWVyICUgOCA8IDQgPyAnI2ZmZicgOiAnI2MwMzkyYic7XHJcbiAgICAgICAgICAgICAgICBcclxuICAgICAgICAgICAgICAgIGxldCB0ZWxlVGltZSA9IHRoaXMuYm9zc1dhdmUgPj0gMzAgPyAzMCA6IDUwO1xyXG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuc3RhdGVUaW1lciA+IHRlbGVUaW1lKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5zdGF0ZSA9ICdEQVNIJztcclxuICAgICAgICAgICAgICAgICAgICB0aGlzLnN0YXRlVGltZXIgPSAwO1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuZGFzaFRhcmdldEFuZ2xlID0gYW5nbGU7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5kYXNoU3BlZWQgPSB0aGlzLmJvc3NXYXZlID49IDMwID8gMjUgOiAxODsgLy8gRGFzaCBidWZmZWFkbyBzaSBlcyAzMCtcclxuICAgICAgICAgICAgICAgICAgICB0aGlzLmNvbG9yID0gJyNjMDM5MmInO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuc3RhdGUgPT09ICdEQVNIJykge1xyXG4gICAgICAgICAgICAgICAgdGhpcy54ICs9IE1hdGguY29zKHRoaXMuZGFzaFRhcmdldEFuZ2xlKSAqIHRoaXMuZGFzaFNwZWVkO1xyXG4gICAgICAgICAgICAgICAgdGhpcy55ICs9IE1hdGguc2luKHRoaXMuZGFzaFRhcmdldEFuZ2xlKSAqIHRoaXMuZGFzaFNwZWVkO1xyXG4gICAgICAgICAgICAgICAgXHJcbiAgICAgICAgICAgICAgICBpZiAoTWF0aC5yYW5kb20oKSA+IDAuNCkgZ2FtZS5zcGF3blRyYWlsKHRoaXMueCwgdGhpcy55LCB0aGlzLnJhZGl1cyk7XHJcbiAgICAgICAgICAgICAgICBcclxuICAgICAgICAgICAgICAgIGlmICh0aGlzLnN0YXRlVGltZXIgPiAyNSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc3RhdGUgPSAnSURMRSc7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5zdGF0ZVRpbWVyID0gMDtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLnN0YXRlID09PSAnU0hPT1QnKSB7XHJcbiAgICAgICAgICAgICAgICB0aGlzLnggKz0gTWF0aC5jb3MoYW5nbGUpICogKHRoaXMuc3BlZWQgKiAwLjMpO1xyXG4gICAgICAgICAgICAgICAgdGhpcy55ICs9IE1hdGguc2luKGFuZ2xlKSAqICh0aGlzLnNwZWVkICogMC4zKTtcclxuICAgICAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuc3RhdGVUaW1lciAlIDIwID09PSAwKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuYm9zc1dhdmUgPj0gMzApIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gTXVjaG9zIG1cdTAwRTFzIHBhdHJvbmVzIGRlIGRpc3Bhcm9cclxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG9mZnNldCA9IHRoaXMuc3RhdGVUaW1lciAqIDAuMTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9yKGxldCBpPTA7IGk8MTI7IGkrKykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGEgPSAoTWF0aC5QSSoyLzEyKSAqIGkgKyBvZmZzZXQ7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBnYW1lLnNwYXduUHJvamVjdGlsZSh0aGlzLngsIHRoaXMueSwgYSwge3NwZWVkOiA3LCBkYW1hZ2U6IDIwICogKGdhbWUuZW5lbXlEYW1hZ2VNdWx0IHx8IDEpLCBjb2xvcjogJyNmMzljMTInfSwgdHJ1ZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBEaXNwYXJvcyB3YXZlIDE1XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcihsZXQgaT0wOyBpPDY7IGkrKykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGEgPSAoTWF0aC5QSSoyLzYpICogaTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGdhbWUuc3Bhd25Qcm9qZWN0aWxlKHRoaXMueCwgdGhpcy55LCBhLCB7c3BlZWQ6IDUsIGRhbWFnZTogMTUgKiAoZ2FtZS5lbmVteURhbWFnZU11bHQgfHwgMSksIGNvbG9yOiAnI2YzOWMxMid9LCB0cnVlKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB0aGlzLnNob290Q291bnQrKztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAgICAgbGV0IG1heFNob290cyA9IHRoaXMuYm9zc1dhdmUgPj0gMzAgPyA2IDogMztcclxuICAgICAgICAgICAgICAgIGlmICh0aGlzLnNob290Q291bnQgPj0gbWF4U2hvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5zdGF0ZSA9ICdJRExFJztcclxuICAgICAgICAgICAgICAgICAgICB0aGlzLnN0YXRlVGltZXIgPSAwO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBcclxuICAgICAgICBlbHNlIGlmKHRoaXMudHlwZSA9PT0gJ1JBTkdFRCcgJiYgZCA8IDQ1MCkge1xyXG4gICAgICAgICAgICBpZihkIDwgMzUwKSB7IHRoaXMueCAtPSBNYXRoLmNvcyhhbmdsZSkgKiB0aGlzLnNwZWVkOyB0aGlzLnkgLT0gTWF0aC5zaW4oYW5nbGUpICogdGhpcy5zcGVlZDsgfVxyXG4gICAgICAgICAgICBpZihEYXRlLm5vdygpIC0gdGhpcy5sYXN0U2hvdCA+IDE1MDApIHtcclxuICAgICAgICAgICAgICAgIGdhbWUuc3Bhd25Qcm9qZWN0aWxlKHRoaXMueCwgdGhpcy55LCBhbmdsZSwge3NwZWVkOiA4LCBkYW1hZ2U6IDE1ICogKGdhbWUuZW5lbXlEYW1hZ2VNdWx0IHx8IDEpLCBjb2xvcjogJyNmZjRkNGQnfSwgdHJ1ZSk7XHJcbiAgICAgICAgICAgICAgICB0aGlzLmxhc3RTaG90ID0gRGF0ZS5ub3coKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gZWxzZSBpZih0aGlzLnR5cGUgPT09ICdLQU1JS0FaRScgJiYgdGhpcy5rYW1pa2F6ZVN0YXRlID09PSAnQVJNRUQnKSB7XHJcbiAgICAgICAgICAgIC8vIFNlIGRldGllbmUgbWllbnRyYXMgYXJtYSBsYSBleHBsb3NpXHUwMEYzblxyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHRoaXMueCArPSBNYXRoLmNvcyhhbmdsZSkgKiB0aGlzLnNwZWVkOyB0aGlzLnkgKz0gTWF0aC5zaW4oYW5nbGUpICogdGhpcy5zcGVlZDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmKGQgPCB0aGlzLnJhZGl1cyArIHBsYXllci5yYWRpdXMpIHBsYXllci50YWtlRGFtYWdlKDAuNSAqIChnYW1lLmVuZW15RGFtYWdlTXVsdCB8fCAxKSk7XHJcbiAgICAgICAgaWYodGhpcy5mbGFzaCA+IDApIHRoaXMuZmxhc2gtLTtcclxuICAgICAgICAvLyBRdWVtYWR1cmEgKExhbnphbGxhbWFzKTogdGljIGRlIGRhXHUwMEYxbyBwZXJpXHUwMEYzZGljbyBpbmRlcGVuZGllbnRlIGRlbCBmbGFzaCBkZSBnb2xwZVxyXG4gICAgICAgIGlmICh0aGlzLmJ1cm5UaWNrcyA+IDApIHtcclxuICAgICAgICAgICAgdGhpcy5idXJuVGlja3MtLTtcclxuICAgICAgICAgICAgaWYgKHRoaXMuYnVyblRpY2tzICUgMjAgPT09IDAgJiYgIXRoaXMuaXNEeWluZykge1xyXG4gICAgICAgICAgICAgICAgZ2FtZS5oaXRFbmVteSh0aGlzLCB0aGlzLmJ1cm5EbWcgfHwgMyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoaXNWaXNpYmxlKHRoaXMueCwgdGhpcy55LCB0aGlzLnJhZGl1cywgZ2FtZS5jYW1lcmEpKSBnYW1lLnNwYXduUGFydGljbGUodGhpcy54LCB0aGlzLnkgLSB0aGlzLnJhZGl1cyowLjUsICcjZmY4ODAwJywgMiwgMywgJ25vcm1hbCcpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgZHJhdyhjYW0pIHtcclxuICAgICAgICBpZiAoIWlzVmlzaWJsZSh0aGlzLngsIHRoaXMueSwgdGhpcy5yYWRpdXMgKiAyLCBjYW0pKSByZXR1cm47XHJcblxyXG4gICAgICAgIGxldCB0eXBlQWxwaGEgPSAxO1xyXG4gICAgICAgIGlmICh0aGlzLnR5cGUgPT09ICdJTlZJU0lCTEUnKSB0eXBlQWxwaGEgPSB0aGlzLmludmlzQWxwaGE7XHJcbiAgICAgICAgaWYgKHRoaXMudHlwZSA9PT0gJ0dIT1NUJykgdHlwZUFscGhhID0gdGhpcy5naG9zdEFscGhhO1xyXG5cclxuICAgICAgICBjb25zdCBib3VuY2UgPSBNYXRoLmFicyhNYXRoLnNpbih0aGlzLnRpY2spKSAqICh0aGlzLnNwZWVkICogMS41KTtcclxuICAgICAgICBsZXQgc3RyZXRjaCA9IDEgKyBNYXRoLmFicyhNYXRoLmNvcyh0aGlzLnRpY2spKSAqIDAuMTU7XHJcbiAgICAgICAgaWYgKHRoaXMudHlwZSA9PT0gJ0ZBU1QnKSBzdHJldGNoICo9IDEuMjtcclxuXHJcbiAgICAgICAgaWYgKGdhbWUuc2hhZG93c0VuYWJsZWQpIHtcclxuICAgICAgICAgICAgY3R4Lmdsb2JhbEFscGhhID0gdHlwZUFscGhhO1xyXG4gICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gXCJyZ2JhKDAsMCwwLDAuMzUpXCI7XHJcbiAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmVsbGlwc2UodGhpcy54IC0gY2FtLngsIHRoaXMueSAtIGNhbS55ICsgdGhpcy5yYWRpdXMqMC44LCB0aGlzLnJhZGl1cyAqIDEuMiwgdGhpcy5yYWRpdXMgKiAwLjQsIDAsIDAsIE1hdGguUEkqMik7IGN0eC5maWxsKCk7XHJcbiAgICAgICAgICAgIGN0eC5nbG9iYWxBbHBoYSA9IDE7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjdHguc2F2ZSgpO1xyXG4gICAgICAgIGN0eC5nbG9iYWxBbHBoYSA9IHR5cGVBbHBoYTtcclxuICAgICAgICBjdHgudHJhbnNsYXRlKHRoaXMueCAtIGNhbS54LCB0aGlzLnkgLSBjYW0ueSAtIGJvdW5jZSk7XHJcbiAgICAgICAgXHJcbiAgICAgICAgaWYgKHRoaXMudHlwZSA9PT0gJ0ZBU1QnKSB7XHJcbiAgICAgICAgICAgIGN0eC5zY2FsZSgxIC8gc3RyZXRjaCwgc3RyZXRjaCk7IFxyXG4gICAgICAgIH0gZWxzZSBpZiAodGhpcy50eXBlID09PSAnVEFOSycpIHtcclxuICAgICAgICAgICAgY3R4LnNjYWxlKHN0cmV0Y2gsIDEgLyBzdHJldGNoKTsgXHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY3R4LnNjYWxlKDEgLyBzdHJldGNoLCBzdHJldGNoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgXHJcbiAgICAgICAgY3R4LmZpbGxTdHlsZSA9IHRoaXMuZmxhc2ggPiAwID8gJyNmZmYnIDogdGhpcy5jb2xvcjtcclxuICAgICAgICBjdHguc3Ryb2tlU3R5bGUgPSAnIzAwMCc7IGN0eC5saW5lV2lkdGggPSAzO1xyXG5cclxuICAgICAgICBpZiAodGhpcy50eXBlID09PSAnVEFOSycpIHtcclxuICAgICAgICAgICAgY3R4LmJlZ2luUGF0aCgpO1xyXG4gICAgICAgICAgICBmb3IobGV0IGk9MDsgaTw2OyBpKyspIHtcclxuICAgICAgICAgICAgICAgIGN0eC5saW5lVG8oTWF0aC5jb3MoaSAqIE1hdGguUEkvMykgKiB0aGlzLnJhZGl1cywgTWF0aC5zaW4oaSAqIE1hdGguUEkvMykgKiB0aGlzLnJhZGl1cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY3R4LmNsb3NlUGF0aCgpOyBjdHguZmlsbCgpOyBjdHguc3Ryb2tlKCk7XHJcbiAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbygtMTAsIC0xMCk7IGN0eC5saW5lVG8oMCwgNSk7IGN0eC5saW5lVG8oMTUsIC01KTsgY3R4LnN0cm9rZSgpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAodGhpcy50eXBlID09PSAnQk9TUycpIHtcclxuICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjOTIyYjIxJztcclxuICAgICAgICAgICAgY3R4LmJlZ2luUGF0aCgpO1xyXG4gICAgICAgICAgICBmb3IobGV0IGk9MDsgaTwxMjsgaSsrKSB7XHJcbiAgICAgICAgICAgICAgICBsZXQgciA9IHRoaXMucmFkaXVzICogKGklMiA9PT0gMCA/IDEuMiA6IDAuOSk7XHJcbiAgICAgICAgICAgICAgICBjdHgubGluZVRvKE1hdGguY29zKGkgKiBNYXRoLlBJLzYpICogciwgTWF0aC5zaW4oaSAqIE1hdGguUEkvNikgKiByKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjdHguY2xvc2VQYXRoKCk7IGN0eC5maWxsKCk7IGN0eC5zdHJva2UoKTtcclxuICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9IHRoaXMuZmxhc2ggPiAwID8gJyNmZmYnIDogdGhpcy5jb2xvcjtcclxuICAgICAgICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKDAsIDAsIHRoaXMucmFkaXVzICogMC44LCAwLCBNYXRoLlBJKjIpOyBjdHguZmlsbCgpOyBjdHguc3Ryb2tlKCk7XHJcbiAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzAwMCc7XHJcbiAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbygtdGhpcy5yYWRpdXMqMC41LCAtdGhpcy5yYWRpdXMqMC43KTsgY3R4LmxpbmVUbygtdGhpcy5yYWRpdXMqMC45LCAtdGhpcy5yYWRpdXMqMS4zKTsgY3R4LmxpbmVUbygtdGhpcy5yYWRpdXMqMC4yLCAtdGhpcy5yYWRpdXMqMC44KTsgY3R4LmZpbGwoKTtcclxuICAgICAgICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRvKHRoaXMucmFkaXVzKjAuNSwgLXRoaXMucmFkaXVzKjAuNyk7IGN0eC5saW5lVG8odGhpcy5yYWRpdXMqMC45LCAtdGhpcy5yYWRpdXMqMS4zKTsgY3R4LmxpbmVUbyh0aGlzLnJhZGl1cyowLjIsIC10aGlzLnJhZGl1cyowLjgpOyBjdHguZmlsbCgpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAodGhpcy50eXBlID09PSAnUkFOR0VEJykge1xyXG4gICAgICAgICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmMoMCwgMCwgdGhpcy5yYWRpdXMsIDAsIE1hdGguUEkqMik7IGN0eC5maWxsKCk7IGN0eC5zdHJva2UoKTtcclxuICAgICAgICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRvKC0xMCwgLXRoaXMucmFkaXVzKTsgY3R4LmxpbmVUbygtMjAsIC10aGlzLnJhZGl1cyAtIDE1KTsgY3R4LnN0cm9rZSgpO1xyXG4gICAgICAgICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8oMTAsIC10aGlzLnJhZGl1cyk7IGN0eC5saW5lVG8oMjAsIC10aGlzLnJhZGl1cyAtIDE1KTsgY3R4LnN0cm9rZSgpO1xyXG4gICAgICAgICAgICBjdHguZmlsbFN0eWxlID0gJyNmMWM0MGYnOyBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmMoLTIwLCAtdGhpcy5yYWRpdXMgLSAxNSwgNCwgMCwgTWF0aC5QSSoyKTsgY3R4LmZpbGwoKTsgY3R4LmFyYygyMCwgLXRoaXMucmFkaXVzIC0gMTUsIDQsIDAsIE1hdGguUEkqMik7IGN0eC5maWxsKCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKDAsIDAsIHRoaXMucmFkaXVzICogKHRoaXMudHlwZSA9PT0gJ0tBTUlLQVpFJyA/IHRoaXMuZXhwbG9kZVNjYWxlIDogMSksIDAsIE1hdGguUEkqMik7IGN0eC5maWxsKCk7IGN0eC5zdHJva2UoKTtcclxuICAgICAgICAgICAgaWYgKHRoaXMudHlwZSA9PT0gJ0dIT1NUJyAmJiB0aGlzLmdob3N0U3RhdGUgPT09ICdHSE9TVCcpIHtcclxuICAgICAgICAgICAgICAgIGN0eC5nbG9iYWxBbHBoYSA9IDAuNztcclxuICAgICAgICAgICAgICAgIGN0eC5zdHJva2VTdHlsZSA9ICcjZWNmMGYxJzsgY3R4LmxpbmVXaWR0aCA9IDM7XHJcbiAgICAgICAgICAgICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmMoMCwgMCwgdGhpcy5yYWRpdXMgKyAzLCAwLCBNYXRoLlBJKjIpOyBjdHguc3Ryb2tlKCk7XHJcbiAgICAgICAgICAgICAgICBjdHguZ2xvYmFsQWxwaGEgPSB0eXBlQWxwaGE7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgXHJcbiAgICAgICAgaWYgKHRoaXMudHlwZSA9PT0gJ1JBTkdFRCcpIHtcclxuICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjZmZmJzsgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKDAsIC01LCAxMCwgMCwgTWF0aC5QSSoyKTsgY3R4LmZpbGwoKTtcclxuICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjMDAwJzsgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKDAsIC01LCA0LCAwLCBNYXRoLlBJKjIpOyBjdHguZmlsbCgpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSB0aGlzLmZsYXNoID4gMCA/ICcjZTc0YzNjJyA6ICh0aGlzLnR5cGUgPT09ICdCT1NTJyA/ICcjZjFjNDBmJyA6ICcjZmZmJyk7XHJcbiAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTtcclxuICAgICAgICAgICAgaWYgKHRoaXMudHlwZSA9PT0gJ0ZBU1QnKSB7XHJcbiAgICAgICAgICAgICAgICBjdHgubW92ZVRvKC10aGlzLnJhZGl1cyowLjUsIC04KTsgY3R4LmxpbmVUbygtdGhpcy5yYWRpdXMqMC4xLCAtMik7IGN0eC5saW5lVG8oLXRoaXMucmFkaXVzKjAuNSwgMik7IFxyXG4gICAgICAgICAgICAgICAgY3R4Lm1vdmVUbyh0aGlzLnJhZGl1cyowLjUsIC04KTsgY3R4LmxpbmVUbyh0aGlzLnJhZGl1cyowLjEsIC0yKTsgY3R4LmxpbmVUbyh0aGlzLnJhZGl1cyowLjUsIDIpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgY3R4Lm1vdmVUbygtdGhpcy5yYWRpdXMqMC40LCAtNSk7IGN0eC5saW5lVG8oLXRoaXMucmFkaXVzKjAuMSwgMCk7IGN0eC5saW5lVG8oLXRoaXMucmFkaXVzKjAuNCwgNSk7IFxyXG4gICAgICAgICAgICAgICAgY3R4Lm1vdmVUbyh0aGlzLnJhZGl1cyowLjQsIC01KTsgY3R4LmxpbmVUbyh0aGlzLnJhZGl1cyowLjEsIDApOyBjdHgubGluZVRvKHRoaXMucmFkaXVzKjAuNCwgNSk7IFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGN0eC5maWxsKCk7XHJcbiAgICAgICAgICAgIGlmICh0aGlzLnR5cGUgPT09ICdCT1NTJykge1xyXG4gICAgICAgICAgICAgICAgY3R4LnN0cm9rZVN0eWxlID0gJyMwMDAnOyBjdHgubGluZVdpZHRoID0gNDtcclxuICAgICAgICAgICAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbygtMjAsIDIwKTsgY3R4LnF1YWRyYXRpY0N1cnZlVG8oMCwgNDAsIDIwLCAyMCk7IGN0eC5zdHJva2UoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICAvLyBBbmlsbG8gZGUgYnJpbGxvIGRlbCBldmVudG8gTVVUQUNJXHUwMEQzTjogcHVyYW1lbnRlIGRlY29yYXRpdm8gKGVsIGVmZWN0byByZWFsIGVuXHJcbiAgICAgICAgLy8gZWwganVlZ28geWEgbG8gYXBsaWNhbiBsb3MgbXVsdGlwbGljYWRvcmVzIGRlIHRhbWFcdTAwRjFvL3ZpZGEvZGFcdTAwRjFvIGRlbCBldmVudG8sIG5vXHJcbiAgICAgICAgLy8gZXN0ZSBhbmlsbG8pLCBzZSBhcGFnYSBlbiBVTFRSQS5cclxuICAgICAgICBpZiAoZ2FtZS5meEVuYWJsZWQgJiYgZ2FtZS5hY3RpdmVFdmVudCA9PT0gJ01VVEFUSU9OJykge1xyXG4gICAgICAgICAgICBjdHguZ2xvYmFsQWxwaGEgPSAwLjM1O1xyXG4gICAgICAgICAgICBjdHguc3Ryb2tlU3R5bGUgPSAnIzM5ZmYxNCc7IGN0eC5saW5lV2lkdGggPSA0O1xyXG4gICAgICAgICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmMoMCwgMCwgdGhpcy5yYWRpdXMgKiAxLjE1LCAwLCBNYXRoLlBJKjIpOyBjdHguc3Ryb2tlKCk7XHJcbiAgICAgICAgICAgIGN0eC5nbG9iYWxBbHBoYSA9IHR5cGVBbHBoYTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY3R4LnJlc3RvcmUoKTtcclxuXHJcbiAgICAgICAgaWYodGhpcy5ocCA8IHRoaXMubWF4SHApIHtcclxuICAgICAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICdyZ2JhKDAsMCwwLDAuOCknOyBjdHguZmlsbFJlY3QodGhpcy54IC0gY2FtLnggLSAxNSwgdGhpcy55IC0gY2FtLnkgLSB0aGlzLnJhZGl1cyAtIDE1LCAzMCwgNSk7XHJcbiAgICAgICAgICAgIGN0eC5maWxsU3R5bGUgPSAnI2U3NGMzYyc7IGN0eC5maWxsUmVjdCh0aGlzLnggLSBjYW0ueCAtIDE1LCB0aGlzLnkgLSBjYW0ueSAtIHRoaXMucmFkaXVzIC0gMTUsIDMwICogKHRoaXMuaHAvdGhpcy5tYXhIcCksIDUpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZ2FtZS5zcGF3blByb2plY3RpbGUgPSBmdW5jdGlvbih4LCB5LCBhbmdsZSwgd2VhcG9uLCBpc0VuZW15ID0gZmFsc2UpIHtcclxuICAgIGxldCBwID0gdGhpcy5wcm9qZWN0aWxlcy5maW5kKHAgPT4gIXAuYWN0aXZlKTtcclxuICAgIGlmKHApIHAuaW5pdCh4LCB5LCBhbmdsZSwgd2VhcG9uLCBpc0VuZW15KTtcclxufTtcclxuXG4vLyMgc291cmNlVVJMPWVuZW1pZXMuanNcblxuLyogPT09PT09PT09PT09PT09PT0gbGV2ZWwuanMgPT09PT09PT09PT09PT09PT0gKi9cbi8qKlxuICogU0lTVEVNQSBERSBOSVZFTCAvIFhQICsgUEVSRklMIERFTCBKVUdBRE9SXG4gKi9cbmNvbnN0IFhQX0NPTkZJRyA9IHtcbiAgICBjdXJ2ZUJhc2U6IDE1MCxcbiAgICBjdXJ2ZUdyb3d0aDogMS4yMixcbiAgICBwZXJLaWxsOiB7IEJPU1M6IDQwLCBUQU5LOiAzLCBSQU5HRUQ6IDIsIEZBU1Q6IDEsIEJBU0lDOiAxLCBJTlZJU0lCTEU6IDIsIEtBTUlLQVpFOiAxLCBHSE9TVDogMiB9LFxuICAgIHBlcktpbGxEZWZhdWx0OiAxLFxuICAgIHdhdmVDbGVhckJhc2U6IDgsXG4gICAgd2F2ZUNsZWFyUGVyV2F2ZTogMlxufTtcblxuZnVuY3Rpb24geHBUb05leHRMZXZlbChsZXZlbCkge1xuICAgIHJldHVybiBNYXRoLmZsb29yKFhQX0NPTkZJRy5jdXJ2ZUJhc2UgKiBNYXRoLnBvdyhYUF9DT05GSUcuY3VydmVHcm93dGgsIGxldmVsIC0gMSkpO1xufVxuXG5jb25zdCBYUF9QRVJfS0lMTCA9IFhQX0NPTkZJRy5wZXJLaWxsO1xuY29uc3QgWFBfUEVSX0tJTExfREVGQVVMVCA9IFhQX0NPTkZJRy5wZXJLaWxsRGVmYXVsdDtcbmZ1bmN0aW9uIHhwRm9yV2F2ZUNsZWFyKHdhdmUpIHsgcmV0dXJuIFhQX0NPTkZJRy53YXZlQ2xlYXJCYXNlICsgd2F2ZSAqIFhQX0NPTkZJRy53YXZlQ2xlYXJQZXJXYXZlOyB9XG5cbmNvbnN0IExFVkVMX1JFV0FSRFMgPSB7XG4gICAgNTogIHsgdHlwZTogJ21vbmV5JywgYW1vdW50OiAzMDAsIGxhYmVsOiAnKyQzMDAnIH0sXG4gICAgMTA6IHsgdHlwZTogJ2RpYW1vbmRzJywgYW1vdW50OiAyMCwgbGFiZWw6ICcrMjAgXHVEODNEXHVEQzhFJyB9LFxuICAgIDE1OiB7IHR5cGU6ICdib3gnLCBsYWJlbDogJ0NhamEnIH0sXG4gICAgMjA6IHsgdHlwZTogJ21vbmV5JywgYW1vdW50OiA4MDAsIGxhYmVsOiAnKyQ4MDAnIH0sXG4gICAgMjU6IHsgdHlwZTogJ2RpYW1vbmRzJywgYW1vdW50OiA1MCwgbGFiZWw6ICcrNTAgXHVEODNEXHVEQzhFJyB9LFxuICAgIDMwOiB7IHR5cGU6ICdza2luJywgbGFiZWw6ICdTa2luJyB9LFxuICAgIDQwOiB7IHR5cGU6ICd0aXRsZScsIGxhYmVsOiAnVFx1MDBFRHR1bG8nIH0sXG4gICAgNTA6IHsgdHlwZTogJ2RpYW1vbmRzJywgYW1vdW50OiAxMDAsIGxhYmVsOiAnKzEwMCBcdUQ4M0RcdURDOEUnIH1cbn07XG5cbmNvbnN0IFBMQVlFUl9QUk9GSUxFX0RFRkFVTFRTID0ge1xuICAgIGxldmVsOiAxLCB4cDogMCxcbiAgICBwbGF5VGltZVNlYzogMCwga2lsbHM6IDAsIGRlYXRoczogMCxcbiAgICBzaG90c0ZpcmVkOiAwLCBzaG90c0hpdDogMCxcbiAgICB3ZWFwb25Vc2FnZToge30sIGRpc3RhbmNlOiAwLCBiZXN0V2F2ZTogMCxcbiAgICB1bmxvY2tzOiBbXSwgZGlhbW9uZHM6IDBcbn07XG5jb25zdCBQbGF5ZXJQcm9maWxlID0gT2JqZWN0LmFzc2lnbih7fSwgUExBWUVSX1BST0ZJTEVfREVGQVVMVFMsIFNhdmVTeXN0ZW0uZ2V0KCdwcm9maWxlJywge30pKTtcblxuUGxheWVyUHJvZmlsZS5zYXZlID0gZnVuY3Rpb24oKSB7IFNhdmVTeXN0ZW0uc2V0KCdwcm9maWxlJywgdGhpcyk7IH07XG5cblBsYXllclByb2ZpbGUucmVzZXQgPSBmdW5jdGlvbigpIHtcbiAgICBPYmplY3Qua2V5cyhQTEFZRVJfUFJPRklMRV9ERUZBVUxUUykuZm9yRWFjaChrID0+IHtcbiAgICAgICAgY29uc3QgZCA9IFBMQVlFUl9QUk9GSUxFX0RFRkFVTFRTW2tdO1xuICAgICAgICB0aGlzW2tdID0gQXJyYXkuaXNBcnJheShkKSA/IFtdIDogKGQgJiYgdHlwZW9mIGQgPT09ICdvYmplY3QnID8ge30gOiBkKTtcbiAgICB9KTtcbiAgICB0aGlzLnNhdmUoKTtcbiAgICBpZiAodHlwZW9mIGdhbWUgIT09ICd1bmRlZmluZWQnICYmIGdhbWUudXBkYXRlTGV2ZWxIVUQpIGdhbWUudXBkYXRlTGV2ZWxIVUQoKTtcbn07XG5cbmdhbWUuZ3JhbnRYUCA9IGZ1bmN0aW9uKGFtb3VudCkge1xuICAgIGFtb3VudCA9IE1hdGguZmxvb3IoYW1vdW50KTtcbiAgICBpZiAoYW1vdW50IDw9IDApIHJldHVybjtcbiAgICBQbGF5ZXJQcm9maWxlLnhwICs9IGFtb3VudDtcbiAgICBsZXQgbGV2ZWxlZFVwID0gZmFsc2U7XG4gICAgd2hpbGUgKFBsYXllclByb2ZpbGUueHAgPj0geHBUb05leHRMZXZlbChQbGF5ZXJQcm9maWxlLmxldmVsKSkge1xuICAgICAgICBQbGF5ZXJQcm9maWxlLnhwIC09IHhwVG9OZXh0TGV2ZWwoUGxheWVyUHJvZmlsZS5sZXZlbCk7XG4gICAgICAgIFBsYXllclByb2ZpbGUubGV2ZWwrKztcbiAgICAgICAgbGV2ZWxlZFVwID0gdHJ1ZTtcbiAgICAgICAgZ2FtZS5hcHBseUxldmVsUmV3YXJkKFBsYXllclByb2ZpbGUubGV2ZWwpO1xuICAgIH1cbiAgICBpZiAobGV2ZWxlZFVwKSBnYW1lLnNob3dMZXZlbFVwKFBsYXllclByb2ZpbGUubGV2ZWwpO1xuICAgIFBsYXllclByb2ZpbGUuc2F2ZSgpO1xufTtcblxuZ2FtZS5ncmFudERpYW1vbmRzID0gZnVuY3Rpb24oYW1vdW50KSB7XG4gICAgYW1vdW50ID0gTWF0aC5mbG9vcihhbW91bnQpO1xuICAgIGlmIChhbW91bnQgPD0gMCkgcmV0dXJuO1xuICAgIFBsYXllclByb2ZpbGUuZGlhbW9uZHMgKz0gYW1vdW50O1xuICAgIFBsYXllclByb2ZpbGUuc2F2ZSgpO1xufTtcblxuZ2FtZS5hcHBseUxldmVsUmV3YXJkID0gZnVuY3Rpb24obGV2ZWwpIHtcbiAgICBjb25zdCByZXdhcmQgPSBMRVZFTF9SRVdBUkRTW2xldmVsXTtcbiAgICBpZiAoIXJld2FyZCkgcmV0dXJuO1xuICAgIGlmIChyZXdhcmQudHlwZSA9PT0gJ21vbmV5JyAmJiBnYW1lLnBsYXllcikgZ2FtZS5wbGF5ZXIubW9uZXkgKz0gcmV3YXJkLmFtb3VudDtcbiAgICBpZiAocmV3YXJkLnR5cGUgPT09ICdkaWFtb25kcycpIGdhbWUuZ3JhbnREaWFtb25kcyhyZXdhcmQuYW1vdW50KTtcbiAgICBQbGF5ZXJQcm9maWxlLnVubG9ja3MucHVzaCh7IGxldmVsLCB0eXBlOiByZXdhcmQudHlwZSwgbGFiZWw6IHJld2FyZC5sYWJlbCB9KTtcbn07XG5cbmdhbWUuc2hvd0xldmVsVXAgPSBmdW5jdGlvbihsZXZlbCkge1xuICAgIHBsYXlTRlgoJ2xldmVsdXAnLCAwLjcsIDAuMDUpO1xuICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xldmVsdXAtdG9hc3QnKTtcbiAgICBpZiAoIWVsKSByZXR1cm47XG4gICAgY29uc3QgcmV3YXJkID0gTEVWRUxfUkVXQVJEU1tsZXZlbF07XG4gICAgZWwuaW5uZXJIVE1MID0gYFx1MDBBMU5JVkVMICR7bGV2ZWx9IWAgKyAocmV3YXJkID8gYDxzcGFuPiR7cmV3YXJkLmxhYmVsfTwvc3Bhbj5gIDogJycpO1xuICAgIGVsLmNsYXNzTGlzdC5yZW1vdmUoJ3Nob3cnKTtcbiAgICB2b2lkIGVsLm9mZnNldFdpZHRoO1xuICAgIGVsLmNsYXNzTGlzdC5hZGQoJ3Nob3cnKTtcbiAgICBjbGVhclRpbWVvdXQoZ2FtZS5fbGV2ZWx1cFRvYXN0VGltZXIpO1xuICAgIGdhbWUuX2xldmVsdXBUb2FzdFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBlbC5jbGFzc0xpc3QucmVtb3ZlKCdzaG93JyksIDI0MDApO1xufTtcblxuZ2FtZS51cGRhdGVMZXZlbEhVRCA9IGZ1bmN0aW9uKCkge1xuICAgIGNvbnN0IGx2bEVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xldmVsLWRpc3BsYXknKTtcbiAgICBjb25zdCB4cEVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3hwLWlubmVyJyk7XG4gICAgaWYgKCFsdmxFbCB8fCAheHBFbCkgcmV0dXJuO1xuICAgIGx2bEVsLmlubmVyVGV4dCA9IFwiTklWRUwgXCIgKyBQbGF5ZXJQcm9maWxlLmxldmVsO1xuICAgIHhwRWwuc3R5bGUud2lkdGggPSBNYXRoLm1pbigxMDAsIChQbGF5ZXJQcm9maWxlLnhwIC8geHBUb05leHRMZXZlbChQbGF5ZXJQcm9maWxlLmxldmVsKSkgKiAxMDApICsgXCIlXCI7XG59O1xuXG5nYW1lLm9wZW5Qcm9maWxlID0gZnVuY3Rpb24oKSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvYmJ5LXNjcmVlbicpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgY29uc3QgcCA9IFBsYXllclByb2ZpbGU7XG4gICAgY29uc3QgYWNjID0gcC5zaG90c0ZpcmVkID4gMCA/IE1hdGgubWluKDEwMCwgTWF0aC5yb3VuZChwLnNob3RzSGl0IC8gcC5zaG90c0ZpcmVkICogMTAwKSkgOiAwO1xuICAgIGNvbnN0IGZhdkVudHJ5ID0gT2JqZWN0LmVudHJpZXMocC53ZWFwb25Vc2FnZSkuc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0pWzBdO1xuICAgIGNvbnN0IGZhdldlYXBvbiA9IGZhdkVudHJ5ID8gZmF2RW50cnlbMF0gOiAnLS0nO1xuICAgIGNvbnN0IGxpdmVTZWMgPSB0aGlzLnN0YXJ0ZWQgPyBNYXRoLmZsb29yKChEYXRlLm5vdygpIC0gdGhpcy5zdGFydFRpbWUpIC8gMTAwMCkgOiAwO1xuICAgIGNvbnN0IHRvdGFsU2VjID0gcC5wbGF5VGltZVNlYyArIGxpdmVTZWM7XG4gICAgY29uc3QgbW0gPSBTdHJpbmcoTWF0aC5mbG9vcih0b3RhbFNlYyAvIDYwKSkucGFkU3RhcnQoMiwgJzAnKSwgc3MgPSBTdHJpbmcodG90YWxTZWMgJSA2MCkucGFkU3RhcnQoMiwgJzAnKTtcbiAgICBjb25zdCByb3dzID0gW1xuICAgICAgICBbJ0N1ZW50YScsIHR5cGVvZiBBdXRoVUkgIT09ICd1bmRlZmluZWQnID8gQXV0aFVJLmN1cnJlbnRMYWJlbCgpIDogJ0ludml0YWRvIChsb2NhbCknXSxcbiAgICAgICAgWydOaXZlbCcsIHAubGV2ZWxdLFxuICAgICAgICBbJ1hQJywgYCR7cC54cH0gLyAke3hwVG9OZXh0TGV2ZWwocC5sZXZlbCl9YF0sXG4gICAgICAgIFsnRGlhbWFudGVzJywgJ1x1RDgzRFx1REM4RSAnICsgcC5kaWFtb25kc10sXG4gICAgICAgIFsnVGllbXBvIGp1Z2FkbycsIGAke21tfToke3NzfWBdLFxuICAgICAgICBbJ1pvbWJpZXMgZWxpbWluYWRvcycsIHAua2lsbHNdLFxuICAgICAgICBbJ1ByZWNpc2lcdTAwRjNuJywgYWNjICsgJyUnXSxcbiAgICAgICAgWydBcm1hIGZhdm9yaXRhJywgZmF2V2VhcG9uXSxcbiAgICAgICAgWydEaXN0YW5jaWEgcmVjb3JyaWRhJywgTWF0aC5mbG9vcihwLmRpc3RhbmNlKSArICcgbSddLFxuICAgICAgICBbJ01heW9yIG9sZWFkYScsIHAuYmVzdFdhdmVdLFxuICAgICAgICBbJ011ZXJ0ZXMnLCBwLmRlYXRoc11cbiAgICBdO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlLXN0YXRzJykuaW5uZXJIVE1MID0gcm93cy5tYXAoKFtsYWJlbCwgdmFsXSkgPT5cbiAgICAgICAgYDxkaXYgY2xhc3M9XCJ1cGdyYWRlLXJvd1wiPjxzcGFuIGNsYXNzPVwidXBncmFkZS1uYW1lXCI+JHtsYWJlbH08L3NwYW4+PHNwYW4gY2xhc3M9XCJodWQtdGV4dFwiPiR7dmFsfTwvc3Bhbj48L2Rpdj5gXG4gICAgKS5qb2luKCcnKTtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZmlsZS1zY3JlZW4nKS5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnO1xufTtcbmdhbWUuY2xvc2VQcm9maWxlID0gZnVuY3Rpb24oKSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGUtc2NyZWVuJykuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9iYnktc2NyZWVuJykuc3R5bGUuZGlzcGxheSA9ICdmbGV4Jztcbn07XG5cbmNvbnN0IF9sZXZlbE9yaWdIaXRFbmVteSA9IGdhbWUuaGl0RW5lbXk7XG5nYW1lLmhpdEVuZW15ID0gZnVuY3Rpb24oZSwgZG1nLCBtZXRhKSB7XG4gICAgY29uc3Qgd2FzQWxpdmUgPSAhZS5pc0R5aW5nO1xuICAgIF9sZXZlbE9yaWdIaXRFbmVteS5jYWxsKHRoaXMsIGUsIGRtZyk7XG4gICAgaWYgKG1ldGEgJiYgbWV0YS5wbGF5ZXJTaG90ICYmICF0aGlzLl9zaG90SGl0UmVnaXN0ZXJlZCkge1xuICAgICAgICBQbGF5ZXJQcm9maWxlLnNob3RzSGl0Kys7XG4gICAgICAgIHRoaXMuX3Nob3RIaXRSZWdpc3RlcmVkID0gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKHdhc0FsaXZlICYmIGUuaXNEeWluZykge1xuICAgICAgICBQbGF5ZXJQcm9maWxlLmtpbGxzKys7XG4gICAgICAgIGNvbnN0IHcgPSB0aGlzLnBsYXllciAmJiB0aGlzLnBsYXllci53ZWFwb247XG4gICAgICAgIGlmICh3KSBQbGF5ZXJQcm9maWxlLndlYXBvblVzYWdlW3cubmFtZV0gPSAoUGxheWVyUHJvZmlsZS53ZWFwb25Vc2FnZVt3Lm5hbWVdIHx8IDApICsgMTtcbiAgICAgICAgZ2FtZS5ncmFudFhQKFhQX1BFUl9LSUxMW2UudHlwZV0gPz8gWFBfUEVSX0tJTExfREVGQVVMVCk7XG4gICAgfVxufTtcblxuY29uc3QgX2xldmVsT3JpZ1Nob290ID0gZ2FtZS5zaG9vdDtcbmdhbWUuc2hvb3QgPSBmdW5jdGlvbigpIHtcbiAgICBjb25zdCB3ID0gdGhpcy5wbGF5ZXIgJiYgdGhpcy5wbGF5ZXIud2VhcG9uO1xuICAgIGNvbnN0IHByZXZMYXN0U2hvdCA9IHRoaXMubGFzdFNob3Q7XG4gICAgX2xldmVsT3JpZ1Nob290LmNhbGwodGhpcyk7XG4gICAgaWYgKHcgJiYgdGhpcy5sYXN0U2hvdCAhPT0gcHJldkxhc3RTaG90ICYmIHcudHlwZSAhPT0gJ21lbGVlJykge1xuICAgICAgICBQbGF5ZXJQcm9maWxlLnNob3RzRmlyZWQrKztcbiAgICAgICAgdGhpcy5fc2hvdEhpdFJlZ2lzdGVyZWQgPSBmYWxzZTtcbiAgICB9XG59O1xuXG5jb25zdCBfbGV2ZWxPcmlnUGxheWVyVXBkYXRlID0gUGxheWVyLnByb3RvdHlwZS51cGRhdGU7XG5QbGF5ZXIucHJvdG90eXBlLnVwZGF0ZSA9IGZ1bmN0aW9uKGtleXMpIHtcbiAgICBjb25zdCBweCA9IHRoaXMueCwgcHkgPSB0aGlzLnk7XG4gICAgX2xldmVsT3JpZ1BsYXllclVwZGF0ZS5jYWxsKHRoaXMsIGtleXMpO1xuICAgIGNvbnN0IGQgPSBNYXRoLmh5cG90KHRoaXMueCAtIHB4LCB0aGlzLnkgLSBweSk7XG4gICAgaWYgKGQgPiAwKSBQbGF5ZXJQcm9maWxlLmRpc3RhbmNlICs9IGQ7XG59O1xuXG5jb25zdCBfbGV2ZWxPcmlnTG9vcCA9IGdhbWUubG9vcDtcbmdhbWUubG9vcCA9IGZ1bmN0aW9uKCkge1xuICAgIGNvbnN0IHdhdmVCZWZvcmUgPSB0aGlzLndhdmU7XG4gICAgX2xldmVsT3JpZ0xvb3AuY2FsbCh0aGlzKTtcbiAgICBpZiAodGhpcy53YXZlICE9PSB3YXZlQmVmb3JlKSB7XG4gICAgICAgIGdhbWUuZ3JhbnRYUCh4cEZvcldhdmVDbGVhcih3YXZlQmVmb3JlKSk7XG4gICAgICAgIFBsYXllclByb2ZpbGUuYmVzdFdhdmUgPSBNYXRoLm1heChQbGF5ZXJQcm9maWxlLmJlc3RXYXZlLCB3YXZlQmVmb3JlKTtcbiAgICAgICAgUGxheWVyUHJvZmlsZS5zYXZlKCk7XG4gICAgfVxuICAgIGdhbWUudXBkYXRlTGV2ZWxIVUQoKTtcbn07XG5cbmNvbnN0IF9sZXZlbE9yaWdHYW1lT3ZlciA9IGdhbWUuZ2FtZU92ZXI7XG5nYW1lLmdhbWVPdmVyID0gZnVuY3Rpb24oKSB7XG4gICAgUGxheWVyUHJvZmlsZS5kZWF0aHMrKztcbiAgICBQbGF5ZXJQcm9maWxlLnBsYXlUaW1lU2VjICs9IE1hdGguZmxvb3IoKERhdGUubm93KCkgLSB0aGlzLnN0YXJ0VGltZSkgLyAxMDAwKTtcbiAgICBQbGF5ZXJQcm9maWxlLmJlc3RXYXZlID0gTWF0aC5tYXgoUGxheWVyUHJvZmlsZS5iZXN0V2F2ZSwgdGhpcy53YXZlIC0gMSk7XG4gICAgUGxheWVyUHJvZmlsZS5zYXZlKCk7XG4gICAgX2xldmVsT3JpZ0dhbWVPdmVyLmNhbGwodGhpcyk7XG59O1xuXG53aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignYmVmb3JldW5sb2FkJywgKCkgPT4gUGxheWVyUHJvZmlsZS5zYXZlKCkpO1xuXG5TYXZlU3lzdGVtLm9uUmVtb3RlRGF0YShmdW5jdGlvbihrZXlzKSB7XG4gICAgaWYgKCFrZXlzLmluY2x1ZGVzKCdwcm9maWxlJykpIHJldHVybjtcbiAgICBPYmplY3QuYXNzaWduKFBsYXllclByb2ZpbGUsIFNhdmVTeXN0ZW0uZ2V0KCdwcm9maWxlJywge30pKTtcbiAgICBnYW1lLnVwZGF0ZUxldmVsSFVEKCk7XG59KTtcblxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ0RPTUNvbnRlbnRMb2FkZWQnLCAoKSA9PiB7XG4gICAgY29uc3QgcGFuZWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcjbG9iYnktc2NyZWVuIC5tZW51LXBhbmVsJyk7XG4gICAgaWYgKHBhbmVsKSB7XG4gICAgICAgIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICBidG4uY2xhc3NOYW1lID0gJ21lbnUtYnRuJztcbiAgICAgICAgYnRuLnRleHRDb250ZW50ID0gJ1x1RDgzRVx1REVBQSBQRVJGSUwnO1xuICAgICAgICBidG4ub25jbGljayA9ICgpID0+IGdhbWUub3BlblByb2ZpbGUoKTtcbiAgICAgICAgcGFuZWwuYXBwZW5kQ2hpbGQoYnRuKTtcbiAgICB9XG4gICAgZ2FtZS51cGRhdGVMZXZlbEhVRCgpO1xufSk7XG5cbi8vIyBzb3VyY2VVUkw9bGV2ZWwuanNcblxuLyogPT09PT09PT09PT09PT09PT0gcHJvZ3Jlc3Npb24uanMgPT09PT09PT09PT09PT09PT0gKi9cbi8qKlxuICogU0lTVEVNQSBERSBQUk9HUkVTSVx1MDBEM04gUEVSTUFORU5URSAoTUVKT1JBUyBFTlRSRSBQQVJUSURBUylcbiAqL1xuY29uc3QgVVBHUkFERVNfREIgPSB7XG4gICAgVklUQUxJVFk6ICB7IG5hbWU6ICdWaXRhbGlkYWQnLCAgICBkZXNjOiAnKzEwIEhQIG1cdTAwRTF4aW1hIHBvciBuaXZlbCcsICAgICAgICBpY29uOiAnXHUyNzY0XHVGRTBGJywgbWF4TGV2ZWw6IDUsIGJhc2VDb3N0OiAyNTAsIGNvc3RHcm93dGg6IDEuNiB9LFxuICAgIEVORFVSQU5DRTogeyBuYW1lOiAnUmVzaXN0ZW5jaWEnLCAgZGVzYzogJysxMCBzdGFtaW5hIG1cdTAwRTF4aW1hIHBvciBuaXZlbCcsICAgaWNvbjogJ1x1RDgzQ1x1REZDMycsIG1heExldmVsOiA1LCBiYXNlQ29zdDogMjUwLCBjb3N0R3Jvd3RoOiAxLjYgfSxcbiAgICBTV0lGVE5FU1M6IHsgbmFtZTogJ1ZlbG9jaWRhZCcsICAgIGRlc2M6ICcrMiUgdmVsb2NpZGFkIGRlIG1vdmltaWVudG8gcG9yIG5pdmVsJywgaWNvbjogJ1x1RDgzRFx1RENBOCcsIG1heExldmVsOiA1LCBiYXNlQ29zdDogMzAwLCBjb3N0R3Jvd3RoOiAxLjYgfSxcbiAgICBQT1dFUjogICAgIHsgbmFtZTogJ1BvZGVyJywgICAgICAgZGVzYzogJyszJSBkYVx1MDBGMW8gZGUgYXJtYXMgcG9yIG5pdmVsJywgICAgaWNvbjogJ1x1MjY5NFx1RkUwRicsIG1heExldmVsOiA1LCBiYXNlQ29zdDogMzUwLCBjb3N0R3Jvd3RoOiAxLjY1IH0sXG4gICAgRk9SVFVORTogICB7IG5hbWU6ICdGb3J0dW5hJywgICAgIGRlc2M6ICcrNCUgZGluZXJvIGdhbmFkbyBwb3Igbml2ZWwnLCAgICAgaWNvbjogJ1x1RDgzRFx1RENCMCcsIG1heExldmVsOiA1LCBiYXNlQ29zdDogMzIwLCBjb3N0R3Jvd3RoOiAxLjY1IH1cbn07XG5cbmNvbnN0IFByb2dyZXNzaW9uID0gT2JqZWN0LmFzc2lnbih7IGxldmVsczoge30gfSwgU2F2ZVN5c3RlbS5nZXQoJ3Byb2dyZXNzaW9uJywge30pKTtcblxuUHJvZ3Jlc3Npb24uZ2V0TGV2ZWwgPSBmdW5jdGlvbihrKSB7IHJldHVybiB0aGlzLmxldmVsc1trXSB8fCAwOyB9O1xuXG5Qcm9ncmVzc2lvbi5nZXRDb3N0ID0gZnVuY3Rpb24oaykge1xuICAgIGNvbnN0IGRlZiA9IFVQR1JBREVTX0RCW2tdO1xuICAgIGlmICghZGVmKSByZXR1cm4gSW5maW5pdHk7XG4gICAgcmV0dXJuIE1hdGguZmxvb3IoZGVmLmJhc2VDb3N0ICogTWF0aC5wb3coZGVmLmNvc3RHcm93dGgsIHRoaXMuZ2V0TGV2ZWwoaykpKTtcbn07XG5cblByb2dyZXNzaW9uLmJ1eSA9IGZ1bmN0aW9uKGspIHtcbiAgICBjb25zdCBkZWYgPSBVUEdSQURFU19EQltrXTtcbiAgICBpZiAoIWRlZikgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IGx2bCA9IHRoaXMuZ2V0TGV2ZWwoayk7XG4gICAgaWYgKGx2bCA+PSBkZWYubWF4TGV2ZWwpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBjb3N0ID0gdGhpcy5nZXRDb3N0KGspO1xuICAgIGlmICghZ2FtZS5wbGF5ZXIgfHwgZ2FtZS5wbGF5ZXIubW9uZXkgPCBjb3N0KSByZXR1cm4gZmFsc2U7XG5cbiAgICBnYW1lLnBsYXllci5tb25leSAtPSBjb3N0O1xuICAgIHRoaXMubGV2ZWxzW2tdID0gbHZsICsgMTtcbiAgICB0aGlzLnNhdmUoKTtcbiAgICB0aGlzLmFwcGx5VG9QbGF5ZXIoZ2FtZS5wbGF5ZXIpO1xuICAgIHBsYXlTRlgoJ2NvaW4nKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn07XG5cblByb2dyZXNzaW9uLnNhdmUgPSBmdW5jdGlvbigpIHsgU2F2ZVN5c3RlbS5zZXQoJ3Byb2dyZXNzaW9uJywgeyBsZXZlbHM6IHRoaXMubGV2ZWxzIH0pOyB9O1xuXG5Qcm9ncmVzc2lvbi5yZXNldCA9IGZ1bmN0aW9uKCkge1xuICAgIHRoaXMubGV2ZWxzID0ge307XG4gICAgdGhpcy5zYXZlKCk7XG4gICAgaWYgKGdhbWUucGxheWVyKSB0aGlzLmFwcGx5VG9QbGF5ZXIoZ2FtZS5wbGF5ZXIpO1xuICAgIGlmICh0eXBlb2YgZ2FtZS5yZW5kZXJVcGdyYWRlcyA9PT0gJ2Z1bmN0aW9uJykgZ2FtZS5yZW5kZXJVcGdyYWRlcygpO1xufTtcblxuUHJvZ3Jlc3Npb24uYXBwbHlUb1BsYXllciA9IGZ1bmN0aW9uKHApIHtcbiAgICBpZiAoIXApIHJldHVybjtcbiAgICBjb25zdCB2aXQgPSB0aGlzLmdldExldmVsKCdWSVRBTElUWScpO1xuICAgIGNvbnN0IGVuZCA9IHRoaXMuZ2V0TGV2ZWwoJ0VORFVSQU5DRScpO1xuICAgIGNvbnN0IG5ld01heEhwID0gMTAwICsgdml0ICogMTA7XG4gICAgY29uc3QgbmV3TWF4U3RhbWluYSA9IDEwMCArIGVuZCAqIDEwO1xuICAgIHAuaHAgPSBNYXRoLm1pbihuZXdNYXhIcCwgcC5ocCArIChuZXdNYXhIcCAtIHAubWF4SHApKTtcbiAgICBwLm1heEhwID0gbmV3TWF4SHA7XG4gICAgcC5zdGFtaW5hID0gTWF0aC5taW4obmV3TWF4U3RhbWluYSwgcC5zdGFtaW5hICsgKG5ld01heFN0YW1pbmEgLSBwLm1heFN0YW1pbmEpKTtcbiAgICBwLm1heFN0YW1pbmEgPSBuZXdNYXhTdGFtaW5hO1xufTtcblxuY29uc3QgX3Byb2dPcmlnSW5pdCA9IGdhbWUuaW5pdDtcbmdhbWUuaW5pdCA9IGZ1bmN0aW9uKCkge1xuICAgIF9wcm9nT3JpZ0luaXQuY2FsbCh0aGlzKTtcbiAgICBQcm9ncmVzc2lvbi5hcHBseVRvUGxheWVyKHRoaXMucGxheWVyKTtcbn07XG5cbmNvbnN0IF9wcm9nT3JpZ1Nob290ID0gZ2FtZS5zaG9vdDtcbmdhbWUuc2hvb3QgPSBmdW5jdGlvbigpIHtcbiAgICBjb25zdCB3ID0gdGhpcy5wbGF5ZXIgJiYgdGhpcy5wbGF5ZXIud2VhcG9uO1xuICAgIGNvbnN0IGx2bCA9IFByb2dyZXNzaW9uLmdldExldmVsKCdQT1dFUicpO1xuICAgIGlmICh3ICYmIGx2bCA+IDAgJiYgdGhpcy5fcG93ZXJPcmlnaW5hbERhbWFnZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRoaXMuX3Bvd2VyT3JpZ2luYWxEYW1hZ2UgPSB3LmRhbWFnZTtcbiAgICAgICAgdy5kYW1hZ2UgPSBNYXRoLnJvdW5kKHRoaXMuX3Bvd2VyT3JpZ2luYWxEYW1hZ2UgKiAoMSArIDAuMDMgKiBsdmwpKTtcbiAgICB9XG4gICAgX3Byb2dPcmlnU2hvb3QuY2FsbCh0aGlzKTtcbiAgICBpZiAodGhpcy5fcG93ZXJPcmlnaW5hbERhbWFnZSAhPT0gdW5kZWZpbmVkICYmICEodGhpcy5wbGF5ZXIgJiYgdGhpcy5wbGF5ZXIuYnVyc3RCdXN5KSkge1xuICAgICAgICB3LmRhbWFnZSA9IHRoaXMuX3Bvd2VyT3JpZ2luYWxEYW1hZ2U7XG4gICAgICAgIHRoaXMuX3Bvd2VyT3JpZ2luYWxEYW1hZ2UgPSB1bmRlZmluZWQ7XG4gICAgfVxufTtcblxuY29uc3QgX3Byb2dPcmlnUGxheWVyVXBkYXRlID0gUGxheWVyLnByb3RvdHlwZS51cGRhdGU7XG5QbGF5ZXIucHJvdG90eXBlLnVwZGF0ZSA9IGZ1bmN0aW9uKGtleXMpIHtcbiAgICBjb25zdCBweCA9IHRoaXMueCwgcHkgPSB0aGlzLnk7XG4gICAgX3Byb2dPcmlnUGxheWVyVXBkYXRlLmNhbGwodGhpcywga2V5cyk7XG4gICAgY29uc3QgbHZsID0gUHJvZ3Jlc3Npb24uZ2V0TGV2ZWwoJ1NXSUZUTkVTUycpO1xuICAgIGlmIChsdmwgPiAwICYmICF0aGlzLmlzRGFzaGluZykge1xuICAgICAgICBjb25zdCBkeCA9IHRoaXMueCAtIHB4LCBkeSA9IHRoaXMueSAtIHB5O1xuICAgICAgICBpZiAoZHggIT09IDAgfHwgZHkgIT09IDApIHtcbiAgICAgICAgICAgIGNvbnN0IGJvbnVzID0gbHZsICogMC4wMjtcbiAgICAgICAgICAgIHRoaXMueCA9IE1hdGgubWF4KHRoaXMucmFkaXVzLCBNYXRoLm1pbihNQVBfU0laRSAtIHRoaXMucmFkaXVzLCB0aGlzLnggKyBkeCAqIGJvbnVzKSk7XG4gICAgICAgICAgICB0aGlzLnkgPSBNYXRoLm1heCh0aGlzLnJhZGl1cywgTWF0aC5taW4oTUFQX1NJWkUgLSB0aGlzLnJhZGl1cywgdGhpcy55ICsgZHkgKiBib251cykpO1xuICAgICAgICB9XG4gICAgfVxufTtcblxuY29uc3QgX3Byb2dPcmlnSGl0RW5lbXkgPSBnYW1lLmhpdEVuZW15O1xuZ2FtZS5oaXRFbmVteSA9IGZ1bmN0aW9uKGUsIGRtZywgLi4ucmVzdCkge1xuICAgIGNvbnN0IG1vbmV5QmVmb3JlID0gdGhpcy5wbGF5ZXIgPyB0aGlzLnBsYXllci5tb25leSA6IDA7XG4gICAgX3Byb2dPcmlnSGl0RW5lbXkuY2FsbCh0aGlzLCBlLCBkbWcsIC4uLnJlc3QpO1xuICAgIGNvbnN0IGx2bCA9IFByb2dyZXNzaW9uLmdldExldmVsKCdGT1JUVU5FJyk7XG4gICAgaWYgKGx2bCA+IDAgJiYgdGhpcy5wbGF5ZXIpIHtcbiAgICAgICAgY29uc3QgZ2FpbmVkID0gdGhpcy5wbGF5ZXIubW9uZXkgLSBtb25leUJlZm9yZTtcbiAgICAgICAgaWYgKGdhaW5lZCA+IDApIHRoaXMucGxheWVyLm1vbmV5ICs9IE1hdGguZmxvb3IoZ2FpbmVkICogKDAuMDQgKiBsdmwpKTtcbiAgICB9XG59O1xuXG5nYW1lLnJlbmRlclVwZ3JhZGVzID0gZnVuY3Rpb24oKSB7XG4gICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndXBncmFkZXMtbGlzdCcpO1xuICAgIGlmICghZWwpIHJldHVybjtcbiAgICBlbC5pbm5lckhUTUwgPSBPYmplY3Qua2V5cyhVUEdSQURFU19EQikubWFwKGsgPT4ge1xuICAgICAgICBjb25zdCBkZWYgPSBVUEdSQURFU19EQltrXTtcbiAgICAgICAgY29uc3QgbHZsID0gUHJvZ3Jlc3Npb24uZ2V0TGV2ZWwoayk7XG4gICAgICAgIGNvbnN0IG1heGVkID0gbHZsID49IGRlZi5tYXhMZXZlbDtcbiAgICAgICAgY29uc3QgY29zdCA9IFByb2dyZXNzaW9uLmdldENvc3Qoayk7XG4gICAgICAgIGNvbnN0IGFjdGlvbiA9IG1heGVkXG4gICAgICAgICAgICA/ICc8c3BhbiBjbGFzcz1cImFjaHYtY2xhaW1lZFwiPk1cdTAwQzFYSU1PPC9zcGFuPidcbiAgICAgICAgICAgIDogYDxidXR0b24gY2xhc3M9XCJidXktYnRuXCIgb25jbGljaz1cImdhbWUuYnV5VXBncmFkZSgnJHtrfScpXCI+JCR7Y29zdH08L2J1dHRvbj5gO1xuICAgICAgICByZXR1cm4gYDxkaXYgY2xhc3M9XCJ3ZWFwb24tcm93XCI+XG4gICAgICAgICAgICA8c3BhbiBjbGFzcz1cIndlYXBvbi1yb3ctbmFtZVwiPiR7ZGVmLmljb259ICR7ZGVmLm5hbWV9ICgke2x2bH0vJHtkZWYubWF4TGV2ZWx9KTwvc3Bhbj5cbiAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwid2VhcG9uLXJvdy1zdGF0dXNcIj4ke2RlZi5kZXNjfTwvc3Bhbj5cbiAgICAgICAgICAgICR7YWN0aW9ufVxuICAgICAgICA8L2Rpdj5gO1xuICAgIH0pLmpvaW4oJycpO1xufTtcblxuZ2FtZS5idXlVcGdyYWRlID0gZnVuY3Rpb24oaykge1xuICAgIGlmIChQcm9ncmVzc2lvbi5idXkoaykpIGdhbWUucmVuZGVyVXBncmFkZXMoKTtcbn07XG5cbmNvbnN0IF9wcm9nT3JpZ09wZW5Qcm9maWxlID0gZ2FtZS5vcGVuUHJvZmlsZTtcbmdhbWUub3BlblByb2ZpbGUgPSBmdW5jdGlvbigpIHtcbiAgICBfcHJvZ09yaWdPcGVuUHJvZmlsZS5jYWxsKHRoaXMpO1xuICAgIGdhbWUucmVuZGVyVXBncmFkZXMoKTtcbn07XG5cblNhdmVTeXN0ZW0ub25SZW1vdGVEYXRhKGZ1bmN0aW9uKGtleXMpIHtcbiAgICBpZiAoIWtleXMuaW5jbHVkZXMoJ3Byb2dyZXNzaW9uJykpIHJldHVybjtcbiAgICBjb25zdCByZW1vdGUgPSBTYXZlU3lzdGVtLmdldCgncHJvZ3Jlc3Npb24nLCB7IGxldmVsczoge30gfSk7XG4gICAgUHJvZ3Jlc3Npb24ubGV2ZWxzID0gcmVtb3RlLmxldmVscyB8fCB7fTtcbiAgICBpZiAoZ2FtZS5wbGF5ZXIpIFByb2dyZXNzaW9uLmFwcGx5VG9QbGF5ZXIoZ2FtZS5wbGF5ZXIpO1xuICAgIGdhbWUucmVuZGVyVXBncmFkZXMoKTtcbn0pO1xuXG4vLyMgc291cmNlVVJMPXByb2dyZXNzaW9uLmpzXG5cbi8qID09PT09PT09PT09PT09PT09IGFjaGlldmVtZW50cy5qcyA9PT09PT09PT09PT09PT09PSAqL1xuLyoqXG4gKiBTSVNURU1BIERFIExPR1JPU1xuICovXG5cbmNvbnN0IFJBUklUWSA9IHtcbiAgICBSQVJPOiAgICAgICB7IGxhYmVsOiAnUkFSTycsICAgICAgICBjb2xvcjogJyMzNDk4ZGInIH0sXG4gICAgU1VQRVJfUkFSTzogeyBsYWJlbDogJ1NcdTAwREFQRVIgUkFSTycsICBjb2xvcjogJyMxYWJjOWMnIH0sXG4gICAgRVBJQ086ICAgICAgeyBsYWJlbDogJ1x1MDBDOVBJQ08nLCAgICAgICBjb2xvcjogJyM5YjU5YjYnIH0sXG4gICAgTUlUSUNPOiAgICAgeyBsYWJlbDogJ01cdTAwQ0RUSUNPJywgICAgICBjb2xvcjogJyNlNzRjM2MnIH0sXG4gICAgTEVHRU5EQVJJTzogeyBsYWJlbDogJ0xFR0VOREFSSU8nLCAgY29sb3I6ICcjZjFjNDBmJyB9XG59O1xuXG5jb25zdCBBQ0hJRVZFTUVOVF9DQVRFR09SSUVTID0ge1xuICAgIENPTUJBVDogICAgICAnXHUyNjk0XHVGRTBGIENvbWJhdGUnLFxuICAgIFNVUlZJVkFMOiAgICAnXHVEODNEXHVERUUxXHVGRTBGIFN1cGVydml2ZW5jaWEnLFxuICAgIFdFQVBPTlM6ICAgICAnXHVEODNEXHVERDJCIEFybWFzJyxcbiAgICBCT1NTRVM6ICAgICAgJ1x1RDgzRFx1REM4MCBCb3NzZXMnLFxuICAgIFBST0dSRVNTSU9OOiAnXHUyQjUwIFByb2dyZXNpXHUwMEYzbicsXG4gICAgRVZFTlRTOiAgICAgICdcdUQ4M0NcdURGMkFcdUZFMEYgRXZlbnRvcycsXG4gICAgRVhQTE9SQVRJT046ICdcdUQ4M0RcdURERkFcdUZFMEYgRXhwbG9yYWNpXHUwMEYzbicsXG4gICAgU1BFQ0lBTDogICAgICdcdUQ4M0NcdURGOTZcdUZFMEYgRXNwZWNpYWxlcydcbn07XG5cbmNvbnN0IFdFQVBPTl9DQVRFR09SWSA9IHtcbiAgICBLTklGRTogJ21lbGVlJywgTUFDSEVURTogJ21lbGVlJywgQ0hBSU5TQVc6ICdtZWxlZScsXG4gICAgRzE4OiAncGlzdG9sJywgUkVWT0xWRVI6ICdwaXN0b2wnLFxuICAgIFVaSTogJ3NtZycsIE1QNTogJ3NtZycsIFA5MDogJ3NtZycsXG4gICAgU0hPVEdVTjogJ3Nob3RndW4nLCBTQVdFRE9GRjogJ3Nob3RndW4nLCBBQTEyOiAnc2hvdGd1bicsXG4gICAgQUs0NzogJ3JpZmxlJywgTTRBMTogJ3JpZmxlJywgRkFNQVM6ICdyaWZsZScsIFNDQVI6ICdyaWZsZScsXG4gICAgV0lOQ0hFU1RFUjogJ3NuaXBlcicsIEFXUDogJ3NuaXBlcicsIFNOSVBFUjogJ3NuaXBlcicsXG4gICAgTTI0OTogJ2hlYXZ5JywgTUlOSUdVTjogJ2hlYXZ5JyxcbiAgICBSUEc6ICdzcGVjaWFsJywgRkxBTUVUSFJPV0VSOiAnc3BlY2lhbCcsIENST1NTQk9XOiAnc3BlY2lhbCdcbn07XG5jb25zdCBUT1RBTF9XRUFQT05fQ09VTlQgPSBPYmplY3Qua2V5cyhXRUFQT05fQ0FURUdPUlkpLmxlbmd0aDtcblxuY29uc3QgQ0FURUdPUllfTUVUQSA9IHtcbiAgICBtZWxlZTogICB7IGljb246ICdcdUQ4M0RcdUREMkEnIH0sXG4gICAgcGlzdG9sOiAgeyBpY29uOiAnXHVEODNEXHVERDJCJyB9LFxuICAgIHNtZzogICAgIHsgaWNvbjogJ1x1RDgzRFx1RENBNScgfSxcbiAgICBzaG90Z3VuOiB7IGljb246ICdcdUQ4M0RcdURDQTInIH0sXG4gICAgcmlmbGU6ICAgeyBpY29uOiAnXHVEODNDXHVERkFGJyB9LFxuICAgIHNuaXBlcjogIHsgaWNvbjogJ1x1RDgzRFx1REQyRCcgfSxcbiAgICBoZWF2eTogICB7IGljb246ICdcdUQ4M0VcdURERjEnIH0sXG4gICAgc3BlY2lhbDogeyBpY29uOiAnXHVEODNEXHVERTgwJyB9XG59O1xuXG5mdW5jdGlvbiBmbXQobikgeyByZXR1cm4gbi50b0xvY2FsZVN0cmluZygnZXMtRVMnKTsgfVxuXG5mdW5jdGlvbiByZXdhcmQob3B0cykge1xuICAgIG9wdHMgPSBvcHRzIHx8IHt9O1xuICAgIGNvbnN0IHhwID0gb3B0cy54cCB8fCAwLCBtb25leSA9IG9wdHMubW9uZXkgfHwgMCwgZGlhbW9uZHMgPSBvcHRzLmRpYW1vbmRzIHx8IDA7XG4gICAgY29uc3QgY29zbWV0aWMgPSBvcHRzLmNvc21ldGljIHx8IG51bGw7XG4gICAgY29uc3QgcGFydHMgPSBbXTtcbiAgICBpZiAoeHApIHBhcnRzLnB1c2goYCske2ZtdCh4cCl9IFhQYCk7XG4gICAgaWYgKG1vbmV5KSBwYXJ0cy5wdXNoKGArJCR7Zm10KG1vbmV5KX1gKTtcbiAgICBpZiAoZGlhbW9uZHMpIHBhcnRzLnB1c2goYCske2ZtdChkaWFtb25kcyl9IFx1RDgzRFx1REM4RWApO1xuICAgIGlmIChjb3NtZXRpYyAmJiBvcHRzLmxhYmVsKSBwYXJ0cy5wdXNoKG9wdHMubGFiZWwpO1xuICAgIHJldHVybiB7IHhwLCBtb25leSwgZGlhbW9uZHMsIGxhYmVsOiBwYXJ0cy5qb2luKCcgICcpIHx8IG9wdHMubGFiZWwgfHwgJycsIGNvc21ldGljIH07XG59XG5cbmNvbnN0IEFDSElFVkVNRU5UX1NUQVRTX0RFRkFVTFRTID0ge1xuICAgIGJvc3NLaWxsczogMCwgY2F0ZWdvcnlLaWxsczoge30sIHdlYXBvbnNVc2VkOiBbXSwgcmVsb2FkczogMCxcbiAgICBraWxsU3RyZWFrTm9EZWF0aDogMCwgYmVzdEtpbGxTdHJlYWs6IDAsIG1lbGVlQm9zc0tpbGxzOiAwLFxuICAgIHBlcmZlY3RXYXZlczogMCwgZXZlbnRzQ29tcGxldGVkOiAwLCBldmVudFR5cGVzQ29tcGxldGVkOiBbXSxcbiAgICB3ZWFwb25zUHVyY2hhc2VkOiAwLCBoZWF2eVdlYXBvblB1cmNoYXNlZDogZmFsc2UsIHdlYXBvbnNTb2xkOiAwLFxuICAgIHVwZ3JhZGVzQnV5czogMCwgdXBncmFkZXNUb3VjaGVkOiBbXSwgaGVhbHRoUGFja1VzZXM6IDAsIGRhc2hVc2VzOiAwLFxuICAgIHByb1dhdmVzQ2xlYXJlZDogMCwgbW9uZXlFYXJuZWQ6IDAsIGJvc3NXYXZlc0RlZmVhdGVkOiBbXSwgbG93SHBDbGVhcnM6IDAsXG4gICAgcGVuZGluZ01vbmV5OiAwXG59O1xuY29uc3QgQWNoaWV2ZW1lbnRTdGF0cyA9IE9iamVjdC5hc3NpZ24oe30sIEFDSElFVkVNRU5UX1NUQVRTX0RFRkFVTFRTLCBTYXZlU3lzdGVtLmdldCgnYWNodl9zdGF0cycsIHt9KSk7XG5cbmNvbnN0IEFjaGlldmVtZW50U3RhdGUgPSBTYXZlU3lzdGVtLmdldCgnYWNodl9zdGF0ZScsIHt9KTtcblxuY29uc3QgQUNISUVWRU1FTlRTX0RCID0ge307XG5cbmZ1bmN0aW9uIGJ1aWxkQ2hhaW4oaWRQcmVmaXgsIGNhdGVnb3J5LCBpY29uLCB0cmlnZ2VyLCBuYW1lRm4sIGRlc2NGbiwgZ2V0VmFsdWVGbiwgc3RhZ2VzLCBoaWRkZW4pIHtcbiAgICBzdGFnZXMuZm9yRWFjaCgocywgaSkgPT4ge1xuICAgICAgICBBQ0hJRVZFTUVOVFNfREJbYCR7aWRQcmVmaXh9XyR7aSArIDF9YF0gPSB7XG4gICAgICAgICAgICBpZDogYCR7aWRQcmVmaXh9XyR7aSArIDF9YCwgY2F0ZWdvcnksIGljb24sIHRyaWdnZXIsXG4gICAgICAgICAgICBuYW1lOiBuYW1lRm4ocy50YXJnZXQsIGkgKyAxKSwgZGVzYzogZGVzY0ZuKHMudGFyZ2V0LCBpICsgMSksXG4gICAgICAgICAgICByYXJpdHk6IHMucmFyaXR5LCB0YXJnZXQ6IHMudGFyZ2V0LCBnZXRWYWx1ZTogZ2V0VmFsdWVGbixcbiAgICAgICAgICAgIHJld2FyZDogcmV3YXJkKHMpLCBoaWRkZW46ICEhaGlkZGVuXG4gICAgICAgIH07XG4gICAgfSk7XG59XG5mdW5jdGlvbiBidWlsZFVuaXF1ZShpZCwgY2F0ZWdvcnksIGljb24sIHRyaWdnZXIsIG5hbWUsIGRlc2MsIHJhcml0eSwgdGFyZ2V0LCBnZXRWYWx1ZSwgcmV3YXJkT3B0cywgaGlkZGVuKSB7XG4gICAgQUNISUVWRU1FTlRTX0RCW2lkXSA9IHsgaWQsIGNhdGVnb3J5LCBpY29uLCB0cmlnZ2VyLCBuYW1lLCBkZXNjLCByYXJpdHksIHRhcmdldCwgZ2V0VmFsdWUsIHJld2FyZDogcmV3YXJkKHJld2FyZE9wdHMpLCBoaWRkZW46ICEhaGlkZGVuIH07XG59XG5cbmJ1aWxkQ2hhaW4oJ2tpbGxzX3RvdGFsJywgJ0NPTUJBVCcsICdcdUQ4M0RcdUREMkInLCAna2lsbCcsXG4gICAgdCA9PiBgRXh0ZXJtaW5hZG9yICgke2ZtdCh0KX0pYCwgdCA9PiBgRWxpbWluYSAke2ZtdCh0KX0gZW5lbWlnb3MgZW4gdG90YWwuYCxcbiAgICAoKSA9PiBQbGF5ZXJQcm9maWxlLmtpbGxzLFxuICAgIFt7IHRhcmdldDogMzAwLCByYXJpdHk6ICdSQVJPJywgeHA6IDQwLCBtb25leTogNjAgfSwgeyB0YXJnZXQ6IDUwMDAsIHJhcml0eTogJ1NVUEVSX1JBUk8nLCB4cDogMTUwLCBtb25leTogMzUwIH0sXG4gICAgIHsgdGFyZ2V0OiA1MDAwMCwgcmFyaXR5OiAnRVBJQ08nLCB4cDogNTAwLCBtb25leTogMTUwMCB9LCB7IHRhcmdldDogNTAwMDAwLCByYXJpdHk6ICdMRUdFTkRBUklPJywgeHA6IDE1MDAsIG1vbmV5OiA2MDAwLCBkaWFtb25kczogMTAwIH1dKTtcblxuYnVpbGRDaGFpbignYm9zc19raWxscycsICdCT1NTRVMnLCAnXHVEODNEXHVEQzgwJywgJ2tpbGwnLFxuICAgIHQgPT4gYENhemFkb3IgZGUgQm9zc2VzICgke2ZtdCh0KX0pYCwgdCA9PiBgRGVycm90YSBhICR7Zm10KHQpfSBqZWZlcy5gLFxuICAgICgpID0+IEFjaGlldmVtZW50U3RhdHMuYm9zc0tpbGxzLFxuICAgIFt7IHRhcmdldDogMywgcmFyaXR5OiAnUkFSTycsIHhwOiA2MCwgbW9uZXk6IDEyMCB9LCB7IHRhcmdldDogMTUsIHJhcml0eTogJ1NVUEVSX1JBUk8nLCB4cDogMjAwLCBtb25leTogNTAwIH0sXG4gICAgIHsgdGFyZ2V0OiA2MCwgcmFyaXR5OiAnRVBJQ08nLCB4cDogNjAwLCBtb25leTogMTgwMCB9LCB7IHRhcmdldDogMjAwLCByYXJpdHk6ICdMRUdFTkRBUklPJywgeHA6IDIwMDAsIG1vbmV5OiA3MDAwLCBkaWFtb25kczogMTIwIH1dKTtcblxuYnVpbGRDaGFpbignd2F2ZXNfc3Vydml2ZWQnLCAnU1VSVklWQUwnLCAnXHVEODNDXHVERjBBJywgJ3dhdmVDbGVhcicsXG4gICAgdCA9PiBgU3VwZXJ2aXZpZW50ZSAoT2xlYWRhICR7dH0pYCwgdCA9PiBgU29icmV2aXZlIGhhc3RhIGxhIG9sZWFkYSAke3R9LmAsXG4gICAgKCkgPT4gUGxheWVyUHJvZmlsZS5iZXN0V2F2ZSxcbiAgICBbeyB0YXJnZXQ6IDE1LCByYXJpdHk6ICdSQVJPJywgeHA6IDgwLCBtb25leTogMTgwIH0sIHsgdGFyZ2V0OiA0MCwgcmFyaXR5OiAnU1VQRVJfUkFSTycsIHhwOiAyNTAsIG1vbmV5OiA2MDAgfSxcbiAgICAgeyB0YXJnZXQ6IDgwLCByYXJpdHk6ICdFUElDTycsIHhwOiA3MDAsIG1vbmV5OiAyMjAwIH0sIHsgdGFyZ2V0OiAxNTAsIHJhcml0eTogJ0xFR0VOREFSSU8nLCB4cDogMTgwMCwgbW9uZXk6IDcwMDAsIGRpYW1vbmRzOiAxMDAgfV0pO1xuXG5idWlsZENoYWluKCdwbGF5dGltZScsICdTVVJWSVZBTCcsICdcdTIzRjFcdUZFMEYnLCAnd2F2ZUNsZWFyJyxcbiAgICB0ID0+IGBWZXRlcmFubyBkZSBHdWVycmEgKCR7dH0gbWluKWAsIHQgPT4gYEFjdW11bGEgJHt0fSBtaW51dG9zIGRlIGp1ZWdvLmAsXG4gICAgKCkgPT4gTWF0aC5mbG9vcihBY2hpZXZlbWVudE1hbmFnZXIuZ2V0VG90YWxQbGF5U2Vjb25kcygpIC8gNjApLFxuICAgIFt7IHRhcmdldDogNjAsIHJhcml0eTogJ1JBUk8nLCB4cDogNjAsIG1vbmV5OiAxMjAgfSwgeyB0YXJnZXQ6IDMwMCwgcmFyaXR5OiAnU1VQRVJfUkFSTycsIHhwOiAyMDAsIG1vbmV5OiA0NTAgfSxcbiAgICAgeyB0YXJnZXQ6IDkwMCwgcmFyaXR5OiAnRVBJQ08nLCB4cDogNTUwLCBtb25leTogMTQwMCB9LCB7IHRhcmdldDogMjQwMCwgcmFyaXR5OiAnTEVHRU5EQVJJTycsIHhwOiAxNTAwLCBtb25leTogNTAwMCwgZGlhbW9uZHM6IDgwIH1dKTtcblxuYnVpbGRDaGFpbignZGlzdGFuY2UnLCAnRVhQTE9SQVRJT04nLCAnXHVEODNEXHVEREZBXHVGRTBGJywgJ3dhdmVDbGVhcicsXG4gICAgdCA9PiBgTlx1MDBGM21hZGEgKCR7Zm10KHQpfSBtKWAsIHQgPT4gYFJlY29ycmUgJHtmbXQodCl9IG1ldHJvcyBlbiB0b3RhbC5gLFxuICAgICgpID0+IE1hdGguZmxvb3IoUGxheWVyUHJvZmlsZS5kaXN0YW5jZSksXG4gICAgW3sgdGFyZ2V0OiAxNTAwMCwgcmFyaXR5OiAnUkFSTycsIHhwOiA2MCwgbW9uZXk6IDEyMCB9LCB7IHRhcmdldDogNzUwMDAsIHJhcml0eTogJ1NVUEVSX1JBUk8nLCB4cDogMjAwLCBtb25leTogNDUwIH0sXG4gICAgIHsgdGFyZ2V0OiA0MDAwMDAsIHJhcml0eTogJ0VQSUNPJywgeHA6IDU1MCwgbW9uZXk6IDE0MDAgfSwgeyB0YXJnZXQ6IDIwMDAwMDAsIHJhcml0eTogJ0xFR0VOREFSSU8nLCB4cDogMTUwMCwgbW9uZXk6IDUwMDAsIGRpYW1vbmRzOiA4MCB9XSk7XG5cbmJ1aWxkQ2hhaW4oJ2FjY3VyYWN5JywgJ0NPTUJBVCcsICdcdUQ4M0NcdURGQUYnLCAnd2F2ZUNsZWFyJyxcbiAgICB0ID0+IGBQdW50ZXJcdTAwRURhICgke3R9JSlgLCB0ID0+IGBBbGNhbnphICR7dH0lIGRlIHByZWNpc2lcdTAwRjNuIChtXHUwMEVEbmltbyA1MDAgZGlzcGFyb3MpLmAsXG4gICAgKCkgPT4gKFBsYXllclByb2ZpbGUuc2hvdHNGaXJlZCA+PSA1MDAgPyBNYXRoLnJvdW5kKFBsYXllclByb2ZpbGUuc2hvdHNIaXQgLyBQbGF5ZXJQcm9maWxlLnNob3RzRmlyZWQgKiAxMDApIDogMCksXG4gICAgW3sgdGFyZ2V0OiA1MCwgcmFyaXR5OiAnUkFSTycsIHhwOiA4MCwgbW9uZXk6IDE1MCB9LCB7IHRhcmdldDogNzAsIHJhcml0eTogJ1NVUEVSX1JBUk8nLCB4cDogMjUwLCBtb25leTogNTAwIH0sXG4gICAgIHsgdGFyZ2V0OiA4NSwgcmFyaXR5OiAnRVBJQ08nLCB4cDogNzAwLCBtb25leTogMTYwMCB9LCB7IHRhcmdldDogOTUsIHJhcml0eTogJ0xFR0VOREFSSU8nLCB4cDogMTgwMCwgbW9uZXk6IDU1MDAsIGRpYW1vbmRzOiA5MCB9XSk7XG5cbmJ1aWxkQ2hhaW4oJ2RlYXRocycsICdTVVJWSVZBTCcsICdcdTI2MjBcdUZFMEYnLCAnZGVhdGgnLFxuICAgIHQgPT4gYFF1ZSBubyB0ZSB0aWVtYmxlIGVsIGdlbCAoJHtmbXQodCl9KWAsIHQgPT4gYE11ZXJlICR7Zm10KHQpfSB2ZWNlcy4gTmFkaWUgZGlqbyBxdWUgZnVlcmEgZlx1MDBFMWNpbC5gLFxuICAgICgpID0+IFBsYXllclByb2ZpbGUuZGVhdGhzLFxuICAgIFt7IHRhcmdldDogMSwgcmFyaXR5OiAnUkFSTycsIHhwOiAyMCwgbW9uZXk6IDMwIH0sIHsgdGFyZ2V0OiAyNSwgcmFyaXR5OiAnU1VQRVJfUkFSTycsIHhwOiA4MCwgbW9uZXk6IDE1MCB9LFxuICAgICB7IHRhcmdldDogMTAwLCByYXJpdHk6ICdFUElDTycsIHhwOiAzMDAsIG1vbmV5OiA2MDAgfSwgeyB0YXJnZXQ6IDMwMCwgcmFyaXR5OiAnTEVHRU5EQVJJTycsIHhwOiA5MDAsIG1vbmV5OiAyMjAwIH1dKTtcblxuYnVpbGRDaGFpbigncmVsb2FkcycsICdXRUFQT05TJywgJ1x1RDgzRFx1REQwNCcsICdyZWxvYWQnLFxuICAgIHQgPT4gYE1hbm9zIHJcdTAwRTFwaWRhcyAoJHtmbXQodCl9KWAsIHQgPT4gYFJlY2FyZ2EgdHVzIGFybWFzICR7Zm10KHQpfSB2ZWNlcy5gLFxuICAgICgpID0+IEFjaGlldmVtZW50U3RhdHMucmVsb2FkcyxcbiAgICBbeyB0YXJnZXQ6IDE1MCwgcmFyaXR5OiAnUkFSTycsIHhwOiA0MCwgbW9uZXk6IDkwIH0sIHsgdGFyZ2V0OiA4MDAsIHJhcml0eTogJ1NVUEVSX1JBUk8nLCB4cDogMTQwLCBtb25leTogMjgwIH0sXG4gICAgIHsgdGFyZ2V0OiA0MDAwLCByYXJpdHk6ICdFUElDTycsIHhwOiA0NTAsIG1vbmV5OiAxMDAwIH0sIHsgdGFyZ2V0OiAxNTAwMCwgcmFyaXR5OiAnTEVHRU5EQVJJTycsIHhwOiAxMjAwLCBtb25leTogMzUwMCwgZGlhbW9uZHM6IDYwIH1dKTtcblxuYnVpbGRDaGFpbignbGV2ZWwnLCAnUFJPR1JFU1NJT04nLCAnXHUyQjUwJywgJ2xldmVsVXAnLFxuICAgIHQgPT4gYE5pdmVsICR7dH1gLCB0ID0+IGBBbGNhbnphIGVsIG5pdmVsICR7dH0gZGUganVnYWRvci5gLFxuICAgICgpID0+IFBsYXllclByb2ZpbGUubGV2ZWwsXG4gICAgW3sgdGFyZ2V0OiA4LCByYXJpdHk6ICdSQVJPJywgbW9uZXk6IDE1MCB9LCB7IHRhcmdldDogMTgsIHJhcml0eTogJ1NVUEVSX1JBUk8nLCBtb25leTogNDAwIH0sXG4gICAgIHsgdGFyZ2V0OiAzNSwgcmFyaXR5OiAnRVBJQ08nLCBtb25leTogMTMwMCB9LCB7IHRhcmdldDogNjAsIHJhcml0eTogJ0xFR0VOREFSSU8nLCBtb25leTogNTAwMCwgZGlhbW9uZHM6IDE1MCB9XSk7XG5cbmJ1aWxkQ2hhaW4oJ3BlcmZlY3Rfd2F2ZXMnLCAnQ09NQkFUJywgJ1x1RDgzRFx1REVFMVx1RkUwRicsICd3YXZlQ2xlYXInLFxuICAgIHQgPT4gYEltcGVjYWJsZSAoJHtmbXQodCl9KWAsIHQgPT4gYENvbXBsZXRhICR7Zm10KHQpfSBvbGVhZGFzIHNpbiByZWNpYmlyIGRhXHUwMEYxby5gLFxuICAgICgpID0+IEFjaGlldmVtZW50U3RhdHMucGVyZmVjdFdhdmVzLFxuICAgIFt7IHRhcmdldDogNSwgcmFyaXR5OiAnUkFSTycsIHhwOiA2MCwgbW9uZXk6IDEyMCB9LCB7IHRhcmdldDogMzAsIHJhcml0eTogJ1NVUEVSX1JBUk8nLCB4cDogMjIwLCBtb25leTogNTUwIH0sXG4gICAgIHsgdGFyZ2V0OiAxMjAsIHJhcml0eTogJ0VQSUNPJywgeHA6IDcwMCwgbW9uZXk6IDIyMDAgfSwgeyB0YXJnZXQ6IDMwMCwgcmFyaXR5OiAnTEVHRU5EQVJJTycsIHhwOiAyMjAwLCBtb25leTogODAwMCwgZGlhbW9uZHM6IDEyMCB9XSk7XG5cbmJ1aWxkQ2hhaW4oJ2tpbGxfc3RyZWFrJywgJ0NPTUJBVCcsICdcdUQ4M0RcdUREMjUnLCAna2lsbCcsXG4gICAgdCA9PiBgUmFjaGEgbGV0YWwgKCR7Zm10KHQpfSlgLCB0ID0+IGBFbGltaW5hICR7Zm10KHQpfSBlbmVtaWdvcyBzZWd1aWRvcyBzaW4gbW9yaXIuYCxcbiAgICAoKSA9PiBBY2hpZXZlbWVudFN0YXRzLmJlc3RLaWxsU3RyZWFrLFxuICAgIFt7IHRhcmdldDogMTUwLCByYXJpdHk6ICdSQVJPJywgeHA6IDgwLCBtb25leTogMTYwIH0sIHsgdGFyZ2V0OiA3MDAsIHJhcml0eTogJ0VQSUNPJywgeHA6IDM1MCwgbW9uZXk6IDkwMCB9LFxuICAgICB7IHRhcmdldDogMzAwMCwgcmFyaXR5OiAnTUlUSUNPJywgeHA6IDEyMDAsIG1vbmV5OiAzNTAwLCBkaWFtb25kczogNjAgfV0pO1xuXG5idWlsZENoYWluKCdldmVudHNfY29tcGxldGVkJywgJ0VWRU5UUycsICdcdUQ4M0NcdURGMkFcdUZFMEYnLCAnZXZlbnRDb21wbGV0ZScsXG4gICAgdCA9PiBgQ3VydGlkbyBlbiB0b3JtZW50YXMgKCR7Zm10KHQpfSlgLCB0ID0+IGBTdXBlcmEgJHtmbXQodCl9IG9sZWFkYXMgY29uIHVuIGV2ZW50byBkaW5cdTAwRTFtaWNvIGFjdGl2by5gLFxuICAgICgpID0+IEFjaGlldmVtZW50U3RhdHMuZXZlbnRzQ29tcGxldGVkLFxuICAgIFt7IHRhcmdldDogNSwgcmFyaXR5OiAnUkFSTycsIHhwOiA0MCwgbW9uZXk6IDkwIH0sIHsgdGFyZ2V0OiA0MCwgcmFyaXR5OiAnU1VQRVJfUkFSTycsIHhwOiAxODAsIG1vbmV5OiA0NTAgfSxcbiAgICAgeyB0YXJnZXQ6IDIwMCwgcmFyaXR5OiAnRVBJQ08nLCB4cDogNjAwLCBtb25leTogMTcwMCB9XSk7XG5cbmJ1aWxkQ2hhaW4oJ3dlYXBvbnNfdXNlZCcsICdXRUFQT05TJywgJ1x1RDgzQ1x1REY5MicsICdzaG9vdCcsXG4gICAgdCA9PiBgQXJzZW5hbCAoJHt0fS8ke1RPVEFMX1dFQVBPTl9DT1VOVH0pYCwgdCA9PiBgVXNhICR7dH0gYXJtYXMgZGlzdGludGFzIGFsIG1lbm9zIHVuYSB2ZXouYCxcbiAgICAoKSA9PiBBY2hpZXZlbWVudFN0YXRzLndlYXBvbnNVc2VkLmxlbmd0aCxcbiAgICBbeyB0YXJnZXQ6IDUsIHJhcml0eTogJ1JBUk8nLCB4cDogNTAsIG1vbmV5OiAxMDAgfSwgeyB0YXJnZXQ6IDEwLCByYXJpdHk6ICdTVVBFUl9SQVJPJywgeHA6IDE1MCwgbW9uZXk6IDMwMCB9LFxuICAgICB7IHRhcmdldDogMTUsIHJhcml0eTogJ0VQSUNPJywgeHA6IDQ1MCwgbW9uZXk6IDkwMCB9LCB7IHRhcmdldDogVE9UQUxfV0VBUE9OX0NPVU5ULCByYXJpdHk6ICdMRUdFTkRBUklPJywgeHA6IDEyMDAsIG1vbmV5OiAzMDAwLCBkaWFtb25kczogNjAgfV0pO1xuXG5idWlsZENoYWluKCdoZWFsdGhwYWNrcycsICdTVVJWSVZBTCcsICdcdUQ4M0RcdURDODknLCAnaGVhbHRoQnV5JyxcbiAgICB0ID0+IGBBZGljdG8gYSBsYSBzYW5hY2lcdTAwRjNuICgke2ZtdCh0KX0pYCwgdCA9PiBgQ29tcHJhIGN1cmFjaVx1MDBGM24gZW4gbGEgdGllbmRhICR7Zm10KHQpfSB2ZWNlcy5gLFxuICAgICgpID0+IEFjaGlldmVtZW50U3RhdHMuaGVhbHRoUGFja1VzZXMsXG4gICAgW3sgdGFyZ2V0OiAyNSwgcmFyaXR5OiAnUkFSTycsIHhwOiA0MCwgbW9uZXk6IDgwIH0sIHsgdGFyZ2V0OiAxNTAsIHJhcml0eTogJ1NVUEVSX1JBUk8nLCB4cDogMTUwLCBtb25leTogMzAwIH0sXG4gICAgIHsgdGFyZ2V0OiA2MDAsIHJhcml0eTogJ0VQSUNPJywgeHA6IDQ1MCwgbW9uZXk6IDkwMCB9XSk7XG5cbmJ1aWxkQ2hhaW4oJ3Byb19ncmFwaGljcycsICdTUEVDSUFMJywgJ1x1RDgzRFx1RERBNVx1RkUwRicsICd3YXZlQ2xlYXInLFxuICAgIHQgPT4gYFNpbiBjb25jZXNpb25lcyAoJHtmbXQodCl9KWAsIHQgPT4gYENvbXBsZXRhICR7Zm10KHQpfSBvbGVhZGFzIGNvbiBnclx1MDBFMWZpY29zIGVuIFBSTy5gLFxuICAgICgpID0+IEFjaGlldmVtZW50U3RhdHMucHJvV2F2ZXNDbGVhcmVkLFxuICAgIFt7IHRhcmdldDogMjUsIHJhcml0eTogJ1JBUk8nLCB4cDogNjAsIG1vbmV5OiAxMDAgfSwgeyB0YXJnZXQ6IDE1MCwgcmFyaXR5OiAnRVBJQ08nLCB4cDogMjUwLCBtb25leTogNTAwIH1dKTtcblxuYnVpbGRDaGFpbignbW9uZXlfZWFybmVkJywgJ1BST0dSRVNTSU9OJywgJ1x1RDgzRFx1RENCMCcsICdraWxsJyxcbiAgICB0ID0+IGBGb3J0dW5hIGFjdW11bGFkYSAoJCR7Zm10KHQpfSlgLCB0ID0+IGBHYW5hICQke2ZtdCh0KX0gZW4gdG90YWwgZWxpbWluYW5kbyBlbmVtaWdvcy5gLFxuICAgICgpID0+IEFjaGlldmVtZW50U3RhdHMubW9uZXlFYXJuZWQsXG4gICAgW3sgdGFyZ2V0OiA1MDAwLCByYXJpdHk6ICdSQVJPJywgeHA6IDYwLCBtb25leTogMTAwIH0sIHsgdGFyZ2V0OiA1MDAwMCwgcmFyaXR5OiAnU1VQRVJfUkFSTycsIHhwOiAyMDAsIG1vbmV5OiA0MDAgfSxcbiAgICAgeyB0YXJnZXQ6IDc1MDAwMCwgcmFyaXR5OiAnRVBJQ08nLCB4cDogNzAwLCBtb25leTogMTUwMCB9LCB7IHRhcmdldDogMTAwMDAwMDAsIHJhcml0eTogJ0xFR0VOREFSSU8nLCB4cDogMjAwMCwgbW9uZXk6IDUwMDAsIGRpYW1vbmRzOiAxMDAgfV0pO1xuXG5idWlsZENoYWluKCdzaG90c19maXJlZCcsICdXRUFQT05TJywgJ1x1RDgzRFx1RENBNScsICdzaG9vdCcsXG4gICAgdCA9PiBgRGVkbyBjYWxpZW50ZSAoJHtmbXQodCl9KWAsIHQgPT4gYERpc3BhcmEgJHtmbXQodCl9IHZlY2VzIGVuIHRvdGFsLmAsXG4gICAgKCkgPT4gUGxheWVyUHJvZmlsZS5zaG90c0ZpcmVkLFxuICAgIFt7IHRhcmdldDogMjAwMCwgcmFyaXR5OiAnUkFSTycsIHhwOiA0MCwgbW9uZXk6IDgwIH0sIHsgdGFyZ2V0OiAxNTAwMCwgcmFyaXR5OiAnU1VQRVJfUkFSTycsIHhwOiAxNDAsIG1vbmV5OiAyNTAgfSxcbiAgICAgeyB0YXJnZXQ6IDc1MDAwLCByYXJpdHk6ICdFUElDTycsIHhwOiA0NTAsIG1vbmV5OiA5MDAgfSwgeyB0YXJnZXQ6IDQwMDAwMCwgcmFyaXR5OiAnTEVHRU5EQVJJTycsIHhwOiAxMjAwLCBtb25leTogMzAwMCwgZGlhbW9uZHM6IDYwIH1dKTtcblxuT2JqZWN0LmtleXMoQ0FURUdPUllfTUVUQSkuZm9yRWFjaChjYXQgPT4ge1xuICAgIGNvbnN0IG1ldGEgPSBDQVRFR09SWV9NRVRBW2NhdF07XG4gICAgYnVpbGRDaGFpbihgY2F0X2tpbGxzXyR7Y2F0fWAsICdXRUFQT05TJywgbWV0YS5pY29uLCAna2lsbCcsXG4gICAgICAgIHQgPT4gYEVzcGVjaWFsaXN0YSAke2NhdC50b1VwcGVyQ2FzZSgpfSAoJHtmbXQodCl9KWAsIHQgPT4gYEVsaW1pbmEgJHtmbXQodCl9IGVuZW1pZ29zIHVzYW5kbyBhcm1hcyBkZSBjYXRlZ29yXHUwMEVEYSBcIiR7Y2F0fVwiLmAsXG4gICAgICAgICgpID0+IEFjaGlldmVtZW50U3RhdHMuY2F0ZWdvcnlLaWxsc1tjYXRdIHx8IDAsXG4gICAgICAgIFt7IHRhcmdldDogNDAwLCByYXJpdHk6ICdSQVJPJywgeHA6IDUwLCBtb25leTogMTAwIH0sIHsgdGFyZ2V0OiA1MDAwLCByYXJpdHk6ICdFUElDTycsIHhwOiAzNTAsIG1vbmV5OiA4MDAgfV0pO1xufSk7XG5cbltbJ1NUT1JNJywgJ1x1RDgzQ1x1REYyOVx1RkUwRiddLCBbJ1NBTkRTVE9STScsICdcdUQ4M0NcdURGMkFcdUZFMEYnXSwgWydCTElaWkFSRCcsICdcdTI3NDRcdUZFMEYnXSwgWydSQURJT0FDVElWRScsICdcdTI2MjJcdUZFMEYnXSwgWydJTlZBU0lPTicsICdcdUQ4M0RcdURDODAnXSwgWydEQVJLTkVTUycsICdcdUQ4M0NcdURGMTEnXV0uZm9yRWFjaCgoW2tleSwgaWNvbl0pID0+IHtcbiAgICBidWlsZFVuaXF1ZShgZXZlbnRfc3Vydml2ZV8ke2tleX1gLCAnRVZFTlRTJywgaWNvbiwgJ2V2ZW50U3Vydml2ZScsXG4gICAgICAgIGBTdXBlclx1MDBGMzogJHtSQU5ET01fRVZFTlRTW2tleV0ubGFiZWx9YCwgYENvbXBsZXRhIHVuYSBvbGVhZGEgZW50ZXJhIGNvbiBlbCBldmVudG8gXCIke1JBTkRPTV9FVkVOVFNba2V5XS5sYWJlbH1cIiBhY3Rpdm8uYCxcbiAgICAgICAgJ01JVElDTycsIDEsICgpID0+IChBY2hpZXZlbWVudFN0YXRzLmV2ZW50VHlwZXNDb21wbGV0ZWQuaW5jbHVkZXMoa2V5KSA/IDEgOiAwKSwgeyB4cDogMjUwLCBtb25leTogNTAwLCBkaWFtb25kczogMjAgfSk7XG59KTtcblxuYnVpbGRVbmlxdWUoJ21lbGVlX2Jvc3Nfa2lsbCcsICdTUEVDSUFMJywgJ1x1RDgzRFx1REQyQScsICdraWxsJywgJ0ZpbG8gQ29udHJhIFRpdGFuZXMnLFxuICAgICdEZXJyb3RhIGEgdW4gamVmZSB1c2FuZG8gXHUwMEZBbmljYW1lbnRlIHVuIGFybWEgY3VlcnBvIGEgY3VlcnBvLicsICdMRUdFTkRBUklPJywgMSxcbiAgICAoKSA9PiBBY2hpZXZlbWVudFN0YXRzLm1lbGVlQm9zc0tpbGxzLCB7IHhwOiAxMDAwLCBtb25leTogMjUwMCwgZGlhbW9uZHM6IDgwIH0sIHRydWUpO1xuXG5idWlsZFVuaXF1ZSgnbm9fYnV5X3dlYXBvbnNfdzE1JywgJ1NQRUNJQUwnLCAnXHVEODNDXHVERjkyJywgJ3dhdmVDbGVhcicsICdNaW5pbWFsaXN0YScsXG4gICAgJ0xsZWdhIGEgbGEgb2xlYWRhIDE1IHNpbiBjb21wcmFyIG5pbmd1bmEgYXJtYSBlbiBsYSB0aWVuZGEuJywgJ01JVElDTycsIDEsXG4gICAgKCkgPT4gKFBsYXllclByb2ZpbGUuYmVzdFdhdmUgPj0gMTUgJiYgQWNoaWV2ZW1lbnRTdGF0cy53ZWFwb25zUHVyY2hhc2VkID09PSAwID8gMSA6IDApLCB7IHhwOiA2MDAsIG1vbmV5OiAxNTAwLCBkaWFtb25kczogNDAgfSwgdHJ1ZSk7XG5cbmJ1aWxkVW5pcXVlKCdsZXZlbF80MF9yZXdhcmRzJywgJ1BST0dSRVNTSU9OJywgJ1x1RDgzQ1x1REZDNScsICdsZXZlbFVwJywgJ1ZldGVyYW5vIENvbmRlY29yYWRvJyxcbiAgICAnQWxjYW56YSBlbCBuaXZlbCA2MC4nLCAnRVBJQ08nLCAxLCAoKSA9PiAoUGxheWVyUHJvZmlsZS5sZXZlbCA+PSA2MCA/IDEgOiAwKSxcbiAgICB7IG1vbmV5OiAyNTAwLCBjb3NtZXRpYzogJ3RpdGxlJywgbGFiZWw6ICdUXHUwMEVEdHVsbyBcIlZldGVyYW5vXCInIH0pO1xuXG5idWlsZFVuaXF1ZSgnd2F2ZV8yMDAnLCAnU1VSVklWQUwnLCAnXHVEODNDXHVERkM2JywgJ3dhdmVDbGVhcicsICdJbm1vcnRhbCBkZWwgU2xpbWUnLFxuICAgICdTb2JyZXZpdmUgaGFzdGEgbGEgb2xlYWRhIDIwMC4nLCAnTEVHRU5EQVJJTycsIDIwMCwgKCkgPT4gUGxheWVyUHJvZmlsZS5iZXN0V2F2ZSwgeyB4cDogMzAwMCwgbW9uZXk6IDEwMDAwLCBkaWFtb25kczogMTUwIH0pO1xuXG5idWlsZFVuaXF1ZSgnYm9zc193YXZlMTUnLCAnQk9TU0VTJywgJ1x1RDgzRFx1REM3OScsICdraWxsJywgJ1NlZ3VuZG8gQ29udGFjdG8nLFxuICAgICdEZXJyb3RhIGFsIGplZmUgZGUgbGEgb2xlYWRhIDE1LicsICdFUElDTycsIDEsICgpID0+IChBY2hpZXZlbWVudFN0YXRzLmJvc3NXYXZlc0RlZmVhdGVkLmluY2x1ZGVzKDE1KSA/IDEgOiAwKSwgeyB4cDogNDUwLCBtb25leTogMTIwMCB9KTtcblxuYnVpbGRVbmlxdWUoJ2Jvc3Nfd2F2ZTMwJywgJ0JPU1NFUycsICdcdUQ4M0RcdURDN0EnLCAna2lsbCcsICdFbCBWZXJkYWRlcm8gRGVzYWZcdTAwRURvJyxcbiAgICAnRGVycm90YSBhbCBqZWZlIGRlIGxhIG9sZWFkYSAzMC4nLCAnTUlUSUNPJywgMSwgKCkgPT4gKEFjaGlldmVtZW50U3RhdHMuYm9zc1dhdmVzRGVmZWF0ZWQuaW5jbHVkZXMoMzApID8gMSA6IDApLCB7IHhwOiA5MDAsIG1vbmV5OiAyNTAwLCBkaWFtb25kczogNDAgfSk7XG5cbmJ1aWxkVW5pcXVlKCdoZWF2eV93ZWFwb25fcHVyY2hhc2UnLCAnV0VBUE9OUycsICdcdTI2OTlcdUZFMEYnLCAnYnV5V2VhcG9uJywgJ0FydGlsbGVyXHUwMEVEYSBQZXNhZGEnLFxuICAgICdDb21wcmEgdHUgcHJpbWVyYSBhcm1hIGRlIGNhdGVnb3JcdTAwRURhIHBlc2FkYSBvIGVzcGVjaWFsLicsICdTVVBFUl9SQVJPJywgMSxcbiAgICAoKSA9PiAoQWNoaWV2ZW1lbnRTdGF0cy5oZWF2eVdlYXBvblB1cmNoYXNlZCA/IDEgOiAwKSwgeyB4cDogMTAwLCBtb25leTogMjUwIH0pO1xuXG5idWlsZFVuaXF1ZSgnc2VsbF93ZWFwb25fZmlyc3QnLCAnV0VBUE9OUycsICdcdUQ4M0RcdURDQjUnLCAnc2VsbFdlYXBvbicsICdSZXZlbnRhIFRcdTAwRTFjdGljYScsXG4gICAgJ1ZlbmRlIHVuIGFybWEgZW4gbGEgdGllbmRhIHBvciBwcmltZXJhIHZlei4nLCAnUkFSTycsIDEsICgpID0+IChBY2hpZXZlbWVudFN0YXRzLndlYXBvbnNTb2xkID49IDEgPyAxIDogMCksIHsgeHA6IDI1LCBtb25leTogNjAgfSk7XG5cbmJ1aWxkVW5pcXVlKCd1cGdyYWRlc19hbGxfbWF4ZWQnLCAnUFJPR1JFU1NJT04nLCAnXHVEODNEXHVEQ0M4JywgJ3VwZ3JhZGVCdXknLCAnTWVqb3JhIFRvdGFsJyxcbiAgICAnTGxldmEgbGFzIDUgbWVqb3JhcyBwZXJtYW5lbnRlcyBhIHN1IG5pdmVsIG1cdTAwRTF4aW1vLicsICdMRUdFTkRBUklPJywgMSxcbiAgICAoKSA9PiAoT2JqZWN0LmtleXMoVVBHUkFERVNfREIpLmV2ZXJ5KGsgPT4gUHJvZ3Jlc3Npb24uZ2V0TGV2ZWwoaykgPj0gVVBHUkFERVNfREJba10ubWF4TGV2ZWwpID8gMSA6IDApLFxuICAgIHsgbW9uZXk6IDQwMDAsIGRpYW1vbmRzOiAxMDAsIGNvc21ldGljOiAnc2tpbicsIGxhYmVsOiAnU2tpbiBleGNsdXNpdmEnIH0pO1xuXG5idWlsZFVuaXF1ZSgndXBncmFkZXNfZWFjaF9vbmUnLCAnUFJPR1JFU1NJT04nLCAnXHVEODNFXHVEREVDJywgJ3VwZ3JhZGVCdXknLCAnVG9kb3RlcnJlbm8nLFxuICAgICdDb21wcmEgYWwgbWVub3MgdW4gbml2ZWwgZGUgY2FkYSBtZWpvcmEgcGVybWFuZW50ZS4nLCAnU1VQRVJfUkFSTycsIE9iamVjdC5rZXlzKFVQR1JBREVTX0RCKS5sZW5ndGgsXG4gICAgKCkgPT4gQWNoaWV2ZW1lbnRTdGF0cy51cGdyYWRlc1RvdWNoZWQubGVuZ3RoLCB7IHhwOiAxMjAsIG1vbmV5OiAzMDAgfSk7XG5cbmJ1aWxkVW5pcXVlKCdkYXNoX21hc3RlcicsICdTUEVDSUFMJywgJ1x1RDgzRFx1RENBOCcsICdkYXNoJywgJ01hZXN0cm8gZGVsIERhc2gnLFxuICAgICdVdGlsaXphIGVsIGRhc2ggMTUwMCB2ZWNlcy4nLCAnU1VQRVJfUkFSTycsIDE1MDAsICgpID0+IEFjaGlldmVtZW50U3RhdHMuZGFzaFVzZXMsIHsgeHA6IDE1MCwgbW9uZXk6IDQwMCB9KTtcblxuYnVpbGRVbmlxdWUoJ2xvd19ocF9jbGVhcicsICdTVVJWSVZBTCcsICdcdUQ4M0RcdURDOTMnLCAnd2F2ZUNsZWFyJywgJ0FsIEZpbG8gZGUgbGEgTXVlcnRlJyxcbiAgICAnVGVybWluYSB1bmEgb2xlYWRhIGNvbiBtZW5vcyBkZWwgMTAlIGRlIHR1IHZpZGEgbVx1MDBFMXhpbWEuJywgJ0VQSUNPJywgMSwgKCkgPT4gQWNoaWV2ZW1lbnRTdGF0cy5sb3dIcENsZWFycywgeyB4cDogMjUwLCBtb25leTogNjAwIH0sIHRydWUpO1xuXG5jb25zdCBfYWNoVHJpZ2dlckluZGV4ID0ge307XG5PYmplY3QudmFsdWVzKEFDSElFVkVNRU5UU19EQikuZm9yRWFjaChkZWYgPT4ge1xuICAgIChfYWNoVHJpZ2dlckluZGV4W2RlZi50cmlnZ2VyXSA9IF9hY2hUcmlnZ2VySW5kZXhbZGVmLnRyaWdnZXJdIHx8IFtdKS5wdXNoKGRlZik7XG59KTtcblxuY29uc3QgQWNoaWV2ZW1lbnRNYW5hZ2VyID0ge1xuICAgIGdldFN0YXRlKGlkKSB7XG4gICAgICAgIGlmICghQWNoaWV2ZW1lbnRTdGF0ZVtpZF0pIEFjaGlldmVtZW50U3RhdGVbaWRdID0geyBub3RpZmllZDogZmFsc2UsIGNsYWltZWQ6IGZhbHNlIH07XG4gICAgICAgIHJldHVybiBBY2hpZXZlbWVudFN0YXRlW2lkXTtcbiAgICB9LFxuICAgIGV2YWx1YXRlKHRyaWdnZXIpIHtcbiAgICAgICAgY29uc3QgZGVmcyA9IF9hY2hUcmlnZ2VySW5kZXhbdHJpZ2dlcl07XG4gICAgICAgIGlmICghZGVmcykgcmV0dXJuO1xuICAgICAgICBsZXQgZGlydHkgPSBmYWxzZTtcbiAgICAgICAgZGVmcy5mb3JFYWNoKGRlZiA9PiB7XG4gICAgICAgICAgICBpZiAoZGVmLmdldFZhbHVlKCkgPCBkZWYudGFyZ2V0KSByZXR1cm47XG4gICAgICAgICAgICBjb25zdCBzdGF0ZSA9IHRoaXMuZ2V0U3RhdGUoZGVmLmlkKTtcbiAgICAgICAgICAgIGlmICghc3RhdGUubm90aWZpZWQpIHsgc3RhdGUubm90aWZpZWQgPSB0cnVlOyB0aGlzLnNob3dUb2FzdChkZWYpOyBkaXJ0eSA9IHRydWU7IH1cbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChkaXJ0eSkgdGhpcy5zYXZlU3RhdGUoKTtcbiAgICB9LFxuICAgIGNsYWltKGlkKSB7XG4gICAgICAgIGNvbnN0IGRlZiA9IEFDSElFVkVNRU5UU19EQltpZF07XG4gICAgICAgIGlmICghZGVmKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gdGhpcy5nZXRTdGF0ZShpZCk7XG4gICAgICAgIGlmIChzdGF0ZS5jbGFpbWVkIHx8IGRlZi5nZXRWYWx1ZSgpIDwgZGVmLnRhcmdldCkgcmV0dXJuIGZhbHNlO1xuICAgICAgICBzdGF0ZS5jbGFpbWVkID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hcHBseVJld2FyZChkZWYpO1xuICAgICAgICB0aGlzLnNhdmVTdGF0ZSgpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICAgIGFwcGx5UmV3YXJkKGRlZikge1xuICAgICAgICBjb25zdCByID0gZGVmLnJld2FyZDtcbiAgICAgICAgaWYgKHIueHApIGdhbWUuZ3JhbnRYUChyLnhwKTtcbiAgICAgICAgaWYgKHIuZGlhbW9uZHMpIGdhbWUuZ3JhbnREaWFtb25kcyhyLmRpYW1vbmRzKTtcbiAgICAgICAgaWYgKHIubW9uZXkpIHtcbiAgICAgICAgICAgIGlmIChnYW1lLnBsYXllcikgZ2FtZS5wbGF5ZXIubW9uZXkgKz0gci5tb25leTtcbiAgICAgICAgICAgIGVsc2UgQWNoaWV2ZW1lbnRTdGF0cy5wZW5kaW5nTW9uZXkgKz0gci5tb25leTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoci5jb3NtZXRpYykgUGxheWVyUHJvZmlsZS51bmxvY2tzLnB1c2goeyBhY2hpZXZlbWVudDogZGVmLmlkLCB0eXBlOiByLmNvc21ldGljLCBsYWJlbDogci5sYWJlbCB9KTtcbiAgICAgICAgUGxheWVyUHJvZmlsZS5zYXZlKCk7XG4gICAgICAgIHRoaXMuc2F2ZVN0YXRzKCk7XG4gICAgfSxcbiAgICBzaG93VG9hc3QoZGVmKSB7XG4gICAgICAgIHBsYXlTRlgoJ2FjaGlldmVtZW50X3VubG9jaycsIDAuNiwgMC4wNSk7XG4gICAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FjaGlldmVtZW50LXRvYXN0Jyk7XG4gICAgICAgIGlmICghZWwpIHJldHVybjtcbiAgICAgICAgY29uc3QgcmFyaXR5ID0gUkFSSVRZW2RlZi5yYXJpdHldO1xuICAgICAgICBlbC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cImFjaHYtdG9hc3QtaGVhZGVyXCIgc3R5bGU9XCJjb2xvcjoke3Jhcml0eS5jb2xvcn1cIj5cdUQ4M0NcdURGQzYgTE9HUk8gREVTQkxPUVVFQURPIFx1MjAxNCAke3Jhcml0eS5sYWJlbH08L2Rpdj48ZGl2IGNsYXNzPVwiYWNodi10b2FzdC1uYW1lXCI+JHtkZWYuaWNvbn0gJHtkZWYubmFtZX08L2Rpdj5gO1xuICAgICAgICBlbC5zdHlsZS5zZXRQcm9wZXJ0eSgnLS1yYXJpdHktY29sb3InLCByYXJpdHkuY29sb3IpO1xuICAgICAgICBlbC5jbGFzc0xpc3QucmVtb3ZlKCdzaG93Jyk7IHZvaWQgZWwub2Zmc2V0V2lkdGg7IGVsLmNsYXNzTGlzdC5hZGQoJ3Nob3cnKTtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuX3RvYXN0VGltZXIpO1xuICAgICAgICB0aGlzLl90b2FzdFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBlbC5jbGFzc0xpc3QucmVtb3ZlKCdzaG93JyksIDM4MDApO1xuICAgIH0sXG4gICAgZ2V0VG90YWxQbGF5U2Vjb25kcygpIHtcbiAgICAgICAgY29uc3QgbGl2ZSA9IGdhbWUuc3RhcnRlZCA/IE1hdGguZmxvb3IoKERhdGUubm93KCkgLSBnYW1lLnN0YXJ0VGltZSkgLyAxMDAwKSA6IDA7XG4gICAgICAgIHJldHVybiBQbGF5ZXJQcm9maWxlLnBsYXlUaW1lU2VjICsgbGl2ZTtcbiAgICB9LFxuICAgIG9uV2F2ZUNsZWFyKHdhdmVOdW0sIGV2ZW50S2V5KSB7XG4gICAgICAgIGlmICghdGhpcy5fdG9va0RhbWFnZVRoaXNXYXZlKSBBY2hpZXZlbWVudFN0YXRzLnBlcmZlY3RXYXZlcysrO1xuICAgICAgICB0aGlzLl90b29rRGFtYWdlVGhpc1dhdmUgPSBmYWxzZTtcbiAgICAgICAgaWYgKGV2ZW50S2V5KSB7XG4gICAgICAgICAgICBBY2hpZXZlbWVudFN0YXRzLmV2ZW50c0NvbXBsZXRlZCsrO1xuICAgICAgICAgICAgaWYgKCFBY2hpZXZlbWVudFN0YXRzLmV2ZW50VHlwZXNDb21wbGV0ZWQuaW5jbHVkZXMoZXZlbnRLZXkpKSBBY2hpZXZlbWVudFN0YXRzLmV2ZW50VHlwZXNDb21wbGV0ZWQucHVzaChldmVudEtleSk7XG4gICAgICAgICAgICB0aGlzLmV2YWx1YXRlKCdldmVudENvbXBsZXRlJyk7XG4gICAgICAgICAgICB0aGlzLmV2YWx1YXRlKCdldmVudFN1cnZpdmUnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoU2V0dGluZ3MuZ3JhcGhpY3MgPT09ICdQUk8nKSBBY2hpZXZlbWVudFN0YXRzLnByb1dhdmVzQ2xlYXJlZCsrO1xuICAgICAgICBpZiAoZ2FtZS5wbGF5ZXIgJiYgZ2FtZS5wbGF5ZXIuaHAgPCBnYW1lLnBsYXllci5tYXhIcCAqIDAuMSkgQWNoaWV2ZW1lbnRTdGF0cy5sb3dIcENsZWFycysrO1xuICAgICAgICB0aGlzLmV2YWx1YXRlKCd3YXZlQ2xlYXInKTtcbiAgICAgICAgdGhpcy5zYXZlU3RhdHMoKTtcbiAgICB9LFxuICAgIHNhdmVTdGF0cygpIHsgU2F2ZVN5c3RlbS5zZXQoJ2FjaHZfc3RhdHMnLCBBY2hpZXZlbWVudFN0YXRzKTsgfSxcbiAgICBzYXZlU3RhdGUoKSB7IFNhdmVTeXN0ZW0uc2V0KCdhY2h2X3N0YXRlJywgQWNoaWV2ZW1lbnRTdGF0ZSk7IH0sXG4gICAgcmVzZXRBbGwoKSB7XG4gICAgICAgIE9iamVjdC5rZXlzKEFDSElFVkVNRU5UX1NUQVRTX0RFRkFVTFRTKS5mb3JFYWNoKGsgPT4ge1xuICAgICAgICAgICAgY29uc3QgZCA9IEFDSElFVkVNRU5UX1NUQVRTX0RFRkFVTFRTW2tdO1xuICAgICAgICAgICAgQWNoaWV2ZW1lbnRTdGF0c1trXSA9IEFycmF5LmlzQXJyYXkoZCkgPyBbXSA6IChkICYmIHR5cGVvZiBkID09PSAnb2JqZWN0JyA/IHt9IDogZCk7XG4gICAgICAgIH0pO1xuICAgICAgICBPYmplY3Qua2V5cyhBY2hpZXZlbWVudFN0YXRlKS5mb3JFYWNoKGsgPT4gZGVsZXRlIEFjaGlldmVtZW50U3RhdGVba10pO1xuICAgICAgICB0aGlzLnNhdmVTdGF0cygpO1xuICAgICAgICB0aGlzLnNhdmVTdGF0ZSgpO1xuICAgICAgICBpZiAodHlwZW9mIGdhbWUucmVuZGVyQWNoaWV2ZW1lbnRzID09PSAnZnVuY3Rpb24nKSBnYW1lLnJlbmRlckFjaGlldmVtZW50cygpO1xuICAgIH1cbn07XG5cbmNvbnN0IF9hY2hPcmlnSGl0RW5lbXkgPSBnYW1lLmhpdEVuZW15O1xuZ2FtZS5oaXRFbmVteSA9IGZ1bmN0aW9uKGUsIGRtZywgLi4ucmVzdCkge1xuICAgIGNvbnN0IHdhc0FsaXZlID0gIWUuaXNEeWluZztcbiAgICBjb25zdCB3YXNCb3NzID0gZS50eXBlID09PSAnQk9TUyc7XG4gICAgY29uc3QgYm9zc1dhdmUgPSBlLmJvc3NXYXZlO1xuICAgIGNvbnN0IHdlYXBvbiA9IHRoaXMucGxheWVyICYmIHRoaXMucGxheWVyLndlYXBvbjtcbiAgICBjb25zdCBtb25leUJlZm9yZSA9IHRoaXMucGxheWVyID8gdGhpcy5wbGF5ZXIubW9uZXkgOiAwO1xuICAgIF9hY2hPcmlnSGl0RW5lbXkuY2FsbCh0aGlzLCBlLCBkbWcsIC4uLnJlc3QpO1xuICAgIGlmICh3YXNBbGl2ZSAmJiBlLmlzRHlpbmcpIHtcbiAgICAgICAgQWNoaWV2ZW1lbnRTdGF0cy5raWxsU3RyZWFrTm9EZWF0aCsrO1xuICAgICAgICBBY2hpZXZlbWVudFN0YXRzLmJlc3RLaWxsU3RyZWFrID0gTWF0aC5tYXgoQWNoaWV2ZW1lbnRTdGF0cy5iZXN0S2lsbFN0cmVhaywgQWNoaWV2ZW1lbnRTdGF0cy5raWxsU3RyZWFrTm9EZWF0aCk7XG4gICAgICAgIGlmICh3ZWFwb24pIHtcbiAgICAgICAgICAgIGNvbnN0IGNhdCA9IFdFQVBPTl9DQVRFR09SWVt3ZWFwb24ubmFtZV07XG4gICAgICAgICAgICBpZiAoY2F0KSBBY2hpZXZlbWVudFN0YXRzLmNhdGVnb3J5S2lsbHNbY2F0XSA9IChBY2hpZXZlbWVudFN0YXRzLmNhdGVnb3J5S2lsbHNbY2F0XSB8fCAwKSArIDE7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHdhc0Jvc3MpIHtcbiAgICAgICAgICAgIEFjaGlldmVtZW50U3RhdHMuYm9zc0tpbGxzKys7XG4gICAgICAgICAgICBpZiAod2VhcG9uICYmIHdlYXBvbi50eXBlID09PSAnbWVsZWUnKSBBY2hpZXZlbWVudFN0YXRzLm1lbGVlQm9zc0tpbGxzKys7XG4gICAgICAgICAgICBpZiAoYm9zc1dhdmUgJiYgIUFjaGlldmVtZW50U3RhdHMuYm9zc1dhdmVzRGVmZWF0ZWQuaW5jbHVkZXMoYm9zc1dhdmUpKSBBY2hpZXZlbWVudFN0YXRzLmJvc3NXYXZlc0RlZmVhdGVkLnB1c2goYm9zc1dhdmUpO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0aGlzLnBsYXllcikgQWNoaWV2ZW1lbnRTdGF0cy5tb25leUVhcm5lZCArPSBNYXRoLm1heCgwLCB0aGlzLnBsYXllci5tb25leSAtIG1vbmV5QmVmb3JlKTtcbiAgICAgICAgQWNoaWV2ZW1lbnRNYW5hZ2VyLmV2YWx1YXRlKCdraWxsJyk7XG4gICAgfVxufTtcblxuY29uc3QgX2FjaE9yaWdTaG9vdCA9IGdhbWUuc2hvb3Q7XG5nYW1lLnNob290ID0gZnVuY3Rpb24oKSB7XG4gICAgY29uc3QgdyA9IHRoaXMucGxheWVyICYmIHRoaXMucGxheWVyLndlYXBvbjtcbiAgICBjb25zdCBwcmV2TGFzdFNob3QgPSB0aGlzLmxhc3RTaG90O1xuICAgIF9hY2hPcmlnU2hvb3QuY2FsbCh0aGlzKTtcbiAgICBpZiAodyAmJiB0aGlzLmxhc3RTaG90ICE9PSBwcmV2TGFzdFNob3QpIHtcbiAgICAgICAgaWYgKCFBY2hpZXZlbWVudFN0YXRzLndlYXBvbnNVc2VkLmluY2x1ZGVzKHcubmFtZSkpIEFjaGlldmVtZW50U3RhdHMud2VhcG9uc1VzZWQucHVzaCh3Lm5hbWUpO1xuICAgICAgICBBY2hpZXZlbWVudE1hbmFnZXIuZXZhbHVhdGUoJ3Nob290Jyk7XG4gICAgfVxufTtcblxuY29uc3QgX2FjaE9yaWdSZWxvYWQgPSBnYW1lLnJlbG9hZDtcbmdhbWUucmVsb2FkID0gZnVuY3Rpb24oKSB7XG4gICAgY29uc3QgdyA9IHRoaXMucGxheWVyICYmIHRoaXMucGxheWVyLndlYXBvbjtcbiAgICBjb25zdCBiZWZvcmUgPSB3ID8gdy5hbW1vIDogbnVsbDtcbiAgICBfYWNoT3JpZ1JlbG9hZC5jYWxsKHRoaXMpO1xuICAgIGlmICh3ICYmIHcudHlwZSAhPT0gJ21lbGVlJyAmJiBiZWZvcmUgIT09IG51bGwgJiYgYmVmb3JlICE9PSB3LmNhcGFjaXR5KSB7XG4gICAgICAgIEFjaGlldmVtZW50U3RhdHMucmVsb2FkcysrO1xuICAgICAgICBBY2hpZXZlbWVudE1hbmFnZXIuZXZhbHVhdGUoJ3JlbG9hZCcpO1xuICAgIH1cbn07XG5cbmNvbnN0IF9hY2hPcmlnVGFrZURhbWFnZSA9IFBsYXllci5wcm90b3R5cGUudGFrZURhbWFnZTtcblBsYXllci5wcm90b3R5cGUudGFrZURhbWFnZSA9IGZ1bmN0aW9uKGFtdCkge1xuICAgIEFjaGlldmVtZW50TWFuYWdlci5fdG9va0RhbWFnZVRoaXNXYXZlID0gdHJ1ZTtcbiAgICBfYWNoT3JpZ1Rha2VEYW1hZ2UuY2FsbCh0aGlzLCBhbXQpO1xufTtcblxuY29uc3QgX2FjaE9yaWdEYXNoID0gUGxheWVyLnByb3RvdHlwZS5kYXNoO1xuUGxheWVyLnByb3RvdHlwZS5kYXNoID0gZnVuY3Rpb24oKSB7XG4gICAgY29uc3QgYmVmb3JlID0gdGhpcy5pc0Rhc2hpbmc7XG4gICAgX2FjaE9yaWdEYXNoLmNhbGwodGhpcyk7XG4gICAgaWYgKCFiZWZvcmUgJiYgdGhpcy5pc0Rhc2hpbmcpIHsgQWNoaWV2ZW1lbnRTdGF0cy5kYXNoVXNlcysrOyBBY2hpZXZlbWVudE1hbmFnZXIuZXZhbHVhdGUoJ2Rhc2gnKTsgfVxufTtcblxuY29uc3QgX2FjaE9yaWdMb29wID0gZ2FtZS5sb29wO1xuZ2FtZS5sb29wID0gZnVuY3Rpb24oKSB7XG4gICAgY29uc3Qgd2F2ZUJlZm9yZSA9IHRoaXMud2F2ZTtcbiAgICBjb25zdCBldmVudEJlZm9yZSA9IHRoaXMuYWN0aXZlRXZlbnQ7XG4gICAgX2FjaE9yaWdMb29wLmNhbGwodGhpcyk7XG4gICAgaWYgKHRoaXMud2F2ZSAhPT0gd2F2ZUJlZm9yZSkgQWNoaWV2ZW1lbnRNYW5hZ2VyLm9uV2F2ZUNsZWFyKHdhdmVCZWZvcmUsIGV2ZW50QmVmb3JlKTtcbn07XG5cbmNvbnN0IF9hY2hPcmlnU2hvd0xldmVsVXAgPSBnYW1lLnNob3dMZXZlbFVwO1xuZ2FtZS5zaG93TGV2ZWxVcCA9IGZ1bmN0aW9uKGxldmVsKSB7XG4gICAgX2FjaE9yaWdTaG93TGV2ZWxVcC5jYWxsKHRoaXMsIGxldmVsKTtcbiAgICBBY2hpZXZlbWVudE1hbmFnZXIuZXZhbHVhdGUoJ2xldmVsVXAnKTtcbn07XG5cbmNvbnN0IF9hY2hPcmlnR2FtZU92ZXIgPSBnYW1lLmdhbWVPdmVyO1xuZ2FtZS5nYW1lT3ZlciA9IGZ1bmN0aW9uKCkge1xuICAgIF9hY2hPcmlnR2FtZU92ZXIuY2FsbCh0aGlzKTtcbiAgICBBY2hpZXZlbWVudFN0YXRzLmtpbGxTdHJlYWtOb0RlYXRoID0gMDtcbiAgICBBY2hpZXZlbWVudE1hbmFnZXIuZXZhbHVhdGUoJ2RlYXRoJyk7XG4gICAgQWNoaWV2ZW1lbnRNYW5hZ2VyLnNhdmVTdGF0cygpO1xufTtcblxuY29uc3QgX2FjaE9yaWdCdXlXZWFwb24gPSBnYW1lLmJ1eVdlYXBvbjtcbmdhbWUuYnV5V2VhcG9uID0gZnVuY3Rpb24oaykge1xuICAgIGNvbnN0IGJlZm9yZSA9IHRoaXMucGxheWVyLmludmVudG9yeS5zb21lKHMgPT4gcyAmJiBzLm5hbWUgPT09IGspO1xuICAgIF9hY2hPcmlnQnV5V2VhcG9uLmNhbGwodGhpcywgayk7XG4gICAgY29uc3QgYWZ0ZXIgPSB0aGlzLnBsYXllci5pbnZlbnRvcnkuc29tZShzID0+IHMgJiYgcy5uYW1lID09PSBrKTtcbiAgICBpZiAoIWJlZm9yZSAmJiBhZnRlcikge1xuICAgICAgICBBY2hpZXZlbWVudFN0YXRzLndlYXBvbnNQdXJjaGFzZWQrKztcbiAgICAgICAgY29uc3QgY2F0ID0gV0VBUE9OX0NBVEVHT1JZW2tdO1xuICAgICAgICBpZiAoY2F0ID09PSAnaGVhdnknIHx8IGNhdCA9PT0gJ3NwZWNpYWwnKSBBY2hpZXZlbWVudFN0YXRzLmhlYXZ5V2VhcG9uUHVyY2hhc2VkID0gdHJ1ZTtcbiAgICAgICAgQWNoaWV2ZW1lbnRNYW5hZ2VyLmV2YWx1YXRlKCdidXlXZWFwb24nKTtcbiAgICAgICAgQWNoaWV2ZW1lbnRNYW5hZ2VyLnNhdmVTdGF0cygpO1xuICAgIH1cbn07XG5jb25zdCBfYWNoT3JpZ1NlbGxXZWFwb24gPSBnYW1lLnNlbGxXZWFwb247XG5nYW1lLnNlbGxXZWFwb24gPSBmdW5jdGlvbihrKSB7XG4gICAgX2FjaE9yaWdTZWxsV2VhcG9uLmNhbGwodGhpcywgayk7XG4gICAgQWNoaWV2ZW1lbnRTdGF0cy53ZWFwb25zU29sZCsrO1xuICAgIEFjaGlldmVtZW50TWFuYWdlci5ldmFsdWF0ZSgnc2VsbFdlYXBvbicpO1xuICAgIEFjaGlldmVtZW50TWFuYWdlci5zYXZlU3RhdHMoKTtcbn07XG5cbmNvbnN0IF9hY2hPcmlnQnV5SGVhbHRoID0gZ2FtZS5idXlIZWFsdGg7XG5nYW1lLmJ1eUhlYWx0aCA9IGZ1bmN0aW9uKCkge1xuICAgIGNvbnN0IGJlZm9yZSA9IHRoaXMucGxheWVyLm1vbmV5O1xuICAgIF9hY2hPcmlnQnV5SGVhbHRoLmNhbGwodGhpcyk7XG4gICAgaWYgKHRoaXMucGxheWVyLm1vbmV5IDwgYmVmb3JlKSB7IEFjaGlldmVtZW50U3RhdHMuaGVhbHRoUGFja1VzZXMrKzsgQWNoaWV2ZW1lbnRNYW5hZ2VyLmV2YWx1YXRlKCdoZWFsdGhCdXknKTsgfVxufTtcblxuY29uc3QgX2FjaE9yaWdQcm9nQnV5ID0gUHJvZ3Jlc3Npb24uYnV5O1xuUHJvZ3Jlc3Npb24uYnV5ID0gZnVuY3Rpb24oaykge1xuICAgIGNvbnN0IHJlc3VsdCA9IF9hY2hPcmlnUHJvZ0J1eS5jYWxsKHRoaXMsIGspO1xuICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgQWNoaWV2ZW1lbnRTdGF0cy51cGdyYWRlc0J1eXMrKztcbiAgICAgICAgaWYgKCFBY2hpZXZlbWVudFN0YXRzLnVwZ3JhZGVzVG91Y2hlZC5pbmNsdWRlcyhrKSkgQWNoaWV2ZW1lbnRTdGF0cy51cGdyYWRlc1RvdWNoZWQucHVzaChrKTtcbiAgICAgICAgQWNoaWV2ZW1lbnRNYW5hZ2VyLmV2YWx1YXRlKCd1cGdyYWRlQnV5Jyk7XG4gICAgICAgIEFjaGlldmVtZW50TWFuYWdlci5zYXZlU3RhdHMoKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbn07XG5cbmNvbnN0IF9hY2hPcmlnSW5pdCA9IGdhbWUuaW5pdDtcbmdhbWUuaW5pdCA9IGZ1bmN0aW9uKCkge1xuICAgIF9hY2hPcmlnSW5pdC5jYWxsKHRoaXMpO1xuICAgIGlmIChBY2hpZXZlbWVudFN0YXRzLnBlbmRpbmdNb25leSkge1xuICAgICAgICB0aGlzLnBsYXllci5tb25leSArPSBBY2hpZXZlbWVudFN0YXRzLnBlbmRpbmdNb25leTtcbiAgICAgICAgQWNoaWV2ZW1lbnRTdGF0cy5wZW5kaW5nTW9uZXkgPSAwO1xuICAgICAgICBBY2hpZXZlbWVudE1hbmFnZXIuc2F2ZVN0YXRzKCk7XG4gICAgfVxufTtcblxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2JlZm9yZXVubG9hZCcsICgpID0+IEFjaGlldmVtZW50TWFuYWdlci5zYXZlU3RhdHMoKSk7XG5cblNhdmVTeXN0ZW0ub25SZW1vdGVEYXRhKGZ1bmN0aW9uKGtleXMpIHtcbiAgICBsZXQgY2hhbmdlZCA9IGZhbHNlO1xuICAgIGlmIChrZXlzLmluY2x1ZGVzKCdhY2h2X3N0YXRzJykpIHsgT2JqZWN0LmFzc2lnbihBY2hpZXZlbWVudFN0YXRzLCBTYXZlU3lzdGVtLmdldCgnYWNodl9zdGF0cycsIHt9KSk7IGNoYW5nZWQgPSB0cnVlOyB9XG4gICAgaWYgKGtleXMuaW5jbHVkZXMoJ2FjaHZfc3RhdGUnKSkgeyBPYmplY3QuYXNzaWduKEFjaGlldmVtZW50U3RhdGUsIFNhdmVTeXN0ZW0uZ2V0KCdhY2h2X3N0YXRlJywge30pKTsgY2hhbmdlZCA9IHRydWU7IH1cbiAgICBpZiAoY2hhbmdlZCAmJiB0eXBlb2YgZ2FtZS5yZW5kZXJBY2hpZXZlbWVudHMgPT09ICdmdW5jdGlvbicpIGdhbWUucmVuZGVyQWNoaWV2ZW1lbnRzKCk7XG59KTtcblxuY29uc3QgX2FjaE9yaWdPcGVuUHJvZmlsZSA9IGdhbWUub3BlblByb2ZpbGU7XG5nYW1lLm9wZW5Qcm9maWxlID0gZnVuY3Rpb24oKSB7XG4gICAgX2FjaE9yaWdPcGVuUHJvZmlsZS5jYWxsKHRoaXMpO1xuICAgIGdhbWUuc2V0UHJvZmlsZVRhYignc3RhdHMnKTtcbn07XG5cbmdhbWUuc2V0UHJvZmlsZVRhYiA9IGZ1bmN0aW9uKHRhYikge1xuICAgIGNvbnN0IHN0YXRzVGFiID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGUtdGFiLXN0YXRzJyk7XG4gICAgY29uc3QgYWNodlRhYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlLXRhYi1hY2h2Jyk7XG4gICAgY29uc3QgYnRuU3RhdHMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGFiLWJ0bi1zdGF0cycpO1xuICAgIGNvbnN0IGJ0bkFjaHYgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGFiLWJ0bi1hY2h2Jyk7XG4gICAgaWYgKCFzdGF0c1RhYiB8fCAhYWNodlRhYikgcmV0dXJuO1xuICAgIHN0YXRzVGFiLnN0eWxlLmRpc3BsYXkgPSB0YWIgPT09ICdzdGF0cycgPyAnYmxvY2snIDogJ25vbmUnO1xuICAgIGFjaHZUYWIuc3R5bGUuZGlzcGxheSA9IHRhYiA9PT0gJ2FjaHYnID8gJ2Jsb2NrJyA6ICdub25lJztcbiAgICBpZiAoYnRuU3RhdHMpIGJ0blN0YXRzLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIHRhYiA9PT0gJ3N0YXRzJyk7XG4gICAgaWYgKGJ0bkFjaHYpIGJ0bkFjaHYuY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgdGFiID09PSAnYWNodicpO1xuICAgIGlmICh0YWIgPT09ICdhY2h2JykgZ2FtZS5yZW5kZXJBY2hpZXZlbWVudHMoKTtcbn07XG5cbmdhbWUuY2xhaW1BY2hpZXZlbWVudCA9IGZ1bmN0aW9uKGlkKSB7XG4gICAgaWYgKEFjaGlldmVtZW50TWFuYWdlci5jbGFpbShpZCkpIHsgcGxheVNGWCgnY29pbicpOyBnYW1lLnJlbmRlckFjaGlldmVtZW50cygpOyB9XG59O1xuXG5nYW1lLnJlbmRlckFjaGlldmVtZW50cyA9IGZ1bmN0aW9uKCkge1xuICAgIGNvbnN0IGxpc3RFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhY2h2LWxpc3QnKTtcbiAgICBjb25zdCBzdW1tYXJ5RWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYWNodi1zdW1tYXJ5Jyk7XG4gICAgaWYgKCFsaXN0RWwpIHJldHVybjtcbiAgICBjb25zdCBzZWFyY2hFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhY2h2LXNlYXJjaCcpO1xuICAgIGNvbnN0IGNhdEVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FjaHYtY2F0ZWdvcnktZmlsdGVyJyk7XG4gICAgY29uc3Qgc3RhdHVzRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYWNodi1zdGF0dXMtZmlsdGVyJyk7XG4gICAgY29uc3Qgc2VhcmNoID0gc2VhcmNoRWwgPyBzZWFyY2hFbC52YWx1ZS50cmltKCkudG9Mb3dlckNhc2UoKSA6ICcnO1xuICAgIGNvbnN0IGNhdEZpbHRlciA9IGNhdEVsID8gY2F0RWwudmFsdWUgOiAnQUxMJztcbiAgICBjb25zdCBzdGF0dXNGaWx0ZXIgPSBzdGF0dXNFbCA/IHN0YXR1c0VsLnZhbHVlIDogJ0FMTCc7XG5cbiAgICBsZXQgdG90YWwgPSAwLCBjb21wbGV0ZWRDb3VudCA9IDA7XG4gICAgY29uc3QgY2FyZHMgPSBbXTtcbiAgICBPYmplY3QudmFsdWVzKEFDSElFVkVNRU5UU19EQikuZm9yRWFjaChkZWYgPT4ge1xuICAgICAgICB0b3RhbCsrO1xuICAgICAgICBjb25zdCB2YWx1ZSA9IGRlZi5nZXRWYWx1ZSgpO1xuICAgICAgICBjb25zdCBpc0NvbXBsZXRlZCA9IHZhbHVlID49IGRlZi50YXJnZXQ7XG4gICAgICAgIGlmIChpc0NvbXBsZXRlZCkgY29tcGxldGVkQ291bnQrKztcbiAgICAgICAgY29uc3Qgc3RhdGUgPSBBY2hpZXZlbWVudE1hbmFnZXIuZ2V0U3RhdGUoZGVmLmlkKTtcblxuICAgICAgICBpZiAoY2F0RmlsdGVyICE9PSAnQUxMJyAmJiBkZWYuY2F0ZWdvcnkgIT09IGNhdEZpbHRlcikgcmV0dXJuO1xuICAgICAgICBpZiAoc3RhdHVzRmlsdGVyID09PSAnQ09NUExFVEVEJyAmJiAhaXNDb21wbGV0ZWQpIHJldHVybjtcbiAgICAgICAgaWYgKHN0YXR1c0ZpbHRlciA9PT0gJ1VOQ0xBSU1FRCcgJiYgIShpc0NvbXBsZXRlZCAmJiAhc3RhdGUuY2xhaW1lZCkpIHJldHVybjtcbiAgICAgICAgaWYgKHN0YXR1c0ZpbHRlciA9PT0gJ0xPQ0tFRCcgJiYgaXNDb21wbGV0ZWQpIHJldHVybjtcblxuICAgICAgICBjb25zdCBzaG93SGlkZGVuID0gZGVmLmhpZGRlbiAmJiAhaXNDb21wbGV0ZWQ7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBzaG93SGlkZGVuID8gJz8/PycgOiBkZWYubmFtZTtcbiAgICAgICAgY29uc3QgZGVzYyA9IHNob3dIaWRkZW4gPyAnTG9ncm8gc2VjcmV0by4gRGVzY1x1MDBGQWJyZWxvIGp1Z2FuZG8uJyA6IGRlZi5kZXNjO1xuICAgICAgICBpZiAoc2VhcmNoICYmICFuYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKSAmJiAhZGVzYy50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHNlYXJjaCkpIHJldHVybjtcblxuICAgICAgICBjb25zdCByYXJpdHkgPSBSQVJJVFlbZGVmLnJhcml0eV07XG4gICAgICAgIGNvbnN0IHBjdCA9IE1hdGgubWluKDEwMCwgTWF0aC5mbG9vcih2YWx1ZSAvIGRlZi50YXJnZXQgKiAxMDApKTtcbiAgICAgICAgY29uc3QgY2FyZENsYXNzZXMgPSBbJ2FjaHYtY2FyZCddO1xuICAgICAgICBpZiAoaXNDb21wbGV0ZWQpIGNhcmRDbGFzc2VzLnB1c2goJ2NvbXBsZXRlZCcpO1xuICAgICAgICBpZiAoaXNDb21wbGV0ZWQgJiYgZGVmLnJhcml0eSA9PT0gJ0xFR0VOREFSSU8nKSBjYXJkQ2xhc3Nlcy5wdXNoKCdsZWdlbmRhcnktZ2xvdycpO1xuXG4gICAgICAgIGxldCBhY3Rpb25IdG1sO1xuICAgICAgICBpZiAoc3RhdGUuY2xhaW1lZCkgYWN0aW9uSHRtbCA9ICc8c3BhbiBjbGFzcz1cImFjaHYtY2xhaW1lZFwiPlJFQ0xBTUFETzwvc3Bhbj4nO1xuICAgICAgICBlbHNlIGlmIChpc0NvbXBsZXRlZCkgYWN0aW9uSHRtbCA9IGA8YnV0dG9uIGNsYXNzPVwiYnV5LWJ0blwiIG9uY2xpY2s9XCJnYW1lLmNsYWltQWNoaWV2ZW1lbnQoJyR7ZGVmLmlkfScpXCI+UkVDTEFNQVI8L2J1dHRvbj5gO1xuICAgICAgICBlbHNlIGFjdGlvbkh0bWwgPSAnPHNwYW4gY2xhc3M9XCJhY2h2LWxvY2tlZFwiPlx1RDgzRFx1REQxMjwvc3Bhbj4nO1xuXG4gICAgICAgIGNhcmRzLnB1c2goYDxkaXYgY2xhc3M9XCIke2NhcmRDbGFzc2VzLmpvaW4oJyAnKX1cIiBzdHlsZT1cIi0tcmFyaXR5LWNvbG9yOiR7cmFyaXR5LmNvbG9yfVwiPlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cImFjaHYtaWNvblwiPiR7c2hvd0hpZGRlbiA/ICdcdTI3NTMnIDogZGVmLmljb259PC9kaXY+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwiYWNodi1pbmZvXCI+XG4gICAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cImFjaHYtbmFtZVwiPiR7bmFtZX0gPHNwYW4gY2xhc3M9XCJhY2h2LXJhcml0eVwiIHN0eWxlPVwiY29sb3I6JHtyYXJpdHkuY29sb3J9XCI+JHtyYXJpdHkubGFiZWx9PC9zcGFuPjwvZGl2PlxuICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJhY2h2LWRlc2NcIj4ke2Rlc2N9PC9kaXY+XG4gICAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cImFjaHYtcHJvZ3Jlc3MtYmFyXCI+PGRpdiBjbGFzcz1cImFjaHYtcHJvZ3Jlc3MtaW5uZXJcIiBzdHlsZT1cIndpZHRoOiR7cGN0fSU7IGJhY2tncm91bmQ6JHtyYXJpdHkuY29sb3J9XCI+PC9kaXY+PC9kaXY+XG4gICAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cImFjaHYtcHJvZ3Jlc3MtdGV4dFwiPiR7TWF0aC5taW4odmFsdWUsIGRlZi50YXJnZXQpfSAvICR7ZGVmLnRhcmdldH0gXHUyMDE0ICR7cGN0fSU8L2Rpdj5cbiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwiYWNodi1yZXdhcmRcIj5cdUQ4M0NcdURGODEgJHtkZWYucmV3YXJkLmxhYmVsIHx8ICdSZWNvbXBlbnNhIGNvc21cdTAwRTl0aWNhJ308L2Rpdj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cImFjaHYtYWN0aW9uXCI+JHthY3Rpb25IdG1sfTwvZGl2PlxuICAgICAgICA8L2Rpdj5gKTtcbiAgICB9KTtcblxuICAgIGxpc3RFbC5pbm5lckhUTUwgPSBjYXJkcy5qb2luKCcnKSB8fCAnPHAgc3R5bGU9XCJjb2xvcjojODg4O1wiPk5vIGhheSBsb2dyb3MgcXVlIGNvaW5jaWRhbiBjb24gZWwgZmlsdHJvLjwvcD4nO1xuICAgIGlmIChzdW1tYXJ5RWwpIHN1bW1hcnlFbC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cImh1ZC10ZXh0XCI+UHJvZ3Jlc28gdG90YWw6ICR7Y29tcGxldGVkQ291bnR9IC8gJHt0b3RhbH0gKCR7TWF0aC5mbG9vcihjb21wbGV0ZWRDb3VudCAvIHRvdGFsICogMTAwKX0lKTwvZGl2PmA7XG59O1xuXG53aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignRE9NQ29udGVudExvYWRlZCcsICgpID0+IHtcbiAgICBjb25zdCBjYXRTZWxlY3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYWNodi1jYXRlZ29yeS1maWx0ZXInKTtcbiAgICBpZiAoY2F0U2VsZWN0KSB7XG4gICAgICAgIE9iamVjdC5lbnRyaWVzKEFDSElFVkVNRU5UX0NBVEVHT1JJRVMpLmZvckVhY2goKFtrZXksIGxhYmVsXSkgPT4ge1xuICAgICAgICAgICAgY29uc3Qgb3B0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgICAgICBvcHQudmFsdWUgPSBrZXk7IG9wdC50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICAgICAgY2F0U2VsZWN0LmFwcGVuZENoaWxkKG9wdCk7XG4gICAgICAgIH0pO1xuICAgIH1cbn0pO1xuXG4vLyMgc291cmNlVVJMPWFjaGlldmVtZW50cy5qc1xuXG4vKiA9PT09PT09PT09PT09PT09PSBhdXRoLXVpLmpzID09PT09PT09PT09PT09PT09ICovXG4vKipcbiAqIEFVVEgtVUkuanNcbiAqIENhcGEgZmluYSBkZSBpbnRlcmZheiBwYXJhIGluaWNpYXIvY2VycmFyIHNlc2lcdTAwRjNuIGRlc2RlIGVsIGxvYmJ5LlxuICogQSBwcm9wXHUwMEYzc2l0byBOTyBjb25vY2UgbmFkYSBkZSBGaXJlYmFzZTogc29sbyBsbGFtYSBhIGxvcyBtXHUwMEU5dG9kb3MgcFx1MDBGQWJsaWNvcyBxdWVcbiAqIGV4cG9uZSBTYXZlU3lzdGVtIChzaWduSW5XaXRoR29vZ2xlIC8gc2lnbk91dCAvIGN1cnJlbnRVc2VyKSwgZGVmaW5pZG9zIGVuXG4gKiBGaXJlYmFzZVNhdmVTeXN0ZW0uanMsIHkgcmVhY2Npb25hIGEgbG9zIGV2ZW50b3MgJ3NhdmVzeXN0ZW06bG9naW4nIC9cbiAqICdzYXZlc3lzdGVtOmxvZ291dCcgcXVlIGVzZSBtXHUwMEYzZHVsbyBkaXNwYXJhIHNvYnJlIGBkb2N1bWVudGAuXG4gKlxuICogRGViZSBjYXJnYXJzZSBERVNQVVx1MDBDOVMgZGUgRmlyZWJhc2VTYXZlU3lzdGVtLmpzICh1c2EgU2F2ZVN5c3RlbSkgeSBkZXNwdVx1MDBFOXMgZGVcbiAqIG1haW4uanMgKGVsIGJvdFx1MDBGM24gdml2ZSBkZW50cm8gZGVsIGlubmVySFRNTCBkZWwgbG9iYnkgcXVlIGFybWEgbWFpbi5qcykuXG4gKi9cbmNvbnN0IEF1dGhVSSA9IHtcbiAgICBoYW5kbGVDbGljaygpIHtcbiAgICAgICAgaWYgKFNhdmVTeXN0ZW0uY3VycmVudFVzZXIpIFNhdmVTeXN0ZW0uc2lnbk91dCgpO1xuICAgICAgICBlbHNlIFNhdmVTeXN0ZW0uc2lnbkluV2l0aEdvb2dsZSgpO1xuICAgIH0sXG5cbiAgICBjdXJyZW50TGFiZWwoKSB7XG4gICAgICAgIGNvbnN0IHUgPSBTYXZlU3lzdGVtLmN1cnJlbnRVc2VyO1xuICAgICAgICByZXR1cm4gdSA/ICh1LmRpc3BsYXlOYW1lIHx8IHUuZW1haWwgfHwgJ0N1ZW50YSBjb25lY3RhZGEnKSA6ICdJbnZpdGFkbyAobG9jYWwpJztcbiAgICB9LFxuXG4gICAgLy8gUmVwaW50YSBlbCBib3RcdTAwRjNuL2VzdGFkbyBkZWwgbG9iYnkgY29uIGVsIGVzdGFkbyBhY3R1YWwgZGUgc2VzaVx1MDBGM24uIFNlIGxsYW1hOlxuICAgIC8vIC0gYWwgY2FyZ2FyIGxhIHBcdTAwRTFnaW5hIChwb3Igc2kgRmlyZWJhc2UgeWEgdGVuXHUwMEVEYSBzZXNpXHUwMEYzbiBndWFyZGFkYSlcbiAgICAvLyAtIGNhZGEgdmV6IHF1ZSBtYWluLmpzIHJlY29uc3RydXllIGVsIGlubmVySFRNTCBkZWwgbG9iYnlcbiAgICAvLyAtIGVuIGxvcyBldmVudG9zIHNhdmVzeXN0ZW06bG9naW4gLyBzYXZlc3lzdGVtOmxvZ291dFxuICAgIHJlZnJlc2goKSB7XG4gICAgICAgIGNvbnN0IHN0YXR1c0VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2F1dGgtc3RhdHVzJyk7XG4gICAgICAgIGNvbnN0IGJ0bkVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2F1dGgtYnRuJyk7XG4gICAgICAgIGlmICghc3RhdHVzRWwgfHwgIWJ0bkVsKSByZXR1cm47XG4gICAgICAgIGNvbnN0IHUgPSBTYXZlU3lzdGVtLmN1cnJlbnRVc2VyO1xuICAgICAgICBpZiAodSkge1xuICAgICAgICAgICAgc3RhdHVzRWwuaW5uZXJUZXh0ID0gYFx1MjcwNSBDb25lY3RhZG8gY29tbyAke3UuZGlzcGxheU5hbWUgfHwgdS5lbWFpbH1gO1xuICAgICAgICAgICAgYnRuRWwuaW5uZXJUZXh0ID0gJ1x1RDgzRFx1REVBQSBDRVJSQVIgU0VTSVx1MDBEM04nO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3RhdHVzRWwuaW5uZXJUZXh0ID0gJ1x1RDgzRFx1REM2NCBJbnZpdGFkbyBcdTIwMTQgdHUgcHJvZ3Jlc28gc29sbyBzZSBndWFyZGEgZW4gZXN0ZSBkaXNwb3NpdGl2byc7XG4gICAgICAgICAgICBidG5FbC5pbm5lclRleHQgPSAnXHVEODNEXHVERDExIElOSUNJQVIgU0VTSVx1MDBEM04gQ09OIEdPT0dMRSc7XG4gICAgICAgIH1cbiAgICB9XG59O1xuXG5kb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdzYXZlc3lzdGVtOmxvZ2luJywgKCkgPT4gQXV0aFVJLnJlZnJlc2goKSk7XG5kb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdzYXZlc3lzdGVtOmxvZ291dCcsICgpID0+IEF1dGhVSS5yZWZyZXNoKCkpO1xud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ0RPTUNvbnRlbnRMb2FkZWQnLCAoKSA9PiBBdXRoVUkucmVmcmVzaCgpKTtcblxuLy8jIHNvdXJjZVVSTD1hdXRoLXVpLmpzXG5cbi8qID09PT09PT09PT09PT09PT09IG1vYmlsZS5qcyA9PT09PT09PT09PT09PT09PSAqL1xuLyoqXHJcbiAqIENPTlRST0xFUyBUXHUwMEMxQ1RJTEVTIChzb2xvIHNlIGFjdGl2YW4gZW4gZGlzcG9zaXRpdm9zIGNvbiBwYW50YWxsYSB0XHUwMEUxY3RpbCxcclxuICogZW4gUEMgZXN0byBubyBoYWNlIG5hZGEgeSBsb3MgY29udHJvbGVzIHNpZ3VlbiBzaWVuZG8gdGVjbGFkbyArIG1vdXNlKVxyXG4gKi9cclxuY29uc3QgaXNUb3VjaERldmljZSA9IHdpbmRvdy5tYXRjaE1lZGlhKCcocG9pbnRlcjogY29hcnNlKScpLm1hdGNoZXM7XHJcblxyXG5pZiAoaXNUb3VjaERldmljZSkge1xyXG4gICAgY29uc3Qgam95c3RpY2tab25lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pveXN0aWNrLXpvbmUnKTtcclxuICAgIGNvbnN0IGpveXN0aWNrS25vYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb3lzdGljay1rbm9iJyk7XHJcbiAgICBjb25zdCBhaW1ab25lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FpbS16b25lJyk7XHJcbiAgICBsZXQgam95c3RpY2tUb3VjaElkID0gbnVsbDtcclxuICAgIGxldCBhaW1Ub3VjaElkID0gbnVsbDtcclxuXHJcbiAgICBmdW5jdGlvbiB1cGRhdGVKb3lzdGljayh0b3VjaCkge1xyXG4gICAgICAgIGNvbnN0IHJlY3QgPSBqb3lzdGlja1pvbmUuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICAgICAgY29uc3QgY3ggPSByZWN0LmxlZnQgKyByZWN0LndpZHRoIC8gMjtcclxuICAgICAgICBjb25zdCBjeSA9IHJlY3QudG9wICsgcmVjdC5oZWlnaHQgLyAyO1xyXG4gICAgICAgIGxldCBkeCA9IHRvdWNoLmNsaWVudFggLSBjeDtcclxuICAgICAgICBsZXQgZHkgPSB0b3VjaC5jbGllbnRZIC0gY3k7XHJcbiAgICAgICAgY29uc3QgbWF4RGlzdCA9IHJlY3Qud2lkdGggLyAyO1xyXG4gICAgICAgIGNvbnN0IGRpc3QgPSBNYXRoLm1pbihNYXRoLmh5cG90KGR4LCBkeSksIG1heERpc3QpO1xyXG4gICAgICAgIGNvbnN0IGFuZ2xlID0gTWF0aC5hdGFuMihkeSwgZHgpO1xyXG4gICAgICAgIGNvbnN0IGt4ID0gTWF0aC5jb3MoYW5nbGUpICogZGlzdDtcclxuICAgICAgICBjb25zdCBreSA9IE1hdGguc2luKGFuZ2xlKSAqIGRpc3Q7XHJcbiAgICAgICAgam95c3RpY2tLbm9iLnN0eWxlLnRyYW5zZm9ybSA9IGB0cmFuc2xhdGUoJHtreH1weCwgJHtreX1weClgO1xyXG5cclxuICAgICAgICAvLyBUcmFkdWNpbW9zIGxhIHBvc2ljaVx1MDBGM24gZGVsIGpveXN0aWNrIGEgbGFzIG1pc21hcyB0ZWNsYXMgcXVlIHVzYSBlbCBqdWVnbyAoV0FTRClcclxuICAgICAgICBjb25zdCB0aHJlc2hvbGQgPSBtYXhEaXN0ICogMC4yNTtcclxuICAgICAgICBnYW1lLmtleXNbJ0tleVcnXSA9IGt5IDwgLXRocmVzaG9sZDtcclxuICAgICAgICBnYW1lLmtleXNbJ0tleVMnXSA9IGt5ID4gdGhyZXNob2xkO1xyXG4gICAgICAgIGdhbWUua2V5c1snS2V5QSddID0ga3ggPCAtdGhyZXNob2xkO1xyXG4gICAgICAgIGdhbWUua2V5c1snS2V5RCddID0ga3ggPiB0aHJlc2hvbGQ7XHJcbiAgICB9XHJcblxyXG4gICAgZnVuY3Rpb24gcmVzZXRKb3lzdGljaygpIHtcclxuICAgICAgICBqb3lzdGlja0tub2Iuc3R5bGUudHJhbnNmb3JtID0gJ3RyYW5zbGF0ZSgwcHgsIDBweCknO1xyXG4gICAgICAgIGdhbWUua2V5c1snS2V5VyddID0gZ2FtZS5rZXlzWydLZXlTJ10gPSBnYW1lLmtleXNbJ0tleUEnXSA9IGdhbWUua2V5c1snS2V5RCddID0gZmFsc2U7XHJcbiAgICB9XHJcblxyXG4gICAgam95c3RpY2tab25lLmFkZEV2ZW50TGlzdGVuZXIoJ3RvdWNoc3RhcnQnLCBlID0+IHtcclxuICAgICAgICBpZiAoZ2FtZS5wYXVzZWQpIHJldHVybjtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgam95c3RpY2tUb3VjaElkID0gZS5jaGFuZ2VkVG91Y2hlc1swXS5pZGVudGlmaWVyO1xyXG4gICAgICAgIHVwZGF0ZUpveXN0aWNrKGUuY2hhbmdlZFRvdWNoZXNbMF0pO1xyXG4gICAgfSk7XHJcbiAgICBqb3lzdGlja1pvbmUuYWRkRXZlbnRMaXN0ZW5lcigndG91Y2htb3ZlJywgZSA9PiB7XHJcbiAgICAgICAgaWYgKGdhbWUucGF1c2VkKSByZXR1cm47XHJcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgIGZvciAoY29uc3QgdCBvZiBlLmNoYW5nZWRUb3VjaGVzKSBpZiAodC5pZGVudGlmaWVyID09PSBqb3lzdGlja1RvdWNoSWQpIHVwZGF0ZUpveXN0aWNrKHQpO1xyXG4gICAgfSk7XHJcbiAgICBqb3lzdGlja1pvbmUuYWRkRXZlbnRMaXN0ZW5lcigndG91Y2hlbmQnLCBlID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IHQgb2YgZS5jaGFuZ2VkVG91Y2hlcykgaWYgKHQuaWRlbnRpZmllciA9PT0gam95c3RpY2tUb3VjaElkKSB7IGpveXN0aWNrVG91Y2hJZCA9IG51bGw7IHJlc2V0Sm95c3RpY2soKTsgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gWm9uYSBkZXJlY2hhOiBhcnJhc3RyYXIgcGFyYSBhcHVudGFyLCBtaWVudHJhcyBzZSB0b2NhIHNlIGRpc3BhcmFcclxuICAgIGFpbVpvbmUuYWRkRXZlbnRMaXN0ZW5lcigndG91Y2hzdGFydCcsIGUgPT4ge1xyXG4gICAgICAgIGlmIChnYW1lLnBhdXNlZCkgcmV0dXJuO1xyXG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgICBjb25zdCB0ID0gZS5jaGFuZ2VkVG91Y2hlc1swXTtcclxuICAgICAgICBhaW1Ub3VjaElkID0gdC5pZGVudGlmaWVyO1xyXG4gICAgICAgIGdhbWUubW91c2UueCA9IHQuY2xpZW50WDsgZ2FtZS5tb3VzZS55ID0gdC5jbGllbnRZO1xyXG4gICAgICAgIGdhbWUubW91c2UuZG93biA9IHRydWU7XHJcbiAgICB9KTtcclxuICAgIGFpbVpvbmUuYWRkRXZlbnRMaXN0ZW5lcigndG91Y2htb3ZlJywgZSA9PiB7XHJcbiAgICAgICAgaWYgKGdhbWUucGF1c2VkKSByZXR1cm47XHJcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgIGZvciAoY29uc3QgdCBvZiBlLmNoYW5nZWRUb3VjaGVzKSBpZiAodC5pZGVudGlmaWVyID09PSBhaW1Ub3VjaElkKSB7IGdhbWUubW91c2UueCA9IHQuY2xpZW50WDsgZ2FtZS5tb3VzZS55ID0gdC5jbGllbnRZOyB9XHJcbiAgICB9KTtcclxuICAgIGFpbVpvbmUuYWRkRXZlbnRMaXN0ZW5lcigndG91Y2hlbmQnLCBlID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IHQgb2YgZS5jaGFuZ2VkVG91Y2hlcykgaWYgKHQuaWRlbnRpZmllciA9PT0gYWltVG91Y2hJZCkgeyBhaW1Ub3VjaElkID0gbnVsbDsgZ2FtZS5tb3VzZS5kb3duID0gZmFsc2U7IH1cclxuICAgIH0pO1xyXG5cclxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtb2JpbGUtZGFzaC1idG4nKS5hZGRFdmVudExpc3RlbmVyKCd0b3VjaHN0YXJ0JywgZSA9PiB7XHJcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgIGlmICghZ2FtZS5wYXVzZWQgJiYgZ2FtZS5wbGF5ZXIpIGdhbWUucGxheWVyLmRhc2goKTtcclxuICAgIH0pO1xyXG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21vYmlsZS1yZWxvYWQtYnRuJykuYWRkRXZlbnRMaXN0ZW5lcigndG91Y2hzdGFydCcsIGUgPT4ge1xyXG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgICBpZiAoIWdhbWUucGF1c2VkKSBnYW1lLnJlbG9hZCgpO1xyXG4gICAgfSk7XHJcbn1cclxuXG4vLyMgc291cmNlVVJMPW1vYmlsZS5qc1xuXG4vKiA9PT09PT09PT09PT09PT09PSBib290LmpzID09PT09PT09PT09PT09PT09ICovXG4vKipcbiAqIEJPT1QuanMgXHUyMDE0IE9ycXVlc3RhZG9yIFx1MDBGQW5pY28gZGVsIGFycmFucXVlIGRlbCBqdWVnby5cbiAqIE9yZGVuIHJlYWw6IGFzc2V0cyAtPiBsb2dpbiAtPiBjbGljayBwYXJhIGVtcGV6YXIgKGRlc2Jsb3F1ZWEgYXVkaW8pIC0+IGxvYmJ5LlxuICogTmluZ1x1MDBGQW4gb3RybyBhcmNoaXZvIGRlYmUgdG9jYXIgI2xvYWRpbmctc2NyZWVuLyNsb2dpbi1zY3JlZW4vI2NsaWNrc3RhcnQtc2NyZWVuLlxuICpcbiAqIE5vdGEgc29icmUgXCJpbVx1MDBFMWdlbmVzXCI6IGVzdGUganVlZ28gbm8gdXNhIGFyY2hpdm9zIGRlIGltYWdlbiAodG9kbyBlbCBhcnRlIHNlXG4gKiBkaWJ1amEgY29uIGNhbnZhcy92ZWN0b3JlcyksIGFzXHUwMEVEIHF1ZSBlc2UgcGFzbyBzZSB0cmFkdWNlIGVuIHByZXBhcmFyXG4gKiB0aXBvZ3JhZlx1MDBFRGEvZ3JcdTAwRTFmaWNvcywgcXVlIGVzIGVsIHJlY3Vyc28gdmlzdWFsIHJlYWwgcXVlIGhhY2UgZmFsdGEgY2FyZ2FyLlxuICovXG5mdW5jdGlvbiB3aXRoVGltZW91dChwcm9taXNlLCBtcykge1xuICAgIHJldHVybiBQcm9taXNlLnJhY2UoW3Byb21pc2UsIG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCBtcykpXSk7XG59XG5cbmNvbnN0IEJvb3RGbG93ID0ge1xuICAgIGFzeW5jIHJ1bigpIHtcbiAgICAgICAgY29uc3QgZmlsbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdib290LXByb2dyZXNzLWZpbGwnKTtcbiAgICAgICAgY29uc3QgcGN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Jvb3QtcHJvZ3Jlc3MtcGN0Jyk7XG4gICAgICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Jvb3QtcHJvZ3Jlc3MtbGFiZWwnKTtcbiAgICAgICAgY29uc3QgbG9hZGluZ1NjcmVlbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2FkaW5nLXNjcmVlbicpO1xuXG4gICAgICAgIGNvbnN0IHN0ZXBzID0gW1xuICAgICAgICAgICAgeyBsYWJlbDogJ0NvbmVjdGFuZG8gY29uIGVsIHNlcnZpZG9yLi4uJywgd2VpZ2h0OiAxLCBydW46IChwKSA9PiB7IHAoMC4yKTsgcmV0dXJuIHdpdGhUaW1lb3V0KFNhdmVTeXN0ZW0ucmVhZHksIDgwMDApLnRoZW4oKCkgPT4gcCgxKSk7IH0gfSxcbiAgICAgICAgICAgIHsgbGFiZWw6ICdTaW5jcm9uaXphbmRvIHByb2dyZXNvLi4uJywgd2VpZ2h0OiAxLCBydW46IChwKSA9PiB7IHAoMSk7IHJldHVybiBQcm9taXNlLnJlc29sdmUoKTsgfSB9LFxuICAgICAgICAgICAgeyBsYWJlbDogJ0NhcmdhbmRvIHNvbmlkb3MuLi4nLCB3ZWlnaHQ6IDMsIHJ1bjogKHApID0+IHByZWxvYWRTRlgoKGwsIHQpID0+IHAobCAvIHQpKSB9LFxuICAgICAgICAgICAgeyBsYWJlbDogJ0NhcmdhbmRvIG1cdTAwRkFzaWNhLi4uJywgd2VpZ2h0OiAzLCBydW46IChwKSA9PiBwcmVsb2FkTXVzaWMoKGwsIHQpID0+IHAobCAvIHQpKSB9LFxuICAgICAgICAgICAgeyBsYWJlbDogJ0NhcmdhbmRvIHJlY3Vyc29zIGdyXHUwMEUxZmljb3MuLi4nLCB3ZWlnaHQ6IDEsIHJ1bjogKHApID0+IHtcbiAgICAgICAgICAgICAgICBwKDAuMyk7XG4gICAgICAgICAgICAgICAgY29uc3QgZm9udHNSZWFkeSA9IChkb2N1bWVudC5mb250cyAmJiBkb2N1bWVudC5mb250cy5yZWFkeSkgPyBkb2N1bWVudC5mb250cy5yZWFkeSA6IFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgICAgICAgIHJldHVybiB3aXRoVGltZW91dChmb250c1JlYWR5LCAzMDAwKS50aGVuKCgpID0+IHAoMSkpO1xuICAgICAgICAgICAgfSB9LFxuICAgICAgICAgICAgeyBsYWJlbDogJ0luaWNpYWxpemFuZG8gc2lzdGVtYXMuLi4nLCB3ZWlnaHQ6IDEsIHJ1bjogKHApID0+IHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIE11c2ljTWFuYWdlciAhPT0gJ3VuZGVmaW5lZCcpIE11c2ljTWFuYWdlci5pbml0KCk7XG4gICAgICAgICAgICAgICAgcCgxKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgICAgICB9IH1cbiAgICAgICAgXTtcblxuICAgICAgICBjb25zdCB0b3RhbFdlaWdodCA9IHN0ZXBzLnJlZHVjZSgocywgc3QpID0+IHMgKyBzdC53ZWlnaHQsIDApO1xuICAgICAgICBsZXQgZG9uZVdlaWdodCA9IDA7XG4gICAgICAgIGNvbnN0IHVwZGF0ZUJhciA9IChleHRyYSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgdG90YWwgPSBNYXRoLm1pbih0b3RhbFdlaWdodCwgZG9uZVdlaWdodCArIGV4dHJhKTtcbiAgICAgICAgICAgIGNvbnN0IHAgPSBNYXRoLnJvdW5kKCh0b3RhbCAvIHRvdGFsV2VpZ2h0KSAqIDEwMCk7XG4gICAgICAgICAgICBpZiAoZmlsbCkgZmlsbC5zdHlsZS53aWR0aCA9IHAgKyAnJSc7XG4gICAgICAgICAgICBpZiAocGN0KSBwY3QuaW5uZXJUZXh0ID0gcCArICclJztcbiAgICAgICAgfTtcblxuICAgICAgICBmb3IgKGNvbnN0IHN0ZXAgb2Ygc3RlcHMpIHtcbiAgICAgICAgICAgIGlmIChsYWJlbCkgbGFiZWwuaW5uZXJUZXh0ID0gc3RlcC5sYWJlbDtcbiAgICAgICAgICAgIGF3YWl0IHN0ZXAucnVuKChmcmFjKSA9PiB1cGRhdGVCYXIoc3RlcC53ZWlnaHQgKiBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBmcmFjKSkpKTtcbiAgICAgICAgICAgIGRvbmVXZWlnaHQgKz0gc3RlcC53ZWlnaHQ7XG4gICAgICAgICAgICB1cGRhdGVCYXIoMCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobGFiZWwpIGxhYmVsLmlubmVyVGV4dCA9ICdcdTAwQTFMaXN0byEnO1xuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgMjUwKSk7XG5cbiAgICAgICAgaWYgKGxvYWRpbmdTY3JlZW4pIGxvYWRpbmdTY3JlZW4uc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICAgICAgdGhpcy5nb1RvTG9naW5PclN0YXJ0KCk7XG4gICAgfSxcblxuICAgIGdvVG9Mb2dpbk9yU3RhcnQoKSB7XG4gICAgICAgIGlmIChTYXZlU3lzdGVtLmN1cnJlbnRVc2VyKSB0aGlzLnNob3dDbGlja1N0YXJ0KCk7XG4gICAgICAgIGVsc2UgdGhpcy5zaG93TG9naW4oKTtcbiAgICB9LFxuXG4gICAgc2hvd0xvZ2luKCkge1xuICAgICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2dpbi1zY3JlZW4nKTtcbiAgICAgICAgaWYgKGVsKSBlbC5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnO1xuICAgIH0sXG5cbiAgICBzaG93Q2xpY2tTdGFydCgpIHtcbiAgICAgICAgY29uc3QgbG9naW4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9naW4tc2NyZWVuJyk7XG4gICAgICAgIGlmIChsb2dpbikgbG9naW4uc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xpY2tzdGFydC1zY3JlZW4nKTtcbiAgICAgICAgaWYgKGVsKSBlbC5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnO1xuICAgIH0sXG5cbiAgICB1bmxvY2tBbmRFbnRlcigpIHtcbiAgICAgICAgY29uc3QgY2xpY2tzdGFydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbGlja3N0YXJ0LXNjcmVlbicpO1xuICAgICAgICBpZiAoY2xpY2tzdGFydCkgY2xpY2tzdGFydC5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuXG4gICAgICAgIC8vIFx1MDBEQW5pY28gcHVudG8gZGVsIGp1ZWdvIGRvbmRlIHNlIHJlcHJvZHVjZSBhdWRpbyBwb3IgcHJpbWVyYSB2ZXo6IHNpZW1wcmVcbiAgICAgICAgLy8gZGV0clx1MDBFMXMgZGUgdW5hIGludGVyYWNjaVx1MDBGM24gcmVhbCBkZWwgdXN1YXJpbyAoZXN0ZSBjbGljaykuXG4gICAgICAgIGlmICh0eXBlb2YgTXVzaWNNYW5hZ2VyICE9PSAndW5kZWZpbmVkJykgTXVzaWNNYW5hZ2VyLnBsYXlMb2JieSgpO1xuXG4gICAgICAgIGNvbnN0IGxvYmJ5U2NyZWVuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvYmJ5LXNjcmVlbicpO1xuICAgICAgICBpZiAobG9iYnlTY3JlZW4pIGxvYmJ5U2NyZWVuLnN0eWxlLmRpc3BsYXkgPSAnZmxleCc7XG4gICAgICAgIGlmICh0eXBlb2YgQXV0aFVJICE9PSAndW5kZWZpbmVkJykgQXV0aFVJLnJlZnJlc2goKTtcbiAgICB9XG59O1xuXG53aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignRE9NQ29udGVudExvYWRlZCcsICgpID0+IHtcbiAgICBjb25zdCBnb29nbGVCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9naW4tZ29vZ2xlLWJ0bicpO1xuICAgIGNvbnN0IGd1ZXN0QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvZ2luLWd1ZXN0LWJ0bicpO1xuICAgIGNvbnN0IGNsaWNrc3RhcnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xpY2tzdGFydC1zY3JlZW4nKTtcblxuICAgIGlmIChnb29nbGVCdG4pIHtcbiAgICAgICAgZ29vZ2xlQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgZ29vZ2xlQnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIGF3YWl0IFNhdmVTeXN0ZW0uc2lnbkluV2l0aEdvb2dsZSgpO1xuICAgICAgICAgICAgZ29vZ2xlQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgICAgICBCb290Rmxvdy5zaG93Q2xpY2tTdGFydCgpO1xuICAgICAgICB9KTtcbiAgICB9XG4gICAgaWYgKGd1ZXN0QnRuKSBndWVzdEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IEJvb3RGbG93LnNob3dDbGlja1N0YXJ0KCkpO1xuICAgIGlmIChjbGlja3N0YXJ0KSBjbGlja3N0YXJ0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gQm9vdEZsb3cudW5sb2NrQW5kRW50ZXIoKSwgeyBvbmNlOiB0cnVlIH0pO1xuXG4gICAgQm9vdEZsb3cucnVuKCk7XG59KTtcblxuLy8jIHNvdXJjZVVSTD1ib290LmpzXG4iXSwKICAibWFwcGluZ3MiOiAiO0FBc0RBLE1BQU0saUJBQWlCO0FBQUEsRUFDbkIsUUFBUTtBQUFBLEVBQ1IsWUFBWTtBQUFBLEVBQ1osV0FBVztBQUFBLEVBQ1gsZUFBZTtBQUFBLEVBQ2YsbUJBQW1CO0FBQUEsRUFDbkIsT0FBTztBQUFBLEVBQ1AsZUFBZTtBQUNuQjtBQUVBLFNBQVMsY0FBYyxjQUFjO0FBQ3JDLE1BQU0sUUFBUSxTQUFTLEtBQUs7QUFDNUIsTUFBTSxNQUFNLFNBQVMsVUFBVTtBQUkvQixJQUFJO0FBQUUsV0FBUyxVQUFVO0FBQUcsU0FBUyxHQUFHO0FBQUUsVUFBUSxLQUFLLGlEQUFpRCxDQUFDO0FBQUc7QUFJNUcsSUFBSTtBQUNBLE1BQUksa0JBQWtCLEVBQUUsaUJBQWlCLEtBQUssQ0FBQyxFQUFFLE1BQU0sU0FBTztBQUMxRCxZQUFRLEtBQUssNkdBQTBHLElBQUksUUFBUSxHQUFHO0FBQUEsRUFDMUksQ0FBQztBQUNMLFNBQVMsR0FBRztBQUEyQztBQUV2RCxNQUFNLGdCQUFnQjtBQUN0QixNQUFN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WUFBWTtBQUFXLFlBQUksVUFBVTtBQUFHLFlBQUksT0FBTyxJQUFJLENBQUM7QUFBRyxZQUFJLE9BQU8sSUFBSSxFQUFFO0FBQUcsWUFBSSxPQUFPLElBQUksRUFBRTtBQUFHLFlBQUksT0FBTyxJQUFJLENBQUM7QUFBRyxZQUFJLEtBQUs7QUFDbkksWUFBSSxZQUFZO0FBQVcsWUFBSSxTQUFTLElBQUksSUFBSSxJQUFJLENBQUM7QUFDckQsWUFBSSxZQUFZO0FBQVcsWUFBSSxTQUFTLElBQUksSUFBSSxHQUFHLENBQUM7QUFBQSxNQUN4RCxXQUFXLEtBQUssT0FBTyxTQUFTLFdBQVc7QUFDdkMsWUFBSSxZQUFZO0FBQVcsWUFBSSxTQUFTLElBQUksSUFBSSxJQUFJLENBQUM7QUFDckQsWUFBSSxZQUFZO0FBQVcsWUFBSSxTQUFTLElBQUksSUFBSSxJQUFJLENBQUM7QUFDckQsWUFBSSxZQUFZO0FBQVEsWUFBSSxTQUFTLElBQUksSUFBSSxJQUFJLENBQUM7QUFDbEQsWUFBSSxZQUFZO0FBQVcsWUFBSSxTQUFTLElBQUksR0FBRyxJQUFJLENBQUM7QUFBQSxNQUN4RCxXQUFXLEtBQUssT0FBTyxTQUFTLE9BQU87QUFDbkMsWUFBSSxZQUFZO0FBQVcsWUFBSSxTQUFTLEdBQUcsSUFBSSxJQUFJLEVBQUU7QUFDckQsWUFBSSxZQUFZO0FBQVcsWUFBSSxTQUFTLEdBQUcsR0FBRyxHQUFHLEVBQUU7QUFDbkQsWUFBSSxZQUFZO0FBQVcsWUFBSSxTQUFTLElBQUksSUFBSSxHQUFHLENBQUM7QUFBQSxNQUN4RCxXQUFXLEtBQUssT0FBTyxTQUFTLE9BQU87QUFDbkMsWUFBSSxZQUFZO0FBQVcsWUFBSSxTQUFTLEdBQUcsSUFBSSxJQUFJLENBQUM7QUFDcEQsWUFBSSxZQUFZO0FBQVcsWUFBSSxTQUFTLEdBQUcsR0FBRyxHQUFHLENBQUM7QUFDbEQsWUFBSSxZQUFZO0FBQVcsWUFBSSxTQUFTLElBQUksSUFBSSxHQUFHLENBQUM7QUFBQSxNQUN4RCxXQUFXLEtBQUssT0FBTyxTQUFTLFlBQVk7QUFDeEMsWUFB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SSxDQUFDO0FBQUEsTUFDekQsV0FBVyxLQUFLLE9BQU8sU0FBUyxTQUFTO0FBQ3JDLFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLElBQUksSUFBSSxFQUFFO0FBQ3RELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLElBQUksSUFBSSxDQUFDO0FBQ3JELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLEtBQUssSUFBSSxDQUFDO0FBQUEsTUFDMUQsV0FBVyxLQUFLLE9BQU8sU0FBUyxRQUFRO0FBQ3BDLFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxHQUFHLElBQUksSUFBSSxDQUFDO0FBQ3BELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLEdBQUcsR0FBRyxFQUFFO0FBQ3BELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLElBQUksSUFBSSxDQUFDO0FBQUEsTUFDekQsV0FBVyxLQUFLLE9BQU8sU0FBUyxjQUFjO0FBQzFDLFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxLQUFLLElBQUksSUFBSSxDQUFDO0FBQ3RELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxLQUFLLEdBQUcsSUFBSSxFQUFFO0FBQ3RELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxHQUFHLElBQUksSUFBSSxDQUFDO0FBQUEsTUFDeEQsV0FBVyxLQUFLLE9BQU8sU0FBUyxPQUFPO0FBQ25DLFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxLQUFLLElBQUksSUFBSSxDQUFDO0FBQ3RELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLEtBQUssSUFBSSxDQUFDO0FBQ3RELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxHQUFHLEtBQUssR0FBRyxDQUFDO0FBQ3BELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxLQUFLLEdBQUcsR0FBRyxFQUFFO0FBQUEsTUFDekQsV0FBVyxLQUFLLE9BQU8sU0FBUyxRQUFRO0FBQ3BDLFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLElBQUksSUFBSSxFQUFFO0FBQ3RELFlBQUksWUFBWTtBQUFXLFlBQUksVUFBVTtBQUFHLFlBQUksSUFBSSxJQUFJLElBQUksSUFBSSxHQUFHLEtBQUssS0FBRyxDQUFDO0FBQUcsWUFBSSxLQUFLO0FBQ3hGLFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLElBQUksSUFBSSxDQUFDO0FBQUEsTUFDekQsV0FBVyxLQUFLLE9BQU8sU0FBUyxPQUFPO0FBQ25DLFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxLQUFLLElBQUksSUFBSSxFQUFFO0FBQ3ZELFlBQUksWUFBWTtBQUFXLFlBQUksVUFBVTtBQUFHLFlBQUksT0FBTyxJQUFJLEVBQUU7QUFBRyxZQUFJLE9BQU8sSUFBSSxDQUFDO0FBQUcsWUFBSSxPQUFPLElBQUksQ0FBQztBQUFHLFlBQUksS0FBSztBQUMvRyxZQUFJLFlBQVk7QUFBVyxZQUFJLFNBQVMsR0FBRyxJQUFJLEdBQUcsQ0FBQztBQUFBLE1BQ3ZELFdBQVcsS0FBSyxPQUFPLFNBQVMsZ0JBQWdCO0FBQzVDLFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLElBQUksSUFBSSxFQUFFO0FBQ3RELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxLQUFLLEdBQUcsSUFBSSxFQUFFO0FBQ3RELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLElBQUksSUFBSSxDQUFDO0FBQUEsTUFDekQsV0FBVyxLQUFLLE9BQU8sU0FBUyxZQUFZO0FBQ3hDLFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLElBQUksSUFBSSxFQUFFO0FBQ3RELFlBQUksWUFBWTtBQUFXLFlBQUksU0FBUyxJQUFJLElBQUksSUFBSSxDQUFDO0FBQ3JELFlBQUksY0FBYztBQUFXLFlBQUksWUFBWTtBQUM3QyxpQkFBUyxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUs7QUFBRSxjQUFJLFVBQVU7QUFBRyxjQUFJLE9BQU8sS0FBSyxJQUFFLEdBQUcsRUFBRTtBQUFHLGNBQUksT0FBTyxLQUFLLElBQUUsR0FBRyxDQUFDO0FBQUcsY0FBSSxPQUFPO0FBQUEsUUFBRztBQUFBLE1BQ3BILFdBQVcsS0FBSyxPQUFPLFNBQVMsU0FBUztBQUNyQyxZQUFJLFlBQVk7QUFBVyxZQUFJLFNBQVMsR0FBRyxJQUFJLElBQUksQ0FBQztBQUNwRCxZQUFJLFlBQVk7QUFBVyxZQUFJLFVBQVU7QUFBRyxZQUFJLE9BQU8sSUFBSSxFQUFFO0FBQUcsWUFBSSxPQUFPLElBQUksQ0FBQztBQUFHLFlBQUksT0FBTyxJQUFJLENBQUM7QUFBRyxZQUFJLEtBQUs7QUFDL0csWUFBSSxZQUFZO0FBQVcsWUFBSSxVQUFVO0FBQUcsWUFBSSxPQUFPLElBQUksQ0FBQztBQUFHLFlBQUksT0FBTyxJQUFJLENBQUM7QUFBRyxZQUFJLE9BQU8sSUFBSSxDQUFDO0FBQUcsWUFBSSxLQUFLO0FBQUEsTUFDbEgsT0FBTztBQUVILFlBQUksWUFBWSxLQUFLLE9BQU87QUFBTyxZQUFJLFNBQVMsR0FBRyxJQUFJLElBQUksQ0FBQztBQUM1RCxZQUFJLFlBQVk7QUFBVyxZQUFJLFNBQVMsSUFBSSxHQUFHLEdBQUcsRUFBRTtBQUNwRCxZQUFJLFlBQVk7QUFBVyxZQUFJLFNBQVMsSUFBSSxJQUFJLElBQUksQ0FBQztBQUFBLE1BQ3pEO0FBRUEsVUFBSSxhQUFhO0FBQUcsVUFBSSxjQUFjO0FBQWUsVUFBSSxnQkFBZ0I7QUFHekUsVUFBSSxLQUFLLGFBQWEsS0FBSyxjQUFjLEtBQUssS0FBSyxPQUFPLFNBQVMsU0FBUztBQUN4RSxZQUFJLFlBQVk7QUFDaEIsWUFBSSxjQUFjO0FBQ2xCLFlBQUksVUFBVTtBQUNkLFlBQUksTUFBSyxxQkFBZ0IsS0FBSyxPQUFPLElBQUksTUFBaEMsWUFBcUM7QUFDOUMsWUFBSSxJQUFJLElBQUksR0FBRyxLQUFLLEtBQUssT0FBTyxJQUFFLElBQUksR0FBRyxLQUFLLEtBQUcsQ0FBQztBQUNsRCxZQUFJLEtBQUs7QUFDVCxZQUFJLFlBQVk7QUFDaEIsWUFBSSxVQUFVO0FBQUcsWUFBSSxJQUFJLElBQUksR0FBRyxJQUFJLEtBQUssT0FBTyxJQUFFLEdBQUcsR0FBRyxLQUFLLEtBQUcsQ0FBQztBQUFHLFlBQUksS0FBSztBQUM3RSxZQUFJLGNBQWM7QUFBQSxNQUN0QjtBQUFBLElBQ0o7QUFDQSxRQUFJLFFBQVE7QUFHWixRQUFJLFlBQVk7QUFDaEIsUUFBSSxTQUFTLEtBQUssSUFBSSxJQUFJLElBQUksSUFBSSxLQUFLLElBQUksSUFBSSxJQUFJLEtBQUssU0FBUyxJQUFJLElBQUksQ0FBQztBQUMxRSxRQUFJLFlBQVk7QUFDaEIsUUFBSSxTQUFTLEtBQUssSUFBSSxJQUFJLElBQUksSUFBSSxLQUFLLElBQUksSUFBSSxJQUFJLEtBQUssU0FBUyxJQUFJLE1BQU0sS0FBSyxVQUFRLEtBQUssYUFBYSxDQUFDO0FBRzNHLFFBQUksS0FBSyxVQUFVLEtBQUssT0FBTyxTQUFTLFFBQVc7QUFDL0MsVUFBSSxZQUFZO0FBQW1CLFVBQUksU0FBUyxLQUFLLElBQUksSUFBSSxJQUFJLElBQUksS0FBSyxJQUFJLElBQUksSUFBSSxLQUFLLFNBQVMsSUFBSSxJQUFJLENBQUM7QUFDN0csVUFBSSxZQUFZLEtBQUssZUFBZSxLQUFLLFlBQVk7QUFDckQsVUFBSSxTQUFTLEtBQUssSUFBSSxJQUFJLElBQUksSUFBSSxLQUFLLElBQUksSUFBSSxJQUFJLEtBQUssU0FBUyxJQUFJLE1BQU0sS0FBSyxlQUFhLEtBQUssT0FBTyxPQUFPLENBQUM7QUFBQSxJQUNySCxXQUFXLEtBQUssVUFBVSxLQUFLLE9BQU8sUUFBUTtBQUMxQyxVQUFJLFlBQVk7QUFBbUIsVUFBSSxTQUFTLEtBQUssSUFBSSxJQUFJLElBQUksSUFBSSxLQUFLLElBQUksSUFBSSxJQUFJLEtBQUssU0FBUyxJQUFJLElBQUksQ0FBQztBQUM3RyxVQUFJLFlBQVk7QUFDaEIsVUFBSSxTQUFTLEtBQUssSUFBSSxJQUFJLElBQUksSUFBSSxLQUFLLElBQUksSUFBSSxJQUFJLEtBQUssU0FBUyxJQUFJLEtBQUssS0FBSyxhQUFhLENBQUM7QUFBQSxJQUNqRztBQUFBLEVBQ0o7QUFDSjtBQUVBLEtBQUssU0FBUyxXQUFXO0FBQ3JCLE1BQUksSUFBSSxLQUFLLE9BQU87QUFDcEIsTUFBRyxDQUFDLEtBQUssRUFBRSxTQUFTLFdBQVcsS0FBSyxPQUFPLGVBQWUsRUFBRSxTQUFTLEVBQUUsU0FBVTtBQUNqRixPQUFLLE9BQU8sY0FBYztBQUMxQixVQUFRLFFBQVE7QUFDaEIsTUFBSSxFQUFFLGNBQWM7QUFDaEIsVUFBTSxPQUFPLE1BQU07QUFDZixVQUFJLEtBQUssT0FBTyxXQUFXLEdBQUc7QUFBRSxhQUFLLE9BQU8sY0FBYztBQUFPO0FBQUEsTUFBUTtBQUN6RSxRQUFFLE9BQU8sS0FBSyxJQUFJLEVBQUUsVUFBVSxFQUFFLE9BQU8sQ0FBQztBQUN4QyxjQUFRLFVBQVUsSUFBSTtBQUN0QixVQUFJLEVBQUUsT0FBTyxFQUFFLFNBQVUsWUFBVyxNQUFNLEVBQUUsVUFBVTtBQUFBLFVBQ2pELE1BQUssT0FBTyxjQUFjO0FBQUEsSUFDbkM7QUFDQSxlQUFXLE1BQU0sRUFBRSxVQUFVO0FBQUEsRUFDakMsT0FBTztBQUNILGVBQVcsTUFBTTtBQUFFLFFBQUUsT0FBTyxFQUFFO0FBQVUsV0FBSyxPQUFPLGNBQWM7QUFBQSxJQUFPLEdBQUcsRUFBRSxVQUFVO0FBQUEsRUFDNUY7QUFDSjtBQUVBLEtBQUssUUFBUSxXQUFXO0FBQ3BCLE1BQUksSUFBSSxLQUFLLE9BQU87QUFDcEIsTUFBRyxDQUFDLEtBQUssS0FBSyxPQUFPLFlBQWE7QUFDbEMsTUFBSSxFQUFFLFNBQVMsVUFBYSxLQUFLLE9BQU8sZ0JBQWdCLEVBQUc7QUFFM0QsTUFBSSxjQUFjLEVBQUUsWUFBWSxLQUFLLHNCQUFzQjtBQUMzRCxNQUFJLEVBQUUsT0FBUSxnQkFBZ0IsTUFBTSxLQUFLLE9BQU8sY0FBYztBQUM5RCxNQUFJLEtBQUssSUFBSSxJQUFJLEtBQUssV0FBVyxZQUFhO0FBRTlDLE1BQUcsRUFBRSxTQUFTLFNBQVM7QUFHbkIsUUFBSSxlQUFlO0FBQ25CLFNBQUssUUFBUSxRQUFRLE9BQUs7QUFDdEIsVUFBRyxDQUFDLEVBQUUsZ0JBQWdCLEtBQUssTUFBTSxLQUFLLE9BQU8sSUFBSSxFQUFFLEdBQUcsS0FBSyxPQUFPLElBQUksRUFBRSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUUsUUFBUTtBQUM3RixhQUFLLFNBQVMsR0FBRyxFQUFFLE1BQU07QUFDekIsdUJBQWU7QUFBQSxNQUNuQjtBQUFBLElBQ0osQ0FBQztBQUNELFFBQUksRUFBRSxTQUFTLFFBQVc7QUFDdEIsV0FBSyxPQUFPLGVBQWUsS0FBSyxJQUFJLEdBQUcsS0FBSyxPQUFPLGVBQWUsRUFBRSxTQUFTO0FBQzdFLFdBQUssT0FBTyxpQkFBaUI7QUFFN0IsY0FBUSxlQUFlLGlCQUFpQixZQUFZLEtBQUssSUFBSTtBQUFBLElBQ2pFLE9BQU87QUFFSCxZQUFNLGdCQUFnQixDQUFDLFNBQVMsVUFBVSxRQUFRO0FBQ2xELGNBQVEsY0FBYyxLQUFLLE1BQU0sS0FBSyxPQUFPLElBQUksY0FBYyxNQUFNLENBQUMsR0FBRyxLQUFLLEdBQUc7QUFBQSxJQUNyRjtBQUNBLFNBQUssV0FBVyxLQUFLLElBQUk7QUFDekI7QUFBQSxFQUNKO0FBRUEsTUFBSSxFQUFFLFFBQVEsR0FBRztBQUFFLFNBQUssT0FBTztBQUFHO0FBQUEsRUFBUTtBQUMxQyxNQUFJLEVBQUUsU0FBUyxLQUFLLE9BQU8sVUFBVztBQUV0QyxRQUFNLFdBQVcsTUFBTTtBQUVuQixRQUFJLFdBQVcsRUFBRSxPQUFPO0FBQ3hCLFFBQUksYUFBYSxlQUFlLEVBQUUsU0FBUyxXQUFZLFlBQVc7QUFBQSxhQUN6RCxhQUFhLGVBQWUsQ0FBQyxRQUFRLFFBQVEsU0FBUyxNQUFNLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRyxZQUFXO0FBQUEsYUFDM0YsYUFBYSxlQUFlLENBQUMsT0FBTyxPQUFPLEtBQUssRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFHLFlBQVc7QUFBQSxhQUMvRSxhQUFhLGVBQWUsQ0FBQyxVQUFVLEtBQUssRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFHLFlBQVc7QUFBQSxhQUMzRSxhQUFhLGVBQWUsRUFBRSxTQUFTLGFBQWMsWUFBVztBQUV6RSxZQUFRLFVBQVUsS0FBSyxHQUFHO0FBQzFCLFNBQUssT0FBTyxlQUFlLEVBQUUsUUFBUTtBQUNyQyxTQUFLLE9BQU8sY0FBYztBQUMxQixTQUFLLE9BQU8sUUFBUSxFQUFFO0FBRXRCLFFBQUksUUFBUSxLQUFLLE1BQU0sS0FBSyxNQUFNLEtBQUssS0FBSyxPQUFPLElBQUksS0FBSyxPQUFPLElBQUksS0FBSyxNQUFNLEtBQUssS0FBSyxPQUFPLElBQUksS0FBSyxPQUFPLEVBQUU7QUFFckgsUUFBRyxFQUFFLE9BQVEsTUFBSyxZQUFZLEtBQUssT0FBTyxHQUFHLEtBQUssT0FBTyxHQUFHLEtBQUs7QUFDakUsUUFBRyxFQUFFLE9BQU87QUFDUixlQUFRLElBQUUsR0FBRyxJQUFFLEVBQUUsT0FBTyxJQUFLLE1BQUssY0FBYyxLQUFLLE9BQU8sSUFBSSxLQUFLLElBQUksS0FBSyxJQUFFLElBQUksS0FBSyxPQUFPLElBQUksS0FBSyxJQUFJLEtBQUssSUFBRSxJQUFJLEVBQUUsU0FBUyxpQkFBaUIsWUFBWSxXQUFXLEdBQUcsR0FBRyxPQUFPO0FBQUEsSUFDNUw7QUFFQSxRQUFHLEVBQUUsU0FBUztBQUNWLGVBQVEsSUFBRSxHQUFHLElBQUUsRUFBRSxTQUFTLElBQUssTUFBSyxnQkFBZ0IsS0FBSyxPQUFPLEdBQUcsS0FBSyxPQUFPLEdBQUcsU0FBUyxLQUFLLE9BQU8sSUFBRSxRQUFNLEVBQUUsVUFBVSxLQUFLLHFCQUFxQixLQUFLLENBQUM7QUFBQSxJQUMvSixPQUFPO0FBQ0gsVUFBSSxLQUFLLEtBQUssT0FBTyxJQUFFLFFBQVEsRUFBRSxVQUFVLEtBQUsscUJBQXFCO0FBQ3JFLFdBQUssZ0JBQWdCLEtBQUssT0FBTyxHQUFHLEtBQUssT0FBTyxHQUFHLFFBQVEsR0FBRyxDQUFDO0FBQUEsSUFDbkU7QUFDQSxNQUFFO0FBQUEsRUFDTjtBQUVBLE1BQUksRUFBRSxPQUFPO0FBQ1QsU0FBSyxPQUFPLFlBQVk7QUFDeEIsUUFBSSxRQUFRO0FBQ1osVUFBTSxXQUFXLE1BQU07QUFDbkIsVUFBSSxFQUFFLFFBQVEsS0FBSyxTQUFTLEVBQUUsT0FBTztBQUFFLGFBQUssT0FBTyxZQUFZO0FBQU87QUFBQSxNQUFRO0FBQzlFLGVBQVM7QUFBRztBQUNaLFVBQUksUUFBUSxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUcsWUFBVyxVQUFVLEVBQUUsVUFBVTtBQUFBLFVBQy9ELE1BQUssT0FBTyxZQUFZO0FBQUEsSUFDakM7QUFDQSxhQUFTO0FBQUEsRUFDYixPQUFPO0FBQ0gsYUFBUztBQUFBLEVBQ2I7QUFDQSxPQUFLLFdBQVcsS0FBSyxJQUFJO0FBQzdCO0FBRUEsS0FBSyxXQUFXLFNBQVMsR0FBRyxLQUFLO0FBNXZFakM7QUE2dkVJLElBQUUsTUFBTTtBQUNSLElBQUUsUUFBUTtBQUtWLFdBQVEsSUFBRSxHQUFHLElBQUUsS0FBSyxLQUFLLElBQUUsS0FBSyxhQUFhLEdBQUcsSUFBSyxNQUFLLGNBQWMsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLE9BQU8sR0FBRyxHQUFHLFFBQVE7QUFFekcsTUFBSSxJQUFJLEtBQUssY0FBYyxLQUFLLENBQUFBLE9BQUssQ0FBQ0EsR0FBRSxNQUFNO0FBQzlDLE1BQUcsQ0FBQyxHQUFHO0FBQUUsUUFBSSxJQUFJLGFBQWE7QUFBRyxTQUFLLGNBQWMsS0FBSyxDQUFDO0FBQUEsRUFBRztBQUM3RCxJQUFFLEtBQUssRUFBRSxHQUFHLEVBQUUsR0FBRyxLQUFLLE1BQU0sR0FBRyxHQUFHLFFBQVEsRUFBRTtBQUU1QyxNQUFHLEVBQUUsTUFBTSxLQUFLLENBQUMsRUFBRSxTQUFTO0FBQ3hCLE1BQUUsVUFBVTtBQUNaLFlBQVEsU0FBUyxHQUFHO0FBQ3BCLFVBQU0sVUFBVSxFQUFFLE1BQU0sS0FBTSxNQUFNLElBQUksUUFBUSxJQUFJLE1BQU0sSUFBSSxPQUFPLElBQUksV0FBVyxJQUFJLFVBQVUsSUFBSSxPQUFPLEdBQUc7QUFDaEgsUUFBSUMsVUFBUyxLQUFLLFFBQU8sYUFBUSxFQUFFLElBQUksTUFBZCxZQUFtQixPQUFPLEtBQUssYUFBYSxFQUFFO0FBQ3ZFLFNBQUssT0FBTyxTQUFTQTtBQUVyQixRQUFJLEtBQUssS0FBSyxjQUFjLEtBQUssQ0FBQUMsUUFBTSxDQUFDQSxJQUFHLE1BQU07QUFDakQsUUFBRyxDQUFDLElBQUk7QUFBRSxXQUFLLElBQUksYUFBYTtBQUFHLFdBQUssY0FBYyxLQUFLLEVBQUU7QUFBQSxJQUFHO0FBQ2hFLE9BQUcsS0FBSyxFQUFFLEdBQUcsRUFBRSxJQUFJLElBQUksS0FBS0QsT0FBTSxJQUFJLFdBQVcsRUFBRTtBQUVuRCxhQUFRLElBQUUsR0FBRyxJQUFFLEtBQUssS0FBSyxLQUFHLEtBQUssYUFBYSxHQUFHLElBQUssTUFBSyxjQUFjLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxPQUFPLEdBQUcsR0FBRyxRQUFRO0FBQzFHLFNBQUssV0FBVyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsU0FBUyxHQUFHO0FBRXhDLFVBQU0sTUFBTSxLQUFLLFFBQVEsUUFBUSxDQUFDO0FBQ2xDLFFBQUcsUUFBUSxHQUFJLE1BQUssUUFBUSxPQUFPLEtBQUssQ0FBQztBQUd6QyxRQUFJLEtBQUssZUFBZSxLQUFLLFFBQVEsVUFBVSxHQUFHO0FBQzlDLFdBQUssVUFBVTtBQUNmLFdBQUssY0FBYztBQUNuQixVQUFJLEtBQUssS0FBSyxjQUFjLEtBQUssQ0FBQUMsUUFBTSxDQUFDQSxJQUFHLE1BQU07QUFDakQsVUFBRyxDQUFDLElBQUk7QUFBRSxhQUFLLElBQUksYUFBYTtBQUFHLGFBQUssY0FBYyxLQUFLLEVBQUU7QUFBQSxNQUFHO0FBQ2hFLFNBQUcsS0FBSyxLQUFLLE9BQU8sR0FBRyxLQUFLLE9BQU8sSUFBSSxJQUFJLGtCQUFrQixXQUFXLEVBQUU7QUFBQSxJQUM5RTtBQUFBLEVBQ0o7QUFDSjtBQUtBLE1BQU0sV0FBVztBQUFBLEVBQ2IsS0FBSyxHQUFHLEdBQUcsT0FBTyxRQUFRLFVBQVUsT0FBTztBQUN2QyxTQUFLLElBQUk7QUFBRyxTQUFLLElBQUk7QUFDckIsU0FBSyxLQUFLLEtBQUssSUFBSSxLQUFLLElBQUksT0FBTyxTQUFTLEtBQUssdUJBQXVCO0FBQ3hFLFNBQUssS0FBSyxLQUFLLElBQUksS0FBSyxJQUFJLE9BQU8sU0FBUyxLQUFLLHVCQUF1QjtBQUN4RSxTQUFLLFNBQVMsT0FBTztBQUNyQixTQUFLLFNBQVMsVUFBVSxJQUFJO0FBQzVCLFNBQUssUUFBUSxVQUFVLFlBQVksT0FBTztBQUMxQyxTQUFLLFNBQVM7QUFBTSxTQUFLLFVBQVU7QUFDbkMsU0FBSyxRQUFRLENBQUM7QUFFZCxTQUFLLFNBQVMsT0FBTyxVQUFVO0FBQy9CLFNBQUssWUFBWSxPQUFPLGFBQWE7QUFDckMsU0FBSyxPQUFPLE9BQU8sUUFBUTtBQUMzQixTQUFLLFlBQVksT0FBTyxhQUFhO0FBQ3JDLFNBQUssa0JBQWtCLE9BQU8sbUJBQW1CO0FBQ2pELFNBQUssV0FBVyxPQUFPLFlBQVk7QUFDbkMsU0FBSyxXQUFXO0FBQ2hCLFNBQUssYUFBYSxLQUFLLGNBQWMsb0JBQUksSUFBSTtBQUM3QyxRQUFJLEtBQUssV0FBVyxLQUFNLE1BQUssV0FBVyxNQUFNO0FBQUEsRUFDcEQ7QUFBQSxFQUNBLFNBQVM7QUFDTCxTQUFLLE1BQU0sS0FBSyxFQUFDLEdBQUcsS0FBSyxHQUFHLEdBQUcsS0FBSyxFQUFDLENBQUM7QUFDdEMsUUFBRyxLQUFLLE1BQU0sU0FBUyxFQUFHLE1BQUssTUFBTSxNQUFNO0FBQzNDLFNBQUssS0FBSyxLQUFLO0FBQUksU0FBSyxLQUFLLEtBQUs7QUFDbEMsUUFBSSxLQUFLLFVBQVU7QUFDZixXQUFLLFlBQVksS0FBSyxNQUFNLEtBQUssSUFBSSxLQUFLLEVBQUU7QUFDNUMsVUFBSSxLQUFLLFdBQVcsS0FBSyxTQUFVLE1BQUssU0FBUztBQUFBLElBQ3JEO0FBQ0EsUUFBRyxLQUFLLElBQUksS0FBSyxLQUFLLElBQUksWUFBWSxLQUFLLElBQUksS0FBSyxLQUFLLElBQUksU0FBVSxNQUFLLFNBQVM7QUFBQSxFQUN6RjtBQUFBLEVBQ0EsS0FBSyxLQUFLO0FBQ04sUUFBSSxDQUFDLFVBQVUsS0FBSyxHQUFHLEtBQUssR0FBRyxJQUFJLEdBQUcsRUFBRztBQUN6QyxRQUFJLFVBQVU7QUFDZCxRQUFJLE9BQU8sS0FBSyxJQUFJLElBQUksR0FBRyxLQUFLLElBQUksSUFBSSxDQUFDO0FBQ3pDLGFBQVEsSUFBSSxLQUFLLE1BQU0sU0FBUyxHQUFHLEtBQUssR0FBRyxLQUFLO0FBQUUsVUFBSSxPQUFPLEtBQUssTUFBTSxDQUFDLEVBQUUsSUFBSSxJQUFJLEdBQUcsS0FBSyxNQUFNLENBQUMsRUFBRSxJQUFJLElBQUksQ0FBQztBQUFBLElBQUc7QUFDaEgsUUFBSSxjQUFjLEtBQUs7QUFBTyxRQUFJLFlBQVksS0FBSztBQUFRLFFBQUksVUFBVTtBQUN6RSxRQUFJLGNBQWM7QUFBSyxRQUFJLE9BQU87QUFBRyxRQUFJLGNBQWM7QUFFdkQsUUFBSSxZQUFZO0FBQ2hCLFFBQUksVUFBVTtBQUFHLFFBQUksSUFBSSxLQUFLLElBQUksSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxRQUFRLEdBQUcsS0FBSyxLQUFHLENBQUM7QUFBRyxRQUFJLEtBQUs7QUFBQSxFQUNsRztBQUNKO0FBRUEsTUFBTSxNQUFNO0FBQUEsRUFDUixZQUFZLEdBQUcsR0FBRyxNQUFNO0FBQ3BCLFNBQUssSUFBSTtBQUFHLFNBQUssSUFBSTtBQUFHLFNBQUssT0FBTztBQUNwQyxTQUFLLFFBQVE7QUFBRyxTQUFLLE9BQU8sS0FBSyxPQUFPLElBQUk7QUFDNUMsU0FBSyxVQUFVO0FBRWYsVUFBTSxJQUFJLElBQUssS0FBSyxPQUFPO0FBQzNCLFFBQUcsU0FBUyxRQUFRO0FBQUUsV0FBSyxRQUFRLE1BQU07QUFBRyxXQUFLLFFBQVE7QUFBSyxXQUFLLFNBQVM7QUFBSSxXQUFLLFFBQVE7QUFBQSxJQUFXLFdBQ2hHLFNBQVMsUUFBUTtBQUFFLFdBQUssUUFBUSxLQUFLO0FBQUcsV0FBSyxRQUFRO0FBQUssV0FBSyxTQUFTO0FBQUksV0FBSyxRQUFRO0FBQUEsSUFBVyxXQUNwRyxTQUFTLFVBQVU7QUFBRSxXQUFLLFFBQVEsS0FBSztBQUFHLFdBQUssUUFBUTtBQUFLLFdBQUssU0FBUztBQUFJLFdBQUssUUFBUTtBQUFXLFdBQUssV0FBVztBQUFBLElBQUcsV0FDekgsU0FBUyxhQUFhO0FBQUUsV0FBSyxRQUFRLEtBQUs7QUFBRyxXQUFLLFFBQVE7QUFBSyxXQUFLLFNBQVM7QUFBSSxXQUFLLFFBQVE7QUFBVyxXQUFLLGFBQWE7QUFBRyxXQUFLLHVCQUF1QjtBQUFHLFdBQUssY0FBYztBQUFBLElBQU8sV0FDdkwsU0FBUyxZQUFZO0FBQUUsV0FBSyxRQUFRLEtBQUs7QUFBRyxXQUFLLFFBQVEsTUFBTTtBQUFLLFdBQUssU0FBUztBQUFJLFdBQUssUUFBUTtBQUFXLFdBQUssWUFBWSxLQUFLO0FBQU8sV0FBSyxnQkFBZ0I7QUFBUyxXQUFLLGdCQUFnQjtBQUFHLFdBQUssZUFBZTtBQUFBLElBQUcsV0FDeE4sU0FBUyxTQUFTO0FBQUUsV0FBSyxRQUFRLEtBQUs7QUFBRyxXQUFLLFFBQVE7QUFBSyxXQUFLLFNBQVM7QUFBSSxXQUFLLFFBQVE7QUFBVyxXQUFLLGFBQWE7QUFBUyxXQUFLLGFBQWE7QUFBRyxXQUFLLGFBQWE7QUFBTSxXQUFLLGVBQWU7QUFBQSxJQUFNLFdBQ3ZNLFNBQVMsUUFBUTtBQUNyQixXQUFLLFdBQVcsS0FBSztBQUNyQixVQUFJLEtBQUssWUFBWSxJQUFJO0FBQ3JCLGFBQUssU0FBUyxPQUFRLEtBQUssV0FBVyxNQUFNLE9BQU87QUFBQSxNQUN2RCxXQUFXLEtBQUssWUFBWSxJQUFJO0FBQzVCLGFBQUssUUFBUSxPQUFPO0FBQUEsTUFDeEIsT0FBTztBQUNILGFBQUssUUFBUSxPQUFPO0FBQUEsTUFDeEI7QUFDQSxXQUFLLFFBQVE7QUFBSyxXQUFLLFNBQVM7QUFBSSxXQUFLLFFBQVE7QUFDakQsV0FBSyxRQUFRO0FBQVEsV0FBSyxhQUFhO0FBQUcsV0FBSyxjQUFjO0FBQzdELFdBQUssa0JBQWtCO0FBQUcsV0FBSyxhQUFhO0FBQUEsSUFDaEQsT0FDSztBQUFFLFdBQUssUUFBUSxLQUFLO0FBQUcsV0FBSyxRQUFRO0FBQUssV0FBSyxTQUFTO0FBQUksV0FBSyxRQUFRO0FBQUEsSUFBVztBQUV4RixTQUFLLFNBQVUsS0FBSyxrQkFBa0I7QUFDdEMsUUFBSSxLQUFLLGNBQWUsTUFBSyxVQUFVLEtBQUs7QUFDNUMsUUFBSSxLQUFLLFlBQWEsTUFBSyxTQUFTLEtBQUs7QUFDekMsU0FBSyxLQUFLLEtBQUs7QUFBQSxFQUNuQjtBQUFBLEVBQ0EsT0FBTyxRQUFRO0FBQ1gsU0FBSyxRQUFRO0FBQ2IsUUFBSSxJQUFJLEtBQUssVUFBVSxTQUFZLEtBQUssUUFBUSxLQUFLLE1BQU0sT0FBTyxJQUFJLEtBQUssR0FBRyxPQUFPLElBQUksS0FBSyxDQUFDO0FBQy9GLFFBQUksUUFBUSxLQUFLLE1BQU0sT0FBTyxJQUFJLEtBQUssR0FBRyxPQUFPLElBQUksS0FBSyxDQUFDO0FBRTNELFFBQUksS0FBSyxTQUFTLFlBQVk7QUFDMUIsVUFBSSxLQUFLLGtCQUFrQixXQUFXLElBQUksS0FBSztBQUFFLGFBQUssZ0JBQWdCO0FBQVMsYUFBSyxnQkFBZ0I7QUFBQSxNQUFHO0FBQ3ZHLFVBQUksS0FBSyxrQkFBa0IsU0FBUztBQUNoQyxhQUFLO0FBQ0wsYUFBSyxRQUFRLEtBQUssZ0JBQWdCLElBQUksSUFBSSxTQUFTLEtBQUs7QUFDeEQsYUFBSyxlQUFlLElBQUksS0FBSyxJQUFJLEtBQU0sS0FBSyxnQkFBZ0IsS0FBTSxHQUFHO0FBQ3JFLFlBQUksS0FBSyxnQkFBZ0IsSUFBSTtBQUN6QixnQkFBTSxjQUFjO0FBQ3BCLGNBQUksSUFBSSxZQUFhLFFBQU8sV0FBVyxFQUFFO0FBQ3pDLGVBQUssUUFBUSxRQUFRLFdBQVM7QUFDMUIsZ0JBQUksVUFBVSxRQUFRLENBQUMsTUFBTSxnQkFBZ0IsS0FBSyxNQUFNLE1BQU0sSUFBSSxLQUFLLEdBQUcsTUFBTSxJQUFJLEtBQUssQ0FBQyxJQUFJLFlBQWEsTUFBSyxTQUFTLE9BQU8sRUFBRTtBQUFBLFVBQ3RJLENBQUM7QUFDRCxlQUFLLE9BQU8sUUFBUTtBQUNwQixtQkFBUSxJQUFFLEdBQUcsSUFBRSxLQUFLLEtBQUssS0FBRyxLQUFLLGFBQWEsR0FBRyxJQUFLLE1BQUssY0FBYyxLQUFLLEdBQUcsS0FBSyxHQUFHLFdBQVcsR0FBRyxHQUFHLFFBQVE7QUFDbEgsZUFBSyxTQUFTLE1BQU0sS0FBSyxFQUFFO0FBQUEsUUFDL0I7QUFBQSxNQUNKO0FBQUEsSUFDSjtBQUNBLFFBQUksS0FBSyxTQUFTLGFBQWE7QUFDM0IsWUFBTSxXQUFXLFVBQVUsS0FBSyxHQUFHLEtBQUssR0FBRyxLQUFLLFFBQVEsS0FBSyxNQUFNO0FBQ25FLFVBQUksWUFBWSxDQUFDLEtBQUssWUFBYSxNQUFLLHVCQUF1QjtBQUMvRCxXQUFLLGNBQWM7QUFDbkIsVUFBSSxLQUFLLHVCQUF1QixHQUFHO0FBQUUsYUFBSyxhQUFhLEtBQUssSUFBSSxHQUFHLEtBQUssYUFBYSxJQUFJO0FBQUcsYUFBSztBQUFBLE1BQXdCLE1BQ3BILE1BQUssYUFBYSxLQUFLLElBQUksR0FBRyxLQUFLLGFBQWEsSUFBSTtBQUN6RCxVQUFJLEtBQUssT0FBTyxJQUFJLElBQUssTUFBSyxXQUFXLEtBQUssR0FBRyxLQUFLLEdBQUcsS0FBSyxTQUFTLEdBQUc7QUFBQSxJQUM5RTtBQUNBLFFBQUksS0FBSyxTQUFTLFNBQVM7QUFDdkIsV0FBSztBQUNMLFVBQUksS0FBSyxlQUFlLFdBQVcsS0FBSyxhQUFhLEtBQUs7QUFBRSxhQUFLLGFBQWE7QUFBUyxhQUFLLGFBQWE7QUFBRyxhQUFLLGVBQWU7QUFBQSxNQUFPLFdBQzlILEtBQUssZUFBZSxXQUFXLEtBQUssYUFBYSxLQUFLO0FBQUUsYUFBSyxhQUFhO0FBQVMsYUFBSyxhQUFhO0FBQUcsYUFBSyxlQUFlO0FBQUEsTUFBTTtBQUMzSSxZQUFNLG1CQUFtQixLQUFLLGVBQWUsVUFBVSxPQUFPO0FBQzlELFdBQUssZUFBZSxtQkFBbUIsS0FBSyxjQUFjO0FBQUEsSUFDOUQ7QUFFQSxRQUFJLEtBQUssU0FBUyxRQUFRO0FBQ3RCLFdBQUs7QUFDTCxXQUFLO0FBR0wsVUFBSSxLQUFLLFlBQVksTUFBTSxLQUFLLGNBQWMsS0FBSyxJQUFJO0FBQ25ELGFBQUssY0FBYztBQUNuQixhQUFLLFFBQVEsS0FBSyxJQUFJLE1BQU0sS0FBSyxJQUFJLEtBQUssS0FBSyxHQUFHLE1BQU0sQ0FBQztBQUN6RCxhQUFLLFFBQVEsS0FBSyxJQUFJLE1BQU0sS0FBSyxJQUFJLEtBQUssS0FBSyxHQUFHLE1BQU0sQ0FBQztBQUN6RCxhQUFLLFFBQVEsS0FBSyxJQUFJLE1BQU0sS0FBSyxHQUFHLEtBQUssSUFBSSxLQUFLLFFBQVEsQ0FBQztBQUMzRCxhQUFLLFFBQVEsS0FBSyxJQUFJLE1BQU0sS0FBSyxHQUFHLEtBQUssSUFBSSxLQUFLLFFBQVEsQ0FBQztBQUFBLE1BQy9EO0FBRUEsVUFBSSxLQUFLLFVBQVUsUUFBUTtBQUN2QixhQUFLLEtBQUssS0FBSyxJQUFJLEtBQUssSUFBSSxLQUFLO0FBQ2pDLGFBQUssS0FBSyxLQUFLLElBQUksS0FBSyxJQUFJLEtBQUs7QUFFakMsWUFBSSxRQUFRLEtBQUssWUFBWSxLQUFLLEtBQU0sS0FBSyxZQUFZLEtBQUssS0FBSztBQUNuRSxZQUFJLEtBQUssYUFBYSxPQUFPO0FBQ3pCLGVBQUssYUFBYTtBQUNsQixjQUFJLEtBQUssWUFBWSxNQUFNLEtBQUssT0FBTyxJQUFJLEtBQUs7QUFDNUMsaUJBQUssUUFBUTtBQUNiLGlCQUFLLGFBQWE7QUFBQSxVQUN0QixPQUFPO0FBQ0gsaUJBQUssUUFBUTtBQUFBLFVBQ2pCO0FBQUEsUUFDSjtBQUFBLE1BQ0osV0FBVyxLQUFLLFVBQVUsYUFBYTtBQUVuQyxhQUFLLE1BQU0sS0FBSyxPQUFPLElBQUksT0FBTztBQUNsQyxhQUFLLE1BQU0sS0FBSyxPQUFPLElBQUksT0FBTztBQUNsQyxhQUFLLFFBQVEsS0FBSyxhQUFhLElBQUksSUFBSSxTQUFTO0FBRWhELFlBQUksV0FBVyxLQUFLLFlBQVksS0FBSyxLQUFLO0FBQzFDLFlBQUksS0FBSyxhQUFhLFVBQVU7QUFDNUIsZUFBSyxRQUFRO0FBQ2IsZUFBSyxhQUFhO0FBQ2xCLGVBQUssa0JBQWtCO0FBQ3ZCLGVBQUssWUFBWSxLQUFLLFlBQVksS0FBSyxLQUFLO0FBQzVDLGVBQUssUUFBUTtBQUFBLFFBQ2pCO0FBQUEsTUFDSixXQUFXLEtBQUssVUFBVSxRQUFRO0FBQzlCLGFBQUssS0FBSyxLQUFLLElBQUksS0FBSyxlQUFlLElBQUksS0FBSztBQUNoRCxhQUFLLEtBQUssS0FBSyxJQUFJLEtBQUssZUFBZSxJQUFJLEtBQUs7QUFFaEQsWUFBSSxLQUFLLE9BQU8sSUFBSSxJQUFLLE1BQUssV0FBVyxLQUFLLEdBQUcsS0FBSyxHQUFHLEtBQUssTUFBTTtBQUVwRSxZQUFJLEtBQUssYUFBYSxJQUFJO0FBQ3RCLGVBQUssUUFBUTtBQUNiLGVBQUssYUFBYTtBQUFBLFFBQ3RCO0FBQUEsTUFDSixXQUFXLEtBQUssVUFBVSxTQUFTO0FBQy9CLGFBQUssS0FBSyxLQUFLLElBQUksS0FBSyxLQUFLLEtBQUssUUFBUTtBQUMxQyxhQUFLLEtBQUssS0FBSyxJQUFJLEtBQUssS0FBSyxLQUFLLFFBQVE7QUFFMUMsWUFBSSxLQUFLLGFBQWEsT0FBTyxHQUFHO0FBQzVCLGNBQUksS0FBSyxZQUFZLElBQUk7QUFFckIsZ0JBQUksU0FBUyxLQUFLLGFBQWE7QUFDL0IscUJBQVEsSUFBRSxHQUFHLElBQUUsSUFBSSxLQUFLO0FBQ3BCLGtCQUFJLElBQUssS0FBSyxLQUFHLElBQUUsS0FBTSxJQUFJO0FBQzdCLG1CQUFLLGdCQUFnQixLQUFLLEdBQUcsS0FBSyxHQUFHLEdBQUcsRUFBQyxPQUFPLEdBQUcsUUFBUSxNQUFNLEtBQUssbUJBQW1CLElBQUksT0FBTyxVQUFTLEdBQUcsSUFBSTtBQUFBLFlBQ3hIO0FBQUEsVUFDSixPQUFPO0FBRUgscUJBQVEsSUFBRSxHQUFHLElBQUUsR0FBRyxLQUFLO0FBQ25CLGtCQUFJLElBQUssS0FBSyxLQUFHLElBQUUsSUFBSztBQUN4QixtQkFBSyxnQkFBZ0IsS0FBSyxHQUFHLEtBQUssR0FBRyxHQUFHLEVBQUMsT0FBTyxHQUFHLFFBQVEsTUFBTSxLQUFLLG1CQUFtQixJQUFJLE9BQU8sVUFBUyxHQUFHLElBQUk7QUFBQSxZQUN4SDtBQUFBLFVBQ0o7QUFDQSxlQUFLO0FBQUEsUUFDVDtBQUVBLFlBQUksWUFBWSxLQUFLLFlBQVksS0FBSyxJQUFJO0FBQzFDLFlBQUksS0FBSyxjQUFjLFdBQVc7QUFDOUIsZUFBSyxRQUFRO0FBQ2IsZUFBSyxhQUFhO0FBQUEsUUFDdEI7QUFBQSxNQUNKO0FBQUEsSUFDSixXQUNRLEtBQUssU0FBUyxZQUFZLElBQUksS0FBSztBQUN2QyxVQUFHLElBQUksS0FBSztBQUFFLGFBQUssS0FBSyxLQUFLLElBQUksS0FBSyxJQUFJLEtBQUs7QUFBTyxhQUFLLEtBQUssS0FBSyxJQUFJLEtBQUssSUFBSSxLQUFLO0FBQUEsTUFBTztBQUM5RixVQUFHLEtBQUssSUFBSSxJQUFJLEtBQUssV0FBVyxNQUFNO0FBQ2xDLGFBQUssZ0JBQWdCLEtBQUssR0FBRyxLQUFLLEdBQUcsT0FBTyxFQUFDLE9BQU8sR0FBRyxRQUFRLE1BQU0sS0FBSyxtQkFBbUIsSUFBSSxPQUFPLFVBQVMsR0FBRyxJQUFJO0FBQ3hILGFBQUssV0FBVyxLQUFLLElBQUk7QUFBQSxNQUM3QjtBQUFBLElBQ0osV0FBVSxLQUFLLFNBQVMsY0FBYyxLQUFLLGtCQUFrQixTQUFTO0FBQUEsSUFFdEUsT0FBTztBQUNILFdBQUssS0FBSyxLQUFLLElBQUksS0FBSyxJQUFJLEtBQUs7QUFBTyxXQUFLLEtBQUssS0FBSyxJQUFJLEtBQUssSUFBSSxLQUFLO0FBQUEsSUFDN0U7QUFFQSxRQUFHLElBQUksS0FBSyxTQUFTLE9BQU8sT0FBUSxRQUFPLFdBQVcsT0FBTyxLQUFLLG1CQUFtQixFQUFFO0FBQ3ZGLFFBQUcsS0FBSyxRQUFRLEVBQUcsTUFBSztBQUV4QixRQUFJLEtBQUssWUFBWSxHQUFHO0FBQ3BCLFdBQUs7QUFDTCxVQUFJLEtBQUssWUFBWSxPQUFPLEtBQUssQ0FBQyxLQUFLLFNBQVM7QUFDNUMsYUFBSyxTQUFTLE1BQU0sS0FBSyxXQUFXLENBQUM7QUFDckMsWUFBSSxVQUFVLEtBQUssR0FBRyxLQUFLLEdBQUcsS0FBSyxRQUFRLEtBQUssTUFBTSxFQUFHLE1BQUssY0FBYyxLQUFLLEdBQUcsS0FBSyxJQUFJLEtBQUssU0FBTyxLQUFLLFdBQVcsR0FBRyxHQUFHLFFBQVE7QUFBQSxNQUMzSTtBQUFBLElBQ0o7QUFBQSxFQUNKO0FBQUEsRUFDQSxLQUFLLEtBQUs7QUFDTixRQUFJLENBQUMsVUFBVSxLQUFLLEdBQUcsS0FBSyxHQUFHLEtBQUssU0FBUyxHQUFHLEdBQUcsRUFBRztBQUV0RCxRQUFJLFlBQVk7QUFDaEIsUUFBSSxLQUFLLFNBQVMsWUFBYSxhQUFZLEtBQUs7QUFDaEQsUUFBSSxLQUFLLFNBQVMsUUFBUyxhQUFZLEtBQUs7QUFFNUMsVUFBTSxTQUFTLEtBQUssSUFBSSxLQUFLLElBQUksS0FBSyxJQUFJLENBQUMsS0FBSyxLQUFLLFFBQVE7QUFDN0QsUUFBSSxVQUFVLElBQUksS0FBSyxJQUFJLEtBQUssSUFBSSxLQUFLLElBQUksQ0FBQyxJQUFJO0FBQ2xELFFBQUksS0FBSyxTQUFTLE9BQVEsWUFBVztBQUVyQyxRQUFJLEtBQUssZ0JBQWdCO0FBQ3JCLFVBQUksY0FBYztBQUNsQixVQUFJLFlBQVk7QUFDaEIsVUFBSSxVQUFVO0FBQUcsVUFBSSxRQUFRLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxJQUFJLElBQUksSUFBSSxLQUFLLFNBQU8sS0FBSyxLQUFLLFNBQVMsS0FBSyxLQUFLLFNBQVMsS0FBSyxHQUFHLEdBQUcsS0FBSyxLQUFHLENBQUM7QUFBRyxVQUFJLEtBQUs7QUFDaEosVUFBSSxjQUFjO0FBQUEsSUFDdEI7QUFFQSxRQUFJLEtBQUs7QUFDVCxRQUFJLGNBQWM7QUFDbEIsUUFBSSxVQUFVLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxJQUFJLElBQUksSUFBSSxNQUFNO0FBRXJELFFBQUksS0FBSyxTQUFTLFFBQVE7QUFDdEIsVUFBSSxNQUFNLElBQUksU0FBUyxPQUFPO0FBQUEsSUFDbEMsV0FBVyxLQUFLLFNBQVMsUUFBUTtBQUM3QixVQUFJLE1BQU0sU0FBUyxJQUFJLE9BQU87QUFBQSxJQUNsQyxPQUFPO0FBQ0gsVUFBSSxNQUFNLElBQUksU0FBUyxPQUFPO0FBQUEsSUFDbEM7QUFFQSxRQUFJLFlBQVksS0FBSyxRQUFRLElBQUksU0FBUyxLQUFLO0FBQy9DLFFBQUksY0FBYztBQUFRLFFBQUksWUFBWTtBQUUxQyxRQUFJLEtBQUssU0FBUyxRQUFRO0FBQ3RCLFVBQUksVUFBVTtBQUNkLGVBQVEsSUFBRSxHQUFHLElBQUUsR0FBRyxLQUFLO0FBQ25CLFlBQUksT0FBTyxLQUFLLElBQUksSUFBSSxLQUFLLEtBQUcsQ0FBQyxJQUFJLEtBQUssUUFBUSxLQUFLLElBQUksSUFBSSxLQUFLLEtBQUcsQ0FBQyxJQUFJLEtBQUssTUFBTTtBQUFBLE1BQzNGO0FBQ0EsVUFBSSxVQUFVO0FBQUcsVUFBSSxLQUFLO0FBQUcsVUFBSSxPQUFPO0FBQ3hDLFVBQUksVUFBVTtBQUFHLFVBQUksT0FBTyxLQUFLLEdBQUc7QUFBRyxVQUFJLE9BQU8sR0FBRyxDQUFDO0FBQUcsVUFBSSxPQUFPLElBQUksRUFBRTtBQUFHLFVBQUksT0FBTztBQUFBLElBQzVGLFdBQVcsS0FBSyxTQUFTLFFBQVE7QUFDN0IsVUFBSSxZQUFZO0FBQ2hCLFVBQUksVUFBVTtBQUNkLGVBQVEsSUFBRSxHQUFHLElBQUUsSUFBSSxLQUFLO0FBQ3BCLFlBQUksSUFBSSxLQUFLLFVBQVUsSUFBRSxNQUFNLElBQUksTUFBTTtBQUN6QyxZQUFJLE9BQU8sS0FBSyxJQUFJLElBQUksS0FBSyxLQUFHLENBQUMsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEtBQUssS0FBRyxDQUFDLElBQUksQ0FBQztBQUFBLE1BQ3ZFO0FBQ0EsVUFBSSxVQUFVO0FBQUcsVUFBSSxLQUFLO0FBQUcsVUFBSSxPQUFPO0FBQ3hDLFVBQUksWUFBWSxLQUFLLFFBQVEsSUFBSSxTQUFTLEtBQUs7QUFDL0MsVUFBSSxVQUFVO0FBQUcsVUFBSSxJQUFJLEdBQUcsR0FBRyxLQUFLLFNBQVMsS0FBSyxHQUFHLEtBQUssS0FBRyxDQUFDO0FBQUcsVUFBSSxLQUFLO0FBQUcsVUFBSSxPQUFPO0FBQ3hGLFVBQUksWUFBWTtBQUNoQixVQUFJLFVBQVU7QUFBRyxVQUFJLE9BQU8sQ0FBQyxLQUFLLFNBQU8sS0FBSyxDQUFDLEtBQUssU0FBTyxHQUFHO0FBQUcsVUFBSSxPQUFPLENBQUMsS0FBSyxTQUFPLEtBQUssQ0FBQyxLQUFLLFNBQU8sR0FBRztBQUFHLFVBQUksT0FBTyxDQUFDLEtBQUssU0FBTyxLQUFLLENBQUMsS0FBSyxTQUFPLEdBQUc7QUFBRyxVQUFJLEtBQUs7QUFDMUssVUFBSSxVQUFVO0FBQUcsVUFBSSxPQUFPLEtBQUssU0FBTyxLQUFLLENBQUMsS0FBSyxTQUFPLEdBQUc7QUFBRyxVQUFJLE9BQU8sS0FBSyxTQUFPLEtBQUssQ0FBQyxLQUFLLFNBQU8sR0FBRztBQUFHLFVBQUksT0FBTyxLQUFLLFNBQU8sS0FBSyxDQUFDLEtBQUssU0FBTyxHQUFHO0FBQUcsVUFBSSxLQUFLO0FBQUEsSUFDM0ssV0FBVyxLQUFLLFNBQVMsVUFBVTtBQUMvQixVQUFJLFVBQVU7QUFBRyxVQUFJLElBQUksR0FBRyxHQUFHLEtBQUssUUFBUSxHQUFHLEtBQUssS0FBRyxDQUFDO0FBQUcsVUFBSSxLQUFLO0FBQUcsVUFBSSxPQUFPO0FBQ2xGLFVBQUksVUFBVTtBQUFHLFVBQUksT0FBTyxLQUFLLENBQUMsS0FBSyxNQUFNO0FBQUcsVUFBSSxPQUFPLEtBQUssQ0FBQyxLQUFLLFNBQVMsRUFBRTtBQUFHLFVBQUksT0FBTztBQUMvRixVQUFJLFVBQVU7QUFBRyxVQUFJLE9BQU8sSUFBSSxDQUFDLEtBQUssTUFBTTtBQUFHLFVBQUksT0FBTyxJQUFJLENBQUMsS0FBSyxTQUFTLEVBQUU7QUFBRyxVQUFJLE9BQU87QUFDN0YsVUFBSSxZQUFZO0FBQVcsVUFBSSxVQUFVO0FBQUcsVUFBSSxJQUFJLEtBQUssQ0FBQyxLQUFLLFNBQVMsSUFBSSxHQUFHLEdBQUcsS0FBSyxLQUFHLENBQUM7QUFBRyxVQUFJLEtBQUs7QUFBRyxVQUFJLElBQUksSUFBSSxDQUFDLEtBQUssU0FBUyxJQUFJLEdBQUcsR0FBRyxLQUFLLEtBQUcsQ0FBQztBQUFHLFVBQUksS0FBSztBQUFBLElBQ3hLLE9BQU87QUFDSCxVQUFJLFVBQVU7QUFBRyxVQUFJLElBQUksR0FBRyxHQUFHLEtBQUssVUFBVSxLQUFLLFNBQVMsYUFBYSxLQUFLLGVBQWUsSUFBSSxHQUFHLEtBQUssS0FBRyxDQUFDO0FBQUcsVUFBSSxLQUFLO0FBQUcsVUFBSSxPQUFPO0FBQ3ZJLFVBQUksS0FBSyxTQUFTLFdBQVcsS0FBSyxlQUFlLFNBQVM7QUFDdEQsWUFBSSxjQUFjO0FBQ2xCLFlBQUksY0FBYztBQUFXLFlBQUksWUFBWTtBQUM3QyxZQUFJLFVBQVU7QUFBRyxZQUFJLElBQUksR0FBRyxHQUFHLEtBQUssU0FBUyxHQUFHLEdBQUcsS0FBSyxLQUFHLENBQUM7QUFBRyxZQUFJLE9BQU87QUFDMUUsWUFBSSxjQUFjO0FBQUEsTUFDdEI7QUFBQSxJQUNKO0FBRUEsUUFBSSxLQUFLLFNBQVMsVUFBVTtBQUN4QixVQUFJLFlBQVk7QUFBUSxVQUFJLFVBQVU7QUFBRyxVQUFJLElBQUksR0FBRyxJQUFJLElBQUksR0FBRyxLQUFLLEtBQUcsQ0FBQztBQUFHLFVBQUksS0FBSztBQUNwRixVQUFJLFlBQVk7QUFBUSxVQUFJLFVBQVU7QUFBRyxVQUFJLElBQUksR0FBRyxJQUFJLEdBQUcsR0FBRyxLQUFLLEtBQUcsQ0FBQztBQUFHLFVBQUksS0FBSztBQUFBLElBQ3ZGLE9BQU87QUFDSCxVQUFJLFlBQVksS0FBSyxRQUFRLElBQUksWUFBYSxLQUFLLFNBQVMsU0FBUyxZQUFZO0FBQ2pGLFVBQUksVUFBVTtBQUNkLFVBQUksS0FBSyxTQUFTLFFBQVE7QUFDdEIsWUFBSSxPQUFPLENBQUMsS0FBSyxTQUFPLEtBQUssRUFBRTtBQUFHLFlBQUksT0FBTyxDQUFDLEtBQUssU0FBTyxLQUFLLEVBQUU7QUFBRyxZQUFJLE9BQU8sQ0FBQyxLQUFLLFNBQU8sS0FBSyxDQUFDO0FBQ2xHLFlBQUksT0FBTyxLQUFLLFNBQU8sS0FBSyxFQUFFO0FBQUcsWUFBSSxPQUFPLEtBQUssU0FBTyxLQUFLLEVBQUU7QUFBRyxZQUFJLE9BQU8sS0FBSyxTQUFPLEtBQUssQ0FBQztBQUFBLE1BQ25HLE9BQU87QUFDSCxZQUFJLE9BQU8sQ0FBQyxLQUFLLFNBQU8sS0FBSyxFQUFFO0FBQUcsWUFBSSxPQUFPLENBQUMsS0FBSyxTQUFPLEtBQUssQ0FBQztBQUFHLFlBQUksT0FBTyxDQUFDLEtBQUssU0FBTyxLQUFLLENBQUM7QUFDakcsWUFBSSxPQUFPLEtBQUssU0FBTyxLQUFLLEVBQUU7QUFBRyxZQUFJLE9BQU8sS0FBSyxTQUFPLEtBQUssQ0FBQztBQUFHLFlBQUksT0FBTyxLQUFLLFNBQU8sS0FBSyxDQUFDO0FBQUEsTUFDbEc7QUFDQSxVQUFJLEtBQUs7QUFDVCxVQUFJLEtBQUssU0FBUyxRQUFRO0FBQ3RCLFlBQUksY0FBYztBQUFRLFlBQUksWUFBWTtBQUMxQyxZQUFJLFVBQVU7QUFBRyxZQUFJLE9BQU8sS0FBSyxFQUFFO0FBQUcsWUFBSSxpQkFBaUIsR0FBRyxJQUFJLElBQUksRUFBRTtBQUFHLFlBQUksT0FBTztBQUFBLE1BQzFGO0FBQUEsSUFDSjtBQUlBLFFBQUksS0FBSyxhQUFhLEtBQUssZ0JBQWdCLFlBQVk7QUFDbkQsVUFBSSxjQUFjO0FBQ2xCLFVBQUksY0FBYztBQUFXLFVBQUksWUFBWTtBQUM3QyxVQUFJLFVBQVU7QUFBRyxVQUFJLElBQUksR0FBRyxHQUFHLEtBQUssU0FBUyxNQUFNLEdBQUcsS0FBSyxLQUFHLENBQUM7QUFBRyxVQUFJLE9BQU87QUFDN0UsVUFBSSxjQUFjO0FBQUEsSUFDdEI7QUFDQSxRQUFJLFFBQVE7QUFFWixRQUFHLEtBQUssS0FBSyxLQUFLLE9BQU87QUFDckIsVUFBSSxZQUFZO0FBQW1CLFVBQUksU0FBUyxLQUFLLElBQUksSUFBSSxJQUFJLElBQUksS0FBSyxJQUFJLElBQUksSUFBSSxLQUFLLFNBQVMsSUFBSSxJQUFJLENBQUM7QUFDN0csVUFBSSxZQUFZO0FBQVcsVUFBSSxTQUFTLEtBQUssSUFBSSxJQUFJLElBQUksSUFBSSxLQUFLLElBQUksSUFBSSxJQUFJLEtBQUssU0FBUyxJQUFJLE1BQU0sS0FBSyxLQUFHLEtBQUssUUFBUSxDQUFDO0FBQUEsSUFDaEk7QUFBQSxFQUNKO0FBQ0o7QUFFQSxLQUFLLGtCQUFrQixTQUFTLEdBQUcsR0FBRyxPQUFPLFFBQVEsVUFBVSxPQUFPO0FBQ2xFLE1BQUksSUFBSSxLQUFLLFlBQVksS0FBSyxDQUFBSixPQUFLLENBQUNBLEdBQUUsTUFBTTtBQUM1QyxNQUFHLEVBQUcsR0FBRSxLQUFLLEdBQUcsR0FBRyxPQUFPLFFBQVEsT0FBTztBQUM3QztBQVFBLE1BQU0sWUFBWTtBQUFBLEVBQ2QsV0FBVztBQUFBLEVBQ1gsYUFBYTtBQUFBLEVBQ2IsU0FBUyxFQUFFLE1BQU0sSUFBSSxNQUFNLEdBQUcsUUFBUSxHQUFHLE1BQU0sR0FBRyxPQUFPLEdBQUcsV0FBVyxHQUFHLFVBQVUsR0FBRyxPQUFPLEVBQUU7QUFBQSxFQUNoRyxnQkFBZ0I7QUFBQSxFQUNoQixlQUFlO0FBQUEsRUFDZixrQkFBa0I7QUFDdEI7QUFFQSxTQUFTLGNBQWMsT0FBTztBQUMxQixTQUFPLEtBQUssTUFBTSxVQUFVLFlBQVksS0FBSyxJQUFJLFVBQVUsYUFBYSxRQUFRLENBQUMsQ0FBQztBQUN0RjtBQUVBLE1BQU0sY0FBYyxVQUFVO0FBQzlCLE1BQU0sc0JBQXNCLFVBQVU7QUFDdEMsU0FBUyxlQUFlLE1BQU07QUFBRSxTQUFPLFVBQVUsZ0JBQWdCLE9BQU8sVUFBVTtBQUFrQjtBQUVwRyxNQUFNLGdCQUFnQjtBQUFBLEVBQ2xCLEdBQUksRUFBRSxNQUFNLFNBQVMsUUFBUSxLQUFLLE9BQU8sUUFBUTtBQUFBLEVBQ2pELElBQUksRUFBRSxNQUFNLFlBQVksUUFBUSxJQUFJLE9BQU8sZ0JBQVM7QUFBQSxFQUNwRCxJQUFJLEVBQUUsTUFBTSxPQUFPLE9BQU8sT0FBTztBQUFBLEVBQ2pDLElBQUksRUFBRSxNQUFNLFNBQVMsUUFBUSxLQUFLLE9BQU8sUUFBUTtBQUFBLEVBQ2pELElBQUksRUFBRSxNQUFNLFlBQVksUUFBUSxJQUFJLE9BQU8sZ0JBQVM7QUFBQSxFQUNwRCxJQUFJLEVBQUUsTUFBTSxRQUFRLE9BQU8sT0FBTztBQUFBLEVBQ2xDLElBQUksRUFBRSxNQUFNLFNBQVMsT0FBTyxZQUFTO0FBQUEsRUFDckMsSUFBSSxFQUFFLE1BQU0sWUFBWSxRQUFRLEtBQUssT0FBTyxpQkFBVTtBQUMxRDtBQUVBLE1BQU0sMEJBQTBCO0FBQUEsRUFDNUIsT0FBTztBQUFBLEVBQUcsSUFBSTtBQUFBLEVBQ2QsYUFBYTtBQUFBLEVBQUcsT0FBTztBQUFBLEVBQUcsUUFBUTtBQUFBLEVBQ2xDLFlBQVk7QUFBQSxFQUFHLFVBQVU7QUFBQSxFQUN6QixhQUFhLENBQUM7QUFBQSxFQUFHLFVBQVU7QUFBQSxFQUFHLFVBQVU7QUFBQSxFQUN4QyxTQUFTLENBQUM7QUFBQSxFQUFHLFVBQVU7QUFDM0I7QUFDQSxNQUFNLGdCQUFnQixPQUFPLE9BQU8sQ0FBQyxHQUFHLHlCQUF5QixXQUFXLElBQUksV0FBVyxDQUFDLENBQUMsQ0FBQztBQUU5RixjQUFjLE9BQU8sV0FBVztBQUFFLGFBQVcsSUFBSSxXQUFXLElBQUk7QUFBRztBQUVuRSxjQUFjLFFBQVEsV0FBVztBQUM3QixTQUFPLEtBQUssdUJBQXVCLEVBQUUsUUFBUSxPQUFLO0FBQzlDLFVBQU0sSUFBSSx3QkFBd0IsQ0FBQztBQUNuQyxTQUFLLENBQUMsSUFBSSxNQUFNLFFBQVEsQ0FBQyxJQUFJLENBQUMsSUFBSyxLQUFLLE9BQU8sTUFBTSxXQUFXLENBQUMsSUFBSTtBQUFBLEVBQ3pFLENBQUM7QUFDRCxPQUFLLEtBQUs7QUFDVixNQUFJLE9BQU8sU0FBUyxlQUFlLEtBQUssZUFBZ0IsTUFBSyxlQUFlO0FBQ2hGO0FBRUEsS0FBSyxVQUFVLFNBQVMsUUFBUTtBQUM1QixXQUFTLEtBQUssTUFBTSxNQUFNO0FBQzFCLE1BQUksVUFBVSxFQUFHO0FBQ2pCLGdCQUFjLE1BQU07QUFDcEIsTUFBSSxZQUFZO0FBQ2hCLFNBQU8sY0FBYyxNQUFNLGNBQWMsY0FBYyxLQUFLLEdBQUc7QUFDM0Qsa0JBQWMsTUFBTSxjQUFjLGNBQWMsS0FBSztBQUNyRCxrQkFBYztBQUNkLGdCQUFZO0FBQ1osU0FBSyxpQkFBaUIsY0FBYyxLQUFLO0FBQUEsRUFDN0M7QUFDQSxNQUFJLFVBQVcsTUFBSyxZQUFZLGNBQWMsS0FBSztBQUNuRCxnQkFBYyxLQUFLO0FBQ3ZCO0FBRUEsS0FBSyxnQkFBZ0IsU0FBUyxRQUFRO0FBQ2xDLFdBQVMsS0FBSyxNQUFNLE1BQU07QUFDMUIsTUFBSSxVQUFVLEVBQUc7QUFDakIsZ0JBQWMsWUFBWTtBQUMxQixnQkFBYyxLQUFLO0FBQ3ZCO0FBRUEsS0FBSyxtQkFBbUIsU0FBUyxPQUFPO0FBQ3BDLFFBQU1HLFVBQVMsY0FBYyxLQUFLO0FBQ2xDLE1BQUksQ0FBQ0EsUUFBUTtBQUNiLE1BQUlBLFFBQU8sU0FBUyxXQUFXLEtBQUssT0FBUSxNQUFLLE9BQU8sU0FBU0EsUUFBTztBQUN4RSxNQUFJQSxRQUFPLFNBQVMsV0FBWSxNQUFLLGNBQWNBLFFBQU8sTUFBTTtBQUNoRSxnQkFBYyxRQUFRLEtBQUssRUFBRSxPQUFPLE1BQU1BLFFBQU8sTUFBTSxPQUFPQSxRQUFPLE1BQU0sQ0FBQztBQUNoRjtBQUVBLEtBQUssY0FBYyxTQUFTLE9BQU87QUFDL0IsVUFBUSxXQUFXLEtBQUssSUFBSTtBQUM1QixRQUFNLEtBQUssU0FBUyxlQUFlLGVBQWU7QUFDbEQsTUFBSSxDQUFDLEdBQUk7QUFDVCxRQUFNQSxVQUFTLGNBQWMsS0FBSztBQUNsQyxLQUFHLFlBQVksYUFBVSxLQUFLLE9BQU9BLFVBQVMsU0FBU0EsUUFBTyxLQUFLLFlBQVk7QUFDL0UsS0FBRyxVQUFVLE9BQU8sTUFBTTtBQUMxQixPQUFLLEdBQUc7QUFDUixLQUFHLFVBQVUsSUFBSSxNQUFNO0FBQ3ZCLGVBQWEsS0FBSyxrQkFBa0I7QUFDcEMsT0FBSyxxQkFBcUIsV0FBVyxNQUFNLEdBQUcsVUFBVSxPQUFPLE1BQU0sR0FBRyxJQUFJO0FBQ2hGO0FBRUEsS0FBSyxpQkFBaUIsV0FBVztBQUM3QixRQUFNLFFBQVEsU0FBUyxlQUFlLGVBQWU7QUFDckQsUUFBTSxPQUFPLFNBQVMsZUFBZSxVQUFVO0FBQy9DLE1BQUksQ0FBQyxTQUFTLENBQUMsS0FBTTtBQUNyQixRQUFNLFlBQVksV0FBVyxjQUFjO0FBQzNDLE9BQUssTUFBTSxRQUFRLEtBQUssSUFBSSxLQUFNLGNBQWMsS0FBSyxjQUFjLGNBQWMsS0FBSyxJQUFLLEdBQUcsSUFBSTtBQUN0RztBQUVBLEtBQUssY0FBYyxXQUFXO0FBQzFCLFdBQVMsZUFBZSxjQUFjLEVBQUUsTUFBTSxVQUFVO0FBQ3hELFFBQU0sSUFBSTtBQUNWLFFBQU0sTUFBTSxFQUFFLGFBQWEsSUFBSSxLQUFLLElBQUksS0FBSyxLQUFLLE1BQU0sRUFBRSxXQUFXLEVBQUUsYUFBYSxHQUFHLENBQUMsSUFBSTtBQUM1RixRQUFNLFdBQVcsT0FBTyxRQUFRLEVBQUUsV0FBVyxFQUFFLEtBQUssQ0FBQyxHQUFHLE1BQU0sRUFBRSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDO0FBQzVFLFFBQU0sWUFBWSxXQUFXLFNBQVMsQ0FBQyxJQUFJO0FBQzNDLFFBQU0sVUFBVSxLQUFLLFVBQVUsS0FBSyxPQUFPLEtBQUssSUFBSSxJQUFJLEtBQUssYUFBYSxHQUFJLElBQUk7QUFDbEYsUUFBTSxXQUFXLEVBQUUsY0FBYztBQUNqQyxRQUFNLEtBQUssT0FBTyxLQUFLLE1BQU0sV0FBVyxFQUFFLENBQUMsRUFBRSxTQUFTLEdBQUcsR0FBRyxHQUFHLEtBQUssT0FBTyxXQUFXLEVBQUUsRUFBRSxTQUFTLEdBQUcsR0FBRztBQUN6RyxRQUFNLE9BQU87QUFBQSxJQUNULENBQUMsVUFBVSxPQUFPLFdBQVcsY0FBYyxPQUFPLGFBQWEsSUFBSSxrQkFBa0I7QUFBQSxJQUNyRixDQUFDLFNBQVMsRUFBRSxLQUFLO0FBQUEsSUFDakIsQ0FBQyxNQUFNLEdBQUcsRUFBRSxFQUFFLE1BQU0sY0FBYyxFQUFFLEtBQUssQ0FBQyxFQUFFO0FBQUEsSUFDNUMsQ0FBQyxhQUFhLGVBQVEsRUFBRSxRQUFRO0FBQUEsSUFDaEMsQ0FBQyxpQkFBaUIsR0FBRyxFQUFFLElBQUksRUFBRSxFQUFFO0FBQUEsSUFDL0IsQ0FBQyxzQkFBc0IsRUFBRSxLQUFLO0FBQUEsSUFDOUIsQ0FBQyxnQkFBYSxNQUFNLEdBQUc7QUFBQSxJQUN2QixDQUFDLGlCQUFpQixTQUFTO0FBQUEsSUFDM0IsQ0FBQyx1QkFBdUIsS0FBSyxNQUFNLEVBQUUsUUFBUSxJQUFJLElBQUk7QUFBQSxJQUNyRCxDQUFDLGdCQUFnQixFQUFFLFFBQVE7QUFBQSxJQUMzQixDQUFDLFdBQVcsRUFBRSxNQUFNO0FBQUEsRUFDeEI7QUFDQSxXQUFTLGVBQWUsZUFBZSxFQUFFLFlBQVksS0FBSztBQUFBLElBQUksQ0FBQyxDQUFDLE9BQU8sR0FBRyxNQUN0RSx1REFBdUQsS0FBSyxpQ0FBaUMsR0FBRztBQUFBLEVBQ3BHLEVBQUUsS0FBSyxFQUFFO0FBQ1QsV0FBUyxlQUFlLGdCQUFnQixFQUFFLE1BQU0sVUFBVTtBQUM5RDtBQUNBLEtBQUssZUFBZSxXQUFXO0FBQzNCLFdBQVMsZUFBZSxnQkFBZ0IsRUFBRSxNQUFNLFVBQVU7QUFDMUQsV0FBUyxlQUFlLGNBQWMsRUFBRSxNQUFNLFVBQVU7QUFDNUQ7QUFFQSxNQUFNLHFCQUFxQixLQUFLO0FBQ2hDLEtBQUssV0FBVyxTQUFTLEdBQUcsS0FBSyxNQUFNO0FBM3ZGdkM7QUE0dkZJLFFBQU0sV0FBVyxDQUFDLEVBQUU7QUFDcEIscUJBQW1CLEtBQUssTUFBTSxHQUFHLEdBQUc7QUFDcEMsTUFBSSxRQUFRLEtBQUssY0FBYyxDQUFDLEtBQUssb0JBQW9CO0FBQ3JELGtCQUFjO0FBQ2QsU0FBSyxxQkFBcUI7QUFBQSxFQUM5QjtBQUNBLE1BQUksWUFBWSxFQUFFLFNBQVM7QUFDdkIsa0JBQWM7QUFDZCxVQUFNLElBQUksS0FBSyxVQUFVLEtBQUssT0FBTztBQUNyQyxRQUFJLEVBQUcsZUFBYyxZQUFZLEVBQUUsSUFBSSxLQUFLLGNBQWMsWUFBWSxFQUFFLElBQUksS0FBSyxLQUFLO0FBQ3RGLFNBQUssU0FBUSxpQkFBWSxFQUFFLElBQUksTUFBbEIsWUFBdUIsbUJBQW1CO0FBQUEsRUFDM0Q7QUFDSjtBQUVBLE1BQU0sa0JBQWtCLEtBQUs7QUFDN0IsS0FBSyxRQUFRLFdBQVc7QUFDcEIsUUFBTSxJQUFJLEtBQUssVUFBVSxLQUFLLE9BQU87QUFDckMsUUFBTSxlQUFlLEtBQUs7QUFDMUIsa0JBQWdCLEtBQUssSUFBSTtBQUN6QixNQUFJLEtBQUssS0FBSyxhQUFhLGdCQUFnQixFQUFFLFNBQVMsU0FBUztBQUMzRCxrQkFBYztBQUNkLFNBQUsscUJBQXFCO0FBQUEsRUFDOUI7QUFDSjtBQUVBLE1BQU0seUJBQXlCLE9BQU8sVUFBVTtBQUNoRCxPQUFPLFVBQVUsU0FBUyxTQUFTLE1BQU07QUFDckMsUUFBTSxLQUFLLEtBQUssR0FBRyxLQUFLLEtBQUs7QUFDN0IseUJBQXVCLEtBQUssTUFBTSxJQUFJO0FBQ3RDLFFBQU0sSUFBSSxLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksS0FBSyxJQUFJLEVBQUU7QUFDN0MsTUFBSSxJQUFJLEVBQUcsZUFBYyxZQUFZO0FBQ3pDO0FBRUEsTUFBTSxpQkFBaUIsS0FBSztBQUM1QixLQUFLLE9BQU8sV0FBVztBQUNuQixRQUFNLGFBQWEsS0FBSztBQUN4QixpQkFBZSxLQUFLLElBQUk7QUFDeEIsTUFBSSxLQUFLLFNBQVMsWUFBWTtBQUMxQixTQUFLLFFBQVEsZUFBZSxVQUFVLENBQUM7QUFDdkMsa0JBQWMsV0FBVyxLQUFLLElBQUksY0FBYyxVQUFVLFVBQVU7QUFDcEUsa0JBQWMsS0FBSztBQUFBLEVBQ3ZCO0FBQ0EsT0FBSyxlQUFlO0FBQ3hCO0FBRUEsTUFBTSxxQkFBcUIsS0FBSztBQUNoQyxLQUFLLFdBQVcsV0FBVztBQUN2QixnQkFBYztBQUNkLGdCQUFjLGVBQWUsS0FBSyxPQUFPLEtBQUssSUFBSSxJQUFJLEtBQUssYUFBYSxHQUFJO0FBQzVFLGdCQUFjLFdBQVcsS0FBSyxJQUFJLGNBQWMsVUFBVSxLQUFLLE9BQU8sQ0FBQztBQUN2RSxnQkFBYyxLQUFLO0FBQ25CLHFCQUFtQixLQUFLLElBQUk7QUFDaEM7QUFFQSxPQUFPLGlCQUFpQixnQkFBZ0IsTUFBTSxjQUFjLEtBQUssQ0FBQztBQUVsRSxXQUFXLGFBQWEsU0FBUyxNQUFNO0FBQ25DLE1BQUksQ0FBQyxLQUFLLFNBQVMsU0FBUyxFQUFHO0FBQy9CLFNBQU8sT0FBTyxlQUFlLFdBQVcsSUFBSSxXQUFXLENBQUMsQ0FBQyxDQUFDO0FBQzFELE9BQUssZUFBZTtBQUN4QixDQUFDO0FBRUQsT0FBTyxpQkFBaUIsb0JBQW9CLE1BQU07QUFDOUMsUUFBTSxRQUFRLFNBQVMsY0FBYywyQkFBMkI7QUFDaEUsTUFBSSxPQUFPO0FBQ1AsVUFBTSxNQUFNLFNBQVMsY0FBYyxRQUFRO0FBQzNDLFFBQUksWUFBWTtBQUNoQixRQUFJLGNBQWM7QUFDbEIsUUFBSSxVQUFVLE1BQU0sS0FBSyxZQUFZO0FBQ3JDLFVBQU0sWUFBWSxHQUFHO0FBQUEsRUFDekI7QUFDQSxPQUFLLGVBQWU7QUFDeEIsQ0FBQztBQVFELE1BQU0sY0FBYztBQUFBLEVBQ2hCLFVBQVcsRUFBRSxNQUFNLGFBQWdCLE1BQU0sOEJBQWtDLE1BQU0sZ0JBQU0sVUFBVSxHQUFHLFVBQVUsS0FBSyxZQUFZLElBQUk7QUFBQSxFQUNuSSxXQUFXLEVBQUUsTUFBTSxlQUFnQixNQUFNLG1DQUFrQyxNQUFNLGFBQU0sVUFBVSxHQUFHLFVBQVUsS0FBSyxZQUFZLElBQUk7QUFBQSxFQUNuSSxXQUFXLEVBQUUsTUFBTSxhQUFnQixNQUFNLHlDQUF5QyxNQUFNLGFBQU0sVUFBVSxHQUFHLFVBQVUsS0FBSyxZQUFZLElBQUk7QUFBQSxFQUMxSSxPQUFXLEVBQUUsTUFBTSxTQUFlLE1BQU0sa0NBQWtDLE1BQU0sZ0JBQU0sVUFBVSxHQUFHLFVBQVUsS0FBSyxZQUFZLEtBQUs7QUFBQSxFQUNuSSxTQUFXLEVBQUUsTUFBTSxXQUFlLE1BQU0sK0JBQW1DLE1BQU0sYUFBTSxVQUFVLEdBQUcsVUFBVSxLQUFLLFlBQVksS0FBSztBQUN4STtBQUVBLE1BQU0sY0FBYyxPQUFPLE9BQU8sRUFBRSxRQUFRLENBQUMsRUFBRSxHQUFHLFdBQVcsSUFBSSxlQUFlLENBQUMsQ0FBQyxDQUFDO0FBRW5GLFlBQVksV0FBVyxTQUFTLEdBQUc7QUFBRSxTQUFPLEtBQUssT0FBTyxDQUFDLEtBQUs7QUFBRztBQUVqRSxZQUFZLFVBQVUsU0FBUyxHQUFHO0FBQzlCLFFBQU0sTUFBTSxZQUFZLENBQUM7QUFDekIsTUFBSSxDQUFDLElBQUssUUFBTztBQUNqQixTQUFPLEtBQUssTUFBTSxJQUFJLFdBQVcsS0FBSyxJQUFJLElBQUksWUFBWSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDL0U7QUFFQSxZQUFZLE1BQU0sU0FBUyxHQUFHO0FBQzFCLFFBQU0sTUFBTSxZQUFZLENBQUM7QUFDekIsTUFBSSxDQUFDLElBQUssUUFBTztBQUNqQixRQUFNLE1BQU0sS0FBSyxTQUFTLENBQUM7QUFDM0IsTUFBSSxPQUFPLElBQUksU0FBVSxRQUFPO0FBQ2hDLFFBQU0sT0FBTyxLQUFLLFFBQVEsQ0FBQztBQUMzQixNQUFJLENBQUMsS0FBSyxVQUFVLEtBQUssT0FBTyxRQUFRLEtBQU0sUUFBTztBQUVyRCxPQUFLLE9BQU8sU0FBUztBQUNyQixPQUFLLE9BQU8sQ0FBQyxJQUFJLE1BQU07QUFDdkIsT0FBSyxLQUFLO0FBQ1YsT0FBSyxjQUFjLEtBQUssTUFBTTtBQUM5QixVQUFRLE1BQU07QUFDZCxTQUFPO0FBQ1g7QUFFQSxZQUFZLE9BQU8sV0FBVztBQUFFLGFBQVcsSUFBSSxlQUFlLEVBQUUsUUFBUSxLQUFLLE9BQU8sQ0FBQztBQUFHO0FBRXhGLFlBQVksUUFBUSxXQUFXO0FBQzNCLE9BQUssU0FBUyxDQUFDO0FBQ2YsT0FBSyxLQUFLO0FBQ1YsTUFBSSxLQUFLLE9BQVEsTUFBSyxjQUFjLEtBQUssTUFBTTtBQUMvQyxNQUFJLE9BQU8sS0FBSyxtQkFBbUIsV0FBWSxNQUFLLGVBQWU7QUFDdkU7QUFFQSxZQUFZLGdCQUFnQixTQUFTLEdBQUc7QUFDcEMsTUFBSSxDQUFDLEVBQUc7QUFDUixRQUFNLE1BQU0sS0FBSyxTQUFTLFVBQVU7QUFDcEMsUUFBTSxNQUFNLEtBQUssU0FBUyxXQUFXO0FBQ3JDLFFBQU0sV0FBVyxNQUFNLE1BQU07QUFDN0IsUUFBTSxnQkFBZ0IsTUFBTSxNQUFNO0FBQ2xDLElBQUUsS0FBSyxLQUFLLElBQUksVUFBVSxFQUFFLE1BQU0sV0FBVyxFQUFFLE1BQU07QUFDckQsSUFBRSxRQUFRO0FBQ1YsSUFBRSxVQUFVLEtBQUssSUFBSSxlQUFlLEVBQUUsV0FBVyxnQkFBZ0IsRUFBRSxXQUFXO0FBQzlFLElBQUUsYUFBYTtBQUNuQjtBQUVBLE1BQU0sZ0JBQWdCLEtBQUs7QUFDM0IsS0FBSyxPQUFPLFdBQVc7QUFDbkIsZ0JBQWMsS0FBSyxJQUFJO0FBQ3ZCLGNBQVksY0FBYyxLQUFLLE1BQU07QUFDekM7QUFFQSxNQUFNLGlCQUFpQixLQUFLO0FBQzVCLEtBQUssUUFBUSxXQUFXO0FBQ3BCLFFBQU0sSUFBSSxLQUFLLFVBQVUsS0FBSyxPQUFPO0FBQ3JDLFFBQU0sTUFBTSxZQUFZLFNBQVMsT0FBTztBQUN4QyxNQUFJLEtBQUssTUFBTSxLQUFLLEtBQUsseUJBQXlCLFFBQVc7QUFDekQsU0FBSyx1QkFBdUIsRUFBRTtBQUM5QixNQUFFLFNBQVMsS0FBSyxNQUFNLEtBQUssd0JBQXdCLElBQUksT0FBTyxJQUFJO0FBQUEsRUFDdEU7QUFDQSxpQkFBZSxLQUFLLElBQUk7QUFDeEIsTUFBSSxLQUFLLHlCQUF5QixVQUFhLEVBQUUsS0FBSyxVQUFVLEtBQUssT0FBTyxZQUFZO0FBQ3BGLE1BQUUsU0FBUyxLQUFLO0FBQ2hCLFNBQUssdUJBQXVCO0FBQUEsRUFDaEM7QUFDSjtBQUVBLE1BQU0sd0JBQXdCLE9BQU8sVUFBVTtBQUMvQyxPQUFPLFVBQVUsU0FBUyxTQUFTLE1BQU07QUFDckMsUUFBTSxLQUFLLEtBQUssR0FBRyxLQUFLLEtBQUs7QUFDN0Isd0JBQXNCLEtBQUssTUFBTSxJQUFJO0FBQ3JDLFFBQU0sTUFBTSxZQUFZLFNBQVMsV0FBVztBQUM1QyxNQUFJLE1BQU0sS0FBSyxDQUFDLEtBQUssV0FBVztBQUM1QixVQUFNLEtBQUssS0FBSyxJQUFJLElBQUksS0FBSyxLQUFLLElBQUk7QUFDdEMsUUFBSSxPQUFPLEtBQUssT0FBTyxHQUFHO0FBQ3RCLFlBQU0sUUFBUSxNQUFNO0FBQ3BCLFdBQUssSUFBSSxLQUFLLElBQUksS0FBSyxRQUFRLEtBQUssSUFBSSxXQUFXLEtBQUssUUFBUSxLQUFLLElBQUksS0FBSyxLQUFLLENBQUM7QUFDcEYsV0FBSyxJQUFJLEtBQUssSUFBSSxLQUFLLFFBQVEsS0FBSyxJQUFJLFdBQVcsS0FBSyxRQUFRLEtBQUssSUFBSSxLQUFLLEtBQUssQ0FBQztBQUFBLElBQ3hGO0FBQUEsRUFDSjtBQUNKO0FBRUEsTUFBTSxvQkFBb0IsS0FBSztBQUMvQixLQUFLLFdBQVcsU0FBUyxHQUFHLFFBQVEsTUFBTTtBQUN0QyxRQUFNLGNBQWMsS0FBSyxTQUFTLEtBQUssT0FBTyxRQUFRO0FBQ3RELG9CQUFrQixLQUFLLE1BQU0sR0FBRyxLQUFLLEdBQUcsSUFBSTtBQUM1QyxRQUFNLE1BQU0sWUFBWSxTQUFTLFNBQVM7QUFDMUMsTUFBSSxNQUFNLEtBQUssS0FBSyxRQUFRO0FBQ3hCLFVBQU0sU0FBUyxLQUFLLE9BQU8sUUFBUTtBQUNuQyxRQUFJLFNBQVMsRUFBRyxNQUFLLE9BQU8sU0FBUyxLQUFLLE1BQU0sVUFBVSxPQUFPLElBQUk7QUFBQSxFQUN6RTtBQUNKO0FBRUEsS0FBSyxpQkFBaUIsV0FBVztBQUM3QixRQUFNLEtBQUssU0FBUyxlQUFlLGVBQWU7QUFDbEQsTUFBSSxDQUFDLEdBQUk7QUFDVCxLQUFHLFlBQVksT0FBTyxLQUFLLFdBQVcsRUFBRSxJQUFJLE9BQUs7QUFDN0MsVUFBTSxNQUFNLFlBQVksQ0FBQztBQUN6QixVQUFNLE1BQU0sWUFBWSxTQUFTLENBQUM7QUFDbEMsVUFBTSxRQUFRLE9BQU8sSUFBSTtBQUN6QixVQUFNLE9BQU8sWUFBWSxRQUFRLENBQUM7QUFDbEMsVUFBTSxTQUFTLFFBQ1QsZ0RBQ0EscURBQXFELENBQUMsUUFBUSxJQUFJO0FBQ3hFLFdBQU87QUFBQSw0Q0FDNkIsSUFBSSxJQUFJLElBQUksSUFBSSxJQUFJLEtBQUssR0FBRyxJQUFJLElBQUksUUFBUTtBQUFBLDhDQUMxQyxJQUFJLElBQUk7QUFBQSxjQUN4QyxNQUFNO0FBQUE7QUFBQSxFQUVoQixDQUFDLEVBQUUsS0FBSyxFQUFFO0FBQ2Q7QUFFQSxLQUFLLGFBQWEsU0FBUyxHQUFHO0FBQzFCLE1BQUksWUFBWSxJQUFJLENBQUMsRUFBRyxNQUFLLGVBQWU7QUFDaEQ7QUFFQSxNQUFNLHVCQUF1QixLQUFLO0FBQ2xDLEtBQUssY0FBYyxXQUFXO0FBQzFCLHVCQUFxQixLQUFLLElBQUk7QUFDOUIsT0FBSyxlQUFlO0FBQ3hCO0FBRUEsV0FBVyxhQUFhLFNBQVMsTUFBTTtBQUNuQyxNQUFJLENBQUMsS0FBSyxTQUFTLGFBQWEsRUFBRztBQUNuQyxRQUFNLFNBQVMsV0FBVyxJQUFJLGVBQWUsRUFBRSxRQUFRLENBQUMsRUFBRSxDQUFDO0FBQzNELGNBQVksU0FBUyxPQUFPLFVBQVUsQ0FBQztBQUN2QyxNQUFJLEtBQUssT0FBUSxhQUFZLGNBQWMsS0FBSyxNQUFNO0FBQ3RELE9BQUssZUFBZTtBQUN4QixDQUFDO0FBU0QsTUFBTSxTQUFTO0FBQUEsRUFDWCxNQUFZLEVBQUUsT0FBTyxRQUFlLE9BQU8sVUFBVTtBQUFBLEVBQ3JELFlBQVksRUFBRSxPQUFPLGlCQUFlLE9BQU8sVUFBVTtBQUFBLEVBQ3JELE9BQVksRUFBRSxPQUFPLFlBQWUsT0FBTyxVQUFVO0FBQUEsRUFDckQsUUFBWSxFQUFFLE9BQU8sYUFBZSxPQUFPLFVBQVU7QUFBQSxFQUNyRCxZQUFZLEVBQUUsT0FBTyxjQUFlLE9BQU8sVUFBVTtBQUN6RDtBQUVBLE1BQU0seUJBQXlCO0FBQUEsRUFDM0IsUUFBYTtBQUFBLEVBQ2IsVUFBYTtBQUFBLEVBQ2IsU0FBYTtBQUFBLEVBQ2IsUUFBYTtBQUFBLEVBQ2IsYUFBYTtBQUFBLEVBQ2IsUUFBYTtBQUFBLEVBQ2IsYUFBYTtBQUFBLEVBQ2IsU0FBYTtBQUNqQjtBQUVBLE1BQU0sa0JBQWtCO0FBQUEsRUFDcEIsT0FBTztBQUFBLEVBQVMsU0FBUztBQUFBLEVBQVMsVUFBVTtBQUFBLEVBQzVDLEtBQUs7QUFBQSxFQUFVLFVBQVU7QUFBQSxFQUN6QixLQUFLO0FBQUEsRUFBTyxLQUFLO0FBQUEsRUFBTyxLQUFLO0FBQUEsRUFDN0IsU0FBUztBQUFBLEVBQVcsVUFBVTtBQUFBLEVBQVcsTUFBTTtBQUFBLEVBQy9DLE1BQU07QUFBQSxFQUFTLE1BQU07QUFBQSxFQUFTLE9BQU87QUFBQSxFQUFTLE1BQU07QUFBQSxFQUNwRCxZQUFZO0FBQUEsRUFBVSxLQUFLO0FBQUEsRUFBVSxRQUFRO0FBQUEsRUFDN0MsTUFBTTtBQUFBLEVBQVMsU0FBUztBQUFBLEVBQ3hCLEtBQUs7QUFBQSxFQUFXLGNBQWM7QUFBQSxFQUFXLFVBQVU7QUFDdkQ7QUFDQSxNQUFNLHFCQUFxQixPQUFPLEtBQUssZUFBZSxFQUFFO0FBRXhELE1BQU0sZ0JBQWdCO0FBQUEsRUFDbEIsT0FBUyxFQUFFLE1BQU0sWUFBSztBQUFBLEVBQ3RCLFFBQVMsRUFBRSxNQUFNLFlBQUs7QUFBQSxFQUN0QixLQUFTLEVBQUUsTUFBTSxZQUFLO0FBQUEsRUFDdEIsU0FBUyxFQUFFLE1BQU0sWUFBSztBQUFBLEVBQ3RCLE9BQVMsRUFBRSxNQUFNLFlBQUs7QUFBQSxFQUN0QixRQUFTLEVBQUUsTUFBTSxZQUFLO0FBQUEsRUFDdEIsT0FBUyxFQUFFLE1BQU0sWUFBSztBQUFBLEVBQ3RCLFNBQVMsRUFBRSxNQUFNLFlBQUs7QUFDMUI7QUFFQSxTQUFTLElBQUksR0FBRztBQUFFLFNBQU8sRUFBRSxlQUFlLE9BQU87QUFBRztBQUVwRCxTQUFTLE9BQU8sTUFBTTtBQUNsQixTQUFPLFFBQVEsQ0FBQztBQUNoQixRQUFNLEtBQUssS0FBSyxNQUFNLEdBQUcsUUFBUSxLQUFLLFNBQVMsR0FBRyxXQUFXLEtBQUssWUFBWTtBQUM5RSxRQUFNLFdBQVcsS0FBSyxZQUFZO0FBQ2xDLFFBQU0sUUFBUSxDQUFDO0FBQ2YsTUFBSSxHQUFJLE9BQU0sS0FBSyxJQUFJLElBQUksRUFBRSxDQUFDLEtBQUs7QUFDbkMsTUFBSSxNQUFPLE9BQU0sS0FBSyxLQUFLLElBQUksS0FBSyxDQUFDLEVBQUU7QUFDdkMsTUFBSSxTQUFVLE9BQU0sS0FBSyxJQUFJLElBQUksUUFBUSxDQUFDLFlBQUs7QUFDL0MsTUFBSSxZQUFZLEtBQUssTUFBTyxPQUFNLEtBQUssS0FBSyxLQUFLO0FBQ2pELFNBQU8sRUFBRSxJQUFJLE9BQU8sVUFBVSxPQUFPLE1BQU0sS0FBSyxJQUFJLEtBQUssS0FBSyxTQUFTLElBQUksU0FBUztBQUN4RjtBQUVBLE1BQU0sNkJBQTZCO0FBQUEsRUFDL0IsV0FBVztBQUFBLEVBQUcsZUFBZSxDQUFDO0FBQUEsRUFBRyxhQUFhLENBQUM7QUFBQSxFQUFHLFNBQVM7QUFBQSxFQUMzRCxtQkFBbUI7QUFBQSxFQUFHLGdCQUFnQjtBQUFBLEVBQUcsZ0JBQWdCO0FBQUEsRUFDekQsY0FBYztBQUFBLEVBQUcsaUJBQWlCO0FBQUEsRUFBRyxxQkFBcUIsQ0FBQztBQUFBLEVBQzNELGtCQUFrQjtBQUFBLEVBQUcsc0JBQXNCO0FBQUEsRUFBTyxhQUFhO0FBQUEsRUFDL0QsY0FBYztBQUFBLEVBQUcsaUJBQWlCLENBQUM7QUFBQSxFQUFHLGdCQUFnQjtBQUFBLEVBQUcsVUFBVTtBQUFBLEVBQ25FLGlCQUFpQjtBQUFBLEVBQUcsYUFBYTtBQUFBLEVBQUcsbUJBQW1CLENBQUM7QUFBQSxFQUFHLGFBQWE7QUFBQSxFQUN4RSxjQUFjO0FBQ2xCO0FBQ0EsTUFBTSxtQkFBbUIsT0FBTyxPQUFPLENBQUMsR0FBRyw0QkFBNEIsV0FBVyxJQUFJLGNBQWMsQ0FBQyxDQUFDLENBQUM7QUFFdkcsTUFBTSxtQkFBbUIsV0FBVyxJQUFJLGNBQWMsQ0FBQyxDQUFDO0FBRXhELE1BQU0sa0JBQWtCLENBQUM7QUFFekIsU0FBUyxXQUFXLFVBQVUsVUFBVSxNQUFNLFNBQVMsUUFBUSxRQUFRLFlBQVksUUFBUSxRQUFRO0FBQy9GLFNBQU8sUUFBUSxDQUFDLEdBQUcsTUFBTTtBQUNyQixvQkFBZ0IsR0FBRyxRQUFRLElBQUksSUFBSSxDQUFDLEVBQUUsSUFBSTtBQUFBLE1BQ3RDLElBQUksR0FBRyxRQUFRLElBQUksSUFBSSxDQUFDO0FBQUEsTUFBSTtBQUFBLE1BQVU7QUFBQSxNQUFNO0FBQUEsTUFDNUMsTUFBTSxPQUFPLEVBQUUsUUFBUSxJQUFJLENBQUM7QUFBQSxNQUFHLE1BQU0sT0FBTyxFQUFFLFFBQVEsSUFBSSxDQUFDO0FBQUEsTUFDM0QsUUFBUSxFQUFFO0FBQUEsTUFBUSxRQUFRLEVBQUU7QUFBQSxNQUFRLFVBQVU7QUFBQSxNQUM5QyxRQUFRLE9BQU8sQ0FBQztBQUFBLE1BQUcsUUFBUSxDQUFDLENBQUM7QUFBQSxJQUNqQztBQUFBLEVBQ0osQ0FBQztBQUNMO0FBQ0EsU0FBUyxZQUFZLElBQUksVUFBVSxNQUFNLFNBQVMsTUFBTSxNQUFNLFFBQVEsUUFBUSxVQUFVLFlBQVksUUFBUTtBQUN4RyxrQkFBZ0IsRUFBRSxJQUFJLEVBQUUsSUFBSSxVQUFVLE1BQU0sU0FBUyxNQUFNLE1BQU0sUUFBUSxRQUFRLFVBQVUsUUFBUSxPQUFPLFVBQVUsR0FBRyxRQUFRLENBQUMsQ0FBQyxPQUFPO0FBQzVJO0FBRUE7QUFBQSxFQUFXO0FBQUEsRUFBZTtBQUFBLEVBQVU7QUFBQSxFQUFNO0FBQUEsRUFDdEMsT0FBSyxpQkFBaUIsSUFBSSxDQUFDLENBQUM7QUFBQSxFQUFLLE9BQUssV0FBVyxJQUFJLENBQUMsQ0FBQztBQUFBLEVBQ3ZELE1BQU0sY0FBYztBQUFBLEVBQ3BCO0FBQUEsSUFBQyxFQUFFLFFBQVEsS0FBSyxRQUFRLFFBQVEsSUFBSSxJQUFJLE9BQU8sR0FBRztBQUFBLElBQUcsRUFBRSxRQUFRLEtBQU0sUUFBUSxjQUFjLElBQUksS0FBSyxPQUFPLElBQUk7QUFBQSxJQUM5RyxFQUFFLFFBQVEsS0FBTyxRQUFRLFNBQVMsSUFBSSxLQUFLLE9BQU8sS0FBSztBQUFBLElBQUcsRUFBRSxRQUFRLEtBQVEsUUFBUSxjQUFjLElBQUksTUFBTSxPQUFPLEtBQU0sVUFBVSxJQUFJO0FBQUEsRUFBQztBQUFDO0FBRTlJO0FBQUEsRUFBVztBQUFBLEVBQWM7QUFBQSxFQUFVO0FBQUEsRUFBTTtBQUFBLEVBQ3JDLE9BQUssc0JBQXNCLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFBSyxPQUFLLGFBQWEsSUFBSSxDQUFDLENBQUM7QUFBQSxFQUM5RCxNQUFNLGlCQUFpQjtBQUFBLEVBQ3ZCO0FBQUEsSUFBQyxFQUFFLFFBQVEsR0FBRyxRQUFRLFFBQVEsSUFBSSxJQUFJLE9BQU8sSUFBSTtBQUFBLElBQUcsRUFBRSxRQUFRLElBQUksUUFBUSxjQUFjLElBQUksS0FBSyxPQUFPLElBQUk7QUFBQSxJQUMzRyxFQUFFLFFBQVEsSUFBSSxRQUFRLFNBQVMsSUFBSSxLQUFLLE9BQU8sS0FBSztBQUFBLElBQUcsRUFBRSxRQUFRLEtBQUssUUFBUSxjQUFjLElBQUksS0FBTSxPQUFPLEtBQU0sVUFBVSxJQUFJO0FBQUEsRUFBQztBQUFDO0FBRXhJO0FBQUEsRUFBVztBQUFBLEVBQWtCO0FBQUEsRUFBWTtBQUFBLEVBQU07QUFBQSxFQUMzQyxPQUFLLHlCQUF5QixDQUFDO0FBQUEsRUFBSyxPQUFLLDZCQUE2QixDQUFDO0FBQUEsRUFDdkUsTUFBTSxjQUFjO0FBQUEsRUFDcEI7QUFBQSxJQUFDLEVBQUUsUUFBUSxJQUFJLFFBQVEsUUFBUSxJQUFJLElBQUksT0FBTyxJQUFJO0FBQUEsSUFBRyxFQUFFLFFBQVEsSUFBSSxRQUFRLGNBQWMsSUFBSSxLQUFLLE9BQU8sSUFBSTtBQUFBLElBQzVHLEVBQUUsUUFBUSxJQUFJLFFBQVEsU0FBUyxJQUFJLEtBQUssT0FBTyxLQUFLO0FBQUEsSUFBRyxFQUFFLFFBQVEsS0FBSyxRQUFRLGNBQWMsSUFBSSxNQUFNLE9BQU8sS0FBTSxVQUFVLElBQUk7QUFBQSxFQUFDO0FBQUM7QUFFeEk7QUFBQSxFQUFXO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFNO0FBQUEsRUFDckMsT0FBSyx1QkFBdUIsQ0FBQztBQUFBLEVBQVMsT0FBSyxXQUFXLENBQUM7QUFBQSxFQUN2RCxNQUFNLEtBQUssTUFBTSxtQkFBbUIsb0JBQW9CLElBQUksRUFBRTtBQUFBLEVBQzlEO0FBQUEsSUFBQyxFQUFFLFFBQVEsSUFBSSxRQUFRLFFBQVEsSUFBSSxJQUFJLE9BQU8sSUFBSTtBQUFBLElBQUcsRUFBRSxRQUFRLEtBQUssUUFBUSxjQUFjLElBQUksS0FBSyxPQUFPLElBQUk7QUFBQSxJQUM3RyxFQUFFLFFBQVEsS0FBSyxRQUFRLFNBQVMsSUFBSSxLQUFLLE9BQU8sS0FBSztBQUFBLElBQUcsRUFBRSxRQUFRLE1BQU0sUUFBUSxjQUFjLElBQUksTUFBTSxPQUFPLEtBQU0sVUFBVSxHQUFHO0FBQUEsRUFBQztBQUFDO0FBRXpJO0FBQUEsRUFBVztBQUFBLEVBQVk7QUFBQSxFQUFlO0FBQUEsRUFBTztBQUFBLEVBQ3pDLE9BQUssY0FBVyxJQUFJLENBQUMsQ0FBQztBQUFBLEVBQU8sT0FBSyxXQUFXLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDbkQsTUFBTSxLQUFLLE1BQU0sY0FBYyxRQUFRO0FBQUEsRUFDdkM7QUFBQSxJQUFDLEVBQUUsUUFBUSxNQUFPLFFBQVEsUUFBUSxJQUFJLElBQUksT0FBTyxJQUFJO0FBQUEsSUFBRyxFQUFFLFFBQVEsTUFBTyxRQUFRLGNBQWMsSUFBSSxLQUFLLE9BQU8sSUFBSTtBQUFBLElBQ2xILEVBQUUsUUFBUSxLQUFRLFFBQVEsU0FBUyxJQUFJLEtBQUssT0FBTyxLQUFLO0FBQUEsSUFBRyxFQUFFLFFBQVEsS0FBUyxRQUFRLGNBQWMsSUFBSSxNQUFNLE9BQU8sS0FBTSxVQUFVLEdBQUc7QUFBQSxFQUFDO0FBQUM7QUFFL0k7QUFBQSxFQUFXO0FBQUEsRUFBWTtBQUFBLEVBQVU7QUFBQSxFQUFNO0FBQUEsRUFDbkMsT0FBSyxnQkFBYSxDQUFDO0FBQUEsRUFBTSxPQUFLLFdBQVcsQ0FBQztBQUFBLEVBQzFDLE1BQU8sY0FBYyxjQUFjLE1BQU0sS0FBSyxNQUFNLGNBQWMsV0FBVyxjQUFjLGFBQWEsR0FBRyxJQUFJO0FBQUEsRUFDL0c7QUFBQSxJQUFDLEVBQUUsUUFBUSxJQUFJLFFBQVEsUUFBUSxJQUFJLElBQUksT0FBTyxJQUFJO0FBQUEsSUFBRyxFQUFFLFFBQVEsSUFBSSxRQUFRLGNBQWMsSUFBSSxLQUFLLE9BQU8sSUFBSTtBQUFBLElBQzVHLEVBQUUsUUFBUSxJQUFJLFFBQVEsU0FBUyxJQUFJLEtBQUssT0FBTyxLQUFLO0FBQUEsSUFBRyxFQUFFLFFBQVEsSUFBSSxRQUFRLGNBQWMsSUFBSSxNQUFNLE9BQU8sTUFBTSxVQUFVLEdBQUc7QUFBQSxFQUFDO0FBQUM7QUFFdEk7QUFBQSxFQUFXO0FBQUEsRUFBVTtBQUFBLEVBQVk7QUFBQSxFQUFNO0FBQUEsRUFDbkMsT0FBSyw2QkFBNkIsSUFBSSxDQUFDLENBQUM7QUFBQSxFQUFLLE9BQUssU0FBUyxJQUFJLENBQUMsQ0FBQztBQUFBLEVBQ2pFLE1BQU0sY0FBYztBQUFBLEVBQ3BCO0FBQUEsSUFBQyxFQUFFLFFBQVEsR0FBRyxRQUFRLFFBQVEsSUFBSSxJQUFJLE9BQU8sR0FBRztBQUFBLElBQUcsRUFBRSxRQUFRLElBQUksUUFBUSxjQUFjLElBQUksSUFBSSxPQUFPLElBQUk7QUFBQSxJQUN6RyxFQUFFLFFBQVEsS0FBSyxRQUFRLFNBQVMsSUFBSSxLQUFLLE9BQU8sSUFBSTtBQUFBLElBQUcsRUFBRSxRQUFRLEtBQUssUUFBUSxjQUFjLElBQUksS0FBSyxPQUFPLEtBQUs7QUFBQSxFQUFDO0FBQUM7QUFFeEg7QUFBQSxFQUFXO0FBQUEsRUFBVztBQUFBLEVBQVc7QUFBQSxFQUFNO0FBQUEsRUFDbkMsT0FBSyxxQkFBa0IsSUFBSSxDQUFDLENBQUM7QUFBQSxFQUFLLE9BQUsscUJBQXFCLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDbEUsTUFBTSxpQkFBaUI7QUFBQSxFQUN2QjtBQUFBLElBQUMsRUFBRSxRQUFRLEtBQUssUUFBUSxRQUFRLElBQUksSUFBSSxPQUFPLEdBQUc7QUFBQSxJQUFHLEVBQUUsUUFBUSxLQUFLLFFBQVEsY0FBYyxJQUFJLEtBQUssT0FBTyxJQUFJO0FBQUEsSUFDN0csRUFBRSxRQUFRLEtBQU0sUUFBUSxTQUFTLElBQUksS0FBSyxPQUFPLElBQUs7QUFBQSxJQUFHLEVBQUUsUUFBUSxNQUFPLFFBQVEsY0FBYyxJQUFJLE1BQU0sT0FBTyxNQUFNLFVBQVUsR0FBRztBQUFBLEVBQUM7QUFBQztBQUUzSTtBQUFBLEVBQVc7QUFBQSxFQUFTO0FBQUEsRUFBZTtBQUFBLEVBQUs7QUFBQSxFQUNwQyxPQUFLLFNBQVMsQ0FBQztBQUFBLEVBQUksT0FBSyxvQkFBb0IsQ0FBQztBQUFBLEVBQzdDLE1BQU0sY0FBYztBQUFBLEVBQ3BCO0FBQUEsSUFBQyxFQUFFLFFBQVEsR0FBRyxRQUFRLFFBQVEsT0FBTyxJQUFJO0FBQUEsSUFBRyxFQUFFLFFBQVEsSUFBSSxRQUFRLGNBQWMsT0FBTyxJQUFJO0FBQUEsSUFDMUYsRUFBRSxRQUFRLElBQUksUUFBUSxTQUFTLE9BQU8sS0FBSztBQUFBLElBQUcsRUFBRSxRQUFRLElBQUksUUFBUSxjQUFjLE9BQU8sS0FBTSxVQUFVLElBQUk7QUFBQSxFQUFDO0FBQUM7QUFFcEg7QUFBQSxFQUFXO0FBQUEsRUFBaUI7QUFBQSxFQUFVO0FBQUEsRUFBTztBQUFBLEVBQ3pDLE9BQUssY0FBYyxJQUFJLENBQUMsQ0FBQztBQUFBLEVBQUssT0FBSyxZQUFZLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDckQsTUFBTSxpQkFBaUI7QUFBQSxFQUN2QjtBQUFBLElBQUMsRUFBRSxRQUFRLEdBQUcsUUFBUSxRQUFRLElBQUksSUFBSSxPQUFPLElBQUk7QUFBQSxJQUFHLEVBQUUsUUFBUSxJQUFJLFFBQVEsY0FBYyxJQUFJLEtBQUssT0FBTyxJQUFJO0FBQUEsSUFDM0csRUFBRSxRQUFRLEtBQUssUUFBUSxTQUFTLElBQUksS0FBSyxPQUFPLEtBQUs7QUFBQSxJQUFHLEVBQUUsUUFBUSxLQUFLLFFBQVEsY0FBYyxJQUFJLE1BQU0sT0FBTyxLQUFNLFVBQVUsSUFBSTtBQUFBLEVBQUM7QUFBQztBQUV6STtBQUFBLEVBQVc7QUFBQSxFQUFlO0FBQUEsRUFBVTtBQUFBLEVBQU07QUFBQSxFQUN0QyxPQUFLLGdCQUFnQixJQUFJLENBQUMsQ0FBQztBQUFBLEVBQUssT0FBSyxXQUFXLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDdEQsTUFBTSxpQkFBaUI7QUFBQSxFQUN2QjtBQUFBLElBQUMsRUFBRSxRQUFRLEtBQUssUUFBUSxRQUFRLElBQUksSUFBSSxPQUFPLElBQUk7QUFBQSxJQUFHLEVBQUUsUUFBUSxLQUFLLFFBQVEsU0FBUyxJQUFJLEtBQUssT0FBTyxJQUFJO0FBQUEsSUFDekcsRUFBRSxRQUFRLEtBQU0sUUFBUSxVQUFVLElBQUksTUFBTSxPQUFPLE1BQU0sVUFBVSxHQUFHO0FBQUEsRUFBQztBQUFDO0FBRTdFO0FBQUEsRUFBVztBQUFBLEVBQW9CO0FBQUEsRUFBVTtBQUFBLEVBQU87QUFBQSxFQUM1QyxPQUFLLHlCQUF5QixJQUFJLENBQUMsQ0FBQztBQUFBLEVBQUssT0FBSyxVQUFVLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDOUQsTUFBTSxpQkFBaUI7QUFBQSxFQUN2QjtBQUFBLElBQUMsRUFBRSxRQUFRLEdBQUcsUUFBUSxRQUFRLElBQUksSUFBSSxPQUFPLEdBQUc7QUFBQSxJQUFHLEVBQUUsUUFBUSxJQUFJLFFBQVEsY0FBYyxJQUFJLEtBQUssT0FBTyxJQUFJO0FBQUEsSUFDMUcsRUFBRSxRQUFRLEtBQUssUUFBUSxTQUFTLElBQUksS0FBSyxPQUFPLEtBQUs7QUFBQSxFQUFDO0FBQUM7QUFFNUQ7QUFBQSxFQUFXO0FBQUEsRUFBZ0I7QUFBQSxFQUFXO0FBQUEsRUFBTTtBQUFBLEVBQ3hDLE9BQUssWUFBWSxDQUFDLElBQUksa0JBQWtCO0FBQUEsRUFBSyxPQUFLLE9BQU8sQ0FBQztBQUFBLEVBQzFELE1BQU0saUJBQWlCLFlBQVk7QUFBQSxFQUNuQztBQUFBLElBQUMsRUFBRSxRQUFRLEdBQUcsUUFBUSxRQUFRLElBQUksSUFBSSxPQUFPLElBQUk7QUFBQSxJQUFHLEVBQUUsUUFBUSxJQUFJLFFBQVEsY0FBYyxJQUFJLEtBQUssT0FBTyxJQUFJO0FBQUEsSUFDM0csRUFBRSxRQUFRLElBQUksUUFBUSxTQUFTLElBQUksS0FBSyxPQUFPLElBQUk7QUFBQSxJQUFHLEVBQUUsUUFBUSxvQkFBb0IsUUFBUSxjQUFjLElBQUksTUFBTSxPQUFPLEtBQU0sVUFBVSxHQUFHO0FBQUEsRUFBQztBQUFDO0FBRXJKO0FBQUEsRUFBVztBQUFBLEVBQWU7QUFBQSxFQUFZO0FBQUEsRUFBTTtBQUFBLEVBQ3hDLE9BQUssNEJBQXlCLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFBSyxPQUFLLG1DQUFnQyxJQUFJLENBQUMsQ0FBQztBQUFBLEVBQ3BGLE1BQU0saUJBQWlCO0FBQUEsRUFDdkI7QUFBQSxJQUFDLEVBQUUsUUFBUSxJQUFJLFFBQVEsUUFBUSxJQUFJLElBQUksT0FBTyxHQUFHO0FBQUEsSUFBRyxFQUFFLFFBQVEsS0FBSyxRQUFRLGNBQWMsSUFBSSxLQUFLLE9BQU8sSUFBSTtBQUFBLElBQzVHLEVBQUUsUUFBUSxLQUFLLFFBQVEsU0FBUyxJQUFJLEtBQUssT0FBTyxJQUFJO0FBQUEsRUFBQztBQUFDO0FBRTNEO0FBQUEsRUFBVztBQUFBLEVBQWdCO0FBQUEsRUFBVztBQUFBLEVBQU87QUFBQSxFQUN6QyxPQUFLLG9CQUFvQixJQUFJLENBQUMsQ0FBQztBQUFBLEVBQUssT0FBSyxZQUFZLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDM0QsTUFBTSxpQkFBaUI7QUFBQSxFQUN2QixDQUFDLEVBQUUsUUFBUSxJQUFJLFFBQVEsUUFBUSxJQUFJLElBQUksT0FBTyxJQUFJLEdBQUcsRUFBRSxRQUFRLEtBQUssUUFBUSxTQUFTLElBQUksS0FBSyxPQUFPLElBQUksQ0FBQztBQUFDO0FBRS9HO0FBQUEsRUFBVztBQUFBLEVBQWdCO0FBQUEsRUFBZTtBQUFBLEVBQU07QUFBQSxFQUM1QyxPQUFLLHVCQUF1QixJQUFJLENBQUMsQ0FBQztBQUFBLEVBQUssT0FBSyxTQUFTLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDM0QsTUFBTSxpQkFBaUI7QUFBQSxFQUN2QjtBQUFBLElBQUMsRUFBRSxRQUFRLEtBQU0sUUFBUSxRQUFRLElBQUksSUFBSSxPQUFPLElBQUk7QUFBQSxJQUFHLEVBQUUsUUFBUSxLQUFPLFFBQVEsY0FBYyxJQUFJLEtBQUssT0FBTyxJQUFJO0FBQUEsSUFDakgsRUFBRSxRQUFRLE1BQVEsUUFBUSxTQUFTLElBQUksS0FBSyxPQUFPLEtBQUs7QUFBQSxJQUFHLEVBQUUsUUFBUSxLQUFVLFFBQVEsY0FBYyxJQUFJLEtBQU0sT0FBTyxLQUFNLFVBQVUsSUFBSTtBQUFBLEVBQUM7QUFBQztBQUVqSjtBQUFBLEVBQVc7QUFBQSxFQUFlO0FBQUEsRUFBVztBQUFBLEVBQU07QUFBQSxFQUN2QyxPQUFLLGtCQUFrQixJQUFJLENBQUMsQ0FBQztBQUFBLEVBQUssT0FBSyxXQUFXLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDeEQsTUFBTSxjQUFjO0FBQUEsRUFDcEI7QUFBQSxJQUFDLEVBQUUsUUFBUSxLQUFNLFFBQVEsUUFBUSxJQUFJLElBQUksT0FBTyxHQUFHO0FBQUEsSUFBRyxFQUFFLFFBQVEsTUFBTyxRQUFRLGNBQWMsSUFBSSxLQUFLLE9BQU8sSUFBSTtBQUFBLElBQ2hILEVBQUUsUUFBUSxNQUFPLFFBQVEsU0FBUyxJQUFJLEtBQUssT0FBTyxJQUFJO0FBQUEsSUFBRyxFQUFFLFFBQVEsS0FBUSxRQUFRLGNBQWMsSUFBSSxNQUFNLE9BQU8sS0FBTSxVQUFVLEdBQUc7QUFBQSxFQUFDO0FBQUM7QUFFNUksT0FBTyxLQUFLLGFBQWEsRUFBRSxRQUFRLFNBQU87QUFDdEMsUUFBTSxPQUFPLGNBQWMsR0FBRztBQUM5QjtBQUFBLElBQVcsYUFBYSxHQUFHO0FBQUEsSUFBSTtBQUFBLElBQVcsS0FBSztBQUFBLElBQU07QUFBQSxJQUNqRCxPQUFLLGdCQUFnQixJQUFJLFlBQVksQ0FBQyxLQUFLLElBQUksQ0FBQyxDQUFDO0FBQUEsSUFBSyxPQUFLLFdBQVcsSUFBSSxDQUFDLENBQUMsMkNBQXdDLEdBQUc7QUFBQSxJQUN2SCxNQUFNLGlCQUFpQixjQUFjLEdBQUcsS0FBSztBQUFBLElBQzdDLENBQUMsRUFBRSxRQUFRLEtBQUssUUFBUSxRQUFRLElBQUksSUFBSSxPQUFPLElBQUksR0FBRyxFQUFFLFFBQVEsS0FBTSxRQUFRLFNBQVMsSUFBSSxLQUFLLE9BQU8sSUFBSSxDQUFDO0FBQUEsRUFBQztBQUNySCxDQUFDO0FBRUQsQ0FBQyxDQUFDLFNBQVMsaUJBQUssR0FBRyxDQUFDLGFBQWEsaUJBQUssR0FBRyxDQUFDLFlBQVksY0FBSSxHQUFHLENBQUMsZUFBZSxjQUFJLEdBQUcsQ0FBQyxZQUFZLFdBQUksR0FBRyxDQUFDLFlBQVksV0FBSSxDQUFDLEVBQUUsUUFBUSxDQUFDLENBQUMsS0FBSyxJQUFJLE1BQU07QUFDako7QUFBQSxJQUFZLGlCQUFpQixHQUFHO0FBQUEsSUFBSTtBQUFBLElBQVU7QUFBQSxJQUFNO0FBQUEsSUFDaEQsY0FBVyxjQUFjLEdBQUcsRUFBRSxLQUFLO0FBQUEsSUFBSSw2Q0FBNkMsY0FBYyxHQUFHLEVBQUUsS0FBSztBQUFBLElBQzVHO0FBQUEsSUFBVTtBQUFBLElBQUcsTUFBTyxpQkFBaUIsb0JBQW9CLFNBQVMsR0FBRyxJQUFJLElBQUk7QUFBQSxJQUFJLEVBQUUsSUFBSSxLQUFLLE9BQU8sS0FBSyxVQUFVLEdBQUc7QUFBQSxFQUFDO0FBQzlILENBQUM7QUFFRDtBQUFBLEVBQVk7QUFBQSxFQUFtQjtBQUFBLEVBQVc7QUFBQSxFQUFNO0FBQUEsRUFBUTtBQUFBLEVBQ3BEO0FBQUEsRUFBZ0U7QUFBQSxFQUFjO0FBQUEsRUFDOUUsTUFBTSxpQkFBaUI7QUFBQSxFQUFnQixFQUFFLElBQUksS0FBTSxPQUFPLE1BQU0sVUFBVSxHQUFHO0FBQUEsRUFBRztBQUFJO0FBRXhGO0FBQUEsRUFBWTtBQUFBLEVBQXNCO0FBQUEsRUFBVztBQUFBLEVBQU07QUFBQSxFQUFhO0FBQUEsRUFDNUQ7QUFBQSxFQUErRDtBQUFBLEVBQVU7QUFBQSxFQUN6RSxNQUFPLGNBQWMsWUFBWSxNQUFNLGlCQUFpQixxQkFBcUIsSUFBSSxJQUFJO0FBQUEsRUFBSSxFQUFFLElBQUksS0FBSyxPQUFPLE1BQU0sVUFBVSxHQUFHO0FBQUEsRUFBRztBQUFJO0FBRXpJO0FBQUEsRUFBWTtBQUFBLEVBQW9CO0FBQUEsRUFBZTtBQUFBLEVBQU07QUFBQSxFQUFXO0FBQUEsRUFDNUQ7QUFBQSxFQUF3QjtBQUFBLEVBQVM7QUFBQSxFQUFHLE1BQU8sY0FBYyxTQUFTLEtBQUssSUFBSTtBQUFBLEVBQzNFLEVBQUUsT0FBTyxNQUFNLFVBQVUsU0FBUyxPQUFPLHVCQUFvQjtBQUFDO0FBRWxFO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBTTtBQUFBLEVBQWE7QUFBQSxFQUNuRDtBQUFBLEVBQWtDO0FBQUEsRUFBYztBQUFBLEVBQUssTUFBTSxjQUFjO0FBQUEsRUFBVSxFQUFFLElBQUksS0FBTSxPQUFPLEtBQU8sVUFBVSxJQUFJO0FBQUM7QUFFaEk7QUFBQSxFQUFZO0FBQUEsRUFBZTtBQUFBLEVBQVU7QUFBQSxFQUFNO0FBQUEsRUFBUTtBQUFBLEVBQy9DO0FBQUEsRUFBb0M7QUFBQSxFQUFTO0FBQUEsRUFBRyxNQUFPLGlCQUFpQixrQkFBa0IsU0FBUyxFQUFFLElBQUksSUFBSTtBQUFBLEVBQUksRUFBRSxJQUFJLEtBQUssT0FBTyxLQUFLO0FBQUM7QUFFN0k7QUFBQSxFQUFZO0FBQUEsRUFBZTtBQUFBLEVBQVU7QUFBQSxFQUFNO0FBQUEsRUFBUTtBQUFBLEVBQy9DO0FBQUEsRUFBb0M7QUFBQSxFQUFVO0FBQUEsRUFBRyxNQUFPLGlCQUFpQixrQkFBa0IsU0FBUyxFQUFFLElBQUksSUFBSTtBQUFBLEVBQUksRUFBRSxJQUFJLEtBQUssT0FBTyxNQUFNLFVBQVUsR0FBRztBQUFDO0FBRTVKO0FBQUEsRUFBWTtBQUFBLEVBQXlCO0FBQUEsRUFBVztBQUFBLEVBQU07QUFBQSxFQUFhO0FBQUEsRUFDL0Q7QUFBQSxFQUEwRDtBQUFBLEVBQWM7QUFBQSxFQUN4RSxNQUFPLGlCQUFpQix1QkFBdUIsSUFBSTtBQUFBLEVBQUksRUFBRSxJQUFJLEtBQUssT0FBTyxJQUFJO0FBQUM7QUFFbEY7QUFBQSxFQUFZO0FBQUEsRUFBcUI7QUFBQSxFQUFXO0FBQUEsRUFBTTtBQUFBLEVBQWM7QUFBQSxFQUM1RDtBQUFBLEVBQStDO0FBQUEsRUFBUTtBQUFBLEVBQUcsTUFBTyxpQkFBaUIsZUFBZSxJQUFJLElBQUk7QUFBQSxFQUFJLEVBQUUsSUFBSSxJQUFJLE9BQU8sR0FBRztBQUFDO0FBRXRJO0FBQUEsRUFBWTtBQUFBLEVBQXNCO0FBQUEsRUFBZTtBQUFBLEVBQU07QUFBQSxFQUFjO0FBQUEsRUFDakU7QUFBQSxFQUFzRDtBQUFBLEVBQWM7QUFBQSxFQUNwRSxNQUFPLE9BQU8sS0FBSyxXQUFXLEVBQUUsTUFBTSxPQUFLLFlBQVksU0FBUyxDQUFDLEtBQUssWUFBWSxDQUFDLEVBQUUsUUFBUSxJQUFJLElBQUk7QUFBQSxFQUNyRyxFQUFFLE9BQU8sS0FBTSxVQUFVLEtBQUssVUFBVSxRQUFRLE9BQU8saUJBQWlCO0FBQUM7QUFFN0U7QUFBQSxFQUFZO0FBQUEsRUFBcUI7QUFBQSxFQUFlO0FBQUEsRUFBTTtBQUFBLEVBQWM7QUFBQSxFQUNoRTtBQUFBLEVBQXVEO0FBQUEsRUFBYyxPQUFPLEtBQUssV0FBVyxFQUFFO0FBQUEsRUFDOUYsTUFBTSxpQkFBaUIsZ0JBQWdCO0FBQUEsRUFBUSxFQUFFLElBQUksS0FBSyxPQUFPLElBQUk7QUFBQztBQUUxRTtBQUFBLEVBQVk7QUFBQSxFQUFlO0FBQUEsRUFBVztBQUFBLEVBQU07QUFBQSxFQUFRO0FBQUEsRUFDaEQ7QUFBQSxFQUErQjtBQUFBLEVBQWM7QUFBQSxFQUFNLE1BQU0saUJBQWlCO0FBQUEsRUFBVSxFQUFFLElBQUksS0FBSyxPQUFPLElBQUk7QUFBQztBQUUvRztBQUFBLEVBQVk7QUFBQSxFQUFnQjtBQUFBLEVBQVk7QUFBQSxFQUFNO0FBQUEsRUFBYTtBQUFBLEVBQ3ZEO0FBQUEsRUFBMkQ7QUFBQSxFQUFTO0FBQUEsRUFBRyxNQUFNLGlCQUFpQjtBQUFBLEVBQWEsRUFBRSxJQUFJLEtBQUssT0FBTyxJQUFJO0FBQUEsRUFBRztBQUFJO0FBRTVJLE1BQU0sbUJBQW1CLENBQUM7QUFDMUIsT0FBTyxPQUFPLGVBQWUsRUFBRSxRQUFRLFNBQU87QUFDMUMsR0FBQyxpQkFBaUIsSUFBSSxPQUFPLElBQUksaUJBQWlCLElBQUksT0FBTyxLQUFLLENBQUMsR0FBRyxLQUFLLEdBQUc7QUFDbEYsQ0FBQztBQUVELE1BQU0scUJBQXFCO0FBQUEsRUFDdkIsU0FBUyxJQUFJO0FBQ1QsUUFBSSxDQUFDLGlCQUFpQixFQUFFLEVBQUcsa0JBQWlCLEVBQUUsSUFBSSxFQUFFLFVBQVUsT0FBTyxTQUFTLE1BQU07QUFDcEYsV0FBTyxpQkFBaUIsRUFBRTtBQUFBLEVBQzlCO0FBQUEsRUFDQSxTQUFTLFNBQVM7QUFDZCxVQUFNLE9BQU8saUJBQWlCLE9BQU87QUFDckMsUUFBSSxDQUFDLEtBQU07QUFDWCxRQUFJLFFBQVE7QUFDWixTQUFLLFFBQVEsU0FBTztBQUNoQixVQUFJLElBQUksU0FBUyxJQUFJLElBQUksT0FBUTtBQUNqQyxZQUFNLFFBQVEsS0FBSyxTQUFTLElBQUksRUFBRTtBQUNsQyxVQUFJLENBQUMsTUFBTSxVQUFVO0FBQUUsY0FBTSxXQUFXO0FBQU0sYUFBSyxVQUFVLEdBQUc7QUFBRyxnQkFBUTtBQUFBLE1BQU07QUFBQSxJQUNyRixDQUFDO0FBQ0QsUUFBSSxNQUFPLE1BQUssVUFBVTtBQUFBLEVBQzlCO0FBQUEsRUFDQSxNQUFNLElBQUk7QUFDTixVQUFNLE1BQU0sZ0JBQWdCLEVBQUU7QUFDOUIsUUFBSSxDQUFDLElBQUssUUFBTztBQUNqQixVQUFNLFFBQVEsS0FBSyxTQUFTLEVBQUU7QUFDOUIsUUFBSSxNQUFNLFdBQVcsSUFBSSxTQUFTLElBQUksSUFBSSxPQUFRLFFBQU87QUFDekQsVUFBTSxVQUFVO0FBQ2hCLFNBQUssWUFBWSxHQUFHO0FBQ3BCLFNBQUssVUFBVTtBQUNmLFdBQU87QUFBQSxFQUNYO0FBQUEsRUFDQSxZQUFZLEtBQUs7QUFDYixVQUFNLElBQUksSUFBSTtBQUNkLFFBQUksRUFBRSxHQUFJLE1BQUssUUFBUSxFQUFFLEVBQUU7QUFDM0IsUUFBSSxFQUFFLFNBQVUsTUFBSyxjQUFjLEVBQUUsUUFBUTtBQUM3QyxRQUFJLEVBQUUsT0FBTztBQUNULFVBQUksS0FBSyxPQUFRLE1BQUssT0FBTyxTQUFTLEVBQUU7QUFBQSxVQUNuQyxrQkFBaUIsZ0JBQWdCLEVBQUU7QUFBQSxJQUM1QztBQUNBLFFBQUksRUFBRSxTQUFVLGVBQWMsUUFBUSxLQUFLLEVBQUUsYUFBYSxJQUFJLElBQUksTUFBTSxFQUFFLFVBQVUsT0FBTyxFQUFFLE1BQU0sQ0FBQztBQUNwRyxrQkFBYyxLQUFLO0FBQ25CLFNBQUssVUFBVTtBQUFBLEVBQ25CO0FBQUEsRUFDQSxVQUFVLEtBQUs7QUFDWCxZQUFRLHNCQUFzQixLQUFLLElBQUk7QUFDdkMsVUFBTSxLQUFLLFNBQVMsZUFBZSxtQkFBbUI7QUFDdEQsUUFBSSxDQUFDLEdBQUk7QUFDVCxVQUFNLFNBQVMsT0FBTyxJQUFJLE1BQU07QUFDaEMsT0FBRyxZQUFZLCtDQUErQyxPQUFPLEtBQUsseUNBQTZCLE9BQU8sS0FBSyxzQ0FBc0MsSUFBSSxJQUFJLElBQUksSUFBSSxJQUFJO0FBQzdLLE9BQUcsTUFBTSxZQUFZLGtCQUFrQixPQUFPLEtBQUs7QUFDbkQsT0FBRyxVQUFVLE9BQU8sTUFBTTtBQUFHLFNBQUssR0FBRztBQUFhLE9BQUcsVUFBVSxJQUFJLE1BQU07QUFDekUsaUJBQWEsS0FBSyxXQUFXO0FBQzdCLFNBQUssY0FBYyxXQUFXLE1BQU0sR0FBRyxVQUFVLE9BQU8sTUFBTSxHQUFHLElBQUk7QUFBQSxFQUN6RTtBQUFBLEVBQ0Esc0JBQXNCO0FBQ2xCLFVBQU0sT0FBTyxLQUFLLFVBQVUsS0FBSyxPQUFPLEtBQUssSUFBSSxJQUFJLEtBQUssYUFBYSxHQUFJLElBQUk7QUFDL0UsV0FBTyxjQUFjLGNBQWM7QUFBQSxFQUN2QztBQUFBLEVBQ0EsWUFBWSxTQUFTLFVBQVU7QUFDM0IsUUFBSSxDQUFDLEtBQUssb0JBQXFCLGtCQUFpQjtBQUNoRCxTQUFLLHNCQUFzQjtBQUMzQixRQUFJLFVBQVU7QUFDVix1QkFBaUI7QUFDakIsVUFBSSxDQUFDLGlCQUFpQixvQkFBb0IsU0FBUyxRQUFRLEVBQUcsa0JBQWlCLG9CQUFvQixLQUFLLFFBQVE7QUFDaEgsV0FBSyxTQUFTLGVBQWU7QUFDN0IsV0FBSyxTQUFTLGNBQWM7QUFBQSxJQUNoQztBQUNBLFFBQUksU0FBUyxhQUFhLE1BQU8sa0JBQWlCO0FBQ2xELFFBQUksS0FBSyxVQUFVLEtBQUssT0FBTyxLQUFLLEtBQUssT0FBTyxRQUFRLElBQUssa0JBQWlCO0FBQzlFLFNBQUssU0FBUyxXQUFXO0FBQ3pCLFNBQUssVUFBVTtBQUFBLEVBQ25CO0FBQUEsRUFDQSxZQUFZO0FBQUUsZUFBVyxJQUFJLGNBQWMsZ0JBQWdCO0FBQUEsRUFBRztBQUFBLEVBQzlELFlBQVk7QUFBRSxlQUFXLElBQUksY0FBYyxnQkFBZ0I7QUFBQSxFQUFHO0FBQUEsRUFDOUQsV0FBVztBQUNQLFdBQU8sS0FBSywwQkFBMEIsRUFBRSxRQUFRLE9BQUs7QUFDakQsWUFBTSxJQUFJLDJCQUEyQixDQUFDO0FBQ3RDLHVCQUFpQixDQUFDLElBQUksTUFBTSxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUssS0FBSyxPQUFPLE1BQU0sV0FBVyxDQUFDLElBQUk7QUFBQSxJQUNyRixDQUFDO0FBQ0QsV0FBTyxLQUFLLGdCQUFnQixFQUFFLFFBQVEsT0FBSyxPQUFPLGlCQUFpQixDQUFDLENBQUM7QUFDckUsU0FBSyxVQUFVO0FBQ2YsU0FBSyxVQUFVO0FBQ2YsUUFBSSxPQUFPLEtBQUssdUJBQXVCLFdBQVksTUFBSyxtQkFBbUI7QUFBQSxFQUMvRTtBQUNKO0FBRUEsTUFBTSxtQkFBbUIsS0FBSztBQUM5QixLQUFLLFdBQVcsU0FBUyxHQUFHLFFBQVEsTUFBTTtBQUN0QyxRQUFNLFdBQVcsQ0FBQyxFQUFFO0FBQ3BCLFFBQU0sVUFBVSxFQUFFLFNBQVM7QUFDM0IsUUFBTSxXQUFXLEVBQUU7QUFDbkIsUUFBTSxTQUFTLEtBQUssVUFBVSxLQUFLLE9BQU87QUFDMUMsUUFBTSxjQUFjLEtBQUssU0FBUyxLQUFLLE9BQU8sUUFBUTtBQUN0RCxtQkFBaUIsS0FBSyxNQUFNLEdBQUcsS0FBSyxHQUFHLElBQUk7QUFDM0MsTUFBSSxZQUFZLEVBQUUsU0FBUztBQUN2QixxQkFBaUI7QUFDakIscUJBQWlCLGlCQUFpQixLQUFLLElBQUksaUJBQWlCLGdCQUFnQixpQkFBaUIsaUJBQWlCO0FBQzlHLFFBQUksUUFBUTtBQUNSLFlBQU0sTUFBTSxnQkFBZ0IsT0FBTyxJQUFJO0FBQ3ZDLFVBQUksSUFBSyxrQkFBaUIsY0FBYyxHQUFHLEtBQUssaUJBQWlCLGNBQWMsR0FBRyxLQUFLLEtBQUs7QUFBQSxJQUNoRztBQUNBLFFBQUksU0FBUztBQUNULHVCQUFpQjtBQUNqQixVQUFJLFVBQVUsT0FBTyxTQUFTLFFBQVMsa0JBQWlCO0FBQ3hELFVBQUksWUFBWSxDQUFDLGlCQUFpQixrQkFBa0IsU0FBUyxRQUFRLEVBQUcsa0JBQWlCLGtCQUFrQixLQUFLLFFBQVE7QUFBQSxJQUM1SDtBQUNBLFFBQUksS0FBSyxPQUFRLGtCQUFpQixlQUFlLEtBQUssSUFBSSxHQUFHLEtBQUssT0FBTyxRQUFRLFdBQVc7QUFDNUYsdUJBQW1CLFNBQVMsTUFBTTtBQUFBLEVBQ3RDO0FBQ0o7QUFFQSxNQUFNLGdCQUFnQixLQUFLO0FBQzNCLEtBQUssUUFBUSxXQUFXO0FBQ3BCLFFBQU0sSUFBSSxLQUFLLFVBQVUsS0FBSyxPQUFPO0FBQ3JDLFFBQU0sZUFBZSxLQUFLO0FBQzFCLGdCQUFjLEtBQUssSUFBSTtBQUN2QixNQUFJLEtBQUssS0FBSyxhQUFhLGNBQWM7QUFDckMsUUFBSSxDQUFDLGlCQUFpQixZQUFZLFNBQVMsRUFBRSxJQUFJLEVBQUcsa0JBQWlCLFlBQVksS0FBSyxFQUFFLElBQUk7QUFDNUYsdUJBQW1CLFNBQVMsT0FBTztBQUFBLEVBQ3ZDO0FBQ0o7QUFFQSxNQUFNLGlCQUFpQixLQUFLO0FBQzVCLEtBQUssU0FBUyxXQUFXO0FBQ3JCLFFBQU0sSUFBSSxLQUFLLFVBQVUsS0FBSyxPQUFPO0FBQ3JDLFFBQU0sU0FBUyxJQUFJLEVBQUUsT0FBTztBQUM1QixpQkFBZSxLQUFLLElBQUk7QUFDeEIsTUFBSSxLQUFLLEVBQUUsU0FBUyxXQUFXLFdBQVcsUUFBUSxXQUFXLEVBQUUsVUFBVTtBQUNyRSxxQkFBaUI7QUFDakIsdUJBQW1CLFNBQVMsUUFBUTtBQUFBLEVBQ3hDO0FBQ0o7QUFFQSxNQUFNLHFCQUFxQixPQUFPLFVBQVU7QUFDNUMsT0FBTyxVQUFVLGFBQWEsU0FBUyxLQUFLO0FBQ3hDLHFCQUFtQixzQkFBc0I7QUFDekMscUJBQW1CLEtBQUssTUFBTSxHQUFHO0FBQ3JDO0FBRUEsTUFBTSxlQUFlLE9BQU8sVUFBVTtBQUN0QyxPQUFPLFVBQVUsT0FBTyxXQUFXO0FBQy9CLFFBQU0sU0FBUyxLQUFLO0FBQ3BCLGVBQWEsS0FBSyxJQUFJO0FBQ3RCLE1BQUksQ0FBQyxVQUFVLEtBQUssV0FBVztBQUFFLHFCQUFpQjtBQUFZLHVCQUFtQixTQUFTLE1BQU07QUFBQSxFQUFHO0FBQ3ZHO0FBRUEsTUFBTSxlQUFlLEtBQUs7QUFDMUIsS0FBSyxPQUFPLFdBQVc7QUFDbkIsUUFBTSxhQUFhLEtBQUs7QUFDeEIsUUFBTSxjQUFjLEtBQUs7QUFDekIsZUFBYSxLQUFLLElBQUk7QUFDdEIsTUFBSSxLQUFLLFNBQVMsV0FBWSxvQkFBbUIsWUFBWSxZQUFZLFdBQVc7QUFDeEY7QUFFQSxNQUFNLHNCQUFzQixLQUFLO0FBQ2pDLEtBQUssY0FBYyxTQUFTLE9BQU87QUFDL0Isc0JBQW9CLEtBQUssTUFBTSxLQUFLO0FBQ3BDLHFCQUFtQixTQUFTLFNBQVM7QUFDekM7QUFFQSxNQUFNLG1CQUFtQixLQUFLO0FBQzlCLEtBQUssV0FBVyxXQUFXO0FBQ3ZCLG1CQUFpQixLQUFLLElBQUk7QUFDMUIsbUJBQWlCLG9CQUFvQjtBQUNyQyxxQkFBbUIsU0FBUyxPQUFPO0FBQ25DLHFCQUFtQixVQUFVO0FBQ2pDO0FBRUEsTUFBTSxvQkFBb0IsS0FBSztBQUMvQixLQUFLLFlBQVksU0FBUyxHQUFHO0FBQ3pCLFFBQU0sU0FBUyxLQUFLLE9BQU8sVUFBVSxLQUFLLE9BQUssS0FBSyxFQUFFLFNBQVMsQ0FBQztBQUNoRSxvQkFBa0IsS0FBSyxNQUFNLENBQUM7QUFDOUIsUUFBTSxRQUFRLEtBQUssT0FBTyxVQUFVLEtBQUssT0FBSyxLQUFLLEVBQUUsU0FBUyxDQUFDO0FBQy9ELE1BQUksQ0FBQyxVQUFVLE9BQU87QUFDbEIscUJBQWlCO0FBQ2pCLFVBQU0sTUFBTSxnQkFBZ0IsQ0FBQztBQUM3QixRQUFJLFFBQVEsV0FBVyxRQUFRLFVBQVcsa0JBQWlCLHVCQUF1QjtBQUNsRix1QkFBbUIsU0FBUyxXQUFXO0FBQ3ZDLHVCQUFtQixVQUFVO0FBQUEsRUFDakM7QUFDSjtBQUNBLE1BQU0scUJBQXFCLEtBQUs7QUFDaEMsS0FBSyxhQUFhLFNBQVMsR0FBRztBQUMxQixxQkFBbUIsS0FBSyxNQUFNLENBQUM7QUFDL0IsbUJBQWlCO0FBQ2pCLHFCQUFtQixTQUFTLFlBQVk7QUFDeEMscUJBQW1CLFVBQVU7QUFDakM7QUFFQSxNQUFNLG9CQUFvQixLQUFLO0FBQy9CLEtBQUssWUFBWSxXQUFXO0FBQ3hCLFFBQU0sU0FBUyxLQUFLLE9BQU87QUFDM0Isb0JBQWtCLEtBQUssSUFBSTtBQUMzQixNQUFJLEtBQUssT0FBTyxRQUFRLFFBQVE7QUFBRSxxQkFBaUI7QUFBa0IsdUJBQW1CLFNBQVMsV0FBVztBQUFBLEVBQUc7QUFDbkg7QUFFQSxNQUFNLGtCQUFrQixZQUFZO0FBQ3BDLFlBQVksTUFBTSxTQUFTLEdBQUc7QUFDMUIsUUFBTSxTQUFTLGdCQUFnQixLQUFLLE1BQU0sQ0FBQztBQUMzQyxNQUFJLFFBQVE7QUFDUixxQkFBaUI7QUFDakIsUUFBSSxDQUFDLGlCQUFpQixnQkFBZ0IsU0FBUyxDQUFDLEVBQUcsa0JBQWlCLGdCQUFnQixLQUFLLENBQUM7QUFDMUYsdUJBQW1CLFNBQVMsWUFBWTtBQUN4Qyx1QkFBbUIsVUFBVTtBQUFBLEVBQ2pDO0FBQ0EsU0FBTztBQUNYO0FBRUEsTUFBTSxlQUFlLEtBQUs7QUFDMUIsS0FBSyxPQUFPLFdBQVc7QUFDbkIsZUFBYSxLQUFLLElBQUk7QUFDdEIsTUFBSSxpQkFBaUIsY0FBYztBQUMvQixTQUFLLE9BQU8sU0FBUyxpQkFBaUI7QUFDdEMscUJBQWlCLGVBQWU7QUFDaEMsdUJBQW1CLFVBQVU7QUFBQSxFQUNqQztBQUNKO0FBRUEsT0FBTyxpQkFBaUIsZ0JBQWdCLE1BQU0sbUJBQW1CLFVBQVUsQ0FBQztBQUU1RSxXQUFXLGFBQWEsU0FBUyxNQUFNO0FBQ25DLE1BQUksVUFBVTtBQUNkLE1BQUksS0FBSyxTQUFTLFlBQVksR0FBRztBQUFFLFdBQU8sT0FBTyxrQkFBa0IsV0FBVyxJQUFJLGNBQWMsQ0FBQyxDQUFDLENBQUM7QUFBRyxjQUFVO0FBQUEsRUFBTTtBQUN0SCxNQUFJLEtBQUssU0FBUyxZQUFZLEdBQUc7QUFBRSxXQUFPLE9BQU8sa0JBQWtCLFdBQVcsSUFBSSxjQUFjLENBQUMsQ0FBQyxDQUFDO0FBQUcsY0FBVTtBQUFBLEVBQU07QUFDdEgsTUFBSSxXQUFXLE9BQU8sS0FBSyx1QkFBdUIsV0FBWSxNQUFLLG1CQUFtQjtBQUMxRixDQUFDO0FBRUQsTUFBTSxzQkFBc0IsS0FBSztBQUNqQyxLQUFLLGNBQWMsV0FBVztBQUMxQixzQkFBb0IsS0FBSyxJQUFJO0FBQzdCLE9BQUssY0FBYyxPQUFPO0FBQzlCO0FBRUEsS0FBSyxnQkFBZ0IsU0FBUyxLQUFLO0FBQy9CLFFBQU0sV0FBVyxTQUFTLGVBQWUsbUJBQW1CO0FBQzVELFFBQU0sVUFBVSxTQUFTLGVBQWUsa0JBQWtCO0FBQzFELFFBQU0sV0FBVyxTQUFTLGVBQWUsZUFBZTtBQUN4RCxRQUFNLFVBQVUsU0FBUyxlQUFlLGNBQWM7QUFDdEQsTUFBSSxDQUFDLFlBQVksQ0FBQyxRQUFTO0FBQzNCLFdBQVMsTUFBTSxVQUFVLFFBQVEsVUFBVSxVQUFVO0FBQ3JELFVBQVEsTUFBTSxVQUFVLFFBQVEsU0FBUyxVQUFVO0FBQ25ELE1BQUksU0FBVSxVQUFTLFVBQVUsT0FBTyxVQUFVLFFBQVEsT0FBTztBQUNqRSxNQUFJLFFBQVMsU0FBUSxVQUFVLE9BQU8sVUFBVSxRQUFRLE1BQU07QUFDOUQsTUFBSSxRQUFRLE9BQVEsTUFBSyxtQkFBbUI7QUFDaEQ7QUFFQSxLQUFLLG1CQUFtQixTQUFTLElBQUk7QUFDakMsTUFBSSxtQkFBbUIsTUFBTSxFQUFFLEdBQUc7QUFBRSxZQUFRLE1BQU07QUFBRyxTQUFLLG1CQUFtQjtBQUFBLEVBQUc7QUFDcEY7QUFFQSxLQUFLLHFCQUFxQixXQUFXO0FBQ2pDLFFBQU0sU0FBUyxTQUFTLGVBQWUsV0FBVztBQUNsRCxRQUFNLFlBQVksU0FBUyxlQUFlLGNBQWM7QUFDeEQsTUFBSSxDQUFDLE9BQVE7QUFDYixRQUFNLFdBQVcsU0FBUyxlQUFlLGFBQWE7QUFDdEQsUUFBTSxRQUFRLFNBQVMsZUFBZSxzQkFBc0I7QUFDNUQsUUFBTSxXQUFXLFNBQVMsZUFBZSxvQkFBb0I7QUFDN0QsUUFBTSxTQUFTLFdBQVcsU0FBUyxNQUFNLEtBQUssRUFBRSxZQUFZLElBQUk7QUFDaEUsUUFBTSxZQUFZLFFBQVEsTUFBTSxRQUFRO0FBQ3hDLFFBQU0sZUFBZSxXQUFXLFNBQVMsUUFBUTtBQUVqRCxNQUFJLFFBQVEsR0FBRyxpQkFBaUI7QUFDaEMsUUFBTSxRQUFRLENBQUM7QUFDZixTQUFPLE9BQU8sZUFBZSxFQUFFLFFBQVEsU0FBTztBQUMxQztBQUNBLFVBQU0sUUFBUSxJQUFJLFNBQVM7QUFDM0IsVUFBTSxjQUFjLFNBQVMsSUFBSTtBQUNqQyxRQUFJLFlBQWE7QUFDakIsVUFBTSxRQUFRLG1CQUFtQixTQUFTLElBQUksRUFBRTtBQUVoRCxRQUFJLGNBQWMsU0FBUyxJQUFJLGFBQWEsVUFBVztBQUN2RCxRQUFJLGlCQUFpQixlQUFlLENBQUMsWUFBYTtBQUNsRCxRQUFJLGlCQUFpQixlQUFlLEVBQUUsZUFBZSxDQUFDLE1BQU0sU0FBVTtBQUN0RSxRQUFJLGlCQUFpQixZQUFZLFlBQWE7QUFFOUMsVUFBTSxhQUFhLElBQUksVUFBVSxDQUFDO0FBQ2xDLFVBQU0sT0FBTyxhQUFhLFFBQVEsSUFBSTtBQUN0QyxVQUFNLE9BQU8sYUFBYSwwQ0FBdUMsSUFBSTtBQUNyRSxRQUFJLFVBQVUsQ0FBQyxLQUFLLFlBQVksRUFBRSxTQUFTLE1BQU0sS0FBSyxDQUFDLEtBQUssWUFBWSxFQUFFLFNBQVMsTUFBTSxFQUFHO0FBRTVGLFVBQU0sU0FBUyxPQUFPLElBQUksTUFBTTtBQUNoQyxVQUFNLE1BQU0sS0FBSyxJQUFJLEtBQUssS0FBSyxNQUFNLFFBQVEsSUFBSSxTQUFTLEdBQUcsQ0FBQztBQUM5RCxVQUFNLGNBQWMsQ0FBQyxXQUFXO0FBQ2hDLFFBQUksWUFBYSxhQUFZLEtBQUssV0FBVztBQUM3QyxRQUFJLGVBQWUsSUFBSSxXQUFXLGFBQWMsYUFBWSxLQUFLLGdCQUFnQjtBQUVqRixRQUFJO0FBQ0osUUFBSSxNQUFNLFFBQVMsY0FBYTtBQUFBLGFBQ3ZCLFlBQWEsY0FBYSwyREFBMkQsSUFBSSxFQUFFO0FBQUEsUUFDL0YsY0FBYTtBQUVsQixVQUFNLEtBQUssZUFBZSxZQUFZLEtBQUssR0FBRyxDQUFDLDJCQUEyQixPQUFPLEtBQUs7QUFBQSxxQ0FDekQsYUFBYSxXQUFNLElBQUksSUFBSTtBQUFBO0FBQUEseUNBRXZCLElBQUksMkNBQTJDLE9BQU8sS0FBSyxLQUFLLE9BQU8sS0FBSztBQUFBLHlDQUM1RSxJQUFJO0FBQUEsK0ZBQ2tELEdBQUcsaUJBQWlCLE9BQU8sS0FBSztBQUFBLGtEQUM3RSxLQUFLLElBQUksT0FBTyxJQUFJLE1BQU0sQ0FBQyxNQUFNLElBQUksTUFBTSxXQUFNLEdBQUc7QUFBQSxxREFDeEQsSUFBSSxPQUFPLFNBQVMseUJBQXNCO0FBQUE7QUFBQSx1Q0FFakQsVUFBVTtBQUFBLGVBQ2xDO0FBQUEsRUFDWCxDQUFDO0FBRUQsU0FBTyxZQUFZLE1BQU0sS0FBSyxFQUFFLEtBQUs7QUFDckMsTUFBSSxVQUFXLFdBQVUsWUFBWSx5Q0FBeUMsY0FBYyxNQUFNLEtBQUssS0FBSyxLQUFLLE1BQU0saUJBQWlCLFFBQVEsR0FBRyxDQUFDO0FBQ3hKO0FBRUEsT0FBTyxpQkFBaUIsb0JBQW9CLE1BQU07QUFDOUMsUUFBTSxZQUFZLFNBQVMsZUFBZSxzQkFBc0I7QUFDaEUsTUFBSSxXQUFXO0FBQ1gsV0FBTyxRQUFRLHNCQUFzQixFQUFFLFFBQVEsQ0FBQyxDQUFDLEtBQUssS0FBSyxNQUFNO0FBQzdELFlBQU0sTUFBTSxTQUFTLGNBQWMsUUFBUTtBQUMzQyxVQUFJLFFBQVE7QUFBSyxVQUFJLGNBQWM7QUFDbkMsZ0JBQVUsWUFBWSxHQUFHO0FBQUEsSUFDN0IsQ0FBQztBQUFBLEVBQ0w7QUFDSixDQUFDO0FBZ0JELE1BQU0sU0FBUztBQUFBLEVBQ1gsY0FBYztBQUNWLFFBQUksV0FBVyxZQUFhLFlBQVcsUUFBUTtBQUFBLFFBQzFDLFlBQVcsaUJBQWlCO0FBQUEsRUFDckM7QUFBQSxFQUVBLGVBQWU7QUFDWCxVQUFNLElBQUksV0FBVztBQUNyQixXQUFPLElBQUssRUFBRSxlQUFlLEVBQUUsU0FBUyxxQkFBc0I7QUFBQSxFQUNsRTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFNQSxVQUFVO0FBQ04sVUFBTSxXQUFXLFNBQVMsZUFBZSxhQUFhO0FBQ3RELFVBQU0sUUFBUSxTQUFTLGVBQWUsVUFBVTtBQUNoRCxRQUFJLENBQUMsWUFBWSxDQUFDLE1BQU87QUFDekIsVUFBTSxJQUFJLFdBQVc7QUFDckIsUUFBSSxHQUFHO0FBQ0gsZUFBUyxZQUFZLHlCQUFvQixFQUFFLGVBQWUsRUFBRSxLQUFLO0FBQ2pFLFlBQU0sWUFBWTtBQUFBLElBQ3RCLE9BQU87QUFDSCxlQUFTLFlBQVk7QUFDckIsWUFBTSxZQUFZO0FBQUEsSUFDdEI7QUFBQSxFQUNKO0FBQ0o7QUFFQSxTQUFTLGlCQUFpQixvQkFBb0IsTUFBTSxPQUFPLFFBQVEsQ0FBQztBQUNwRSxTQUFTLGlCQUFpQixxQkFBcUIsTUFBTSxPQUFPLFFBQVEsQ0FBQztBQUNyRSxPQUFPLGlCQUFpQixvQkFBb0IsTUFBTSxPQUFPLFFBQVEsQ0FBQztBQVNsRSxNQUFNLGdCQUFnQixPQUFPLFdBQVcsbUJBQW1CLEVBQUU7QUFFN0QsSUFBSSxlQUFlO0FBT2YsTUFBUyxpQkFBVCxTQUF3QixPQUFPO0FBQzNCLFVBQU0sT0FBTyxhQUFhLHNCQUFzQjtBQUNoRCxVQUFNLEtBQUssS0FBSyxPQUFPLEtBQUssUUFBUTtBQUNwQyxVQUFNLEtBQUssS0FBSyxNQUFNLEtBQUssU0FBUztBQUNwQyxRQUFJLEtBQUssTUFBTSxVQUFVO0FBQ3pCLFFBQUksS0FBSyxNQUFNLFVBQVU7QUFDekIsVUFBTSxVQUFVLEtBQUssUUFBUTtBQUM3QixVQUFNLE9BQU8sS0FBSyxJQUFJLEtBQUssTUFBTSxJQUFJLEVBQUUsR0FBRyxPQUFPO0FBQ2pELFVBQU0sUUFBUSxLQUFLLE1BQU0sSUFBSSxFQUFFO0FBQy9CLFVBQU0sS0FBSyxLQUFLLElBQUksS0FBSyxJQUFJO0FBQzdCLFVBQU0sS0FBSyxLQUFLLElBQUksS0FBSyxJQUFJO0FBQzdCLGlCQUFhLE1BQU0sWUFBWSxhQUFhLEVBQUUsT0FBTyxFQUFFO0FBR3ZELFVBQU0sWUFBWSxVQUFVO0FBQzVCLFNBQUssS0FBSyxNQUFNLElBQUksS0FBSyxDQUFDO0FBQzFCLFNBQUssS0FBSyxNQUFNLElBQUksS0FBSztBQUN6QixTQUFLLEtBQUssTUFBTSxJQUFJLEtBQUssQ0FBQztBQUMxQixTQUFLLEtBQUssTUFBTSxJQUFJLEtBQUs7QUFBQSxFQUM3QixHQUVTLGdCQUFULFdBQXlCO0FBQ3JCLGlCQUFhLE1BQU0sWUFBWTtBQUMvQixTQUFLLEtBQUssTUFBTSxJQUFJLEtBQUssS0FBSyxNQUFNLElBQUksS0FBSyxLQUFLLE1BQU0sSUFBSSxLQUFLLEtBQUssTUFBTSxJQUFJO0FBQUEsRUFDcEY7QUE5QkEsUUFBTSxlQUFlLFNBQVMsZUFBZSxlQUFlO0FBQzVELFFBQU0sZUFBZSxTQUFTLGVBQWUsZUFBZTtBQUM1RCxRQUFNLFVBQVUsU0FBUyxlQUFlLFVBQVU7QUFDbEQsTUFBSSxrQkFBa0I7QUFDdEIsTUFBSSxhQUFhO0FBNEJqQixlQUFhLGlCQUFpQixjQUFjLE9BQUs7QUFDN0MsUUFBSSxLQUFLLE9BQVE7QUFDakIsTUFBRSxlQUFlO0FBQ2pCLHNCQUFrQixFQUFFLGVBQWUsQ0FBQyxFQUFFO0FBQ3RDLG1CQUFlLEVBQUUsZUFBZSxDQUFDLENBQUM7QUFBQSxFQUN0QyxDQUFDO0FBQ0QsZUFBYSxpQkFBaUIsYUFBYSxPQUFLO0FBQzVDLFFBQUksS0FBSyxPQUFRO0FBQ2pCLE1BQUUsZUFBZTtBQUNqQixlQUFXLEtBQUssRUFBRSxlQUFnQixLQUFJLEVBQUUsZUFBZSxnQkFBaUIsZ0JBQWUsQ0FBQztBQUFBLEVBQzVGLENBQUM7QUFDRCxlQUFhLGlCQUFpQixZQUFZLE9BQUs7QUFDM0MsZUFBVyxLQUFLLEVBQUUsZUFBZ0IsS0FBSSxFQUFFLGVBQWUsaUJBQWlCO0FBQUUsd0JBQWtCO0FBQU0sb0JBQWM7QUFBQSxJQUFHO0FBQUEsRUFDdkgsQ0FBQztBQUdELFVBQVEsaUJBQWlCLGNBQWMsT0FBSztBQUN4QyxRQUFJLEtBQUssT0FBUTtBQUNqQixNQUFFLGVBQWU7QUFDakIsVUFBTSxJQUFJLEVBQUUsZUFBZSxDQUFDO0FBQzVCLGlCQUFhLEVBQUU7QUFDZixTQUFLLE1BQU0sSUFBSSxFQUFFO0FBQVMsU0FBSyxNQUFNLElBQUksRUFBRTtBQUMzQyxTQUFLLE1BQU0sT0FBTztBQUFBLEVBQ3RCLENBQUM7QUFDRCxVQUFRLGlCQUFpQixhQUFhLE9BQUs7QUFDdkMsUUFBSSxLQUFLLE9BQVE7QUFDakIsTUFBRSxlQUFlO0FBQ2pCLGVBQVcsS0FBSyxFQUFFLGVBQWdCLEtBQUksRUFBRSxlQUFlLFlBQVk7QUFBRSxXQUFLLE1BQU0sSUFBSSxFQUFFO0FBQVMsV0FBSyxNQUFNLElBQUksRUFBRTtBQUFBLElBQVM7QUFBQSxFQUM3SCxDQUFDO0FBQ0QsVUFBUSxpQkFBaUIsWUFBWSxPQUFLO0FBQ3RDLGVBQVcsS0FBSyxFQUFFLGVBQWdCLEtBQUksRUFBRSxlQUFlLFlBQVk7QUFBRSxtQkFBYTtBQUFNLFdBQUssTUFBTSxPQUFPO0FBQUEsSUFBTztBQUFBLEVBQ3JILENBQUM7QUFFRCxXQUFTLGVBQWUsaUJBQWlCLEVBQUUsaUJBQWlCLGNBQWMsT0FBSztBQUMzRSxNQUFFLGVBQWU7QUFDakIsUUFBSSxDQUFDLEtBQUssVUFBVSxLQUFLLE9BQVEsTUFBSyxPQUFPLEtBQUs7QUFBQSxFQUN0RCxDQUFDO0FBQ0QsV0FBUyxlQUFlLG1CQUFtQixFQUFFLGlCQUFpQixjQUFjLE9BQUs7QUFDN0UsTUFBRSxlQUFlO0FBQ2pCLFFBQUksQ0FBQyxLQUFLLE9BQVEsTUFBSyxPQUFPO0FBQUEsRUFDbEMsQ0FBQztBQUNMO0FBY0EsU0FBUyxZQUFZLFNBQVMsSUFBSTtBQUM5QixTQUFPLFFBQVEsS0FBSyxDQUFDLFNBQVMsSUFBSSxRQUFRLGFBQVcsV0FBVyxTQUFTLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDbEY7QUFFQSxNQUFNLFdBQVc7QUFBQSxFQUNiLE1BQU0sTUFBTTtBQUNSLFVBQU0sT0FBTyxTQUFTLGVBQWUsb0JBQW9CO0FBQ3pELFVBQU0sTUFBTSxTQUFTLGVBQWUsbUJBQW1CO0FBQ3ZELFVBQU0sUUFBUSxTQUFTLGVBQWUscUJBQXFCO0FBQzNELFVBQU0sZ0JBQWdCLFNBQVMsZUFBZSxnQkFBZ0I7QUFFOUQsVUFBTSxRQUFRO0FBQUEsTUFDVixFQUFFLE9BQU8saUNBQWlDLFFBQVEsR0FBRyxLQUFLLENBQUMsTUFBTTtBQUFFLFVBQUUsR0FBRztBQUFHLGVBQU8sWUFBWSxXQUFXLE9BQU8sR0FBSSxFQUFFLEtBQUssTUFBTSxFQUFFLENBQUMsQ0FBQztBQUFBLE1BQUcsRUFBRTtBQUFBLE1BQzFJLEVBQUUsT0FBTyw2QkFBNkIsUUFBUSxHQUFHLEtBQUssQ0FBQyxNQUFNO0FBQUUsVUFBRSxDQUFDO0FBQUcsZUFBTyxRQUFRLFFBQVE7QUFBQSxNQUFHLEVBQUU7QUFBQSxNQUNqRyxFQUFFLE9BQU8sdUJBQXVCLFFBQVEsR0FBRyxLQUFLLENBQUMsTUFBTSxXQUFXLENBQUMsR0FBRyxNQUFNLEVBQUUsSUFBSSxDQUFDLENBQUMsRUFBRTtBQUFBLE1BQ3RGLEVBQUUsT0FBTyx5QkFBc0IsUUFBUSxHQUFHLEtBQUssQ0FBQyxNQUFNLGFBQWEsQ0FBQyxHQUFHLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQyxFQUFFO0FBQUEsTUFDdkYsRUFBRSxPQUFPLG9DQUFpQyxRQUFRLEdBQUcsS0FBSyxDQUFDLE1BQU07QUFDN0QsVUFBRSxHQUFHO0FBQ0wsY0FBTSxhQUFjLFNBQVMsU0FBUyxTQUFTLE1BQU0sUUFBUyxTQUFTLE1BQU0sUUFBUSxRQUFRLFFBQVE7QUFDckcsZUFBTyxZQUFZLFlBQVksR0FBSSxFQUFFLEtBQUssTUFBTSxFQUFFLENBQUMsQ0FBQztBQUFBLE1BQ3hELEVBQUU7QUFBQSxNQUNGLEVBQUUsT0FBTyw2QkFBNkIsUUFBUSxHQUFHLEtBQUssQ0FBQyxNQUFNO0FBQ3pELFlBQUksT0FBTyxpQkFBaUIsWUFBYSxjQUFhLEtBQUs7QUFDM0QsVUFBRSxDQUFDO0FBQ0gsZUFBTyxRQUFRLFFBQVE7QUFBQSxNQUMzQixFQUFFO0FBQUEsSUFDTjtBQUVBLFVBQU0sY0FBYyxNQUFNLE9BQU8sQ0FBQyxHQUFHLE9BQU8sSUFBSSxHQUFHLFFBQVEsQ0FBQztBQUM1RCxRQUFJLGFBQWE7QUFDakIsVUFBTSxZQUFZLENBQUMsVUFBVTtBQUN6QixZQUFNLFFBQVEsS0FBSyxJQUFJLGFBQWEsYUFBYSxLQUFLO0FBQ3RELFlBQU0sSUFBSSxLQUFLLE1BQU8sUUFBUSxjQUFlLEdBQUc7QUFDaEQsVUFBSSxLQUFNLE1BQUssTUFBTSxRQUFRLElBQUk7QUFDakMsVUFBSSxJQUFLLEtBQUksWUFBWSxJQUFJO0FBQUEsSUFDakM7QUFFQSxlQUFXLFFBQVEsT0FBTztBQUN0QixVQUFJLE1BQU8sT0FBTSxZQUFZLEtBQUs7QUFDbEMsWUFBTSxLQUFLLElBQUksQ0FBQyxTQUFTLFVBQVUsS0FBSyxTQUFTLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDaEYsb0JBQWMsS0FBSztBQUNuQixnQkFBVSxDQUFDO0FBQUEsSUFDZjtBQUVBLFFBQUksTUFBTyxPQUFNLFlBQVk7QUFDN0IsVUFBTSxJQUFJLFFBQVEsT0FBSyxXQUFXLEdBQUcsR0FBRyxDQUFDO0FBRXpDLFFBQUksY0FBZSxlQUFjLE1BQU0sVUFBVTtBQUNqRCxTQUFLLGlCQUFpQjtBQUFBLEVBQzFCO0FBQUEsRUFFQSxtQkFBbUI7QUFDZixRQUFJLFdBQVcsWUFBYSxNQUFLLGVBQWU7QUFBQSxRQUMzQyxNQUFLLFVBQVU7QUFBQSxFQUN4QjtBQUFBLEVBRUEsWUFBWTtBQUNSLFVBQU0sS0FBSyxTQUFTLGVBQWUsY0FBYztBQUNqRCxRQUFJLEdBQUksSUFBRyxNQUFNLFVBQVU7QUFBQSxFQUMvQjtBQUFBLEVBRUEsaUJBQWlCO0FBQ2IsVUFBTSxRQUFRLFNBQVMsZUFBZSxjQUFjO0FBQ3BELFFBQUksTUFBTyxPQUFNLE1BQU0sVUFBVTtBQUNqQyxVQUFNLEtBQUssU0FBUyxlQUFlLG1CQUFtQjtBQUN0RCxRQUFJLEdBQUksSUFBRyxNQUFNLFVBQVU7QUFBQSxFQUMvQjtBQUFBLEVBRUEsaUJBQWlCO0FBQ2IsVUFBTSxhQUFhLFNBQVMsZUFBZSxtQkFBbUI7QUFDOUQsUUFBSSxXQUFZLFlBQVcsTUFBTSxVQUFVO0FBSTNDLFFBQUksT0FBTyxpQkFBaUIsWUFBYSxjQUFhLFVBQVU7QUFFaEUsVUFBTSxjQUFjLFNBQVMsZUFBZSxjQUFjO0FBQzFELFFBQUksWUFBYSxhQUFZLE1BQU0sVUFBVTtBQUM3QyxRQUFJLE9BQU8sV0FBVyxZQUFhLFFBQU8sUUFBUTtBQUFBLEVBQ3REO0FBQ0o7QUFFQSxPQUFPLGlCQUFpQixvQkFBb0IsTUFBTTtBQUM5QyxRQUFNLFlBQVksU0FBUyxlQUFlLGtCQUFrQjtBQUM1RCxRQUFNLFdBQVcsU0FBUyxlQUFlLGlCQUFpQjtBQUMxRCxRQUFNLGFBQWEsU0FBUyxlQUFlLG1CQUFtQjtBQUU5RCxNQUFJLFdBQVc7QUFDWCxjQUFVLGlCQUFpQixTQUFTLFlBQVk7QUFDNUMsZ0JBQVUsV0FBVztBQUNyQixZQUFNLFdBQVcsaUJBQWlCO0FBQ2xDLGdCQUFVLFdBQVc7QUFDckIsZUFBUyxlQUFlO0FBQUEsSUFDNUIsQ0FBQztBQUFBLEVBQ0w7QUFDQSxNQUFJLFNBQVUsVUFBUyxpQkFBaUIsU0FBUyxNQUFNLFNBQVMsZUFBZSxDQUFDO0FBQ2hGLE1BQUksV0FBWSxZQUFXLGlCQUFpQixTQUFTLE1BQU0sU0FBUyxlQUFlLEdBQUcsRUFBRSxNQUFNLEtBQUssQ0FBQztBQUVwRyxXQUFTLElBQUk7QUFDakIsQ0FBQzsiLAogICJuYW1lcyI6IFsicCIsICJjIiwgInQiLCAicmV3YXJkIiwgImZ0Il0KfQo=
