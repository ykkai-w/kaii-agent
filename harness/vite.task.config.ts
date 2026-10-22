import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

// Narrow visual-QA server: it renders only the workbench harness and never boots Electron.
export default defineConfig({
  root: repositoryRoot,
  server: {
    host: "127.0.0.1",
    port: 4179,
    strictPort: true,
  },
});
