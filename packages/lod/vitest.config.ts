import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { vitecache } from "vitecache/vite";

// The tests run in Chromium, on WebGPU: the package draws with nothing else. On machines
// without a GPU (CI), Chromium's SwiftShader adapter stands in. Chromium in its new
// headless mode: the old headless shell loses every device once a page asks for a second
// adapter after drawing to a canvas, which the bakes' own renderer does.
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
            ...(process.platform === "linux" ? ["--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan"] : []),
          ],
        },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
