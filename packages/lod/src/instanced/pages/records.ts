import type { Node } from "three/webgpu";
import { If, Var, code, float, localId, storage, struct, wgslFn } from "three/tsl";
import { tgpu } from "typegpu";
import type { GpuRecords } from "./index.js";

/** What the passes take from an instance function's result: its matrix, colour padded to four floats, and keep ratio. */
const Instance = struct({ matrix: "mat4", color: "vec4", keep: "float" }, "LodRecordInstance");

/**
 * The records of GPU chunks and the app's instance function, as the passes that take chunks in read them: each lane of
 * a job's workgroup reads one record of the job's window, whose first record is the job's `x` and records its `z`.
 * Lanes past the window's records read none and keep nothing.
 */
export class Records {
  /** The `vec4u` words of a record. */
  readonly words: number;
  private readonly source: ReturnType<typeof readRecords>;
  private functions: ReturnType<typeof instanceFunctions> | null = null;

  constructor(
    private readonly instance: GpuRecords["instance"],
    records: GpuRecords["records"],
  ) {
    const words = instance.shell.argTypes;
    if (words.length === 0 || words.some((word) => word.type !== "vec4u")) throw new TypeError("InstancedLod: gpuRecords.instance must take a record's vec4u words");
    this.words = words.length;
    this.source = readRecords(records);
  }

  /** This lane's instance in `job`, the instance function run once: its keep ratio is 1 past the job's records. */
  instanceAt(job: Node<"uvec4">) {
    const instance = Var(Instance());
    const keep = float(1).toVar();
    If(localId.x.lessThan(job.z), () => {
      instance.assign(this.of().instanceOf(this.wordsAt(job)));
      keep.assign(instance.get("keep"));
    });
    return { matrix: instance.get("matrix"), color: instance.get("color"), keep };
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

const readRecords = (records: GpuRecords["records"]) => storage(records, "uvec4", records.count).toReadOnly();

/**
 * `instance` as a TSL function of a record's words `w0`, `w1`…, making an `Instance`.
 * TypeGPU writes the WGSL of `instance`, which three's shaders include; its return type keeps its own name.
 */
function instanceFunctions(instance: GpuRecords["instance"], words: number) {
  const names = Array.from({ length: words }, (_, w) => `w${w}`).join(", ");
  const params = Array.from({ length: words }, (_, w) => `w${w}: vec4u`).join(", ");
  const library = code(
    tgpu.resolve({
      template: `fn lodInstance(${params}) -> LodRecordInstance { let made = instance(${names}); return LodRecordInstance(made.matrix, vec4f(made.color, 1), made.keep); }`,
      externals: { instance },
    }),
  );
  // three calls a function it parsed itself, which forwards to TypeGPU's.
  return { instanceOf: wgslFn(`fn lodInstanceOf(${params}) -> LodRecordInstance { return lodInstance(${names}); }`, [library]) };
}
