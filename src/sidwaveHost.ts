import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createImportResolver } from "sidwave";
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

/**
 * Applies the host path rules to every library a score or one of its libraries names by relative path, so that an
 * import cannot read a hidden or server-owned file. Missing and absolute paths are left to the library to report.
 */
function checkImports(score: unknown, from: string, seen: Set<string>): void {
  const entries = (score as { imports?: unknown } | null | undefined)?.imports;
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    const name: unknown = (entry as { from?: unknown } | null)?.from;
    if (typeof name !== "string" || isAbsolute(name) || name.includes(":")) continue;
    const candidate = resolve(dirname(from), name);
    if (!existsSync(candidate)) continue;
    const file = resolveHostPath(candidate, { purpose: "read" });
    if (seen.has(file)) continue;
    seen.add(file);
    let library: unknown;
    try {
      library = YAML.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    checkImports(library, file, seen);
  }
}

/**
 * Resolver for the `imports` of the score in `file`. The sidwave library keeps imports inside the score's directory;
 * the host path rules apply in addition.
 */
export function hostSidwaveImportResolver(file: string): NonNullable<SidwaveReadOptions["imports"]> {
  const resolveImports = createImportResolver({ file });
  return (score) => {
    checkImports(score, file, new Set());
    return resolveImports(score);
  };
}
