import { useEffect, useMemo, useRef, useState, useCallback, type DragEvent } from "react";
import {
  decodeTiles,
  grayPaletteRGBA,
  tileSizeBytes,
  writePixelIndex,
  locatePixel,
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
  const [palIndex, setPalIndex] = useState(1); // cor "de frente" selecionada
  const [showGrid, setShowGrid] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const indexed = bpp <= 8;
  const ncolors = indexed ? 1 << bpp : 0;

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

  const open = useCallback(async (p?: string) => {
    const file = p ?? (await window.api.openFile());
    if (!file) return;
    setPath(file);
    setRaw(new Uint8Array(await window.api.readFile(file)));
    setOffset(0);
    setDirty(false);
    setMsg(null);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT") return;
      if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
      else if (e.key === "PageDown") { e.preventDefault(); step(tileRows); }
      else if (e.key === "PageUp") { e.preventDefault(); step(-tileRows); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bytesPerTileRow, tileRows]);

  // -- edicao de pixel (clique/arraste no canvas) -----------------------------
  const paintAt = useCallback(
    (clientX: number, clientY: number) => {
      const cv = canvasRef.current;
      if (!cv || !raw) return;
      const rect = cv.getBoundingClientRect();
      const x = Math.floor(((clientX - rect.left) / rect.width) * cv.width);
      const y = Math.floor(((clientY - rect.top) / rect.height) * cv.height);
      if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return;
      const loc = locatePixel(cfg, x, y);
      // valor a gravar: para indexado, o indice de paleta selecionado;
      // para cor direta, a cor da paleta selecionada convertida (aprox).
      let value = palIndex;
      if (bpp === 16 && effPal === undefined && palette) {
        value = 0; // sem paleta pra cor direta, nao pinta
      }
      writePixelIndex(raw, cfg, loc.tileBase, loc.px, loc.py, value);
      setRaw(new Uint8Array(raw)); // dispara re-render
      setDirty(true);
    },
    [raw, cfg, palIndex, bpp, effPal, palette],
  );

  const dragging = useRef(false);
  const onCanvasDown = (e: React.MouseEvent) => {
    if (!indexed) return; // edicao de pixel so pra bpp indexado por enquanto
    dragging.current = true;
    paintAt(e.clientX, e.clientY);
  };
  const onCanvasMove = (e: React.MouseEvent) => {
    if (dragging.current) paintAt(e.clientX, e.clientY);
  };
  useEffect(() => {
    const up = () => (dragging.current = false);
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

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <aside className="sidebar">
        <button className="primary" onClick={() => open()}>Abrir arquivo</button>
        {path && <div className="folder" title={path}>{path}{dirty ? " *" : ""}</div>}

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

      <main className="viewer">
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
                cursor: indexed ? "crosshair" : "default",
              }}
            />
          </div>
        ) : (
          <div className="empty">// abra um arquivo (ou arraste). clique nos tiles pra pintar. setas/PageUp/Down navegam.</div>
        )}
      </main>

      <aside className="inspector">
        <h2>tile studio<span className="caret">_</span><span className="ver">v0.2</span></h2>

        {indexed && (
          <div className="palette">
            <div className="kv"><span>Paleta</span><b>{palette ? "custom" : "cinza"} ({ncolors})</b></div>
            <div className="swatches">
              {Array.from({ length: ncolors }, (_, i) => (
                <label
                  key={i}
                  className={"palcell" + (i === palIndex ? " on" : "")}
                  title={`indice ${i}`}
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
            <div className="hint">Cor selecionada: indice {palIndex}. Clique num tile pra pintar; clique no quadradinho pra abrir o color-picker.</div>
          </div>
        )}

        {view && (
          <>
            <div className="kv"><span>Bytes/tile</span><b>{bytesPerTile}</b></div>
            <div className="kv"><span>Bytes/linha</span><b>{bytesPerTileRow}</b></div>
            <div className="kv"><span>Canvas</span><b>{view.width}×{view.height}</b></div>
            <div className="kv"><span>Tiles</span><b>{view.tileCount}</b></div>
            <div className="kv"><span>Tile</span><b>{tileW}×{tileH} {bpp}bpp {indexed ? mode : "direto"}</b></div>
          </>
        )}
        <p className="hint">
          Clone do Tile Molester. Fonte do Legend of Mana = preset "Fonte LoM"
          (1bpp planar, tile 16×12). Mapas WM = 4bpp, tile 8×8, offset 20.
        </p>
      </aside>
    </div>
  );
}
