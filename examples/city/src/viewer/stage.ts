import * as THREE from "three/webgpu";
import { terrain } from "../content/terrain.ts";
import { loadSky } from "../render/sky.ts";

/**
 * Lighting and ground for looking at content. The HDRI's sun is cut out of the image-based
 * light and replaced by a directional light of the same energy and direction, so it casts
 * shadows instead of lighting everything evenly. Shadows are fitted to whatever is shown.
 */
export class Stage {
  readonly scene = new THREE.Scene();
  readonly sun = new THREE.DirectionalLight("#fff3e2", 3);
  private readonly ground: THREE.Mesh<THREE.PlaneGeometry, THREE.Material>;
  private sunDirection = new THREE.Vector3(0.5, 0.8, 0.3).normalize();

  constructor() {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.scene.add(this.sun, this.sun.target);
    // 20 km of ground with UVs in metres, so distant views do not end at an edge
    const size = 20000;
    const plane = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
    const uv = plane.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - 0.5) * size, (uv.getY(i) - 0.5) * size);
    this.ground = new THREE.Mesh(plane, terrain());
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  async loadSky(renderer: THREE.Renderer): Promise<void> {
    // turn the sky so the sun rakes across content facing +z from the front left
    const sky = await loadSky(renderer, Math.atan2(0.8, -0.6));
    this.sunDirection = sky.sun;
    this.sun.intensity = sky.irradiance;
    this.scene.environment = sky.environment;
    this.scene.background = sky.background;
    this.scene.environmentRotation.y = this.scene.backgroundRotation.y = sky.turn;
  }

  setGround(material: THREE.Material): void {
    this.ground.material = material;
  }

  /** Points the sun's shadow camera at the box so shadow texels scale with the object. */
  fitShadow(box: THREE.Box3): void {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius * 1.2, 0.002);
    this.sun.target.position.copy(sphere.center);
    this.sun.position.copy(sphere.center).addScaledVector(this.sunDirection, r * 4);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -r;
    cam.right = cam.top = r;
    cam.near = r * 0.5;
    cam.far = r * 8;
    cam.updateProjectionMatrix();
    // the sun is low, so thin flat surfaces (leaves) need several shadow texels of normal
    // offset to stay free of acne; one texel is r / 2048
    this.sun.shadow.bias = -0.0001;
    this.sun.shadow.normalBias = r * 0.002;
  }
}
