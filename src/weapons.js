/**
 * CONFIGURACIÓN DE ARMAS
 * (Extraído de player.js por organización. Mismo objeto WEAPONS_DB de siempre,
 * ningún valor fue modificado.)
 */
const WEAPONS_DB = {
    // --- MELÉ ---
    KNIFE:    { name: 'KNIFE', damage: 60, fireRate: 250, capacity: Infinity, reloadTime: 0, speed: 5, range: 65, type: 'melee', color: '#bdc3c7', shake: 2, spread: 0 },
    MACHETE:  { name: 'MACHETE', damage: 100, fireRate: 320, capacity: Infinity, reloadTime: 0, speed: 5, range: 95, type: 'melee', color: '#ecf0f1', shake: 4, spread: 0 },
    CHAINSAW: { name: 'CHAINSAW', damage: 9, fireRate: 90, capacity: Infinity, reloadTime: 0, speed: 5, range: 65, type: 'melee', color: '#7f8c8d', shake: 3, spread: 0, fuel: 100, fuelDrain: 2.2, sfx: 'chainsaw' },
    // --- PISTOLAS ---
    G18:      { name: 'G18', damage: 25, fireRate: 200, capacity: 15, reloadTime: 1000, speed: 18, type: 'range', color: '#f1c40f', shake: 3, spread: 0.05, casing: true, smoke: 1, sfx: 'shoot_G18' },
    REVOLVER: { name: 'REVOLVER', damage: 45, fireRate: 500, capacity: 6, reloadTime: 1400, speed: 22, type: 'range', color: '#95a5a6', shake: 5, spread: 0.03, casing: true, smoke: 1, sfx: 'shoot_G18', pierce: 3 },
    // --- SUBFUSILES ---
    UZI:      { name: 'UZI', damage: 15, fireRate: 70, capacity: 40, reloadTime: 1500, speed: 20, type: 'range', color: '#e67e22', shake: 4, spread: 0.15, casing: true, smoke: 2, sfx: 'shoot_G18' },
    MP5:      { name: 'MP5', damage: 22, fireRate: 110, capacity: 30, reloadTime: 1400, speed: 22, type: 'range', color: '#7f8c8d', shake: 2, spread: 0.025, casing: true, smoke: 1, sfx: 'shoot_G18' },
    P90:      { name: 'P90', damage: 18, fireRate: 90, capacity: 50, reloadTime: 1700, speed: 21, type: 'range', color: '#9b59b6', shake: 3, spread: 0.06, casing: true, smoke: 1, sfx: 'shoot_G18', mobility: true },
    // --- ESCOPETAS ---
    SHOTGUN:  { name: 'SHOTGUN', damage: 20, fireRate: 900, capacity: 7, reloadTime: 2200, speed: 15, type: 'range', pellets: 8, color: '#e74c3c', shake: 15, spread: 0.22, casing: true, smoke: 5, sfx: 'shoot_SHOTGUN', knockback: 220 },
    SAWEDOFF: { name: 'SAWEDOFF', damage: 35, fireRate: 1100, capacity: 2, reloadTime: 1800, speed: 14, type: 'range', pellets: 10, color: '#c0392b', shake: 18, spread: 0.35, casing: true, smoke: 6, sfx: 'shoot_SHOTGUN', maxRange: 260, knockback: 260 },
    AA12:     { name: 'AA12', damage: 18, fireRate: 220, capacity: 20, reloadTime: 2200, speed: 15, type: 'range', pellets: 6, color: '#e67e22', shake: 10, spread: 0.2, casing: true, smoke: 3, sfx: 'shoot_SHOTGUN', knockback: 100 },
    // --- RIFLES ---
    AK47:     { name: 'AK47', damage: 40, fireRate: 140, capacity: 30, reloadTime: 1800, speed: 24, type: 'range', color: '#27ae60', shake: 6, spread: 0.08, casing: true, smoke: 3, sfx: 'shoot_G18' },
    M4A1:     { name: 'M4A1', damage: 32, fireRate: 160, capacity: 30, reloadTime: 1600, speed: 23, type: 'range', color: '#2ecc71', shake: 3, spread: 0.015, casing: true, smoke: 2, sfx: 'shoot_G18' },
    FAMAS:    { name: 'FAMAS', damage: 28, fireRate: 550, capacity: 24, reloadTime: 1700, speed: 23, type: 'range', color: '#3498db', shake: 5, spread: 0.04, casing: true, smoke: 2, sfx: 'shoot_G18', burst: 3, burstDelay: 65 },
    SCAR:     { name: 'SCAR', damage: 55, fireRate: 450, capacity: 20, reloadTime: 1900, speed: 25, type: 'range', color: '#16a085', shake: 8, spread: 0.03, casing: true, smoke: 2, sfx: 'shoot_G18' },
    // --- PRECISIÓN ---
    WINCHESTER: { name: 'WINCHESTER', damage: 130, fireRate: 900, capacity: 8, reloadTime: 450, speed: 30, type: 'range', color: '#8e5a2d', shake: 10, spread: 0.01, casing: true, smoke: 2, sfx: 'shoot_G18', singleReload: true },
    AWP:      { name: 'AWP', damage: 260, fireRate: 1700, capacity: 5, reloadTime: 2600, speed: 38, type: 'range', color: '#34495e', shake: 22, spread: 0, casing: true, smoke: 2, sfx: 'shoot_G18', pierce: 4 },
    SNIPER:   { name: 'SNIPER', damage: 220, fireRate: 1500, capacity: 5, reloadTime: 2500, speed: 35, type: 'range', color: '#34495e', shake: 20, spread: 0, casing: true, smoke: 2, sfx: 'shoot_G18' },
    // --- PESADAS ---
    M249:     { name: 'M249', damage: 24, fireRate: 90, capacity: 150, reloadTime: 4000, speed: 22, type: 'range', color: '#556b2f', shake: 5, spread: 0.12, casing: true, smoke: 3, sfx: 'shoot_G18' },
    MINIGUN:  { name: 'MINIGUN', damage: 20, fireRate: 50, capacity: 100, reloadTime: 3000, speed: 22, type: 'range', color: '#c0392b', shake: 8, spread: 0.2, casing: true, smoke: 3, sfx: 'shoot_G18', spinup: true },
    // --- ESPECIALES ---
    RPG:      { name: 'RPG', damage: 85, fireRate: 1400, capacity: 1, reloadTime: 2400, speed: 16, type: 'range', color: '#e67e22', shake: 25, spread: 0, casing: false, smoke: 4, sfx: 'shoot_SHOTGUN', explosive: true, explosionRadius: 140 },
    FLAMETHROWER: { name: 'FLAMETHROWER', damage: 4, fireRate: 45, capacity: 120, reloadTime: 2200, speed: 12, type: 'range', color: '#ff8800', shake: 2, spread: 0.15, casing: false, smoke: 2, sfx: 'flamethrower', maxRange: 260, burn: true, pierce: 2 },
    CROSSBOW: { name: 'CROSSBOW', damage: 90, fireRate: 700, capacity: 1, reloadTime: 1200, speed: 26, type: 'range', color: '#16a085', shake: 4, spread: 0, casing: false, smoke: 0, sfx: 'shoot_G18' }
};

// Posiciones del destello de boca por arma (antes se creaba este objeto literal
// en cada frame dentro de Player.draw; movido acá como constante fija para no
// generar basura/garbage collection en cada disparo).
const WEAPON_MUZZLE_X = { AK47: 45, SHOTGUN: 40, SNIPER: 48, MINIGUN: 30, REVOLVER: 20, CROSSBOW: 15,
    MP5: 26, P90: 29, SAWEDOFF: 20, AA12: 25, M4A1: 42, FAMAS: 32, SCAR: 24, WINCHESTER: 45,
    AWP: 50, M249: 30, RPG: 66, FLAMETHROWER: 35, CHAINSAW: 28 };
