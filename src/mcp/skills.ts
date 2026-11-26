import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * Skill catalogue. Skills (`.github/skills/<name>/SKILL.md` plus optional supporting files) hold the
 * execution steps that prompts route to. They ship in the npm package, but a client outside this
 * repository cannot read repository paths, so each skill is served as the resource `c64://skills/<name>`
 * and, for clients that use the MCP Skills extension, as `skill://<name>/SKILL.md` and
 * `skill://<name>/<path>`. Both URIs serve the same bytes, which are produced once per catalogue.
 *
 * This module has no MCP SDK imports; the protocol handlers live in `mcp-server.ts`.
 */
export const SKILL_URI_PREFIX = "c64://skills/";
export const SKILL_EXTENSION_URI_PREFIX = "skill://";

/** Limits per skill (same values as the MCP Skills extension helper). */
export const SKILL_LIMITS = { maxFiles: 512, maxBytes: 16 * 1024 * 1024 } as const;
export const DEFAULT_SKILL_PAGE_SIZE = 100;

/** Developer-only skills that are not part of the package. */
const EXCLUDED_SKILLS = new Set(["pr-converge"]);

export interface SkillResource {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: "text/markdown";
  readonly path: string;
}

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly [key: string]: unknown;
}

export interface SkillFileDescriptor {
  readonly uri: string;
  readonly digest: string;
  readonly size: number;
}

export interface SkillExtensionEntry {
  readonly uri: string;
  readonly frontmatter: SkillFrontmatter;
  readonly resources: readonly SkillFileDescriptor[];
}

export interface SkillExtensionPage {
  readonly entries: readonly SkillExtensionEntry[];
  readonly nextCursor?: string;
}

export interface SkillDiagnostic {
  /** Skill directory name. */
  readonly skill: string;
  readonly message: string;
}

export interface SkillCatalogueOptions {
  /** Repository root that contains `.github/skills`. Defaults to this package. */
  readonly root?: string;
}

export interface SkillPageOptions extends SkillCatalogueOptions {
  readonly cursor?: string;
  readonly pageSize?: number;
}

export interface SkillBytes {
  readonly uri: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** An invalid or unrecognised pagination cursor; callers map this to an invalid-params error. */
export class SkillCursorError extends Error {
  constructor(message = "Invalid skills cursor") {
    super(message);
    this.name = "SkillCursorError";
  }
}

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_NAME_PATTERN = /^[\p{Ll}\p{Nd}]+(?:-[\p{Ll}\p{Nd}]+)*$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

interface CatalogueFile {
  readonly uri: string;
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

interface CatalogueSkill {
  readonly name: string;
  readonly path: string;
  readonly frontmatter: SkillFrontmatter;
  readonly files: ReadonlyMap<string, CatalogueFile>;
  readonly entry: SkillExtensionEntry;
}

interface Catalogue {
  readonly skills: readonly CatalogueSkill[];
  readonly byName: ReadonlyMap<string, CatalogueSkill>;
  readonly diagnostics: readonly SkillDiagnostic[];
}

let defaultCatalogue: Catalogue | undefined;

export function skillUri(name: string): string {
  return `${SKILL_URI_PREFIX}${name}`;
}

/** Rewrites repository skill paths in served text to their resource URIs, which every client can read. */
export function rewriteSkillPaths(text: string): string {
  return text.replace(/(?:\.\/)?\.github\/skills\/\*\/SKILL\.md/g, `${SKILL_URI_PREFIX}<name>`).replace(/(?:\.\.\/skills|(?:\.\/)?\.github\/skills)\/([a-z0-9-]+)\/SKILL\.md/g, (whole, name: string) =>
    EXCLUDED_SKILLS.has(name) ? whole : skillUri(name));
}

function mimeTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    case "yaml":
    case "yml":
      return "application/yaml";
    case "js":
    case "mjs":
      return "text/javascript";
    case "ts":
      return "text/typescript";
    case "py":
      return "text/x-python";
    case "sh":
      return "application/x-sh";
    case "html":
      return "text/html";
    case "css":
      return "text/css";
    case "csv":
      return "text/csv";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class SkillRejected extends Error {}

/** Collects the regular files of one skill (relative posix path to absolute path), refusing escapes. */
function collectFiles(skillDir: string, diagnostics: SkillDiagnostic[], skill: string): Map<string, string> {
  const realSkillDir = realpathSync(skillDir);
  const found = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const relPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.name.startsWith(".")) continue;
      if (!SAFE_SEGMENT.test(entry.name)) {
        diagnostics.push({ skill, message: `file ${relPath} skipped: unsupported characters in name` });
        continue;
      }
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(abs);
        } catch {
          diagnostics.push({ skill, message: `symlink ${relPath} skipped: target does not exist` });
          continue;
        }
        if (!isInside(realSkillDir, target)) {
          diagnostics.push({ skill, message: `symlink ${relPath} skipped: resolves outside the skill directory` });
          if (relPath === "SKILL.md") throw new SkillRejected("SKILL.md is a symlink that resolves outside the skill directory");
          continue;
        }
        if (!lstatSync(target).isFile()) {
          diagnostics.push({ skill, message: `symlink ${relPath} skipped: directory symlinks are not followed` });
          continue;
        }
        found.set(relPath, target);
      } else if (stat.isDirectory()) {
        walk(abs, relPath);
      } else if (stat.isFile()) {
        found.set(relPath, abs);
      }
      if (found.size > SKILL_LIMITS.maxFiles) throw new SkillRejected(`more than ${SKILL_LIMITS.maxFiles} files`);
    }
  };
  walk(skillDir, "");
  return found;
}

function parseFrontmatter(text: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^﻿/, ""));
  if (!match) throw new SkillRejected("SKILL.md has no YAML frontmatter");
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch (error) {
    throw new SkillRejected(`SKILL.md frontmatter is not valid YAML: ${describeError(error)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new SkillRejected("SKILL.md frontmatter must be a YAML mapping");
  const record = data as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.description !== "string") {
    throw new SkillRejected('SKILL.md frontmatter must contain string "name" and "description"');
  }
  return record as SkillFrontmatter;
}

function validateFrontmatter(frontmatter: SkillFrontmatter, directory: string): void {
  const { name, description } = frontmatter;
  if (name.length === 0 || name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw new SkillRejected(`name "${name}" must be 1-64 lowercase letters, digits and single hyphens without leading or trailing hyphen`);
  }
  if (name !== directory) throw new SkillRejected(`name "${name}" must equal the directory name "${directory}"`);
  const length = [...description].length;
  if (length < 1 || length > 1024) throw new SkillRejected("description must be 1-1024 characters");
  const compatibility = frontmatter.compatibility;
  if (compatibility !== undefined && (typeof compatibility !== "string" || compatibility === "" || [...compatibility].length > 500)) {
    throw new SkillRejected("compatibility must be a string of 1-500 characters");
  }
  const metadata = frontmatter.metadata;
  if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata) || Object.values(metadata).some((value) => typeof value !== "string"))) {
    throw new SkillRejected("metadata must map strings to strings");
  }
}

function buildSkill(directory: string, skillDir: string, diagnostics: SkillDiagnostic[]): CatalogueSkill {
  const paths = collectFiles(skillDir, diagnostics, directory);
  const skillMdPath = paths.get("SKILL.md");
  if (!skillMdPath) throw new SkillRejected("SKILL.md is missing");
  let total = 0;
  const files = new Map<string, CatalogueFile>();
  let frontmatter: SkillFrontmatter | undefined;
  for (const [relPath, abs] of paths) {
    let bytes: Uint8Array = readFileSync(abs);
    total += bytes.byteLength;
    if (total > SKILL_LIMITS.maxBytes) throw new SkillRejected(`more than ${SKILL_LIMITS.maxBytes} bytes`);
    const uri = `${SKILL_EXTENSION_URI_PREFIX}${directory}/${relPath}`;
    if (relPath === "SKILL.md") {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new SkillRejected("SKILL.md is not valid UTF-8");
      }
      frontmatter = parseFrontmatter(text);
      validateFrontmatter(frontmatter, directory);
      bytes = new TextEncoder().encode(rewriteSkillPaths(text));
    }
    files.set(relPath, { uri, path: abs, mimeType: relPath === "SKILL.md" ? "text/markdown" : mimeTypeFor(relPath), bytes, digest: sha256(bytes) });
  }
  const resources = [...files.values()]
    .map((file): SkillFileDescriptor => ({ uri: file.uri, digest: file.digest, size: file.bytes.byteLength }))
    .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  const entry: SkillExtensionEntry = { uri: `${SKILL_EXTENSION_URI_PREFIX}${directory}/SKILL.md`, frontmatter: frontmatter!, resources };
  return { name: directory, path: skillMdPath, frontmatter: frontmatter!, files, entry };
}

function buildCatalogue(root: string): Catalogue {
  const base = join(root, ".github", "skills");
  const diagnostics: SkillDiagnostic[] = [];
  const skills: CatalogueSkill[] = [];
  let directories: string[] = [];
  try {
    directories = readdirSync(base, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !EXCLUDED_SKILLS.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { skills, byName: new Map(), diagnostics };
  }
  const seen = new Set<string>();
  let realBase: string;
  try {
    realBase = realpathSync(base);
  } catch {
    return { skills, byName: new Map(), diagnostics };
  }
  for (const directory of directories) {
    const skillDir = join(base, directory);
    try {
      if (!isInside(realBase, realpathSync(skillDir)) || !lstatSync(skillDir).isDirectory() && !lstatSync(realpathSync(skillDir)).isDirectory()) {
        throw new SkillRejected("skill directory resolves outside the skills directory");
      }
      // A directory without SKILL.md is not a skill.
      const hasSkillFile = readdirSync(skillDir).includes("SKILL.md");
      if (!hasSkillFile) continue;
      const skill = buildSkill(directory, skillDir, diagnostics);
      if (seen.has(skill.name)) throw new SkillRejected(`duplicate skill name "${skill.name}"`);
      seen.add(skill.name);
      skills.push(skill);
    } catch (error) {
      diagnostics.push({ skill: directory, message: describeError(error) });
    }
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { skills, byName: new Map(skills.map((skill) => [skill.name, skill])), diagnostics };
}

function catalogueFor(root: string | undefined): Catalogue {
  if (root === undefined || root === PROJECT_ROOT) {
    defaultCatalogue ??= buildCatalogue(PROJECT_ROOT);
    return defaultCatalogue;
  }
  return buildCatalogue(root);
}

/** Legacy resource listing (`c64://skills/<name>`), sorted by URI. */
export function listSkillResources(root: string = PROJECT_ROOT): readonly SkillResource[] {
  return catalogueFor(root).skills
    .map((skill): SkillResource => ({
      uri: skillUri(skill.name),
      name: `Skill: ${skill.name}`,
      description: skill.frontmatter.description,
      mimeType: "text/markdown",
      path: skill.path,
    }))
    .sort((a, b) => a.uri.localeCompare(b.uri));
}

/** Problems found while loading the catalogue; the affected skills or files are excluded. */
export function getSkillDiagnostics(options: SkillCatalogueOptions = {}): readonly SkillDiagnostic[] {
  return catalogueFor(options.root).diagnostics;
}

/** Entries for the MCP Skills extension, in name order. */
export function listSkillExtensionEntries(options: SkillCatalogueOptions = {}): readonly SkillExtensionEntry[] {
  return catalogueFor(options.root).skills.map((skill) => skill.entry);
}

function encodeCursor(after: string): string {
  return Buffer.from(JSON.stringify({ after }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new SkillCursorError();
  const raw = Buffer.from(cursor, "base64url");
  if (raw.toString("base64url") !== cursor) throw new SkillCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new SkillCursorError();
  }
  const after = (parsed as { after?: unknown } | null)?.after;
  if (typeof after !== "string" || after.length === 0) throw new SkillCursorError();
  return after;
}

/** One page of extension entries. `cursor` is opaque; an invalid cursor throws `SkillCursorError`. */
export function pageSkillExtensionEntries(options: SkillPageOptions = {}): SkillExtensionPage {
  const pageSize = options.pageSize ?? DEFAULT_SKILL_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be a positive integer");
  const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  const all = catalogueFor(options.root).skills.filter((skill) => after === undefined || skill.name > after);
  const page = all.slice(0, pageSize);
  const last = page[page.length - 1];
  const entries = page.map((skill) => skill.entry);
  return all.length > pageSize && last ? { entries, nextCursor: encodeCursor(last.name) } : { entries };
}

function lookupFile(uri: string, root: string | undefined): { skill: CatalogueSkill; file: CatalogueFile } | undefined {
  const catalogue = catalogueFor(root);
  let name: string;
  let path: string;
  if (uri.startsWith(SKILL_URI_PREFIX)) {
    name = uri.slice(SKILL_URI_PREFIX.length);
    path = "SKILL.md";
  } else if (uri.startsWith(SKILL_EXTENSION_URI_PREFIX)) {
    const rest = uri.slice(SKILL_EXTENSION_URI_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return undefined;
    name = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  } else {
    return undefined;
  }
  // Only exact names and exact listed paths resolve, so "..", ".", empty segments and percent or
  // backslash encodings never match a catalogue entry.
  const skill = catalogue.byName.get(name);
  const file = skill?.files.get(path);
  return skill && file ? { skill, file } : undefined;
}

/**
 * Bytes of a skill file as served: `skill://<name>/<path>` for any listed file, or `c64://skills/<name>`
 * for SKILL.md. Returns undefined for an unknown URI. The returned `uri` echoes the requested URI.
 */
export function readSkillBytes(uri: string, options: SkillCatalogueOptions = {}): SkillBytes | undefined {
  const found = lookupFile(uri, options.root);
  return found ? { uri, mimeType: found.file.mimeType, bytes: found.file.bytes } : undefined;
}

/** Text form of `c64://skills/<name>` used by the existing resource handler. */
export function readSkillResource(uri: string): { uri: string; mimeType: "text/markdown"; text: string } | undefined {
  if (!uri.startsWith(SKILL_URI_PREFIX)) return undefined;
  const found = lookupFile(uri, undefined);
  if (!found) return undefined;
  return { uri, mimeType: "text/markdown", text: new TextDecoder().decode(found.file.bytes) };
}
