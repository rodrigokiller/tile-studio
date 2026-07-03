import { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, type MenuItemConstructorOptions } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// guardado pra popar cada submenu como um Menu NOVO (popar um submenu que ja pertence ao
// applicationMenu nao funciona de forma confiavel no Electron)
let menuTemplate: MenuItemConstructorOptions[] = [];
// estado dinamico do menu: o item "Exportar paleta (.ACT)" so habilita nos bpp indexados.
// e uma var de modulo (nao getMenuItemById) pra o template refletir e o popup ler certo.
let exportPaletteEnabled = false;

// O Tile Studio abre 1 arquivo por janela; suporta multiplas janelas.
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0e10",
    title: "Tile Studio",
    // barra de titulo custom (estilo VS Code): escondemos a nativa e desenhamos a nossa no
    // renderer (com o botao de menu ☰), deixando o overlay do Windows com min/max/fechar.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0c0f12", symbolColor: "#8aa39b", height: 34 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}

// -- arquivos recentes + ultimo aberto (persistidos no userData) --------------
const recentsPath = (): string => join(app.getPath("userData"), "recents.json");

function readRecents(): { last: string; recent: string[] } {
  try {
    const r = JSON.parse(readFileSync(recentsPath(), "utf8"));
    return { last: r.last ?? "", recent: Array.isArray(r.recent) ? r.recent : [] };
  } catch {
    return { last: "", recent: [] };
  }
}

function addRecent(path: string): void {
  const r = readRecents();
  const recent = [path, ...r.recent.filter((p) => p !== path)].slice(0, 8);
  writeFileSync(recentsPath(), JSON.stringify({ last: path, recent }));
  buildMenu();
}

// pede pro renderer da janela ativa carregar um arquivo
function sendOpenFile(path: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send("menu:openFile", path);
}

async function openFileDialog(): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const r = await dialog.showOpenDialog(win!, { properties: ["openFile"] });
  if (!r.canceled && r.filePaths[0]) sendOpenFile(r.filePaths[0]);
}

function buildMenu(): void {
  const { recent } = readRecents();
  const openRecent: MenuItemConstructorOptions[] = recent.length
    ? recent.flatMap((p, i) => [
        { label: p, click: () => sendOpenFile(p) },
        // "Abrir com..." (dialogo nativo do Windows) do arquivo mais recente
        ...(i === 0
          ? [
              { type: "separator" } as MenuItemConstructorOptions,
              { label: `Abrir "${p.split(/[\\/]/).pop()}" com...`, click: () => openWith(p) } as MenuItemConstructorOptions,
              { type: "separator" } as MenuItemConstructorOptions,
            ]
          : []),
      ])
    : [{ label: "(nenhum)", enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    {
      label: "Arquivo",
      submenu: [
        { label: "Nova janela", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { type: "separator" },
        { label: "Abrir arquivo...", accelerator: "CmdOrCtrl+O", click: () => openFileDialog() },
        { label: "Abrir recente", submenu: openRecent },
        { type: "separator" },
        { role: "quit", label: "Sair" },
      ],
    },
    {
      label: "Editar",
      submenu: [
        { role: "undo", label: "Desfazer" },
        { role: "redo", label: "Refazer" },
        { type: "separator" },
        { role: "cut", label: "Recortar" },
        { role: "copy", label: "Copiar" },
        { role: "paste", label: "Colar" },
        { role: "selectAll", label: "Selecionar tudo" },
        { type: "separator" },
        {
          label: "Exportar paleta (.ACT)...",
          enabled: exportPaletteEnabled, // so habilita nos bpp indexados (renderer atualiza)
          click: () =>
            (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send("menu:exportPalette"),
        },
        { type: "separator" },
        {
          label: "Preferencias...",
          accelerator: "CmdOrCtrl+,",
          click: () =>
            (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send("menu:preferences"),
        },
      ],
    },
    {
      label: "Exibir",
      submenu: [
        { role: "reload", label: "Recarregar" },
        { role: "toggleDevTools", label: "Ferramentas de desenvolvedor" },
        { type: "separator" },
        { role: "resetZoom", label: "Zoom padrao" },
        { role: "zoomIn", label: "Aumentar zoom" },
        { role: "zoomOut", label: "Diminuir zoom" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Tela cheia" },
      ],
    },
    { label: "Janela", submenu: [{ role: "minimize", label: "Minimizar" }, { role: "close", label: "Fechar" }] },
    {
      label: "Ajuda",
      submenu: [
        {
          label: "Sobre o Tile Studio",
          click: () =>
            dialog.showMessageBox({
              type: "info",
              title: "Tile Studio",
              message: "Tile Studio",
              detail: "Editor/visualizador de tiles graficos (estilo Tile Molester). Parte da suite com TIM Studio e LoM Studio.",
            }),
        },
      ],
    },
  ];
  menuTemplate = template; // guarda pra os botoes da barra poparem cada submenu como menu novo
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// abre o menu do app (Arquivo/Editar/...) como popup -- com a barra de titulo custom,
// o menu nativo do Windows fica escondido; os botoes da barra chamam isto.
ipcMain.handle("menu:popup", (e) => {
  const m = Menu.getApplicationMenu();
  const win = BrowserWindow.fromWebContents(e.sender);
  if (m && win) m.popup({ window: win, x: 8, y: 34 });
});
// abre o submenu de UM item do topo (0=Arquivo,1=Editar,...) na posicao x do botao (barra de titulo).
// constroi um Menu NOVO a partir do template do submenu -- popar o submenu que ja pertence ao
// applicationMenu nao funciona de forma confiavel no Electron.
//
// Hover entre menus (padrao Windows: com um menu aberto, passar o mouse por outro botao troca
// o menu sem clicar): o popup nativo CAPTURA o mouse, entao o renderer manda os retangulos dos
// botoes e o main faz polling do cursor; sobre outro botao -> fecha e reabre o submenu daquele.
// O renderer recebe menu:openIndex pra acender o botao certo (o :hover do CSS congela).
type MenuBtnRect = { index: number; x1: number; x2: number };
let popupMenu: Menu | null = null; // ref de modulo: o Menu do popup nao pode ser coletado pelo GC
let menuPoll: ReturnType<typeof setInterval> | null = null;
let menuSession = 0; // id da abertura atual: o callback de close so limpa se nada reabriu depois

function openTopMenu(win: BrowserWindow, index: number, x: number): void {
  const top = menuTemplate[index];
  if (!top || !Array.isArray(top.submenu)) return;
  popupMenu = Menu.buildFromTemplate(top.submenu as MenuItemConstructorOptions[]);
  const session = ++menuSession;
  win.webContents.send("menu:openIndex", index);
  popupMenu.popup({
    window: win,
    x: Math.round(x),
    y: 34,
    callback: () => {
      // fechou de verdade (Esc/clicou item/fora)? para o polling e apaga o highlight
      setTimeout(() => {
        if (session === menuSession) {
          if (menuPoll) {
            clearInterval(menuPoll);
            menuPoll = null;
          }
          if (!win.isDestroyed()) win.webContents.send("menu:openIndex", -1);
        }
      }, 80);
    },
  });
}

ipcMain.handle("menu:popupItem", (e, arg: { index: number; x: number; buttons?: MenuBtnRect[] }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const buttons = arg.buttons ?? [];
  let current = arg.index;
  openTopMenu(win, current, arg.x);
  if (menuPoll) clearInterval(menuPoll);
  if (!buttons.length) return; // sem retangulos nao tem como fazer hover
  menuPoll = setInterval(() => {
    if (win.isDestroyed()) {
      if (menuPoll) clearInterval(menuPoll);
      menuPoll = null;
      return;
    }
    const pt = screen.getCursorScreenPoint();
    const cb = win.getContentBounds();
    const x = pt.x - cb.x;
    const y = pt.y - cb.y;
    if (y < 0 || y >= 34) return; // so vale na faixa da barra de titulo
    const hit = buttons.find((b) => x >= b.x1 && x < b.x2);
    if (hit && hit.index !== current) {
      current = hit.index;
      popupMenu?.closePopup(win);
      openTopMenu(win, current, hit.x1);
    }
  }, 60);
});

// abre o dialogo nativo "Abrir com..." do Windows (escolher o programa); fallback pro padrao
function openWith(p: string): boolean | Promise<string> {
  if (process.platform === "win32") {
    const ps = spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", p], { detached: true, stdio: "ignore" });
    ps.unref(); // solta o processo pra nao prender o app
    return true;
  }
  return shell.openPath(p);
}

// -- dialogs/IPC --------------------------------------------------------------
ipcMain.handle("dialog:openFile", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openFile"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("dialog:openPng", async () => {
  const r = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("dialog:savePng", async (_e, def: string) => {
  const r = await dialog.showSaveDialog({
    defaultPath: def,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle("dialog:saveBin", async (_e, def: string) => {
  const r = await dialog.showSaveDialog({ defaultPath: def });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle("dialog:saveAct", async (_e, def: string) => {
  const r = await dialog.showSaveDialog({
    defaultPath: def,
    filters: [{ name: "Adobe Color Table", extensions: ["act"] }],
  });
  return r.canceled ? null : r.filePath;
});
// habilita/desabilita o item "Exportar paleta" no menu Editar (o renderer chama conforme o bpp).
// atualiza a var de modulo e reconstroi o menu, pra o template (que o popup le) refletir.
ipcMain.handle("menu:setPaletteEnabled", (_e, on: boolean) => {
  if (exportPaletteEnabled === on) return;
  exportPaletteEnabled = on;
  buildMenu();
});
ipcMain.handle("fs:readFile", (_e, p: string) => readFileSync(p));
ipcMain.handle("fs:writeFile", (_e, p: string, data: Uint8Array) => {
  writeFileSync(p, Buffer.from(data));
  return true;
});

// "Abrir com..." tambem exposto pro renderer (ex.: botao do arquivo atual)
ipcMain.handle("shell:openWith", (_e, p: string) => openWith(p));

// recentes: o renderer avisa qual arquivo abriu (setLast) e pergunta o ultimo (getLast)
ipcMain.handle("file:setLast", (_e, p: string) => addRecent(p));
ipcMain.handle("file:getLast", () => {
  const last = readRecents().last;
  return last && existsSync(last) ? last : ""; // so reabre se ainda existir
});

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
