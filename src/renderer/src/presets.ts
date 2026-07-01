/**
 * Presets (padroes salvaveis) do Tile Studio: config de visualizacao e paletas.
 *
 * - Embutidos (builtin): ja vem no app, read-only, nao apagaveis.
 * - Customizados (user): criados pelo usuario, persistidos em localStorage.
 *
 * Aplicar um preset SO altera o estado de visualizacao (nunca mexe nos bytes da
 * imagem nem na pilha de undo de pixel).
 */

import { grayPaletteRGBA, type PixelMode, type TileConfig } from "../../tile";

// -- presets de configuracao --------------------------------------------------

/** O que um preset de config guarda: tudo que define como o tile e lido/mostrado. */
export interface ConfigPreset {
  name: string;
  bpp: TileConfig["bpp"];
  mode: PixelMode;
  reverse: boolean;
  tileW: number;
  tileH: number;
  cols: number;
  offset: number;
  zoom: number;
  builtin?: boolean; // true = embutido (read-only)
}

/** Presets de config embutidos (read-only). Valores ja validados. */
export const BUILTIN_CONFIG_PRESETS: ConfigPreset[] = [
  { name: "Fonte LoM (1bpp planar 16x12)", bpp: 1, mode: "planar", reverse: false, tileW: 16, tileH: 12, cols: 16, offset: 0, zoom: 4, builtin: true },
  { name: "8x8 4bpp linear", bpp: 4, mode: "linear", reverse: false, tileW: 8, tileH: 8, cols: 16, offset: 0, zoom: 6, builtin: true },
  { name: "8x8 2bpp planar", bpp: 2, mode: "planar", reverse: false, tileW: 8, tileH: 8, cols: 16, offset: 0, zoom: 6, builtin: true },
  { name: "16x16 4bpp linear", bpp: 4, mode: "linear", reverse: false, tileW: 16, tileH: 16, cols: 8, offset: 0, zoom: 4, builtin: true },
  // mapa-mundi do Legend of Mana: 4bpp linear reverse, tile 8x8, header TIM = 20 bytes
  { name: "WM map (4bpp linear reverse)", bpp: 4, mode: "linear", reverse: true, tileW: 8, tileH: 8, cols: 32, offset: 20, zoom: 2, builtin: true },
];

// -- presets de paleta --------------------------------------------------------

/** Uma paleta salva: nome + cores RGBA planas (r,g,b,a por indice). */
export interface PalettePreset {
  name: string;
  rgba: number[]; // multiplo de 4
  builtin?: boolean;
}

/** Paleta PSX-ish de 16 cores contrastantes pra visualizar tiles indexados. */
function contrast16(): number[] {
  const cols = [
    0x000000, 0xffffff, 0xe6194b, 0x3cb44b, 0x4363d8, 0xffe119, 0xf58231, 0x911eb4,
    0x46f0f0, 0xf032e6, 0xbcf60c, 0xfabebe, 0x008080, 0x9a6324, 0x800000, 0x808000,
  ];
  const out: number[] = [];
  for (const c of cols) {
    out.push((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff, 255);
  }
  return out;
}

/** Paletas embutidas (read-only). */
export const BUILTIN_PALETTE_PRESETS: PalettePreset[] = [
  { name: "Tons de cinza (16)", rgba: [...grayPaletteRGBA(16)], builtin: true },
  { name: "Contraste 16 cores", rgba: contrast16(), builtin: true },
];

// -- persistencia (localStorage) ---------------------------------------------

const K_CONFIG = "tilestudio:presets";
const K_PALETTE = "tilestudio:palettes";

function loadJson<T>(key: string): T[] {
  try {
    const s = localStorage.getItem(key);
    if (!s) return [];
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function saveJson<T>(key: string, arr: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    // storage cheio/indisponivel: ignora silenciosamente
  }
}

/** Carrega os presets de config customizados (sem os embutidos). */
export const loadCustomConfigs = (): ConfigPreset[] =>
  loadJson<ConfigPreset>(K_CONFIG).map((p) => ({ ...p, builtin: false }));

export const saveCustomConfigs = (arr: ConfigPreset[]): void =>
  saveJson(K_CONFIG, arr.map((p) => ({ ...p, builtin: false })));

/** Carrega as paletas customizadas (sem as embutidas). */
export const loadCustomPalettes = (): PalettePreset[] =>
  loadJson<PalettePreset>(K_PALETTE).map((p) => ({ ...p, builtin: false }));

export const saveCustomPalettes = (arr: PalettePreset[]): void =>
  saveJson(K_PALETTE, arr.map((p) => ({ ...p, builtin: false })));
