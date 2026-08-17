import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = dirname(fileURLToPath(import.meta.url));

/** Read-only, localhost-only console — both the dev server and the built preview bind
 * 127.0.0.1 only, matching the backend's own binding (server/index.ts). */
export default defineConfig({
  root: rootDir,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5273,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5274",
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 5273,
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
