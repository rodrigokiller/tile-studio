import { app, BrowserWindow, ipcMain, dialog, Menu, type MenuItemConstructorOptions } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// O Tile Studio abre 1 arquivo por janela; suporta multiplas janelas.
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0e10",
    title: "Tile Studio",
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
    ? recent.map((p) => ({ label: p, click: () => sendOpenFile(p) }))
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
ipcMain.handle("fs:readFile", (_e, p: string) => readFileSync(p));
ipcMain.handle("fs:writeFile", (_e, p: string, data: Uint8Array) => {
  writeFileSync(p, Buffer.from(data));
  return true;
});

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
