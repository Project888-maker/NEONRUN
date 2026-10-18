import RAPIER from '@dimforge/rapier3d-compat';

export type R = typeof RAPIER;
export { RAPIER };

export const GROUP_WORLD = 0x0001;
export const GROUP_CAR = 0x0002;
export const GROUP_TRAFFIC = 0x0004;
export const GROUP_GATE = 0x0008;
/** the courier on foot: blocked by the world and every car, parked or moving */
export const GROUP_HERO = 0x0010;
/** membership << 16 | filter */
export const groups = (member: number, filter: number) => (member << 16) | filter;

export class Physics {
  world!: RAPIER.World;
  static async init() {
    await RAPIER.init();
    const p = new Physics();
    p.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    p.world.timestep = 1 / 60;
    // ground plane
    const g = p.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    p.world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 1, 4000).setTranslation(0, -1, 0).setFriction(1.0), g);
    return p;
  }

  private fixedBody?: RAPIER.RigidBody;
  private get fixed() {
    if (!this.fixedBody) this.fixedBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    return this.fixedBody;
  }

  box(x: number, y: number, z: number, hx: number, hy: number, hz: number, rotY = 0, friction = 0.3) {
    const d = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(friction).setRestitution(0.1);
    if (rotY) d.setRotation({ x: 0, y: Math.sin(rotY / 2), z: 0, w: Math.cos(rotY / 2) });
    return this.world.createCollider(d, this.fixed);
  }

  cylinder(x: number, y: number, z: number, halfH: number, r: number) {
    return this.world.createCollider(RAPIER.ColliderDesc.cylinder(halfH, r).setTranslation(x, y, z).setFriction(0.2).setRestitution(0.2), this.fixed);
  }

  remove(c: RAPIER.Collider) { this.world.removeCollider(c, false); }
}
