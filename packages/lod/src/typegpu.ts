import type { Node } from "three/webgpu";
import { Fn, code, wgslFn } from "three/tsl";
import { tgpu, type TgpuFn } from "typegpu";
import { at } from "./at.js";
import { isNodeOf, type NodeType } from "./tsl.js";

// TypeGPU functions ('use gpu') in three's shaders: one function runs as plain JS on the CPU and, through toTsl, as
// WGSL in a TSL node graph.

/** The WGSL types a TypeGPU function given to toTsl takes or returns, by TypeGPU's names, and the TSL node type of each. */
const NODE_TYPES = { f32: "float", i32: "int", u32: "uint", vec3f: "vec3", vec4f: "vec4", mat4x4f: "mat4" } as const satisfies Record<string, NodeType>;
type WgslType = keyof typeof NODE_TYPES;

/** The WGSL types such a function returns. */
type ReturnedType = "f32" | "vec3f" | "vec4f";

/** A TypeGPU data type, such as `d.f32`, by its WGSL name. */
type Typed<T extends WgslType = WgslType> = { readonly type: T };

/** A TypeGPU function's argument and return types. */
interface Shell<A extends readonly Typed[], R extends ReturnedType> {
  readonly argTypes: A;
  readonly returnType: Typed<R>;
}

/** The TSL nodes the function takes, by the names `N` of its arguments, typed `A` in their order. */
type TslInputs<N extends readonly string[], A extends readonly Typed[]> = {
  [I in keyof N & `${number}` as N[I]]: Node<(typeof NODE_TYPES)[A[I & keyof A]["type"]]>;
};

/**
 * A TSL function of nodes named `names` that calls `fn`, a TypeGPU function, through a WGSL forwarder `name`;
 * TypeGPU's WGSL joins the shader as a library.
 */
export function toTsl<A extends Typed[], R extends ReturnedType, const N extends { [I in keyof A]: string }>(
  name: string,
  names: N,
  fn: TgpuFn & { readonly shell: Shell<A, R> },
): (inputs: TslInputs<N, A>) => Node<(typeof NODE_TYPES)[R]>;
// Not generic: three's Fn leaves a generic return type unresolved.
export function toTsl(
  name: string,
  names: readonly string[],
  fn: TgpuFn & { readonly shell: Shell<Typed[], ReturnedType> },
): (inputs: Record<string, Node>) => Node<(typeof NODE_TYPES)[ReturnedType]> {
  // TgpuFn types its shell loosely; the signature types it by its WGSL types.
  const shell: Shell<Typed[], ReturnedType> = fn.shell;
  const returned = shell.returnType.type;
  const params = names.map((param, index) => `${param}: ${at(shell.argTypes, index).type}`);
  const signature = `(${params.join(", ")}) -> ${returned}`;
  const library = code(tgpu.resolve({ template: `fn ${name}Of${signature} { return target(${names.join(", ")}); }`, externals: { target: fn } }));
  const call = wgslFn(`fn ${name}${signature} { return ${name}Of(${names.join(", ")}); }`, [library]);
  const type = NODE_TYPES[returned];
  return (inputs) =>
    Fn((builder) => {
      const value = call(inputs);
      if (isNodeOf(value, type, builder)) return value;
      throw new Error(`@drawcall/lod: ${name}'s WGSL returns no ${returned}`);
    })();
}
