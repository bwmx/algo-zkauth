import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The public showcase, built into dist-site/ for GitHub Pages at
// https://bwmx.github.io/algo-zkauth/ by .github/workflows/pages.yml.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  root: here("site"),
  base: "/algo-zkauth/",
  plugins: [react()],
  build: { outDir: here("dist-site"), emptyOutDir: true, target: "es2022" },
});
