import { defineConfig } from "vite";

// Port 8775 is the origin the local stack registers for the "example" app.
export default defineConfig({
  server: { port: 8775, strictPort: true, host: "127.0.0.1" },
  preview: { port: 8775, strictPort: true, host: "0.0.0.0" },
  build: { target: "es2022" },
});
