import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import type { Vehicle } from './vehicle';
import { kitParts } from '../core/assets';
import { LAYER_NO_REFLECT } from '../render/reflector';
import { createConeMaterial } from '../render/specialMaterials';
import { type CarAsset, type CarLightUniforms, patchCarLights, carPaint } from './carModels';

export const PAINTS: { id: string; name: string; color: [number, number, number]; metal: number }[] = [
  { id: 'gunmetal', name: 'Gunmetal', color: [1, 1, 1], metal: 0.6 },
  { id: 'midnight', name: 'Midnight Blue', color: [0.35, 0.6, 2.2], metal: 0.7 },
  { id: 'crimson', name: 'Crimson', color: [2.6, 0.25, 0.3], metal: 0.5 },
  { id: 'toxic', name: 'Toxic Lime', color: [1.4, 2.6, 0.3], metal: 0.4 },
  { id: 'pearl', name: 'Pearl', color: [3.4, 3.4, 3.6], metal: 0.3 },
  { id: 'violet', name: 'Ultraviolet', color: [1.6, 0.4, 2.8], metal: 0.65 },
];
export const UNDERGLOW = ['#21f3ff', '#ff2fb4', '#ffb020', '#7cff4f', '#9b5cff', '#ffffff'];

function radialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner);
  gr.addColorStop(1, outer);
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export class CarVisual {
  root = new THREE.Group();
  body = new THREE.Group();
  wheels: THREE.Object3D[] = [];
  wheelLocal: Record<string, THREE.Vector3> = {};
  headLights: THREE.SpotLight[] = [];
  tailLight: THREE.PointLight;
  underLight: THREE.PointLight;
  underglow: THREE.Mesh;
  shadow: THREE.Mesh;
  brakeMat?: THREE.MeshStandardMaterial;
  tailMat?: THREE.MeshStandardMaterial;
  paintMat?: THREE.MeshPhysicalMaterial;
  bodyMesh?: THREE.Mesh;
  flames: THREE.Mesh[] = [];
  flameLight: THREE.PointLight;
  beams: THREE.Mesh;
  underglowColor = new THREE.Color('#21f3ff');
  private decal?: THREE.Object3D;
  lightU?: CarLightUniforms;
  dims = { length: 4.8, width: 2.06, height: 1.3 };
  readonly isHero: boolean;

  constructor(car: GLTF | null, kit: GLTF, envMap: THREE.Texture | null, asset?: CarAsset) {
    this.root.add(this.body);
    this.isHero = !asset;
    if (asset) {
      // generated car: body with texture-driven lights + its own baked wheels
      const sp = asset.spec;
      this.dims = { length: sp.length, width: sp.width, height: sp.height };
      for (const b of asset.body) {
        let mat = b.material;
        if (mat.name !== 'liner' && (mat as THREE.MeshStandardMaterial).map) {
          const pm = carPaint(mat as THREE.MeshStandardMaterial, envMap);
          this.lightU = patchCarLights(pm, sp.length / 2, false);
          mat = pm;
          this.paintMat = pm;
        }
        const mesh = new THREE.Mesh(b.geometry, mat);
        if (mat === this.paintMat) this.bodyMesh = mesh;
        this.body.add(mesh);
      }
      for (const k of ['FL', 'FR', 'RL', 'RR'] as const) {
        this.wheelLocal[k] = new THREE.Vector3(...sp.wheels[k]);
        const pivot = new THREE.Group();
        const spinner = new THREE.Group();
        for (const w of asset.wheels[k]) {
          const wm = (w.material as THREE.MeshStandardMaterial).map ? carPaint(w.material as THREE.MeshStandardMaterial, envMap) : w.material;
          spinner.add(new THREE.Mesh(w.geometry, wm));
        }
        pivot.add(spinner);
        pivot.position.copy(this.wheelLocal[k]);
        this.root.add(pivot);
        this.wheels.push(pivot);
      }
    } else if (car) {
      // own copy per car (the garage, story missions and parked cars can create several):
      // wheel positions are measured in the copy's local space, never relative to an older car
      const scene = car.scene.clone(true);
      scene.updateMatrixWorld(true);
      scene.traverse((o) => {
        if (o.name.startsWith('wheel_')) this.wheelLocal[o.name.slice(6)] = o.getWorldPosition(new THREE.Vector3());
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        let mat = m.material as THREE.MeshStandardMaterial;
        if (mat.name.startsWith('emit_')) {
          mat = mat.clone();
          m.material = mat;
          mat.emissiveIntensity = mat.name === 'emit_headlight' ? 9 : 4;
          if (mat.name === 'emit_brake') { this.brakeMat = mat; mat.emissiveIntensity = 0.3; }
          if (mat.name === 'emit_taillight') this.tailMat = mat;
        } else if (mat.name !== 'liner') {
          // promote body paint to a clear-coated physical material for wet glossy reflections
          const p = new THREE.MeshPhysicalMaterial({
            map: mat.map, normalMap: mat.normalMap, roughnessMap: mat.roughnessMap, metalnessMap: mat.metalnessMap,
            roughness: 1, metalness: 1, clearcoat: 1, clearcoatRoughness: 0.06, envMap, envMapIntensity: 1.6,
          });
          p.name = 'paint';
          m.material = p;
          this.paintMat = p;
          this.bodyMesh = m;
        }
        m.castShadow = false;
      });
      this.body.add(scene);
    } else {
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.9, 4.6), new THREE.MeshPhysicalMaterial({ color: 0x222228, metalness: 0.6, roughness: 0.3, clearcoat: 1 }));
      box.position.y = 0.8;
      this.body.add(box);
    }
    if (!asset && !this.wheelLocal.FL) {
      this.wheelLocal = { FL: new THREE.Vector3(0.84, 0.35, 1.43), FR: new THREE.Vector3(-0.84, 0.35, 1.43), RL: new THREE.Vector3(0.84, 0.35, -1.38), RR: new THREE.Vector3(-0.84, 0.35, -1.38) };
    }
    // hero: wheels from the Blender kit (axis along X)
    const parts = asset ? [] : kitParts(kit, 'hero_wheel');
    if (!asset) for (const k of ['FL', 'FR', 'RL', 'RR']) {
      const pivot = new THREE.Group(); // steering pivot
      const spinner = new THREE.Group(); // spin about X
      for (const p of parts) {
        const mm = new THREE.Mesh(p.geometry, p.material);
        if (envMap) { (p.material as THREE.MeshStandardMaterial).envMap = envMap; }
        spinner.add(mm);
      }
      // kit wheel is built with its outer face toward +X; mirror for the right side
      if (k[1] === 'R') spinner.scale.x = -1;
      spinner.scale.multiplyScalar(0.98);
      pivot.add(spinner);
      pivot.position.copy(this.wheelLocal[k]);
      this.root.add(pivot);
      this.wheels.push(pivot);
    }

    // headlights: two spot lights with volumetric beam cones
    const D = this.dims, hl = D.length / 2, hx = D.width * 0.3, hy = Math.min(0.75, D.height * 0.45);
    for (const sx of [hx, -hx]) {
      const s = new THREE.SpotLight(0xdde8ff, 260, 85, 0.42, 0.55, 1.4);
      s.position.set(sx, hy, hl - 0.15);
      s.target.position.set(sx * 1.4, -0.4, 20);
      this.root.add(s, s.target);
      this.headLights.push(s);
    }
    const beamGeo = new THREE.ConeGeometry(1, 1, 24, 1, true);
    beamGeo.translate(0, -0.5, 0);
    beamGeo.rotateX(-Math.PI / 2); // apex at origin, opening toward +Z
    const beamMat = createConeMaterial(0.05);
    const beams = new THREE.InstancedMesh(beamGeo, beamMat, 2);
    const cols = new Float32Array([0.85, 0.9, 1, 0.85, 0.9, 1]);
    beams.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(cols, 3));
    [hx, -hx].forEach((sx, i) => {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(sx, hy, hl - 0.1), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.06, 0, 0)), new THREE.Vector3(4.5, 3, 26));
      beams.setMatrixAt(i, m);
    });
    beams.layers.set(LAYER_NO_REFLECT);
    beams.frustumCulled = false;
    this.beams = beams;
    this.root.add(beams);

    this.tailLight = new THREE.PointLight(0xff1010, 2.5, 7, 2);
    this.tailLight.position.set(0, 0.35, -hl - 1.1); // behind the car, lighting the road rather than the bumper
    this.root.add(this.tailLight);

    // underglow: emissive blurred quad on the ground + a small point light
    const ugTex = radialTexture();
    this.underglow = new THREE.Mesh(
      new THREE.PlaneGeometry(D.width * 1.45, D.length * 1.15).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: ugTex, color: this.underglowColor.clone().multiplyScalar(0.8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.underglow.position.y = 0.03;
    this.root.add(this.underglow);
    this.underLight = new THREE.PointLight(this.underglowColor, 18, 7, 2);
    this.underLight.position.set(0, 0.25, 0);
    this.root.add(this.underLight);
    // underglow is a Night Courier mod: generated cars (stolen, bought, story) ship without it
    if (!this.isHero) { this.underglow.visible = false; this.underLight.visible = false; this.underglowColor.setRGB(0, 0, 0); }

    // contact shadow (multiply-darkening blob)
    const shTex = radialTexture('rgba(0,0,0,0.9)', 'rgba(0,0,0,0)');
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(D.width * 1.35, D.length * 1.15).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false }));
    this.shadow.position.y = 0.02;
    this.shadow.renderOrder = -1;
    this.root.add(this.shadow);

    // boost flames
    const flameGeo = new THREE.ConeGeometry(0.09, 1, 12, 1, true);
    flameGeo.translate(0, -0.5, 0);
    flameGeo.rotateX(Math.PI / 2); // apex at origin pointing -Z... flame extends backwards
    for (const sx of [0.42, -0.42]) {
      const f = new THREE.Mesh(flameGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.15, 0.35, 2.2), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      f.position.set(sx, 0.42, -hl + 0.05);
      f.visible = false;
      this.root.add(f);
      this.flames.push(f);
    }
    this.flameLight = new THREE.PointLight(0x55aaff, 0, 9, 2);
    this.flameLight.position.set(0, 0.5, -hl - 0.6);
    this.root.add(this.flameLight);
  }

  setPaint(id: string) {
    if (!this.isHero) return; // generated cars keep their own paint job
    const p = PAINTS.find((q) => q.id === id) ?? PAINTS[0];
    if (this.paintMat) {
      this.paintMat.color.setRGB(...p.color);
      this.paintMat.metalness = p.metal;
    }
  }

  setUnderglow(hex: string) {
    if (!this.isHero) return;
    this.underglowColor.set(hex);
    (this.underglow.material as THREE.MeshBasicMaterial).color.copy(this.underglowColor).multiplyScalar(0.8);
    this.underLight.color.copy(this.underglowColor);
  }

  /** Project a livery decal onto both flanks and the hood. */
  setLivery(tex: THREE.Texture | null) {
    // the decal is a group of projected meshes (sides + hood): dispose every child's geometry
    if (this.decal) {
      this.decal.removeFromParent();
      this.decal.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      this.decal = undefined;
    }
    if (!tex || !this.bodyMesh) return;
    const mesh = this.bodyMesh;
    mesh.updateMatrixWorld(true);
    const mat = new THREE.MeshPhysicalMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.3, metalness: 0.2, clearcoat: 1, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 });
    const geos: THREE.BufferGeometry[] = [];
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const place = (pos: THREE.Vector3, rot: THREE.Euler, size: THREE.Vector3) => {
      const wp = pos.clone().applyMatrix4(this.root.matrixWorld);
      const wr = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromEuler(rot).premultiply(this.root.getWorldQuaternion(new THREE.Quaternion())));
      const g = new DecalGeometry(mesh, wp, wr, size);
      g.applyMatrix4(inv);
      geos.push(g);
    };
    place(new THREE.Vector3(1.0, 0.75, 0), new THREE.Euler(0, Math.PI / 2, 0), new THREE.Vector3(4.2, 1.0, 1.2));
    place(new THREE.Vector3(-1.0, 0.75, 0), new THREE.Euler(0, -Math.PI / 2, 0), new THREE.Vector3(4.2, 1.0, 1.2));
    place(new THREE.Vector3(0, 1.1, 1.3), new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2), new THREE.Vector3(1.6, 1.0, 1.2));
    const g = new THREE.Group();
    for (const geo of geos) g.add(new THREE.Mesh(geo, mat));
    this.decal = g;
    this.root.add(g);
  }

  private t = 0;
  update(dt: number, v: Vehicle, pos: THREE.Vector3, quat: THREE.Quaternion, throttle: number) {
    this.t += dt;
    this.root.position.copy(pos);
    this.root.quaternion.copy(quat);
    const keys = ['FL', 'FR', 'RL', 'RR'];
    v.wheels.forEach((w, i) => {
      const pivot = this.wheels[i];
      const base = this.wheelLocal[keys[i]];
      // suspension travel: wheel centre sits at contact + radius (in body space)
      let y = base.y;
      if (w.contact) {
        const local = this.root.worldToLocal(w.contactPoint.clone());
        y = THREE.MathUtils.clamp(local.y + v.wheelRadius, base.y - 0.25, base.y + 0.2);
      } else y = base.y - 0.12;
      pivot.position.set(base.x, THREE.MathUtils.lerp(pivot.position.y || base.y, y, Math.min(1, dt * 30)), base.z);
      pivot.rotation.set(0, w.steer, 0);
      pivot.children[0].rotation.x = w.spin;
    });
    const braking = v.braking;
    if (this.brakeMat) this.brakeMat.emissiveIntensity = braking ? 14 : 0.3;
    if (this.lightU) this.lightU.uBrake.value = braking ? 1 : 0;
    this.tailLight.intensity = braking ? 9 : 2.5;
    // underglow pulse + boost flames
    const pulse = 1 + 0.08 * Math.sin(this.t * 3);
    this.underLight.intensity = 18 * pulse;
    const boosting = v.boosting;
    for (const f of this.flames) {
      f.visible = boosting;
      if (boosting) {
        const s = 0.55 + Math.random() * 0.35;
        f.scale.set(1 + Math.random() * 0.3, 1 + Math.random() * 0.3, s);
      }
    }
    this.flameLight.intensity = boosting ? 30 + Math.random() * 25 : 0;
    // exhaust pop on throttle lift could go here
    void throttle;
  }
}
