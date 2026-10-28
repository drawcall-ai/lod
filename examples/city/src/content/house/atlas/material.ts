import { MeshStandardNodeMaterial, Vector4, type Texture } from "three/webgpu";
import { attribute, normalMap, normalView, sharedUniformGroup, texture, uint, uniformArray, uv, varying, vec4 } from "three/tsl";
import { weatherColor, weatherStrength, type Surface } from "../../materials.ts";
import { TextureArray } from "./textures.ts";

/** One immutable material table and set of texture layers shared by all houses. */
export class HouseAtlas {
  readonly inside: MeshStandardNodeMaterial;
  readonly outside: MeshStandardNodeMaterial;
  private readonly ids = new Map<Surface, number>();
  private readonly arrays: TextureArray[] = [];

  constructor(surfaces: readonly Surface[], shared?: readonly TextureArray[]) {
    const rows = [...new Set(surfaces)];
    for (const material of rows) validate(material);
    try {
      const array = (maps: (Texture | null)[], name: string) => {
        const made = shared?.[this.arrays.length] ?? new TextureArray(maps, name);
        this.arrays.push(made);
        return made;
      };
      const base = array(
        rows.map((m) => m.map),
        "house albedo",
      );
      const normal = array(
        rows.map((m) => m.normalMap),
        "house normals",
      );
      const arm = array(
        rows.map((m) => m.roughnessMap),
        "house ARM",
      );
      const data: Vector4[] = [];
      rows.forEach((material, index) => {
        this.ids.set(material, index);
        const map = material.map ?? material.normalMap ?? material.roughnessMap;
        data.push(
          new Vector4(material.color.r, material.color.g, material.color.b, weatherStrength(material)),
          new Vector4(material.roughness, material.metalness, material.normalScale.x, material.normalScale.y),
          new Vector4(base.layer(material.map), normal.layer(material.normalMap), arm.layer(material.roughnessMap), Number(material.metalnessMap !== null)),
          new Vector4(map?.repeat.x ?? 1, map?.repeat.y ?? 1, 0, 0),
        );
      });
      const table = uniformArray<"vec4">(data, "vec4").setGroup(sharedUniformGroup("houseMaterials"));
      // setup() fills the buffer once; these material values never change.
      table.updateType = "none";
      const id = uint(attribute<"float">("houseMaterial", "float")).mul(uint(4));
      const color = varying(table.element(id)).setInterpolation("flat");
      const parameters = varying(table.element(id.add(uint(1)))).setInterpolation("flat");
      const layers = varying(table.element(id.add(uint(2)))).setInterpolation("flat");
      const repeat = varying(table.element(id.add(uint(3)))).setInterpolation("flat").xy;
      const coords = uv().mul(repeat);
      const albedo = texture(base.texture, coords).depth(layers.x.max(0));
      const normals = texture(normal.texture, coords).depth(layers.y.max(0));
      const packed = texture(arm.texture, coords).depth(layers.z.max(0));
      const paint = layers.x.greaterThanEqual(0).select(vec4(color.rgb, 1).mul(albedo), vec4(color.rgb, 1));
      const material = (outside: boolean) => {
        const made = new MeshStandardNodeMaterial({
          name: outside ? "house exterior atlas" : "house interior atlas",
          vertexColors: true,
          envMapIntensity: outside ? 1 : 0.12,
        });
        made.colorNode = outside ? paint.mul(vec4(weatherColor(color.w), 1)) : paint;
        made.roughnessNode = layers.z.greaterThanEqual(0).select(parameters.x.mul(packed.g), parameters.x);
        made.metalnessNode = layers.w.greaterThan(0).select(parameters.y.mul(packed.b), parameters.y);
        made.aoNode = layers.z.greaterThanEqual(0).select(packed.r.sub(1).mul(1).add(1), 1);
        made.normalNode = layers.y.greaterThanEqual(0).select(normalMap(normals.rgb, parameters.zw), normalView);
        return made;
      };
      this.inside = material(false);
      this.outside = material(true);
    } catch (error) {
      for (const array of this.arrays) array.dispose();
      throw error;
    }
  }

  id(material: Surface): number {
    const id = this.ids.get(material);
    if (id === undefined) throw new Error(`${material.name}: material is not in the house atlas`);
    return id;
  }

  dispose(): void {
    this.inside.dispose();
    this.outside.dispose();
    for (const array of this.arrays) array.dispose();
  }
}

function validate(material: Surface): void {
  if (
    material.opacity !== 1 ||
    material.alphaTest !== 0 ||
    material.transparent ||
    material.emissive.getHex() !== 0 ||
    material.aoMapIntensity !== 1 ||
    material.flatShading
  ) {
    throw new Error(`${material.name}: unsupported house atlas material`);
  }
  if (material.roughnessMap !== material.aoMap || (material.metalnessMap && material.metalnessMap !== material.roughnessMap))
    throw new Error(`${material.name}: house atlas requires one ARM map`);
  const maps = [material.map, material.normalMap, material.roughnessMap].filter((map) => map !== null);
  const first = maps[0];
  for (const map of maps) {
    if (
      map.channel !== 0 ||
      map.rotation !== 0 ||
      map.offset.x !== 0 ||
      map.offset.y !== 0 ||
      map.center.x !== 0 ||
      map.center.y !== 0 ||
      !map.matrixAutoUpdate
    ) {
      throw new Error(`${material.name}: unsupported house atlas UV transform`);
    }
    map.updateMatrix();
    if (first && !map.matrix.equals(first.matrix)) throw new Error(`${material.name}: house atlas maps have different UV transforms`);
  }
}
