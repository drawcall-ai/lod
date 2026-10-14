import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeImpostor } from "@drawcall/impostor";
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "impostor-cli-"));
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });

/** A unit cube with one material: red, or a green texture in a Draco-compressed, separate-file .gltf. */
async function cube(path: string, textured = false): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1]);
  const faces = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  const position = document.createAccessor().setType("VEC3").setArray(new Float32Array(corners.flat())).setBuffer(buffer);
  const indices = document.createAccessor().setType("SCALAR").setArray(new Uint16Array(faces)).setBuffer(buffer);
  const material = document.createMaterial().setBaseColorFactor([1, 0, 0, 1]);
  const primitive = document.createPrimitive().setAttribute("POSITION", position).setIndices(indices).setMaterial(material);
  document.createScene().addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)));
  if (!textured) return void (await new NodeIO().write(path, document));

  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 200, b: 0 } } }).png().toBuffer();
  material.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(document.createTexture().setMimeType("image/png").setImage(png).setURI("green.png"));
  const uv = document.createAccessor().setType("VEC2").setArray(new Float32Array(corners.flatMap(([x, y]) => [x ?? 0, y ?? 0]))).setBuffer(buffer);
  primitive.setAttribute("TEXCOORD_0", uv);
  document.createExtension(KHRDracoMeshCompression).setRequired(true);
  await new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({ "draco3d.encoder": await draco3d.createEncoderModule() })
    .write(path, document);
}

/** Mean colour of the covered texels in a .glts file's base map. */
function baseColour(path: string): [number, number, number] {
  const data = /decodeImpostor\("([^"]+)"\)/.exec(readFileSync(path, "utf8"))?.[1];
  if (!data) throw new Error(`${path} embeds no impostor`);
  const [base] = decodeImpostor(data).layers;
  if (!base) throw new Error("no base layer");
  const sum = [0, 0, 0];
  let covered = 0;
  for (let i = 0; i < base.length; i += 4) {
    if (base[i + 3] !== 255) continue;
    covered++;
    for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (base[i + c] ?? 0);
  }
  const [r = 0, g = 0, b = 0] = sum.map((s) => s / covered);
  return [r, g, b];
}

beforeAll(async () => {
  await cube(join(dir, "cube.glb"));
  await cube(join(dir, "green.gltf"), true);
  writeFileSync(join(dir, "broken.glb"), "not a glb");
});

afterAll(() => rmSync(dir, { recursive: true }));

describe("impostor", () => {
  it("bakes each input next to it, or to --out", () => {
    const result = run("cube.glb", "--layout", "hemi", "--resolution", "64");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/cube\.glb → cube\.impostor\.glts\s+hemi .* 3 maps/);
    const [r, g] = baseColour(join(dir, "cube.impostor.glts"));
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(10);

    expect(run("cube.glb", "--out", "out/x.glts").status).toBe(0);
    expect(existsSync(join(dir, "out/x.glts"))).toBe(true);
  });

  it("reads textures and Draco from a separate-file .gltf", () => {
    const result = run("green.gltf", "--resolution", "64");
    expect(result.stderr).toBe("");
    const [r, g] = baseColour(join(dir, "green.impostor.glts"));
    expect(g).toBeGreaterThan(150);
    expect(r).toBeLessThan(10);
  });

  it("reports a broken file briefly, bakes the rest and exits 1", () => {
    const result = run("broken.glb", "cube.glb");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^broken\.glb: cannot read it: .*\n$/);
    expect(result.stdout).toContain("cube.glb →");
  });

  it.each([
    [["--layout", "side", "cube.glb"], /--layout must be/],
    [["--resolution", "100", "cube.glb"], /--resolution must be/],
    [["--resolution", "0x40", "cube.glb"], /--resolution must be/],
    [["--out", "out", "cube.glb"], /--out must be a \.glts file/],
    [["--out", "x.glts", "a.glb", "b.glb"], /--out needs exactly one input/],
    [["scene.glts"], /only \.glb and \.gltf/],
    [["--frames", "8", "cube.glb"], /Unknown option '--frames'/],
    [[], /no input files/],
  ])("rejects %j", (args, message) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
  });

  it("prints help", () => {
    const result = run("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: impostor <input...>");
  });
});
