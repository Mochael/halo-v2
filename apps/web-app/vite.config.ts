import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      output: {
        minify: false,
        preserveModules: true,
      },
    },
  },
  optimizeDeps: {
    noDiscovery: true,
  },
  resolve: {
    alias: {
      // Tandem Logger.ts imports node:fs at module load.
      "node:fs": fileURLToPath(
        new URL("../../packages/web/src/emptyNodeFs.ts", import.meta.url),
      ),
    },
    dedupe: [
      "react",
      "react-dom",
      "react-aria-components",
      "purse-styles",
      "wouter",
    ],
    preserveSymlinks: false,
  },
});
