import type { Object3D } from "three/webgpu";
import type { InstancedLod, Lod, Wind } from "@drawcall/lod";
import type { Tour } from "./flight/tour.ts";
import type { Pipeline } from "./render/pipeline.ts";
import type { Sun } from "./render/sun/index.ts";
import type { Patches } from "./world/patches.ts";
import { countLevels } from "./stats.ts";

interface City {
  loadMs: number;
  loadStages: Record<string, number>;
  pipeline: Pipeline;
  wind: Wind | undefined;
  tour: Tour;
  sun: Sun;
  lods: (Lod | InstancedLod)[];
  patches: Patches[];
  kinds: { name: string; roots: Object3D[] }[];
  playback: { time: number };
  frame(): void;
  resume(): void;
  seek(time: number): void;
}

/** The tour scripts can settle and measure a view without changing the live loop. */
export function diagnostics(view: City) {
  const { pipeline, wind, tour, sun, lods, patches, kinds, playback, frame, resume } = view;
  let arrivals = 0;
  for (const lod of lods) lod.addEventListener("levelschange", () => arrivals++);

  async function draw(count: number, before?: (index: number) => void) {
    pipeline.renderer.setAnimationLoop(null);
    await pipeline.timing();
    const frames: { cpu: number; gpu: number | null }[] = [];
    for (let i = 0; i < count; i++) {
      const cpu = await pipeline.step(() => {
        before?.(i);
        const start = performance.now();
        frame();
        return performance.now() - start;
      });
      frames.push({ cpu, gpu: await pipeline.timing() });
    }
    return frames;
  }

  async function settle(): Promise<void> {
    const until = performance.now() + 60000;
    let changed = arrivals;
    let quiet = performance.now();
    for (;;) {
      await draw(1);
      const failed = lods.find((lod) => lod.error !== undefined);
      if (failed) throw failed.error;
      if (arrivals !== changed || lods.some((lod) => lod.pending) || patches.some((patch) => !patch.settled)) {
        changed = arrivals;
        quiet = performance.now();
      }
      if (performance.now() - quiet > 300) return;
      if (performance.now() > until) throw new Error("The requested view did not settle");
    }
  }

  return {
    loadMs: view.loadMs,
    loadStages: view.loadStages,
    wind,
    keys: tour.keys.map(({ name, time }) => ({ name, time })),
    async seek(time: number) {
      pipeline.renderer.setAnimationLoop(null);
      view.seek(time);
      await settle();
      resume();
    },
    async measure(frames: number, runs: number, move = 0) {
      if (!pipeline.renderer.hasFeature("timestamp-query")) throw new Error("measure needs the GPU's timestamp-query feature");
      await settle();
      const start = playback.time;
      const breeze = wind?.time ?? 0;
      const perFrame: number[] = [];
      const cpu: number[] = [];
      for (let run = 0; run < runs; run++) {
        const each = await draw(frames, (i) => {
          playback.time = start + i * move;
          if (wind) wind.time = breeze + i / 60;
        });
        let gpu = 0;
        for (const frame of each) {
          if (frame.gpu === null) throw new Error("measure: a frame has no GPU timing");
          gpu += frame.gpu;
          cpu.push(frame.cpu);
        }
        perFrame.push(gpu / frames);
      }
      playback.time = start;
      if (wind) wind.time = breeze;
      await draw(1);
      resume();
      return {
        ms: median(perFrame),
        cpu: median(cpu),
        ...pipeline.drawn,
        kinds: kinds.map(({ name, roots }) => ({ name, levels: countLevels(roots) })),
        cascades: sun.cascades.map((cascade) => ({ ...cascade.drawn })),
      };
    },
  };
}

function median(values: number[]): number {
  const value = values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  if (value === undefined) throw new Error("measure: no frames sampled");
  return value;
}

declare global {
  interface Window {
    city: ReturnType<typeof diagnostics>;
  }
}
