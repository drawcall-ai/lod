import assert from "node:assert/strict";
import { test } from "node:test";
import { choice, number } from "../../public/content/parameters.ts";

test("asset parameters default only when absent and reject malformed values", () => {
  const choices = ["lawn", "meadow"] as const;
  assert.equal(choice(new URLSearchParams(), "kind", choices, "lawn"), "lawn");
  assert.throws(() => choice(new URLSearchParams("kind=forest"), "kind", choices, "lawn"), /Unknown kind/);
  assert.equal(number(new URLSearchParams(), "seed", 1, 0, 4, true), 1);
  for (const value of ["", "NaN", "Infinity", "-1", "5", "1.5"])
    assert.throws(() => number(new URLSearchParams({ seed: value }), "seed", 1, 0, 4, true), /Invalid seed/);
});
