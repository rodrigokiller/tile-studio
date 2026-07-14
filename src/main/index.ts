import { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, type MenuItemConstructorOptions } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
// electron-updater e CJS: com o main em ESM o named import quebra ("autoUpdater not
// found"), entao importamos o default e desestruturamos.
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

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
  // menu de contexto nos campos editaveis: recortar/copiar/colar (roles nativos, mexem no
  // clipboard do SO respeitando a selecao); em texto selecionado nao-editavel, so copiar.
  win.webContents.on("context-menu", (_e, params) => {
    const { isEditable, editFlags, selectionText } = params;
    const sel = (selectionText ?? "").trim();
    if (!isEditable && !sel) return; // so aparece em campo editavel OU quando ha texto selecionado
    const template: MenuItemConstructorOptions[] = [];
    if (isEditable) {
      template.push({ role: "cut", enabled: editFlags.canCut });
      template.push({ role: "copy", enabled: editFlags.canCopy });
      template.push({ role: "paste", enabled: editFlags.canPaste });
      template.push({ type: "separator" });
      template.push({ role: "selectAll" });
    } else {
      template.push({ role: "copy", enabled: editFlags.canCopy });
    }
    Menu.buildFromTemplate(template).popup({ window: win });
  });
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
        {
          label: "Importar PNG (por cima da vista)...",
          click: () =>
            (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send("menu:importPng"),
        },
        {
          label: "Fechar arquivo",
          accelerator: "CmdOrCtrl+W",
          click: () =>
            (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send("menu:closeFile"),
        },
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
        // dispara o check de update PELO renderer (pra UI do banner aparecer junto)
        {
          label: "Verificar atualizacoes...",
          click: () =>
            (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send("menu:checkUpdates"),
        },
        { type: "separator" },
        // "Sobre" e um modal do renderer (dialog nativo trava o foco no Electron):
        // o main so avisa e o renderer abre o modal proprio
        {
          label: "Sobre o Tile Studio",
          click: () =>
            (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send("menu:about"),
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
let menuSession = 0; // id da abertura atual: o callback de close so para o poll se nada reabriu depois
let menuShownIndex = -1; // qual submenu do topo esta aberto agora (-1 = nenhum). Pro TOGGLE de clique.
// TOGGLE (reclicar o botao aberto = fechar): quando o popup e dispensado por um clique do usuario
// no proprio botao, o mesmo clique tambem dispara o onClick -> popupMenuItem. Registramos o instante
// e o index do dismiss NA HORA (nao com atraso) pra esse popupMenuItem saber que e "o mesmo clique
// reabrindo" e NAO reabrir. hoverSwitching marca os closePopup programaticos do hover (nao contam).
let lastDismissAt = 0;
let lastDismissIndex = -1;
let hoverSwitching = false;

function openTopMenu(win: BrowserWindow, index: number, xDip: number, yDip: number): void {
  const top = menuTemplate[index];
  if (!top || !Array.isArray(top.submenu)) return;
  popupMenu = Menu.buildFromTemplate(top.submenu as MenuItemConstructorOptions[]);
  const session = ++menuSession;
  menuShownIndex = index;
  // avisa o renderer qual botao acender (o hover do CSS nao funciona com o popup capturando o mouse)
  win.webContents.send("menu:openIndex", index);
  popupMenu.popup({
    window: win,
    x: Math.round(xDip),
    y: Math.round(yDip),
    callback: () => {
      // registra o dismiss IMEDIATAMENTE (nao no setTimeout): um clique deliberado pode segurar o
      // botao > 80ms, entao esperar mataria a deteccao do toggle. Fechamentos do hover-switch nao contam.
      if (!hoverSwitching) {
        lastDismissAt = Date.now();
        lastDismissIndex = index;
      }
      hoverSwitching = false;
      // fechou de verdade (Esc/clicou item/fora)? se ninguem reabriu, para o polling e apaga o highlight
      setTimeout(() => {
        if (session === menuSession) {
          if (menuPoll) {
            clearInterval(menuPoll);
            menuPoll = null;
          }
          menuShownIndex = -1;
          if (!win.isDestroyed()) win.webContents.send("menu:openIndex", -1);
        }
      }, 80);
    },
  });
}

ipcMain.handle(
  "menu:popupItem",
  (e, arg: { index: number; x: number; buttons?: MenuBtnRect[]; viewport?: { w: number; h: number } }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    // TOGGLE: reclicar o botao do menu ABERTO = fechar (nao reabrir). Dois sinais:
    //  (A) o clique JA dispensou o popup nativo -> o mesmo clique chega aqui logo em seguida
    //      (lastDismiss recente, mesmo index). Robusto a clique lento (nao depende do 80ms);
    //  (B) o popup ainda esta aberto neste index (o clique nao dispensou) -> fecha via closePopup.
    const justClosedSame = Date.now() - lastDismissAt < 350 && lastDismissIndex === arg.index;
    // CASO A: o proprio clique JA dispensou o popup nativo (dismiss recente, mesmo index). Nao reabre.
    // NAO reseta lastDismiss NEM mexe no hoverSwitching: um mesmo clique gera 2 popupItem (um eco) --
    // o eco tambem cai aqui e continua fechado. lastDismiss expira sozinho em 350ms.
    if (justClosedSame) return;
    // CASO B: o popup ainda esta aberto neste index (clique nao dispensou) -> fecha de fato.
    if (menuShownIndex === arg.index) {
      hoverSwitching = true; // o closePopup abaixo (popup aberto) fecha e dispara o callback -> reseta o flag
      popupMenu?.closePopup(win);
      menuShownIndex = -1;
      lastDismissAt = Date.now(); // marca o fechamento pra o eco deste clique tambem cair no caso A
      lastDismissIndex = arg.index;
      if (menuPoll) {
        clearInterval(menuPoll);
        menuPoll = null;
      }
      if (!win.isDestroyed()) win.webContents.send("menu:openIndex", -1);
      return;
    }
    const buttons = arg.buttons ?? [];
    // os retangulos dos botoes vem em CSS px; o cursor (getCursorScreenPoint) e o contentBounds vem
    // em DIP. Com zoom/DPI, CSS != DIP -> o erro CRESCIA com a distancia do botao. sx/sy = razao
    // CSS/DIP (viewport / contentBounds); converto o cursor DIP->CSS (pra detectar o botao) e as
    // posicoes CSS->DIP (pra posicionar o popup). Sem viewport (fallback) assume 1:1.
    const cb0 = win.getContentBounds();
    const sx = arg.viewport && cb0.width ? arg.viewport.w / cb0.width : 1; // CSS px por DIP (X)
    const sy = arg.viewport && cb0.height ? arg.viewport.h / cb0.height : 1;
    const yDip = 34 / sy; // a barra tem 34 CSS px -> DIP
    let current = arg.index;
    openTopMenu(win, current, arg.x / sx, yDip);
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
      const x = (pt.x - cb.x) * sx; // cursor em CSS px (mesma unidade dos retangulos)
      const y = (pt.y - cb.y) * sy;
      if (y < 0 || y >= 34) return; // so vale na faixa da barra de titulo (34 CSS px)
      const hit = buttons.find((b) => x >= b.x1 && x < b.x2);
      if (hit && hit.index !== current) {
        current = hit.index;
        hoverSwitching = true; // fechamento programatico do hover: nao conta como dismiss (toggle)
        popupMenu?.closePopup(win);
        openTopMenu(win, current, hit.x1 / sx, yDip); // hit.x1 CSS -> DIP
      }
    }, 60);
  },
);

// infos pro modal Sobre (versao do package.json empacotado + runtimes)
ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

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

// --- auto-update (electron-updater) ------------------------------------------
// O usuario decide baixar/instalar: autoDownload fica DESLIGADO e o renderer mostra
// um banner conforme o status. Feed: GitHub Releases (bloco "publish" do package.json).
// Tudo em try/catch: repo/release inexistente NAO pode derrubar o app.
autoUpdater.autoDownload = false;

// TESTE LOCAL do auto-update: com a env var UPDATE_FEED_URL setada (ex. http://localhost:8765),
// o feed vira um servidor "generic" local em vez do GitHub -- da pra ensaiar o fluxo inteiro
// (detectar -> baixar -> reinstalar) servindo a pasta release/ com qualquer servidor estatico.
// So faz sentido no app empacotado (em dev o check responde "dev" sem tocar no feed).
if (app.isPackaged && process.env.UPDATE_FEED_URL) {
  autoUpdater.setFeedURL({ provider: "generic", url: process.env.UPDATE_FEED_URL });
}

type UpdState = "checking" | "available" | "none" | "downloading" | "downloaded" | "error" | "dev";
type UpdStatus = { state: UpdState; version?: string; percent?: number; error?: string };

// mensagem de erro CURTA pro banner (1a linha, sem stack)
const shortErr = (e: unknown): string =>
  String((e as Error)?.message ?? e).split("\n")[0].slice(0, 160);

// manda o status pra todas as janelas (o banner vive no renderer)
function sendUpdStatus(s: UpdStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("upd:status", s);
  }
}

autoUpdater.on("checking-for-update", () => sendUpdStatus({ state: "checking" }));
autoUpdater.on("update-available", (info) => sendUpdStatus({ state: "available", version: info.version }));
autoUpdater.on("update-not-available", () => sendUpdStatus({ state: "none" }));
autoUpdater.on("download-progress", (p) =>
  sendUpdStatus({ state: "downloading", percent: Math.round(p.percent) }),
);
autoUpdater.on("update-downloaded", (info) => sendUpdStatus({ state: "downloaded", version: info.version }));
autoUpdater.on("error", (e) => sendUpdStatus({ state: "error", error: shortErr(e) }));

// check: em dev (nao empacotado) responde "dev" -- a UI avisa que so funciona instalado
ipcMain.handle("upd:check", async () => {
  if (!app.isPackaged) {
    sendUpdStatus({ state: "dev" });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    sendUpdStatus({ state: "error", error: shortErr(e) }); // o evento "error" pode nao cobrir tudo
  }
});
ipcMain.handle("upd:download", async () => {
  if (!app.isPackaged) return;
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    sendUpdStatus({ state: "error", error: shortErr(e) });
  }
});
ipcMain.handle("upd:install", () => {
  if (!app.isPackaged) return;
  try {
    autoUpdater.quitAndInstall();
  } catch (e) {
    sendUpdStatus({ state: "error", error: shortErr(e) });
  }
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
