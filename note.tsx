#!/usr/bin/env bun
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerWebSocket } from "bun";
import QRCode from "qrcode";

type Format = "md" | "html" | "svg";
type PadSocket = ServerWebSocket<unknown>;

const HOST = "0.0.0.0";
const DEFAULT_IDLE_SHUTDOWN_MS = 2_000;
const DEFAULT_FIRST_CLIENT_TIMEOUT_MS = 5 * 60_000;
const PAD_ASSET_BASE = ".";

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
  note --pad ./file.pad.html      edit a PAD through a trusted local server
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

function escapeAttribute(input: string) {
  return escapeHtml(input).replace(/'/g, "&#39;");
}

function stripShebang(input: string) {
  return input.startsWith("#!") ? input.replace(/^#!.*\n/, "") : input;
}

function packageRoot() {
  return dirname(fileURLToPath(import.meta.url));
}

function packageAssetUrl(asset: string) {
  return `${PAD_ASSET_BASE}/${asset}`;
}

function contentTypeFor(pathname: string) {
  const extension = extname(pathname).toLowerCase();
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml; charset=utf-8";
  if (extension === ".html" || extension === ".htm") return "text/html; charset=utf-8";
  if (extension === ".md" || extension === ".markdown") return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function padKind(file: string): Format | "text" {
  const lower = file.toLowerCase();
  if (lower.endsWith(".svg")) return "svg";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  return "text";
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function localNetworkHost() {
  const base = hostname().replace(/\.local$/i, "").replace(/\s+/g, "-");
  return `${base}.local`;
}

function safeScriptJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function renderEditorHtml(config: {
  fileName: string;
  kind: ReturnType<typeof padKind>;
  localUrl: string;
  publicUrl: string;
  token: string;
}) {
  const clientConfig = safeScriptJson({ mode: "server", ...config });
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(config.fileName)} - PAD editor</title>
<link rel="stylesheet" href="/pad.css">
<main data-pad-editor>
  <section class="pad-editor-hero">
    <div>
      <p class="pad-kicker">Trusted local PAD server</p>
      <h1>${escapeHtml(config.fileName)}</h1>
      <p>Edit this file from this computer, phone, or iPad. Server saves write back to the original file.</p>
    </div>
    <figure class="pad-qr-card">
      <img src="/qr.svg?t=${escapeAttribute(config.token)}" alt="QR code for ${escapeAttribute(config.publicUrl)}">
      <figcaption><a href="${escapeAttribute(config.publicUrl)}">${escapeHtml(config.publicUrl)}</a></figcaption>
    </figure>
  </section>
  <section class="pad-controls" aria-label="PAD controls">
    <button type="button" id="padSaveServer">Save to original file</button>
    <button type="button" id="padDownload">Download copy</button>
    <button type="button" id="padPickFile">Pick file for Chrome save</button>
    <button type="button" id="padSavePicked" disabled>Save picked file</button>
    <button type="button" id="padCopyUrl">Copy phone URL</button>
  </section>
  <p id="padStatus" class="pad-status">Starting editor...</p>
  <section class="pad-editor-grid">
    <label class="pad-source-pane">
      <span>Source</span>
      <textarea id="padSource" spellcheck="false"></textarea>
    </label>
    <section class="pad-preview-pane" aria-label="Preview">
      <span>Preview</span>
      <iframe id="padPreview" title="PAD preview" sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"></iframe>
    </section>
  </section>
</main>
<script>globalThis.__PAD_SERVER__ = ${clientConfig};</script>
<script type="module" src="/pad.mjs"></script>
`;
}

function markdown(title: string) {
  return `#!/usr/bin/env -S bun ./note.tsx --pad
<!-- PAD: the shebang is intentional; only run this document if you trust it as a Bun script. -->
# ${title}

- [ ] Write something worth keeping.
`;
}

function html(title: string) {
  const safeTitle = escapeHtml(title);
  return `#!/usr/bin/env -S bun ./note.tsx --pad
<!-- PAD: the shebang is intentional; only run this document if you trust it as a Bun script. -->
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${safeTitle}</title>
<link rel="stylesheet" href="${packageAssetUrl("pad.css")}">
<script type="module" src="${packageAssetUrl("pad.mjs")}"></script>
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
  <text x="60" y="230" fill="#d7ff9b" font-family="system-ui, sans-serif" font-size="28">Preview like a file. Open like a page. Run with: bun ./note.tsx --pad</text>
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
    die(`That looks like a file path.\n\nRun a PAD with:\n  bun ./note.tsx --pad ${title}\n\nForce a literal title with:\n  bun ./note.tsx --title ${JSON.stringify(title)}`);
  }

  const file = `${localDate()}-${slugify(title)}.pad.${format}`;
  if (existsSync(file)) die(`Refusing to overwrite existing file: ${file}`);

  const content = template(format, title);
  await Bun.write(file, content);
  if (content.startsWith("#!")) chmodSync(file, 0o755);
  console.log(file);
}

async function openInBrowser(url: string) {
  if (process.platform === "darwin") {
    const chrome = Bun.spawn(["open", "-a", "Google Chrome", url], { stdout: "ignore", stderr: "ignore" });
    if ((await chrome.exited) === 0) return;
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    return;
  }

  const opener = process.platform === "win32" ? "cmd" : "xdg-open";
  const openArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  Bun.spawn([opener, ...openArgs], { stdout: "ignore", stderr: "ignore" });
}

async function runPad(args: Array<string>) {
  const file = args.find((arg) => !arg.startsWith("-"));
  if (!file) die("Usage: note --pad ./file.pad.html");
  if (!existsSync(file)) die(`No such PAD: ${file}`);

  const absoluteFile = resolve(file);
  const fileName = basename(absoluteFile);
  const kind = padKind(absoluteFile);
  const clients = new Set<PadSocket>();
  let source = await readFile(absoluteFile, "utf8");
  let lastSavedAt: string | null = null;
  let saveCounter = 0;
  let localUrl = "";
  let publicUrl = "";
  const token = crypto.randomUUID().replaceAll("-", "");
  let server: ReturnType<typeof Bun.serve>;
  let hasHadClient = false;
  let stopping = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let firstClientTimer: ReturnType<typeof setTimeout> | null = null;
  const idleShutdownMs = envNumber("NOTE_PAD_IDLE_MS", DEFAULT_IDLE_SHUTDOWN_MS);
  const firstClientTimeoutMs = envNumber("NOTE_PAD_FIRST_CLIENT_TIMEOUT_MS", DEFAULT_FIRST_CLIENT_TIMEOUT_MS);

  const broadcast = (message: unknown) => {
    const text = JSON.stringify(message);
    for (const client of clients) {
      try {
        client.send(text);
      } catch {
        clients.delete(client);
      }
    }
  };

  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const stopServer = (reason: string) => {
    if (stopping) return;
    stopping = true;
    clearIdleTimer();
    if (firstClientTimer) clearTimeout(firstClientTimer);
    console.log(reason);
    server.stop(true);
  };

  const stopWhenIdle = () => {
    if (stopping || !hasHadClient || clients.size > 0) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      if (clients.size > 0) return;
      stopServer("No active PAD clients remain; stopping server.");
    }, idleShutdownMs);
  };

  const saveToOriginal = async (reason: string) => {
    await writeFile(absoluteFile, source);
    saveCounter += 1;
    lastSavedAt = new Date().toISOString();
    broadcast({ type: "saved", source, reason, saveCounter, savedAt: lastSavedAt });
    console.log(`[save ${saveCounter}] ${reason} -> ${absoluteFile}`);
  };

  const handleClientMessage = async (ws: PadSocket, rawMessage: string | Buffer) => {
    let message: { type?: string; source?: unknown; reason?: string };
    try {
      message = JSON.parse(String(rawMessage));
    } catch {
      ws.send(JSON.stringify({ type: "server-error", message: "Server received malformed JSON." }));
      return;
    }

    if (message.type === "update") {
      source = String(message.source ?? "");
      broadcast({ type: "source", source, reason: message.reason || "client edit" });
      return;
    }

    if (message.type === "save") {
      source = String(message.source ?? source);
      await saveToOriginal(message.reason || "client save");
      return;
    }

    if (message.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    ws.send(JSON.stringify({ type: "server-error", message: `Unknown message type: ${message.type}` }));
  };

  const isAuthorized = (url: URL) => url.searchParams.get("t") === token;

  server = Bun.serve({
    hostname: HOST,
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/ws") {
        if (!isAuthorized(url)) return new Response("Missing or invalid PAD token", { status: 403 });
        if (server.upgrade(request)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

      if (url.pathname === "/pad.css" || url.pathname === "/pad.mjs") {
        const assetPath = resolve(packageRoot(), url.pathname.slice(1));
        return new Response(await readFile(assetPath), { headers: { "content-type": contentTypeFor(assetPath), "cache-control": "no-store" } });
      }

      if (!isAuthorized(url)) return new Response("Missing or invalid PAD token. Use the URL printed by note --pad.", { status: 403 });

      if (url.pathname === "/raw") {
        return new Response(source, { headers: { "content-type": contentTypeFor(absoluteFile), "cache-control": "no-store" } });
      }

      if (url.pathname === "/download") {
        return new Response(source, {
          headers: {
            "content-type": contentTypeFor(absoluteFile),
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="${fileName.replace(/["\\]/g, "_")}"`,
          },
        });
      }

      if (url.pathname === "/qr.svg") {
        const svg = await QRCode.toString(publicUrl, { type: "svg", margin: 1, width: 240 });
        return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" } });
      }

      return new Response(renderEditorHtml({ fileName, kind, localUrl, publicUrl, token }), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    },
    websocket: {
      open(ws) {
        if (firstClientTimer) clearTimeout(firstClientTimer);
        clearIdleTimer();
        hasHadClient = true;
        clients.add(ws);
        ws.send(JSON.stringify({ type: "hello", source, fileName, kind, localUrl, publicUrl, savedAt: lastSavedAt }));
        broadcast({ type: "peer-count", count: clients.size });
      },
      message: handleClientMessage,
      close(ws) {
        clients.delete(ws);
        broadcast({ type: "peer-count", count: clients.size });
        stopWhenIdle();
      },
    },
  });

  localUrl = `http://127.0.0.1:${server.port}/?t=${token}`;
  publicUrl = `http://${localNetworkHost()}:${server.port}/?t=${token}`;

  firstClientTimer = setTimeout(() => {
    if (!hasHadClient) stopServer("No PAD client connected before the first-client timeout; stopping server.");
  }, firstClientTimeoutMs);

  const terminalQr = await QRCode.toString(publicUrl, { type: "terminal", small: true });
  console.log(`\n${fileName}`);
  console.log(`Listening on ${HOST}:${server.port}`);
  console.log(`Local:   ${localUrl}`);
  console.log(`Phone:   ${publicUrl}`);
  console.log("Scan this QR code from your phone or iPad:");
  console.log(terminalQr);
  console.log("The server stops shortly after the last browser client disconnects. Press Ctrl-C to stop.\n");

  const noOpen = args.includes("--no-open") || process.env.NOTE_PAD_NO_OPEN === "1";
  if (!noOpen) await openInBrowser(localUrl);

  const stop = () => stopServer("Stopping PAD server.");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) console.log(help);
else if (args.includes("--version")) console.log(VERSION);
else if (args[0] === "--pad") await runPad(args.slice(1));
else await createPad(args);
