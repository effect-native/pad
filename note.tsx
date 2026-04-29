#!/usr/bin/env bun
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Format = "md" | "html" | "svg";

function readVersion() {
  const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "package.json");
  const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (!packageJson || typeof packageJson !== "object" || !("version" in packageJson) || typeof packageJson.version !== "string") {
    throw new Error(`Missing version in ${packageJsonPath}`);
  }
  return packageJson.version;
}

const VERSION = readVersion();

const help = `note creates Portable App Documents.

Usage:
  note some random thing          create YYYY-MM-DD-some-random-thing.pad.md
  note --html some random thing   create YYYY-MM-DD-some-random-thing.pad.html
  note --svg some random thing    create YYYY-MM-DD-some-random-thing.pad.svg
  note --pad ./file.pad.html      run a PAD in trusted program mode
`;

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function localDate(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "untitled";
}

function looksLikePath(input: string) {
  const knownFileExtension = /\.(?:pad\.)?(?:md|markdown|html?|svg|tsx?|jsx?|mjs|cjs|js|jsonc?|ya?ml|toml|txt|css|xml|pdf|png|jpe?g|gif|webp)$/i;
  return existsSync(input)
    || input.startsWith(".")
    || input.startsWith("~")
    || /[\\/]/.test(input)
    || knownFileExtension.test(basename(input));
}

function escapeHtml(input: string) {
  return input.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char] || char);
}

function markdown(title: string) {
  return `#!/usr/bin/env -S bunx --bun note --pad
<!-- PAD: the shebang is intentional; it lets this document run as a trusted Bun program. -->
# ${title}

- [ ] Write something worth keeping.
`;
}

function html(title: string) {
  const safeTitle = escapeHtml(title);
  return `#!/usr/bin/env -S bunx --bun note --pad
<!-- PAD: the shebang is intentional; it lets this document run as a trusted Bun program. -->
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${safeTitle}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/note@${VERSION}/pad.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/note@${VERSION}/pad.mjs"></script>
<main>
  <h1>${safeTitle}</h1>
  <p>Preview like a file. Open like a page. Run like an app.</p>
  <p>Run trusted mode by executing this file.</p>
</main>
`;
}

function svg(title: string) {
  const safeTitle = escapeHtml(title);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 480">
  <title>${safeTitle}</title>
  <rect width="900" height="480" fill="#08111f"/>
  <text x="60" y="150" fill="#f8ffe8" font-family="system-ui, sans-serif" font-size="64" font-weight="700">${safeTitle}</text>
  <text x="60" y="230" fill="#d7ff9b" font-family="system-ui, sans-serif" font-size="28">Preview like a file. Open like a page. Run with: bunx note --pad</text>
</svg>
`;
}

function template(format: Format, title: string) {
  if (format === "html") return html(title);
  if (format === "svg") return svg(title);
  return markdown(title);
}

async function createPad(args: Array<string>) {
  let format: Format = "md";
  let forcedTitle = false;
  const titleParts: Array<string> = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--md") format = "md";
    else if (arg === "--html") format = "html";
    else if (arg === "--svg") format = "svg";
    else if (arg === "--format" || arg === "-f") {
      const next = args[++i];
      if (next !== "md" && next !== "html" && next !== "svg") die("--format must be md, html, or svg");
      format = next;
    } else if (arg === "--title") {
      const next = args[++i];
      if (!next) die("--title needs a value");
      forcedTitle = true;
      titleParts.push(next);
    } else if (arg.startsWith("-")) die(`Unknown option: ${arg}`);
    else titleParts.push(arg);
  }

  const title = titleParts.join(" ").trim() || "untitled";
  if (!forcedTitle && looksLikePath(title)) {
    die(`That looks like a file path.\n\nRun a PAD with:\n  bunx note --pad ${title}\n\nForce a literal title with:\n  bunx note --title ${JSON.stringify(title)}`);
  }

  const file = `${localDate()}-${slugify(title)}.pad.${format}`;
  if (existsSync(file)) die(`Refusing to overwrite existing file: ${file}`);

  const content = template(format, title);
  await Bun.write(file, content);
  if (content.startsWith("#!")) chmodSync(file, 0o755);
  console.log(file);
}

function runPad(args: Array<string>) {
  const [file, ...rest] = args;
  if (!file) die("Usage: note --pad ./file.pad.html");
  if (!existsSync(file)) die(`No such PAD: ${file}`);

  console.log("PAD trusted program mode");
  console.log(`file=${resolve(file)}`);
  console.log(`args=${JSON.stringify(rest)}`);
  console.log("A trusted runner can add a local server, WebSocket sync, self-save, or anything else Bun can do.");
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) console.log(help);
else if (args.includes("--version")) console.log(VERSION);
else if (args[0] === "--pad") runPad(args.slice(1));
else await createPad(args);
