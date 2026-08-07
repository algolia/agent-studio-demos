import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const demoRoot = fileURLToPath(new URL(".", import.meta.url));
const deployRoot = fileURLToPath(new URL("../../public/summary-card/", import.meta.url));

export default defineConfig({
  root: demoRoot,
  base: "./",
  plugins: [react()],
  build: {
    outDir: deployRoot,
    emptyOutDir: true,
  },
});
