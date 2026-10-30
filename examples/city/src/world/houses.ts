import { InstancedLod, Lod, type LodRequest } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import { HOUSE_VARIANTS } from "../../public/content/house/params.ts";
import { Random } from "../../public/content/random.ts";
import { loader } from "../loading.ts";
import { place } from "./place.ts";
import type { Plan } from "./plan.ts";

const WARMER = new THREE.Color(1.05, 0.98, 0.88);

export async function houses(plan: Plan): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "houses";
  const homes = Array.from({ length: HOUSE_VARIANTS }, async (_, variant) => {
    const spots = plan.houses.filter((house) => house.variant === variant).map((house) => house.spot);
    if (!spots.length) return [];
    const levels = await loader.loadAsync(
      request(`/houses/house.glts?variant=${variant}`, { textureSize: 512, maxPixels: 350 }, { resolution: 64, maxPixels: 90 }),
    );
    const lod = new InstancedLod(levels, spots.length);
    lod.name = `house ${variant}`;
    const color = new THREE.Color();
    spots.forEach((at, index) => {
      place(lod, index, at);
      const random = new Random(index * 31 + variant);
      lod.setColorAt(index, color.setRGB(1, 1, 1).multiplyScalar(random.range(0.88, 1.04)).lerp(WARMER, random.range(0, 0.4)));
    });
    return [lod];
  });
  const [variants, levels] = await Promise.all([
    Promise.all(homes),
    loader.loadAsync(request("/houses/church.glts", { textureSize: 1024, maxPixels: 560 }, { resolution: 128, maxPixels: 144 })),
  ]);
  const building = new Lod(levels);
  building.name = "church";
  building.position.set(plan.church.x, plan.church.y, plan.church.z);
  building.rotation.y = plan.church.angle;
  root.add(...variants.flat(), building);
  return root;
}

/** A building's ladder: the source, its windows baked onto the authored low shell, then an impostor; derived levels cast and receive shadows. */
function request(url: string, baked: { textureSize: number; maxPixels: number }, impostor: { resolution: number; maxPixels: number }): LodRequest {
  return {
    url,
    levels: [
      { type: "baked", low: withPart(url, "low"), interior: withPart(url, "interior"), ...baked },
      { type: "impostor", layout: "hemi", frames: 8, ...impostor },
    ],
    onLevel: (object, index) => {
      if (index > 0) object.castShadow = object.receiveShadow = true;
    },
  };
}

function withPart(url: string, part: "low" | "interior"): string {
  return `${url}${url.includes("?") ? "&" : "?"}part=${part}`;
}
