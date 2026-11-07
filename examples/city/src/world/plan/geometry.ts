import { Box3, BufferAttribute, BufferGeometry, Sphere, Vector3 } from "three/webgpu";
import { cachedNumber, cachedNumbers, cachedRecord } from "../../cache.ts";

type Files = Record<string, Uint8Array>;

export function encode(geometry: BufferGeometry, name: string, files: Files): void {
  const attributes = Object.entries({ ...geometry.attributes, ...(geometry.index ? { index: geometry.index } : {}) }).map(([key, attribute]) => {
    const file = `${name}:${key}`;
    files[file] = new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength);
    return { key, file, type: attribute.array.constructor.name, size: attribute.itemSize, normalized: attribute.normalized };
  });
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const box = geometry.boundingBox,
    sphere = geometry.boundingSphere;
  if (!box || !sphere) throw new Error(`Missing plan bounds ${name}`);
  files[name] = new TextEncoder().encode(
    JSON.stringify({ attributes, box: [...box.min.toArray(), ...box.max.toArray()], sphere: [...sphere.center.toArray(), sphere.radius] }),
  );
}

export function decode(name: string, files: Files): BufferGeometry {
  const metadata = files[name];
  if (!metadata) throw new Error(`Missing plan geometry ${name}`);
  const data = cachedRecord(JSON.parse(new TextDecoder().decode(metadata)));
  if (!Array.isArray(data.attributes)) throw new Error("Invalid plan attributes");
  const geometry = new BufferGeometry();
  for (const value of data.attributes) {
    const attribute = cachedRecord(value);
    if (typeof attribute.file !== "string" || typeof attribute.key !== "string" || typeof attribute.normalized !== "boolean")
      throw new Error("Invalid plan attribute");
    const bytes = files[attribute.file];
    if (!bytes) throw new Error(`Missing plan buffer ${attribute.file}`);
    const buffer = bytes.slice().buffer;
    const array =
      attribute.type === "Float32Array"
        ? new Float32Array(buffer)
        : attribute.type === "Uint32Array"
          ? new Uint32Array(buffer)
          : attribute.type === "Uint16Array"
            ? new Uint16Array(buffer)
            : undefined;
    if (!array) throw new Error(`Unsupported plan attribute ${attribute.type}`);
    const part = new BufferAttribute(array, cachedNumber(attribute.size), attribute.normalized);
    if (attribute.key === "index") geometry.setIndex(part);
    else geometry.setAttribute(attribute.key, part);
  }
  const box = cachedNumbers(data.box, 6),
    sphere = cachedNumbers(data.sphere, 4);
  geometry.boundingBox = new Box3().setFromArray(box);
  geometry.boundingSphere = new Sphere(new Vector3().fromArray(sphere), sphere[3]);
  return geometry;
}
