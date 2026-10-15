import { MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";
import { fadeUniforms, fadedCopy, fadeUniformsOf, originalOf } from "../src/fade.js";
import { GPU_TIMEOUT, compile } from "./webgl.js";

describe("fadedCopy", { timeout: GPU_TIMEOUT }, () => {
  it("copies the original, reads the given uniforms and chains the original patch", () => {
    const material = new MeshStandardMaterial();
    let chained = false;
    material.onBeforeCompile = () => void (chained = true);
    const uniforms = fadeUniforms();
    const copy = fadedCopy(material, uniforms);
    expect(copy).not.toBe(material);
    expect(fadeUniformsOf(copy)).toBe(uniforms);
    expect(originalOf(fadedCopy(copy, fadeUniforms()))).toBe(material);
    const shader = compile(copy);
    expect(chained).toBe(true);
    expect(shader.uniforms.lodFade).toBe(uniforms.lodFade);
    expect(shader.fragmentShader).toContain("lodFadeDiscard(lodFade, vLodFadeSubtense)");
    expect(shader.fragmentShader).toContain("diffuseColor.rgb *= lodTint");
    expect(copy.customProgramCacheKey()).toBe(fadedCopy(material, fadeUniforms()).customProgramCacheKey());
  });
});
