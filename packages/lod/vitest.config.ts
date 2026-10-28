import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { vitecache } from "vitecache/vite";

const publicDir = mkdtempSync(join(tmpdir(), "lod-test-"));

// Linux uses SwiftShader for WebGPU. Canvas presentation also needs ANGLE's Vulkan
// path and Mesa's Vulkan runtime: without them offscreen draws work, but a canvas
// draw loses the device. Use full Chromium; the old headless shell also loses devices
// when a second adapter is requested after drawing to a canvas.
export default defineConfig({
  publicDir,
  plugins: [
    vitecache({ basePath: join(publicDir, "_vitecache") }),
    { name: "test-cache-cleanup", closeBundle: () => rmSync(publicDir, { recursive: true, force: true }) },
  ],
  test: {
    include: ["test/**/*.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: {
          channel: "chromium",
          args: [
            "--enable-unsafe-webgpu",
            "--enable-webgpu-developer-features",
            ...(process.platform === "linux" ? ["--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan", "--use-angle=vulkan"] : []),
          ],
        },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
