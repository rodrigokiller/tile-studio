import { useEffect, useMemo, useRef, useState, useCallback, type DragEvent } from "react";
import {
  decodeTiles,
  grayPaletteRGBA,
  tileSizeBytes,
  writePixelIndex,
  readPixelIndex,
  locatePixel,
  rgbToDirect,
  directToRgb,
  type TileConfig,
  type PixelMode,
} from "../../tile";
import {
  BUILTIN_CONFIG_PRESETS,
  BUILTIN_PALETTE_PRESETS,
  loadCustomConfigs,
  saveCustomConfigs,
  loadCustomPalettes,
  saveCustomPalettes,
  type ConfigPreset,
  type PalettePreset,
} from "./presets";

// teto do historico de undo (descarta as entradas mais antigas ao passar)
const MAX_UNDO = 200;

// -- helpers de paleta --------------------------------------------------------

async function pngToRgba(bytes: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/png" }));
  const cv = document.createElement("canvas");
  cv.width = bmp.width;
  cv.height = bmp.height;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: bmp.width, height: bmp.height, rgba: new Uint8Array(d.data.buffer) };
}

/** Extrai ate `count` cores unicas de um RGBA (ex.: de um PNG de paleta). */
function paletteFromRgba(rgba: Uint8Array, count: number): Uint8Array {
  const pal = new Uint8Array(count * 4);
  const seen = new Set<number>();
  let n = 0;
  for (let i = 0; i < rgba.length && n < count; i += 4) {
    const key = (rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3];
    if (seen.has(key)) continue;
    seen.add(key);
    pal.set(rgba.subarray(i, i + 4), n * 4);
    n++;
  }
  for (; n < count; n++) {
    const v = count <= 1 ? 0 : Math.round((n / (count - 1)) * 255);
    pal[n * 4] = pal[n * 4 + 1] = pal[n * 4 + 2] = v;
    pal[n * 4 + 3] = 255;
  }
  return pal;
}

const hex2 = (n: number): string => n.toString(16).padStart(2, "0");
const rgbaToHex = (p: Uint8Array, i: number): string =>
  `#${hex2(p[i * 4])}${hex2(p[i * 4 + 1])}${hex2(p[i * 4 + 2])}`;

// Uma edicao de pixel = 1 byte que mudou (offset, valor antigo, valor novo).
// Um "stroke" (do mousedown ao mouseup) agrupa varias dessas mudancas.
type ByteChange = { off: number; old: number; neu: number };

// -----------------------------------------------------------------------------

export function App(): JSX.Element {
  const [path, setPath] = useState<string | null>(null);
  const [raw, setRaw] = useState<Uint8Array | null>(null);
  const [dirty, setDirty] = useState(false);

  const [bpp, setBpp] = useState<TileConfig["bpp"]>(1);
  const [mode, setMode] = useState<PixelMode>("planar");
  const [tileW, setTileW] = useState(16);
  const [tileH, setTileH] = useState(12);
  const [cols, setCols] = useState(16);
  const [tileRows, setTileRows] = useState(16); // quantas linhas de tiles mostrar
  const [reverse, setReverse] = useState(false);
  const [offset, setOffset] = useState(0);
  const [zoom, setZoom] = useState(4);

  const [palette, setPalette] = useState<Uint8Array | null>(null);
  const [palIndex, setPalIndex] = useState(1); // cor "de frente" (indice que pinta, bpp<=8)
  const [dirColor, setDirColor] = useState("#34e2a0"); // cor RGB de pintura (16/24bpp)
  const [dirStp, setDirStp] = useState(false); // bit STP/mascara pra 16bpp
  const [showGrid, setShowGrid] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  // preferencias persistidas (localStorage)
  const [showPrefs, setShowPrefs] = useState(false);
  const [reopenLast, setReopenLast] = useState(
    () => localStorage.getItem("tilestudio:reopenLast") !== "0", // default: liga
  );
  const [initialTool, setInitialTool] = useState<"edit" | "pan">(
    () => (localStorage.getItem("tilestudio:initialTool") === "pan" ? "pan" : "edit"),
  );

  // ferramenta ativa: editar (pinta) ou navegar (pan). Espaco/Ctrl = pan temporario.
  const [tool, setTool] = useState<"edit" | "pan">(initialTool);
  const [tempPan, setTempPan] = useState(false);

  // presets: customizados (persistidos) + selecao atual nos dropdowns
  const [customCfgs, setCustomCfgs] = useState<ConfigPreset[]>(() => loadCustomConfigs());
  const [customPals, setCustomPals] = useState<PalettePreset[]>(() => loadCustomPalettes());
  const [cfgPresetName, setCfgPresetName] = useState("");
  const [palPresetName, setPalPresetName] = useState("");
  const [selCfg, setSelCfg] = useState(""); // nome do preset de config selecionado
  const [selPal, setSelPal] = useState(""); // nome da paleta selecionada

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<HTMLElement>(null);
  const indexed = bpp <= 8;
  const ncolors = indexed ? 1 << bpp : 0;

  const panning = tool === "pan" || tempPan;

  // paleta efetiva (cinza por padrao para bpp baixos)
  const effPal = useMemo(() => {
    if (!indexed) return undefined;
    if (palette && palette.length >= ncolors * 4) return palette;
    return grayPaletteRGBA(ncolors);
  }, [palette, indexed, ncolors]);

  const cfg: TileConfig = useMemo(
    () => ({
      bpp,
      mode,
      tileW: Math.max(1, tileW),
      tileH: Math.max(1, tileH),
      cols: Math.max(1, cols),
      tileCount: Math.max(1, cols) * Math.max(1, tileRows),
      reverse,
      byteOffset: offset,
      palette: effPal,
    }),
    [bpp, mode, tileW, tileH, cols, tileRows, reverse, offset, effPal],
  );

  // -- pilha de undo/redo: guarda SO edicoes de bytes (nunca estado de view) ---
  const undoStack = useRef<ByteChange[][]>([]);
  const redoStack = useRef<ByteChange[][]>([]);
  const [histLen, setHistLen] = useState({ u: 0, r: 0 }); // so pra atualizar UI

  const open = useCallback(async (p?: string) => {
    const file = p ?? (await window.api.openFile());
    if (!file) return;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await window.api.readFile(file));
    } catch {
      setMsg(`nao consegui abrir: ${file}`);
      return;
    }
    setPath(file);
    setRaw(bytes);
    setOffset(0);
    setDirty(false);
    setMsg(null);
    // arquivo novo: zera a historia de edicao
    undoStack.current = [];
    redoStack.current = [];
    setHistLen({ u: 0, r: 0 });
    // registra nos recentes (alimenta o menu "Abrir recente" e o reabrir-ao-iniciar)
    window.api.setLastFile(file);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) open(window.api.pathForFile(f));
    },
    [open],
  );

  // menu (Abrir arquivo / Abrir recente) manda o caminho pra carregar aqui
  useEffect(() => window.api.onOpenFile((p) => open(p)), [open]);

  // menu Editar > Preferencias (Ctrl+,) abre a janela de preferencias
  useEffect(() => window.api.onOpenPreferences(() => setShowPrefs(true)), []);

  // Esc fecha a janela de preferencias
  useEffect(() => {
    if (!showPrefs) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setShowPrefs(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showPrefs]);

  // ao iniciar: reabre o ultimo arquivo automaticamente (se a preferencia estiver ligada e ele existir)
  useEffect(() => {
    if (!reopenLast) return;
    (async () => {
      const last = await window.api.getLastFile();
      if (last) open(last);
    })();
    // so na montagem; open e estavel (useCallback [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = useMemo(() => {
    if (!raw) return null;
    try {
      return decodeTiles(raw, cfg);
    } catch {
      return null;
    }
  }, [raw, cfg]);

  // desenha o canvas + grid de tiles
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !view) return;
    cv.width = view.width;
    cv.height = view.height;
    const ctx = cv.getContext("2d")!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(view.rgba), view.width, view.height), 0, 0);
    if (showGrid && (tileW > 1 || tileH > 1)) {
      ctx.strokeStyle = "rgba(52,226,160,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= view.width; x += tileW) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, view.height);
      }
      for (let y = 0; y <= view.height; y += tileH) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(view.width, y + 0.5);
      }
      ctx.stroke();
    }
  }, [view, showGrid, tileW, tileH]);

  // navegacao pelo arquivo: 1 linha de tiles = cols tiles
  const bytesPerTile = tileSizeBytes(cfg);
  const bytesPerTileRow = bytesPerTile * Math.max(1, cols);
  const step = (mult: number) => setOffset((o) => Math.max(0, o + bytesPerTileRow * mult));

  // -- undo/redo: aplica um conjunto de mudancas de bytes ----------------------
  const applyChanges = useCallback((changes: ByteChange[], useOld: boolean) => {
    setRaw((cur) => {
      if (!cur) return cur;
      const next = new Uint8Array(cur);
      for (const c of changes) next[c.off] = useOld ? c.old : c.neu;
      return next;
    });
    setDirty(true);
  }, []);

  const undo = useCallback(() => {
    const changes = undoStack.current.pop();
    if (!changes) return;
    applyChanges(changes, true); // reverte pros valores antigos
    redoStack.current.push(changes);
    setHistLen({ u: undoStack.current.length, r: redoStack.current.length });
    setMsg("desfez edicao");
  }, [applyChanges]);

  const redo = useCallback(() => {
    const changes = redoStack.current.pop();
    if (!changes) return;
    applyChanges(changes, false); // reaplica os valores novos
    undoStack.current.push(changes);
    setHistLen({ u: undoStack.current.length, r: redoStack.current.length });
    setMsg("refez edicao");
  }, [applyChanges]);

  // teclado: navegacao + undo/redo. Undo/redo so quando o foco NAO esta num
  // campo de texto (input/select) -- assim o Ctrl+Z nativo dos campos continua ok.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inField = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";

      // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z -> undo/redo de EDICAO (nunca de view)
      if ((e.ctrlKey || e.metaKey) && !inField) {
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); return; }
      }

      if (inField) return;
      if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
      else if (e.key === "PageDown") { e.preventDefault(); step(tileRows); }
      else if (e.key === "PageUp") { e.preventDefault(); step(-tileRows); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bytesPerTileRow, tileRows, undo, redo]);

  // Espaco (segurar) = pan temporario enquanto o foco nao esta num campo.
  useEffect(() => {
    const isField = () => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isField()) { e.preventDefault(); setTempPan(true); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setTempPan(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // valor que a pintura grava: indice de paleta (bpp<=8) ou cor direta empacotada (16/24)
  const paintValue = useMemo(() => {
    if (indexed) return palIndex;
    const r = parseInt(dirColor.slice(1, 3), 16);
    const g = parseInt(dirColor.slice(3, 5), 16);
    const b = parseInt(dirColor.slice(5, 7), 16);
    return rgbToDirect(bpp as 16 | 24, r, g, b, dirStp ? 1 : 0);
  }, [indexed, palIndex, dirColor, dirStp, bpp]);

  // -- pintura (agrupa mudancas do stroke atual pra 1 entrada de undo) ---------
  const stroke = useRef<Map<number, ByteChange> | null>(null);

  const paintAt = useCallback(
    (clientX: number, clientY: number) => {
      const cv = canvasRef.current;
      if (!cv || !raw || !stroke.current) return;
      const rect = cv.getBoundingClientRect();
      const x = Math.floor(((clientX - rect.left) / rect.width) * cv.width);
      const y = Math.floor(((clientY - rect.top) / rect.height) * cv.height);
      if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return;
      const loc = locatePixel(cfg, x, y);
      const value = paintValue;

      // snapshot dos bytes antes: le, escreve, e compara pra registrar so o que mudou
      const before = new Uint8Array(raw);
      const prevIdx = readPixelIndex(raw, cfg, loc.tileBase, loc.px, loc.py);
      if (prevIdx === value) return; // ja e essa cor, nada a fazer
      writePixelIndex(raw, cfg, loc.tileBase, loc.px, loc.py, value);
      // registra os bytes que mudaram neste pixel (planar toca varios bytes)
      const tsz = tileSizeBytes(cfg);
      for (let o = loc.tileBase; o < loc.tileBase + tsz && o < raw.length; o++) {
        if (before[o] !== raw[o]) {
          const existing = stroke.current.get(o);
          // preserva o "old" da 1a vez que este byte mudou no stroke
          stroke.current.set(o, { off: o, old: existing ? existing.old : before[o], neu: raw[o] });
        }
      }
      setRaw(new Uint8Array(raw)); // dispara re-render
      setDirty(true);
    },
    [raw, cfg, paintValue],
  );

  // conta-gotas (Alt+clique): pica a cor do pixel como cor de pintura. NAO entra no undo
  // (nao altera bytes). Indexado -> seleciona o indice; direto (16/24) -> seta o RGB.
  const pickAt = useCallback(
    (clientX: number, clientY: number) => {
      const cv = canvasRef.current;
      if (!cv || !raw) return;
      const rect = cv.getBoundingClientRect();
      const x = Math.floor(((clientX - rect.left) / rect.width) * cv.width);
      const y = Math.floor(((clientY - rect.top) / rect.height) * cv.height);
      if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return;
      const loc = locatePixel(cfg, x, y);
      const val = readPixelIndex(raw, cfg, loc.tileBase, loc.px, loc.py);
      if (indexed) {
        setPalIndex(val);
        setMsg(`conta-gotas: indice ${val}`);
      } else {
        const c = directToRgb(bpp as 16 | 24, val);
        setDirColor(`#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`);
        if (bpp === 16) setDirStp(!!c.stp);
        setMsg(`conta-gotas: #${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`);
      }
    },
    [raw, cfg, indexed, bpp],
  );

  const dragging = useRef(false);
  const panStart = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  const onCanvasDown = (e: React.MouseEvent) => {
    // Alt+clique = conta-gotas (pica a cor), sem pintar nem entrar no pan
    if (e.altKey) {
      e.preventDefault();
      pickAt(e.clientX, e.clientY);
      return;
    }
    if (panning) {
      // inicia pan: guarda posicao inicial e scroll atual do viewer
      const v = viewerRef.current;
      if (!v) return;
      panStart.current = { x: e.clientX, y: e.clientY, sl: v.scrollLeft, st: v.scrollTop };
      dragging.current = true;
      e.preventDefault();
      return;
    }
    dragging.current = true;
    stroke.current = new Map(); // comeca um novo stroke (indexado ou cor direta)
    paintAt(e.clientX, e.clientY);
  };

  const onCanvasMove = (e: React.MouseEvent) => {
    if (!dragging.current) return;
    if (panning) {
      const v = viewerRef.current;
      const ps = panStart.current;
      if (!v || !ps) return;
      v.scrollLeft = ps.sl - (e.clientX - ps.x);
      v.scrollTop = ps.st - (e.clientY - ps.y);
      return;
    }
    paintAt(e.clientX, e.clientY);
  };

  // fim do stroke/pan em qualquer lugar: fecha o stroke e empilha no undo
  useEffect(() => {
    const up = () => {
      dragging.current = false;
      panStart.current = null;
      if (stroke.current && stroke.current.size > 0) {
        undoStack.current.push([...stroke.current.values()]);
        // teto do historico: descarta as entradas mais antigas
        if (undoStack.current.length > MAX_UNDO) {
          undoStack.current.splice(0, undoStack.current.length - MAX_UNDO);
        }
        redoStack.current = []; // nova edicao invalida o redo
        setHistLen({ u: undoStack.current.length, r: 0 });
      }
      stroke.current = null;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // -- paleta editavel --------------------------------------------------------
  const setPalColor = useCallback(
    (i: number, hexColor: string) => {
      const base = (palette && palette.length >= ncolors * 4 ? palette : grayPaletteRGBA(ncolors)).slice();
      const r = parseInt(hexColor.slice(1, 3), 16);
      const g = parseInt(hexColor.slice(3, 5), 16);
      const b = parseInt(hexColor.slice(5, 7), 16);
      base[i * 4] = r;
      base[i * 4 + 1] = g;
      base[i * 4 + 2] = b;
      base[i * 4 + 3] = 255;
      setPalette(base);
    },
    [palette, ncolors],
  );

  // color-picker unico e compartilhado; abrimos ele programaticamente pro indice
  // que o usuario quer EDITAR (clique-direito / shift-clique numa celula, ou clique
  // no swatch grande). O clique-esquerdo simples so SELECIONA o indice de pintura.
  const colorInputRef = useRef<HTMLInputElement>(null);
  const editingIdx = useRef(0);
  const openPicker = useCallback(
    (i: number) => {
      if (!effPal) return;
      editingIdx.current = i;
      const inp = colorInputRef.current;
      if (!inp) return;
      inp.value = rgbaToHex(effPal, i); // parte da cor atual daquele indice
      inp.click(); // abre o dialogo nativo de cor
    },
    [effPal],
  );

  const loadPalette = useCallback(async () => {
    const png = await window.api.openPng();
    if (!png) return;
    const { rgba } = await pngToRgba(await window.api.readFile(png));
    setPalette(paletteFromRgba(rgba, ncolors));
    setMsg(`paleta carregada (${ncolors} cores)`);
  }, [ncolors]);

  // -- salvar de volta no arquivo ---------------------------------------------
  const save = useCallback(async () => {
    if (!raw || !path) return;
    await window.api.writeFile(path, raw);
    setDirty(false);
    setMsg(`salvo: ${path.split(/[\\/]/).pop()}`);
  }, [raw, path]);

  const saveAs = useCallback(async () => {
    if (!raw) return;
    const def = path ?? "tiles.bin";
    const out = await window.api.saveBin(def.split(/[\\/]/).pop() ?? "tiles.bin");
    if (!out) return;
    await window.api.writeFile(out, raw);
    setPath(out);
    setDirty(false);
    setMsg(`salvo: ${out.split(/[\\/]/).pop()}`);
  }, [raw, path]);

  const exportPng = useCallback(async () => {
    if (!view) return;
    const cv = document.createElement("canvas");
    cv.width = view.width;
    cv.height = view.height;
    cv.getContext("2d")!.putImageData(
      new ImageData(new Uint8ClampedArray(view.rgba), view.width, view.height),
      0,
      0,
    );
    const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/png"));
    if (!blob) return;
    const def = (path?.replace(/\.[^.\\/]+$/, "") ?? "tiles") + ".png";
    const out = await window.api.savePng(def.split(/[\\/]/).pop() ?? "tiles.png");
    if (!out) return;
    await window.api.writeFile(out, new Uint8Array(await blob.arrayBuffer()));
    setMsg(`PNG salvo: ${out.split(/[\\/]/).pop()}`);
  }, [view, path]);

  const num = (v: number, set: (n: number) => void, min = 0) => (
    <input type="number" value={v} min={min} onChange={(e) => set(Math.max(min, +e.target.value))} />
  );

  // -- presets de config -------------------------------------------------------
  // lista completa (embutidos + customizados) pros dropdowns
  const allCfgs = useMemo<ConfigPreset[]>(
    () => [...BUILTIN_CONFIG_PRESETS, ...customCfgs],
    [customCfgs],
  );

  // aplica um preset: seta o estado de VIEW inteiro de uma vez. NAO toca undo/redo,
  // nem os bytes da imagem, nem o modo editar/navegar.
  const applyConfigPreset = useCallback((p: ConfigPreset) => {
    setBpp(p.bpp);
    setMode(p.mode);
    setReverse(p.reverse);
    setTileW(p.tileW);
    setTileH(p.tileH);
    setCols(p.cols);
    setOffset(p.offset);
    setZoom(p.zoom);
    setSelCfg(p.name);
    setMsg(`preset aplicado: ${p.name}`);
  }, []);

  // salva a config atual como um preset customizado (ou sobrescreve se ja existir)
  const saveConfigPreset = useCallback(() => {
    const name = cfgPresetName.trim();
    if (!name) { setMsg("de um nome pro preset"); return; }
    if (BUILTIN_CONFIG_PRESETS.some((b) => b.name === name)) {
      setMsg("nome reservado (embutido); escolha outro");
      return;
    }
    const p: ConfigPreset = { name, bpp, mode, reverse, tileW, tileH, cols, offset, zoom, builtin: false };
    setCustomCfgs((prev) => {
      const next = [...prev.filter((x) => x.name !== name), p];
      saveCustomConfigs(next);
      return next;
    });
    setSelCfg(name);
    setCfgPresetName("");
    setMsg(`preset salvo: ${name}`);
  }, [cfgPresetName, bpp, mode, reverse, tileW, tileH, cols, offset, zoom]);

  const deleteConfigPreset = useCallback((name: string) => {
    setCustomCfgs((prev) => {
      const next = prev.filter((x) => x.name !== name);
      saveCustomConfigs(next);
      return next;
    });
    setSelCfg((s) => (s === name ? "" : s));
    setMsg(`preset excluido: ${name}`);
  }, []);

  const renameConfigPreset = useCallback((oldName: string) => {
    const nn = window.prompt("Novo nome do preset:", oldName);
    const name = nn?.trim();
    if (!name || name === oldName) return;
    if (BUILTIN_CONFIG_PRESETS.some((b) => b.name === name) || customCfgs.some((x) => x.name === name)) {
      setMsg("ja existe um preset com esse nome");
      return;
    }
    setCustomCfgs((prev) => {
      const next = prev.map((x) => (x.name === oldName ? { ...x, name } : x));
      saveCustomConfigs(next);
      return next;
    });
    setSelCfg((s) => (s === oldName ? name : s));
  }, [customCfgs]);

  // -- presets de paleta -------------------------------------------------------
  const allPals = useMemo<PalettePreset[]>(
    () => [...BUILTIN_PALETTE_PRESETS, ...customPals],
    [customPals],
  );

  // aplica uma paleta salva: recorta/estica pras cores do bpp atual e seta.
  const applyPalettePreset = useCallback((p: PalettePreset) => {
    const src = Uint8Array.from(p.rgba);
    const want = indexed ? ncolors : Math.max(1, p.rgba.length / 4);
    const out = new Uint8Array(want * 4);
    for (let i = 0; i < want; i++) {
      if (i * 4 + 3 < src.length) out.set(src.subarray(i * 4, i * 4 + 4), i * 4);
      else { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 0; out[i * 4 + 3] = 255; }
    }
    setPalette(out);
    setSelPal(p.name);
    setMsg(`paleta aplicada: ${p.name}`);
  }, [indexed, ncolors]);

  const savePalettePreset = useCallback(() => {
    const name = palPresetName.trim();
    if (!name) { setMsg("de um nome pra paleta"); return; }
    if (BUILTIN_PALETTE_PRESETS.some((b) => b.name === name)) {
      setMsg("nome reservado (embutida); escolha outro");
      return;
    }
    // salva a paleta efetiva atual (a que esta sendo mostrada)
    const src = effPal ?? grayPaletteRGBA(ncolors || 16);
    const p: PalettePreset = { name, rgba: [...src], builtin: false };
    setCustomPals((prev) => {
      const next = [...prev.filter((x) => x.name !== name), p];
      saveCustomPalettes(next);
      return next;
    });
    setSelPal(name);
    setPalPresetName("");
    setMsg(`paleta salva: ${name}`);
  }, [palPresetName, effPal, ncolors]);

  const deletePalettePreset = useCallback((name: string) => {
    setCustomPals((prev) => {
      const next = prev.filter((x) => x.name !== name);
      saveCustomPalettes(next);
      return next;
    });
    setSelPal((s) => (s === name ? "" : s));
    setMsg(`paleta excluida: ${name}`);
  }, []);

  const renamePalettePreset = useCallback((oldName: string) => {
    const nn = window.prompt("Novo nome da paleta:", oldName);
    const name = nn?.trim();
    if (!name || name === oldName) return;
    if (BUILTIN_PALETTE_PRESETS.some((b) => b.name === name) || customPals.some((x) => x.name === name)) {
      setMsg("ja existe uma paleta com esse nome");
      return;
    }
    setCustomPals((prev) => {
      const next = prev.map((x) => (x.name === oldName ? { ...x, name } : x));
      saveCustomPalettes(next);
      return next;
    });
    setSelPal((s) => (s === oldName ? name : s));
  }, [customPals]);

  const cursor = panning ? (dragging.current ? "grabbing" : "grab") : "crosshair";

  const fileName = path ? path.split(/[\\/]/).pop() : null;

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {/* barra de titulo custom (arrasta a janela); botao ☰ abre o menu do app */}
      <div className="titlebar">
        <div className="tb-nav">
          <button className="tb-btn tb-menu" onClick={() => window.api.popupMenu()} title="menu (Arquivo, Editar...)">☰</button>
        </div>
        <div className="tb-title">
          <span className="tb-app">tile studio</span>
          {fileName && <span className="tb-sep">·</span>}
          {fileName && <span className="tb-ctx" title={path ?? ""}>{fileName}{dirty ? " *" : ""}</span>}
        </div>
      </div>

      {showPrefs && (
        <div className="modal-backdrop" onClick={() => setShowPrefs(false)}>
          <div className="prefswin" onClick={(e) => e.stopPropagation()}>
            <div className="prefswin-head">
              <span>Preferencias</span>
              <button className="prefswin-close" onClick={() => setShowPrefs(false)} title="fechar (Esc)">×</button>
            </div>
            <div className="prefswin-body">
              <div className="prefsec">
                <div className="prefsec-title">Inicializacao</div>
                <label className="preflabel">
                  <input
                    type="checkbox"
                    checked={reopenLast}
                    onChange={(e) => {
                      setReopenLast(e.target.checked);
                      localStorage.setItem("tilestudio:reopenLast", e.target.checked ? "1" : "0");
                    }}
                  />
                  <span>
                    Reabrir o ultimo arquivo ao iniciar
                    <small>abre automaticamente o ultimo arquivo aberto (se ainda existir)</small>
                  </span>
                </label>
              </div>
              <div className="prefsec">
                <div className="prefsec-title">Ferramenta</div>
                <label className="preflabel">
                  <input
                    type="checkbox"
                    checked={initialTool === "pan"}
                    onChange={(e) => {
                      const t = e.target.checked ? "pan" : "edit";
                      setInitialTool(t);
                      localStorage.setItem("tilestudio:initialTool", t);
                    }}
                  />
                  <span>
                    Iniciar no modo Navegar (pan)
                    <small>por padrao o app abre no modo Editar; ligue pra abrir no Navegar</small>
                  </span>
                </label>
              </div>
            </div>
            <div className="prefswin-foot">
              <button className="primary" onClick={() => setShowPrefs(false)}>Fechar</button>
            </div>
          </div>
        </div>
      )}

      <div className="appbody">
      <aside className="sidebar">
        <button className="primary" onClick={() => open()}>Abrir arquivo</button>
        {path && <div className="folder" title={path}>{path}{dirty ? " *" : ""}</div>}

        {/* toggle claro editar vs navegar */}
        <div className="toolrow">
          <button
            className={"tool" + (tool === "edit" && !tempPan ? " on" : "")}
            onClick={() => setTool("edit")}
            title="Editar: clicar pinta pixels"
          >Editar</button>
          <button
            className={"tool" + (panning ? " on" : "")}
            onClick={() => setTool("pan")}
            title="Navegar: clicar-e-arrastar move a imagem (pan)"
          >Navegar</button>
        </div>

        <div className="tile">
          <label>bpp
            <select value={bpp} onChange={(e) => setBpp(+e.target.value as TileConfig["bpp"])}>
              {[1, 2, 4, 8, 16, 24].map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label>modo
            <select value={mode} onChange={(e) => setMode(e.target.value as PixelMode)} disabled={!indexed}>
              <option value="planar">planar</option>
              <option value="linear">linear</option>
            </select>
          </label>
          <label>tile largura{num(tileW, setTileW, 1)}</label>
          <label>tile altura{num(tileH, setTileH, 1)}</label>
          <label>colunas{num(cols, setCols, 1)}</label>
          <label>linhas (tiles){num(tileRows, setTileRows, 1)}</label>
          <label>offset (bytes){num(offset, setOffset, 0)}</label>
          {mode === "linear" && indexed && (
            <label className="chk"><input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} /> reverse (bits)</label>
          )}
          <label className="chk"><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> grid de tiles</label>
        </div>

        {/* PRESETS de config: aplicar (dropdown) + salvar/renomear/excluir */}
        <div className="presets">
          <div className="presets-title">Presets de config</div>
          <select
            className="preset-sel"
            value={selCfg}
            onChange={(e) => {
              const p = allCfgs.find((x) => x.name === e.target.value);
              if (p) applyConfigPreset(p);
            }}
          >
            <option value="">— aplicar preset —</option>
            <optgroup label="Embutidos">
              {BUILTIN_CONFIG_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </optgroup>
            {customCfgs.length > 0 && (
              <optgroup label="Meus presets">
                {customCfgs.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </optgroup>
            )}
          </select>
          <div className="preset-save">
            <input
              className="preset-name"
              type="text"
              placeholder="nome do preset"
              value={cfgPresetName}
              onChange={(e) => setCfgPresetName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveConfigPreset(); }}
            />
            <button className="secondary" onClick={saveConfigPreset}>Salvar preset</button>
          </div>
          {selCfg && customCfgs.some((x) => x.name === selCfg) && (
            <div className="preset-actions">
              <button className="secondary" onClick={() => renameConfigPreset(selCfg)}>Renomear</button>
              <button className="secondary" onClick={() => deleteConfigPreset(selCfg)}>Excluir</button>
            </div>
          )}
        </div>

        <div className="nav">
          <button className="secondary" onClick={() => step(-tileRows)}>{"<<"}</button>
          <button className="secondary" onClick={() => step(-1)}>{"<"}</button>
          <button className="secondary" onClick={() => step(1)}>{">"}</button>
          <button className="secondary" onClick={() => step(tileRows)}>{">>"}</button>
        </div>

        <div className="btnrow">
          <button className="secondary" onClick={undo} disabled={histLen.u === 0} title="Ctrl+Z">Desfazer</button>
          <button className="secondary" onClick={redo} disabled={histLen.r === 0} title="Ctrl+Shift+Z / Ctrl+Y">Refazer</button>
        </div>

        <label className="zoom">
          Zoom {zoom}×
          <input type="range" min={1} max={20} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
        </label>

        <div className="btnrow">
          <button className="primary" onClick={save} disabled={!path || !dirty}>Salvar</button>
          <button className="secondary" onClick={saveAs} disabled={!raw}>Salvar como</button>
        </div>
        <button className="secondary" onClick={exportPng} disabled={!view}>Exportar PNG</button>
        {msg && <div className="msg">{msg}</div>}
      </aside>

      <main className="viewer" ref={viewerRef}>
        {view ? (
          <div className="canvas-wrap">
            <canvas
              ref={canvasRef}
              onMouseDown={onCanvasDown}
              onMouseMove={onCanvasMove}
              style={{
                width: view.width * zoom,
                height: view.height * zoom,
                imageRendering: "pixelated",
                cursor,
              }}
            />
          </div>
        ) : (
          <div className="empty">// abra um arquivo (ou arraste). modo Editar: clique pinta. modo Navegar (ou segure Espaco): arraste move. setas/PageUp/Down navegam.</div>
        )}
      </main>

      <aside className="inspector">
        <h2>tile studio<span className="caret">_</span><span className="ver">v0.7</span></h2>

        {indexed && (
          <div className="palette">
            {/* COR ATUAL de pintura: swatch grande + rotulo.
                clicar no quadrado abre o editor de cor do indice selecionado. */}
            <div className="curcolor">
              <div className="curlabel">Cor de pintura</div>
              <div className="curbox">
                <button
                  type="button"
                  className="curswatch"
                  style={{ background: rgbaToHex(effPal!, palIndex) }}
                  title="clique pra editar a cor de pintura atual"
                  onClick={() => openPicker(palIndex)}
                />
                <div className="curmeta">
                  <b>indice {palIndex}</b>
                  <span>{rgbaToHex(effPal!, palIndex)}</span>
                </div>
              </div>
            </div>

            <div className="kv"><span>Paleta</span><b>{palette ? "custom" : "cinza"} ({ncolors})</b></div>
            <div className="swatches">
              {Array.from({ length: ncolors }, (_, i) => (
                <div
                  key={i}
                  className={"palcell" + (i === palIndex ? " on" : "")}
                  title={`indice ${i} -- clique: pintar | shift/direito: editar cor`}
                  style={{ background: rgbaToHex(effPal!, i) }}
                  onClick={(e) => {
                    // shift+clique edita; clique simples so seleciona a cor de pintura
                    if (e.shiftKey) openPicker(i);
                    else setPalIndex(i);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault(); // sem menu de contexto nativo
                    openPicker(i);
                  }}
                />
              ))}
            </div>
            {/* color-picker unico, escondido, disparado por openPicker() */}
            <input
              ref={colorInputRef}
              type="color"
              className="hidden-color"
              onChange={(e) => setPalColor(editingIdx.current, e.target.value)}
            />
            <div className="btnrow">
              <button className="secondary" onClick={loadPalette}>Paleta (PNG)</button>
              {palette && <button className="secondary" onClick={() => setPalette(null)}>Cinza</button>}
            </div>

            {/* PRESETS de paleta: aplicar + salvar/renomear/excluir */}
            <div className="presets">
              <div className="presets-title">Presets de paleta</div>
              <select
                className="preset-sel"
                value={selPal}
                onChange={(e) => {
                  const p = allPals.find((x) => x.name === e.target.value);
                  if (p) applyPalettePreset(p);
                }}
              >
                <option value="">— aplicar paleta —</option>
                <optgroup label="Embutidas">
                  {BUILTIN_PALETTE_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                </optgroup>
                {customPals.length > 0 && (
                  <optgroup label="Minhas paletas">
                    {customPals.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </optgroup>
                )}
              </select>
              <div className="preset-save">
                <input
                  className="preset-name"
                  type="text"
                  placeholder="nome da paleta"
                  value={palPresetName}
                  onChange={(e) => setPalPresetName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") savePalettePreset(); }}
                />
                <button className="secondary" onClick={savePalettePreset}>Salvar paleta</button>
              </div>
              {selPal && customPals.some((x) => x.name === selPal) && (
                <div className="preset-actions">
                  <button className="secondary" onClick={() => renamePalettePreset(selPal)}>Renomear</button>
                  <button className="secondary" onClick={() => deletePalettePreset(selPal)}>Excluir</button>
                </div>
              )}
            </div>

            <div className="hint">Clique numa celula = escolhe a cor de pintura (fica destacada). Shift+clique ou clique-direito = edita a cor daquele indice. Clicar no quadrado grande "Cor de pintura" edita o indice selecionado.</div>
          </div>
        )}

        {!indexed && (
          <div className="palette">
            {/* COR DE PINTURA em cor direta (16/24bpp): color-picker de RGB */}
            <div className="curcolor">
              <div className="curlabel">Cor de pintura ({bpp}bpp {bpp === 16 ? "ABGR1555" : "RGB"})</div>
              <div className="curbox">
                <label className="curswatch" style={{ background: dirColor }} title="clique pra escolher a cor RGB">
                  <input type="color" value={dirColor} onChange={(e) => setDirColor(e.target.value)} />
                </label>
                <div className="curmeta">
                  <b>{dirColor.toUpperCase()}</b>
                  <span>{bpp === 16 ? "snap 5-5-5" : "RGB 8-8-8"}</span>
                </div>
              </div>
            </div>
            {bpp === 16 && (
              <label className="chk chk-stp">
                <input type="checkbox" checked={dirStp} onChange={(e) => setDirStp(e.target.checked)} /> bit STP (mascara)
              </label>
            )}
            <div className="hint">Cor direta: clique no quadrado pra escolher a cor RGB de pintura. Clique-e-arraste no canvas pinta essa cor nos bytes.</div>
          </div>
        )}

        {view && (
          <>
            <div className="kv"><span>Ferramenta</span><b>{panning ? "navegar (pan)" : "editar"}</b></div>
            <div className="kv"><span>Historico</span><b>{histLen.u} desfazer / {histLen.r} refazer</b></div>
            <div className="kv"><span>Bytes/tile</span><b>{bytesPerTile}</b></div>
            <div className="kv"><span>Bytes/linha</span><b>{bytesPerTileRow}</b></div>
            <div className="kv"><span>Canvas</span><b>{view.width}×{view.height}</b></div>
            <div className="kv"><span>Tiles</span><b>{view.tileCount}</b></div>
            <div className="kv"><span>Tile</span><b>{tileW}×{tileH} {bpp}bpp {indexed ? mode : "direto"}</b></div>
          </>
        )}
        <p className="hint">
          Clone do Tile Molester. Ctrl+Z desfaz edicoes de pixel (nao mexe em bpp/zoom/offset).
          Segure Espaco pra pan temporario. Alt+clique = conta-gotas. Fonte LoM = 1bpp planar, tile 16×12.
        </p>
      </aside>
      </div>
    </div>
  );
}
