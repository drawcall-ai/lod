export async function encode(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes.slice().buffer]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

/** Decode through native gzip streams without creating a worker for each texture. */
export async function decode(bytes: Uint8Array, size: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid pixel array size");
  const data = new Uint8Array(await new Response(new Blob([bytes.slice().buffer]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  if (data.length !== size) throw new Error("Texture dimensions do not match its pixels");
  return data;
}
