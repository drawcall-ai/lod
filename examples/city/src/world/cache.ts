import * as THREE from "three";
import { bakeImpostor, decodeImpostor, encodeImpostor, type Impostor } from "@drawcall/lod";

/**
 * Impostors saved across page loads in the browser's Cache Storage, saved with
 * `encodeImpostor` and read with `decodeImpostor`. The key is a fingerprint of what the
 * bake sees: every vertex, index and colour of the source, its materials' settings and
 * the pixels of their textures, and the bake options. Change the content and the key
 * changes with it; nothing is ever read back stale. The key does not see the baker:
 * when the package bakes differently, name a new store (older ones are deleted).
 */
const STORE = "city-impostors-v4";

export async function cachedImpostor(source: THREE.Object3D, options: { resolution?: number; frames?: number; maxPixels?: number }): Promise<Impostor> {
  const key = `/${fingerprint(source)}-${options.resolution ?? "d"}-${options.frames ?? "d"}-${options.maxPixels ?? "d"}.ktx2`;
  const store = await openStore();
  const hit = await store.match(key);
  if (hit) return decodeImpostor(await hit.arrayBuffer());
  const impostor = await bakeImpostor(source, { layout: "hemi", ...options });
  await store.put(key, new Response(new Uint8Array(encodeImpostor(impostor))));
  return impostor;
}

let opened: Promise<Cache> | null = null;

/** The store, once older stores are gone. */
function openStore(): Promise<Cache> {
  opened ??= (async () => {
    for (const name of await caches.keys()) if (name.startsWith("city-impostors-") && name !== STORE) await caches.delete(name);
    return caches.open(STORE);
  })();
  return opened;
}

/** FNV-1a over everything a bake reads from `root`, as hex. */
function fingerprint(root: THREE.Object3D): string {
  let h = 0x811c9dc5;
  const bytes = (data: ArrayBufferView) => {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < view.length; i++) h = Math.imul(h ^ (view[i] ?? 0), 0x01000193);
  };
  const text = (s: string) => bytes(new TextEncoder().encode(s));
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    if (!node.visible) return;
    text(node.type);
    bytes(new Float32Array(node.matrix.elements));
    if (!(node instanceof THREE.Mesh)) return;
    const g: THREE.BufferGeometry = node.geometry;
    for (const name of Object.keys(g.attributes).sort()) {
      const attribute = g.getAttribute(name);
      if (attribute instanceof THREE.BufferAttribute) bytes(attribute.array);
    }
    if (g.index) bytes(g.index.array);
    for (const m of [node.material].flat()) settings(m);
  });
  function settings(m: THREE.Material) {
    for (const [name, value] of Object.entries(m)) {
      // identity and edit counters differ from load to load without changing the look
      if (name === "uuid" || name === "version") continue;
      if (value instanceof THREE.Texture) texture(name, value);
      else if (value instanceof THREE.Color) text(`${name}:${value.getHexString()}`);
      else if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") text(`${name}:${value}`);
    }
  }
  function texture(name: string, t: THREE.Texture) {
    text(`${name}:${t.repeat.x},${t.repeat.y},${t.colorSpace}`);
    const image: unknown = t.image;
    if (image instanceof HTMLImageElement) return text(image.src);
    // decoded from a fetched model, which is a fixed file: its name and size identify it
    if (image instanceof ImageBitmap) return text(`${t.name}:${image.width}x${image.height}`);
    if (image instanceof HTMLCanvasElement) {
      const g = image.getContext("2d");
      if (!g) throw new Error("cache: a canvas texture without a 2d context");
      return bytes(g.getImageData(0, 0, image.width, image.height).data);
    }
    if (t instanceof THREE.DataTexture && ArrayBuffer.isView(t.image.data)) return bytes(t.image.data);
    throw new Error(`cache: cannot fingerprint the ${name} texture "${t.name}"`);
  }
  return (h >>> 0).toString(16);
}
