import { chromium } from "@playwright/test";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader=false"] });
const page = await browser.newPage();
await page.goto("about:blank");
const r = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2")!;
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return { renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?", float: !!gl.getExtension("EXT_color_buffer_float"), timer: !!gl.getExtension("EXT_disjoint_timer_query_webgl2") };
});
console.log(r);
await browser.close();
