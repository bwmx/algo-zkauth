import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port 8770 is the origin the local stack registers for the shared "wallet" app (apps.json).
export default defineConfig({
  plugins: [react()],
  server: { port: 8770, strictPort: true, host: "127.0.0.1" },
  preview: { port: 8770, strictPort: true, host: "0.0.0.0" },
  build: { target: "es2022" },
});
