import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // electron-updater fica externo (nao embutido no bundle do main): ele e CJS com
  // requires dinamicos e le o app-update.yml em runtime; o electron-builder copia
  // as dependencies de producao pro pacote automaticamente.
  main: { build: { rollupOptions: { external: ["electron-updater"] } } },
  preload: {},
  renderer: {
    resolve: {
      alias: { "@codec": resolve("src/tim.ts") },
    },
    plugins: [react()],
  },
});
