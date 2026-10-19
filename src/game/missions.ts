import * as THREE from 'three';
import type { City, Spot } from '../world/city';
import { RoadGraph, districtAt, DISTRICTS, DISTRICT_ORDER, type DistrictId } from '../world/layout';
import type { Hud } from './hud';
import type { AudioSys, VoiceName } from '../audio/audio';
import { Save, UNLOCK_AT, writeSave } from './progress';
import { Drone } from '../world/ambient';
import { LAYER_NO_REFLECT } from '../render/reflector';

type State = 'toPickup' | 'toDrop' | 'results';

export function beamMesh(color: THREE.Color) {
  const g = new THREE.CylinderGeometry(2.4, 2.4, 160, 32, 1, true);
  g.translate(0, 80, 0);
  const m = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position,1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }',
    fragmentShader: `uniform vec3 uColor; uniform float uTime; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        float f = pow(abs(dot(vN, vV)), 1.5);
        float h = vUv.y;
        float bands = 0.75 + 0.25 * sin(h * 160.0 - uTime * 6.0);
        float a = f * (1.0 - h) * (1.0 - h) * bands * 0.9;
        gl_FragColor = vec4(uColor * a * 2.5, 1.0);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(g, m);
  const ring = new THREE.Mesh(new THREE.RingGeometry(4.2, 5, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  ring.position.y = 0.2;
  const grp = new THREE.Group();
  grp.add(beam, ring);
  grp.traverse((o) => o.layers.set(LAYER_NO_REFLECT));
  return grp;
}

export interface MissionEvents {
  onUnlock: (d: DistrictId) => void;
  onComplete: (ok: boolean) => void;
  onNearMiss: () => void;
}

export class Missions {
  state: State = 'toPickup';
  pickup!: Spot;
  drop!: Spot;
  timer = 0;
  timeLimit = 0;
  route: THREE.Vector3[] = [];
  drones: Drone[] = [];
  group = new THREE.Group();
  private pickupBeam = beamMesh(new THREE.Color(0.13, 0.95, 1));
  private dropBeam = beamMesh(new THREE.Color(1, 0.18, 0.7));
  private routeTimer = 0;
  private driftScore = 0;
  private driftChain = 0;
  private nearMisses = 0;
  private hits = 0;
  private said20 = false; private said10 = false;
  private nearCooldown = new Map<number, number>();
  private resultsT = 0;
  private lastBeep = 0;
  private rng = Math.random;
  pickupLight: THREE.PointLight;
  /** true while a story mission runs: free-ride jobs are hidden and frozen */
  suspended = false;

  constructor(private city: City, private graph: RoadGraph, private hud: Hud, private audio: AudioSys, private save: Save, private ev: MissionEvents) {
    this.group.add(this.pickupBeam, this.dropBeam);
    this.pickupLight = new THREE.PointLight(0x21f3ff, 30, 25, 2);
    this.group.add(this.pickupLight);
    this.dropBeam.visible = false;
  }

  private spotsIn(d: DistrictId[]) { return this.city.spots.filter((s) => d.includes(s.district)); }

  newJob(playerPos: THREE.Vector3) {
    let pool = this.spotsIn(this.save.unlocked);
    if (!pool.length) pool = this.city.spots;
    // pickup reasonably close to the player
    const near = pool.filter((s) => { const d = Math.hypot(s.x - playerPos.x, s.z - playerPos.z); return d > 120 && d < 420; });
    this.pickup = (near.length ? near : pool)[Math.floor(this.rng() * (near.length ? near.length : pool.length))];
    this.state = 'toPickup';
    this.pickupBeam.visible = true;
    this.dropBeam.visible = false;
    this.pickupBeam.position.set(this.pickup.x, 0, this.pickup.z);
    this.pickupLight.position.set(this.pickup.x, 3, this.pickup.z);
    this.pickupLight.color.set(0x21f3ff);
    this.hud.setPrompt('Get to the pickup');
    this.hud.setTimer(null);
    this.computeRoute(playerPos);
    const lines: VoiceName[] = ['brief_1', 'brief_2', 'brief_3'];
    this.audio.say(lines[Math.floor(this.rng() * lines.length)]);
  }

  private startDelivery(playerPos: THREE.Vector3) {
    // prefer the most recently unlocked district now and then
    const newest = this.save.unlocked[this.save.unlocked.length - 1];
    const targetDistricts = this.rng() < 0.4 ? [newest] : this.save.unlocked;
    const pool = this.spotsIn(targetDistricts).filter((s) => { const d = Math.hypot(s.x - playerPos.x, s.z - playerPos.z); return d > 350 && d < 1100; });
    const all = this.spotsIn(this.save.unlocked);
    this.drop = (pool.length ? pool : all)[Math.floor(this.rng() * (pool.length ? pool.length : all.length))];
    this.state = 'toDrop';
    this.pickupBeam.visible = false;
    this.dropBeam.visible = true;
    this.dropBeam.position.set(this.drop.x, 0, this.drop.z);
    this.pickupLight.position.set(this.drop.x, 3, this.drop.z);
    this.pickupLight.color.set(0xff2fb4);
    this.computeRoute(playerPos);
    const len = this.routeLength(playerPos);
    const difficulty = Math.min(1, this.save.deliveries / 14);
    this.timeLimit = Math.round(len / (16 + difficulty * 6) + 12);
    this.timer = this.timeLimit;
    this.driftScore = 0; this.nearMisses = 0; this.hits = 0; this.said10 = this.said20 = false;
    this.hud.setPrompt('Get to the drop-off');
    this.audio.play('pickup');
    this.audio.play('mission_start', { volume: 0.7 });
    this.audio.say('pickup');
    this.audio.music_('drive');
    // hazard drones once the player has a few deliveries done: posted along the route, not on top of the player
    const nd = this.save.deliveries < 4 ? 0 : Math.min(2, 1 + Math.floor((this.save.deliveries - 4) / 6)) * (districtAt(this.drop.x, this.drop.z) === 'neon' ? 0.5 : 1);
    for (let i = 0; i < Math.round(nd); i++) {
      const d = new Drone();
      const k = 0.4 + 0.3 * this.rng();
      const post = { x: playerPos.x + (this.drop.x - playerPos.x) * k, z: playerPos.z + (this.drop.z - playerPos.z) * k };
      d.mesh.position.set(post.x + (this.rng() - 0.5) * 50, 26, post.z + (this.rng() - 0.5) * 50);
      this.drones.push(d);
      this.group.add(d.mesh);
    }
    if (this.drones.length) setTimeout(() => this.audio.say('drone'), 2500);
  }

  private clearDrones() {
    for (const d of this.drones) d.dispose();
    this.drones = [];
  }

  private routeLength(p: THREE.Vector3) {
    let l = 0, prev = p;
    for (const q of this.route) { l += prev.distanceTo(q); prev = q; }
    return l;
  }

  computeRoute(p: THREE.Vector3) {
    const target = this.state === 'toPickup' ? this.pickup : this.drop;
    if (!target) return;
    const a = this.graph.nearestNode(p.x, p.z), b = this.graph.nearestNode(target.x, target.z);
    const locked = DISTRICT_ORDER.filter((d) => !this.save.unlocked.includes(d));
    const blocked = (e: { a: number; b: number }) => {
      const A = this.graph.nodes[e.a], B = this.graph.nodes[e.b];
      const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2;
      return locked.includes(districtAt(mx + Math.sign(mx) * 0.5, mz + Math.sign(mz) * 0.5)) && Math.abs(mx) > 1 && Math.abs(mz) > 1;
    };
    const ids = this.graph.route(a, b, blocked);
    this.route = ids.map((i) => new THREE.Vector3(this.graph.nodes[i].x, 0, this.graph.nodes[i].z));
    this.route.push(new THREE.Vector3(target.x, 0, target.z));
  }

  suspend(on: boolean, playerPos: THREE.Vector3) {
    this.suspended = on;
    this.group.visible = !on;
    if (on) { this.clearDrones(); this.route = []; this.hud.setTimer(null); this.hud.setDist(null); document.getElementById('results')!.classList.add('hidden'); }
    else this.newJob(playerPos);
  }

  get target(): THREE.Vector3 | null {
    if (this.state === 'results' || this.suspended) return null;
    const s = this.state === 'toPickup' ? this.pickup : this.drop;
    return s ? new THREE.Vector3(s.x, 0, s.z) : null;
  }

  /** Called every frame. */
  update(dt: number, t: number, pos: THREE.Vector3, vel: THREE.Vector3, speed: number, drifting: boolean, trafficCars: { pos: THREE.Vector3; yaw: number; body: { handle: number } }[], onDroneHit: () => void) {
    if (this.suspended) return;
    (this.pickupBeam.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>).material.uniforms.uTime.value = t;
    (this.dropBeam.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>).material.uniforms.uTime.value = t;
    this.pickupLight.intensity = 30 + Math.sin(t * 4) * 8;
    if (this.state === 'results') {
      this.resultsT -= dt;
      if (this.resultsT <= 0) {
        document.getElementById('results')!.classList.add('hidden');
        this.newJob(pos);
      }
      return;
    }
    // re-route occasionally
    this.routeTimer -= dt;
    if (this.routeTimer <= 0) { this.routeTimer = 1.0; this.computeRoute(pos); }
    const tgt = this.target;
    if (!tgt) { this.newJob(pos); return; } // no job yet (should not happen): start one rather than fail every frame
    const dist = Math.hypot(tgt.x - pos.x, tgt.z - pos.z);
    this.hud.setDist(dist);

    if (this.state === 'toPickup') {
      if (dist < 6.5) this.startDelivery(pos);
      return;
    }
    // ---- delivery in progress
    this.timer -= dt;
    this.hud.setTimer(Math.max(0, this.timer));
    if (this.timer < 20 && !this.said20) { this.said20 = true; this.audio.say('twenty_left'); this.audio.music_('urgent'); }
    if (this.timer < 10 && !this.said10) { this.said10 = true; this.audio.say('ten_left'); }
    if (this.timer < 10 && Math.floor(this.timer) !== this.lastBeep) { this.lastBeep = Math.floor(this.timer); this.audio.play(this.timer < 5 ? 'timer_warning' : 'timer_tick', { volume: 0.6 }); }

    // drift scoring (chain while drifting, bank when it ends)
    if (drifting && speed > 12) {
      this.driftChain += dt * speed * 3;
      this.hud.combo(`DRIFT ${Math.round(this.driftChain)}`, 'keep it sideways', 0.5);
    } else if (this.driftChain > 0) {
      if (this.driftChain > 60) { this.driftScore += this.driftChain; this.hud.combo(`+${Math.round(this.driftChain)}`, 'drift banked', 1.2); }
      this.driftChain = 0;
    }
    // near misses
    if (speed > 18) {
      for (const c of trafficCars) {
        const d = c.pos.distanceTo(pos);
        if (d < 3.4 && d > 2.0) {
          const h = c.body.handle;
          if ((this.nearCooldown.get(h) ?? 0) > t) continue;
          this.nearCooldown.set(h, t + 3);
          this.nearMisses++;
          this.hud.combo('NEAR MISS', `+${50} · boost`, 1.2);
          this.audio.play('near_miss', { volume: 0.8 });
          this.ev.onNearMiss();
          if (this.rng() < 0.25) this.audio.say(this.rng() < 0.5 ? 'near_miss_1' : 'near_miss_2');
        }
      }
    }
    // drones
    for (const dr of this.drones) {
      if (dr.update(dt, pos, vel, t)) {
        this.timer -= 4;
        this.hits++;
        this.hud.toast('Drone strike  −4s');
        onDroneHit();
      }
    }

    if (dist < 6.5) this.finish(true, pos);
    else if (this.timer <= 0) this.finish(false, pos);
  }

  get droneList() { return this.drones; }

  private finish(ok: boolean, pos: THREE.Vector3) {
    this.state = 'results';
    this.resultsT = ok ? 5.5 : 4;
    this.clearDrones();
    this.dropBeam.visible = false;
    this.hud.setTimer(null);
    this.hud.setDist(null);
    this.route = [];
    const res = document.getElementById('results')!;
    const vid = document.getElementById('stinger') as HTMLVideoElement;
    res.classList.remove('hidden');
    const title = document.getElementById('r-title')!;
    title.textContent = ok ? 'Delivered' : 'Too late';
    title.classList.toggle('fail', !ok);
    const rows = document.getElementById('r-rows')!;
    const total = document.getElementById('r-total')!;
    if (ok) {
      const base = 220 + Math.round(this.timeLimit * 6);
      const timeBonus = Math.round(Math.max(0, this.timer) * 14);
      const style = Math.round(this.driftScore * 0.5 + this.nearMisses * 50);
      const district = districtAt(this.drop.x, this.drop.z);
      const mult = 1 + DISTRICTS[district].order * 0.25;
      const sum = Math.round((base + timeBonus + style) * mult);
      rows.innerHTML = `<div>Delivery fee <b>${base}</b></div><div>Time bonus (${this.timer.toFixed(1)}s) <b>${timeBonus}</b></div><div>Style (drift ${Math.round(this.driftScore)}, near misses ${this.nearMisses}) <b>${style}</b></div><div>${DISTRICTS[district].name} rate <b>×${mult.toFixed(2)}</b></div>${this.hits ? `<div>Drone hits <b>${this.hits}</b></div>` : ''}`;
      total.textContent = `+${sum.toLocaleString()} CR`;
      this.save.credits += sum;
      this.save.deliveries++;
      this.audio.play('mission_complete');
      setTimeout(() => this.audio.play('cash'), 700);
      this.audio.say(Math.random() < 0.5 ? 'success_1' : 'success_2');
      vid.currentTime = 0;
      vid.classList.remove('hidden');
      vid.play().catch(() => {});
      // unlocks
      for (const d of DISTRICT_ORDER) {
        if (!this.save.unlocked.includes(d) && this.save.deliveries >= UNLOCK_AT[d]) {
          this.save.unlocked.push(d);
          setTimeout(() => this.ev.onUnlock(d), 3500);
        }
      }
    } else {
      rows.innerHTML = `<div>The client walked.</div><div>Package value lost <b>0 CR</b></div>`;
      total.textContent = '';
      vid.classList.add('hidden');
      this.audio.play('ui_error');
      this.audio.say(Math.random() < 0.5 ? 'fail_1' : 'fail_2');
    }
    this.audio.music_('chill');
    writeSave(this.save);
    this.hud.setCredits(this.save.credits);
    this.ev.onComplete(ok);
    void pos;
  }

  dispose() { this.clearDrones(); }
}
