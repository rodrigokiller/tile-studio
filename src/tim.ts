/**
 * TIM (PlayStation) image codec.
 *
 * A .TIM file is the standard PSX texture format. Layout:
 *
 *   u32  id     = 0x00000010            (magic: byte 0x10 then 00 00 00)
 *   u32  flags  bits0-2 = pixel mode    (0=4bpp, 1=8bpp, 2=16bpp, 3=24bpp, 4=mixed)
 *               bit3    = CF            (1 = a CLUT/palette block follows)
 *   [CLUT block]  (only if CF=1)
 *     u32  bnum                          (byte size of this whole block)
 *     u16  x, y                          (target position in VRAM — we keep it for round-trip)
 *     u16  w                             (colors per palette: 16 for 4bpp, 256 for 8bpp)
 *     u16  h                             (number of palettes)
 *     u16[w*h] colors                    (each color = 15-bit BGR + STP bit, see color15)
 *   [Pixel block]
 *     u32  bnum
 *     u16  x, y                          (VRAM position)
 *     u16  w                             (WIDTH IN 16-BIT WORDS — actual px width depends on bpp)
 *     u16  h                             (height in pixels)
 *     ...  pixel data
 *
 * Pixel widths: 4bpp -> w*4 px (2 px/byte), 8bpp -> w*2 px (1 px/byte),
 *               16bpp -> w px (1 color/u16), 24bpp -> w*2/3 px (3 bytes/px).
 */

export type PixelMode = "4bpp" | "8bpp" | "16bpp" | "24bpp" | "mixed";
const MODES: PixelMode[] = ["4bpp", "8bpp", "16bpp", "24bpp", "mixed"];

export interface TimImage {
  mode: PixelMode;
  hasClut: boolean;
  width: number;
  height: number;
  rgba: Uint8Array; // width*height*4, ready for PNG
  // --- metadata kept so we can re-encode faithfully ---
  clutX: number;
  clutY: number;
  clutW: number;
  clutH: number;
  clut?: Uint16Array; // raw 15-bit palette colors (clutW*clutH)
  indices?: Uint8Array; // 4/8bpp: indice de paleta por pixel (preservado p/ round-trip 100%)
  raw16?: Uint16Array; // 16bpp: cor original por pixel (preserva bit STP p/ round-trip 100%)
  imgX: number;
  imgY: number;
  pixelOffset: number; // offset em bytes onde os pixels comecam no arquivo (edicao in-place)
  rowBytes: number; // bytes por linha no bloco de pixels (imgW*2)
}

/** 15-bit BGR (1bit STP + 5+5+5) -> [r,g,b,a] 8-bit. Color 0x0000 = fully transparent (PSX convention). */
export function color15ToRgba(c: number): [number, number, number, number] {
  const r5 = c & 0x1f;
  const g5 = (c >> 5) & 0x1f;
  const b5 = (c >> 10) & 0x1f;
  // expand 5->8 bits (replicate high bits for a fuller range)
  const r = (r5 << 3) | (r5 >> 2);
  const g = (g5 << 3) | (g5 >> 2);
  const b = (b5 << 3) | (b5 >> 2);
  const a = c === 0 ? 0 : 255;
  return [r, g, b, a];
}

/** [r,g,b] 8-bit -> 15-bit BGR. (a handled by caller; black opaque -> 0x0421-ish? we map pure 0,0,0 opaque to bit set later) */
function rgbToColor15(r: number, g: number, b: number): number {
  const r5 = r >> 3;
  const g5 = g >> 3;
  const b5 = b >> 3;
  return (b5 << 10) | (g5 << 5) | r5;
}

export function decodeTim(buf: Uint8Array): TimImage {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const id = dv.getUint32(p, true); p += 4;
  if ((id & 0xff) !== 0x10) throw new Error("Not a TIM file (bad magic " + id.toString(16) + ")");
  const flags = dv.getUint32(p, true); p += 4;
  const mode = MODES[flags & 0x07];
  const hasClut = (flags & 0x08) !== 0;

  let clut: Uint16Array | undefined;
  let clutX = 0, clutY = 0, clutW = 0, clutH = 0;
  if (hasClut) {
    /* const bnum = */ dv.getUint32(p, true); p += 4;
    clutX = dv.getUint16(p, true); p += 2;
    clutY = dv.getUint16(p, true); p += 2;
    clutW = dv.getUint16(p, true); p += 2;
    clutH = dv.getUint16(p, true); p += 2;
    clut = new Uint16Array(clutW * clutH);
    for (let i = 0; i < clut.length; i++) { clut[i] = dv.getUint16(p, true); p += 2; }
  }

  /* const imgBnum = */ dv.getUint32(p, true); p += 4;
  const imgX = dv.getUint16(p, true); p += 2;
  const imgY = dv.getUint16(p, true); p += 2;
  const imgW = dv.getUint16(p, true); p += 2; // in 16-bit words
  const imgH = dv.getUint16(p, true); p += 2;
  const pix = p;
  const height = imgH;
  let width: number;
  let rgba: Uint8Array;
  let indices: Uint8Array | undefined;
  let raw16: Uint16Array | undefined;

  const put = (o: number, c: [number, number, number, number]) => { rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3]; };

  if (mode === "4bpp") {
    if (!clut) throw new Error("4bpp TIM without CLUT");
    width = imgW * 4;
    rgba = new Uint8Array(width * height * 4);
    indices = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const byte = buf[pix + y * imgW * 2 + (x >> 1)];
      const idx = (x & 1) ? (byte >> 4) : (byte & 0x0f);
      indices[y * width + x] = idx;
      put((y * width + x) * 4, color15ToRgba(clut[idx]));
    }
  } else if (mode === "8bpp") {
    if (!clut) throw new Error("8bpp TIM without CLUT");
    width = imgW * 2;
    rgba = new Uint8Array(width * height * 4);
    indices = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const idx = buf[pix + y * imgW * 2 + x];
      indices[y * width + x] = idx;
      put((y * width + x) * 4, color15ToRgba(clut[idx]));
    }
  } else if (mode === "16bpp") {
    width = imgW;
    rgba = new Uint8Array(width * height * 4);
    raw16 = new Uint16Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const c = dv.getUint16(pix + (y * width + x) * 2, true);
      raw16[y * width + x] = c;
      put((y * width + x) * 4, color15ToRgba(c));
    }
  } else if (mode === "24bpp") {
    width = Math.floor((imgW * 2) / 3);
    rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const o3 = pix + (y * width + x) * 3;
      put((y * width + x) * 4, [buf[o3], buf[o3 + 1], buf[o3 + 2], 255]);
    }
  } else {
    throw new Error("Unsupported TIM mode: " + mode);
  }

  return { mode, hasClut, width, height, rgba, clutX, clutY, clutW, clutH, clut, indices, raw16, imgX, imgY, pixelOffset: pix, rowBytes: imgW * 2 };
}

/** Find the palette index whose color is closest to (r,g,b). Exact match wins (faithful round-trip). */
function nearestClutIndex(clut: Uint16Array, count: number, r: number, g: number, b: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const [cr, cg, cb] = color15ToRgba(clut[i]);
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
  }
  return best;
}

/**
 * Encode a TimImage back to .TIM bytes. For 4/8bpp it re-quantizes the RGBA pixels
 * against the ORIGINAL palette (so editing keeps the exact PSX format/colors).
 */
export function encodeTim(img: TimImage): Uint8Array {
  const { mode, width, height, rgba, clut, clutW, clutH } = img;
  const parts: number[] = [];
  const w16 =
    mode === "4bpp" ? Math.ceil(width / 4) :
    mode === "8bpp" ? Math.ceil(width / 2) :
    mode === "16bpp" ? width :
    Math.ceil((width * 3) / 2);

  // pixel payload
  const rowBytes = w16 * 2;
  const pixels = new Uint8Array(rowBytes * height);
  const pdv = new DataView(pixels.buffer);
  const colorsCount = clutW || 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    if (mode === "4bpp" || mode === "8bpp") {
      let idx = 0;
      if (clut) {
        // pixel inalterado: reusa o indice original (preserva cores duplicadas -> byte-perfect);
        // pixel editado (cor diferente do indice original): re-quantiza pro mais proximo
        const orig = img.indices ? img.indices[y * width + x] : -1;
        const c = orig >= 0 && orig < colorsCount ? color15ToRgba(clut[orig]) : null;
        idx =
          c && c[0] === r && c[1] === g && c[2] === b && c[3] === rgba[o + 3]
            ? orig
            : nearestClutIndex(clut, colorsCount, r, g, b);
      }
      if (mode === "8bpp") pixels[y * rowBytes + x] = idx;
      else { const bi = y * rowBytes + (x >> 1); pixels[bi] = (x & 1) ? ((pixels[bi] & 0x0f) | (idx << 4)) : ((pixels[bi] & 0xf0) | (idx & 0x0f)); }
    } else if (mode === "16bpp") {
      // pixel inalterado: reusa a cor 16-bit original (preserva STP); editado: re-encoda
      const orig = img.raw16 ? img.raw16[y * width + x] : -1;
      const c = orig >= 0 ? color15ToRgba(orig) : null;
      const val =
        c && c[0] === r && c[1] === g && c[2] === b && c[3] === rgba[o + 3]
          ? orig
          : rgba[o + 3] === 0
            ? 0
            : rgbToColor15(r, g, b);
      pdv.setUint16((y * width + x) * 2, val, true);
    } else { // 24bpp
      const o3 = (y * width + x) * 3; pixels[o3] = r; pixels[o3 + 1] = g; pixels[o3 + 2] = b;
    }
  }

  const u32 = (v: number) => { parts.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff); };
  const u16 = (v: number) => { parts.push(v & 0xff, (v >> 8) & 0xff); };

  u32(0x10);
  u32((MODES.indexOf(mode)) | (img.hasClut ? 0x08 : 0));
  if (img.hasClut && clut) {
    const clutBytes = 4 + 8 + clut.length * 2;
    u32(clutBytes); u16(img.clutX); u16(img.clutY); u16(clutW); u16(clutH);
    for (let i = 0; i < clut.length; i++) u16(clut[i]);
  }
  const imgBytes = 4 + 8 + pixels.length;
  u32(imgBytes); u16(img.imgX); u16(img.imgY); u16(w16); u16(height);
  for (let i = 0; i < pixels.length; i++) parts.push(pixels[i]);
  return new Uint8Array(parts);
}
