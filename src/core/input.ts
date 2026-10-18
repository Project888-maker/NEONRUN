import type { VehicleInput } from '../vehicle/vehicle';

/** Keyboard + gamepad + touch input merged into one VehicleInput. */
export class Input {
  keys = new Set<string>();
  touch = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false, moveY: 0, run: false, lookX: 0, lookY: 0 };
  pressed = new Set<string>(); // edge-triggered this frame
  private steerSmooth = 0;
  scripted: Partial<VehicleInput> | null = null; // for automated tests / screenshots

  constructor() {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    // with the mouse captured (playing on foot): left button punches, right button kicks
    addEventListener('mousedown', (e) => { if (document.pointerLockElement) this.pressed.add(`Mouse${e.button}`); });
    addEventListener('contextmenu', (e) => { if (document.pointerLockElement) e.preventDefault(); });
    addEventListener('blur', () => this.keys.clear());
  }

  consume(code: string) {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }
  endFrame() { this.pressed.clear(); }

  /** On-foot movement: x = strafe right, z = forward (camera relative). */
  readFoot() {
    const k = this.keys;
    let x = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    let z = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let run = k.has('ShiftLeft') || k.has('ShiftRight');
    let jump = this.pressed.has('Space');
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      if (Math.abs(p.axes[0] ?? 0) > 0.15) x = p.axes[0];
      if (Math.abs(p.axes[1] ?? 0) > 0.15) z = -p.axes[1];
      run = run || !!p.buttons[1]?.pressed || (p.buttons[7]?.value ?? 0) > 0.5;
      jump = jump || !!p.buttons[0]?.pressed;
    }
    if (this.touch.steer || this.touch.moveY) { x = this.touch.steer; z = this.touch.moveY; }
    // radial dead zone: a thumb resting on the stick (or a slightly drifting gamepad stick) must not
    // count as input — it used to make the hero twist back and forth on the spot
    const mag = Math.hypot(x, z);
    if (mag < 0.2) { x = 0; z = 0; } else if (mag < 1) { const k = (mag - 0.2) / 0.8 / mag; x *= k; z *= k; }
    // touch: RUN button, or push the stick all the way out
    run = run || this.touch.run || (!!(this.touch.steer || this.touch.moveY) && Math.hypot(x, z) > 0.95);
    if (this.scripted) { x = (this.scripted as any).footX ?? 0; z = (this.scripted as any).footZ ?? 0; run = !!(this.scripted as any).run; jump = !!(this.scripted as any).jump; }
    return { x, z, run, jump };
  }

  read(dt: number): VehicleInput {
    if (this.scripted) return { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, ...this.scripted };
    const k = this.keys;
    let throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    let brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    let steerRaw = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let handbrake = k.has('Space');
    let boost = k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyN');

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) steerRaw = ax;
      throttle = Math.max(throttle, p.buttons[7]?.value ?? 0);
      brake = Math.max(brake, p.buttons[6]?.value ?? 0);
      handbrake = handbrake || !!p.buttons[0]?.pressed || !!p.buttons[5]?.pressed;
      boost = boost || !!p.buttons[1]?.pressed || !!p.buttons[2]?.pressed;
    }
    if (this.touch.throttle || this.touch.brake || this.touch.steer || this.touch.handbrake || this.touch.boost) {
      throttle = Math.max(throttle, this.touch.throttle);
      brake = Math.max(brake, this.touch.brake);
      if (Math.abs(this.touch.steer) > 0.1) steerRaw = Math.sign(this.touch.steer) * (Math.abs(this.touch.steer) - 0.1) / 0.9; // dead zone for a resting thumb
      handbrake = handbrake || this.touch.handbrake;
      boost = boost || this.touch.boost;
    }
    // keyboard steering is digital: ramp it so it feels analog
    const rate = Math.abs(steerRaw) > Math.abs(this.steerSmooth) ? 5 : 9;
    this.steerSmooth += Math.max(-rate * dt, Math.min(rate * dt, steerRaw - this.steerSmooth));
    return { throttle, brake, steer: this.steerSmooth, handbrake, boost };
  }
}
