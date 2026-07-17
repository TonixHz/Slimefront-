class Projectile {
    init(x, y, angle, weapon, isEnemy = false) {
        this.x = x; this.y = y;
        this.vx = Math.cos(angle) * weapon.speed * (game.projectileSpeedMult || 1);
        this.vy = Math.sin(angle) * weapon.speed * (game.projectileSpeedMult || 1);
        this.damage = weapon.damage;
        this.radius = isEnemy ? 6 : 4;
        this.color = isEnemy ? '#ff4d4d' : weapon.color;
        this.active = true; this.isEnemy = isEnemy;
        this.trail = [];
        // Rasgos opcionales de arma (0/undefined = sin efecto, no rompe armas viejas)
        this.pierce = weapon.pierce || 0;
        this.knockback = weapon.knockback || 0;
        this.burn = weapon.burn || false;
        this.explosive = weapon.explosive || false;
        this.explosionRadius = weapon.explosionRadius || 0;
        this.maxRange = weapon.maxRange || 1800; // recicla el proyectil aunque la wapon no defina un rango propio
        this.traveled = 0;
        this.hitEnemies = this.hitEnemies || new Set();
        if (this.hitEnemies.size) this.hitEnemies.clear();
    }
    update() {
        this.trail.push({x: this.x, y: this.y});
        if(this.trail.length > 5) this.trail.shift();
        this.x += this.vx; this.y += this.vy;
        if (this.maxRange) {
            this.traveled += Math.hypot(this.vx, this.vy);
            if (this.traveled > this.maxRange) this.active = false;
        }
        if(this.x < 0 || this.x > MAP_SIZE || this.y < 0 || this.y > MAP_SIZE) this.active = false;
    }
    draw(cam) {
        if (!isVisible(this.x, this.y, 20, cam)) return;
        ctx.beginPath();
        ctx.moveTo(this.x - cam.x, this.y - cam.y);
        for(let i = this.trail.length - 1; i >= 0; i--) { ctx.lineTo(this.trail[i].x - cam.x, this.trail[i].y - cam.y); }
        ctx.strokeStyle = this.color; ctx.lineWidth = this.radius; ctx.lineCap = 'round';
        ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;

        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(this.x - cam.x, this.y - cam.y, this.radius, 0, Math.PI*2); ctx.fill();
    }
}

class Enemy {
    constructor(x, y, type) {
        this.x = x; this.y = y; this.type = type;
        this.flash = 0; this.tick = Math.random() * 100;
        this.isDying = false;
        
        const m = 1 + (game.wave * 0.25);
        if(type === 'TANK') { this.maxHp = 300 * m; this.speed = 1.1; this.radius = 35; this.color = '#2c3e50'; } 
        else if(type === 'FAST') { this.maxHp = 40 * m; this.speed = 4.0; this.radius = 18; this.color = '#e67e22'; } 
        else if(type === 'RANGED') { this.maxHp = 80 * m; this.speed = 1.8; this.radius = 24; this.color = '#8e44ad'; this.lastShot = 0; } 
        else if(type === 'INVISIBLE') { this.maxHp = 60 * m; this.speed = 2.4; this.radius = 22; this.color = '#16a085'; this.invisAlpha = 0; this.onscreenVisibleTimer = 0; this.wasOnScreen = false; }
        else if(type === 'KAMIKAZE') { this.maxHp = 25 * m; this.speed = 2.4 * 1.3; this.radius = 20; this.color = '#e74c3c'; this.baseColor = this.color; this.kamikazeState = 'CHASE'; this.kamikazeTimer = 0; this.explodeScale = 1; }
        else if(type === 'GHOST') { this.maxHp = 90 * m; this.speed = 2.0; this.radius = 22; this.color = '#9b59b6'; this.ghostState = 'GHOST'; this.ghostTimer = 0; this.ghostAlpha = 0.18; this.invulnerable = true; }
        else if(type === 'BOSS') { 
            this.bossWave = game.wave;
            if (this.bossWave >= 30) {
                this.maxHp = (4000 + (this.bossWave - 30) * 500) * m;
            } else if (this.bossWave >= 15) {
                this.maxHp = 2500 * m;
            } else {
                this.maxHp = 1500 * m;
            }
            this.speed = 1.6; this.radius = 70; this.color = '#c0392b'; 
            this.state = 'IDLE'; this.stateTimer = 0; this.summonTimer = 0;
            this.dashTargetAngle = 0; this.shootCount = 0;
        } 
        else { this.maxHp = 70 * m; this.speed = 2.4; this.radius = 22; this.color = '#27ae60'; }
        // Modificadores de eventos dinámicos (Mutación agranda/fortalece, etc. Ver events.js)
        this.speed *= (game.enemySpeedMult || 1);
        if (game.enemySizeMult) this.radius *= game.enemySizeMult;
        if (game.enemyHpMult) this.maxHp *= game.enemyHpMult;
        this.hp = this.maxHp;
    }
    update(player) {
        this.tick += 0.2;
        let d = this._dist !== undefined ? this._dist : Math.hypot(player.x - this.x, player.y - this.y);
        let angle = Math.atan2(player.y - this.y, player.x - this.x);

        if (this.type === 'KAMIKAZE') {
            if (this.kamikazeState === 'CHASE' && d < 120) { this.kamikazeState = 'ARMED'; this.kamikazeTimer = 0; }
            if (this.kamikazeState === 'ARMED') {
                this.kamikazeTimer++;
                this.color = this.kamikazeTimer % 6 < 3 ? '#fff' : this.baseColor;
                this.explodeScale = 1 + Math.min(0.4, (this.kamikazeTimer / 60) * 0.4);
                if (this.kamikazeTimer > 60) { // ~1s de cuenta regresiva antes de explotar
                    const blastRadius = 120;
                    if (d < blastRadius) player.takeDamage(35);
                    game.enemies.forEach(other => {
                        if (other !== this && !other.invulnerable && Math.hypot(other.x - this.x, other.y - this.y) < blastRadius) game.hitEnemy(other, 40);
                    });
                    game.camera.shake = 12;
                    for(let i=0; i<Math.ceil(20*game.particleScale); i++) game.spawnParticle(this.x, this.y, '#e74c3c', 6, 4, 'normal');
                    game.hitEnemy(this, this.hp); // se autodestruye reutilizando la lógica de muerte existente
                }
            }
        }
        if (this.type === 'INVISIBLE') {
            const onScreen = isVisible(this.x, this.y, this.radius, game.camera);
            if (onScreen && !this.wasOnScreen) this.onscreenVisibleTimer = 120; // ~2s a 60fps
            this.wasOnScreen = onScreen;
            if (this.onscreenVisibleTimer > 0) { this.invisAlpha = Math.min(1, this.invisAlpha + 0.08); this.onscreenVisibleTimer--; }
            else this.invisAlpha = Math.max(0, this.invisAlpha - 0.05);
            if (Math.random() > 0.9) game.spawnTrail(this.x, this.y, this.radius * 0.5); // rastro tenue
        }
        if (this.type === 'GHOST') {
            this.ghostTimer++;
            if (this.ghostState === 'GHOST' && this.ghostTimer > 180) { this.ghostState = 'SOLID'; this.ghostTimer = 0; this.invulnerable = false; }
            else if (this.ghostState === 'SOLID' && this.ghostTimer > 120) { this.ghostState = 'GHOST'; this.ghostTimer = 0; this.invulnerable = true; }
            const targetGhostAlpha = this.ghostState === 'GHOST' ? 0.18 : 1;
            this.ghostAlpha += (targetGhostAlpha - this.ghostAlpha) * 0.08; // transición suave
        }

        if (this.type === 'BOSS') {
            this.stateTimer++;
            this.summonTimer++;
            
            // Invocación (Boss Wave 30+)
            if (this.bossWave >= 30 && this.summonTimer > 60 * 12) { // Cada ~12 segundos
                this.summonTimer = 0;
                game.enemies.push(new Enemy(this.x + 100, this.y, 'TANK'));
                game.enemies.push(new Enemy(this.x - 100, this.y, 'TANK'));
                game.enemies.push(new Enemy(this.x, this.y + 100, 'RANGED'));
                game.enemies.push(new Enemy(this.x, this.y - 100, 'RANGED'));
            }

            if (this.state === 'IDLE') {
                this.x += Math.cos(angle) * this.speed;
                this.y += Math.sin(angle) * this.speed;
                
                let limit = this.bossWave >= 30 ? 50 : (this.bossWave >= 15 ? 70 : 100);
                if (this.stateTimer > limit) {
                    this.stateTimer = 0;
                    if (this.bossWave >= 15 && Math.random() < 0.5) {
                        this.state = 'SHOOT';
                        this.shootCount = 0;
                    } else {
                        this.state = 'TELEGRAPH';
                    }
                }
            } else if (this.state === 'TELEGRAPH') {
                // Temblor y cambio de color para avisar que va a dashear
                this.x += (Math.random() - 0.5) * 4;
                this.y += (Math.random() - 0.5) * 4;
                this.color = this.stateTimer % 8 < 4 ? '#fff' : '#c0392b';
                
                let teleTime = this.bossWave >= 30 ? 30 : 50;
                if (this.stateTimer > teleTime) {
                    this.state = 'DASH';
                    this.stateTimer = 0;
                    this.dashTargetAngle = angle;
                    this.dashSpeed = this.bossWave >= 30 ? 25 : 18; // Dash buffeado si es 30+
                    this.color = '#c0392b';
                }
            } else if (this.state === 'DASH') {
                this.x += Math.cos(this.dashTargetAngle) * this.dashSpeed;
                this.y += Math.sin(this.dashTargetAngle) * this.dashSpeed;
                
                if (Math.random() > 0.4) game.spawnTrail(this.x, this.y, this.radius);
                
                if (this.stateTimer > 25) {
                    this.state = 'IDLE';
                    this.stateTimer = 0;
                }
            } else if (this.state === 'SHOOT') {
                this.x += Math.cos(angle) * (this.speed * 0.3);
                this.y += Math.sin(angle) * (this.speed * 0.3);
                
                if (this.stateTimer % 20 === 0) {
                    if (this.bossWave >= 30) {
                        // Muchos más patrones de disparo
                        let offset = this.stateTimer * 0.1;
                        for(let i=0; i<12; i++) {
                            let a = (Math.PI*2/12) * i + offset;
                            game.spawnProjectile(this.x, this.y, a, {speed: 7, damage: 20 * (game.enemyDamageMult || 1), color: '#f39c12'}, true);
                        }
                    } else {
                        // Disparos wave 15
                        for(let i=0; i<6; i++) {
                            let a = (Math.PI*2/6) * i;
                            game.spawnProjectile(this.x, this.y, a, {speed: 5, damage: 15 * (game.enemyDamageMult || 1), color: '#f39c12'}, true);
                        }
                    }
                    this.shootCount++;
                }
                
                let maxShoots = this.bossWave >= 30 ? 6 : 3;
                if (this.shootCount >= maxShoots) {
                    this.state = 'IDLE';
                    this.stateTimer = 0;
                }
            }
        } 
        else if(this.type === 'RANGED' && d < 450) {
            if(d < 350) { this.x -= Math.cos(angle) * this.speed; this.y -= Math.sin(angle) * this.speed; }
            if(Date.now() - this.lastShot > 1500) {
                game.spawnProjectile(this.x, this.y, angle, {speed: 8, damage: 15 * (game.enemyDamageMult || 1), color: '#ff4d4d'}, true);
                this.lastShot = Date.now();
            }
        } else if(this.type === 'KAMIKAZE' && this.kamikazeState === 'ARMED') {
            // Se detiene mientras arma la explosión
        } else {
            this.x += Math.cos(angle) * this.speed; this.y += Math.sin(angle) * this.speed;
        }

        if(d < this.radius + player.radius) player.takeDamage(0.5 * (game.enemyDamageMult || 1));
        if(this.flash > 0) this.flash--;
        // Quemadura (Lanzallamas): tic de daño periódico independiente del flash de golpe
        if (this.burnTicks > 0) {
            this.burnTicks--;
            if (this.burnTicks % 20 === 0 && !this.isDying) {
                game.hitEnemy(this, this.burnDmg || 3);
                if (isVisible(this.x, this.y, this.radius, game.camera)) game.spawnParticle(this.x, this.y - this.radius*0.5, '#ff8800', 2, 3, 'normal');
            }
        }
    }
    draw(cam) {
        if (!isVisible(this.x, this.y, this.radius * 2, cam)) return;

        let typeAlpha = 1;
        if (this.type === 'INVISIBLE') typeAlpha = this.invisAlpha;
        if (this.type === 'GHOST') typeAlpha = this.ghostAlpha;

        const bounce = Math.abs(Math.sin(this.tick)) * (this.speed * 1.5);
        let stretch = 1 + Math.abs(Math.cos(this.tick)) * 0.15;
        if (this.type === 'FAST') stretch *= 1.2;

        if (game.shadowsEnabled) {
            ctx.globalAlpha = typeAlpha;
            ctx.fillStyle = "rgba(0,0,0,0.35)";
            ctx.beginPath(); ctx.ellipse(this.x - cam.x, this.y - cam.y + this.radius*0.8, this.radius * 1.2, this.radius * 0.4, 0, 0, Math.PI*2); ctx.fill();
            ctx.globalAlpha = 1;
        }

        ctx.save();
        ctx.globalAlpha = typeAlpha;
        ctx.translate(this.x - cam.x, this.y - cam.y - bounce);
        
        if (this.type === 'FAST') {
            ctx.scale(1 / stretch, stretch); 
        } else if (this.type === 'TANK') {
            ctx.scale(stretch, 1 / stretch); 
        } else {
            ctx.scale(1 / stretch, stretch);
        }
        
        ctx.fillStyle = this.flash > 0 ? '#fff' : this.color;
        ctx.strokeStyle = '#000'; ctx.lineWidth = 3;

        if (this.type === 'TANK') {
            ctx.beginPath();
            for(let i=0; i<6; i++) {
                ctx.lineTo(Math.cos(i * Math.PI/3) * this.radius, Math.sin(i * Math.PI/3) * this.radius);
            }
            ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(-10, -10); ctx.lineTo(0, 5); ctx.lineTo(15, -5); ctx.stroke();
        } else if (this.type === 'BOSS') {
            ctx.fillStyle = '#922b21';
            ctx.beginPath();
            for(let i=0; i<12; i++) {
                let r = this.radius * (i%2 === 0 ? 1.2 : 0.9);
                ctx.lineTo(Math.cos(i * Math.PI/6) * r, Math.sin(i * Math.PI/6) * r);
            }
            ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.fillStyle = this.flash > 0 ? '#fff' : this.color;
            ctx.beginPath(); ctx.arc(0, 0, this.radius * 0.8, 0, Math.PI*2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#000';
            ctx.beginPath(); ctx.moveTo(-this.radius*0.5, -this.radius*0.7); ctx.lineTo(-this.radius*0.9, -this.radius*1.3); ctx.lineTo(-this.radius*0.2, -this.radius*0.8); ctx.fill();
            ctx.beginPath(); ctx.moveTo(this.radius*0.5, -this.radius*0.7); ctx.lineTo(this.radius*0.9, -this.radius*1.3); ctx.lineTo(this.radius*0.2, -this.radius*0.8); ctx.fill();
        } else if (this.type === 'RANGED') {
            ctx.beginPath(); ctx.arc(0, 0, this.radius, 0, Math.PI*2); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(-10, -this.radius); ctx.lineTo(-20, -this.radius - 15); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(10, -this.radius); ctx.lineTo(20, -this.radius - 15); ctx.stroke();
            ctx.fillStyle = '#f1c40f'; ctx.beginPath(); ctx.arc(-20, -this.radius - 15, 4, 0, Math.PI*2); ctx.fill(); ctx.arc(20, -this.radius - 15, 4, 0, Math.PI*2); ctx.fill();
        } else {
            ctx.beginPath(); ctx.arc(0, 0, this.radius * (this.type === 'KAMIKAZE' ? this.explodeScale : 1), 0, Math.PI*2); ctx.fill(); ctx.stroke();
            if (this.type === 'GHOST' && this.ghostState === 'GHOST') {
                ctx.globalAlpha = 0.7;
                ctx.strokeStyle = '#ecf0f1'; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.arc(0, 0, this.radius + 3, 0, Math.PI*2); ctx.stroke();
                ctx.globalAlpha = typeAlpha;
            }
        }
        
        if (this.type === 'RANGED') {
            ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, -5, 10, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(0, -5, 4, 0, Math.PI*2); ctx.fill();
        } else {
            ctx.fillStyle = this.flash > 0 ? '#e74c3c' : (this.type === 'BOSS' ? '#f1c40f' : '#fff');
            ctx.beginPath();
            if (this.type === 'FAST') {
                ctx.moveTo(-this.radius*0.5, -8); ctx.lineTo(-this.radius*0.1, -2); ctx.lineTo(-this.radius*0.5, 2); 
                ctx.moveTo(this.radius*0.5, -8); ctx.lineTo(this.radius*0.1, -2); ctx.lineTo(this.radius*0.5, 2);
            } else {
                ctx.moveTo(-this.radius*0.4, -5); ctx.lineTo(-this.radius*0.1, 0); ctx.lineTo(-this.radius*0.4, 5); 
                ctx.moveTo(this.radius*0.4, -5); ctx.lineTo(this.radius*0.1, 0); ctx.lineTo(this.radius*0.4, 5); 
            }
            ctx.fill();
            if (this.type === 'BOSS') {
                ctx.strokeStyle = '#000'; ctx.lineWidth = 4;
                ctx.beginPath(); ctx.moveTo(-20, 20); ctx.quadraticCurveTo(0, 40, 20, 20); ctx.stroke();
            }
        }
        if (game.activeEvent === 'MUTATION') {
            ctx.globalAlpha = 0.35;
            ctx.strokeStyle = '#39ff14'; ctx.lineWidth = 4;
            ctx.beginPath(); ctx.arc(0, 0, this.radius * 1.15, 0, Math.PI*2); ctx.stroke();
            ctx.globalAlpha = typeAlpha;
        }
        ctx.restore();

        if(this.hp < this.maxHp) {
            ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(this.x - cam.x - 15, this.y - cam.y - this.radius - 15, 30, 5);
            ctx.fillStyle = '#e74c3c'; ctx.fillRect(this.x - cam.x - 15, this.y - cam.y - this.radius - 15, 30 * (this.hp/this.maxHp), 5);
        }
    }
}

game.spawnProjectile = function(x, y, angle, weapon, isEnemy = false) {
    let p = this.projectiles.find(p => !p.active);
    if(p) p.init(x, y, angle, weapon, isEnemy);
};