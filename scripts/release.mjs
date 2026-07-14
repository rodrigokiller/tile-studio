// releaser da suite (LoM / TIM / Tile Studio): sobe a versao, builda, publica no GitHub Releases
// (o auto-update dos apps instalados le dai) e gera as notas a partir do git log desde o ultimo tag.
//
//   node scripts/release.mjs <patch|minor|major|x.y.z> [flags]     (ou: release.bat patch)
//   flags:  --dry            so mostra o que faria (nao muda/publica nada)
//           --yes            nao pergunta confirmacao
//           --notes-file f   usa o texto do arquivo como notas (em vez de gerar do git log)
//
// pre-requisitos: working tree limpo, `gh` autenticado (gh auth login). Nada de segredo no codigo:
// o token vem de `gh auth token` na hora.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const cap = (cmd) => execSync(cmd, { encoding: "utf8" }).trim(); // captura a saida
const run = (cmd, env) => execSync(cmd, { stdio: "inherit", env: env ?? process.env }); // stream ao vivo
const die = (msg) => {
  console.error("erro: " + msg);
  process.exit(1);
};

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const yes = argv.includes("--yes");
const nfIdx = argv.indexOf("--notes-file");
const notesFile = nfIdx >= 0 ? argv[nfIdx + 1] : null;
const bump = argv.find((a) => !a.startsWith("--") && a !== notesFile);
if (!bump) die("uso: node scripts/release.mjs <patch|minor|major|x.y.z> [--dry] [--yes] [--notes-file f]");

// working tree tem que estar limpo (o bump de versao sera o unico commit) -- so no release de verdade;
// no --dry deixa passar, pra dar pra pre-visualizar as notas mesmo com mudancas pendentes
if (!dry && cap("git status --porcelain")) die("working tree sujo -- faca commit ou stash antes de lancar uma versao");

// versao atual -> proxima
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [MA, MI, PA] = pkg.version.split(".").map(Number);
const next = /^\d+\.\d+\.\d+$/.test(bump)
  ? bump
  : bump === "major"
    ? `${MA + 1}.0.0`
    : bump === "minor"
      ? `${MA}.${MI + 1}.0`
      : bump === "patch"
        ? `${MA}.${MI}.${PA + 1}`
        : null;
if (!next) die("bump invalido: " + bump + " (use patch | minor | major | x.y.z)");
const tag = "v" + next;

// repo do remote origin (owner/nome) -- sem hardcode
const rm = cap("git remote get-url origin").match(/github\.com[:/]([^/]+)\/([^/.]+)/);
if (!rm) die("o remote origin nao aponta pra um repo GitHub");
const repo = `${rm[1]}/${rm[2]}`;

// NOTAS: agrupa os commits desde o ultimo tag por prefixo conventional-commit
try {
  execSync("git fetch --tags --quiet", { stdio: "ignore" });
} catch {
  /* sem rede: usa os tags que ja tem */
}
let range = "HEAD";
try {
  range = cap("git describe --tags --abbrev=0") + "..HEAD";
} catch {
  /* sem tag anterior: pega o historico todo */
}
const log = cap(`git log ${range} --pretty=format:%s`).split("\n").filter(Boolean);
const G = { feat: [], fix: [], perf: [], refactor: [], docs: [], outros: [] };
for (const s of log) {
  const mm = s.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)/);
  const type = mm?.[1];
  const text = mm?.[2] ?? s;
  if (type === "chore") continue; // chores (inclui o proprio commit de release) ficam fora das notas
  (G[type] ?? G.outros).push(text);
}
const LBL = { feat: "Novidades", fix: "Correcoes", perf: "Desempenho", refactor: "Refatoracoes", docs: "Documentacao", outros: "Outros" };
let notes = notesFile
  ? readFileSync(notesFile, "utf8")
  : Object.keys(LBL)
      .filter((k) => G[k].length)
      .map((k) => `### ${LBL[k]}\n` + G[k].map((t) => `- ${t}`).join("\n"))
      .join("\n\n");
if (!notes.trim()) notes = "Manutencao e melhorias internas.";

const productName = pkg.build?.productName ?? pkg.name;
console.log(`\n=== ${productName}: ${pkg.version} -> ${next}   (${repo}) ===`);
console.log(`${log.length} commit(s) desde ${range === "HEAD" ? "o inicio" : range.replace("..HEAD", "")}\n`);
console.log("--- notas da release ---\n" + notes + "\n------------------------\n");

if (dry) {
  console.log("[--dry] nada foi alterado nem publicado.");
  process.exit(0);
}

if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`Publicar ${tag} em ${repo}? Isso builda, sobe o instalador e PUBLICA a release. [s/N] `)).trim().toLowerCase();
  rl.close();
  if (ans !== "s" && ans !== "sim" && ans !== "y") {
    console.log("cancelado.");
    process.exit(0);
  }
}

// 1) bump + commit + push (a release aponta pra esse commit)
run(`npm version ${next} --no-git-tag-version`);
run(`git add package.json package-lock.json`);
run(`git commit -m "chore(release): ${tag}"`);
run(`git push`);

// 2) build + publish (electron-builder cria a release como DRAFT e sobe Setup + latest.yml + blockmap)
const env = { ...process.env, GH_TOKEN: cap("gh auth token") };
run(`npx electron-vite build`, env);
run(`npx electron-builder --win --publish always`, env);

// 3) publica a draft com titulo + notas
const tmp = ".release-notes.tmp.md";
writeFileSync(tmp, notes);
run(`gh release edit ${tag} --draft=false --title "${productName} ${next}" --notes-file ${tmp}`, env);
if (existsSync(tmp)) unlinkSync(tmp);

console.log(`\nOK -- publicada: https://github.com/${repo}/releases/tag/${tag}`);
