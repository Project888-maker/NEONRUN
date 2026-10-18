import * as THREE from 'three';
import { GRID, HALF, PITCH, lineCoord, DISTRICTS, districtAt, RAIL_Z, ROAD_W, ALLEY_W, blockCenter, districtOfBlock, type DistrictId } from '../world/layout';

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  root = $('hud');
  private speedo = $('speedo') as HTMLCanvasElement;
  private sctx = this.speedo.getContext('2d')!;
  private mini = $('minimap') as HTMLCanvasElement;
  private mctx = this.mini.getContext('2d')!;
  private big = $('bigmap-canvas') as HTMLCanvasElement;
  private mapImg: HTMLCanvasElement;
  private toastT = 0;
  private comboT = 0;
  private lastDistrict = '';
  unlocked: DistrictId[] = ['neon'];

  constructor() {
    this.mapImg = this.renderMap();
  }

  show(v: boolean) { this.root.classList.toggle('hidden', !v); }

  /** Pre-render the whole city map (roads, blocks, districts) to an offscreen canvas. */
  renderMap() {
    const S = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const k = S / (HALF * 2 + 80);
    const tx = (x: number) => (x + HALF + 40) * k;
    g.fillStyle = '#04060d';
    g.fillRect(0, 0, S, S);
    // water
    g.fillStyle = '#071526';
    g.fillRect(tx(HALF + 20), 0, S, S);
    // blocks tinted by district
    for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
      const d = districtOfBlock(i, j);
      const col = DISTRICTS[d].color;
      const x = blockCenter(i), z = blockCenter(j);
      const s = (PITCH - ROAD_W) * k;
      g.fillStyle = col + '22';
      g.fillRect(tx(x) - s / 2, tx(z) - s / 2, s, s);
      g.strokeStyle = col + '40';
      g.strokeRect(tx(x) - s / 2, tx(z) - s / 2, s, s);
      if (d === 'backstreets') {
        g.fillStyle = '#1a1e2b';
        g.fillRect(tx(x) - s / 2, tx(z) - (ALLEY_W * k) / 2, s, ALLEY_W * k);
      }
    }
    // roads
    g.fillStyle = '#1d2233';
    for (let i = 0; i <= GRID; i++) {
      const p = tx(lineCoord(i));
      g.fillRect(p - (ROAD_W * k) / 2, tx(-HALF), ROAD_W * k, (HALF * 2) * k);
      g.fillRect(tx(-HALF), p - (ROAD_W * k) / 2, (HALF * 2) * k, ROAD_W * k);
    }
    // rail
    g.strokeStyle = '#21f3ff66';
    g.lineWidth = 2;
    g.setLineDash([6, 4]);
    g.beginPath(); g.moveTo(0, tx(RAIL_Z)); g.lineTo(S, tx(RAIL_Z)); g.stroke();
    g.setLineDash([]);
    return c;
  }

  private mapK = 1024 / (HALF * 2 + 80);
  private m2p(x: number) { return (x + HALF + 40) * this.mapK; }

  drawMinimap(pos: THREE.Vector3, yaw: number, target: THREE.Vector3 | null, route: THREE.Vector3[], drones: THREE.Vector3[], pickupKind: 'pickup' | 'drop' | null, people: THREE.Vector3[] = [], shops: THREE.Vector3[] = []) {
    const g = this.mctx, W = this.mini.width;
    const zoom = 2.2; // map px per minimap px scale
    g.save();
    g.clearRect(0, 0, W, W);
    g.beginPath();
    g.arc(W / 2, W / 2, W / 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#04060d';
    g.fillRect(0, 0, W, W);
    g.translate(W / 2, W / 2);
    g.rotate(yaw + Math.PI);
    g.scale(zoom, zoom);
    g.translate(-this.m2p(pos.x), -this.m2p(pos.z));
    g.drawImage(this.mapImg, 0, 0);
    // locked districts overlay
    for (const d of Object.keys(DISTRICTS) as DistrictId[]) {
      if (this.unlocked.includes(d)) continue;
      const x0 = d === 'downtown' || d === 'docks' ? 0 : -HALF, z0 = d === 'backstreets' || d === 'docks' ? 0 : -HALF;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(this.m2p(x0), this.m2p(z0), HALF * this.mapK, HALF * this.mapK);
    }
    if (route.length > 1) {
      g.strokeStyle = pickupKind === 'drop' ? '#ff2fb4' : '#21f3ff';
      g.lineWidth = 3 / zoom * 1.6;
      g.shadowColor = g.strokeStyle;
      g.shadowBlur = 6;
      g.beginPath();
      g.moveTo(this.m2p(pos.x), this.m2p(pos.z));
      for (const p of route) g.lineTo(this.m2p(p.x), this.m2p(p.z));
      g.stroke();
      g.shadowBlur = 0;
    }
    // shops you can walk into: small warm squares
    g.fillStyle = 'rgba(255, 214, 160, 0.85)';
    for (const q of shops) g.fillRect(this.m2p(q.x) - 2.5, this.m2p(q.z) - 2.5, 5, 5);
    // regulars with work: amber diamonds
    g.fillStyle = '#ffb347';
    for (const q of people) {
      const x = this.m2p(q.x), z = this.m2p(q.z);
      g.beginPath(); g.moveTo(x, z - 4.5); g.lineTo(x + 4.5, z); g.lineTo(x, z + 4.5); g.lineTo(x - 4.5, z); g.closePath(); g.fill();
    }
    for (const d of drones) {
      g.fillStyle = '#ff3030';
      g.beginPath(); g.arc(this.m2p(d.x), this.m2p(d.z), 3, 0, Math.PI * 2); g.fill();
    }
    g.restore();
    // target marker (clamped to the edge)
    if (target) {
      const dx = (target.x - pos.x) * this.mapK * zoom, dz = (target.z - pos.z) * this.mapK * zoom;
      const a = yaw + Math.PI; // same rotation as the map transform above
      let rx = dx * Math.cos(a) - dz * Math.sin(a);
      let rz = dx * Math.sin(a) + dz * Math.cos(a);
      const r = Math.hypot(rx, rz), lim = W / 2 - 10;
      if (r > lim) { rx *= lim / r; rz *= lim / r; }
      g.fillStyle = pickupKind === 'drop' ? '#ff2fb4' : '#21f3ff';
      g.shadowColor = g.fillStyle;
      g.shadowBlur = 10;
      g.beginPath(); g.arc(W / 2 + rx, W / 2 + rz, 6, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
    }
    // player arrow
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(W / 2, W / 2 - 9); g.lineTo(W / 2 + 6, W / 2 + 7); g.lineTo(W / 2, W / 2 + 3); g.lineTo(W / 2 - 6, W / 2 + 7);
    g.closePath(); g.fill();
    g.strokeStyle = 'rgba(33,243,255,0.5)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(W / 2, W / 2, W / 2 - 1, 0, Math.PI * 2); g.stroke();
  }

  drawBigMap(pos: THREE.Vector3, yaw: number, target: THREE.Vector3 | null, route: THREE.Vector3[]) {
    const g = this.big.getContext('2d')!;
    const W = this.big.width;
    g.clearRect(0, 0, W, W);
    g.drawImage(this.mapImg, 0, 0, W, W);
    const s = W / 1024;
    for (const d of Object.keys(DISTRICTS) as DistrictId[]) {
      const x0 = d === 'downtown' || d === 'docks' ? 0 : -HALF, z0 = d === 'backstreets' || d === 'docks' ? 0 : -HALF;
      if (!this.unlocked.includes(d)) { g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(this.m2p(x0) * s, this.m2p(z0) * s, HALF * this.mapK * s, HALF * this.mapK * s); }
      g.fillStyle = DISTRICTS[d].color;
      g.font = '600 18px Orbitron, sans-serif';
      g.textAlign = 'center';
      g.fillText(DISTRICTS[d].name.toUpperCase() + (this.unlocked.includes(d) ? '' : ' (LOCKED)'), (this.m2p(x0) + HALF * this.mapK / 2) * s, (this.m2p(z0) + 30) * s);
    }
    if (route.length) {
      g.strokeStyle = '#ff2fb4'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(this.m2p(pos.x) * s, this.m2p(pos.z) * s);
      for (const p of route) g.lineTo(this.m2p(p.x) * s, this.m2p(p.z) * s);
      g.stroke();
    }
    if (target) { g.fillStyle = '#ff2fb4'; g.beginPath(); g.arc(this.m2p(target.x) * s, this.m2p(target.z) * s, 8, 0, Math.PI * 2); g.fill(); }
    g.save();
    g.translate(this.m2p(pos.x) * s, this.m2p(pos.z) * s);
    g.rotate(-yaw + Math.PI);
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(0, -12); g.lineTo(8, 9); g.lineTo(0, 4); g.lineTo(-8, 9); g.closePath(); g.fill();
    g.restore();
  }

  drawSpeedo(kmh: number, rpm: number, gear: number, boost: number, boosting: boolean) {
    const g = this.sctx, W = this.speedo.width, c = W / 2;
    g.clearRect(0, 0, W, W);
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    const R = c - 18;
    // backing
    g.beginPath(); g.arc(c, c, R + 10, 0, Math.PI * 2); g.fillStyle = 'rgba(5,8,20,0.55)'; g.fill();
    // rpm arc
    const rf = Math.min(1, rpm / 8000);
    g.lineWidth = 10;
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.arc(c, c, R, a0, a1); g.stroke();
    const grad = g.createLinearGradient(0, W, W, 0);
    grad.addColorStop(0, '#21f3ff'); grad.addColorStop(0.7, '#9b5cff'); grad.addColorStop(1, '#ff2fb4');
    g.strokeStyle = rpm > 6800 ? '#ff2fb4' : grad;
    g.shadowColor = '#21f3ff'; g.shadowBlur = 12;
    g.beginPath(); g.arc(c, c, R, a0, a0 + (a1 - a0) * rf); g.stroke();
    g.shadowBlur = 0;
    // ticks
    for (let i = 0; i <= 8; i++) {
      const a = a0 + ((a1 - a0) * i) / 8;
      g.strokeStyle = i >= 7 ? '#ff2fb4' : 'rgba(255,255,255,0.6)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * (R - 14), c + Math.sin(a) * (R - 14));
      g.lineTo(c + Math.cos(a) * (R - 22), c + Math.sin(a) * (R - 22));
      g.stroke();
    }
    g.textAlign = 'center';
    g.fillStyle = boosting ? '#21f3ff' : '#fff';
    g.font = `800 ${W * 0.22}px Orbitron, sans-serif`;
    g.fillText(String(Math.round(kmh)), c, c + W * 0.06);
    g.font = `600 ${W * 0.06}px Rajdhani, sans-serif`;
    g.fillStyle = '#8c9bb8';
    g.fillText('KM/H', c, c + W * 0.15);
    g.font = `800 ${W * 0.09}px Orbitron, sans-serif`;
    g.fillStyle = '#ffb347';
    g.fillText(gear > 0 ? String(gear) : 'R', c, c + W * 0.32);
    ($('h-boost') as HTMLElement).style.width = `${boost * 100}%`;
  }

  setCredits(n: number) { $('h-credits').textContent = n.toLocaleString(); }
  setPrompt(t: string) { $('h-prompt').textContent = t; }
  setTimer(t: number | null) {
    const el = $('h-timer');
    if (t === null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.textContent = t.toFixed(1);
    el.classList.toggle('warn', t < 10);
  }
  /** Mission meter under the timer (damage, comfort, drift points, tail distance). frac 0..1; null hides it. */
  meter(label: string | null, frac = 0, color = 'var(--cyan)', value = '') {
    const el = $('h-meter');
    if (label === null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.querySelector('.m-label')!.textContent = label;
    el.querySelector('.m-val')!.textContent = value;
    const f = el.querySelector('.m-fill') as HTMLElement;
    f.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    f.style.background = color;
    f.style.boxShadow = `0 0 10px ${color}`;
  }
  setDist(m: number | null) { $('h-dist').textContent = m === null ? '' : m > 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`; }
  setDistrict(d: DistrictId) {
    $('h-district').textContent = DISTRICTS[d].name;
    if (this.lastDistrict && this.lastDistrict !== d) this.banner(DISTRICTS[d].name, 'Entering');
    this.lastDistrict = d;
  }
  /** the courier's standing in the current district (people talk) */
  setRep(v: number, label: string) {
    const el = $('h-rep');
    el.textContent = `Rep ${v > 0 ? '+' : ''}${v}`;
    el.title = label;
    el.classList.toggle('good', v >= 12);
    el.classList.toggle('bad', v <= -12);
  }
  banner(title: string, sub = '') {
    const b = $('banner');
    b.classList.remove('hidden');
    b.querySelector('.b-sub')!.textContent = sub;
    $('banner-title').textContent = title.toUpperCase();
    b.style.animation = 'none';
    void b.offsetWidth;
    b.style.animation = '';
    clearTimeout((b as any)._t);
    (b as any)._t = setTimeout(() => b.classList.add('hidden'), 3300);
  }
  toast(t: string, dur = 2.5) {
    const el = $('toast');
    el.textContent = t;
    el.classList.add('on');
    this.toastT = dur;
  }
  combo(t: string, sub = '', dur = 1.4) {
    const el = $('combo');
    el.innerHTML = `${t}${sub ? `<small>${sub}</small>` : ''}`;
    el.classList.add('on');
    this.comboT = dur;
  }
  /** Screen-edge arrow toward an off-screen objective. */
  arrow(cam: THREE.PerspectiveCamera, target: THREE.Vector3 | null, color: string) {
    const el = $('arrow');
    if (!target) { el.style.opacity = '0'; return; }
    const p = target.clone().add(new THREE.Vector3(0, 3, 0)).project(cam);
    const behind = p.z > 1;
    let x = p.x, y = p.y;
    if (behind) { x = -x; y = -y; }
    const onScreen = !behind && Math.abs(x) < 0.85 && Math.abs(y) < 0.85;
    if (onScreen) { el.style.opacity = '0'; return; }
    const ang = Math.atan2(y, x);
    const r = 0.82;
    const m = Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang)));
    const sx = (Math.cos(ang) / m) * r, sy = (Math.sin(ang) / m) * r;
    el.style.opacity = '1';
    el.style.borderBottomColor = color;
    el.style.left = `${(sx * 0.5 + 0.5) * innerWidth - 14}px`;
    el.style.top = `${(-sy * 0.5 + 0.5) * innerHeight - 13}px`;
    el.style.transform = `rotate(${-ang + Math.PI / 2}rad)`;
  }
  tick(dt: number) {
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) $('toast').classList.remove('on'); }
    if (this.comboT > 0) { this.comboT -= dt; if (this.comboT <= 0) $('combo').classList.remove('on'); }
  }
  fps(t: string) { $('fps').textContent = t; }
}

export { districtAt };
