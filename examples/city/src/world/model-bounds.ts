import { Box3, Vector3 } from "three/webgpu";
import { manifest } from "../content/materials.ts";

/** Encloses every re-centred variant without loading the model. */
export function modelBounds(id: string): Box3 {
  const entry = manifest().models[id];
  if (!entry) throw new Error(`No manifest bounds for ${id}`);
  const [low, high] = entry.bounds;
  if (!low || !high || low.length !== 3 || high.length !== 3) throw new Error(`Invalid manifest bounds for ${id}`);
  // fetch-assets rounds endpoints to four decimals. Re-centred subsets cannot
  // exceed the whole asset's width/depth, and retain their original y.
  const box = new Box3(new Vector3().fromArray(low), new Vector3().fromArray(high)).expandByScalar(0.000051);
  const half = box.getSize(new Vector3()).multiplyScalar(0.5);
  box.min.x = -half.x;
  box.max.x = half.x;
  box.min.z = -half.z;
  box.max.z = half.z;
  return box;
}
