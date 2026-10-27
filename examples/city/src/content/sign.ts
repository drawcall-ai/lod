import * as THREE from "three/webgpu";
import { box, Parts } from "./geometry.ts";
import { surface } from "./materials.ts";

const plate = { w: 0.76, h: 0.17, corner: 0.02, thick: 0.002 };

/**
 * A street-name sign: a galvanised post with a domed cap, a cast bracket on top holding an
 * aluminium blade, printed on both faces with the name in white on green reflective sheeting.
 */
export function streetSign(text: string): THREE.Group {
  const parts = new Parts();
  const galvanised = surface("metal_plate_02", { albedo: false, color: "#b9bdbd", metalness: 1, normalScale: 0.25, roughness: 0.8, weather: 0.6 });
  const height = 2.55;
  parts.add(galvanised, new THREE.CylinderGeometry(0.03, 0.03, height, 20).translate(0, height / 2, 0));
  parts.add(galvanised, new THREE.SphereGeometry(0.032, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, height, 0));
  parts.add(galvanised, new THREE.CylinderGeometry(0.036, 0.036, 0.1, 20).translate(0, height - 0.12, 0));
  parts.add(galvanised, box(0.05, 0.04, 0.012).translate(0, height + 0.01, 0));

  const y = height + 0.03 + plate.h / 2;
  parts.add(galvanised, box(plate.w * 0.9, 0.012, 0.012).translate(0, y - plate.h / 2 - 0.006, 0));
  parts.add(galvanised, box(plate.w * 0.9, 0.012, 0.012).translate(0, y + plate.h / 2 + 0.006, 0));
  const outline = roundedRect(plate.w, plate.h, plate.corner);
  const blade = new THREE.ExtrudeGeometry(outline, { depth: plate.thick, bevelEnabled: false, curveSegments: 4 });
  parts.add(galvanised, blade.translate(0, y, -plate.thick / 2));
  const face = faceMaterial(text);
  for (const side of [0, 1]) {
    const g = new THREE.ShapeGeometry(outline, 4);
    const uv = g.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / plate.w + 0.5, uv.getY(i) / plate.h + 0.5);
    g.translate(0, 0, plate.thick / 2 + 0.0003)
      .rotateY(side * Math.PI)
      .translate(0, y, 0);
    parts.add(face, g);
  }
  return parts.build("sign");
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return s;
}

/** Reflective sheeting printed with a border and the street name, plus faint grime. */
function faceMaterial(text: string): THREE.MeshStandardMaterial {
  const px = 1600;
  const w = px;
  const h = Math.round((px * plate.h) / plate.w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("2d canvas unavailable");
  g.fillStyle = "#0f6b3d";
  g.fillRect(0, 0, w, h);
  const inset = h * 0.07;
  g.strokeStyle = "#f2f2ec";
  g.lineWidth = h * 0.035;
  g.beginPath();
  g.roundRect(inset, inset, w - 2 * inset, h - 2 * inset, h * 0.08);
  g.stroke();
  g.fillStyle = "#f4f4ee";
  g.font = `600 ${Math.round(h * 0.56)}px "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text.toUpperCase(), w / 2, h * 0.53, w - 6 * inset);
  const dirt = g.createLinearGradient(0, 0, 0, h);
  dirt.addColorStop(0, "rgba(60,50,30,0.0)");
  dirt.addColorStop(1, "rgba(60,50,30,0.12)");
  g.fillStyle = dirt;
  g.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ name: `sign-${text}`, map: t, roughness: 0.38, metalness: 0 });
}
