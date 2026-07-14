import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeAct,
  grayPaletteRGBA,
  CONSOLE_CODECS,
  readCodecPixel,
  writeCodecPixel,
  readPixelIndex,
  writePixelIndex,
  tileSizeBytes,
  type ConsoleCodec,
  type TileConfig,
} from "./tile";
import { decodeAct, decodeRiffPal, decodeJascPal, decodePal, fitPalette } from "./palette";

test("encodeAct: 772 bytes, RGB corretos e trailer com o nº de cores", () => {
  // paleta RGBA: 4 cores (vermelho, verde, azul, branco)
  const pal = new Uint8Array([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ]);
  const act = encodeAct(pal, 4);
  assert.equal(act.length, 772);
  // cor 0 = vermelho
  assert.equal(act[0], 255);
  assert.equal(act[1], 0);
  assert.equal(act[2], 0);
  // cor 3 = branco (offset 9..11)
  assert.equal(act[9], 255);
  assert.equal(act[10], 255);
  assert.equal(act[11], 255);
  // cores nao usadas (4..255) ficam zeradas
  assert.equal(act[12], 0);
  assert.equal(act[767], 0);
  // trailer: count = 4 (big-endian), transparente = 0xFFFF (nenhum)
  assert.equal(act[768], 0);
  assert.equal(act[769], 4);
  assert.equal(act[770], 0xff);
  assert.equal(act[771], 0xff);
});

test("encodeAct: count 16 (4bpp) e count 4 (2bpp) com a rampa de cinza", () => {
  const pal16 = grayPaletteRGBA(16);
  const act16 = encodeAct(pal16, 16);
  assert.equal(act16.length, 772);
  assert.equal(act16[769], 16); // count no trailer
  // cor 0 = preto, cor 15 = branco
  assert.equal(act16[0], 0);
  assert.equal(act16[15 * 3], 255);
  // a 16a cor em diante fica zerada
  assert.equal(act16[16 * 3], 0);

  const act4 = encodeAct(grayPaletteRGBA(4), 4);
  assert.equal(act4[769], 4);
  assert.equal(act4[768], 0);
});

// ===========================================================================
// ITEM 1 -- codecs por console (intercalamento real)
// ===========================================================================

// Cada codec fixa bpp e tile 8x8; estes sao os tamanhos canonicos.
const CODEC_BYTES: Record<Exclude<ConsoleCodec, "generic">, number> = {
  nes2: 16, gb2: 16, snes2: 16, snes4: 32, snes8: 64, md4: 32, gba4: 32, gba8: 64,
};
const ALL_CODECS = Object.keys(CODEC_BYTES) as Exclude<ConsoleCodec, "generic">[];

test("codecs: tileBytes e bpp da tabela batem com os canonicos", () => {
  for (const c of ALL_CODECS) {
    assert.equal(CONSOLE_CODECS[c].tileBytes, CODEC_BYTES[c], `tileBytes de ${c}`);
    assert.equal(CONSOLE_CODECS[c].tileW, 8);
    assert.equal(CONSOLE_CODECS[c].tileH, 8);
    // tamanho = 8 linhas * bpp * 1 byte/plano-por-linha... confere via bpp
    assert.equal((1 << CONSOLE_CODECS[c].bpp) > 0, true);
  }
});

// (b) TILES FEITOS A MAO -> prova o intercalamento (bytes conhecidos -> indices esperados)

test("codec NES 2bpp: planar sequencial (plano0 bytes 0-7, plano1 bytes 8-15)", () => {
  const d = new Uint8Array(16);
  d[0] = 0b10110001; // plano0, linha 0 (bit7 = px0)
  d[8] = 0b11000010; // plano1, linha 0
  // px:      0 1 2 3 4 5 6 7
  // plano0:  1 0 1 1 0 0 0 1
  // plano1:  1 1 0 0 0 0 1 0
  // pixel = p0 | p1<<1
  const esperado = [3, 2, 1, 1, 0, 0, 2, 1];
  for (let px = 0; px < 8; px++) assert.equal(readCodecPixel("nes2", d, 0, px, 0), esperado[px], `px${px}`);
});

test("codec Game Boy/SNES 2bpp: planos 0/1 intercalados por linha (bytes 0 e 1)", () => {
  const d = new Uint8Array(16);
  d[0] = 0b10110001; // plano0, linha 0
  d[1] = 0b11000010; // plano1, linha 0
  const esperado = [3, 2, 1, 1, 0, 0, 2, 1];
  for (let px = 0; px < 8; px++) {
    assert.equal(readCodecPixel("gb2", d, 0, px, 0), esperado[px], `gb px${px}`);
    assert.equal(readCodecPixel("snes2", d, 0, px, 0), esperado[px], `snes2 px${px}`);
  }
  // prova que o intercalamento difere do NES: com os MESMOS bytes, o NES le o plano1 do byte 8 (=0)
  const soPlano0 = [1, 0, 1, 1, 0, 0, 0, 1];
  for (let px = 0; px < 8; px++) assert.equal(readCodecPixel("nes2", d, 0, px, 0), soPlano0[px], `nes difere px${px}`);
});

test("codec SNES 4bpp: 16 bytes planos 0&1, depois 16 bytes planos 2&3", () => {
  const d = new Uint8Array(32);
  d[0] = 0b10000000; // plano0 -> bit em px0
  d[1] = 0b01000000; // plano1 -> bit em px1
  d[16] = 0b00100000; // plano2 -> bit em px2
  d[17] = 0b00010000; // plano3 -> bit em px3
  const esperado = [1, 2, 4, 8, 0, 0, 0, 0];
  for (let px = 0; px < 8; px++) assert.equal(readCodecPixel("snes4", d, 0, px, 0), esperado[px], `px${px}`);
});

test("codec SNES 8bpp: quatro blocos de 16 (planos 0-1,2-3,4-5,6-7)", () => {
  const d = new Uint8Array(64);
  // liga o bit de px0 em CADA um dos 8 planos -> px0 = 0xFF
  d[0] = d[1] = d[16] = d[17] = d[32] = d[33] = d[48] = d[49] = 0b10000000;
  assert.equal(readCodecPixel("snes8", d, 0, 0, 0), 0xff);
  // so o plano 5 (byte 33, bloco 2 byte impar) em px1 -> valor 1<<5 = 32
  const d2 = new Uint8Array(64);
  d2[33] = 0b01000000; // px1
  assert.equal(readCodecPixel("snes8", d2, 0, 1, 0), 32);
  assert.equal(readCodecPixel("snes8", d2, 0, 0, 0), 0);
});

test("codec Mega Drive 4bpp: linear packed, nibble ALTO = pixel esquerdo", () => {
  const d = new Uint8Array(32);
  d[0] = 0x12; // px0 = 1 (alto), px1 = 2 (baixo)
  d[1] = 0x34;
  d[2] = 0x56;
  d[3] = 0x78;
  const esperado = [1, 2, 3, 4, 5, 6, 7, 8];
  for (let px = 0; px < 8; px++) assert.equal(readCodecPixel("md4", d, 0, px, 0), esperado[px], `px${px}`);
});

test("codec GBA 4bpp: linear packed, nibble BAIXO = pixel esquerdo", () => {
  const d = new Uint8Array(32);
  d[0] = 0x21; // px0 = 1 (baixo), px1 = 2 (alto)
  d[1] = 0x43;
  d[2] = 0x65;
  d[3] = 0x87;
  const esperado = [1, 2, 3, 4, 5, 6, 7, 8];
  for (let px = 0; px < 8; px++) assert.equal(readCodecPixel("gba4", d, 0, px, 0), esperado[px], `px${px}`);
});

test("codec GBA 8bpp: linear, 1 byte por pixel", () => {
  const d = new Uint8Array(64);
  const linha0 = [10, 20, 30, 40, 50, 60, 70, 80];
  for (let px = 0; px < 8; px++) d[px] = linha0[px];
  d[8] = 99; // px0 da linha 1
  for (let px = 0; px < 8; px++) assert.equal(readCodecPixel("gba8", d, 0, px, 0), linha0[px], `px${px}`);
  assert.equal(readCodecPixel("gba8", d, 0, 0, 1), 99);
});

// (a) ROUND-TRIP: escreve indices conhecidos em TODOS os pixels do tile e le de volta identico.
// Faz duas vezes (idempotencia): decode -> write-back -> decode = igual.
test("codecs: round-trip write->read de um tile inteiro (todos os pixels)", () => {
  for (const c of ALL_CODECS) {
    const info = CONSOLE_CODECS[c];
    const mask = (1 << info.bpp) - 1;
    const d = new Uint8Array(info.tileBytes);
    // padrao pseudo-aleatorio mas deterministico por pixel
    const val = (px: number, py: number): number => (px * 7 + py * 13 + 1) & mask;
    for (let py = 0; py < 8; py++)
      for (let px = 0; px < 8; px++) writeCodecPixel(c, d, 0, px, py, val(px, py));
    for (let py = 0; py < 8; py++)
      for (let px = 0; px < 8; px++)
        assert.equal(readCodecPixel(c, d, 0, px, py), val(px, py), `${c} leu (${px},${py})`);
    // idempotencia: reescreve o que leu num buffer novo e compara byte a byte
    const d2 = new Uint8Array(info.tileBytes);
    for (let py = 0; py < 8; py++)
      for (let px = 0; px < 8; px++)
        writeCodecPixel(c, d2, 0, px, py, readCodecPixel(c, d, 0, px, py));
    assert.deepEqual(d2, d, `${c} write-back byte-identico`);
  }
});

// EDICAO parcial: mudar 1 pixel nao corrompe os vizinhos que compartilham byte/plano.
test("codecs: editar 1 pixel preserva os outros pixels do tile", () => {
  for (const c of ALL_CODECS) {
    const info = CONSOLE_CODECS[c];
    const mask = (1 << info.bpp) - 1;
    const d = new Uint8Array(info.tileBytes);
    const val = (px: number, py: number): number => (px * 3 + py * 5) & mask;
    for (let py = 0; py < 8; py++)
      for (let px = 0; px < 8; px++) writeCodecPixel(c, d, 0, px, py, val(px, py));
    // muda o pixel (3,4) para um valor diferente
    const alvo = (val(3, 4) + 1) & mask;
    writeCodecPixel(c, d, 0, 3, 4, alvo);
    assert.equal(readCodecPixel(c, d, 0, 3, 4), alvo, `${c} pixel editado`);
    for (let py = 0; py < 8; py++)
      for (let px = 0; px < 8; px++) {
        if (px === 3 && py === 4) continue;
        assert.equal(readCodecPixel(c, d, 0, px, py), val(px, py), `${c} vizinho (${px},${py}) intacto`);
      }
  }
});

// DESPACHO: readPixelIndex/writePixelIndex/tileSizeBytes usam cfg.codec quando != generic.
test("codecs: readPixelIndex/writePixelIndex/tileSizeBytes despacham pelo codec", () => {
  for (const c of ALL_CODECS) {
    const info = CONSOLE_CODECS[c];
    const cfg: TileConfig = { bpp: info.bpp, mode: "linear", tileW: 8, tileH: 8, cols: 1, codec: c };
    assert.equal(tileSizeBytes(cfg), info.tileBytes, `${c} tileSizeBytes`);
    const d = new Uint8Array(info.tileBytes);
    const mask = (1 << info.bpp) - 1;
    // grava via API generica -> deve bater com o codec direto
    for (let py = 0; py < 8; py++)
      for (let px = 0; px < 8; px++) writePixelIndex(d, cfg, 0, px, py, (px + py) & mask);
    for (let py = 0; py < 8; py++)
      for (let px = 0; px < 8; px++) {
        assert.equal(readPixelIndex(d, cfg, 0, px, py), (px + py) & mask, `${c} readPixelIndex`);
        assert.equal(readPixelIndex(d, cfg, 0, px, py), readCodecPixel(c, d, 0, px, py), `${c} coerencia`);
      }
  }
});

// ===========================================================================
// ITEM 3 -- importar paleta .ACT e .PAL
// ===========================================================================

test("decodeAct: round-trip com encodeAct (768/772 bytes, RGB e count)", () => {
  const pal = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);
  const act = encodeAct(pal, 4); // 772 bytes com trailer count=4
  const dec = decodeAct(act);
  assert.equal(dec.count, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(dec.rgba[i * 4], pal[i * 4], `cor ${i} R`);
    assert.equal(dec.rgba[i * 4 + 1], pal[i * 4 + 1], `cor ${i} G`);
    assert.equal(dec.rgba[i * 4 + 2], pal[i * 4 + 2], `cor ${i} B`);
    assert.equal(dec.rgba[i * 4 + 3], 255);
  }
});

test("decodeAct: 768 bytes sem trailer = 256 cores", () => {
  const b = new Uint8Array(768);
  b[3] = 10; b[4] = 20; b[5] = 30; // cor 1
  const dec = decodeAct(b);
  assert.equal(dec.count, 256);
  assert.deepEqual([dec.rgba[4], dec.rgba[5], dec.rgba[6], dec.rgba[7]], [10, 20, 30, 255]);
});

test("decodeAct: indice transparente no trailer marca alpha 0", () => {
  const b = new Uint8Array(772);
  b[0] = 1; b[1] = 2; b[2] = 3; // cor 0
  b[768] = 0; b[769] = 4; // count = 4
  b[770] = 0; b[771] = 0; // transparente = indice 0
  const dec = decodeAct(b);
  assert.equal(dec.count, 4);
  assert.equal(dec.rgba[3], 0); // cor 0 -> transparente
});

test("decodeRiffPal: header RIFF/PAL/data + RGBQ", () => {
  // monta um RIFF PAL de 2 cores a mao
  const count = 2;
  const dataSize = 4 + count * 4; // ver(2)+count(2)+entradas
  const buf = new Uint8Array(12 + 8 + dataSize);
  const put = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  put(0, "RIFF");
  buf[4] = (4 + 8 + dataSize) & 0xff; // riff size (LE, cabe em 1 byte aqui)
  put(8, "PAL ");
  put(12, "data");
  buf[16] = dataSize & 0xff; // data size LE
  buf[20] = 0x00; buf[21] = 0x03; // version 0x0300
  buf[22] = count & 0xff; buf[23] = 0; // count LE
  // entradas RGBQ (R,G,B,flags)
  buf.set([200, 100, 50, 0], 24);
  buf.set([1, 2, 3, 0], 28);
  const dec = decodeRiffPal(buf);
  assert.equal(dec.count, 2);
  assert.deepEqual([dec.rgba[0], dec.rgba[1], dec.rgba[2], dec.rgba[3]], [200, 100, 50, 255]);
  assert.deepEqual([dec.rgba[4], dec.rgba[5], dec.rgba[6], dec.rgba[7]], [1, 2, 3, 255]);
  // decodePal deve rotear pro RIFF automaticamente
  assert.equal(decodePal(buf).count, 2);
});

test("decodeJascPal: texto JASC-PAL", () => {
  const txt = "JASC-PAL\r\n0100\r\n3\r\n255 0 0\r\n0 128 0\r\n10 20 30\r\n";
  const dec = decodeJascPal(txt);
  assert.equal(dec.count, 3);
  assert.deepEqual([dec.rgba[0], dec.rgba[1], dec.rgba[2], dec.rgba[3]], [255, 0, 0, 255]);
  assert.deepEqual([dec.rgba[4], dec.rgba[5], dec.rgba[6]], [0, 128, 0]);
  assert.deepEqual([dec.rgba[8], dec.rgba[9], dec.rgba[10]], [10, 20, 30]);
  // decodePal roteia texto JASC pelo header tambem
  assert.equal(decodePal(new TextEncoder().encode(txt)).count, 3);
});

test("fitPalette: ajusta pro nº de cores (corta e completa com preto)", () => {
  const dec = { rgba: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]), count: 2 };
  const p16 = fitPalette(dec, 16);
  assert.equal(p16.length, 64);
  assert.deepEqual([p16[0], p16[1], p16[2]], [1, 2, 3]);
  assert.deepEqual([p16[8], p16[9], p16[10], p16[11]], [0, 0, 0, 255]); // preenchido preto opaco
  const p1 = fitPalette(dec, 1);
  assert.equal(p1.length, 4);
  assert.deepEqual([p1[0], p1[1], p1[2]], [1, 2, 3]);
});
