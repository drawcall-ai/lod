import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTSLoader } from "@drawcall/glts";
import type { BakeOptions } from "@drawcall/impostor";

// Test subjects, each chosen to break a specific part of the technique.

export interface Subject {
  name: string;
  why: string;
  bake?: BakeOptions;
  load(): Promise<THREE.Object3D>;
}

const gltf = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath("/draco/"));
const model = (file: string) => async () => (await gltf.loadAsync(`/models/${file}`)).scene;
// Realistic cases (scripts/cases.ts): each is a .glts file, loaded as an app would.
const glts = new GLTSLoader(new THREE.LoadingManager(), { cdnURL: new URL("/esm/", location.origin).href });
const realistic = (id: string) => async () => glts.loadAsync(`/cases/${id}/${id}.glts`);
const CASES = ["oak", "ash", "spruce", "quiver", "shrub", "rooibos", "fern02", "boulder", "rock07", "cliffstone", "moonrock", "car", "barrel", "streetlamp", "grass", "mansion"];

export const subjects: Subject[] = [
  { name: "tree", why: "alpha-tested foliage, the main use case", load: model("CommonTree_3.glb") },
  { name: "pine", why: "dense needle cards, dark interior", load: model("Pine_2.glb") },
  { name: "dead", why: "thin branches: sub-pixel detail and mip erosion", load: model("DeadTree_2.glb") },
  { name: "twisted", why: "asymmetric silhouette: wrong frame choice is obvious", load: model("TwistedTree_2.glb") },
  { name: "bush", why: "small, wide and low: horizon views dominate", load: model("Bush_Common_Flowers.glb") },
  { name: "fern", why: "flat fronds seen edge-on", load: model("Fern_1.glb") },
  { name: "rock", why: "solid, smooth shading: normals and depth must be right", load: model("Rock_Medium_1.glb") },
  { name: "fence", why: "thin flat object: degenerate edge-on frames", load: model("quaternius-platformer-fence.glb") },
  { name: "sign", why: "text-like detail and an off-centre pivot", load: model("quaternius-platformer-sign-2.glb") },
  { name: "knot", why: "deep self-occlusion: ghosting and parallax", load: async () => knot() },
  { name: "pbr", why: "metal/rough grid under IBL: ORM correctness", load: async () => pbrGrid() },
  { name: "lamp", why: "emissive bulb on a tall thin pole, pivot at the base", load: async () => lamp() },
  { name: "asteroid", why: "full-sphere layout, seen from below", bake: { layout: "full" }, load: async () => asteroid() },
  { name: "wall", why: "20:4:1 brick wall: the non-uniform worst case", load: async () => wall() },
  { name: "log", why: "a 10:1 log lying down: elongated", load: async () => log() },
  ...CASES.map((id) => ({ name: id, why: "realistic case (scripts/cases.ts)", load: realistic(id) })),
];

function knot(): THREE.Object3D {
  const mesh = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1, 0.32, 256, 32, 2, 3),
    new THREE.MeshStandardMaterial({ color: 0xd08040, roughness: 0.35, metalness: 0.2 }),
  );
  return mesh;
}

function pbrGrid(): THREE.Object3D {
  const group = new THREE.Group();
  const geometry = new THREE.SphereGeometry(0.42, 48, 24);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: 0xc8c8c8, metalness: i / 3, roughness: 0.08 + (j / 3) * 0.9 }),
      );
      mesh.position.set((i - 1.5) * 1, (j - 1.5) * 1 + 2, 0);
      group.add(mesh);
    }
  return group;
}

function lamp(): THREE.Object3D {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x303438, metalness: 0.9, roughness: 0.4 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 4, 16), metal);
  pole.position.y = 2;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.06, 0.06), metal);
  arm.position.set(0.37, 3.95, 0);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 24, 12),
    new THREE.MeshStandardMaterial({ color: 0xffeecc, emissive: 0xffb050, emissiveIntensity: 1 }),
  );
  bulb.position.set(0.72, 3.8, 0);
  group.add(pole, arm, bulb);
  return group;
}

function asteroid(): THREE.Object3D {
  const geometry = new THREE.IcosahedronGeometry(1, 5);
  const p = geometry.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = Math.sin(v.x * 3.1) * Math.cos(v.y * 2.7) * Math.sin(v.z * 3.7 + 1) * 0.25 + Math.sin(v.x * 9 + v.y * 7) * 0.05;
    v.multiplyScalar(1 + n);
    v.y *= 0.7;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8a7f74, roughness: 0.9, flatShading: true }));
}

/** A brick texture drawn on a canvas, tiled along the wall. */
function bricks(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#c9c2b4";
  ctx.fillRect(0, 0, 256, 256);
  for (let row = 0; row < 8; row++)
    for (let col = -1; col < 5; col++) {
      const shade = 150 + ((row * 7 + col * 13) % 5) * 12;
      ctx.fillStyle = `rgb(${shade}, ${shade * 0.45}, ${shade * 0.32})`;
      ctx.fillRect(col * 64 + (row % 2) * 32 + 3, row * 32 + 3, 58, 26);
    }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function wall(): THREE.Object3D {
  const geometry = new THREE.BoxGeometry(20, 4, 1);
  const map = bricks();
  map.repeat.set(5, 1);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map, roughness: 0.9 }));
  mesh.position.y = 2;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

function log(): THREE.Object3D {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.34, 6, 24, 1),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.85 }),
  );
  mesh.rotation.z = Math.PI / 2;
  mesh.position.y = 0.34;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

// Lookups go by name: a realistic case named like a low-poly subject would silently load the wrong asset.
const seen = new Set<string>();
for (const s of subjects) {
  if (seen.has(s.name)) throw new Error(`duplicate subject name "${s.name}"`);
  seen.add(s.name);
}
