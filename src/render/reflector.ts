import * as THREE from 'three';

/**
 * Planar reflection for a horizontal plane at y = height.
 * Renders the scene mirrored into a half-res HDR target with mipmaps (for rough blur).
 * Objects on layer REFLECT_HIDE (e.g. the road itself, rain) are skipped.
 */
export const LAYER_NO_REFLECT = 2;

export class PlanarReflector {
  rt: THREE.WebGLRenderTarget;
  textureMatrix = new THREE.Matrix4();
  camera = new THREE.PerspectiveCamera();
  height: number;
  enabled = true;
  far = 320;
  private plane = new THREE.Plane();
  private normal = new THREE.Vector3(0, 1, 0);
  private clipPlane = new THREE.Vector4();
  private q = new THREE.Vector4();
  private v = new THREE.Vector3();
  private frame = 0;

  constructor(height = 0, public scale = 0.5, public every = 1) {
    this.height = height;
    this.rt = new THREE.WebGLRenderTarget(16, 16, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    this.camera.layers.enableAll();
    this.camera.layers.disable(LAYER_NO_REFLECT);
  }

  setSize(w: number, h: number) {
    this.rt.setSize(Math.max(16, Math.round(w * this.scale)), Math.max(16, Math.round(h * this.scale)));
  }

  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.PerspectiveCamera) {
    if (!this.enabled) return;
    if (this.frame++ % this.every !== 0) return;
    const rc = this.camera;
    const h = this.height;
    // mirror camera position & orientation
    rc.position.set(cam.position.x, 2 * h - cam.position.y, cam.position.z);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    dir.y = -dir.y;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    up.y = -up.y;
    rc.up.copy(up);
    rc.lookAt(rc.position.clone().add(dir));
    // reflections only need the nearby street: a short far plane culls distant chunks (big draw-call saving)
    rc.fov = cam.fov; rc.aspect = cam.aspect; rc.near = cam.near; rc.far = Math.min(cam.far, this.far);
    rc.updateMatrixWorld();
    rc.updateProjectionMatrix();

    // texture matrix: world -> reflection uv
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);

    // oblique near-plane clipping (Lengyel) so nothing below the plane leaks in
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.v.set(0, h, 0));
    this.plane.applyMatrix4(rc.matrixWorldInverse);
    this.clipPlane.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const pm = rc.projectionMatrix;
    const q = this.q;
    q.x = (Math.sign(this.clipPlane.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(this.clipPlane.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1.0;
    q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    this.clipPlane.multiplyScalar(2.0 / this.clipPlane.dot(q));
    pm.elements[2] = this.clipPlane.x;
    pm.elements[6] = this.clipPlane.y;
    pm.elements[10] = this.clipPlane.z + 1.0 - 0.003;
    pm.elements[14] = this.clipPlane.w;

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.rt);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, rc);
    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevTarget);
  }
}
