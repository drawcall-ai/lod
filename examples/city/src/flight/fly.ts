import * as THREE from "three/webgpu";

/**
 * Free flight: drag to look, WASD to move, Q/E down and up, Shift to hurry, the wheel to
 * set the pace. Speed scales with the height above the ground (`clearance`), so the
 * same keys cross the town from the sky and creep through the corn.
 */
export class Fly {
  /** Set when the user steered; the app hands the camera over from the tour. */
  touched = false;
  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private pace = 1;

  constructor(
    element: HTMLElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly clearance: (at: THREE.Vector3) => number,
  ) {
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (/^Key[WASDQE]$/.test(e.code)) this.take();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());
    element.addEventListener("pointerdown", (e) => {
      element.setPointerCapture(e.pointerId);
      this.take();
    });
    element.addEventListener("wheel", (e) => (this.pace = THREE.MathUtils.clamp(this.pace * Math.exp(-e.deltaY * 0.002), 0.001, 10)), { passive: true });
    element.addEventListener("pointermove", (e) => {
      if (!e.buttons) return;
      this.yaw -= e.movementX * 0.003;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.003, -1.55, 1.55);
    });
  }

  /** Start from wherever the camera is now. */
  private take(): void {
    if (this.touched) return;
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = e.y;
    this.pitch = e.x;
    this.touched = true;
  }

  release(): void {
    this.touched = false;
  }

  /**
   * Moves the camera for `dt` seconds; returns the distance that matters for detail: the
   * height above ground, less when the pace is slowed to look at something small.
   */
  update(dt: number): number {
    const { camera, keys } = this;
    camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
    const height = Math.max(this.clearance(camera.position), 0.002);
    const move = new THREE.Vector3(
      (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0),
      (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyQ") ? 1 : 0),
      (keys.has("KeyS") ? 1 : 0) - (keys.has("KeyW") ? 1 : 0),
    );
    const focus = () => Math.max(this.clearance(camera.position) * Math.min(this.pace, 1), 0.002);
    if (move.lengthSq() === 0) return focus();
    const speed = height * this.pace * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 3 : 0.8);
    const up = move.y;
    move.y = 0;
    move.applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(move, speed * dt);
    camera.position.y += up * speed * dt;
    // never below the ground
    const below = this.clearance(camera.position);
    if (below < 0.002) camera.position.y += 0.002 - below;
    return focus();
  }
}
