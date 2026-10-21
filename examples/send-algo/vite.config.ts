import { defineConfig } from "vite";

// Port 8775 is the origin the local stack registers for the "example" app.
export default defineConfig({
  server: { port: 8775, strictPort: true, host: "127.0.0.1" },
  preview: { port: 8775, strictPort: true, host: "0.0.0.0" },
  // Two pages: index.html (the dApp holds the session) and hosted.html (the shared wallet does).
  build: { target: "es2022", rollupOptions: { input: { main: "index.html", hosted: "hosted.html" } } },
});
