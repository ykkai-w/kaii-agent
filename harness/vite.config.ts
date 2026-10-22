import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

// Full-app visual QA with deterministic fake IPC. Electron and model processes stay off.
export default defineConfig({
  root: repositoryRoot,
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
  },
});
