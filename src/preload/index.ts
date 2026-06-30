import { contextBridge, ipcRenderer, webUtils } from "electron";

const api = {
  openFile: (): Promise<string | null> => ipcRenderer.invoke("dialog:openFile"),
  openPng: (): Promise<string | null> => ipcRenderer.invoke("dialog:openPng"),
  savePng: (def: string): Promise<string | null> => ipcRenderer.invoke("dialog:savePng", def),
  readFile: (p: string): Promise<Uint8Array> => ipcRenderer.invoke("fs:readFile", p),
  writeFile: (p: string, data: Uint8Array): Promise<boolean> =>
    ipcRenderer.invoke("fs:writeFile", p, data),
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
};

contextBridge.exposeInMainWorld("api", api);
export type Api = typeof api;
