import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAct, grayPaletteRGBA } from "./tile";

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
