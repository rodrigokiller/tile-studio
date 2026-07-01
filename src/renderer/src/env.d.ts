/// <reference types="vite/client" />

interface Window {
  api: {
    openFile: () => Promise<string | null>;
    openPng: () => Promise<string | null>;
    savePng: (def: string) => Promise<string | null>;
    saveBin: (def: string) => Promise<string | null>;
    readFile: (p: string) => Promise<Uint8Array>;
    writeFile: (p: string, data: Uint8Array) => Promise<boolean>;
    pathForFile: (f: File) => string;
  };
}
