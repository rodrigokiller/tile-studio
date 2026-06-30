import { useEffect, useMemo, useRef, useState, useCallback, type DragEvent } from "react";
import { decodeTiles } from "../../tile";

async function pngToRgba(bytes: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const cv = document.createElement("canvas");
  cv.width = bmp.width;
  cv.height = bmp.height;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: bmp.width, height: bmp.height, rgba: new Uint8Array(d.data.buffer) };
}

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

export function App(): JSX.Element {
  const [path, setPath] = useState<string | null>(null);
  const [raw, setRaw] = useState<Uint8Array | null>(null);
  const [bpp, setBpp] = useState<4 | 8 | 16>(4);
  const [width, setWidth] = useState(128);
  const [tile, setTile] = useState(8);
  const [reverse, setReverse] = useState(false);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState(64); // quantas linhas de pixels mostrar
  const [zoom, setZoom] = useState(3);
  const [palette, setPalette] = useState<Uint8Array | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const open = useCallback(async (p?: string) => {
    const file = p ?? (await window.api.openFile());
    if (!file) return;
    setPath(file);
    setRaw(new Uint8Array(await window.api.readFile(file)));
    setOffset(0);
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
      return decodeTiles(raw, {
        bpp,
        width: Math.max(1, width),
        height: Math.max(1, rows),
        tile: tile > 0 ? tile : undefined,
        reverse,
        byteOffset: offset,
        palette: palette ?? undefined,
      });
    } catch {
      return null;
    }
  }, [raw, bpp, width, tile, reverse, offset, rows, palette]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !view) return;
    cv.width = view.width;
    cv.height = view.height;
    cv.getContext("2d")!.putImageData(
      new ImageData(new Uint8ClampedArray(view.rgba), view.width, view.height),
      0,
      0,
    );
  }, [view]);

  // navegacao pelo arquivo (1 linha = width pixels = width*bpp/8 bytes)
  const bytesPerRow = Math.max(1, Math.floor((width * bpp) / 8));
  const step = (mult: number) => setOffset((o) => Math.max(0, o + bytesPerRow * mult));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
      else if (e.key === "PageDown") { e.preventDefault(); step(rows); }
      else if (e.key === "PageUp") { e.preventDefault(); step(-rows); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bytesPerRow, rows]);

  const loadPalette = useCallback(async () => {
    const png = await window.api.openPng();
    if (!png) return;
    const { rgba } = await pngToRgba(await window.api.readFile(png));
    setPalette(paletteFromRgba(rgba, 1 << bpp));
    setMsg(`paleta carregada (${1 << bpp} cores)`);
  }, [bpp]);

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
    const out = await window.api.savePng(def);
    if (!out) return;
    await window.api.writeFile(out, new Uint8Array(await blob.arrayBuffer()));
    setMsg(`PNG salvo: ${out.split(/[\\/]/).pop()}`);
  }, [view, path]);

  const num = (v: number, set: (n: number) => void, min = 0) => (
    <input type="number" value={v} min={min} onChange={(e) => set(Math.max(min, +e.target.value))} />
  );

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <aside className="sidebar">
        <button className="primary" onClick={() => open()}>Abrir arquivo</button>
        {path && <div className="folder" title={path}>{path}</div>}

        <div className="tile">
          <label>bpp
            <select value={bpp} onChange={(e) => setBpp(+e.target.value as 4 | 8 | 16)}>
              <option value={4}>4</option>
              <option value={8}>8</option>
              <option value={16}>16</option>
            </select>
          </label>
          <label>largura (px){num(width, setWidth, 1)}</label>
          <label>tile (0=linear){num(tile, setTile, 0)}</label>
          <label>linhas{num(rows, setRows, 1)}</label>
          <label>offset (bytes){num(offset, setOffset, 0)}</label>
          <label className="chk"><input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} /> reverse (nibble)</label>
        </div>

        <div className="nav">
          <button className="secondary" onClick={() => step(-rows)}>{"<<"}</button>
          <button className="secondary" onClick={() => step(-1)}>{"<"}</button>
          <button className="secondary" onClick={() => step(1)}>{">"}</button>
          <button className="secondary" onClick={() => step(rows)}>{">>"}</button>
        </div>

        {bpp < 16 && (
          <div className="btnrow">
            <button className="secondary" onClick={loadPalette}>Paleta (PNG)</button>
            {palette && <button className="secondary" onClick={() => setPalette(null)}>Cinza</button>}
          </div>
        )}

        <label className="zoom">
          Zoom {zoom}×
          <input type="range" min={1} max={12} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
        </label>

        <button className="primary" onClick={exportPng}>Exportar PNG</button>
        {msg && <div className="msg">{msg}</div>}
      </aside>

      <main className="viewer">
        {view ? (
          <div className="canvas-wrap">
            <canvas
              ref={canvasRef}
              style={{ width: view.width * zoom, height: view.height * zoom, imageRendering: "pixelated" }}
            />
          </div>
        ) : (
          <div className="empty">// abra um arquivo (ou arraste). setas/PageUp/Down navegam.</div>
        )}
      </main>

      <aside className="inspector">
        <h2>tile studio<span className="caret">_</span><span className="ver">v0.1</span></h2>
        <p className="hint">
          Visualizador de tiles configuravel (estilo Tile Molester). Ajuste bpp, largura, tile e
          offset ate a imagem aparecer. Ex.: mapas WM do Legend of Mana = 4bpp, largura 1280, tile 8,
          reverse, offset 20.
        </p>
        {view && (
          <>
            <div className="kv"><span>Bytes/linha</span><b>{bytesPerRow}</b></div>
            <div className="kv"><span>Canvas</span><b>{view.width}×{view.height}</b></div>
            <div className="kv"><span>Paleta</span><b>{palette ? `PNG (${1 << bpp})` : `cinza (${bpp < 16 ? 1 << bpp : "-"})`}</b></div>
          </>
        )}
        <p className="hint">Proximo: desenhar/editar os tiles e re-exportar pro jogo (via TIM Studio / toolchain).</p>
      </aside>
    </div>
  );
}
