/**
 * La base de datos de armas (WEAPONS_DB) y la tabla de posiciones de destello de
 * boca (WEAPON_MUZZLE_X) ahora viven en weapons.js, que se carga antes que este
 * archivo. Nada cambia en tiempo de ejecución: siguen siendo variables globales
 * con exactamente los mismos valores.
 */

// Regeneración/consumo de stamina precalculados una sola vez (antes se hacían
// las mismas divisiones "15/60" y "30/60" en cada frame dentro de update()).
const STAMINA_REGEN_PER_FRAME = 15 / 60;
const SPRINT_STAMINA_DRAIN_PER_FRAME = 30 / 60;

class Player {
    constructor() {
        this.x = MAP_SIZE / 2; this.y = MAP_SIZE / 2;
        this.radius = 24; this.hp = 100; this.maxHp = 100;
        this.money = 0;
        this.inventory = [ { ...WEAPONS_DB.G18, ammo: 15 }, { ...WEAPONS_DB.KNIFE }, null, null, null ];
        this.activeSlot = 0; this.isReloading = false;
        this.tick = 0; this.recoilOffset = 0;
        this.muzzleFlash = 0;
        this.chainsawFuel = 100; this.chainsawActive = false; // CHAINSAW: combustible de uso continuo
        this.minigunSpin = 0; // MINIGUN: 0 = frío, 1 = a máxima velocidad
        this.burstBusy = false; // FAMAS: evita reiniciar una ráfaga en curso

        // Dash y Stamina
        this.stamina = 100; this.maxStamina = 100;
        this.isDashing = false; this.dashTimer = 0; this.dashCooldownTimer = 0;
        this.dashDirX = 0; this.dashDirY = 0;
        
        // Efecto interno gelatinoso
        this.bubbles = Array.from({length: 5}, () => ({
            x: (Math.random()-0.5)*20, y: (Math.random()-0.5)*20, s: 2 + Math.random()*4, offset: Math.random()*Math.PI*2
        }));
    }
    get weapon() { return this.inventory[this.activeSlot]; }

    takeDamage(amt) {
        this.hp = Math.max(0, this.hp - amt);
        game.camera.shake = 10;
        document.getElementById('damage-overlay').style.opacity = "1";
        setTimeout(() => document.getElementById('damage-overlay').style.opacity = "0", 150);
        if(this.hp <= 0) { playSFX('muerte_player', 0.6); game.gameOver(); }
    }

    dash() {
        if(this.dashCooldownTimer > 0 || this.isDashing || this.stamina < 20) return;
        this.stamina -= 20;

        let dx = 0, dy = 0;
        if(game.keys['KeyW']) dy -= 1; if(game.keys['KeyS']) dy += 1;
        if(game.keys['KeyA']) dx -= 1; if(game.keys['KeyD']) dx += 1;
        if(dx === 0 && dy === 0) {
            let angle = Math.atan2(game.mouse.y - (this.y - game.camera.y), game.mouse.x - (this.x - game.camera.x));
            dx = Math.cos(angle); dy = Math.sin(angle);
        } else {
            const len = Math.hypot(dx, dy);
            dx /= len; dy /= len;
        }

        this.dashDirX = dx; this.dashDirY = dy;
        this.isDashing = true;
        this.dashTimer = 8;        // ~0.13s de dash a 60fps
        this.dashCooldownTimer = 45; // ~0.75s de cooldown
        game.camera.shake = 4;
        playSFX('reload', 0.15, 0.4); 
        for(let i=0; i<Math.ceil(10*game.particleScale); i++) game.spawnParticle(this.x, this.y, '#a8e6cf', 3, 3, 'normal');
    }

    update(keys) {
        if(this.dashCooldownTimer > 0) this.dashCooldownTimer--;

        // Regeneración de stamina (15 por segundo)
        this.stamina = Math.min(this.maxStamina, this.stamina + STAMINA_REGEN_PER_FRAME);

        let speedMultiplier = (game.playerSpeedMult || 1);
        if ((keys['ShiftLeft'] || keys['ShiftRight']) && this.stamina > 0.5 && !this.isDashing) {
            speedMultiplier = 1.6 * (game.playerSpeedMult || 1);
            this.stamina -= SPRINT_STAMINA_DRAIN_PER_FRAME; // Gasto por sprintar
        }
        if (this.weapon && this.weapon.mobility) speedMultiplier *= 1.15; // P90: gran movilidad

        if (this.weapon && this.weapon.spinup) { // MINIGUN: rampa de velocidad de disparo
            if (game.mouse.down && !this.isReloading) this.minigunSpin = Math.min(1, this.minigunSpin + 0.02);
            else this.minigunSpin = Math.max(0, this.minigunSpin - 0.015);
        } else if (this.minigunSpin > 0) this.minigunSpin = Math.max(0, this.minigunSpin - 0.03);

        if (this.weapon && this.weapon.fuel !== undefined) { // CHAINSAW: regenera combustible si no está cortando
            if (!this.chainsawActive) this.chainsawFuel = Math.min(this.weapon.fuel, this.chainsawFuel + 0.8);
        }
        this.chainsawActive = false; // se vuelve a marcar true en game.shoot si efectivamente corta este frame

        let vx = 0, vy = 0;
        if(this.isDashing) {
            vx = this.dashDirX * 18; vy = this.dashDirY * 18;
            if(Math.random() > 0.3) game.spawnTrail(this.x, this.y, this.radius * 0.9);
            this.dashTimer--;
            if(this.dashTimer <= 0) this.isDashing = false;
        } else {
            if(keys['KeyW']) vy = -5 * speedMultiplier; if(keys['KeyS']) vy = 5 * speedMultiplier;
            if(keys['KeyA']) vx = -5 * speedMultiplier; if(keys['KeyD']) vx = 5 * speedMultiplier;
            if(vx !== 0 && vy !== 0) { vx *= 0.707; vy *= 0.707; }
        }

        if(vx !== 0 || vy !== 0) {
            this.tick += 0.3;
            if(Math.random() > 0.9) game.spawnParticle(this.x, this.y + this.radius, '#555', 1, 2, 'smoke');
            if(Math.random() > 0.7) game.spawnTrail(this.x, this.y, this.radius * 0.8);
        }
        
        this.x = Math.max(this.radius, Math.min(MAP_SIZE-this.radius, this.x + vx));
        this.y = Math.max(this.radius, Math.min(MAP_SIZE-this.radius, this.y + vy));
        
        if(this.recoilOffset > 0) this.recoilOffset = Math.max(0, this.recoilOffset - 2);
        if(this.muzzleFlash > 0) this.muzzleFlash--;
    }

    draw(cam, mouse) {
        let moving = (game.keys['KeyW'] || game.keys['KeyS'] || game.keys['KeyA'] || game.keys['KeyD']);
        const bounce = moving ? Math.abs(Math.sin(this.tick)) * 6 : 0;
        const stretchX = moving ? 1 - Math.abs(Math.cos(this.tick)) * 0.15 : 1 + (this.recoilOffset*0.02);
        const stretchY = moving ? 1 + Math.abs(Math.cos(this.tick)) * 0.15 : 1 - (this.recoilOffset*0.02);
        
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.beginPath(); ctx.ellipse(this.x - cam.x, this.y - cam.y + 12, 30, 10, 0, 0, Math.PI*2); ctx.fill();

        ctx.save();
        ctx.translate(this.x - cam.x, this.y - cam.y - bounce);
        ctx.scale(stretchX, stretchY); 
        
        ctx.globalAlpha = 0.9;
        let grad = ctx.createRadialGradient(-5, -10, 0, 0, 0, this.radius);
        grad.addColorStop(0, '#a8e6cf'); grad.addColorStop(0.7, '#3b7a57'); grad.addColorStop(1, '#2c3e50');
        ctx.fillStyle = grad; ctx.strokeStyle = '#1e382b'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, this.radius, 0, Math.PI*2); ctx.fill(); ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        this.bubbles.forEach(b => {
            let by = b.y + Math.sin(this.tick * 0.5 + b.offset) * 3;
            ctx.beginPath(); ctx.arc(b.x, by, b.s, 0, Math.PI*2); ctx.fill();
        });

        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(0, 0, this.radius - 6, Math.PI + 0.5, Math.PI * 1.5 - 0.5); ctx.stroke();

        ctx.globalAlpha = 1;

        let angle = Math.atan2(mouse.y - (this.y - cam.y), mouse.x - (this.x - cam.x));
        let eyeOffsetX = Math.cos(angle) * 6; let eyeOffsetY = Math.sin(angle) * 6;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(-8 + eyeOffsetX, -4 + eyeOffsetY, 7, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(8 + eyeOffsetX, -4 + eyeOffsetY, 7, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(-8 + eyeOffsetX + Math.cos(angle)*3, -4 + eyeOffsetY + Math.sin(angle)*3, 3.5, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(8 + eyeOffsetX + Math.cos(angle)*3, -4 + eyeOffsetY + Math.sin(angle)*3, 3.5, 0, Math.PI*2); ctx.fill();

        if(this.weapon) {
            ctx.rotate(angle);
            ctx.translate(this.radius - 5, 0); 
            ctx.translate(-this.recoilOffset, 0); 
            
            // Sombra proyectada del arma: puramente cosmética/postprocesado, se apaga en ULTRA
            if (game.fxEnabled) { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 3; }
            
            if (this.weapon.name === 'AK47') {
                ctx.fillStyle = '#873600'; ctx.fillRect(-10, -3, 15, 6); 
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(5, -4, 20, 8); 
                ctx.fillStyle = '#34495e'; ctx.beginPath(); ctx.moveTo(15, 4); ctx.lineTo(10, 15); ctx.lineTo(20, 15); ctx.lineTo(25, 4); ctx.fill(); 
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(25, -2, 20, 4); 
                ctx.fillStyle = '#bdc3c7'; ctx.fillRect(35, -4, 2, 2); 
            } else if (this.weapon.name === 'SHOTGUN') {
                ctx.fillStyle = '#5c4033'; ctx.fillRect(-5, -4, 15, 8); 
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(10, -4, 30, 8); 
                ctx.fillStyle = '#111'; ctx.fillRect(10, -1, 30, 2); 
                ctx.fillStyle = '#873600'; ctx.fillRect(15, 4, 15, 5); 
            } else if (this.weapon.name === 'UZI') {
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(0, -5, 20, 10);
                ctx.fillStyle = '#34495e'; ctx.fillRect(5, 5, 8, 14); 
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(20, -2, 8, 4); 
            } else if (this.weapon.name === 'G18') {
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(0, -4, 15, 8);
                ctx.fillStyle = '#34495e'; ctx.fillRect(2, 4, 6, 8);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(15, -3, 5, 4); 
            } else if (this.weapon.name === 'REVOLVER') {
                ctx.fillStyle = '#5c4033'; ctx.fillRect(-6, -3, 10, 8); 
                ctx.fillStyle = '#7f8c8d'; ctx.beginPath(); ctx.arc(4, 0, 6, 0, Math.PI*2); ctx.fill(); 
                ctx.fillStyle = '#95a5a6'; ctx.fillRect(8, -3, 16, 6); 
            } else if (this.weapon.name === 'SNIPER') {
                ctx.fillStyle = '#34495e'; ctx.fillRect(-10, -3, 50, 6); 
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(-5, -9, 15, 5); 
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(5, -12, 3, 8); 
            } else if (this.weapon.name === 'MINIGUN') {
                ctx.fillStyle = '#c0392b'; ctx.fillRect(-8, -6, 15, 12); 
                ctx.fillStyle = '#2c3e50';
                for(let i=0; i<4; i++) ctx.fillRect(8, -6 + i*3, 22, 2); 
            } else if (this.weapon.name === 'CROSSBOW') {
                ctx.strokeStyle = '#16a085'; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.moveTo(5,-14); ctx.lineTo(15,0); ctx.lineTo(5,14); ctx.stroke(); 
                ctx.fillStyle = '#5c4033'; ctx.fillRect(-5, -2, 20, 4); 
            } else if (this.weapon.name === 'MP5') {
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(0, -4, 26, 8);
                ctx.fillStyle = '#34495e'; ctx.fillRect(4, 4, 6, 12);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(26, -2, 8, 4);
            } else if (this.weapon.name === 'P90') {
                ctx.fillStyle = '#8e44ad'; ctx.fillRect(-5, -6, 34, 10);
                ctx.fillStyle = '#5e3370'; ctx.fillRect(2, -12, 18, 8);
                ctx.fillStyle = '#34495e'; ctx.fillRect(29, -3, 6, 5);
            } else if (this.weapon.name === 'SAWEDOFF') {
                ctx.fillStyle = '#5c4033'; ctx.fillRect(-8, -4, 14, 8);
                ctx.fillStyle = '#111'; ctx.fillRect(6, -5, 14, 5); ctx.fillRect(6, 1, 14, 4);
            } else if (this.weapon.name === 'AA12') {
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(-5, -5, 30, 10);
                ctx.fillStyle = '#111'; ctx.fillRect(25, -3, 10, 6);
                ctx.fillStyle = '#7f8c8d'; ctx.beginPath(); ctx.arc(0, 8, 6, 0, Math.PI*2); ctx.fill();
            } else if (this.weapon.name === 'M4A1') {
                ctx.fillStyle = '#2ecc71'; ctx.fillRect(0, -4, 20, 8);
                ctx.fillStyle = '#1e8449'; ctx.fillRect(-8, 4, 6, 12);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(20, -3, 22, 4);
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(5, -10, 12, 6);
            } else if (this.weapon.name === 'FAMAS') {
                ctx.fillStyle = '#3498db'; ctx.fillRect(-8, -6, 40, 10);
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(30, -4, 12, 4);
                ctx.fillStyle = '#1a5276'; ctx.fillRect(-8, -12, 14, 6);
            } else if (this.weapon.name === 'SCAR') {
                ctx.fillStyle = '#16a085'; ctx.fillRect(0, -5, 24, 9);
                ctx.fillStyle = '#0e6655'; ctx.fillRect(-9, 3, 7, 13);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(24, -3, 20, 4);
            } else if (this.weapon.name === 'WINCHESTER') {
                ctx.fillStyle = '#8e5a2d'; ctx.fillRect(-10, -3, 55, 6);
                ctx.fillStyle = '#5c4033'; ctx.fillRect(-14, 2, 10, 10);
                ctx.fillStyle = '#c9a86a'; ctx.fillRect(0, -6, 30, 3);
            } else if (this.weapon.name === 'AWP') {
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(-10, -4, 60, 7);
                ctx.fillStyle = '#1a252f'; ctx.fillRect(-6, -11, 18, 6);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(8, -14, 3, 9);
                ctx.fillStyle = '#34495e'; ctx.fillRect(-14, 1, 8, 12);
            } else if (this.weapon.name === 'M249') {
                ctx.fillStyle = '#556b2f'; ctx.fillRect(-5, -6, 30, 12);
                ctx.fillStyle = '#3e4f22'; ctx.beginPath(); ctx.arc(-2, 10, 10, 0, Math.PI*2); ctx.fill();
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(30, -3, 22, 4);
            } else if (this.weapon.name === 'RPG') {
                ctx.fillStyle = '#5c4a1a'; ctx.fillRect(-10, -7, 60, 14);
                ctx.fillStyle = '#2c3e50'; ctx.beginPath(); ctx.moveTo(50, -7); ctx.lineTo(66, 0); ctx.lineTo(50, 7); ctx.fill();
                ctx.fillStyle = '#e67e22'; ctx.fillRect(2, -4, 8, 8);
            } else if (this.weapon.name === 'FLAMETHROWER') {
                ctx.fillStyle = '#7f2b0a'; ctx.fillRect(-5, -6, 40, 12);
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(-10, 2, 12, 16);
                ctx.fillStyle = '#ff8800'; ctx.fillRect(35, -3, 10, 6);
            } else if (this.weapon.name === 'CHAINSAW') {
                ctx.fillStyle = '#e67e22'; ctx.fillRect(-6, -6, 18, 14);
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(10, -4, 34, 8);
                ctx.strokeStyle = '#bdc3c7'; ctx.lineWidth = 2;
                for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(12 + i*5, -4); ctx.lineTo(12 + i*5, 4); ctx.stroke(); }
            } else if (this.weapon.type === 'melee') {
                ctx.fillStyle = '#873600'; ctx.fillRect(0, -3, 10, 6); 
                ctx.fillStyle = '#bdc3c7'; ctx.beginPath(); ctx.moveTo(10, -2); ctx.lineTo(30, 0); ctx.lineTo(10, 2); ctx.fill(); 
                ctx.fillStyle = '#ecf0f1'; ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(28, 0); ctx.lineTo(10, 1); ctx.fill(); 
            } else {
                // Fallback genérico: cualquier arma de fuego futura sin modelo propio no queda invisible
                ctx.fillStyle = this.weapon.color; ctx.fillRect(0, -4, 22, 8);
                ctx.fillStyle = '#2c3e50'; ctx.fillRect(-6, 3, 6, 10);
                ctx.fillStyle = '#7f8c8d'; ctx.fillRect(22, -2, 10, 4);
            }
            
            ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetY = 0;

            // Destello de boca/glow: efecto puramente cosmético, se apaga por completo en ULTRA
            if (game.fxEnabled && this.muzzleFlash > 0 && this.weapon.type === 'range') {
                ctx.fillStyle = '#f1c40f';
                ctx.globalAlpha = 0.9;
                ctx.beginPath();
                let mX = WEAPON_MUZZLE_X[this.weapon.name] ?? 25;
                ctx.arc(mX, 0, 12 + Math.random()*15, 0, Math.PI*2);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.beginPath(); ctx.arc(mX, 0, 6 + Math.random()*5, 0, Math.PI*2); ctx.fill();
                ctx.globalAlpha = 1;
            }
        }
        ctx.restore();

        // Barra de Stamina
        ctx.fillStyle = 'rgba(0,0,0,0.8)'; 
        ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 10, 40, 5);
        ctx.fillStyle = '#3498db'; 
        ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 10, 40 * (this.stamina/this.maxStamina), 5);

        // Barra secundaria: combustible de la Chainsaw o rampa de la Minigun
        if (this.weapon && this.weapon.fuel !== undefined) {
            ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40, 4);
            ctx.fillStyle = this.chainsawFuel < 25 ? '#e74c3c' : '#f39c12';
            ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40 * (this.chainsawFuel/this.weapon.fuel), 4);
        } else if (this.weapon && this.weapon.spinup) {
            ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40, 4);
            ctx.fillStyle = '#c0392b';
            ctx.fillRect(this.x - cam.x - 20, this.y - cam.y + this.radius + 17, 40 * this.minigunSpin, 4);
        }
    }
}

game.reload = function() {
    let w = this.player.weapon;
    if(!w || w.type === 'melee' || this.player.isReloading || w.ammo === w.capacity) return;
    this.player.isReloading = true;
    playSFX('reload');
    if (w.singleReload) { // WINCHESTER: carga bala por bala, se puede interrumpir cambiando de arma
        const step = () => {
            if (this.player.weapon !== w) { this.player.isReloading = false; return; } // cambiaron de arma
            w.ammo = Math.min(w.capacity, w.ammo + 1);
            playSFX('reload', 0.25);
            if (w.ammo < w.capacity) setTimeout(step, w.reloadTime);
            else this.player.isReloading = false;
        };
        setTimeout(step, w.reloadTime);
    } else {
        setTimeout(() => { w.ammo = w.capacity; this.player.isReloading = false; }, w.reloadTime);
    }
};

game.shoot = function() {
    let w = this.player.weapon;
    if(!w || this.player.isReloading) return;
    if (w.fuel !== undefined && this.player.chainsawFuel <= 0) return; // CHAINSAW sin combustible

    let effFireRate = w.fireRate * (game.weaponFireRateMult || 1);
    if (w.spinup) effFireRate *= (1.8 - this.player.minigunSpin * 1.3); // MINIGUN: arranca lenta, acelera con el spin
    if (Date.now() - this.lastShot < effFireRate) return;

    if(w.type === 'melee') {
        // Rastrea si el swing efectivamente conecta con algún enemigo, para elegir
        // el sonido correcto (motor girando en el aire vs. sonido de impacto)
        let hitSomething = false;
        this.enemies.forEach(e => {
            if(!e.invulnerable && Math.hypot(this.player.x - e.x, this.player.y - e.y) < w.range + e.radius) {
                this.hitEnemy(e, w.damage);
                hitSomething = true;
            }
        });
        if (w.fuel !== undefined) { // CHAINSAW: consume combustible mientras corta
            this.player.chainsawFuel = Math.max(0, this.player.chainsawFuel - w.fuelDrain);
            this.player.chainsawActive = true;
            // CHAINSAW = motor girando en el aire, CHAINSAWHIT = conectando con un enemigo
            playSFX(hitSomething ? 'chainsaw_hit' : 'chainsaw', 0.2, 0.05);
        } else {
            // Sonido melee aleatorio para knife/machete
            const meleeVariants = ['melee', 'melee2', 'melee3'];
            playSFX(meleeVariants[Math.floor(Math.random() * meleeVariants.length)], 0.3, 0.1);
        }
        this.lastShot = Date.now();
        return;
    }

    if (w.ammo <= 0) { this.reload(); return; }
    if (w.burst && this.player.burstBusy) return; // FAMAS: ya hay una ráfaga en curso

    const fireOnce = () => {
        // Usar sonido específico del arma, con fallback inteligente
        let soundKey = w.sfx || 'shoot_G18';
        if (soundKey === 'shoot_G18' && w.name === 'REVOLVER') soundKey = 'shoot_revolver';
        else if (soundKey === 'shoot_G18' && ['AK47', 'M4A1', 'FAMAS', 'SCAR'].includes(w.name)) soundKey = 'shoot_rifle';
        else if (soundKey === 'shoot_G18' && ['UZI', 'MP5', 'P90'].includes(w.name)) soundKey = 'shoot_smg';
        else if (soundKey === 'shoot_G18' && ['SNIPER', 'AWP'].includes(w.name)) soundKey = 'shoot_sniper';
        else if (soundKey === 'shoot_G18' && w.name === 'WINCHESTER') soundKey = 'shoot_sniper2';
        
        playSFX(soundKey, 0.4, 0.2);
        this.player.recoilOffset = w.shake * 2;
        this.player.muzzleFlash = 3;
        this.camera.shake = w.shake;

        let angle = Math.atan2(this.mouse.y - (this.player.y - this.camera.y), this.mouse.x - (this.player.x - this.camera.x));

        if(w.casing) this.spawnCasing(this.player.x, this.player.y, angle);
        if(w.smoke) {
            for(let i=0; i<w.smoke; i++) this.spawnParticle(this.player.x + Math.cos(angle)*30, this.player.y + Math.sin(angle)*30, w.name === 'FLAMETHROWER' ? '#ff8800' : '#bdc3c7', 2, 3, 'smoke');
        }

        if(w.pellets) {
            for(let i=0; i<w.pellets; i++) this.spawnProjectile(this.player.x, this.player.y, angle + (Math.random()-0.5)*(w.spread + (game.weaponSpreadBonus || 0)), w);
        } else {
            let s = (Math.random()-0.5) * (w.spread + (game.weaponSpreadBonus || 0));
            this.spawnProjectile(this.player.x, this.player.y, angle + s, w);
        }
        w.ammo--;
    };

    if (w.burst) { // FAMAS: dispara 3 tiros encadenados aunque el jugador haya soltado el click
        this.player.burstBusy = true;
        let shots = 0;
        const nextShot = () => {
            if (w.ammo <= 0 || shots >= w.burst) { this.player.burstBusy = false; return; }
            fireOnce(); shots++;
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
    e.hp -= dmg;
    e.flash = 4;
    // Sin sonido genérico de "hit" acá: cada arma ya reproduce su propio sonido
    // (disparo o swing/chainsaw) en el momento del ataque. Antes esto reutilizaba
    // el sonido de melee (MEELE.mp3) para CUALQUIER impacto, incluyendo balas,
    // por eso se escuchaba el "golpe de cuchillo" al disparar armas de fuego.
    for(let i=0; i<Math.ceil(8*this.particleScale); i++) this.spawnParticle(e.x, e.y, e.color, 4, 3, 'normal'); 
    
    let t = this.floatingTexts.find(t => !t.active);
    if(!t) { t = new FloatingText(); this.floatingTexts.push(t); }
    t.init(e.x, e.y, Math.floor(dmg), '#fff', 20);

    if(e.hp <= 0 && !e.isDying) {
        e.isDying = true;
        playSFX('death', 0.5);
        const REWARDS = { BOSS: 1000, TANK: 80, RANGED: 45, FAST: 25, BASIC: 30, INVISIBLE: 35, KAMIKAZE: 20, GHOST: 45 };
        let reward = Math.floor((REWARDS[e.type] ?? 30) * (game.moneyMult || 1));
        this.player.money += reward;

        let ft = this.floatingTexts.find(ft => !ft.active);
        if(!ft) { ft = new FloatingText(); this.floatingTexts.push(ft); }
        ft.init(e.x, e.y - 20, `+$${reward}`, '#f1c40f', 24);

        for(let n=0; n<Math.ceil(20*this.particleScale); n++) this.spawnParticle(e.x, e.y, e.color, 6, 4, 'normal');
        this.spawnTrail(e.x, e.y, e.radius * 1.5); 

        const idx = this.enemies.indexOf(e);
        if(idx !== -1) this.enemies.splice(idx, 1);
        
        // Aparición del jefe cuando quedan pocos enemigos
        if (this.bossPending && this.enemies.length <= 4) {
            this.spawnBoss();
            this.bossPending = false;
            let bt = this.floatingTexts.find(ft => !ft.active);
            if(!bt) { bt = new FloatingText(); this.floatingTexts.push(bt); }
            bt.init(this.player.x, this.player.y - 60, "BOSS INCOMING!", '#c0392b', 35);
        }
    }
};
