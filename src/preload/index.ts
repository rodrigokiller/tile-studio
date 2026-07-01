import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

const api = {
  openFile: (): Promise<string | null> => ipcRenderer.invoke("dialog:openFile"),
  openPng: (): Promise<string | null> => ipcRenderer.invoke("dialog:openPng"),
  savePng: (def: string): Promise<string | null> => ipcRenderer.invoke("dialog:savePng", def),
  saveBin: (def: string): Promise<string | null> => ipcRenderer.invoke("dialog:saveBin", def),
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
};

contextBridge.exposeInMainWorld("api", api);
export type Api = typeof api;
