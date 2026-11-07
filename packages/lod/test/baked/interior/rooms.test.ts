import { BoxGeometry, Group, Matrix4, Mesh } from "three/webgpu";
import { expect, it } from "vitest";
import { readBoxes } from "../../../src/baked/interior/rooms.js";

it("reads one room per child of the interior, and refuses rooms that overlap", () => {
  const rooms = new Group().add(new Mesh(new BoxGeometry(1, 2, 1)).translateX(-0.5), new Mesh(new BoxGeometry(1, 2, 1)).translateX(0.5));
  const boxes = readBoxes(rooms, new Matrix4().makeTranslation(0, 1, 0));
  expect(boxes.map(({ min, max }) => [...min.toArray(), ...max.toArray()])).toEqual([
    [-1, 0, -0.5, 0, 2, 0.5],
    [0, 0, -0.5, 1, 2, 0.5],
  ]);
  const crowded = new Group().add(new Mesh(new BoxGeometry(1, 2, 1)), new Mesh(new BoxGeometry(1, 2, 1)).translateX(0.5));
  expect(() => readBoxes(crowded, new Matrix4())).toThrow(/overlap/);
  expect(() => readBoxes(new Group(), new Matrix4())).toThrow(/no rooms/);
});
