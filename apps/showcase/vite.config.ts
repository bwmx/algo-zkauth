import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The public showcase, built into dist/ and published to GitHub Pages at
// https://bwmx.github.io/algo-zkauth/ by .github/workflows/pages.yml.
export default defineConfig({
  base: "/algo-zkauth/",
  plugins: [react()],
  // The committed verification keys are imported from the repository's fixtures/.
  server: { fs: { allow: ["../.."] } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  test: { environment: "node" },
});
