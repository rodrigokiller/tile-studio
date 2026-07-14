/// <reference types="vite/client" />

// tipa window.api direto do preload (export type Api = typeof api) -- assim NUNCA fica
// desatualizado quando a gente adiciona metodo novo no preload
interface Window {
  api: import("../../preload").Api;
}
