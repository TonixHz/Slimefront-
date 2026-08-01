/**
 * GENERACIÓN DE TERRENO PROCEDURAL (LIGERO)
 */
function createProceduralTerrain() {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = 512; offCanvas.height = 512;
    const oCtx = offCanvas.getContext('2d');
    
    // Base grass
    oCtx.fillStyle = '#3e4a3d';
    oCtx.fillRect(0, 0, 512, 512);

    // Variaciones de pasto
    for(let i=0; i<300; i++) {
        oCtx.fillStyle = Math.random() > 0.5 ? '#455344' : '#384236';
        oCtx.beginPath();
        oCtx.arc(Math.random()*512, Math.random()*512, Math.random()*15, 0, Math.PI*2);
        oCtx.fill();
    }
    // Zonas de tierra
    for(let i=0; i<15; i++) {
        oCtx.fillStyle = 'rgba(92, 64, 51, 0.15)';
        oCtx.beginPath();
        oCtx.arc(Math.random()*512, Math.random()*512, 20 + Math.random()*40, 0, Math.PI*2);
        oCtx.fill();
    }
    // Piedritas y detalles oscuros
    for(let i=0; i<150; i++) {
        oCtx.fillStyle = Math.random() > 0.5 ? '#2c3e50' : '#1e272e';
        oCtx.globalAlpha = 0.4;
        oCtx.beginPath();
        oCtx.arc(Math.random()*512, Math.random()*512, 1 + Math.random()*2, 0, Math.PI*2);
        oCtx.fill();
    }
    oCtx.globalAlpha = 1;
    return ctx.createPattern(offCanvas, 'repeat');
}
const terrainPattern = createProceduralTerrain();

/**
 * PROPS PROCEDURALES CON COLISIONES Y VARIANTES
 */
class Prop {
    constructor(type) {
        this.type = type;
        this.x = Math.random() * MAP_SIZE;
        this.y = Math.random() * MAP_SIZE;
        this.rot = Math.random() * Math.PI * 2;
        this.scale = 0.8 + Math.random() * 0.5;
        
        // Asignación de radios y solidez según tipo
        if (['rock', 'rock_tall', 'rock_split', 'tree', 'tree_pine', 'tree_dead', 'crate'].includes(type)) {
            this.isSolid = true;
            this.radius = type.includes('tree') ? 15 * this.scale : (type === 'crate' ? 25 * this.scale : 20 * this.scale);
        } else {
            this.isSolid = false;
            this.radius = 0;
        }
    }
    drawShadow(cam) {
        if (!isVisible(this.x, this.y, 40, cam)) return;
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.beginPath();
        ctx.ellipse(this.x - cam.x + 15*this.scale, this.y - cam.y + 10*this.scale, 35*this.scale, 20*this.scale, 0, 0, Math.PI*2);
        ctx.fill();
    }
    draw(cam) {
        if (!isVisible(this.x, this.y, 50 * this.scale, cam)) return;
        ctx.save();
        ctx.translate(this.x - cam.x, this.y - cam.y);
        ctx.rotate(this.rot);
        ctx.scale(this.scale, this.scale);
        
        if (this.type.includes('rock')) {
            ctx.fillStyle = '#7f8c8d'; ctx.strokeStyle = '#2c3e50'; ctx.lineWidth = 2;
            ctx.beginPath(); 
            if (this.type === 'rock_tall') {
                ctx.moveTo(-15, 10); ctx.lineTo(-10, -40); ctx.lineTo(10, -35); ctx.lineTo(15, 10);
            } else if (this.type === 'rock_split') {
                ctx.moveTo(-20, -5); ctx.lineTo(-5, -20); ctx.lineTo(0, 0); ctx.lineTo(15, -15); ctx.lineTo(25, 10); ctx.lineTo(-25, 10);
            } else {
                ctx.moveTo(-20, -10); ctx.lineTo(10, -25); ctx.lineTo(30, 5); ctx.lineTo(10, 20); ctx.lineTo(-25, 10);
            }
            ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.beginPath(); ctx.arc(-5, -5, 10, 0, Math.PI); ctx.fill();
        } 
        else if (this.type.includes('tree')) {
            ctx.fillStyle = '#5c4033'; ctx.strokeStyle = '#3e2723'; ctx.lineWidth = 2;
            ctx.fillRect(-5, -10, 10, 20); ctx.strokeRect(-5, -10, 10, 20);
            if (this.type === 'tree_pine') {
                ctx.fillStyle = '#1e8449'; ctx.strokeStyle = '#145a32';
                ctx.beginPath(); ctx.moveTo(0, -50); ctx.lineTo(-25, 0); ctx.lineTo(25, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0, -30); ctx.lineTo(-30, 15); ctx.lineTo(30, 15); ctx.closePath(); ctx.fill(); ctx.stroke();
            } else if (this.type === 'tree') {
                ctx.fillStyle = '#27ae60'; ctx.strokeStyle = '#1e8449';
                for(let i=0; i<4; i++) {
                    ctx.beginPath(); ctx.arc(Math.cos(i*1.5)*15, -15 + Math.sin(i*1.5)*10, 20, 0, Math.PI*2); ctx.fill(); ctx.stroke();
                }
            } else if (this.type === 'tree_dead') {
                ctx.strokeStyle = '#5c4033'; ctx.lineWidth = 3; ctx.lineCap = 'round';
                ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-15, -30); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(15, -25); ctx.stroke();
            }
        }
        else if (this.type === 'crate') {
            ctx.fillStyle = '#d35400'; ctx.strokeStyle = '#873600'; ctx.lineWidth = 3;
            ctx.fillRect(-20, -20, 40, 40); ctx.strokeRect(-20, -20, 40, 40);
            ctx.beginPath(); ctx.moveTo(-20, -20); ctx.lineTo(20, 20); ctx.moveTo(20, -20); ctx.lineTo(-20, 20); ctx.stroke();
            ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(0, -20, 20, 40);
        } else if (this.type === 'bush') {
            ctx.fillStyle = '#1e8449'; ctx.strokeStyle = '#145a32'; ctx.lineWidth = 2;
            for(let i=0; i<3; i++) {
                ctx.beginPath(); ctx.arc(Math.cos(i*2.1)*10, Math.sin(i*2.1)*10, 15, 0, Math.PI*2);
                ctx.fill(); ctx.stroke();
            }
        } else if (this.type === 'pebbles') {
            ctx.fillStyle = '#95a5a6';
            ctx.beginPath(); ctx.arc(-5, -2, 3, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(5, 3, 2, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(0, 5, 4, 0, Math.PI*2); ctx.fill();
        }
        ctx.restore();
    }
}

// Grid espacial: agrupa props sólidos en celdas para no chequear colisión contra TODOS los props
game.buildPropGrid = function() {
    this.propGridSize = 200;
    this.propGrid = new Map();
    // Array reutilizable devuelto por getNearbyProps: se consume siempre de forma
    // síncrona e inmediata en cada call site, así que evitar crear un array nuevo
    // por cada consulta (jugador + cada enemigo cercano + cada proyectil activo,
    // todos los frames) reduce mucho la basura generada para el Garbage Collector.
    this._nearbyPropsScratch = [];
    this.props.forEach(p => {
        if (!p.isSolid) return;
        const key = this.propGridKey(p.x, p.y);
        if (!this.propGrid.has(key)) this.propGrid.set(key, []);
        this.propGrid.get(key).push(p);
    });
};
game.propGridKey = function(x, y) {
    // Clave numérica en vez de template string: mismo resultado (una celda = una
    // clave única), pero sin la asignación de memoria que implica construir un
    // string nuevo en cada llamada (se llama muchas veces por frame).
    return Math.floor(x / this.propGridSize) * 100000 + Math.floor(y / this.propGridSize);
};
// Devuelve solo los props sólidos cercanos (celda actual + 8 vecinas)
game.getNearbyProps = function(x, y) {
    const gx = Math.floor(x / this.propGridSize);
    const gy = Math.floor(y / this.propGridSize);
    const result = this._nearbyPropsScratch;
    result.length = 0;
    for(let dx=-1; dx<=1; dx++) {
        for(let dy=-1; dy<=1; dy++) {
            const arr = this.propGrid.get((gx+dx) * 100000 + (gy+dy));
            if(arr) for(let i=0; i<arr.length; i++) result.push(arr[i]);
        }
    }
    return result;
};

const WEAPON_COSTS = {
    REVOLVER: 500, MACHETE: 400, UZI: 600, CROSSBOW: 700, SHOTGUN: 1000, AK47: 1800, MINIGUN: 2500, SNIPER: 2200,
    MP5: 900, P90: 1300, SAWEDOFF: 1100, AA12: 2000, M4A1: 1600, FAMAS: 1500, SCAR: 2100, WINCHESTER: 1400,
    AWP: 3200, M249: 2600, RPG: 3500, FLAMETHROWER: 2400, CHAINSAW: 1700
};

game.startNextWave = function() {
    document.getElementById('shop-menu').style.display = 'none';
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
    
    let count = 15 + (this.wave * 8);
    if (this.activeEvent === 'INVASION') count *= 2; // el doble de enemigos durante la invasión
    for(let i=0; i<count; i++) {
        let a = Math.random() * Math.PI * 2;
        let d = 800 + Math.random() * 600;
        let type = this.wave > 6 && Math.random() > 0.85 ? 'GHOST' : (this.wave > 4 && Math.random() > 0.85 ? 'INVISIBLE' : (this.wave > 3 && Math.random() > 0.85 ? 'KAMIKAZE' : (this.wave > 3 && Math.random() > 0.8 ? 'TANK' : (this.wave > 2 && Math.random() > 0.7 ? 'RANGED' : (this.wave > 1 && Math.random() > 0.8 ? 'FAST' : 'BASIC')))));
        let pos = this.findClearSpawn(this.player.x + Math.cos(a)*d, this.player.y + Math.sin(a)*d);
        this.enemies.push(new Enemy(pos.x, pos.y, type));
    }

    // Configurar si aparecerá un jefe en base a la wave
    if (this.wave === 5 || this.wave === 15 || this.wave === 30 || (this.wave > 30 && (this.wave - 30) % 10 === 0)) {
        this.bossPending = true;
    } else {
        this.bossPending = false;
    }
};

game.spawnBoss = function() {
    let a = Math.random() * Math.PI * 2;
    let bossPos = this.findClearSpawn(this.player.x + Math.cos(a)*800, this.player.y + Math.sin(a)*800);
    this.enemies.push(new Enemy(bossPos.x, bossPos.y, 'BOSS'));
    MusicManager.switchContext(MusicManager.bossTracks, 1000);
};

game.findClearSpawn = function(x, y) {
    for(let attempt = 0; attempt < 8; attempt++) {
        let blocked = this.props.some(p => p.isSolid && Math.hypot(x - p.x, y - p.y) < p.radius + 45);
        if(!blocked) return { x, y };
        x += (Math.random() - 0.5) * 200;
        y += (Math.random() - 0.5) * 200;
    }
    return { x, y };
};

// Economía
game.buyAmmo = function() {
    if(this.player.money >= 150) {
        this.player.money -= 150;
        this.player.inventory.forEach(w => { if(w && w.type === 'range') w.ammo = w.capacity; });
        playSFX('reload');
    }
};

game.buyHealth = function() {
    if(this.player.money >= 200 && this.player.hp < this.player.maxHp) {
        this.player.money -= 200; this.player.hp = this.player.maxHp;
        playSFX('coin');
    }
};

game.buyWeapon = function(k) {
    const w = WEAPONS_DB[k];
    const cost = WEAPON_COSTS[k];
    if(this.player.money >= cost) {
        let slot = this.player.inventory.findIndex(s => s === null);
        if(slot !== -1) {
            this.player.money -= cost;
            this.player.inventory[slot] = { ...w, ammo: w.capacity };
            playSFX('reload');
            this.updateShop();
        }
    }
};

game.sellWeapon = function(k) {
    let idx = this.player.inventory.findIndex(i => i && i.name === k);
    if(idx === -1) return;
    const refund = Math.floor(WEAPON_COSTS[k] / 2);
    this.player.money += refund;
    this.player.inventory[idx] = null;
    if(this.player.activeSlot === idx) {
        let fallback = this.player.inventory.findIndex(s => s !== null);
        this.player.activeSlot = fallback !== -1 ? fallback : 0;
    }
    playSFX('coin');
    this.updateShop();
};
