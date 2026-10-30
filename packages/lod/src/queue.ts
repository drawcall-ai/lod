import { pause } from "./pause.js";

interface Job {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  priority: number;
}

const queue: Job[] = [];
let running = false;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Run at most one installation per animation frame across all LODs. */
export function enqueue(run: () => Promise<void>, priority = 0): Promise<void> {
  const promise = new Promise<void>((resolve, reject) => {
    queue.push({ run, resolve, reject, priority });
    queue.sort((a, b) => b.priority - a.priority);
  });
  if (!running) void drain();
  return promise;
}

async function drain(): Promise<void> {
  running = true;
  while (queue.length) {
    await frame();
    await pause();
    const job = queue.shift();
    if (!job) break;
    try {
      await job.run();
      job.resolve();
    } catch (error) {
      job.reject(error);
    }
  }
  running = false;
}
