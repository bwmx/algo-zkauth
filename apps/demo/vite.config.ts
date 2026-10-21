import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port 8765 is the origin the local stack's demo app allows (apps.json).
export default defineConfig({
  plugins: [react()],
  server: { port: 8765, strictPort: true, host: "127.0.0.1" },
  preview: { port: 8765, strictPort: true, host: "0.0.0.0" },
  build: { target: "es2022" },
});
