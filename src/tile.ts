/**
 * Codec de tiles configuravel, inspirado no Tile Molester (Kent Hansen, GPL).
 *
 * Modelo:
 *  - Um "tile" tem largura/altura em pixels (ex.: 8x8, 16x12, 16x16). No Tile Molester
 *    o tile atomico e sempre 8x8, mas aqui generalizamos: cada tile e um bloco W_t x H_t.
 *  - bpp: bits por pixel (1,2,4,8 indexados; 16 e 24 sao cor direta).
 *  - modo de pixel:
 *      "planar"  -> bitplanes por linha: para cada linha, primeiro todos os bytes do plano 0,
 *                   depois plano 1, etc. MSB = pixel da esquerda. (fonte do Legend of Mana:
 *                   1bpp planar, glifo 16x12, 24 bytes = 12 linhas x 2 bytes.)
 *      "linear"  -> pixels empacotados: cada byte carrega varios pixels em sequencia.
 *                   ordering in-order (MSB=esquerda) ou reverse (LSB=esquerda).
 *  - Os tiles sao dispostos num canvas de N colunas (grid), igual ao Tile Molester.
 *
 * Tudo puro (Uint8Array). decodeTiles() gera RGBA; readPixelIndex/writePixelIndex
 * fazem a leitura/edicao de um pixel individual de volta nos bytes.
 */

export type PixelMode = "planar" | "linear";

export interface TileConfig {
  bpp: 1 | 2 | 4 | 8 | 16 | 24;
  mode: PixelMode; // "planar" ou "linear" (ignorado para 16/24bpp = cor direta)
  tileW: number; // largura do tile em pixels
  tileH: number; // altura do tile em pixels
  cols: number; // quantas colunas de tiles no canvas (largura do canvas em tiles)
  tileCount?: number; // quantos tiles decodificar; se omitido, deriva do tamanho dos dados
  reverse?: boolean; // linear: ordering reverse (LSB = pixel da esquerda)
  palette?: Uint8Array; // RGBA por indice (para bpp<=8); default: rampa de cinza
  byteOffset?: number; // pula N bytes antes de comecar (ex.: cabecalho)
}

/** Rampa de cinza com n cores (RGBA). */
export function grayPaletteRGBA(n: number): Uint8Array {
  const p = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = n <= 1 ? 0 : Math.round((i / (n - 1)) * 255);
    p[i * 4] = v;
    p[i * 4 + 1] = v;
    p[i * 4 + 2] = v;
    p[i * 4 + 3] = 255;
  }
  return p;
}

/** Bytes ocupados por UM tile no stream, para a config dada. */
export function tileSizeBytes(cfg: TileConfig): number {
  const { bpp, tileW, tileH } = cfg;
  if (bpp === 16) return tileW * tileH * 2;
  if (bpp === 24) return tileW * tileH * 3;
  // indexados (planar e linear ocupam o mesmo total): W*H*bpp bits, arredondado por linha.
  const bytesPerRow = Math.ceil((tileW * bpp) / 8);
  return bytesPerRow * tileH;
}

/**
 * Le o indice/valor de UM pixel (tx,ty dentro do tile em (px,py)) direto dos bytes.
 * Retorna o indice de paleta (bpp<=8) ou o valor cru de cor (16/24bpp).
 * `tileBase` e o offset em bytes onde o tile comeca.
 */
export function readPixelIndex(
  data: Uint8Array,
  cfg: TileConfig,
  tileBase: number,
  px: number,
  py: number,
): number {
  const { bpp, tileW } = cfg;
  if (bpp === 16) {
    const o = tileBase + (py * tileW + px) * 2;
    return data[o] | (data[o + 1] << 8);
  }
  if (bpp === 24) {
    const o = tileBase + (py * tileW + px) * 3;
    return data[o] | (data[o + 1] << 8) | (data[o + 2] << 16);
  }
  const bytesPerRow = Math.ceil((tileW * bpp) / 8);
  const rowBase = tileBase + py * bytesPerRow;
  if (cfg.mode === "planar") {
    // um bitplane por byte-slice da linha; MSB = pixel da esquerda.
    let val = 0;
    for (let plane = 0; plane < bpp; plane++) {
      // byte que contem o bit deste pixel neste plano
      const byteInRow = plane * Math.ceil(tileW / 8) + (px >> 3);
      const b = data[rowBase + byteInRow] ?? 0;
      const bit = (b >> (7 - (px & 7))) & 1;
      val |= bit << plane;
    }
    return val;
  }
  // linear: pixels empacotados dentro do byte
  const pixelsPerByte = 8 / bpp;
  const byteInRow = Math.floor(px / pixelsPerByte);
  const b = data[rowBase + byteInRow] ?? 0;
  const within = px % pixelsPerByte; // 0 = mais a esquerda
  const mask = (1 << bpp) - 1;
  // in-order: pixel 0 nos bits altos; reverse: pixel 0 nos bits baixos
  const shift = cfg.reverse ? within * bpp : (pixelsPerByte - 1 - within) * bpp;
  return (b >> shift) & mask;
}

/**
 * Grava o indice/valor de UM pixel de volta nos bytes (edicao). Espelha readPixelIndex.
 */
export function writePixelIndex(
  data: Uint8Array,
  cfg: TileConfig,
  tileBase: number,
  px: number,
  py: number,
  value: number,
): void {
  const { bpp, tileW } = cfg;
  if (bpp === 16) {
    const o = tileBase + (py * tileW + px) * 2;
    data[o] = value & 0xff;
    data[o + 1] = (value >> 8) & 0xff;
    return;
  }
  if (bpp === 24) {
    const o = tileBase + (py * tileW + px) * 3;
    data[o] = value & 0xff;
    data[o + 1] = (value >> 8) & 0xff;
    data[o + 2] = (value >> 16) & 0xff;
    return;
  }
  const bytesPerRow = Math.ceil((tileW * bpp) / 8);
  const rowBase = tileBase + py * bytesPerRow;
  if (cfg.mode === "planar") {
    for (let plane = 0; plane < bpp; plane++) {
      const byteInRow = plane * Math.ceil(tileW / 8) + (px >> 3);
      const o = rowBase + byteInRow;
      if (o < 0 || o >= data.length) continue;
      const bitPos = 7 - (px & 7);
      const bit = (value >> plane) & 1;
      data[o] = (data[o] & ~(1 << bitPos)) | (bit << bitPos);
    }
    return;
  }
  const pixelsPerByte = 8 / bpp;
  const byteInRow = Math.floor(px / pixelsPerByte);
  const o = rowBase + byteInRow;
  if (o < 0 || o >= data.length) return;
  const within = px % pixelsPerByte;
  const mask = (1 << bpp) - 1;
  const shift = cfg.reverse ? within * bpp : (pixelsPerByte - 1 - within) * bpp;
  data[o] = (data[o] & ~(mask << shift)) | ((value & mask) << shift);
}

/** Converte um valor de cor direta (16/24bpp) para RGBA. */
function directToRGBA(bpp: 16 | 24, c: number, out: Uint8Array, o: number): void {
  if (bpp === 24) {
    out[o] = c & 0xff;
    out[o + 1] = (c >> 8) & 0xff;
    out[o + 2] = (c >> 16) & 0xff;
    out[o + 3] = 255;
    return;
  }
  // 16bpp = ABGR1555 (PSX): bit15=STP/alpha, 5-5-5
  const r5 = c & 31;
  const g5 = (c >> 5) & 31;
  const b5 = (c >> 10) & 31;
  out[o] = (r5 << 3) | (r5 >> 2);
  out[o + 1] = (g5 << 3) | (g5 >> 2);
  out[o + 2] = (b5 << 3) | (b5 >> 2);
  out[o + 3] = c === 0 ? 0 : 255;
}

/**
 * Empacota uma cor RGB (0-255) no valor cru de cor direta pra gravar com writePixelIndex.
 * 16bpp = ABGR1555 do PSX (5-5-5 + bit STP no bit15); 24bpp = 0xBBGGRR.
 * @param stp bit STP/mascara do 16bpp (0 ou 1). Ignorado no 24bpp.
 */
export function rgbToDirect(
  bpp: 16 | 24,
  r: number,
  g: number,
  b: number,
  stp = 0,
): number {
  if (bpp === 24) {
    return (r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16);
  }
  // 5 bits por canal (arredonda de 8->5)
  const r5 = (r >> 3) & 31;
  const g5 = (g >> 3) & 31;
  const b5 = (b >> 3) & 31;
  return r5 | (g5 << 5) | (b5 << 10) | ((stp & 1) << 15);
}

/** Extrai o RGB (0-255) de um valor de cor direta. Inverso de rgbToDirect. */
export function directToRgb(
  bpp: 16 | 24,
  c: number,
): { r: number; g: number; b: number; stp: number } {
  if (bpp === 24) {
    return { r: c & 0xff, g: (c >> 8) & 0xff, b: (c >> 16) & 0xff, stp: 0 };
  }
  const r5 = c & 31;
  const g5 = (c >> 5) & 31;
  const b5 = (c >> 10) & 31;
  return {
    r: (r5 << 3) | (r5 >> 2),
    g: (g5 << 3) | (g5 >> 2),
    b: (b5 << 3) | (b5 >> 2),
    stp: (c >> 15) & 1,
  };
}

/**
 * Decodifica um grid de tiles num buffer RGBA. Dispoe `cols` tiles por linha.
 */
export function decodeTiles(
  data: Uint8Array,
  cfg: TileConfig,
): { width: number; height: number; rgba: Uint8Array; tileCount: number } {
  const off = cfg.byteOffset || 0;
  const { bpp, tileW, tileH, cols } = cfg;
  const tsz = tileSizeBytes(cfg);
  const avail = Math.max(0, data.length - off);
  const maxTiles = Math.floor(avail / tsz);
  const tileCount = Math.min(cfg.tileCount ?? maxTiles, maxTiles);
  const rowsOfTiles = Math.max(1, Math.ceil(tileCount / cols));

  const W = cols * tileW;
  const H = rowsOfTiles * tileH;
  const pal = cfg.palette || grayPaletteRGBA(bpp <= 8 ? 1 << bpp : 1);
  const rgba = new Uint8Array(W * H * 4);

  for (let t = 0; t < tileCount; t++) {
    const tileBase = off + t * tsz;
    const gridX = (t % cols) * tileW; // canto do tile no canvas
    const gridY = Math.floor(t / cols) * tileH;
    for (let py = 0; py < tileH; py++) {
      for (let px = 0; px < tileW; px++) {
        const o = ((gridY + py) * W + (gridX + px)) * 4;
        if (bpp === 16 || bpp === 24) {
          directToRGBA(bpp, readPixelIndex(data, cfg, tileBase, px, py), rgba, o);
        } else {
          const idx = readPixelIndex(data, cfg, tileBase, px, py);
          rgba[o] = pal[idx * 4] ?? 0;
          rgba[o + 1] = pal[idx * 4 + 1] ?? 0;
          rgba[o + 2] = pal[idx * 4 + 2] ?? 0;
          rgba[o + 3] = pal[idx * 4 + 3] ?? 255;
        }
      }
    }
  }
  return { width: W, height: H, rgba, tileCount };
}

/**
 * Dado um pixel (x,y) no canvas, resolve qual tile e a coordenada local, e retorna
 * o offset em bytes daquele tile. Util pra edicao a partir de um clique.
 */
export function locatePixel(
  cfg: TileConfig,
  x: number,
  y: number,
): { tileIndex: number; tileBase: number; px: number; py: number } {
  const off = cfg.byteOffset || 0;
  const tsz = tileSizeBytes(cfg);
  const tx = Math.floor(x / cfg.tileW);
  const ty = Math.floor(y / cfg.tileH);
  const tileIndex = ty * cfg.cols + tx;
  return {
    tileIndex,
    tileBase: off + tileIndex * tsz,
    px: x % cfg.tileW,
    py: y % cfg.tileH,
  };
}

/**
 * Gera uma paleta no formato Adobe Color Table (.ACT), pra usar no Photoshop (Imagem >
 * Modo > Cores indexadas > carregar tabela). Sao 256 triplas RGB (768 bytes) + um trailer
 * de 4 bytes: nº de cores (16-bit big-endian) e o indice transparente (0xFFFF = nenhum).
 * `palette` = cores da paleta em RGBA (0-255, 4 bytes por indice); `count` = quantas cores.
 */
export function encodeAct(palette: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(772);
  for (let i = 0; i < 256; i++) {
    if (i < count) {
      out[i * 3] = palette[i * 4] ?? 0;
      out[i * 3 + 1] = palette[i * 4 + 1] ?? 0;
      out[i * 3 + 2] = palette[i * 4 + 2] ?? 0;
    }
  }
  out[768] = (count >> 8) & 0xff; // nº de cores (big-endian)
  out[769] = count & 0xff;
  out[770] = 0xff; // indice transparente: nenhum
  out[771] = 0xff;
  return out;
}
