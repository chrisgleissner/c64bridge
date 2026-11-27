import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createImportResolver, SIDWAVE_LIBRARY_LIMITS } from "sidwave";
import type { SidwaveFileReader, SidwaveReadOptions } from "sidwave/pcm";
import YAML from "yaml";
import { DEFAULT_MAX_READ_BYTES, resolveHostPath } from "./hostPaths.js";

/**
 * Reads a SIDWAVE `file:` sample source the way every other host file argument is read: the path must lie in an
 * allowed root and the file must not exceed the host read size limit.
 */
export const hostSidwaveFileReader: SidwaveFileReader = (file) => readFileSync(resolveHostPath(file, { purpose: "read" }));

/** Options for sidwave `parseSidwave` and `renderSample` calls made on behalf of a tool caller. */
export const hostSidwaveReadOptions: SidwaveReadOptions = {
  readFile: hostSidwaveFileReader,
  maxFileBytes: DEFAULT_MAX_READ_BYTES,
};

/** The file an import names, or undefined when the library rejects the name without reading anything. */
function importedFile(name: string, importingFile: string, scoreDir: string): string | undefined {
  if (name.includes("\0") || isAbsolute(name)) return undefined;
  if (!name.startsWith("pkg:")) return resolve(dirname(importingFile), name);
  // Like the library: node_modules of the importing file's directory and of each parent up to the score's directory.
  for (let dir = dirname(importingFile); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...name.slice(4).split("/"));
    if (existsSync(candidate)) return candidate;
    if (dir === scoreDir || dirname(dir) === dir) return undefined;
  }
}

/**
 * Applies the host path rules to every library a score or one of its libraries names, by relative path or as
 * `pkg:<package>/<file>`, so that an import cannot read a hidden or server-owned file. Names the library rejects and
 * files it refuses by size are left to the library to report.
 */
function checkImports(score: unknown, from: string, scoreDir: string, seen: Set<string>): void {
  const entries = (score as { imports?: unknown } | null | undefined)?.imports;
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    const name: unknown = (entry as { from?: unknown } | null)?.from;
    if (typeof name !== "string") continue;
    const candidate = importedFile(name, from, scoreDir);
    if (candidate === undefined) continue;
    // Checked before the existence test, so a refusal does not reveal whether a file outside the roots exists.
    const file = resolveHostPath(candidate, { purpose: "read" });
    if (seen.has(file) || seen.size >= SIDWAVE_LIBRARY_LIMITS.maxFiles || !existsSync(file)) continue;
    seen.add(file);
    if (statSync(file).size > SIDWAVE_LIBRARY_LIMITS.maxFileBytes) continue;
    let library: unknown;
    try {
      library = YAML.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    checkImports(library, file, scoreDir, seen);
  }
}

/**
 * Resolver for the `imports` of the score in `file`. The sidwave library keeps imports inside the score's directory;
 * the host path rules apply in addition.
 */
export function hostSidwaveImportResolver(file: string): NonNullable<SidwaveReadOptions["imports"]> {
  const resolveImports = createImportResolver({ file });
  return (score) => {
    checkImports(score, file, realpathSync(dirname(file)), new Set());
    return resolveImports(score);
  };
}

/** Read options for a caller supplied score, using its path or the working directory for inline text. */
export function hostSidwaveReadOptionsFor(file = resolve(process.cwd(), "score.yaml")): SidwaveReadOptions {
  return { ...hostSidwaveReadOptions, imports: hostSidwaveImportResolver(file) };
}
