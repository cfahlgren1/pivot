import { defineConfig } from "vite";

// Tauri expects a fixed dev port and must see Rust compile errors in the terminal.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari16", outDir: "dist" },
});
