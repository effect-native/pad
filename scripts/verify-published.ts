#!/usr/bin/env bun
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")).version as string;
const distTag = version.includes("-") ? "beta" : "latest";

async function examples(dir = resolve(repoRoot, "examples")): Promise<Array<string>> {
  const found: Array<string> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await examples(absolute));
      continue;
    }
    if (/\.pad\.(?:md|markdown|html?|svg)$/i.test(entry.name)) found.push(absolute);
  }
  return found.sort();
}

async function run(args: Array<string>, options: { timeoutMs?: number } = {}) {
  const proc = Bun.spawn(args, { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: { ...process.env, NOTE_PAD_NO_OPEN: "1", NOTE_PAD_IDLE_MS: "200", NOTE_PAD_FIRST_CLIENT_TIMEOUT_MS: "8000" } });
  const timeout = setTimeout(() => proc.kill(), options.timeoutMs || 120_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timeout));
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed with ${exitCode}\n${stdout}\n${stderr}`);
  return stdout.trim();
}

async function waitForDistTag() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = await run(["npm", "view", "note", "dist-tags", "--json"]);
    const tags = JSON.parse(raw) as Record<string, string>;
    if (tags[distTag] === version) return;
    await Bun.sleep(3_000);
  }
  throw new Error(`npm dist-tag ${distTag} did not resolve to ${version}`);
}

async function runPublishedServer(args: Array<string>, label: string) {
  const proc = Bun.spawn(args, { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: { ...process.env, NOTE_PAD_NO_OPEN: "1", NOTE_PAD_IDLE_MS: "200", NOTE_PAD_FIRST_CLIENT_TIMEOUT_MS: "8000" } });
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let output = "";
  let localUrl = "";
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
    const match = /Local:\s+(http:\/\/[^\s]+)/.exec(output);
    if (match) {
      localUrl = match[1];
      break;
    }
  }
  if (!localUrl.includes("?t=")) throw new Error(`${label}: no tokenized Local URL\n${output}`);
  const wsUrl = new URL(localUrl);
  wsUrl.protocol = "ws:";
  wsUrl.pathname = "/ws";
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: WebSocket timeout`)), 6_000);
    ws.addEventListener("message", (event) => {
      if (JSON.parse(event.data).type === "hello") {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    ws.addEventListener("error", reject);
  });
  ws.close();
  const exit = await Promise.race([proc.exited, new Promise((resolvePromise) => setTimeout(() => resolvePromise("timeout"), 7_000))]);
  if (exit === "timeout") {
    proc.kill();
    throw new Error(`${label}: server did not idle-shutdown`);
  }
}

await waitForDistTag();
if (await run(["bunx", "--bun", `note@${distTag}`, "--version"]) !== version) throw new Error(`note@${distTag} did not return ${version}`);
for (const example of await examples()) {
  const source = await readFile(example, "utf8");
  const relative = example.replace(`${repoRoot}/`, "");
  if (source.startsWith("#!")) await runPublishedServer([example, "--no-open"], `${relative} shebang`);
  else await runPublishedServer(["bunx", "--bun", `note@${version}`, "--pad", example, "--no-open"], `${relative} exact package`);
}
for (const asset of ["pad.css", "pad.mjs"]) {
  const response = await fetch(`https://cdn.jsdelivr.net/npm/note@${version}/${asset}`);
  if (!response.ok) throw new Error(`CDN asset failed: ${asset} ${response.status}`);
}
console.log(`verify-published ok: note@${version}`);
