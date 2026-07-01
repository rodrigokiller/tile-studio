import { useEffect, useMemo, useRef, useState, useCallback, type DragEvent } from "react";
import {
  decodeTiles,
  grayPaletteRGBA,
  tileSizeBytes,
  writePixelIndex,
  readPixelIndex,
  locatePixel,
  rgbToDirect,
  type TileConfig,
  type PixelMode,
} from "../../tile";

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

  // ferramenta ativa: editar (pinta) ou navegar (pan). Espaco/Ctrl = pan temporario.
  const [tool, setTool] = useState<"edit" | "pan">("edit");
  const [tempPan, setTempPan] = useState(false);

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
    setPath(file);
    setRaw(new Uint8Array(await window.api.readFile(file)));
    setOffset(0);
    setDirty(false);
    setMsg(null);
    // arquivo novo: zera a historia de edicao
    undoStack.current = [];
    redoStack.current = [];
    setHistLen({ u: 0, r: 0 });
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) open(window.api.pathForFile(f));
    },
    [open],
  );

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

  const dragging = useRef(false);
  const panStart = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  const onCanvasDown = (e: React.MouseEvent) => {
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

  // presets rapidos
  const applyPreset = (p: "lomfont" | "tile8" | "tile16") => {
    if (p === "lomfont") { setBpp(1); setMode("planar"); setTileW(16); setTileH(12); setCols(16); setReverse(false); setOffset(0); }
    else if (p === "tile8") { setTileW(8); setTileH(8); }
    else if (p === "tile16") { setTileW(16); setTileH(16); }
  };

  const cursor = panning ? (dragging.current ? "grabbing" : "grab") : "crosshair";

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
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

        <div className="btnrow">
          <button className="secondary" onClick={() => applyPreset("lomfont")}>Fonte LoM</button>
          <button className="secondary" onClick={() => applyPreset("tile8")}>8×8</button>
          <button className="secondary" onClick={() => applyPreset("tile16")}>16×16</button>
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
        <h2>tile studio<span className="caret">_</span><span className="ver">v0.4</span></h2>

        {indexed && (
          <div className="palette">
            {/* COR ATUAL de pintura: swatch grande + rotulo */}
            <div className="curcolor">
              <div className="curlabel">Cor de pintura</div>
              <div className="curbox">
                <span className="curswatch" style={{ background: rgbaToHex(effPal!, palIndex) }} />
                <div className="curmeta">
                  <b>indice {palIndex}</b>
                  <span>{rgbaToHex(effPal!, palIndex)}</span>
                </div>
              </div>
            </div>

            <div className="kv"><span>Paleta</span><b>{palette ? "custom" : "cinza"} ({ncolors})</b></div>
            <div className="swatches">
              {Array.from({ length: ncolors }, (_, i) => (
                <label
                  key={i}
                  className={"palcell" + (i === palIndex ? " on" : "")}
                  title={`indice ${i} -- clique pra pintar com esta cor`}
                  onClick={() => setPalIndex(i)}
                  style={{ background: rgbaToHex(effPal!, i) }}
                >
                  <input
                    type="color"
                    value={rgbaToHex(effPal!, i)}
                    onChange={(e) => setPalColor(i, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
              ))}
            </div>
            <div className="btnrow">
              <button className="secondary" onClick={loadPalette}>Paleta (PNG)</button>
              {palette && <button className="secondary" onClick={() => setPalette(null)}>Cinza</button>}
            </div>
            <div className="hint">Clique numa celula pra escolher a cor de pintura (ela fica destacada). Clique de novo abre o color-picker daquele indice.</div>
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
          Segure Espaco pra pan temporario. Fonte LoM = 1bpp planar, tile 16×12.
        </p>
      </aside>
    </div>
  );
}
