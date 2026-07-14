import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

// status do auto-update (main -> renderer via "upd:status"); "dev" = rodando sem empacotar
export type UpdStatus = {
  state: "checking" | "available" | "none" | "downloading" | "downloaded" | "error" | "dev";
  version?: string;
  percent?: number;
  error?: string;
};

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
  // buttons = retangulos de todos os botoes (hover-switch estilo Windows, feito no main);
  // viewport = tamanho da janela em CSS px (o main converte CSS<->DIP pro popup cair certo com zoom/DPI)
  popupMenuItem: (
    index: number,
    x: number,
    buttons?: { index: number; x1: number; x2: number }[],
    viewport?: { w: number; h: number },
  ): Promise<void> => ipcRenderer.invoke("menu:popupItem", { index, x, buttons, viewport }),
  // indice do menu aberto na barra (-1 = fechou): acende o botao certo durante o hover-switch
  onMenuOpenIndex: (cb: (i: number) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, i: number): void => cb(i);
    ipcRenderer.on("menu:openIndex", handler);
    return () => ipcRenderer.removeListener("menu:openIndex", handler);
  },
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
  // Arquivo > Fechar arquivo / Importar PNG; Ajuda > Sobre / Verificar atualizacoes
  onMenuSimple: (
    channel: "menu:closeFile" | "menu:importPng" | "menu:about" | "menu:checkUpdates",
    cb: () => void,
  ): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  // infos pro modal Sobre (versao + runtimes)
  appInfo: (): Promise<{ version: string; electron: string; chrome: string; node: string }> =>
    ipcRenderer.invoke("app:info"),
  // --- auto-update ------------------------------------------------------------
  updCheck: (): Promise<void> => ipcRenderer.invoke("upd:check"),
  updDownload: (): Promise<void> => ipcRenderer.invoke("upd:download"),
  updInstall: (): Promise<void> => ipcRenderer.invoke("upd:install"),
  // stream de status do updater (checking/available/none/downloading/downloaded/error/dev)
  onUpdStatus: (cb: (s: UpdStatus) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, s: UpdStatus): void => cb(s);
    ipcRenderer.on("upd:status", h);
    return () => ipcRenderer.removeListener("upd:status", h);
  },
};

contextBridge.exposeInMainWorld("api", api);
export type Api = typeof api;
