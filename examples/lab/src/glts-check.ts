import * as THREE from "three";
import { GLTSLoader } from "@drawcall/glts";
import {
  ImpostorMesh,
  bakeImpostor,
  boxCentre,
  decodeImpostor,
  encodeImpostor,
  boundingRadius,
  writeImpostorGlts,
} from "@drawcall/impostor";

// End-to-end check that a `.glts` written by writeImpostorGlts loads through the real
// GLTSLoader and renders the same pixels as an ImpostorMesh built directly from the
// decoded data. Driven by scripts/glts-e2e.ts through `window.gltsCheck.run()`.

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
renderer.setSize(64, 64);
document.body.appendChild(renderer.domElement);

const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(`error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => errors.push(`unhandledrejection: ${String(e.reason)}`));
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  errors.push(`console.error: ${args.map(String).join(" ")}`);
  consoleError(...args);
};

function subject(): THREE.Object3D {
  const group = new THREE.Group();
  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.6, 0.2, 128, 24),
    new THREE.MeshStandardMaterial({ color: 0xd06030, roughness: 0.45, metalness: 0.1 }),
  );
  knot.position.y = 1;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#3fa34d";
  ctx.beginPath();
  ctx.arc(64, 64, 56, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f2e14c";
  ctx.fillRect(40, 40, 48, 48);
  ctx.clearRect(56, 56, 16, 16);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const leaf = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.8),
    new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide }),
  );
  leaf.position.set(0.7, 0.4, 0.3);
  leaf.rotation.set(-0.4, 0.6, 0);
  group.add(knot, leaf);
  return group;
}

// ------------------------------------------------------------------ rendering

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(40, 60, 50);
scene.add(sun, sun.target, new THREE.HemisphereLight(0xbfd4ff, 0x4a3d2e, 0.8));

interface Shot {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Renders `scene` with only `show` of the candidates visible. */
function shoot(show: THREE.Object3D, hide: THREE.Object3D[], camera: THREE.Camera, width: number, height: number): Shot {
  show.visible = true;
  for (const o of hide) o.visible = false;
  const target = new THREE.WebGLRenderTarget(width, height, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  renderer.setRenderTarget(null);
  target.dispose();
  return { width, height, pixels };
}

function compare(a: Shot, b: Shot) {
  let max = 0;
  let sum = 0;
  let differing = 0;
  let coverageA = 0;
  let coverageB = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    let pixelMax = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.pixels[i + c]! - b.pixels[i + c]!);
      sum += d;
      pixelMax = Math.max(pixelMax, d);
    }
    max = Math.max(max, pixelMax);
    if (pixelMax > 2) differing++;
    if (a.pixels[i]! + a.pixels[i + 1]! + a.pixels[i + 2]! > 0) coverageA++;
    if (b.pixels[i]! + b.pixels[i + 1]! + b.pixels[i + 2]! > 0) coverageB++;
  }
  const count = a.pixels.length / 4;
  return { maxDiff: max, meanDiff: sum / (count * 3), differingPixels: differing, coverageGlts: coverageA / count, coverageDirect: coverageB / count };
}

/** glts | direct | 8x amplified difference, flipped to top-down. */
function sideBySide(a: Shot, b: Shot): string {
  const { width, height } = a;
  const canvas = document.createElement("canvas");
  canvas.width = width * 3;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(width * 3, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const src = ((height - 1 - y) * width + x) * 4;
      for (let panel = 0; panel < 3; panel++) {
        const dst = (y * width * 3 + panel * width + x) * 4;
        for (let c = 0; c < 3; c++) {
          const va = a.pixels[src + c]!;
          const vb = b.pixels[src + c]!;
          image.data[dst + c] = panel === 0 ? va : panel === 1 ? vb : Math.min(255, Math.abs(va - vb) * 8);
        }
        image.data[dst + 3] = 255;
      }
    }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function find(root: THREE.Object3D): THREE.Object3D | undefined {
  let found: THREE.Object3D | undefined;
  root.traverse((o) => {
    if ((o as { isImpostorMesh?: boolean }).isImpostorMesh) found ??= o;
  });
  return found;
}

function grid(index: number, spacing: number, offset: THREE.Vector3): THREE.Matrix4 {
  const col = index % 25;
  const row = Math.floor(index / 25);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), index * 0.37);
  const scale = 0.8 + 0.4 * ((index * 7) % 5) / 4;
  return new THREE.Matrix4().compose(
    new THREE.Vector3((col - 12) * spacing, 0, (row - 9.5) * spacing).add(offset),
    rotation,
    new THREE.Vector3(scale, scale, scale),
  );
}

// ------------------------------------------------------------------ check

async function run() {
  errors.length = 0;
  const checks: Record<string, boolean> = {};
  const images: Record<string, string> = {};

  const object = subject();
  const impostor = await bakeImpostor(object, { renderer, resolution: 64 });
  const encoded = encodeImpostor(impostor);
  const source = writeImpostorGlts(impostor);
  const url = URL.createObjectURL(new Blob([source], { type: "text/plain" }));
  const sphere = boundingRadius(impostor.box);
  const centre = new THREE.Vector3(...boxCentre(impostor.box));
  const result: Record<string, unknown> = {
    renderer: rendererName(),
    impostor: { frames: impostor.frames, size: impostor.size, layout: impostor.layout, maps: impostor.maps, halfSize: impostor.halfSize, sphere },
    encodedBytes: encoded.length,
    gltsSourceChars: source.length,
  };
  // Base64 of the KTX2 file plus a header of well under 2 KB.
  checks.sourceLength = source.length > Math.ceil(encoded.length / 3) * 4 && source.length < Math.ceil(encoded.length / 3) * 4 + 2048;
  checks.sourceImport = /from "@drawcall\/impostor@\d+\.\d+\.\d+"/.test(source);

  renderer.info.autoReset = false;
  const memoryBefore = { ...renderer.info.memory };
  const loader = new GLTSLoader(new THREE.LoadingManager(), { cdnURL: new URL("/esm/", location.origin).href });

  // ---- single: loadAsync, with a transform on the loaded scene root
  const single = await loader.loadAsync(url);
  const loadedMesh = find(single);
  checks.isImpostorMesh = loadedMesh !== undefined;
  checks.separateModuleInstance = loadedMesh !== undefined && !(loadedMesh instanceof ImpostorMesh);
  const direct = new ImpostorMesh(decodeImpostor(encodeImpostor(impostor)), 1);
  const directRoot = new THREE.Group();
  directRoot.add(direct);
  for (const root of [single, directRoot]) {
    root.position.set(0.3, -0.2, 0.1);
    root.rotation.set(0.2, 0.7, -0.1);
    root.scale.set(1.2, 0.9, 1.1);
  }
  scene.add(single, directRoot);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  const target = centre.clone().applyMatrix4(directRoot.matrix.compose(directRoot.position, directRoot.quaternion, directRoot.scale));
  camera.position.copy(target).add(new THREE.Vector3(1, 0.6, 1.4).normalize().multiplyScalar(sphere * 4.2));
  camera.lookAt(target);
  const a = shoot(single, [directRoot], camera, 256, 256);
  const b = shoot(directRoot, [single], camera, 256, 256);
  const singleDiff = compare(a, b);
  result.single = singleDiff;
  images.single = sideBySide(a, b);
  checks.singleRendered = singleDiff.coverageDirect > 0.05 && singleDiff.coverageGlts > 0.05;
  checks.singleMatches = singleDiff.maxDiff <= 8 && singleDiff.meanDiff < 0.5;
  scene.remove(single, directRoot);

  // ---- instances: loadInstancesAsync(url, 500) in a grid
  const count = 500;
  const instances = await loader.loadInstancesAsync(url, count);
  const instancedMesh = find(instances) as THREE.InstancedMesh | undefined;
  checks.instancesIsImpostorMesh = instancedMesh !== undefined;
  checks.instancesCount = instances.count === count && instancedMesh?.count === count;
  const directMany = new ImpostorMesh(decodeImpostor(encodeImpostor(impostor)), count);
  const spacing = sphere * 2.2;
  const place = (offset: THREE.Vector3) => {
    for (let i = 0; i < count; i++) {
      const m = grid(i, spacing, offset);
      instances.setMatrixAt(i, m);
      directMany.setMatrixAt(i, m);
    }
    directMany.instanceMatrix.needsUpdate = true;
    directMany.computeBoundingSphere();
  };
  const gridCamera = new THREE.PerspectiveCamera(40, 4 / 3, 0.1, 500);
  const aim = (offset: THREE.Vector3) => {
    gridCamera.position.copy(offset).add(new THREE.Vector3(0, spacing * 14, spacing * 16));
    gridCamera.lookAt(offset);
  };
  place(new THREE.Vector3());
  aim(new THREE.Vector3());
  const roundTrip = instances.getMatrixAt(37, new THREE.Matrix4());
  checks.getMatrixAt = roundTrip.equals(grid(37, spacing, new THREE.Vector3()));
  scene.add(instances, directMany);
  const c = shoot(instances, [directMany], gridCamera, 512, 384);
  const d = shoot(directMany, [instances], gridCamera, 512, 384);
  const gridDiff = compare(c, d);
  result.instances = gridDiff;
  images.instances = sideBySide(c, d);
  checks.instancesRendered = gridDiff.coverageDirect > 0.05 && gridDiff.coverageGlts > 0.05;
  checks.instancesMatch = gridDiff.maxDiff <= 8 && gridDiff.meanDiff < 0.5;

  // ---- move every instance far away after the first render: the loaded mesh must not
  // keep culling against its old bounds
  const far = new THREE.Vector3(spacing * 60, 0, -spacing * 40);
  place(far);
  aim(far);
  const e = shoot(instances, [directMany], gridCamera, 512, 384);
  const f = shoot(directMany, [instances], gridCamera, 512, 384);
  const movedDiff = compare(e, f);
  result.instancesMoved = movedDiff;
  images.instancesMoved = sideBySide(e, f);
  checks.movedRendered = movedDiff.coverageDirect > 0.05 && movedDiff.coverageGlts > 0.05;
  checks.movedMatch = movedDiff.maxDiff <= 8 && movedDiff.meanDiff < 0.5;
  scene.remove(instances, directMany);

  // ---- disposal
  const memoryLoaded = { ...renderer.info.memory };
  const disposeErrors: string[] = [];
  for (const [name, dispose] of [
    ["single", () => single.dispose()],
    ["instances", () => instances.dispose()],
    ["direct", () => direct.dispose()],
    ["directMany", () => directMany.dispose()],
    ["loader", () => loader.dispose()],
  ] as const) {
    try {
      dispose();
    } catch (error) {
      disposeErrors.push(`${name}: ${(error as Error).stack ?? String(error)}`);
    }
  }
  URL.revokeObjectURL(url);
  const memoryAfter = { ...renderer.info.memory };
  result.memory = { before: memoryBefore, loaded: memoryLoaded, afterDispose: memoryAfter };
  result.afterDispose = { singleChildren: single.children.length, instancesChildren: instances.children.length };
  result.disposeErrors = disposeErrors;
  checks.disposeClean = disposeErrors.length === 0;
  checks.texturesReleased = memoryAfter.textures === memoryBefore.textures;
  checks.geometriesReleased = memoryAfter.geometries === memoryBefore.geometries;
  // The direct pair holds 2 x layers textures; the loaded pair must have held as many.
  checks.loadedUploadedTextures = memoryLoaded.textures - memoryBefore.textures === 4 * impostor.maps.length;

  result.pageErrors = [...errors];
  checks.noPageErrors = errors.length === 0;
  result.checks = checks;
  result.pass = Object.values(checks).every(Boolean);
  return { result, images };
}

function rendererName(): string {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}

declare global {
  interface Window {
    gltsCheck: { run: typeof run };
  }
}
window.gltsCheck = { run };
