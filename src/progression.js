/**
 * SISTEMA DE PROGRESIÓN PERMANENTE (MEJORAS ENTRE PARTIDAS)
 */
const UPGRADES_DB = {
    VITALITY:  { name: 'Vitalidad',    desc: '+10 HP máxima por nivel',        icon: '❤️', maxLevel: 5, baseCost: 250, costGrowth: 1.6 },
    ENDURANCE: { name: 'Resistencia',  desc: '+10 stamina máxima por nivel',   icon: '🏃', maxLevel: 5, baseCost: 250, costGrowth: 1.6 },
    SWIFTNESS: { name: 'Velocidad',    desc: '+2% velocidad de movimiento por nivel', icon: '💨', maxLevel: 5, baseCost: 300, costGrowth: 1.6 },
    POWER:     { name: 'Poder',       desc: '+3% daño de armas por nivel',    icon: '⚔️', maxLevel: 5, baseCost: 350, costGrowth: 1.65 },
    FORTUNE:   { name: 'Fortuna',     desc: '+4% dinero ganado por nivel',     icon: '💰', maxLevel: 5, baseCost: 320, costGrowth: 1.65 }
};

const Progression = Object.assign({ levels: {} }, SaveSystem.get('progression', {}));

Progression.getLevel = function(k) { return this.levels[k] || 0; };

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
    playSFX('coin');
    return true;
};

Progression.save = function() { SaveSystem.set('progression', { levels: this.levels }); };

Progression.reset = function() {
    this.levels = {};
    this.save();
    if (game.player) this.applyToPlayer(game.player);
    if (typeof game.renderUpgrades === 'function') game.renderUpgrades();
};

Progression.applyToPlayer = function(p) {
    if (!p) return;
    const vit = this.getLevel('VITALITY');
    const end = this.getLevel('ENDURANCE');
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
    const lvl = Progression.getLevel('POWER');
    if (w && lvl > 0 && this._powerOriginalDamage === undefined) {
        this._powerOriginalDamage = w.damage;
        w.damage = Math.round(this._powerOriginalDamage * (1 + 0.03 * lvl));
    }
    _progOrigShoot.call(this);
    if (this._powerOriginalDamage !== undefined && !(this.player && this.player.burstBusy)) {
        w.damage = this._powerOriginalDamage;
        this._powerOriginalDamage = undefined;
    }
};

const _progOrigPlayerUpdate = Player.prototype.update;
Player.prototype.update = function(keys) {
    const px = this.x, py = this.y;
    _progOrigPlayerUpdate.call(this, keys);
    const lvl = Progression.getLevel('SWIFTNESS');
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
    const lvl = Progression.getLevel('FORTUNE');
    if (lvl > 0 && this.player) {
        const gained = this.player.money - moneyBefore;
        if (gained > 0) this.player.money += Math.floor(gained * (0.04 * lvl));
    }
};

game.renderUpgrades = function() {
    const el = document.getElementById('upgrades-list');
    if (!el) return;
    el.innerHTML = Object.keys(UPGRADES_DB).map(k => {
        const def = UPGRADES_DB[k];
        const lvl = Progression.getLevel(k);
        const maxed = lvl >= def.maxLevel;
        const cost = Progression.getCost(k);
        const action = maxed
            ? '<span class="achv-claimed">MÁXIMO</span>'
            : `<button class="buy-btn" onclick="game.buyUpgrade('${k}')">$${cost}</button>`;
        return `<div class="weapon-row">
            <span class="weapon-row-name">${def.icon} ${def.name} (${lvl}/${def.maxLevel})</span>
            <span class="weapon-row-status">${def.desc}</span>
            ${action}
        </div>`;
    }).join('');
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
    if (!keys.includes('progression')) return;
    const remote = SaveSystem.get('progression', { levels: {} });
    Progression.levels = remote.levels || {};
    if (game.player) Progression.applyToPlayer(game.player);
    game.renderUpgrades();
});
