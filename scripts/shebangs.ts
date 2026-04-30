#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Target = "local" | "branch" | "main" | "release";

type RunnerState = {
  target: Target;
  shebang: string;
  padCommand: string;
  createCommand: string;
  assetBase: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const githubRepo = "effect-native/pad";
const ignoredDirectories = new Set([".git", "node_modules", "tasks"]);
const textExtensions = new Set([".md", ".markdown", ".html", ".htm", ".svg", ".tsx"]);

function readText(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function writeText(path: string, content: string) {
  writeFileSync(resolve(repoRoot, path), content);
}

function extension(path: string) {
  const match = /\.[^.]+$/.exec(path);
  return match ? match[0].toLowerCase() : "";
}

function walk(dir = repoRoot): Array<string> {
  const paths: Array<string> = [];
  for (const entry of readdirSync(dir)) {
    if (ignoredDirectories.has(entry)) continue;
    const absolute = resolve(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      paths.push(...walk(absolute));
      continue;
    }
    const path = relative(repoRoot, absolute);
    if (textExtensions.has(extension(path))) paths.push(path);
  }
  return paths.sort();
}

function padFiles() {
  return walk().filter((path) => /\.pad\.(?:md|markdown|html?|svg)$/i.test(path));
}

function managedFiles() {
  return Array.from(new Set(["README.md", "note.tsx", ...padFiles()].filter((path) => {
    try {
      readText(path);
      return true;
    } catch {
      return false;
    }
  }))).sort();
}

function packageVersion() {
  return JSON.parse(readText("package.json")).version as string;
}

async function currentBranch() {
  const proc = Bun.spawn(["git", "branch", "--show-current"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const output = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !output) return process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "main";
  return output;
}

function arg(name: string) {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

function archiveRunner(ref: string) {
  return `bunx --bun -p https://github.com/${githubRepo}/archive/refs/heads/${ref}.tar.gz note`;
}

function githubAssetBase(ref: string) {
  return `https://cdn.jsdelivr.net/gh/${githubRepo}@${ref}`;
}

async function state(target: Target): Promise<RunnerState> {
  const version = arg("--version") || packageVersion();
  const branch = arg("--branch") || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || await currentBranch();
  const base = target === "branch" ? branch : target;
  const runner = target === "local"
    ? "bun ./note.tsx"
    : target === "release"
      ? `bunx --bun note@${version}`
      : archiveRunner(base);
  const assetBase = target === "local"
    ? "."
    : target === "release"
      ? `https://cdn.jsdelivr.net/npm/note@${version}`
      : githubAssetBase(base);

  return {
    target,
    shebang: `#!/usr/bin/env -S ${runner} --pad`,
    padCommand: `${runner} --pad`,
    createCommand: runner,
    assetBase,
  };
}

function replaceAll(content: string, replacements: Array<[RegExp, string]>) {
  return replacements.reduce((next, [pattern, value]) => next.replace(pattern, value), content);
}

function assetBaseForFile(next: RunnerState, path: string) {
  if (next.target !== "local") return next.assetBase;
  const from = dirname(path);
  const relativeBase = relative(from, ".").replaceAll("\\", "/");
  return relativeBase === "" ? "." : relativeBase;
}

function updatePadFile(path: string, next: RunnerState) {
  const content = readText(path);
  const assetBase = assetBaseForFile(next, path);
  let updated = replaceAll(content, [
    [/^#!\/usr\/bin\/env -S .* --pad$/m, next.shebang],
    [/href="[^"]+\/pad\.css"/g, `href="${assetBase}/pad.css"`],
    [/src="[^"]+\/pad\.mjs"/g, `src="${assetBase}/pad.mjs"`],
    [/Pass to .* --pad only when you trust it\./g, `Pass to ${next.padCommand} only when you trust it.`],
    [/Run with: .* --pad/g, `Run with: ${next.padCommand}`],
    [/Runnable with .* --pad\./g, `Runnable with ${next.padCommand}.`],
  ]);

  if (updated !== content) writeText(path, updated);
}

function updateReadme(next: RunnerState) {
  const content = readText("README.md");
  writeText("README.md", replaceAll(content, [
    [/^bun(?:x)?(?: --bun)?(?: -p \S+)?(?: \.\/note\.tsx| note(?:@[^\s]+)?) some random thing$/m, `${next.createCommand} some random thing`],
    [/^bun(?:x)?(?: --bun)?(?: -p \S+)?(?: \.\/note\.tsx| note(?:@[^\s]+)?) --html checklist$/m, `${next.createCommand} --html checklist`],
    [/^bun(?:x)?(?: --bun)?(?: -p \S+)?(?: \.\/note\.tsx| note(?:@[^\s]+)?) --svg diagram$/m, `${next.createCommand} --svg diagram`],
    [/^#!\/usr\/bin\/env -S .* --pad$/m, next.shebang],
    [/document path is passed to `[^`]+ --pad`/g, `document path is passed to \`${next.padCommand}\``],
  ]));
}

function updateNote(next: RunnerState) {
  const content = readText("note.tsx");
  writeText("note.tsx", replaceAll(content, [
    [/const PAD_ASSET_BASE = "[^"]+";/, `const PAD_ASSET_BASE = "${next.assetBase}";`],
    [/#!\/usr\/bin\/env -S .* --pad/g, next.shebang],
    [/Run with: .* --pad<\/text>/, `Run with: ${next.padCommand}</text>`],
    [/Run a PAD with:\\n  .* --pad \$\{title\}/, `Run a PAD with:\\n  ${next.padCommand} \${title}`],
    [/Force a literal title with:\\n  .* --title \$\{JSON\.stringify\(title\)\}/, `Force a literal title with:\\n  ${next.createCommand} --title \${JSON.stringify(title)}`],
  ]));
}

function updateAll(next: RunnerState) {
  for (const path of padFiles()) updatePadFile(path, next);
  updateReadme(next);
  updateNote(next);
}

function snapshot() {
  return managedFiles().map((path) => [path, readText(path)] as const);
}

function restore(files: ReadonlyArray<readonly [string, string]>) {
  for (const [path, content] of files) writeText(path, content);
}

async function main() {
  const command = Bun.argv[2];
  const target = (arg("--target") || Bun.argv[3]) as Target | undefined;
  if ((command !== "set" && command !== "check") || !target || !["local", "branch", "main", "release"].includes(target)) {
    console.error("Usage: shebangs.ts set|check --target local|branch|main|release [--branch name] [--version x.y.z]");
    process.exit(1);
  }

  const next = await state(target);
  if (command === "set") {
    updateAll(next);
    console.log(`shebangs set: ${target}`);
    return;
  }

  const before = snapshot();
  updateAll(next);
  const after = snapshot();
  restore(before);
  const changed = before.some(([path, content], index) => path !== after[index][0] || content !== after[index][1]);
  if (changed) {
    console.error(`shebangs are not in ${target} state`);
    process.exit(1);
  }
  console.log(`shebangs ok: ${target}`);
}

await main();
