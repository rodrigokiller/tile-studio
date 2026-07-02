# Tile Studio

Visualizador/editor de tiles graficos de consoles antigos (estilo Tile Molester), moderno em
TypeScript + Electron. Parte do suite com o TIM Studio.

## Por que

Muitos graficos (mapas, tilesets) nao sao TIM linear: ficam em formato de tiles que so faz
sentido com bpp/largura/ordem certos (ex.: os mapas WM do Legend of Mana = 4bpp, reverse, tiles
8x8). O Tile Molester faz isso mas e uma GUI Java antiga. O Tile Studio e a nossa versao moderna:
abrir qualquer arquivo, ajustar os parametros ate a imagem aparecer, navegar pelo arquivo e
exportar.

## Estado atual (v0.8)

- `src/tile.ts`: motor de tiles estilo Tile Molester. bpp **1/2/4/8** (indexado) e **16/24**
  (cor direta); modo **planar** (bitplanes por linha, MSB = pixel da esquerda) e **linear**
  (empacotado, in-order ou reverse); tile de qualquer tamanho (LxA); disposicao em N colunas;
  offset em bytes. Expoe `decodeTiles`, `readPixelIndex`, `writePixelIndex`, `tileSizeBytes`,
  `locatePixel`, `rgbToDirect`, `directToRgb`, `encodeAct`.
- `src/tim.ts`: codec TIM (compartilhado; pra futuras conversoes).
- App Electron + React:
  - abrir qualquer arquivo binario (ou arrastar);
  - controles de bpp, modo planar/linear, tile largura/altura, colunas, linhas, offset, zoom;
  - **canvas-em-tiles** com grade opcional (igual ao Tile Molester);
  - **modo editar vs navegar (pan)**: toggle claro; no modo navegar (ou segurando Espaco)
    arrastar rola a imagem sem pintar;
  - **editor de pixel** pra qualquer bpp: no modo editar, clique/arraste pinta e grava de
    volta nos bytes. Em bpp indexado (1/2/4/8) pinta o indice de paleta; em cor direta
    (16/24bpp) pinta uma cor RGB escolhida por color-picker (16bpp com bit STP opcional);
  - **conta-gotas** (Alt+clique no canvas): pica a cor do pixel como cor de pintura
    (indexado seleciona o indice; direto seta o RGB); nao entra no undo;
  - **desfazer/refazer** (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y): a pilha guarda SO edicoes de
    pixel (mudancas de bytes); o estado de visualizacao nunca entra na pilha; historico
    capado em 200 entradas (descarta as mais antigas);
  - **cor de pintura** clara: swatch grande no inspector com indice/hex; em bpp indexado
    clique-esquerdo numa celula SELECIONA a cor de pintura (destaque forte),
    shift+clique ou clique-direito EDITA a cor daquele indice, e clicar no swatch grande
    edita a cor selecionada; em cor direta o swatch e um color-picker de RGB;
  - **paleta editavel** (color-picker por indice), carregar de PNG, ou rampa de cinza padrao;
  - **exportar a paleta como .ACT** (Adobe Color Table) pro Photoshop (Imagem > Modo > Cores
    indexadas > carregar tabela): botao na secao da paleta e item no menu Editar, so nos bpp
    indexados (2/4/8);
  - **Salvar** (grava no arquivo), **Salvar como**, **Exportar PNG**;
  - **presets salvaveis** (persistidos em localStorage):
    - de config (bpp, modo, reverse, tile LxA, colunas, offset, zoom): aplicar por dropdown,
      salvar/renomear/excluir os customizados. Embutidos read-only: "Fonte LoM
      (1bpp planar 16x12)", "8x8 4bpp linear", "8x8 2bpp planar", "16x16 4bpp linear",
      "WM map (4bpp linear reverse)".
    - de paleta: aplicar/salvar/renomear/excluir. Embutidas: "Tons de cinza (16)" e
      "Contraste 16 cores". Aplicar um preset nunca entra na pilha de undo de pixel.
  - **barra de titulo custom** (frameless estilo VS Code): arrasta a janela, barra de menu com
    botoes por item (Arquivo / Editar / Exibir / Janela / Ajuda -- cada um abre seu submenu),
    mostra o nome do arquivo aberto. Menu do Electron (pt-br): Arquivo (Nova janela / Abrir
    arquivo... / Abrir recente + "Abrir com..." / Sair), Editar (+ Preferencias Ctrl+,), Exibir,
    Janela, Ajuda. Multi-janela (1 arquivo por janela). Os **recentes** (ate 8) e o ultimo
    aberto ficam em `userData/recents.json`.
  - **janela de Preferencias** (Editar > Preferencias / Ctrl+,): modal com opcoes persistidas
    em localStorage -- reabrir o ultimo arquivo ao iniciar, e iniciar no modo Navegar.
  - navegacao pelo arquivo por offset (setas / PageUp-Down / botoes).

Rodar: `npm install` e `npm run dev`. Testes: `npm test`.

## Exemplo: fonte do Legend of Mana

Aplique o preset embutido **Fonte LoM (1bpp planar 16x12)** no dropdown de presets de config
(1bpp **planar**, tile **16x12**, 16 colunas). A fonte aparece
legivel: ASCII, acentos PT-BR (a e i o u com til/acento/circunflexo, c-cedilha), icones de botao
do PSX, coracao e nota musical. Cada glifo = 24 bytes (12 linhas x 2 bytes, MSB = pixel da esquerda).

## Exemplo: mapas WM do Legend of Mana

Abra o `WM1.TIM` e use: bpp **4**, modo **linear**, tile **8x8**, offset **20**, ajuste colunas.

## Roadmap

- [x] Motor de tiles configuravel (planar/linear, 1/2/4/8/16/24bpp) + navegacao + export PNG
- [x] Paleta de PNG, rampa de cinza, ou editavel por color-picker
- [x] Desenhar/editar pixel e salvar de volta no arquivo
- [x] Desfazer/refazer (undo/redo) so das edicoes de pixel, com teto de 200 entradas
- [x] Modo editar vs navegar (pan) + cor de pintura clara
- [x] Edicao de pixel em cor direta (16bpp ABGR1555 / 24bpp RGB)
- [x] Presets salvaveis de config e de paleta (embutidos + customizados persistidos)
- [x] Menu do Electron (multi-janela, abrir/abrir recente, reabrir o ultimo ao iniciar)
- [x] Barra de titulo custom + janela de Preferencias + conta-gotas (Alt+clique)
- [x] Exportar a paleta de pintura como .ACT (Adobe Color Table) pro Photoshop
- [ ] Codec composite (tiles montados de varios sub-tiles, ex.: 3bpp = 2bpp+1bpp)
- [ ] Modo 2D (stride) alem do 1D
- [ ] Selecao / copiar-colar / espelhar / girar tiles
- [ ] Visao de VRAM / arranjos 2D extras
- [ ] Core compartilhado (psx-core) entre TIM Studio, Tile Studio e LoM Studio

## Nota de arquitetura

Por ora `src/tile.ts` e `src/tim.ts` sao copias dos modulos do TIM Studio. A intencao e extrair
um pacote `psx-core` compartilhado pelos tres apps do suite.
