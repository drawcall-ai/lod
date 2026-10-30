import { Lod, type Wind } from "@drawcall/lod";
import type { LevelCount } from "./stats.ts";

function element<T extends Element>(selector: string, type: new () => T): T {
  const e = document.querySelector(selector);
  if (!(e instanceof type)) throw new Error(`page markup is missing ${selector}`);
  return e;
}

/** The overlay: loading progress, then tour controls, the package's global knobs and live counts. */
export class Ui {
  private readonly controls = element("#controls", HTMLDivElement);
  private readonly loading = element("#loading", HTMLDivElement);
  private readonly status = element("#status", HTMLDivElement);
  private readonly bar = element("#bar div", HTMLDivElement);
  private readonly play = element("#play", HTMLButtonElement);
  private readonly time = element("#time", HTMLInputElement);
  private readonly stats = element("#stats", HTMLDivElement);

  /** Connects the controls to the tour and the package's global settings. */
  bind(tour: { duration: number; toggle: () => boolean; seek: (time: number) => void }, wind?: Wind): void {
    this.time.max = String(tour.duration);
    this.play.addEventListener("click", () => (this.play.textContent = tour.toggle() ? "Pause" : "Play"));
    this.time.addEventListener("input", () => {
      tour.seek(Number(this.time.value));
      this.play.textContent = "Play";
    });
    const strength = element("#wind", HTMLInputElement);
    strength.disabled = !wind;
    strength.value = String(wind?.strength ?? 0);
    strength.addEventListener("input", () => {
      if (wind) wind.strength = Number(strength.value);
    });
    const debug = element("#debug", HTMLInputElement);
    debug.checked = Lod.debug;
    debug.addEventListener("change", () => (Lod.debug = debug.checked));
    const quality = element("#quality", HTMLInputElement);
    const value = element("#qualityValue", HTMLSpanElement);
    quality.value = String(Lod.quality);
    value.textContent = Lod.quality.toFixed(2);
    quality.addEventListener("input", () => {
      Lod.quality = Number(quality.value);
      value.textContent = Lod.quality.toFixed(2);
    });
  }

  progress(text: string, done: number): void {
    this.status.textContent = text;
    this.bar.style.width = `${Math.round(done * 100)}%`;
  }

  ready(): void {
    this.loading.hidden = true;
    this.controls.hidden = false;
  }

  /** Shows where the tour is, unless the user is dragging the slider. */
  showTime(time: number, playing: boolean): void {
    if (document.activeElement !== this.time) this.time.value = String(time);
    this.play.textContent = playing ? "Pause" : "Play";
  }

  showStats(frame: { ms: number; gpu: number | null; calls: number; triangles: number }, kinds: { name: string; levels: LevelCount[] }[] = []): void {
    const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
    const lines = [
      `frame ${frame.ms.toFixed(1)} ms${frame.gpu === null ? "" : `  gpu pass sum ${frame.gpu.toFixed(1)} ms`}`,
      `${k(frame.triangles)} triangles  ${frame.calls} draws`,
    ];
    if (kinds.length) lines.push("", "instances per level   0 · 1 · 2 · 3");
    for (const { name, levels } of kinds) lines.push(`${name.padEnd(13)} ${levels.map((l) => k(l.instances).padStart(5)).join(" ")}`);
    this.stats.textContent = lines.join("\n");
  }
}
