import type { Node } from "three/webgpu";
import { If, code, float, localId, storage, wgslFn } from "three/tsl";
import { tgpu } from "typegpu";
import type { GpuChunks } from "./pages.js";

/**
 * The records of GPU chunks and the app's instance function, as the passes that take chunks in read them: each lane of
 * a job's workgroup reads one record of the job's window, whose first record is the job's `x` and records its `z`.
 */
export class Records {
  /** The `vec4u` words of a record. */
  readonly words: number;
  private readonly source: ReturnType<typeof readRecords>;
  private functions: ReturnType<typeof instanceFunctions> | null = null;

  constructor(
    private readonly instance: GpuChunks["instance"],
    records: GpuChunks["records"],
  ) {
    const words = instance.shell.argTypes;
    if (words.length === 0 || words.some((word) => word.type !== "vec4u"))
      throw new TypeError("InstancedLod: gpuChunks.instance must take a record's vec4u words");
    this.words = words.length;
    this.source = readRecords(records);
  }

  /** The keep ratio of this lane's record in `job`, or 1 for a lane past its records. */
  keepAt(job: Node<"uvec4">): Node<"float"> {
    const keep = float(1).toVar();
    If(localId.x.lessThan(job.z), () => void keep.assign(this.of().keepOf(this.wordsAt(job))));
    return keep;
  }

  /** The matrix of this lane's record in `job`. */
  matrixAt(job: Node<"uvec4">): Node {
    return this.of().matrixOf(this.wordsAt(job));
  }

  /** The colour of this lane's record in `job`, padded to four floats. */
  colorAt(job: Node<"uvec4">): Node {
    return this.of().colorOf(this.wordsAt(job));
  }

  private of() {
    this.functions ??= instanceFunctions(this.instance, this.words);
    return this.functions;
  }

  /** The words of this lane's record in `job`, as `w0`, `w1`… */
  private wordsAt(job: Node<"uvec4">) {
    const { words, source } = this;
    const first = job.x.add(localId.x).mul(words);
    return Object.fromEntries(Array.from({ length: words }, (_, w) => [`w${w}`, source.element(first.add(w))]));
  }
}

const readRecords = (records: GpuChunks["records"]) => storage(records, "uvec4", records.count).toReadOnly();

/**
 * `instance` as TSL functions of a record's words `w0`, `w1`…: its matrix, its colour (padded to four floats) and its
 * keep ratio. TypeGPU writes the WGSL of `instance`, which three's shaders include; its return type keeps its own name.
 */
function instanceFunctions(instance: GpuChunks["instance"], words: number) {
  const names = Array.from({ length: words }, (_, w) => `w${w}`).join(", ");
  const params = Array.from({ length: words }, (_, w) => `w${w}: vec4u`).join(", ");
  const parts = { Matrix: ["mat4x4f", "$.matrix"], Color: ["vec4f", "vec4f($.color, 1)"], Keep: ["f32", "$.keep"] } as const;
  const record = `instance(${names})`;
  const library = code(
    tgpu.resolve({
      template: Object.entries(parts)
        .map(([part, [type, value]]) => `fn lodInstance${part}(${params}) -> ${type} { return ${value.replace("$", record)}; }`)
        .join("\n"),
      externals: { instance },
    }),
  );
  // three calls a function it parsed itself, which forwards to TypeGPU's.
  const forward = (part: keyof typeof parts) =>
    wgslFn(`fn lodInstance${part}Of(${params}) -> ${parts[part][0]} { return lodInstance${part}(${names}); }`, [library]);
  return { matrixOf: forward("Matrix"), colorOf: forward("Color"), keepOf: forward("Keep") };
}
