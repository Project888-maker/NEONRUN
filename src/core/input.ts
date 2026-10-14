import type { VehicleInput } from '../vehicle/vehicle';

/** Keyboard + gamepad + touch input merged into one VehicleInput. */
export class Input {
  keys = new Set<string>();
  touch = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false };
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
    addEventListener('blur', () => this.keys.clear());
  }

  consume(code: string) {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }
  endFrame() { this.pressed.clear(); }

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
      if (this.touch.steer) steerRaw = this.touch.steer;
      handbrake = handbrake || this.touch.handbrake;
      boost = boost || this.touch.boost;
    }
    // keyboard steering is digital: ramp it so it feels analog
    const rate = Math.abs(steerRaw) > Math.abs(this.steerSmooth) ? 5 : 9;
    this.steerSmooth += Math.max(-rate * dt, Math.min(rate * dt, steerRaw - this.steerSmooth));
    return { throttle, brake, steer: this.steerSmooth, handbrake, boost };
  }
}
