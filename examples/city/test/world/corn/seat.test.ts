import assert from "node:assert/strict";
import { test } from "node:test";
import { plant } from "../../../public/corn/model.ts";
import { cornMaterials } from "../../../public/corn/tissue.ts";
import { HERO_VARIANT } from "../../../public/corn/layout.ts";
import { LADYBIRD_SEAT, leafSeat } from "../../../src/world/corn/seat.ts";

test("LADYBIRD_SEAT is where leafSeat seats the ladybird on the hero plant", () => {
  const seat = leafSeat(plant(cornMaterials(), HERO_VARIANT, true));
  assert.ok(seat.point.distanceTo(LADYBIRD_SEAT.point) < 1e-6, `point ${seat.point.toArray()}`);
  assert.ok(seat.normal.distanceTo(LADYBIRD_SEAT.normal) < 1e-6, `normal ${seat.normal.toArray()}`);
  assert.ok(Math.abs(seat.heading - LADYBIRD_SEAT.heading) < 1e-6, `heading ${seat.heading}`);
});
