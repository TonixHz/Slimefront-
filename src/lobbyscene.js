/**
 * LOBBYSCENE.js — Escena viva de fondo para el lobby.
 */
const LobbyScene = {
    _built: false,
    _t: 0,
    clouds: [],
    farTrees: [],
    midProps: [],
    minis: [],
    leaves: [],
    fireflies: [],

    build() {
        if (this._built) return;
        this._built = true;
        const w = canvas.width, h = canvas.height;

        this.clouds = Array.from({ length: 6 }, () => ({
            x: Math.random() * w,
            y: 40 + Math.random() * (h * 0.28),
            scale: 0.7 + Math.random() * 1.1,
            speed: 0.06 + Math.random() * 0.08,
            alpha: 0.10 + Math.random() * 0.10
        }));

        this.farTrees = Array.from({ length: 16 }, (_, i) => ({
            x: (i / 16) * (w + 200) - 100 + (Math.random() - 0.5) * 40,
            h: 90 + Math.random() * 70,
            wobble: Math.random() * Math.PI * 2
        }));

        const propTypes = ['tree', 'tree_pine', 'rock', 'rock_tall', 'bush'];
        this.midProps = Array.from({ length: 10 }, () => ({
            x: Math.random() * (w + 400) - 200,
            baseY: h * 0.62 + Math.random() * (h * 0.3),
            type: propTypes[Math.floor(Math.random() * propTypes.length)],
            scale: 0.8 + Math.random() * 0.6
        })).sort((a, b) => a.baseY - b.baseY);

        this.minis = Array.from({ length: 3 }, () => ({
            x: w * 0.15 + Math.random() * w * 0.6,
            y: h * 0.72 + Math.random() * (h * 0.18),
            dir: Math.random() * Math.PI * 2,
            timer: 0,
            color: ['#27ae60', '#8e44ad', '#e67e22'][Math.floor(Math.random() * 3)],
            tick: Math.random() * 10
        }));

        this.leaves = Array.from({ length: 18 }, () => this._newLeaf(w, h, true));
        this.fireflies = Array.from({ length: 14 }, () => ({
            x: Math.random() * w, y: h * 0.4 + Math.random() * h * 0.55,
            r: 1.5 + Math.random() * 1.8,
            phase: Math.random() * Math.PI * 2,
            speed: 0.3 + Math.random() * 0.4,
            driftX: (Math.random() - 0.5) * 0.4,
            driftY: (Math.random() - 0.5) * 0.3
        }));
    },

    _newLeaf(w, h, randomY) {
        return {
            x: Math.random() * w,
            y: randomY ? Math.random() * h : -20,
            vx: -0.4 - Math.random() * 0.6,
            vy: 0.6 + Math.random() * 0.8,
            size: 4 + Math.random() * 5,
            rot: Math.random() * Math.PI * 2,
            vrot: (Math.random() - 0.5) * 0.05,
            sway: Math.random() * Math.PI * 2,
            color: ['#2ecc71', '#27ae60', '#e67e22', '#d4a017'][Math.floor(Math.random() * 4)]
        };
    },

    reset() {
        this._built = false;
    },

    render() {
        const w = canvas.width, h = canvas.height;
        this.build();
        this._t += 1;

        const sky = ctx.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#0d1f14');
        sky.addColorStop(0.55, '#0a1710');
        sky.addColorStop(1, '#060d08');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, w, h);

        this.clouds.forEach(c => {
            c.x -= c.speed;
            if (c.x < -160 * c.scale) c.x = w + 160 * c.scale;
            ctx.fillStyle = `rgba(200,220,210,${c.alpha})`;
            ctx.beginPath();
            for (let i = 0; i < 4; i++) {
                ctx.arc(c.x + i * 26 * c.scale, c.y + Math.sin(i) * 6 * c.scale, 24 * c.scale, 0, Math.PI * 2);
            }
            ctx.fill();
        });

        const farOffset = (this._t * 0.10) % (w + 200);
        ctx.fillStyle = '#0d2416';
        this.farTrees.forEach(t => {
            let x = t.x - farOffset;
            if (x < -60) x += w + 200;
            const sway = Math.sin(this._t * 0.01 + t.wobble) * 3;
            ctx.beginPath();
            ctx.moveTo(x + sway, h * 0.62 - t.h);
            ctx.lineTo(x - 35, h * 0.62);
            ctx.lineTo(x + 35, h * 0.62);
            ctx.closePath();
            ctx.fill();
        });

        const groundGrad = ctx.createLinearGradient(0, h * 0.6, 0, h);
        groundGrad.addColorStop(0, '#16301c');
        groundGrad.addColorStop(1, '#0a160c');
        ctx.fillStyle = groundGrad;
        ctx.fillRect(0, h * 0.62, w, h * 0.38);

        const midOffset = (this._t * 0.28) % (w + 400);
        this.midProps.forEach(p => {
            let x = p.x - midOffset;
            if (x < -220) x += w + 400;
            this._drawMidProp(x, p.baseY, p.type, p.scale);
        });

        this.minis.forEach(m => {
            m.timer++;
            m.tick += 0.15;
            if (m.timer > 90) { m.timer = 0; m.dir += (Math.random() - 0.5) * 2; }
            const speed = 0.35;
            m.x += Math.cos(m.dir) * speed;
            m.y += Math.sin(m.dir) * speed * 0.4;
            if (m.x < w * 0.08) m.dir = 0; if (m.x > w * 0.85) m.dir = Math.PI;
            if (m.y < h * 0.68) m.dir = Math.PI / 2; if (m.y > h * 0.92) m.dir = -Math.PI / 2;
            const bounce = Math.abs(Math.sin(m.tick)) * 4;
            ctx.save();
            ctx.globalAlpha = 0.9;
            ctx.translate(m.x, m.y - bounce);
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.beginPath(); ctx.ellipse(0, bounce + 6, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = m.color; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.beginPath(); ctx.arc(-3, -2, 2, 0, Math.PI * 2); ctx.arc(3, -2, 2, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
        });

        this._drawHero(w * 0.5, h * 0.8);

        this.leaves.forEach(l => {
            l.x += l.vx; l.y += l.vy + Math.sin(this._t * 0.03 + l.sway) * 0.3;
            l.rot += l.vrot;
            if (l.y > h + 20 || l.x < -20) { Object.assign(l, this._newLeaf(w, h, false)); l.x = w + 20; }
            ctx.save();
            ctx.globalAlpha = 0.85;
            ctx.translate(l.x, l.y);
            ctx.rotate(l.rot);
            ctx.fillStyle = l.color;
            ctx.beginPath();
            ctx.ellipse(0, 0, l.size, l.size * 0.55, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });

        this.fireflies.forEach(f => {
            f.x += f.driftX; f.y += f.driftY;
            if (f.x < 0) f.x = w; if (f.x > w) f.x = 0;
            if (f.y < h * 0.35) f.y = h * 0.35; if (f.y > h * 0.98) f.y = h * 0.98;
            const glow = 0.4 + Math.abs(Math.sin(this._t * 0.04 * f.speed + f.phase)) * 0.6;
            ctx.save();
            ctx.globalAlpha = glow;
            ctx.fillStyle = '#f5e97a';
            ctx.shadowColor = '#f5e97a';
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });

        const vig = ctx.createRadialGradient(w * 0.5, h * 0.55, h * 0.25, w * 0.5, h * 0.55, h * 0.85);
        vig.addColorStop(0, 'rgba(0,0,0,0)');
        vig.addColorStop(1, 'rgba(0,0,0,0.55)');
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, w, h);
    },

    _drawMidProp(x, y, type, scale) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(scale, scale);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath(); ctx.ellipse(6, 8, 26, 10, 0, 0, Math.PI * 2); ctx.fill();

        if (type === 'tree' || type === 'tree_pine') {
            ctx.fillStyle = '#4a3324'; ctx.fillRect(-5, -10, 10, 22);
            if (type === 'tree_pine') {
                ctx.fillStyle = '#134a29';
                ctx.beginPath(); ctx.moveTo(0, -60); ctx.lineTo(-28, -6); ctx.lineTo(28, -6); ctx.closePath(); ctx.fill();
                ctx.beginPath(); ctx.moveTo(0, -38); ctx.lineTo(-33, 10); ctx.lineTo(33, 10); ctx.closePath(); ctx.fill();
            } else {
                ctx.fillStyle = '#1e6b3f';
                for (let i = 0; i < 4; i++) {
                    ctx.beginPath(); ctx.arc(Math.cos(i * 1.5) * 16, -18 + Math.sin(i * 1.5) * 10, 20, 0, Math.PI * 2); ctx.fill();
                }
            }
        } else if (type === 'rock' || type === 'rock_tall') {
            ctx.fillStyle = '#4a5254'; ctx.strokeStyle = '#1c2224'; ctx.lineWidth = 2;
            ctx.beginPath();
            if (type === 'rock_tall') { ctx.moveTo(-14, 10); ctx.lineTo(-9, -36); ctx.lineTo(9, -32); ctx.lineTo(14, 10); }
            else { ctx.moveTo(-20, -8); ctx.lineTo(8, -22); ctx.lineTo(26, 4); ctx.lineTo(8, 18); ctx.lineTo(-24, 8); }
            ctx.closePath(); ctx.fill(); ctx.stroke();
        } else if (type === 'bush') {
            ctx.fillStyle = '#14472b'; ctx.strokeStyle = '#0d3320'; ctx.lineWidth = 2;
            for (let i = 0; i < 3; i++) {
                ctx.beginPath(); ctx.arc(Math.cos(i * 2.1) * 9, Math.sin(i * 2.1) * 9, 14, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
            }
        }
        ctx.restore();
    },

    _drawHero(cx, cy) {
        this._heroTick = (this._heroTick || 0) + 0.05;
        const bounce = Math.abs(Math.sin(this._heroTick)) * 10;
        const stretchX = 1 - Math.abs(Math.cos(this._heroTick)) * 0.08;
        const stretchY = 1 + Math.abs(Math.cos(this._heroTick)) * 0.08;
        const angle = Math.sin(this._heroTick * 0.4) * 0.5;

        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath(); ctx.ellipse(cx, cy + 30, 34, 12, 0, 0, Math.PI * 2); ctx.fill();

        ctx.translate(cx, cy - bounce);
        ctx.scale(stretchX, stretchY);

        const grad = ctx.createRadialGradient(-6, -12, 0, 0, 0, 30);
        grad.addColorStop(0, '#a8e6cf'); grad.addColorStop(0.7, '#3b7a57'); grad.addColorStop(1, '#2c3e50');
        ctx.fillStyle = grad; ctx.strokeStyle = '#1e382b'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

        ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(0, 0, 22, Math.PI + 0.5, Math.PI * 1.5 - 0.5); ctx.stroke();

        const eox = Math.cos(angle) * 7, eoy = Math.sin(angle) * 3 - 5;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(-9 + eox, -5 + eoy, 8, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(9 + eox, -5 + eoy, 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(-9 + eox + Math.cos(angle) * 3, -5 + eoy + 1, 4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(9 + eox + Math.cos(angle) * 3, -5 + eoy + 1, 4, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }
};
