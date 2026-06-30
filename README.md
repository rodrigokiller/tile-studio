# Tile Studio

Visualizador/editor de tiles graficos de consoles antigos (estilo Tile Molester), moderno em
TypeScript + Electron. Parte do suite com o TIM Studio.

## Por que

Muitos graficos (mapas, tilesets) nao sao TIM linear: ficam em formato de tiles que so faz
sentido com bpp/largura/ordem certos (ex.: os mapas WM do Legend of Mana = 4bpp, reverse, tiles
8x8). O Tile Molester faz isso mas e uma GUI Java antiga. O Tile Studio e a nossa versao moderna:
abrir qualquer arquivo, ajustar os parametros ate a imagem aparecer, navegar pelo arquivo e
exportar.

## Estado atual (v0.1)

- `src/tile.ts`: decoder de tiles configuravel (bpp 4/8/16, largura, tile, reverse, offset,
  paleta) -- compartilhado com o TIM Studio.
- `src/tim.ts`: codec TIM (compartilhado; pra futuras conversoes).
- App Electron + React: abrir arquivo (ou arrastar), controles de bpp/largura/tile/offset,
  navegacao pelo arquivo (setas / PageUp-Down), paleta de PNG ou tons de cinza, zoom, exportar PNG.

Rodar: `npm install` e `npm run dev`.

## Exemplo: mapas WM do Legend of Mana

Abra o `WM1.TIM` e use: bpp **4**, largura **1280**, tile **8**, **reverse** ligado, offset **20**.

## Roadmap

- [x] Visualizador de tiles configuravel + navegacao + export PNG
- [x] Paleta de PNG ou tons de cinza
- [ ] Desenhar/editar os tiles (pixel editor) e re-exportar pro jogo
- [ ] Editor de paleta
- [ ] Visao de VRAM / arranjos 2D extras
- [ ] Core compartilhado (psx-core) entre TIM Studio, Tile Studio e LoM Studio

## Nota de arquitetura

Por ora `src/tile.ts` e `src/tim.ts` sao copias dos modulos do TIM Studio. A intencao e extrair
um pacote `psx-core` compartilhado pelos tres apps do suite.
