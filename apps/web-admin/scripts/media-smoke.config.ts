import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [{
    name: "smoke-test-page",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "index.html", source: readFileSync(new URL("./media-smoke.html", import.meta.url), "utf8") });
    },
  }],
  build: {
    outDir: "../../.media-smoke",
    emptyOutDir: true,
    lib: { entry: fileURLToPath(new URL("./media-smoke.ts", import.meta.url)), formats: ["es"], fileName: () => "smoke.js" },
  },
});
