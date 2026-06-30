/**
 * Decodificador "raw / tile" configuravel (estilo Tile Molester), para graficos que NAO sao
 * TIM padrao renderizavel linearmente: os mapas-mundi (WM*.TIM, 4bpp tiles) e possivelmente
 * a tela de titulo. Puro (Uint8Array). Permite escolher bpp, largura, modo tile e paleta.
 */

export interface TileConfig {
  bpp: 4 | 8 | 16;
  width: number; // largura do canvas em pixels
  height?: number; // altura; se omitida, derivada do tamanho dos dados
  reverse?: boolean; // 4bpp: inverte qual nibble e o primeiro pixel
  tile?: number; // se >0, arranjo 2D em tiles (tile x tile); senao, linhas lineares
  palette?: Uint8Array; // RGBA por indice (para bpp<16); default: rampa de cinza
  byteOffset?: number; // pula N bytes (ex.: cabecalho TIM de 20 bytes)
}

export function grayPaletteRGBA(n: number): Uint8Array {
  const p = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = n === 1 ? 0 : Math.round((i / (n - 1)) * 255);
    p[i * 4] = v;
    p[i * 4 + 1] = v;
    p[i * 4 + 2] = v;
    p[i * 4 + 3] = 255;
  }
  return p;
}

export function decodeTiles(
  data: Uint8Array,
  cfg: TileConfig,
): { width: number; height: number; rgba: Uint8Array } {
  const off = cfg.byteOffset || 0;
  const bpp = cfg.bpp;
  const W = cfg.width;
  const avail = data.length - off;
  const totalPx = Math.floor((avail * 8) / bpp);
  const H = cfg.height || Math.max(1, Math.floor(totalPx / W));
  const pal = cfg.palette || grayPaletteRGBA(bpp >= 16 ? 1 : 1 << bpp);
  const rgba = new Uint8Array(W * H * 4);

  // indice de armazenamento (ordem no stream) para o pixel (x,y) do canvas
  const storeIndex = (x: number, y: number): number => {
    if (!cfg.tile) return y * W + x;
    const T = cfg.tile;
    const tilesPerRow = Math.max(1, Math.floor(W / T));
    const tx = Math.floor(x / T);
    const ty = Math.floor(y / T);
    const ix = x % T;
    const iy = y % T;
    return (ty * tilesPerRow + tx) * T * T + iy * T + ix;
  };

  const readValue = (si: number): number => {
    if (bpp === 16) {
      const o = off + si * 2;
      return data[o] | (data[o + 1] << 8);
    }
    if (bpp === 8) return data[off + si] ?? 0;
    // 4bpp
    const byte = data[off + (si >> 1)] ?? 0;
    const hi = (si & 1) === (cfg.reverse ? 0 : 1);
    return hi ? byte >> 4 : byte & 0x0f;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = storeIndex(x, y);
      const o = (y * W + x) * 4;
      if (bpp === 16) {
        const c = readValue(si);
        const r5 = c & 31;
        const g5 = (c >> 5) & 31;
        const b5 = (c >> 10) & 31;
        rgba[o] = (r5 << 3) | (r5 >> 2);
        rgba[o + 1] = (g5 << 3) | (g5 >> 2);
        rgba[o + 2] = (b5 << 3) | (b5 >> 2);
        rgba[o + 3] = c === 0 ? 0 : 255;
      } else {
        const idx = readValue(si);
        rgba[o] = pal[idx * 4];
        rgba[o + 1] = pal[idx * 4 + 1];
        rgba[o + 2] = pal[idx * 4 + 2];
        rgba[o + 3] = pal[idx * 4 + 3];
      }
    }
  }
  return { width: W, height: H, rgba };
}
