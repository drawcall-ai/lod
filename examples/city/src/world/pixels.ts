import { gunzip } from "fflate";

export async function encode(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes.slice().buffer]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

/** Transfer the owned compressed buffer so decoding and joining large pixel arrays stay off the main thread. */
export function decode(bytes: Uint8Array, size: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid pixel array size");
  return new Promise((resolve, reject) => {
    gunzip(bytes, { consume: true }, (error, data) => {
      if (error) return reject(error);
      if (data.length !== size) return reject(new Error("Texture dimensions do not match its pixels"));
      resolve(data);
    });
  });
}
