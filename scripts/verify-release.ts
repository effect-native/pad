#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")).version as string;

async function run(args: Array<string>) {
  const proc = Bun.spawn(args, { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed with ${exitCode}`);
}

async function versionExists() {
  const proc = Bun.spawn(["npm", "view", `note@${version}`, "version"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  return await proc.exited === 0;
}

if (!process.env.NOTE_ALLOW_PUBLISHED_VERSION && await versionExists()) throw new Error(`note@${version} already exists on npm`);
await run(["bun", "scripts/shebangs.ts", "check", "--target", "release", "--version", version]);
await run(["bun", "scripts/verify-artifact.ts"]);
console.log(`verify-release ok: note@${version}`);
