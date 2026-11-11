import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths: the site works from any sub-path (e.g. https://<user>.github.io/<repo>/).
  base: "./",
  build: { target: "es2022", outDir: "dist" },
});
