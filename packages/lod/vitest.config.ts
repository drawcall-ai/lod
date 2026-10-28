import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { vitecache } from "vitecache/vite";

// Linux uses SwiftShader for WebGPU. Canvas presentation also needs ANGLE's Vulkan
// path and Mesa's Vulkan runtime: without them offscreen draws work, but a canvas
// draw loses the device. Use full Chromium; the old headless shell also loses devices
// when a second adapter is requested after drawing to a canvas.
export default defineConfig({
  publicDir: "test/public",
  plugins: [vitecache({ basePath: "test/public/_vitecache" })],
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
