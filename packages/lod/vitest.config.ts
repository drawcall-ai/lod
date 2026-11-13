import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import typegpu from "unplugin-typegpu/vite";

// Linux uses SwiftShader for WebGPU. Canvas presentation also needs ANGLE's Vulkan
// path and Mesa's Vulkan runtime: without them offscreen draws work, but a canvas
// draw loses the device. Use full Chromium; the old headless shell also loses devices
// when a second adapter is requested after drawing to a canvas.
export default defineConfig({
  // Tests write their own GPU code as TypeGPU functions, as an app does.
  plugins: [typegpu()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "browser",
          include: ["test/**/*.test.ts"],
          exclude: ["test/node/**"],
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
      },
      // CachedLodLoader as the vitecache plugin runs it, on a WebGPU device of @drawcall/webgpu.
      { extends: true, test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" } },
    ],
  },
});
