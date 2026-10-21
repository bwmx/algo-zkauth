import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Built into dist/ and served by scripts/demo/phase6-server.mjs at /demo/, the
// origin registered with Google. Shared protocol modules are imported from
// the repository's packages/protocol/src by path and bundled here.
export default defineConfig({
  base: "/demo/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  test: { environment: "jsdom", setupFiles: ["tests/setup.ts"] },
});
