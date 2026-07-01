import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
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
}

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

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
