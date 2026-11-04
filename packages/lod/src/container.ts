// The file layout the codecs share: a JSON header, then files that each start at a multiple of 8 bytes so decode can
// view them in place, all gzip-compressed. Browsers check the gzip trailer's CRC when they inflate, so a corrupt file
// fails to decode instead of decoding to wrong values.

export interface Contents {
  header: unknown;
  files: Uint8Array[];
}

/** `header` and `files` in one gzip stream. */
export async function pack(header: unknown, files: readonly Uint8Array[]): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify({ header, files: files.map((file) => file.byteLength) }));
  const parts: Uint8Array[] = [new Uint8Array(new Uint32Array([json.length]).buffer), json];
  let length = 4 + json.length;
  for (const file of files) {
    const padding = align(length) - length;
    parts.push(new Uint8Array(padding), file);
    length += padding + file.byteLength;
  }
  return transform(new Blob(parts.map(own)), new CompressionStream("gzip"));
}

/** What `pack` stored; `fail` reports why `bytes` is not such a file. */
export async function unpack(bytes: Uint8Array, fail: (why: string, cause?: unknown) => never): Promise<Contents> {
  let raw: Uint8Array;
  try {
    raw = await transform(new Blob([own(bytes)]), new DecompressionStream("gzip"));
  } catch (error) {
    fail("corrupt or truncated", error);
  }
  if (raw.length < 4) fail("missing header");
  const end = 4 + new DataView(raw.buffer).getUint32(0, true);
  if (end > raw.length) fail("invalid header length");
  let contents: unknown;
  try {
    contents = JSON.parse(new TextDecoder().decode(raw.subarray(4, end)));
  } catch (error) {
    fail("header is not JSON", error);
  }
  if (typeof contents !== "object" || contents === null || !("files" in contents) || !Array.isArray(contents.files)) fail("missing file table");
  let offset = end;
  const files = contents.files.map((length: unknown) => {
    if (!Number.isSafeInteger(length) || typeof length !== "number" || length < 0) fail("invalid file length");
    offset = align(offset);
    if (offset + length > raw.length) fail("truncated file");
    const file = raw.subarray(offset, offset + length);
    offset += length;
    return file;
  });
  if (offset !== raw.length) fail("trailing bytes");
  return { header: "header" in contents ? contents.header : undefined, files };
}

/** The next multiple of 8, the largest element size. */
const align = (offset: number): number => Math.ceil(offset / 8) * 8;

/** `bytes` on a plain ArrayBuffer, as Blob takes it; copied only when it is a view of a shared buffer. */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice();
}

async function transform(input: Blob, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(input.stream().pipeThrough(stream)).arrayBuffer());
}
