// Locates the `sidwave` package: the directory in SIDWAVE_DIR (a built checkout's `sidwave` folder), or the
// package installed in node_modules.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function sidwaveDir() {
  if (process.env.SIDWAVE_DIR) return path.resolve(process.env.SIDWAVE_DIR);
  const entry = createRequire(import.meta.url).resolve("sidwave/package.json");
  return path.dirname(entry);
}

export async function loadSidwave() {
  const dir = sidwaveDir();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const index = await import(pathToFileURL(path.join(dir, "dist", "index.js")).href);
  // 6502-toolkit is a dependency of sidwave: resolve it from there.
  const assemblerPath = createRequire(path.join(dir, "package.json")).resolve("6502-toolkit/assembler");
  const { assemblyToPrgDetailed } = await import(pathToFileURL(assemblerPath).href);
  return { dir, version: manifest.version, parseSidwave: index.parseSidwave, compileSidwave: index.compileSidwave, assemblyToPrgDetailed };
}

/** Runs the sidwave command line tool and returns its standard output. */
export function sidwaveCli(args, options = {}) {
  const dir = sidwaveDir();
  return execFileSync(process.execPath, [path.join(dir, "bin", "sidwave.js"), ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
}

export const showcaseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
