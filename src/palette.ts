/**
 * Importadores de paleta: Adobe Color Table (.ACT) e Microsoft/JASC Palette (.PAL).
 *
 * Todas as funcoes sao puras (Uint8Array -> RGBA plano) e retornam { rgba, count }, onde
 * rgba tem count*4 bytes (R,G,B,A por indice). O editor depois ajusta pro numero de cores
 * do bpp atual. PNG NAO entra aqui (precisa de decode de imagem; fica no renderer).
 */

export interface DecodedPalette {
  rgba: Uint8Array; // count*4 (R,G,B,A por indice)
  count: number; // numero de cores
}

const le16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const le32 = (b: Uint8Array, o: number): number =>
  ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;
const tag = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

/**
 * Adobe Color Table (.ACT): 768 bytes = 256 triplas RGB. Opcional: trailer de 4 bytes com
 * o numero de cores (16-bit big-endian) e o indice transparente (0xFFFF = nenhum). Espelha
 * o encodeAct de tile.ts.
 */
export function decodeAct(bytes: Uint8Array): DecodedPalette {
  if (bytes.length < 768) {
    throw new Error("ACT muito curto (" + bytes.length + " bytes; esperado 768 ou 772)");
  }
  let count = 256;
  let transparent = 0xffff;
  if (bytes.length >= 772) {
    const c = (bytes[768] << 8) | bytes[769]; // big-endian
    if (c >= 1 && c <= 256) count = c;
    transparent = (bytes[770] << 8) | bytes[771];
  }
  const rgba = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    rgba[i * 4] = bytes[i * 3];
    rgba[i * 4 + 1] = bytes[i * 3 + 1];
    rgba[i * 4 + 2] = bytes[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  if (transparent !== 0xffff && transparent < count) rgba[transparent * 4 + 3] = 0; // marca a cor transparente
  return { rgba, count };
}

/**
 * Microsoft RIFF PAL: "RIFF" <size> "PAL " "data" <size> <ver u16> <count u16> e depois
 * `count` entradas de 4 bytes (PALETTEENTRY: R,G,B,flags). Le o 1o chunk "data".
 */
export function decodeRiffPal(bytes: Uint8Array): DecodedPalette {
  if (tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "PAL ") throw new Error("nao e um RIFF PAL");
  // procura o chunk "data" a partir do offset 12 (pula chunks desconhecidos)
  let p = 12;
  while (p + 8 <= bytes.length && tag(bytes, p) !== "data") {
    const sz = le32(bytes, p + 4);
    p += 8 + sz + (sz & 1); // chunks tem padding pra tamanho par
  }
  if (p + 12 > bytes.length || tag(bytes, p) !== "data") throw new Error("RIFF PAL sem chunk 'data'");
  // p -> "data" (4) + size (4) + version u16 + count u16
  const count = le16(bytes, p + 10);
  const base = p + 12;
  const rgba = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = base + i * 4; // R,G,B,flags
    rgba[i * 4] = bytes[o] ?? 0;
    rgba[i * 4 + 1] = bytes[o + 1] ?? 0;
    rgba[i * 4 + 2] = bytes[o + 2] ?? 0;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, count };
}

/**
 * JASC-PAL (texto): "JASC-PAL\n0100\n<count>\nR G B\n..." (Paint Shop Pro; comum em romhacking).
 */
export function decodeJascPal(text: string): DecodedPalette {
  const lines = text.split(/\r?\n/).map((s) => s.trim());
  const nonEmpty = lines.filter((s) => s.length > 0);
  if (nonEmpty[0] !== "JASC-PAL") throw new Error("nao e um JASC-PAL");
  const count = parseInt(nonEmpty[2] ?? "0", 10);
  if (!(count > 0)) throw new Error("JASC-PAL com contagem invalida");
  const rgba = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const parts = (nonEmpty[3 + i] ?? "").split(/\s+/);
    rgba[i * 4] = (parseInt(parts[0], 10) || 0) & 0xff;
    rgba[i * 4 + 1] = (parseInt(parts[1], 10) || 0) & 0xff;
    rgba[i * 4 + 2] = (parseInt(parts[2], 10) || 0) & 0xff;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, count };
}

/** .PAL: escolhe entre RIFF (binario) e JASC-PAL (texto) pelo cabecalho. */
export function decodePal(bytes: Uint8Array): DecodedPalette {
  if (tag(bytes, 0) === "RIFF") return decodeRiffPal(bytes);
  const head = tag(bytes, 0) + tag(bytes, 4); // "JASC-PAL"
  if (head.startsWith("JASC-PAL")) return decodeJascPal(new TextDecoder().decode(bytes));
  throw new Error("PAL desconhecido (nem RIFF nem JASC-PAL)");
}

/**
 * Dispatcher por nome de arquivo (.act/.pal). Se a extensao nao ajudar, tenta pelo conteudo.
 * PNG e tratado a parte no renderer (precisa decodificar imagem).
 */
export function decodePaletteFile(name: string, bytes: Uint8Array): DecodedPalette {
  if (/\.act$/i.test(name)) return decodeAct(bytes);
  if (/\.pal$/i.test(name)) return decodePal(bytes);
  // sem extensao conhecida: deduz pelo conteudo
  if (tag(bytes, 0) === "RIFF" || (tag(bytes, 0) + tag(bytes, 4)).startsWith("JASC-PAL")) {
    return decodePal(bytes);
  }
  if (bytes.length === 768 || bytes.length === 772) return decodeAct(bytes);
  throw new Error("formato de paleta nao reconhecido: " + name);
}

/**
 * Ajusta uma paleta decodificada pro numero de cores desejado (`want`): copia as primeiras
 * `want` cores e completa o resto com preto opaco. Usada ao aplicar no editor (bpp fixa o total).
 */
export function fitPalette(p: DecodedPalette, want: number): Uint8Array {
  const out = new Uint8Array(want * 4);
  for (let i = 0; i < want; i++) {
    if (i < p.count) {
      out.set(p.rgba.subarray(i * 4, i * 4 + 4), i * 4);
    } else {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 0;
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}
