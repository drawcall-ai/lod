import { BoxGeometry, Mesh, MeshBasicMaterial } from "three/webgpu";
import { expect, it } from "vitest";
import { parts } from "../../src/instanced/meshes.js";

it.each([true, false])("clips material groups to the draw range (indexed: %s)", (indexed) => {
  const box = new BoxGeometry(2, 2, 2);
  const geometry = indexed ? box : box.toNonIndexed();
  geometry.clearGroups();
  geometry.addGroup(0, 18, 0);
  geometry.addGroup(18, 18, 1);
  geometry.addGroup(36, 6, 0);
  geometry.setDrawRange(6, 24);
  const red = new MeshBasicMaterial({ color: 0xff0000 });
  const green = new MeshBasicMaterial({ color: 0x00ff00 });
  const mesh = new Mesh(geometry, [red, green]);
  expect(parts(mesh, 2).map(({ draw }) => draw)).toEqual([
    { level: 2, count: 12, start: 6, indexed },
    { level: 2, count: 12, start: 18, indexed },
    { level: 2, count: 0, start: 36, indexed },
  ]);
  expect(parts(new Mesh(geometry, red), 2).map(({ draw }) => draw)).toEqual([{ level: 2, count: 24, start: 6, indexed }]);
  geometry.dispose();
  if (!indexed) box.dispose();
  red.dispose();
  green.dispose();
});
