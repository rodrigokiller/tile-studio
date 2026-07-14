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
  encodeAct,
  CONSOLE_CODECS,
  type TileConfig,
  type PixelMode,
  type ConsoleCodec,
} from "../../tile";
import { decodeTim, color15ToRgba } from "../../tim";
import { decodePaletteFile, fitPalette } from "../../palette";
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
import type { UpdStatus } from "../../preload"; // status do auto-update (so o tipo)

// teto do historico de undo (descarta as entradas mais antigas ao passar)
const MAX_UNDO = 200;

// -- helpers de paleta --------------------------------------------------------

// coordenada do canvas (px da imagem) a partir do mouse, ja clampada
function cvXY(cv: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = cv.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(cv.width - 1, Math.floor(((clientX - rect.left) / rect.width) * cv.width))),
    y: Math.max(0, Math.min(cv.height - 1, Math.floor(((clientY - rect.top) / rect.height) * cv.height))),
  };
}

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

/** Converte UMA CLUT (linha `row` de um TIM multi-CLUT) de cores 15-bit pra paleta RGBA do editor. */
function clutRowToRgba(clut: Uint16Array, clutW: number, row: number): Uint8Array {
  const out = new Uint8Array(clutW * 4);
  for (let i = 0; i < clutW; i++) {
    const [r, g, b, a] = color15ToRgba(clut[row * clutW + i] ?? 0);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
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

// menus da barra de titulo + a letra do acelerador (Alt+letra), padrao Windows. A ordem casa com
// menuTemplate no main (o index e o mesmo). Letras distintas: Arquivo=A, Editar=E, eXibir=X,
// Janela=J, ajuDa=D.
const TB_MENUS: { label: string; alt: string }[] = [
  { label: "Arquivo", alt: "a" },
  { label: "Editar", alt: "e" },
  { label: "Exibir", alt: "x" },
  { label: "Janela", alt: "j" },
  { label: "Ajuda", alt: "d" },
];

// offset digitado pelo usuario: aceita hex com prefixo ("0x1A00" / "$1A00") ou sufixo ("1A00h"),
// e decimal puro ("6656"). Sem prefixo: decimal por padrao; com hexDefault=true (ir-para, Ctrl+G)
// ou quando tem letra a-f, interpreta como hex. Retorna null se nao der pra entender.
function parseOffsetText(s: string, hexDefault = false): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  const m = /^(?:0x|\$)([0-9a-f]+)$/.exec(t) ?? /^([0-9a-f]+)h$/.exec(t);
  if (m) return parseInt(m[1], 16);
  if (/^[0-9a-f]+$/.test(t)) {
    if (hexDefault || /[a-f]/.test(t)) return parseInt(t, 16);
    return parseInt(t, 10);
  }
  return null;
}

const fmtHex = (n: number): string => "0x" + n.toString(16).toUpperCase();

// -----------------------------------------------------------------------------

export function App(): JSX.Element {
  // botao da barra de titulo cujo menu esta aberto (highlight do hover-switch; -1 = nenhum)
  const [openMenuIdx, setOpenMenuIdx] = useState(-1);
  useEffect(() => window.api.onMenuOpenIndex((i) => setOpenMenuIdx(i)), []);
  // navegacao do menu por Alt (padrao Windows)
  const [altHeld, setAltHeld] = useState(false); // Alt segurado -> sublinha as letras dos menus
  const [menuNavIdx, setMenuNavIdx] = useState<number | null>(null); // barra ativada por Alt: menu em foco (setas), sem abrir
  const navReturnRef = useRef<number | null>(null); // menu aberto PELO teclado -> pra onde voltar quando fechar (Esc volta pra barra)
  const prevOpenMenuRef = useRef(-1); // openMenuIdx anterior (detectar a transicao aberto -> fechado)
  // modais proprios (confirm/prompt/Sobre): os dialogs nativos travam o foco da janela no Electron
  const [confirmState, setConfirmState] = useState<{ msg: string; okLabel?: string; onOk: () => void } | null>(null);
  const [promptState, setPromptState] = useState<{ title: string; hint?: string; value: string; onOk: (v: string) => void } | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [appInfo, setAppInfo] = useState<{ version: string; electron: string; chrome: string; node: string } | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [raw, setRaw] = useState<Uint8Array | null>(null);
  const [dirty, setDirty] = useState(false);

  const [bpp, setBpp] = useState<TileConfig["bpp"]>(1);
  const [mode, setMode] = useState<PixelMode>("planar");
  // codec por console (ITEM 1): "generic" = usa bpp/mode; um console trava bpp e tile 8x8
  const [codec, setCodec] = useState<ConsoleCodec>("generic");
  const codecOn = codec !== "generic";
  const [tileW, setTileW] = useState(16);
  const [tileH, setTileH] = useState(12);
  const [cols, setCols] = useState(16);
  const [tileRows, setTileRows] = useState(16); // quantas linhas de tiles mostrar
  const [reverse, setReverse] = useState(false);
  const [offset, setOffset] = useState(0);
  const [zoom, setZoom] = useState(4);

  const [palette, setPalette] = useState<Uint8Array | null>(null);
  // TIM multi-CLUT: guarda as CLUTs cruas pra o seletor trocar qual paleta usar (ITEM 2)
  const [timClut, setTimClut] = useState<{ clut: Uint16Array; clutW: number; clutH: number } | null>(null);
  const [timClutIdx, setTimClutIdx] = useState(0);
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
  // banner de atualizacao (null = escondido) + pref "verificar ao iniciar" (default LIGADO)
  const [upd, setUpd] = useState<UpdStatus | null>(null);
  const [updOnBoot, setUpdOnBoot] = useState(() => localStorage.getItem("tilestudio:updOnBoot") !== "0");
  // check silencioso (boot): so vira banner se HOUVER update; checking/none/erro nao incomodam
  const updSilent = useRef(false);

  // ferramenta ativa: editar (pinta), navegar (pan), selecionar ou balde. Espaco = pan temporario.
  const [tool, setTool] = useState<"edit" | "pan" | "select" | "fill">(initialTool);
  const [tempPan, setTempPan] = useState(false);
  // selecao retangular (px do canvas) pra copiar/colar; Esc limpa
  const [selRect, setSelRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const selStart = useRef<{ x: number; y: number } | null>(null);
  // copia interna (valores crus de pixel; o Ctrl+C tambem poe um PNG no clipboard do sistema)
  const clipRef = useRef<{ w: number; h: number; vals: Int32Array } | null>(null);

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
      codec,
    }),
    [bpp, mode, tileW, tileH, cols, tileRows, reverse, offset, effPal, codec],
  );

  // troca de codec: "generico" volta ao comportamento por bpp/mode; um console TRAVA bpp e
  // o tile em 8x8 (o formato define isso). NAO mexe nos bytes nem no undo.
  const applyCodec = useCallback((c: ConsoleCodec) => {
    setCodec(c);
    if (c !== "generic") {
      const info = CONSOLE_CODECS[c];
      setBpp(info.bpp);
      setTileW(info.tileW);
      setTileH(info.tileH);
    }
  }, []);

  // -- pilha de undo/redo: guarda SO edicoes de bytes (nunca estado de view) ---
  const undoStack = useRef<ByteChange[][]>([]);
  const redoStack = useRef<ByteChange[][]>([]);
  const [histLen, setHistLen] = useState({ u: 0, r: 0 }); // so pra atualizar UI

  // -- abrir .TIM (PSX): decodifica e configura a vista (dimensoes/bpp reais) + CLUT (ITEM 2).
  // A vista aponta pro bloco de pixels do proprio arquivo (byteOffset = pixelOffset), entao a
  // EDICAO de pixel escreve in-place nos bytes do TIM e "Salvar" grava um .TIM valido de volta.
  const loadTim = useCallback((bytes: Uint8Array) => {
    const tim = decodeTim(bytes); // lanca se nao for TIM valido (ex.: mode "mixed")
    const tbpp: TileConfig["bpp"] =
      tim.mode === "4bpp" ? 4 : tim.mode === "8bpp" ? 8 : tim.mode === "16bpp" ? 16 : 24;
    setCodec("generic"); // TIM = linear/cor-direta generico (nao e formato de console)
    setMode("linear");
    setReverse(tim.mode === "4bpp"); // 4bpp do TIM = nibble baixo primeiro (reverse)
    setBpp(tbpp);
    setTileW(tim.width);
    setTileH(tim.height);
    setCols(1);
    setTileRows(1);
    setOffset(tim.pixelOffset);
    if (tim.clut && (tbpp === 4 || tbpp === 8)) {
      setTimClut({ clut: tim.clut, clutW: tim.clutW, clutH: tim.clutH });
      setTimClutIdx(0);
      setPalette(clutRowToRgba(tim.clut, tim.clutW, 0));
    } else {
      setTimClut(null);
      setPalette(null); // 16/24bpp: cor direta, sem paleta
    }
    setMsg(
      `TIM ${tim.mode} ${tim.width}×${tim.height}` +
        (tim.clut ? ` · ${tim.clutH} CLUT(s) de ${tim.clutW} cores` : ""),
    );
  }, []);

  const open = useCallback(
    async (p?: string) => {
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
      setDirty(false);
      setSelRect(null);
      // arquivo novo: zera a historia de edicao
      undoStack.current = [];
      redoStack.current = [];
      setHistLen({ u: 0, r: 0 });
      // registra nos recentes (alimenta o menu "Abrir recente" e o reabrir-ao-iniciar)
      window.api.setLastFile(file);
      // .TIM: detecta pela extensao OU pelo header (10 00 00 00). Configura a vista + CLUT.
      const looksTim =
        /\.tim$/i.test(file) ||
        (bytes.length >= 8 && bytes[0] === 0x10 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0);
      if (looksTim) {
        try {
          loadTim(bytes);
          return;
        } catch (err) {
          // TIM invalido: cai pro modo de bytes crus (tile) com um aviso
          setTimClut(null);
          setOffset(0);
          setMsg("TIM invalido (" + (err as Error).message + "); abrindo como bytes crus");
          return;
        }
      }
      // arquivo comum (nao-TIM): modo tile cru, offset 0, sem CLUT
      setTimClut(null);
      setOffset(0);
      setMsg(null);
    },
    [loadTim],
  );

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

  // -- auto-update: status do main vira banner; no modo silencioso so "available" promove
  useEffect(
    () =>
      window.api.onUpdStatus((s) => {
        if (updSilent.current) {
          if (s.state === "available") {
            updSilent.current = false; // achou update: daqui em diante o banner acompanha tudo
          } else {
            if (s.state !== "checking") updSilent.current = false; // terminou sem novidade
            return;
          }
        }
        // download-progress nao manda a versao: preserva a do status anterior
        setUpd((prev) => ({ ...s, version: s.version ?? prev?.version }));
      }),
    [],
  );

  // dispara um check; silent = check automatico do boot (banner so aparece com update)
  const checkUpdates = useCallback((silent: boolean) => {
    updSilent.current = silent;
    if (!silent) setUpd({ state: "checking" });
    void window.api.updCheck();
  }, []);

  // menu Ajuda > Verificar atualizacoes... (check manual, com banner)
  useEffect(() => window.api.onMenuSimple("menu:checkUpdates", () => checkUpdates(false)), [checkUpdates]);

  // pref ligada: check silencioso ~10s depois do boot (nao atrapalha a abertura)
  useEffect(() => {
    if (!updOnBoot) return;
    const t = setTimeout(() => checkUpdates(true), 10_000);
    return () => clearTimeout(t);
    // so na montagem (o valor da pref no boot decide); checkUpdates e estavel
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
    // moldura da selecao (tracinho preto+branco, estilo marching ants)
    if (selRect) {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "#000";
      ctx.strokeRect(selRect.x + 0.5, selRect.y + 0.5, selRect.w - 1 || 1, selRect.h - 1 || 1);
      ctx.lineDashOffset = 4;
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(selRect.x + 0.5, selRect.y + 0.5, selRect.w - 1 || 1, selRect.h - 1 || 1);
      ctx.restore();
    }
  }, [view, showGrid, tileW, tileH, selRect]);

  // navegacao pelo arquivo: 1 linha de tiles = cols tiles
  const bytesPerTile = tileSizeBytes(cfg);
  const bytesPerTileRow = bytesPerTile * Math.max(1, cols);
  const step = (mult: number) => setOffset((o) => Math.max(0, o + bytesPerTileRow * mult));

  // o input de offset e TEXTO (aceita decimal "6656" e hex "0x1A00"/"$1A00"); so aplica no
  // Enter/blur (digitar "0x" pela metade nao zera a vista). Sincroniza quando muda por fora.
  const [offsetText, setOffsetText] = useState("0");
  useEffect(() => setOffsetText(String(offset)), [offset]);
  const commitOffsetText = useCallback(() => {
    const v = parseOffsetText(offsetText);
    if (v === null) {
      setOffsetText(String(offset)); // invalido: volta pro valor atual
      return;
    }
    setOffset(Math.max(0, v));
    setOffsetText(String(Math.max(0, v))); // normaliza mesmo se o offset nao mudou (o effect nao roda)
  }, [offsetText, offset]);

  // Ctrl+G: modal "ir para offset" -- digita em hex (padrao) ou decimal e vai
  const gotoOffset = useCallback(() => {
    setPromptState({
      title: "Ir para offset",
      hint: "em HEX: 1A00 = 0x1A00 (prefixo 0x/$ opcional). O campo de offset da sidebar aceita decimal.",
      value: fmtHex(offset),
      onOk: (v) => {
        const n = parseOffsetText(v, true); // sem prefixo = hex (e o modal de "ir para em hex")
        if (n === null) {
          setMsg("offset invalido: " + v);
          return;
        }
        setOffset(Math.max(0, n));
      },
    });
  }, [offset]);

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

      // Ctrl+G: ir para offset (modal em hex); funciona mesmo com o foco num campo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        gotoOffset();
        return;
      }

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
      // nudge FINO: +-1 byte no offset (essencial pra achar o alinhamento dos tiles)
      else if (e.key === "ArrowLeft" && e.shiftKey) { e.preventDefault(); setOffset((o) => Math.max(0, o - 1)); }
      else if (e.key === "ArrowRight" && e.shiftKey) { e.preventDefault(); setOffset((o) => o + 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bytesPerTileRow, tileRows, undo, redo, gotoOffset]);

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
    // ferramenta Balde: 1 clique preenche a area contigua (flood fill); 1 clique = 1 undo
    if (tool === "fill" && !tempPan) {
      e.preventDefault();
      fillAt(e.clientX, e.clientY);
      return;
    }
    // ferramenta Selecionar: arrasta um retangulo (px) pra copiar/colar
    if (tool === "select" && !tempPan) {
      const cv = canvasRef.current;
      if (!cv) return;
      const p = cvXY(cv, e.clientX, e.clientY);
      selStart.current = p;
      setSelRect({ x: p.x, y: p.y, w: 1, h: 1 });
      dragging.current = true;
      e.preventDefault();
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
    if (tool === "select" && selStart.current) {
      const cv = canvasRef.current;
      if (!cv) return;
      const p = cvXY(cv, e.clientX, e.clientY);
      const s = selStart.current;
      setSelRect({
        x: Math.min(s.x, p.x),
        y: Math.min(s.y, p.y),
        w: Math.abs(p.x - s.x) + 1,
        h: Math.abs(p.y - s.y) + 1,
      });
      return;
    }
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

  // -- selecao: copiar / colar / importar PNG ---------------------------------

  /** Ctrl+C: guarda os valores crus da selecao E poe um PNG no clipboard do sistema
   *  (da pra colar direto no Photoshop; e o Ctrl+V daqui tambem le de la). */
  const copySelection = useCallback(async () => {
    if (!raw || !view || !selRect) return;
    const { x, y, w, h } = selRect;
    const vals = new Int32Array(w * h);
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) {
        const loc = locatePixel(cfg, x + xx, y + yy);
        vals[yy * w + xx] = readPixelIndex(raw, cfg, loc.tileBase, loc.px, loc.py);
      }
    clipRef.current = { w, h, vals };
    try {
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const cx = cv.getContext("2d")!;
      const region = cx.createImageData(w, h);
      for (let yy = 0; yy < h; yy++) {
        const src = ((y + yy) * view.width + x) * 4;
        region.data.set(view.rgba.subarray(src, src + w * 4), yy * w * 4);
      }
      cx.putImageData(region, 0, 0);
      const blob: Blob = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("png"))), "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setMsg(`copiado ${w}x${h}px (tambem como imagem, pro Photoshop etc.)`);
    } catch {
      setMsg(`copiado ${w}x${h}px (interno)`);
    }
  }, [raw, view, selRect, cfg]);

  /** escreve um bloco de pixels em (dx,dy) como UMA entrada de undo.
   *  `value(xx,yy)` retorna o valor do pixel ou null pra pular (transparencia). */
  const applyBlockAt = useCallback(
    (w: number, h: number, dx: number, dy: number, value: (xx: number, yy: number) => number | null): number => {
      if (!raw || !view) return 0;
      const before = new Uint8Array(raw);
      let painted = 0;
      for (let yy = 0; yy < h; yy++) {
        const py = dy + yy;
        if (py >= view.height) break;
        for (let xx = 0; xx < w; xx++) {
          const px = dx + xx;
          if (px >= view.width) continue;
          const v = value(xx, yy);
          if (v === null) continue;
          const loc = locatePixel(cfg, px, py);
          if (readPixelIndex(raw, cfg, loc.tileBase, loc.px, loc.py) === v) continue;
          writePixelIndex(raw, cfg, loc.tileBase, loc.px, loc.py, v);
          painted++;
        }
      }
      // uma passada de diff = uma entrada de undo (old/neu certos mesmo com 2 px por byte)
      const changes: ByteChange[] = [];
      for (let o = 0; o < raw.length; o++) if (before[o] !== raw[o]) changes.push({ off: o, old: before[o], neu: raw[o] });
      if (changes.length) {
        undoStack.current.push(changes);
        if (undoStack.current.length > MAX_UNDO) undoStack.current.splice(0, undoStack.current.length - MAX_UNDO);
        redoStack.current = [];
        setHistLen({ u: undoStack.current.length, r: 0 });
        setRaw(new Uint8Array(raw));
        setDirty(true);
      }
      return painted;
    },
    [raw, view, cfg],
  );

  /** converte RGBA pra valores do formato atual: indexado quantiza pra cor mais proxima
   *  da paleta; 16/24bpp converte direto. Alpha < 128 nao pinta. */
  const applyRgbaAt = useCallback(
    (rgba: Uint8Array, w: number, h: number, dx: number, dy: number): number =>
      applyBlockAt(w, h, dx, dy, (xx, yy) => {
        const si = (yy * w + xx) * 4;
        if (rgba[si + 3] < 128) return null;
        const r = rgba[si];
        const g = rgba[si + 1];
        const b = rgba[si + 2];
        if (!indexed) return rgbToDirect(bpp as 16 | 24, r, g, b, 0);
        const pal = effPal!;
        let best = 0;
        let bd = Infinity;
        for (let c = 0; c < ncolors; c++) {
          const dr = r - pal[c * 4];
          const dg = g - pal[c * 4 + 1];
          const db = b - pal[c * 4 + 2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bd) {
            bd = d;
            best = c;
          }
        }
        return best;
      }),
    [applyBlockAt, indexed, effPal, ncolors, bpp],
  );

  /** ferramenta BALDE: flood fill 4-direcoes a partir do clique, com a cor de pintura atual.
   *  Anda so por pixels da MESMA cor do pixel clicado e nao sai da vista atual (canvas
   *  decodificado). A gravacao passa pelo applyBlockAt -> vira UMA entrada de undo byte-level,
   *  o mesmo caminho do lapis/colar. */
  const fillAt = useCallback(
    (clientX: number, clientY: number) => {
      const cv = canvasRef.current;
      if (!cv || !raw || !view) return;
      const p = cvXY(cv, clientX, clientY);
      const seed = locatePixel(cfg, p.x, p.y);
      const target = readPixelIndex(raw, cfg, seed.tileBase, seed.px, seed.py);
      if (target === paintValue) return; // ja e a cor de pintura, nada a fazer
      const W = view.width;
      const H = view.height;
      // 1) marca a regiao contigua (SO leitura) com um flood fill iterativo 4-direcoes
      const mask = new Uint8Array(W * H);
      const stack: number[] = [p.y * W + p.x];
      mask[p.y * W + p.x] = 1;
      let minX = p.x, maxX = p.x, minY = p.y, maxY = p.y;
      const tryPush = (nx: number, ny: number): void => {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) return; // limitado a vista atual
        const ni = ny * W + nx;
        if (mask[ni]) return;
        const loc = locatePixel(cfg, nx, ny);
        if (readPixelIndex(raw, cfg, loc.tileBase, loc.px, loc.py) !== target) return;
        mask[ni] = 1;
        stack.push(ni);
      };
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % W;
        const y = (i / W) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        tryPush(x - 1, y);
        tryPush(x + 1, y);
        tryPush(x, y - 1);
        tryPush(x, y + 1);
      }
      // 2) grava a regiao como UMA entrada de undo (mesmo caminho do colar/importar PNG)
      const n = applyBlockAt(maxX - minX + 1, maxY - minY + 1, minX, minY, (xx, yy) =>
        mask[(minY + yy) * W + (minX + xx)] ? paintValue : null,
      );
      setMsg(`balde: ${n} px preenchidos`);
    },
    [raw, view, cfg, paintValue, applyBlockAt],
  );

  /** ITEM 4: transforma a regiao selecionada -- espelhar H, espelhar V ou girar 90° (horario).
   *  Opera nos PIXELS decodificados (tira um snapshot antes de escrever) e regrava pelo mesmo
   *  caminho do lapis/balde (applyBlockAt = 1 passo de undo byte-level). Girar 90° so em regiao
   *  quadrada (senao mudaria as dimensoes) -- o botao fica desabilitado quando w != h. */
  const transformSelection = useCallback(
    (kind: "flipH" | "flipV" | "rot90") => {
      if (!raw || !view || !selRect) return;
      const { x, y, w, h } = selRect;
      if (kind === "rot90" && w !== h) {
        setMsg("girar 90° requer selecao quadrada");
        return;
      }
      // snapshot dos valores atuais da regiao (ler durante a escrita pegaria pixels ja mexidos)
      const src = new Int32Array(w * h);
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++) {
          const loc = locatePixel(cfg, x + xx, y + yy);
          src[yy * w + xx] = readPixelIndex(raw, cfg, loc.tileBase, loc.px, loc.py);
        }
      const val = (xx: number, yy: number): number => {
        if (kind === "flipH") return src[yy * w + (w - 1 - xx)];
        if (kind === "flipV") return src[(h - 1 - yy) * w + xx];
        // rot90 horario (quadrado NxN): dest(xx,yy) = src(sx=yy, sy=N-1-xx)
        return src[(w - 1 - xx) * w + yy];
      };
      const n = applyBlockAt(w, h, x, y, val);
      setMsg(
        kind === "flipH"
          ? `selecao espelhada na horizontal (${n} px)`
          : kind === "flipV"
            ? `selecao espelhada na vertical (${n} px)`
            : `selecao girada 90° (${n} px)`,
      );
    },
    [raw, view, selRect, cfg, applyBlockAt],
  );

  /** Ctrl+V: cola no canto da selecao (ou em 0,0 da vista). Prefere a imagem do clipboard
   *  do sistema (Photoshop etc., com quantizacao pra paleta); senao usa a copia interna. */
  const pasteClipboard = useCallback(async () => {
    if (!raw || !view) return;
    const dx = selRect?.x ?? 0;
    const dy = selRect?.y ?? 0;
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const bmp = await createImageBitmap(await it.getType(type));
        const cv = document.createElement("canvas");
        cv.width = bmp.width;
        cv.height = bmp.height;
        const cx = cv.getContext("2d")!;
        cx.drawImage(bmp, 0, 0);
        const data = cx.getImageData(0, 0, bmp.width, bmp.height);
        const n = applyRgbaAt(new Uint8Array(data.data.buffer), bmp.width, bmp.height, dx, dy);
        setMsg(
          `colado ${bmp.width}x${bmp.height}px em (${dx},${dy})` +
            (indexed ? " -- cores ajustadas pra mais proxima da paleta" : "") +
            ` (${n} px)`,
        );
        return;
      }
    } catch {
      /* sem imagem no clipboard do sistema: tenta a copia interna */
    }
    const clip = clipRef.current;
    if (!clip) {
      setMsg("nada pra colar (selecione e Ctrl+C aqui, ou copie uma imagem em outro app)");
      return;
    }
    const n = applyBlockAt(clip.w, clip.h, dx, dy, (xx, yy) => clip.vals[yy * clip.w + xx]);
    setMsg(`colado ${clip.w}x${clip.h}px em (${dx},${dy}) (${n} px, valores exatos)`);
  }, [raw, view, selRect, applyRgbaAt, applyBlockAt, indexed]);

  /** importa um PNG POR CIMA da vista atual (0,0 do canvas = offset atual). Round-trip
   *  perfeito com o "Exportar PNG": exporta, edita fora, importa de volta. */
  const importPng = useCallback(async () => {
    if (!raw || !view) return;
    const p = await window.api.openPng();
    if (!p) return;
    try {
      const { width, height, rgba } = await pngToRgba(new Uint8Array(await window.api.readFile(p)));
      const n = applyRgbaAt(rgba, width, height, 0, 0);
      const cut = width !== view.width || height !== view.height ? " (tamanho difere da vista: aplicado parcial)" : "";
      setMsg(`PNG importado ${width}x${height}px sobre a vista${indexed ? ", cores ajustadas pra paleta" : ""} -- ${n} px${cut}`);
    } catch (err) {
      setMsg("falha ao importar PNG: " + (err as Error).message);
    }
  }, [raw, view, applyRgbaAt, indexed]);

  /** Arquivo > Fechar arquivo (Ctrl+W): volta pra tela vazia. Com alteracoes nao salvas,
   *  confirma num modal PROPRIO (window.confirm nativo trava o foco da janela no Electron). */
  const closeFile = useCallback(() => {
    if (!raw) return;
    const doClose = (): void => {
      setPath(null);
      setRaw(null);
      setDirty(false);
      setSelRect(null);
      setMsg(null);
      setTimClut(null);
      undoStack.current = [];
      redoStack.current = [];
      setHistLen({ u: 0, r: 0 });
    };
    if (dirty) {
      setConfirmState({
        msg: "O arquivo tem alteracoes nao salvas. Fechar mesmo assim?",
        okLabel: "Fechar mesmo assim",
        onOk: doClose,
      });
      return;
    }
    doClose();
  }, [raw, dirty]);

  useEffect(() => window.api.onMenuSimple("menu:closeFile", () => closeFile()), [closeFile]);
  useEffect(() => window.api.onMenuSimple("menu:importPng", () => void importPng()), [importPng]);
  // Ajuda > Sobre: o main so manda o IPC e o modal abre AQUI (dialog nativo trava o foco)
  useEffect(() => window.api.onMenuSimple("menu:about", () => setShowAbout(true)), []);
  // infos de versao pro Sobre: busca 1x ao montar
  useEffect(() => {
    void window.api.appInfo().then(setAppInfo);
  }, []);

  // Esc fecha os modais proprios (confirmar / prompt / Sobre). Listener em CAPTURE pra ganhar
  // do Esc que limpa a selecao (o evento nem chega nos handlers de bolha).
  useEffect(() => {
    if (!confirmState && !promptState && !showAbout) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setConfirmState(null);
        setPromptState(null);
        setShowAbout(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirmState, promptState, showAbout]);

  // Ctrl+C copia a selecao / Ctrl+V cola / Esc limpa a selecao
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selRect) {
        e.preventDefault();
        void copySelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void pasteClipboard();
      } else if (e.key === "Escape") {
        setSelRect(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selRect, copySelection, pasteClipboard]);

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

  /** ITEM 3: importa paleta de .ACT / .PAL (RIFF ou JASC) / .PNG. Ajusta pro nº de cores do
   *  bpp atual. PNG passa pelo mesmo caminho do PNG (extrai cores unicas); .act/.pal usam os
   *  parsers de palette.ts (indice = cor, sem dedupe). */
  const importPalette = useCallback(async () => {
    const file = await window.api.openPalette();
    if (!file) return;
    try {
      const bytes = new Uint8Array(await window.api.readFile(file));
      const ext = file.split(".").pop()?.toLowerCase();
      if (ext === "png") {
        const { rgba } = await pngToRgba(bytes);
        setPalette(paletteFromRgba(rgba, ncolors));
      } else {
        const dec = decodePaletteFile(file, bytes);
        setPalette(fitPalette(dec, ncolors));
      }
      setSelPal(""); // saiu dos presets de paleta
      setMsg(`paleta importada de ${file.split(/[\\/]/).pop()} (${ncolors} cores)`);
    } catch (err) {
      setMsg("falha ao importar paleta: " + (err as Error).message);
    }
  }, [ncolors]);

  // exporta a paleta de pintura atual como .ACT (Adobe Color Table) pro Photoshop
  const exportPalette = useCallback(async () => {
    if (!indexed || !effPal) {
      setMsg("exportar paleta so nos bpp indexados (2/4/8)");
      return;
    }
    const act = encodeAct(effPal, ncolors);
    const base = (path?.split(/[\\/]/).pop()?.replace(/\.[^.\\/]+$/, "") ?? "paleta") + `_${bpp}bpp`;
    const out = await window.api.saveAct(base + ".act");
    if (!out) return;
    await window.api.writeFile(out, act);
    setMsg(`paleta exportada (.ACT): ${out.split(/[\\/]/).pop()} -- no Photoshop: Imagem > Modo > Cores indexadas > carregar tabela`);
  }, [indexed, effPal, ncolors, bpp, path]);

  // menu Editar > Exportar paleta (.ACT); habilitado so nos bpp indexados
  useEffect(() => window.api.onExportPalette(() => exportPalette()), [exportPalette]);
  useEffect(() => {
    window.api.setPaletteEnabled(indexed);
  }, [indexed]);

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

  /** exporta SO a selecao retangular como PNG (mesmo caminho do exportPng, recortado). */
  const exportSelPng = useCallback(async () => {
    if (!view || !selRect) return;
    const { x, y, w, h } = selRect;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const cx = cv.getContext("2d")!;
    // copia linha a linha o retangulo da vista decodificada (mesma tecnica do copySelection)
    const region = cx.createImageData(w, h);
    for (let yy = 0; yy < h; yy++) {
      const src = ((y + yy) * view.width + x) * 4;
      region.data.set(view.rgba.subarray(src, src + w * 4), yy * w * 4);
    }
    cx.putImageData(region, 0, 0);
    const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/png"));
    if (!blob) return;
    const def = (path?.replace(/\.[^.\\/]+$/, "") ?? "tiles") + `_sel_${w}x${h}.png`;
    const out = await window.api.savePng(def.split(/[\\/]/).pop() ?? "selecao.png");
    if (!out) return;
    await window.api.writeFile(out, new Uint8Array(await blob.arrayBuffer()));
    setMsg(`selecao ${w}x${h}px salva como PNG: ${out.split(/[\\/]/).pop()}`);
  }, [view, selRect, path]);

  const num = (v: number, set: (n: number) => void, min = 0, disabled = false) => (
    <input type="number" value={v} min={min} disabled={disabled} onChange={(e) => set(Math.max(min, +e.target.value))} />
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
    setCodec("generic"); // presets sao configs genericas (bpp/mode); destrava os controles
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

  // renomear via modal proprio (window.prompt nativo trava o foco da janela no Electron)
  const renameConfigPreset = useCallback((oldName: string) => {
    setPromptState({
      title: "Renomear preset",
      value: oldName,
      onOk: (nn) => {
        const name = nn.trim();
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
      },
    });
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

  // renomear via modal proprio (mesmo motivo do renameConfigPreset)
  const renamePalettePreset = useCallback((oldName: string) => {
    setPromptState({
      title: "Renomear paleta",
      value: oldName,
      onOk: (nn) => {
        const name = nn.trim();
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
      },
    });
  }, [customPals]);

  // -- barra de menu: abrir por clique OU teclado (Alt) -------------------------

  // abre o submenu do topo `index` PROGRAMATICAMENTE (mesmo caminho do clique no botao): mede os
  // retangulos dos botoes + viewport e chama o popupMenuItem. Usado pelo clique E pelo Alt.
  const openTitlebarMenu = useCallback((index: number, fromNav = false) => {
    // se veio da barra ativada por teclado, lembra pra onde VOLTAR quando o popup fechar por Esc
    navReturnRef.current = fromNav ? index : null;
    setMenuNavIdx(null); // abrir um menu encerra a navegacao-por-setas da barra
    const btns = [...document.querySelectorAll<HTMLButtonElement>(".tb-nav button.tb-menub")];
    const btn = btns[index];
    if (!btn) return;
    btn.blur();
    const rects = btns.map((b, j) => {
      const r = b.getBoundingClientRect();
      return { index: j, x1: r.left, x2: r.right };
    });
    void window.api.popupMenuItem(index, btn.getBoundingClientRect().left, rects, {
      w: window.innerWidth,
      h: window.innerHeight,
    });
  }, []);

  // navegacao por Alt (padrao Windows): Alt+letra abre o menu; Alt sozinho (tap) ativa a barra;
  // segurar Alt sublinha as letras. Uma vez o popup NATIVO aberto, ele captura o teclado
  // (setas/Enter/Esc navegam nativamente).
  useEffect(() => {
    let altTap = false; // Alt esta sendo segurado sozinho (candidato a tap)
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Alt" && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault(); // evita o foco/beep do menu nativo do Windows
        if (!e.repeat) {
          altTap = true;
          setAltHeld(true);
        }
        return;
      }
      // qualquer outra tecla ja NAO e um "tap" de Alt sozinho (ex.: Alt+clique do conta-gotas)
      altTap = false;
      // Alt+letra (sem Ctrl -> nao pega AltGr/acentos): abre o menu correspondente
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key.length === 1) {
        const idx = TB_MENUS.findIndex((m) => m.alt === e.key.toLowerCase());
        if (idx >= 0) {
          e.preventDefault();
          setAltHeld(false);
          openTitlebarMenu(idx);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === "Alt") {
        setAltHeld(false);
        if (altTap) {
          altTap = false;
          e.preventDefault();
          // tap do Alt: ATIVA/desativa a barra (foca o 1o menu, sem abrir). Setas navegam; Enter/abaixo abre
          setMenuNavIdx((cur) => {
            if (cur !== null) return null;
            (document.activeElement as HTMLElement | null)?.blur?.(); // tira o foco do input pra a barra ter o teclado
            return 0;
          });
        }
      }
    };
    const onBlur = (): void => {
      altTap = false;
      setAltHeld(false);
      setMenuNavIdx(null); // perdeu o foco da janela -> sai da navegacao da barra
    };
    // Alt+CLIQUE e o conta-gotas: clicar com o Alt segurado NAO e um tap (senao soltar o Alt
    // depois de picar a cor ativaria a barra de menu sem querer)
    const onMouseDown = (): void => {
      altTap = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [openTitlebarMenu]);

  // barra ATIVADA (menuNavIdx != null, sem popup aberto): setas movem o foco entre os menus, Enter/
  // seta-baixo ABRE, letra vai direto, Esc/Alt saem. So enquanto NENHUM popup esta aberto (com o
  // popup nativo aberto o teclado e dele: setas/Enter/Esc funcionam la dentro).
  useEffect(() => {
    if (menuNavIdx === null) return;
    const onKey = (e: KeyboardEvent): void => {
      // TRAVA: se o foco caiu num campo de texto, sai da barra e deixa a tecla passar (nao trapear)
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        setMenuNavIdx(null);
        return;
      }
      if (e.key === "ArrowRight" && !e.altKey) {
        e.preventDefault();
        setMenuNavIdx((i) => ((i ?? -1) + 1) % TB_MENUS.length);
      } else if (e.key === "ArrowLeft" && !e.altKey) {
        e.preventDefault();
        setMenuNavIdx((i) => ((i ?? 0) - 1 + TB_MENUS.length) % TB_MENUS.length);
      } else if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openTitlebarMenu(menuNavIdx, true); // abre o menu em foco (Esc dentro dele volta pra barra)
      } else if (e.key === "Escape") {
        e.preventDefault();
        setMenuNavIdx(null); // sai da barra
      } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // letra (sem Alt): mnemonico abre o menu; qualquer outra imprimivel SAI da barra (nao trapeia)
        const idx = TB_MENUS.findIndex((m) => m.alt === e.key.toLowerCase());
        if (idx >= 0) {
          e.preventDefault();
          openTitlebarMenu(idx, true);
        } else {
          setMenuNavIdx(null);
        }
      }
    };
    // clicar fora dos botoes do menu sai da barra
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement)?.closest?.(".tb-nav")) setMenuNavIdx(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [menuNavIdx, openTitlebarMenu]);

  // popup aberto POR teclado fechou (Esc/selecionou)? volta pra barra ativada (Esc de novo sai).
  // So quando openMenuIdx faz aberto -> fechado (-1); hover-switch vai idx1 -> idx2, nao dispara.
  useEffect(() => {
    if (prevOpenMenuRef.current >= 0 && openMenuIdx === -1 && navReturnRef.current !== null) {
      setMenuNavIdx(navReturnRef.current);
      navReturnRef.current = null;
    }
    prevOpenMenuRef.current = openMenuIdx;
  }, [openMenuIdx]);

  const cursor = panning ? (dragging.current ? "grabbing" : "grab") : "crosshair";

  const fileName = path ? path.split(/[\\/]/).pop() : null;

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {/* barra de titulo custom (arrasta a janela); barra de menu com botoes por item.
          os indices batem com o template do menu: Arquivo=0, Editar=1, Exibir=2, Janela=3, Ajuda=4 */}
      <div className="titlebar">
        {/* .menuopen: com popup aberto o :hover congela no botao clicado (mouse capturado);
            a classe neutraliza o hover e so o .open (vindo do main) acende */}
        <div className={"tb-nav" + (openMenuIdx >= 0 ? " menuopen" : "")}>
          {TB_MENUS.map(({ label, alt }, i) => {
            // sublinha a letra do acelerador enquanto o Alt esta segurado (padrao Windows)
            const ai = altHeld ? label.toLowerCase().indexOf(alt) : -1;
            return (
              <button
                key={label}
                className={"tb-menub" + (openMenuIdx === i ? " open" : "") + (menuNavIdx === i ? " navfocus" : "")}
                title={`${label} (Alt+${alt.toUpperCase()})`}
                onClick={() => openTitlebarMenu(i)}
              >
                {ai < 0 ? (
                  label
                ) : (
                  <>
                    {label.slice(0, ai)}
                    <u>{label[ai]}</u>
                    {label.slice(ai + 1)}
                  </>
                )}
              </button>
            );
          })}
        </div>
        <div className="tb-navsep" />
        <div className="tb-title">
          <span className="tb-app">tile studio</span>
          {fileName && <span className="tb-sep">·</span>}
          {fileName && <span className="tb-ctx" title={path ?? ""}>{fileName}{dirty ? " *" : ""}</span>}
        </div>
      </div>

      {/* banner de atualizacao (electron-updater): discreto, abaixo da barra de titulo */}
      {upd && (
        <div className={"updbar" + (upd.state === "error" ? " err" : "")}>
          <span className="updbar-txt">
            {upd.state === "checking" && "verificando atualizacoes..."}
            {upd.state === "none" && "nenhuma atualizacao disponivel"}
            {upd.state === "dev" && "verificacao disponivel so no app instalado"}
            {upd.state === "available" && `v${upd.version} disponivel`}
            {upd.state === "downloading" && `baixando v${upd.version ?? "?"}... ${upd.percent ?? 0}%`}
            {upd.state === "downloaded" && `atualizacao pronta (v${upd.version ?? "?"})`}
            {upd.state === "error" && `erro ao atualizar: ${upd.error ?? "?"}`}
          </span>
          {upd.state === "downloading" && (
            <span className="updbar-prog">
              <span style={{ width: `${upd.percent ?? 0}%` }} />
            </span>
          )}
          {upd.state === "available" && (
            <button className="updbar-btn" onClick={() => void window.api.updDownload()}>Baixar</button>
          )}
          {upd.state === "downloaded" && (
            <button className="updbar-btn" onClick={() => void window.api.updInstall()}>Reiniciar agora</button>
          )}
          <button className="updbar-close" onClick={() => setUpd(null)} title="fechar">×</button>
        </div>
      )}

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
              <div className="prefsec">
                <div className="prefsec-title">Atualizacoes</div>
                <label className="preflabel">
                  <input
                    type="checkbox"
                    checked={updOnBoot}
                    onChange={(e) => {
                      setUpdOnBoot(e.target.checked);
                      localStorage.setItem("tilestudio:updOnBoot", e.target.checked ? "1" : "0");
                    }}
                  />
                  <span>
                    Verificar atualizacoes ao iniciar
                    <small>checa em segundo plano ~10s depois de abrir; so avisa se houver versao nova</small>
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

      {/* modal de CONFIRMACAO generico (substitui o window.confirm, que trava o foco no Electron) */}
      {confirmState && (
        <div className="modal-backdrop" onClick={() => setConfirmState(null)}>
          <div className="prefswin" onClick={(e) => e.stopPropagation()}>
            <div className="prefswin-head">
              <span>Confirmar</span>
              <button className="prefswin-close" onClick={() => setConfirmState(null)} title="fechar (Esc)">×</button>
            </div>
            <div className="prefswin-body">
              <div className="confirm-msg">{confirmState.msg}</div>
            </div>
            <div className="prefswin-foot">
              <button className="secondary" onClick={() => setConfirmState(null)}>Cancelar</button>
              <button
                className="primary"
                onClick={() => {
                  confirmState.onOk();
                  setConfirmState(null);
                }}
              >
                {confirmState.okLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* mini-modal de PROMPT com input (substitui o window.prompt): renomear presets, ir-para offset */}
      {promptState && (
        <div className="modal-backdrop" onClick={() => setPromptState(null)}>
          <div className="prefswin" onClick={(e) => e.stopPropagation()}>
            <div className="prefswin-head">
              <span>{promptState.title}</span>
              <button className="prefswin-close" onClick={() => setPromptState(null)} title="fechar (Esc)">×</button>
            </div>
            <div className="prefswin-body">
              <input
                className="prompt-input"
                type="text"
                autoFocus
                spellCheck={false}
                value={promptState.value}
                onChange={(e) => setPromptState((s) => (s ? { ...s, value: e.target.value } : s))}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    promptState.onOk(promptState.value);
                    setPromptState(null);
                  }
                }}
              />
              {promptState.hint && <div className="hint">{promptState.hint}</div>}
            </div>
            <div className="prefswin-foot">
              <button className="secondary" onClick={() => setPromptState(null)}>Cancelar</button>
              <button
                className="primary"
                onClick={() => {
                  promptState.onOk(promptState.value);
                  setPromptState(null);
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* modal Sobre (o main manda menu:about; dialog nativo travava o foco) */}
      {showAbout && (
        <div className="modal-backdrop" onClick={() => setShowAbout(false)}>
          <div className="prefswin" onClick={(e) => e.stopPropagation()}>
            <div className="prefswin-head">
              <span>Sobre</span>
              <button className="prefswin-close" onClick={() => setShowAbout(false)} title="fechar (Esc)">×</button>
            </div>
            <div className="prefswin-body">
              <div className="about-logo">tile studio<span className="caret">_</span></div>
              <div className="about-title">Editor/visualizador de tiles graficos (estilo Tile Molester)</div>
              <div className="kv"><span>Versao</span><b>v{appInfo?.version ?? "?"}</b></div>
              <div className="kv"><span>Suite</span><b>TIM Studio · Tile Studio · LoM Studio</b></div>
              <div className="kv">
                <span>Runtimes</span>
                <b>Electron {appInfo?.electron ?? "?"} · Chrome {appInfo?.chrome ?? "?"} · Node {appInfo?.node ?? "?"}</b>
              </div>
              <div className="prefsec">
                <div className="prefsec-title">Creditos</div>
                <p className="about-lic">
                  Inspirado no Tile Molester (SnowBro). Parte da suite de ferramentas do projeto
                  Legend of Mana PSX PT-BR.
                </p>
              </div>
            </div>
            <div className="prefswin-foot">
              <button className="primary" onClick={() => setShowAbout(false)}>Fechar</button>
            </div>
          </div>
        </div>
      )}

      <div className="appbody">
      <aside className="sidebar">
        <button className="primary" onClick={() => open()}>Abrir arquivo</button>
        {path && <div className="folder" title={path}>{path}{dirty ? " *" : ""}</div>}

        {/* ferramentas em 3 letras, estilo terminal (tooltip explica cada uma) */}
        <div className="toolrow">
          <button
            className={"tool" + (tool === "edit" && !tempPan ? " on" : "")}
            onClick={() => setTool("edit")}
            title="EDITAR: clicar pinta pixels (Alt+clique = conta-gotas)"
          >edi</button>
          <button
            className={"tool" + (panning ? " on" : "")}
            onClick={() => setTool("pan")}
            title="NAVEGAR: clicar-e-arrastar move a imagem (segurar Espaco tambem)"
          >nav</button>
          <button
            className={"tool" + (tool === "fill" && !tempPan ? " on" : "")}
            onClick={() => setTool("fill")}
            title="BALDE: clique preenche a area contigua da mesma cor com a cor de pintura (flood fill 4 direcoes, limitado a vista atual; 1 clique = 1 desfazer)"
          >bal</button>
          <button
            className={"tool" + (tool === "select" && !tempPan ? " on" : "")}
            onClick={() => setTool("select")}
            title="SELECIONAR: arraste um retangulo; Ctrl+C copia (interno + imagem pro sistema), Ctrl+V cola no canto da selecao (aceita imagem do Photoshop, cores ajustadas pra paleta); Esc limpa"
          >sel</button>
        </div>

        <div className="tile">
          {/* codec por console (ITEM 1): ao escolher um console, bpp e tile 8x8 ficam TRAVADOS
              (o formato define o intercalamento real dos bits/planos). "generico" = bpp/modo. */}
          <label>codec
            <select value={codec} onChange={(e) => applyCodec(e.target.value as ConsoleCodec)}>
              <option value="generic">generico (bpp/modo)</option>
              <optgroup label="Consoles (8x8)">
                {(Object.keys(CONSOLE_CODECS) as Exclude<ConsoleCodec, "generic">[]).map((c) => (
                  <option key={c} value={c}>{CONSOLE_CODECS[c].label}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>bpp
            <select value={bpp} onChange={(e) => setBpp(+e.target.value as TileConfig["bpp"])} disabled={codecOn} title={codecOn ? "travado pelo codec do console" : undefined}>
              {[1, 2, 4, 8, 16, 24].map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label>modo
            <select value={mode} onChange={(e) => setMode(e.target.value as PixelMode)} disabled={!indexed || codecOn}>
              <option value="planar">planar</option>
              <option value="linear">linear</option>
            </select>
          </label>
          <label>tile largura{num(tileW, setTileW, 1, codecOn)}</label>
          <label>tile altura{num(tileH, setTileH, 1, codecOn)}</label>
          <label>colunas{num(cols, setCols, 1)}</label>
          <label>linhas (tiles){num(tileRows, setTileRows, 1)}</label>
          {/* offset em TEXTO: aceita decimal (6656) e hex (0x1A00/$1A00); Enter/blur aplica */}
          <label>offset (bytes)
            <input
              type="text"
              value={offsetText}
              spellCheck={false}
              onChange={(e) => setOffsetText(e.target.value)}
              onBlur={commitOffsetText}
              onKeyDown={(e) => { if (e.key === "Enter") commitOffsetText(); }}
              title={`decimal ou hex com prefixo 0x/$ · atual: ${offset} (${fmtHex(offset)}) · Ctrl+G = ir para (hex)`}
            />
          </label>
          {/* eco do offset atual tambem em hex (pra conferir alinhamento sem converter de cabeca) */}
          <div className="offsethex">offset {offset} ({fmtHex(offset)})</div>
          {mode === "linear" && indexed && !codecOn && (
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
          <button className="secondary" onClick={() => step(-tileRows)} title="pagina pra tras (PageUp)">{"<<"}</button>
          <button className="secondary" onClick={() => step(-1)} title="1 linha de tiles pra tras (seta cima)">{"<"}</button>
          <button className="secondary" onClick={() => step(1)} title="1 linha de tiles pra frente (seta baixo)">{">"}</button>
          <button className="secondary" onClick={() => step(tileRows)} title="pagina pra frente (PageDown)">{">>"}</button>
        </div>
        {/* nudge FINO (+-1 byte) pra achar o alinhamento dos tiles + ir-para offset em hex */}
        <div className="nav">
          <button className="secondary" onClick={() => setOffset((o) => Math.max(0, o - 1))} title="offset -1 byte (Shift+seta esquerda)">-1B</button>
          <button className="secondary" onClick={() => setOffset((o) => o + 1)} title="offset +1 byte (Shift+seta direita)">+1B</button>
          <button className="secondary" onClick={gotoOffset} title="ir para offset em hex (Ctrl+G)">goto</button>
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
        {selRect && (
          <button
            className="secondary"
            onClick={exportSelPng}
            title="salva SO o retangulo selecionado como PNG (mesmo caminho do Exportar PNG)"
          >
            Exportar selecao (PNG)
          </button>
        )}
        {/* ITEM 4: transformar a selecao (1 passo de undo). Girar 90° so em selecao quadrada. */}
        {selRect && (
          <div className="btnrow">
            <button className="secondary" onClick={() => transformSelection("flipH")} title="espelhar a selecao na horizontal">Espelhar H</button>
            <button className="secondary" onClick={() => transformSelection("flipV")} title="espelhar a selecao na vertical">Espelhar V</button>
            <button
              className="secondary"
              onClick={() => transformSelection("rot90")}
              disabled={selRect.w !== selRect.h}
              title={selRect.w !== selRect.h ? "girar 90° requer selecao quadrada (w = h)" : "girar 90° (horario)"}
            >Girar 90°</button>
          </div>
        )}
        <button
          className="secondary"
          onClick={importPng}
          disabled={!view}
          title="aplica um PNG por cima da vista atual (round-trip com o Exportar PNG); cores ajustadas pra paleta"
        >
          Importar PNG
        </button>
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
        <h2>tile studio<span className="caret">_</span><span className="ver">v0.8</span></h2>

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
            {/* seletor de CLUT: so aparece pra TIM com mais de uma paleta (multi-CLUT) */}
            {timClut && timClut.clutH > 1 && (
              <label className="clutsel">
                CLUT do TIM ({timClut.clutH})
                <select
                  value={timClutIdx}
                  onChange={(e) => {
                    const row = +e.target.value;
                    setTimClutIdx(row);
                    setPalette(clutRowToRgba(timClut.clut, timClut.clutW, row));
                    setMsg(`CLUT ${row} aplicada`);
                  }}
                >
                  {Array.from({ length: timClut.clutH }, (_, i) => (
                    <option key={i} value={i}>CLUT {i}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="btnrow">
              <button className="secondary" onClick={loadPalette}>Paleta (PNG)</button>
              {palette && <button className="secondary" onClick={() => setPalette(null)}>Cinza</button>}
            </div>
            <button
              className="secondary"
              onClick={importPalette}
              title="importa uma paleta de arquivo .ACT (Adobe), .PAL (Microsoft RIFF ou JASC-PAL texto) ou .PNG"
            >Importar paleta (.act/.pal/.png)</button>
            <button
              className="secondary"
              onClick={exportPalette}
              title="salva a paleta atual como .ACT (Adobe Color Table) pro Photoshop"
            >Exportar paleta (.ACT)</button>

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
            <div className="kv"><span>Ferramenta</span><b>{panning ? "navegar (pan)" : tool === "select" ? "selecionar" : tool === "fill" ? "balde" : "editar"}</b></div>
            <div className="kv"><span>Historico</span><b>{histLen.u} desfazer / {histLen.r} refazer</b></div>
            <div className="kv"><span>Offset</span><b>{offset} ({fmtHex(offset)})</b></div>
            <div className="kv"><span>Bytes/tile</span><b>{bytesPerTile}</b></div>
            <div className="kv"><span>Bytes/linha</span><b>{bytesPerTileRow}</b></div>
            <div className="kv"><span>Canvas</span><b>{view.width}×{view.height}</b></div>
            <div className="kv"><span>Tiles</span><b>{view.tileCount}</b></div>
            <div className="kv"><span>Tile</span><b>{tileW}×{tileH} {bpp}bpp {codecOn ? CONSOLE_CODECS[codec as Exclude<ConsoleCodec, "generic">].label : indexed ? mode : "direto"}</b></div>
          </>
        )}
        <p className="hint">
          Clone do Tile Molester. Ctrl+Z desfaz edicoes de pixel (nao mexe em bpp/zoom/offset).
          Segure Espaco pra pan temporario. Alt+clique = conta-gotas. Ctrl+G = ir para offset (hex).
          Shift+setas esquerda/direita = offset ±1 byte. Fonte LoM = 1bpp planar, tile 16×12.
        </p>
      </aside>
      </div>
    </div>
  );
}
