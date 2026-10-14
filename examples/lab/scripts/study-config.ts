// The technique study: objects × viewing cells (distance band × view angle) × techniques.
// A use case is any set of cells of one object; scripts/study-*.ts measure every cell and
// every technique combination, and the decision tool composes them.

export interface StudyObject {
  id: string;
  /** what kind of object it stands for */
  label: string;
  /** typical instance count for this kind of object in a scene */
  count: number;
  /** close-ups: true = stand inside its volume (a canopy), false = just outside its bounds */
  enterable: boolean;
}

export const OBJECTS: StudyObject[] = [
  { id: "oak", label: "Broadleaf tree (card leaves)", count: 50_000, enterable: true },
  { id: "spruce", label: "Conifer (card needles)", count: 50_000, enterable: true },
  { id: "rooibos", label: "Shrub (card leaves)", count: 100_000, enterable: true },
  { id: "grass", label: "Grass clump (card blades)", count: 200_000, enterable: true },
  { id: "boulder", label: "Rock scan", count: 5_000, enterable: false },
  { id: "barrel", label: "Hard-surface prop", count: 2_000, enterable: false },
  { id: "car", label: "Vehicle", count: 2_000, enterable: false },
  { id: "mansion", label: "Building", count: 200, enterable: false },
  { id: "streetlamp", label: "Thin, tall structure", count: 2_000, enterable: false },
  { id: "moonrock", label: "Debris / asteroid", count: 10_000, enterable: false },
];

export interface Angle {
  id: string;
  label: string;
  /** degrees above the horizon for the quality views */
  elevation: number;
  azimuth: number;
  /** instance rotation for the quality views (tumbling) */
  rotation?: [number, number, number];
  /** GPU field camera: 0 = eye height, else degrees looking down from just above the tops */
  field: number;
  tumble?: boolean;
}

export const ANGLES: Angle[] = [
  { id: "ground", label: "From the ground", elevation: 4, azimuth: 20, field: 0 },
  { id: "elevated", label: "From above (40°)", elevation: 40, azimuth: 140, field: 40 },
  { id: "top", label: "Top-down", elevation: 80, azimuth: 250, field: 80 },
  { id: "any", label: "Any orientation (tumbling)", elevation: -35, azimuth: 70, rotation: [40, 20, 110], field: 0, tumble: true },
];

export interface Band {
  id: string;
  label: string;
  /** bounding-sphere diameter on screen */
  px: number;
  /** close-ups: a wide lens, standing at the object (see StudyObject.enterable) */
  fov?: number;
  close?: boolean;
}

/** Near to far. Neighbouring bands switch at the geometric mean of their sizes. */
export const BANDS: Band[] = [
  { id: "close", label: "Close (standing next to it)", px: 800, fov: 75, close: true },
  { id: "300", label: "Near (300 px)", px: 300 },
  { id: "100", label: "Mid (100 px)", px: 100 },
  { id: "30", label: "Far (30 px)", px: 30 },
];

/** Techniques in order of detail; combinations always go from more to less detail. */
export const TECHS = ["real", "lod", "baked", "hemi", "full"] as const;
export type Tech = (typeof TECHS)[number];
export const TECH_LABEL: Record<Tech, string> = { real: "Original", lod: "LOD", baked: "Baked LOD", hemi: "Impostor (hemi)", full: "Impostor (full)" };

/** Pairs a switch can join (near technique first). */
export const PAIRS: Array<[Tech, Tech]> = [
  ["real", "lod"], ["real", "baked"], ["real", "hemi"], ["real", "full"],
  ["lod", "baked"], ["lod", "hemi"], ["lod", "full"], ["baked", "hemi"], ["baked", "full"],
];

/** Every combination tried: one technique, two, or the classic LOD chain plus impostor. */
export const COMBOS: Tech[][] = [
  ...TECHS.map((t) => [t]),
  ...PAIRS.map(([a, b]) => [a, b]),
  ["real", "lod", "hemi"], ["real", "lod", "full"], ["real", "baked", "hemi"], ["real", "baked", "full"],
];

/** Baked-LOD texture: about two texels per screen pixel. */
export const bakedTexture = (px: number) => Math.min(1024, Math.max(64, 2 ** Math.ceil(Math.log2(px * 2))));

/** prepare() arguments for a technique at a band. */
export function prepareArgs(tech: Tech, band: Band): [object, object] {
  const hemi = { layout: "hemi", frames: 12 };
  if (tech === "full") return [{ layout: "full", frames: 16 }, {}];
  if (tech === "hemi") return [hemi, {}];
  if (tech === "real") return [hemi, { kind: "real" }];
  return [hemi, { kind: tech === "lod" ? "lod-simple" : "lod-baked", lodError: 1 / band.px, texture: bakedTexture(band.px) }];
}
