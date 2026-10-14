import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { bakedLod, lodReady, simplifyLod, simplifyStats } from "./lod";

// Standalone page (lod.html): mesh LODs next to their originals. Does not import
// @drawcall/impostor. Driven by scripts/lod-check.ts through window.lodCheck.run().

const defaultRatios = [0.25, 0.05, 0.01];
const views: Array<{ azimuth: number; elevation: number; zoom?: number }> = [
  { azimuth: 35, elevation: 12 },
  { azimuth: 160, elevation: 30 },
  { azimuth: 265, elevation: 65 },
  { azimuth: 20, elevation: 8, zoom: 5 }, // close-up: texture and normal detail
];
const TILE = 300;

const gltf = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath("/draco/"));
const model = (file: string) => async () => (await gltf.loadAsync(`/models/${file}`)).scene;
const subjects: Array<{ name: string; load: () => Promise<THREE.Object3D> }> = [
  { name: "tree", load: model("CommonTree_3.glb") },
  { name: "pine", load: model("Pine_2.glb") },
  { name: "rock", load: model("Rock_Medium_1.glb") },
  { name: "fence", load: model("quaternius-platformer-fence.glb") },
  { name: "wall", load: async () => wall() },
];

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NeutralToneMapping;
document.body.append(renderer.domElement);
const pmrem = new THREE.PMREMGenerator(renderer);
const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

function triangles(object: THREE.Object3D) {
  let n = 0;
  object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    n += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  });
  return n;
}

function textureBytes(object: THREE.Object3D) {
  const seen = new Set<THREE.Texture>();
  object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material])
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) seen.add(v);
  });
  let bytes = 0;
  for (const t of seen) {
    const img = t.image as { width: number; height: number };
    bytes += img.width * img.height * 4 * (t.generateMipmaps ? 4 / 3 : 1);
  }
  return Math.round(bytes);
}

function sceneFor(object: THREE.Object3D) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x5a6470);
  scene.environment = environment;
  scene.environmentIntensity = 0.6;
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 5, 2);
  scene.add(sun, object);
  return scene;
}

type Mode = "lit" | "albedo" | "normal";

/** Copy of `object` rendered as unlit base colour or as view-space normals, for checking a bake. */
function debugView(object: THREE.Object3D, mode: Mode): THREE.Object3D {
  if (mode === "lit") return object;
  const copy = object.clone(true);
  copy.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const convert = (x: THREE.Material) => {
      const s = x as THREE.MeshStandardMaterial;
      const common = { side: s.side, alphaTest: s.alphaTest };
      if (mode === "albedo") return new THREE.MeshBasicMaterial({ ...common, map: s.map, color: s.color, vertexColors: s.vertexColors });
      // Normal view: the cut-out still needs the colour map's alpha, so draw normals via a
      // MeshNormalMaterial and discard by alpha in onBeforeCompile.
      const n = new THREE.MeshNormalMaterial({ side: s.side, normalMap: s.normalMap, normalMapType: s.normalMapType, normalScale: s.normalScale });
      if (s.map && s.alphaTest > 0) {
        n.onBeforeCompile = (shader) => {
          shader.uniforms.alphaSource = { value: s.map };
          shader.vertexShader = shader.vertexShader.replace("void main() {", "varying vec2 vAlphaUv;\nvoid main() {\nvAlphaUv = (" + JSON.stringify(Array.from(s.map!.matrix.elements)).replace("[", "mat3(").replace("]", ")") + " * vec3(uv, 1.0)).xy;");
          shader.fragmentShader = shader.fragmentShader.replace("void main() {", "uniform sampler2D alphaSource;\nvarying vec2 vAlphaUv;\nvoid main() {\nif (texture2D(alphaSource, vAlphaUv).a < " + s.alphaTest.toFixed(3) + ") discard;");
        };
      }
      return n;
    };
    m.material = Array.isArray(m.material) ? m.material.map(convert) : convert(m.material);
  });
  return copy;
}

async function sheet(name: string, columns: Array<{ label: string; object: THREE.Object3D }>, sphere: THREE.Sphere) {
  const w = columns.length * TILE;
  const h = views.length * TILE;
  renderer.setSize(w, h, false);
  renderer.setScissorTest(true);
  const camera = new THREE.PerspectiveCamera(30, 1, sphere.radius * 0.05, sphere.radius * 20);
  const distance = sphere.radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.02;
  columns.forEach((column, c) => {
    const scene = sceneFor(column.object);
    views.forEach((view, r) => {
      const az = THREE.MathUtils.degToRad(view.azimuth);
      const el = THREE.MathUtils.degToRad(view.elevation);
      camera.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(distance / (view.zoom ?? 1)).add(sphere.center);
      camera.lookAt(sphere.center);
      // WebGL viewport y is bottom-up.
      const y = h - (r + 1) * TILE;
      renderer.setViewport(c * TILE, y, TILE, TILE);
      renderer.setScissor(c * TILE, y, TILE, TILE);
      renderer.render(scene, camera);
    });
    scene.remove(column.object);
  });
  renderer.setScissorTest(false);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h + 22;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, w, 22);
  ctx.drawImage(renderer.domElement, 0, 22);
  ctx.fillStyle = "#eee";
  ctx.font = "14px system-ui, sans-serif";
  columns.forEach((column, c) => ctx.fillText(`${name} ${column.label}`, c * TILE + 6, 16));
  ctx.strokeStyle = "#111";
  for (let c = 1; c < columns.length; c++) ctx.strokeRect(c * TILE, 22, 0, h);
  return canvas.toDataURL("image/png");
}

/** Debug view of a baked texture (rows bottom-up, i.e. v up). */
function textureImage(texture: THREE.DataTexture, opaque = false) {
  const { width, height, data } = texture.image as { width: number; height: number; data: Uint8Array };
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const pixels = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    const row = data.subarray((height - 1 - y) * width * 4, (height - y) * width * 4);
    pixels.data.set(row, y * width * 4);
  }
  if (opaque) for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL("image/png");
}

async function run(only?: string[], ratios = defaultRatios, modes: Mode[] = ["lit"]) {
  await lodReady;
  const results: Record<string, unknown>[] = [];
  const images: Record<string, string> = {};
  for (const subject of subjects) {
    if (only && !only.includes(subject.name)) continue;
    const original = await subject.load();
    const box = new THREE.Box3().setFromObject(original);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const columns = [{ label: `original ${triangles(original)}`, object: original }];
    const simple: Record<string, unknown>[] = [];
    const baked: Record<string, unknown>[] = [];
    for (const ratio of ratios) {
      Object.assign(simplifyStats, { strict: 0, permissive: 0, sloppy: 0 });
      const t0 = performance.now();
      const lod = simplifyLod(original, ratio);
      const ms = performance.now() - t0;
      simple.push({ ratio, triangles: triangles(lod), ms: Math.round(ms), textureBytes: textureBytes(lod), methods: { ...simplifyStats } });
      columns.push({ label: `simple ${ratio} ${triangles(lod)}`, object: lod });
    }
    for (const ratio of ratios) {
      const lod = await bakedLod(original, ratio);
      const info = lod.userData.lod as Record<string, number>;
      baked.push({ ratio, ...Object.fromEntries(Object.entries(info).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) });
      columns.push({ label: `baked ${ratio} ${info.triangles}`, object: lod });
      if (ratio === ratios[1]) {
        const mesh = lod.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
        images[`${subject.name}-baked-${ratio}-color`] = textureImage(mesh.material.map as THREE.DataTexture);
        images[`${subject.name}-baked-${ratio}-normal`] = textureImage(mesh.material.normalMap as THREE.DataTexture);
        images[`${subject.name}-baked-${ratio}-orm`] = textureImage(mesh.material.roughnessMap as THREE.DataTexture);
      }
    }
    for (const mode of modes)
      images[`${subject.name}-${mode === "lit" ? "sheet" : mode}`] = await sheet(subject.name, columns.map((c) => ({ label: c.label, object: debugView(c.object, mode) })), sphere);
    results.push({ name: subject.name, triangles: triangles(original), textureBytes: textureBytes(original), simple, baked });
  }
  return { renderer: rendererName(), results, images };
}

function rendererName() {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
}

// --- procedural brick wall ------------------------------------------------------------

function wall(): THREE.Object3D {
  const W = 512;
  const H = 256;
  const rows = 4;
  const perRow = 4;
  const mortar = 6;
  const color = document.createElement("canvas");
  color.width = W;
  color.height = H;
  const ctx = color.getContext("2d")!;
  ctx.fillStyle = "#b9b2a6";
  ctx.fillRect(0, 0, W, H);
  const height = new Float32Array(W * H);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const bh = H / rows;
  const bw = W / perRow;
  for (let r = 0; r < rows; r++)
    for (let b = -1; b < perRow; b++) {
      const x0 = b * bw + (r % 2 ? bw / 2 : 0) + mortar / 2;
      const y0 = r * bh + mortar / 2;
      const shade = 0.75 + rand() * 0.3;
      ctx.fillStyle = `rgb(${Math.round(160 * shade)}, ${Math.round(70 * shade)}, ${Math.round(50 * shade)})`;
      ctx.fillRect(x0, y0, bw - mortar, bh - mortar);
      // Bevelled brick: height rises over `bevel` pixels from the mortar.
      const bevel = 5;
      for (let y = Math.ceil(y0); y < y0 + bh - mortar; y++)
        for (let x = Math.ceil(x0); x < x0 + bw - mortar; x++) {
          if (x < 0 || x >= W) continue;
          const edge = Math.min(x - x0, x0 + bw - mortar - x, y - y0, y0 + bh - mortar - y);
          height[y * W + x] = Math.min(1, (edge + 0.5) / bevel);
        }
    }
  // Tangent-space normal map from the height field. Canvas textures upload with flipY, so
  // image +y is -v: n = normalize(-dh/du, -dh/dv, 1/strength) with dh/dv = -dh/dy.
  const normal = document.createElement("canvas");
  normal.width = W;
  normal.height = H;
  const nctx = normal.getContext("2d")!;
  const pixels = nctx.createImageData(W, H);
  const h = (x: number, y: number) => height[((y + H) % H) * W + ((x + W) % W)]!;
  const strength = 3;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 0.5 * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * 0.5 * strength;
      const n = new THREE.Vector3(-dx, dy, 1).normalize();
      const o = (y * W + x) * 4;
      pixels.data[o] = (n.x * 0.5 + 0.5) * 255;
      pixels.data[o + 1] = (n.y * 0.5 + 0.5) * 255;
      pixels.data[o + 2] = (n.z * 0.5 + 0.5) * 255;
      pixels.data[o + 3] = 255;
    }
  nctx.putImageData(pixels, 0, 0);
  const map = new THREE.CanvasTexture(color);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = new THREE.CanvasTexture(normal);
  for (const t of [map, normalMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(10, 4); // one tile = 2 m x 1 m on the long faces
    t.anisotropy = 8;
  }
  // Segmented so the simplifier has something to remove (a 12-triangle box would not change).
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(20, 4, 1, 40, 8, 2),
    new THREE.MeshStandardMaterial({ map, normalMap, roughness: 0.85, metalness: 0 }),
  );
  mesh.position.y = 2;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

declare global {
  interface Window {
    lodCheck: { run: typeof run };
  }
}
window.lodCheck = { run };
