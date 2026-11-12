// Confinement of host file paths that originate from tool arguments.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolValidationError } from "./tools/errors.js";

export type HostPathPurpose = "read" | "write";

export interface ResolveHostPathOptions {
  readonly purpose: HostPathPurpose;
  /** Read only: largest file accepted, in bytes. Default 16 MiB. */
  readonly maxBytes?: number;
  /** Replaces the default allowed roots. Intended for tests. */
  readonly roots?: readonly string[];
}

export const DEFAULT_MAX_READ_BYTES = 16 * 1024 * 1024;
export const DISK_IMAGE_MAX_READ_BYTES = 64 * 1024 * 1024;
export const ALLOWED_DIRS_ENV = "C64BRIDGE_ALLOWED_DIRS";

/** True when candidate equals root or lies inside it. Both must be absolute. */
export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Real path of the deepest existing ancestor, with the nonexistent remainder appended. */
function realpathOfDeepest(target: string): string {
  const pending: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...pending.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      let isLink = false;
      try { isLink = fs.lstatSync(current).isSymbolicLink(); } catch { /* does not exist */ }
      // A dangling symlink would be followed by a later write, so its target cannot be vetted.
      if (isLink) throw new ToolValidationError(`Host path is a dangling symbolic link: ${current}`, { path: current });
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...pending.reverse());
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

function safeRealpath(p: string): string {
  try { return realpathOfDeepest(path.resolve(p)); } catch { return path.resolve(p); }
}

function homeDirectory(): string {
  return process.env.HOME || os.homedir();
}

/** Allowed roots (real paths). Reads cwd, environment and home directory at call time. */
export function allowedHostRoots(): string[] {
  const roots: string[] = [];
  const cwd = safeRealpath(process.cwd());
  const home = safeRealpath(homeDirectory());
  if (cwd !== home && cwd !== path.parse(cwd).root) roots.push(cwd);
  roots.push(safeRealpath(path.join(homeDirectory(), ".c64bridge")));
  roots.push(safeRealpath(os.tmpdir()));
  const extra = process.env[ALLOWED_DIRS_ENV];
  if (extra) {
    for (const entry of extra.split(path.delimiter)) {
      const trimmed = entry.trim();
      if (trimmed && trimmed !== "*") roots.push(safeRealpath(trimmed));
    }
  }
  return [...new Set(roots)];
}

/**
 * Resolve a file name that the server appends to an already resolved directory.
 * The final path is checked again: a symbolic link planted at that name in a
 * shared directory (for example the temp directory) must not redirect the write
 * outside the allowed roots.
 */
export function resolveHostChildPath(dir: string, ...names: string[]): string {
  return resolveHostPath(path.join(dir, ...names), { purpose: "write" });
}

/** Default output directory under the working directory, or under ~/.c64bridge when the working directory is not an allowed root. */
export function defaultHostOutputDir(...names: string[]): string {
  try {
    return resolveHostPath(path.join(process.cwd(), ...names), { purpose: "write" });
  } catch (error) {
    if (!(error instanceof ToolValidationError)) throw error;
    return resolveHostPath(path.join(homeDirectory(), ".c64bridge", ...names), { purpose: "write" });
  }
}

function confinementDisabled(): boolean {
  const extra = process.env[ALLOWED_DIRS_ENV];
  return !!extra && extra.trim() === "*";
}

/**
 * Resolve a tool-supplied path to an absolute real path inside the allowed roots.
 * Throws ToolValidationError for paths outside the roots, dangling symlinks and oversized reads.
 */
export function resolveHostPath(input: string, options: ResolveHostPathOptions): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new ToolValidationError("Host path must be a non-empty string without NUL bytes.");
  }
  const resolved = path.resolve(input);
  const disabled = !options.roots && confinementDisabled();
  const real = disabled ? resolved : realpathOfDeepest(resolved);
  if (!disabled) {
    const roots = options.roots ? options.roots.map(safeRealpath) : allowedHostRoots();
    if (!roots.some((root) => isWithin(root, real))) {
      throw new ToolValidationError(
        `Host path is outside the allowed directories: ${resolved}. Allowed roots: ${roots.join(", ")}. `
          + `Add directories with the ${ALLOWED_DIRS_ENV} environment variable (entries separated by "${path.delimiter}"; "*" disables confinement).`,
        { path: resolved, details: { allowedRoots: roots, env: ALLOWED_DIRS_ENV } },
      );
    }
  }
  if (options.purpose === "read") {
    const limit = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;
    let size: number | undefined;
    try { size = fs.statSync(real).size; } catch { size = undefined; }
    if (size !== undefined && size > limit) {
      throw new ToolValidationError(`Host file is too large to read: ${resolved} is ${size} bytes, limit is ${limit} bytes.`, { path: resolved });
    }
  }
  return real;
}
