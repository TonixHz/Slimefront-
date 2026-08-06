const test = require('node:test');
const assert = require('node:assert/strict');
const TimerManager = require('../../src/timers.js');

test('setTimeout: el callback se ejecuta', async () => {
    let ran = false;
    TimerManager.setTimeout(() => { ran = true; }, 5);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(ran, true);
});

test('clearAll: cancela un setTimeout pendiente antes de que se dispare', async () => {
    let ran = false;
    TimerManager.setTimeout(() => { ran = true; }, 20);
    TimerManager.clearAll();
    await new Promise(r => setTimeout(r, 40));
    assert.equal(ran, false);
});

test('clearAll: cancela un setInterval pendiente', async () => {
    let ticks = 0;
    TimerManager.setInterval(() => { ticks++; }, 5);
    await new Promise(r => setTimeout(r, 12)); // deja correr un par de ticks
    TimerManager.clearAll();
    const ticksAtClear = ticks;
    await new Promise(r => setTimeout(r, 30));
    assert.equal(ticks, ticksAtClear, 'no deberían registrarse más ticks después de clearAll');
});

test('pendingCount: refleja timers/intervals registrados y baja a 0 tras clearAll', async () => {
    TimerManager.setTimeout(() => {}, 1000);
    TimerManager.setInterval(() => {}, 1000);
    assert.equal(TimerManager.pendingCount(), 2);
    TimerManager.clearAll();
    assert.equal(TimerManager.pendingCount(), 0);
});

test('un timer que ya disparó se autolimpia del registro (no crece indefinidamente)', async () => {
    TimerManager.clearAll();
    TimerManager.setTimeout(() => {}, 5);
    await new Promise(r => setTimeout(r, 25));
    assert.equal(TimerManager.pendingCount(), 0);
});
