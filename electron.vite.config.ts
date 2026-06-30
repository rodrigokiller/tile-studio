import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: { "@codec": resolve("src/tim.ts") },
    },
    plugins: [react()],
  },
});
