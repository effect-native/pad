#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")).version as string;

type RunOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

async function run(args: Array<string>, options: RunOptions = {}) {
  const proc = Bun.spawn(args, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), options.timeoutMs || 120_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timeout));
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed with ${exitCode}\n${stdout}\n${stderr}`);
  }
  return stdout.trim();
}

async function tempDir() {
  return (await run(["mktemp", "-d"])).trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForLocalUrl(proc: ReturnType<typeof Bun.spawn>, label: string) {
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let output = "";
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
    const match = /Local:\s+(http:\/\/[^\s]+)/.exec(output);
    if (match) return match[1];
  }
  throw new Error(`${label}: server did not print Local URL. Output:\n${output}`);
}

async function exercisePadServer(command: Array<string>, file: string, label: string) {
  const proc = Bun.spawn(command, {
    cwd: repoRoot,
    env: {
      ...process.env,
      NOTE_PAD_NO_OPEN: "1",
      NOTE_PAD_IDLE_MS: "200",
      NOTE_PAD_FIRST_CLIENT_TIMEOUT_MS: "8000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const localUrl = await waitForLocalUrl(proc, label);
  assert(localUrl.includes("?t="), `${label}: Local URL is not tokenized`);
  const withoutToken = localUrl.replace(/\?.*/, "");
  assert(await fetch(withoutToken).then((response) => response.status) === 403, `${label}: missing token did not 403`);
  const editor = await fetch(localUrl).then((response) => response.text());
  assert(editor.includes("Trusted local PAD server"), `${label}: editor did not render`);
  assert(editor.includes("/qr.svg?t="), `${label}: editor did not include tokenized QR`);
  const qrUrl = new URL(`/qr.svg${new URL(localUrl).search}`, localUrl);
  assert((await fetch(qrUrl).then((response) => response.text())).includes("<svg"), `${label}: QR endpoint did not return SVG`);

  const wsUrl = new URL(localUrl);
  wsUrl.protocol = "ws:";
  wsUrl.pathname = "/ws";
  const ws = new WebSocket(wsUrl);
  const hello = await new Promise<Record<string, string>>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: WebSocket hello timeout`)), 5_000);
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "hello") {
        clearTimeout(timer);
        resolvePromise(message);
      }
    });
    ws.addEventListener("error", reject);
  });
  assert(hello.source, `${label}: hello did not include source`);
  const edited = hello.source.includes("Smoke")
    ? hello.source.replace("Smoke", "Smoke Verified")
    : `${hello.source}\n<!-- Smoke Verified -->\n`;
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: save timeout`)), 5_000);
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "saved") {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    ws.send(JSON.stringify({ type: "save", source: edited, reason: label }));
  });
  ws.close();
  const exit = await Promise.race([proc.exited, new Promise((resolvePromise) => setTimeout(() => resolvePromise("timeout"), 7_000))]);
  if (exit === "timeout") {
    proc.kill();
    throw new Error(`${label}: server did not stop after client close`);
  }
  assert((await readFile(file, "utf8")).includes("Smoke Verified"), `${label}: save did not write to disk`);
}

async function packPackage() {
  const packDir = await tempDir();
  const raw = await run(["npm", "pack", "--json", "--pack-destination", packDir]);
  const [pack] = JSON.parse(raw) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const paths = pack.files.map((file) => file.path).sort();
  const required = [
    "README.md",
    "note.tsx",
    "package.json",
    "pad.css",
    "pad.mjs",
  ];
  for (const requiredPath of required) assert(paths.includes(requiredPath), `package is missing ${requiredPath}`);
  assert(paths.some((path) => path.startsWith("examples/") && /\.pad\./.test(path)), "package does not include any PAD examples");
  for (const path of paths) {
    assert(!path.startsWith("tasks/"), `package includes local review artifact ${path}`);
    assert(!path.startsWith("scripts/"), `package includes release tooling ${path}`);
    assert(!path.startsWith("node_modules/"), `package includes node_modules artifact ${path}`);
    assert(!path.endsWith(".tgz"), `package includes nested tarball ${path}`);
  }
  return resolve(packDir, pack.filename);
}

async function createSmokePad(dir: string, name: string) {
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, name);
  await writeFile(file, `#!/usr/bin/env -S bun ./note.tsx --pad\n<!-- PAD: test -->\n<!doctype html>\n<title>Smoke</title>\n<main><h1>Smoke</h1></main>\n`);
  return file;
}

async function main() {
  await run(["bun", "install", "--frozen-lockfile"]);
  await run(["bun", "run", "check"]);

  const generatedDir = await tempDir();
  const generatedName = await run(["bun", resolve(repoRoot, "note.tsx"), "--html", "Artifact Smoke"], { cwd: generatedDir });
  const generated = await readFile(resolve(generatedDir, generatedName), "utf8");
  assert(generated.includes("--pad"), "generated HTML is missing executable PAD shebang");
  assert(generated.includes("/pad.css") || generated.includes("./pad.css"), "generated HTML is missing pad.css asset URL");
  assert(generated.includes("/pad.mjs") || generated.includes("./pad.mjs"), "generated HTML is missing pad.mjs asset URL");

  const sourceSmoke = await createSmokePad(await tempDir(), "source.pad.html");
  await exercisePadServer(["bun", resolve(repoRoot, "note.tsx"), "--pad", sourceSmoke, "--no-open"], sourceSmoke, "source server");

  const tarball = await packPackage();
  assert(await run(["bunx", "--bun", "-p", tarball, "note", "--version"]) === version, "packed CLI returned wrong version");
  const packedSmoke = await createSmokePad(await tempDir(), "packed.pad.html");
  await exercisePadServer(["bunx", "--bun", "-p", tarball, "note", "--pad", packedSmoke, "--no-open"], packedSmoke, "packed server");

  console.log(`verify-artifact ok: ${basename(tarball)}`);
}

await main();
