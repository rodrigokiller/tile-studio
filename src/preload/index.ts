import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

const api = {
  openFile: (): Promise<string | null> => ipcRenderer.invoke("dialog:openFile"),
  openPng: (): Promise<string | null> => ipcRenderer.invoke("dialog:openPng"),
  savePng: (def: string): Promise<string | null> => ipcRenderer.invoke("dialog:savePng", def),
  saveBin: (def: string): Promise<string | null> => ipcRenderer.invoke("dialog:saveBin", def),
  // exportar paleta como .ACT (Adobe Color Table) pro Photoshop
  saveAct: (def: string): Promise<string | null> => ipcRenderer.invoke("dialog:saveAct", def),
  setPaletteEnabled: (on: boolean): Promise<void> => ipcRenderer.invoke("menu:setPaletteEnabled", on),
  readFile: (p: string): Promise<Uint8Array> => ipcRenderer.invoke("fs:readFile", p),
  writeFile: (p: string, data: Uint8Array): Promise<boolean> =>
    ipcRenderer.invoke("fs:writeFile", p, data),
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  // recentes: registra o ultimo arquivo aberto e consulta o ultimo (pra reabrir ao iniciar)
  setLastFile: (p: string): Promise<void> => ipcRenderer.invoke("file:setLast", p),
  getLastFile: (): Promise<string> => ipcRenderer.invoke("file:getLast"),
  // menu -> renderer: quando o menu (Abrir arquivo / Abrir recente) pede pra carregar um caminho
  onOpenFile: (cb: (path: string) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, path: string): void => cb(path);
    ipcRenderer.on("menu:openFile", handler);
    return () => ipcRenderer.removeListener("menu:openFile", handler);
  },
  // barra de titulo custom: abre o menu do app como popup, ou o submenu de um item do topo
  popupMenu: (): Promise<void> => ipcRenderer.invoke("menu:popup"),
  popupMenuItem: (index: number, x: number): Promise<void> =>
    ipcRenderer.invoke("menu:popupItem", { index, x }),
  // "Abrir com..." (dialogo nativo do Windows) do arquivo atual
  openWith: (p: string): Promise<boolean | string> => ipcRenderer.invoke("shell:openWith", p),
  // menu Editar > Preferencias (Ctrl+,) manda o app abrir a janela de preferencias
  onOpenPreferences: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on("menu:preferences", handler);
    return () => ipcRenderer.removeListener("menu:preferences", handler);
  },
  // menu Editar > Exportar paleta (.ACT)
  onExportPalette: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on("menu:exportPalette", handler);
    return () => ipcRenderer.removeListener("menu:exportPalette", handler);
  },
};

contextBridge.exposeInMainWorld("api", api);
export type Api = typeof api;
