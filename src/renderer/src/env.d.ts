/// <reference types="vite/client" />

interface Window {
  api: {
    openFile: () => Promise<string | null>;
    openPng: () => Promise<string | null>;
    savePng: (def: string) => Promise<string | null>;
    saveBin: (def: string) => Promise<string | null>;
    saveAct: (def: string) => Promise<string | null>;
    setPaletteEnabled: (on: boolean) => Promise<void>;
    readFile: (p: string) => Promise<Uint8Array>;
    writeFile: (p: string, data: Uint8Array) => Promise<boolean>;
    pathForFile: (f: File) => string;
    setLastFile: (p: string) => Promise<void>;
    getLastFile: () => Promise<string>;
    onOpenFile: (cb: (path: string) => void) => () => void;
    popupMenu: () => Promise<void>;
    popupMenuItem: (index: number, x: number) => Promise<void>;
    openWith: (p: string) => Promise<boolean | string>;
    onOpenPreferences: (cb: () => void) => () => void;
    onExportPalette: (cb: () => void) => () => void;
  };
}
