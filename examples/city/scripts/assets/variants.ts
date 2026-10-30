import { createHash } from "node:crypto";
import { BufferUtils, type Document, Format, GLB_BUFFER, ImageUtils, type NodeIO } from "@gltf-transform/core";
import { clearNodeParent, cloneDocument, flatten, getBounds, join, prune } from "@gltf-transform/functions";

/** Select authored parts, retain their world placement, and centre the variant on x/z. */
export async function variant(source: Document, name: string, names: readonly string[], batch: boolean): Promise<Document> {
  const doc = cloneDocument(source);
  const root = doc.getRoot();
  const selected = names.map((name) => {
    const matches = root.listNodes().filter((node) => node.getName() === name);
    const node = matches[0];
    if (matches.length !== 1 || !node) throw new Error(`Expected one node named ${name}, found ${matches.length}`);
    return clearNodeParent(node);
  });
  for (const scene of root.listScenes()) scene.dispose();
  const scene = doc.createScene(name);
  root.setDefaultScene(scene);
  for (const node of selected) scene.addChild(node);
  // Retain encoded images, including constant-colour maps: pruning must not decode them.
  await doc.transform(prune({ keepSolidTextures: true }));
  const { min, max } = getBounds(scene);
  for (const node of scene.listChildren()) {
    const [x, y, z] = node.getTranslation();
    node.setTranslation([x - (min[0] + max[0]) / 2, y, z - (min[2] + max[2]) / 2]);
  }
  if (batch)
    await doc.transform(
      flatten(),
      join({
        filter: (node) =>
          node
            .getMesh()
            ?.listPrimitives()
            .every((primitive) => primitive.getMaterial()?.getAlphaMode() !== "BLEND") ?? false,
      }),
    );
  return doc;
}

/** Write one geometry payload and per-model shared image files, preserving their encoded bytes. */
export async function writeVariant(
  io: NodeIO,
  source: Document,
): Promise<{
  binary: Uint8Array;
  images: ReadonlyMap<string, Uint8Array>;
}> {
  const doc = cloneDocument(source);
  const images = new Map<string, Uint8Array>();
  const uris = doc
    .getRoot()
    .listTextures()
    .map((texture) => {
      const image = texture.getImage();
      if (!image) throw new Error(`Missing image data: ${texture.getName()}`);
      const digest = createHash("sha256").update(image).digest("hex");
      const uri = `images/${digest}.${ImageUtils.mimeTypeToExtension(texture.getMimeType())}`;
      images.set(uri, image);
      texture.setImage(null);
      return uri;
    });
  const { json, resources } = await io.writeJSON(doc, { format: Format.GLB });
  for (const [index, image] of (json.images ?? []).entries()) {
    const uri = uris[index];
    if (!uri) throw new Error(`Missing external image URI: ${index}`);
    image.uri = uri;
  }
  const jsonData = BufferUtils.pad(BufferUtils.encodeText(JSON.stringify(json)), 0x20);
  const binData = BufferUtils.pad(resources[GLB_BUFFER] ?? new Uint8Array(), 0);
  // glTF Transform embeds images in writeBinary(); wrap its geometry-only JSON and BIN chunks instead.
  const header = new Uint32Array([0x46546c67, 2, 12 + 8 + jsonData.byteLength + 8 + binData.byteLength]);
  const binary = BufferUtils.concat([
    BufferUtils.toView(header),
    BufferUtils.toView(new Uint32Array([jsonData.byteLength, 0x4e4f534a])),
    jsonData,
    BufferUtils.toView(new Uint32Array([binData.byteLength, 0x004e4942])),
    binData,
  ]);
  return { binary, images };
}
