// IMU orientation: a small three.js box rotated by the stream's first four channels read as a
// quaternion [w, x, y, z] (the Myo layout). three.js is loaded on demand, so pages without an IMU
// stream never download it. If WebGL is unavailable the view says so and the charts keep working.

import type { RingBuffer } from '../lib/ringbuffer';
import { el } from '../ui/dom';

type Three = typeof import('three');

export class ImuView {
  readonly root: HTMLDivElement;
  private readout: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private three: Three | null = null;
  private renderer: import('three').WebGLRenderer | null = null;
  private scene: import('three').Scene | null = null;
  private camera: import('three').PerspectiveCamera | null = null;
  private box: import('three').Object3D | null = null;
  private lastT = NaN;
  frames = 0;
  quat: [number, number, number, number] = [1, 0, 0, 0];

  constructor(private rb: RingBuffer) {
    this.root = el('div', 'imu');
    this.canvas = el('canvas', 'imu-canvas');
    this.readout = el('div', 'imu-readout', 'w 1  x 0  y 0  z 0');
    this.root.append(this.canvas, this.readout);
    void this.init();
  }

  private async init(): Promise<void> {
    let THREE: Three;
    try {
      THREE = await import('three');
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    } catch {
      this.readout.textContent = 'WebGL unavailable: orientation view disabled';
      return;
    }
    this.three = THREE;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(3.2, 2.4, 4.2);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, 5, 4);
    this.scene.add(sun);
    // A box with one colored face per axis (+X red, +Y green, +Z blue) so the orientation is readable.
    const mats = [0xe57373, 0x5d4037, 0x81c784, 0x33691e, 0x4fc3f7, 0x1a237e]
      .map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.0), mats);
    const group = new THREE.Group();
    group.add(box, new THREE.AxesHelper(1.3));
    this.box = group;
    this.scene.add(group);
    this.scene.add(new THREE.GridHelper(4, 8, 0x444444, 0x2a2a2a).translateY(-1));
  }

  draw(): void {
    if (!this.rb.length) return;
    const t = this.rb.lastTime;
    const i = this.rb.length - 1;
    const [w, x, y, z] = [0, 1, 2, 3].map((c) => this.rb.valueAt(c, i));
    const norm = Math.hypot(w, x, y, z);
    if (!Number.isFinite(norm) || norm < 1e-9) return;
    if (t !== this.lastT) {
      this.quat = [w / norm, x / norm, y / norm, z / norm];
      this.readout.textContent = `w ${this.quat[0].toFixed(2)}  x ${this.quat[1].toFixed(2)}  ` +
        `y ${this.quat[2].toFixed(2)}  z ${this.quat[3].toFixed(2)}`;
    }
    if (!this.renderer || !this.scene || !this.camera || !this.box || !this.three) return;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    const size = this.renderer.getSize(new this.three.Vector2());
    if (size.x !== cw || size.y !== ch) {
      this.renderer.setSize(cw, ch, false);
      this.camera.aspect = cw / ch;
      this.camera.updateProjectionMatrix();
      this.lastT = NaN;
    }
    if (t === this.lastT) return;  // only re-render when a new orientation arrived
    this.lastT = t;
    this.box.quaternion.set(this.quat[1], this.quat[2], this.quat[3], this.quat[0]);  // three: (x, y, z, w)
    this.renderer.render(this.scene, this.camera);
    this.frames++;
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
  }
}
