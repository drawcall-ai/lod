import * as THREE from "three";
import { surface } from "./materials.ts";
import { Random } from "./random.ts";

/**
 * A clipped hedge, `length` metres along +x from the origin, about a metre high and 0.6 m
 * deep: a finely subdivided box whose surface bulges and dents a few centimetres, as
 * clipped privet does, under a leafy texture darkened toward the base. `detail: "box"`
 * makes the same hedge as a plain box, for the middle distance.
 */
export function hedge(length: number, seed: number, detail: "fine" | "box" = "fine"): THREE.Mesh {
  const r = new Random(seed);
  const height = r.range(0.95, 1.15);
  const depth = 0.6;
  const g = detail === "fine" ? new THREE.BoxGeometry(length, height, depth, Math.ceil(length * 8), 8, 5) : new THREE.BoxGeometry(length, height, depth);
  g.translate(length / 2, height / 2, 0);
  const position = g.getAttribute("position");
  const normal = g.getAttribute("normal");
  const uv = g.getAttribute("uv");
  const colors = new Float32Array(position.count * 3);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const phase = r.range(0, 100);
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    n.fromBufferAttribute(normal, i);
    // lumpy, and rounded off along the top edges
    const lump = detail === "box" ? 0 : 0.035 * Math.sin(p.x * 7.1 + phase) * Math.sin(p.y * 9.3 + p.z * 5.7) + 0.02 * Math.sin(p.x * 23 + p.y * 17 + phase);
    const round = n.y > 0.5 ? -0.04 * (Math.abs(p.z) / (depth / 2)) ** 3 : 0;
    p.addScaledVector(n, lump).y += round;
    position.setXYZ(i, p.x, p.y, p.z);
    // UVs in metres over each face
    uv.setXY(i, Math.abs(n.x) > 0.5 ? p.z : p.x, Math.abs(n.y) > 0.5 ? p.z : p.y);
    const shade = 0.55 + 0.45 * Math.min(1, p.y / height);
    colors.set([shade * 0.9, shade, shade * 0.85], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, hedgeMaterial());
  mesh.name = "hedge";
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

function hedgeMaterial(): THREE.MeshStandardMaterial {
  return surface("leafy_grass", { color: "#7f9a6a", vertexColors: true, normalScale: 2.5, roughness: 1.1 });
}
