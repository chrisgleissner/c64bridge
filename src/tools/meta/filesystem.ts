// Filesystem discovery meta tool
import type { ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, arraySchema, numberSchema, optionalSchema, booleanSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolExecutionError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { promises as fs } from "node:fs";
import { resolve as resolvePath, join as joinPath, dirname } from "node:path";
import { formatTimestampSpec } from "./util.js";
import { getTasksHomeDir } from "./background.js";

// Reusable collators to avoid repeated instantiation overhead
const CASE_INSENSITIVE_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });
const CASE_SENSITIVE_COLLATOR = new Intl.Collator(undefined, { sensitivity: "variant" });

const findPathsByNameArgsSchema = objectSchema({
  description: "Find device paths with names containing a substring. Uses firmware wildcard file info.",
  properties: {
    root: optionalSchema(stringSchema({ description: "Root path to search (host)" }), "/"),
    nameContains: stringSchema({ description: "Substring to match", minLength: 1 }),
    extensions: optionalSchema(arraySchema(stringSchema({ description: "Extension filter without dot", minLength: 1 }))),
    maxResults: optionalSchema(numberSchema({ description: "Maximum results", integer: true, minimum: 1, default: 50 }), 50),
    caseInsensitive: optionalSchema(booleanSchema({ description: "Case-insensitive name match", default: true }), true),
  },
  required: ["nameContains"],
  additionalProperties: false,
});

const findAndRunProgramArgsSchema = objectSchema({
  description: "Search for a program by substring and run the first match (PRG/CRT).",
  properties: {
    root: optionalSchema(stringSchema({ description: "Root path to search", minLength: 1 }), "/"),
    nameContains: stringSchema({ description: "Substring to match", minLength: 1 }),
    extensions: optionalSchema(arraySchema(stringSchema({ description: "File extensions to include (without dot)", minLength: 1 }))),
    caseInsensitive: optionalSchema(booleanSchema({ description: "Case-insensitive name match", default: true }), true),
    sort: optionalSchema(stringSchema({ description: "Sort order for matches", enum: ["discovered", "alphabetical"] }), "discovered"),
    waitMs: optionalSchema(numberSchema({ description: "Delay after firmware run before returning", integer: true, minimum: 0, default: 0 }), 0),
    captureCandidates: optionalSchema(numberSchema({ description: "Include up to this many candidates in result", integer: true, minimum: 1, maximum: 100 }), 10),
  },
  required: ["nameContains"],
  additionalProperties: false,
});

const filesystemStatsArgsSchema = objectSchema({
  description: "Compute per-extension stats by walking the filesystem (and container contents) beneath a root path.",
  properties: {
    root: optionalSchema(stringSchema({ description: "Root path to scan", minLength: 1 }), "/"),
    extensions: optionalSchema(arraySchema(stringSchema({ description: "Limit to these extensions (without dot)", minLength: 1 }))),
    includeContainers: optionalSchema(booleanSchema({ description: "Include container images (d64/d81/etc.) in extension stats", default: true }), true),
    maxSamplesPerExtension: optionalSchema(numberSchema({ description: "Number of sample paths to keep per extension", integer: true, minimum: 1, maximum: 10, default: 3 }), 3),
  },
  required: [],
  additionalProperties: false,
});

/**
 * Find a drive in drivesList() output. Ultimate firmware lists drives as a/b
 * with a configurable bus_id, so "drive8" or "8" is matched by bus number.
 */
function findListedDrive(drives: any[], drive: string): any {
  const wanted = drive.trim().toLowerCase();
  const exact = drives.find((d) => String(d?.id ?? "").toLowerCase() === wanted);
  if (exact) return exact;
  // VICE lists drives as driveN; the Ultimate letters a and b default to buses 8 and 9 there.
  const letterBus = wanted === "a" ? 8 : wanted === "b" ? 9 : undefined;
  const bus = /^(?:drive)?\s*(\d+)$/.exec(wanted);
  if (!bus && letterBus === undefined) return undefined;
  const busId = letterBus ?? Number(bus![1]);
  if (letterBus !== undefined) {
    return drives.find((d) => String(d?.id ?? "").toLowerCase() === `drive${busId}`);
  }
  return drives.find((d) => Number(d?.raw?.bus_id) === busId || String(d?.id ?? "").toLowerCase() === `drive${busId}`);
}

interface FindRunStateEntry {
  root: string;
  pattern: string;
  extensions: string[];
  matched?: string;
  timestamp: string;
}

interface FindRunState {
  recentSearches: FindRunStateEntry[];
  lastRunPath?: string;
}

function extractPaths(value: unknown): string[] {
  const acc: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === "string") {
      acc.push(current);
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (typeof current === "object") {
      const maybeObj = current as Record<string, unknown>;
      if (typeof maybeObj.path === "string") acc.push(maybeObj.path);
      if (Array.isArray(maybeObj.paths)) stack.push(maybeObj.paths);
      if (Array.isArray(maybeObj.entries)) stack.push(maybeObj.entries);
    }
  }
  return acc;
}

function extractExtension(candidate: string): string {
  const withoutContainer = candidate.includes("#") ? candidate.slice(candidate.indexOf("#") + 1) : candidate;
  const lastSegment = withoutContainer.split(/[\\/]/).pop() ?? withoutContainer;
  const dot = lastSegment.lastIndexOf(".");
  if (dot === -1) return "";
  return lastSegment.slice(dot + 1).toLowerCase();
}

function normalisePath(path: string, caseInsensitive: boolean): string {
  return caseInsensitive ? path.toLowerCase() : path;
}

async function loadState(statePath: string): Promise<FindRunState> {
  try {
    const text = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const rawRecent = Array.isArray((parsed as any).recentSearches) ? (parsed as any).recentSearches : [];
      const recent: FindRunStateEntry[] = [];
      for (const rawEntry of rawRecent) {
        if (!rawEntry || typeof rawEntry !== "object" || typeof (rawEntry as any).pattern !== "string") continue;
        const rootValue = typeof (rawEntry as any).root === "string" ? (rawEntry as any).root : "/";
        const extensionsValue = Array.isArray((rawEntry as any).extensions)
          ? (rawEntry as any).extensions.map((ext: unknown) => String(ext))
          : [];
        const matchedValue = typeof (rawEntry as any).matched === "string" ? (rawEntry as any).matched : undefined;
        const timestampValue = typeof (rawEntry as any).timestamp === "string" ? (rawEntry as any).timestamp : formatTimestampSpec();
        recent.push({
          root: rootValue,
          pattern: String((rawEntry as any).pattern),
          extensions: extensionsValue,
          matched: matchedValue,
          timestamp: timestampValue,
        });
      }
      return {
        recentSearches: recent,
        lastRunPath: typeof (parsed as any).lastRunPath === "string" ? (parsed as any).lastRunPath : undefined,
      } satisfies FindRunState;
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      // Ignore malformed state; caller will write a fresh copy
    }
  }
  return { recentSearches: [] } satisfies FindRunState;
}

async function persistState(statePath: string, entry: FindRunStateEntry, lastRunPath: string): Promise<void> {
  const current = await loadState(statePath);
  const updated: FindRunState = {
    recentSearches: [entry, ...current.recentSearches].slice(0, 10),
    lastRunPath,
  };
  await fs.mkdir(dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(updated, null, 2), "utf8");
}

interface FileInfoEntry {
  path: string;
  size: number | null;
  isContainer: boolean;
}

interface StatsAccumulator {
  count: number;
  withSize: number;
  totalBytes: number;
  minBytes: number | null;
  maxBytes: number | null;
}

interface ExtensionAccumulator extends StatsAccumulator {
  samples: string[];
}

const CONTAINER_EXTENSIONS = new Set([
  "d64",
  "d71",
  "d81",
  "dnp",
  "t64",
  "g64",
  "g71",
  "d41",
]);

function parseSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
    const parsed = parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function detectContainerFlag(record: Record<string, unknown>, path: string): boolean {
  if (record.isContainer === true || record.is_container === true) return true;
  const typeValue = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
  if (typeValue && CONTAINER_EXTENSIONS.has(typeValue)) return true;
  const formatValue = typeof record.format === "string" ? record.format.toLowerCase() : undefined;
  if (formatValue && CONTAINER_EXTENSIONS.has(formatValue)) return true;
  const ext = extractExtension(path);
  return CONTAINER_EXTENSIONS.has(ext);
}

function isDirectoryRecord(record: Record<string, unknown>, path: string): boolean {
  if (record.isDirectory === true || record.directory === true) return true;
  const typeValue = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
  if (typeValue === "directory" || typeValue === "dir" || typeValue === "folder") return true;
  if (typeof record.kind === "string") {
    const kindValue = (record.kind as string).toLowerCase();
    if (kindValue === "directory" || kindValue === "folder") return true;
  }
  if (path.endsWith("/")) return true;
  return false;
}

function extractEntriesFromInfo(input: unknown): FileInfoEntry[] {
  const map = new Map<string, FileInfoEntry>();
  const stack: unknown[] = [input];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === "string") {
      if (!map.has(current)) {
        map.set(current, { path: current, size: null, isContainer: false });
      }
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (typeof current === "object") {
      const obj = current as Record<string, unknown>;
      const collections = [obj.entries, obj.children, obj.files, obj.contents, obj.items];
      for (const collection of collections) {
        if (Array.isArray(collection)) {
          for (const item of collection) stack.push(item);
        }
      }
      const pathValue = typeof obj.path === "string"
        ? obj.path
        : typeof obj.fullPath === "string"
          ? obj.fullPath
          : undefined;
      if (!pathValue) continue;
      if (isDirectoryRecord(obj, pathValue)) continue;
      const size = parseSize(obj.size ?? obj.length ?? obj.bytes ?? obj.byteLength);
      const isContainer = detectContainerFlag(obj, pathValue);
      const existing = map.get(pathValue);
      if (!existing) {
        map.set(pathValue, { path: pathValue, size: size ?? null, isContainer });
      } else {
        if (existing.size === null && size !== null) existing.size = size;
        existing.isContainer = existing.isContainer || isContainer;
      }
    }
  }
  return Array.from(map.values());
}

function createStatsAccumulator(): StatsAccumulator {
  return { count: 0, withSize: 0, totalBytes: 0, minBytes: null, maxBytes: null };
}

function createExtensionAccumulator(): ExtensionAccumulator {
  return { ...createStatsAccumulator(), samples: [] };
}

function recordSize(acc: StatsAccumulator, size: number | null): void {
  acc.count += 1;
  if (size === null) return;
  acc.withSize += 1;
  acc.totalBytes += size;
  acc.minBytes = acc.minBytes === null ? size : Math.min(acc.minBytes, size);
  acc.maxBytes = acc.maxBytes === null ? size : Math.max(acc.maxBytes, size);
}

function recordExtension(acc: ExtensionAccumulator, size: number | null, path: string, sampleLimit: number): void {
  recordSize(acc, size);
  if (acc.samples.length < sampleLimit) acc.samples.push(path);
}

function deriveMean(acc: StatsAccumulator): number | null {
  if (acc.withSize === 0) return null;
  return acc.totalBytes / acc.withSize;
}

function toSummaryArray<T extends StatsAccumulator>(
  map: Map<string, T>,
  keyName: "extension" | "folder" | "container",
  options: { includeSamples?: boolean; sampleLimit: number },
): Array<Record<string, unknown>> {
  const { includeSamples = false, sampleLimit } = options;
  const entries: Array<Record<string, unknown>> = [];
  for (const [key, acc] of map.entries()) {
    const base: Record<string, unknown> = {
      [keyName]: key,
      count: acc.count,
      knownSizes: acc.withSize,
      unknownSizes: acc.count - acc.withSize,
      totalBytes: acc.totalBytes,
      minBytes: acc.minBytes,
      maxBytes: acc.maxBytes,
      meanBytes: deriveMean(acc),
    };
    if (includeSamples && "samples" in acc && Array.isArray((acc as ExtensionAccumulator).samples)) {
      base.samples = (acc as ExtensionAccumulator).samples.slice(0, sampleLimit);
    }
    entries.push(base);
  }
  return entries;
}

function resolveHostFolder(path: string): string {
  const hashIndex = path.indexOf("#");
  const hostPart = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const lastSlash = hostPart.lastIndexOf("/");
  if (lastSlash <= 0) return hostPart.startsWith("/") ? "/" : hostPart || ".";
  return hostPart.slice(0, lastSlash);
}

function resolveContainerPath(path: string): string | null {
  const hashIndex = path.indexOf("#");
  if (hashIndex === -1) return null;
  return path.slice(0, hashIndex);
}

function extensionKey(path: string): { raw: string; normalised: string } {
  const raw = extractExtension(path);
  return { raw, normalised: raw.length > 0 ? raw : "(none)" };
}

function buildSearchPattern(root: string, extension?: string): string {
  const trimmed = root === "/" ? "/" : root.replace(/\/+$/, "");
  if (trimmed === "/") {
    return extension ? `/**/*.${extension}` : `/**/*`;
  }
  return extension ? `${trimmed}/**/*.${extension}` : `${trimmed}/**/*`;
}

export const tools: ToolDefinition[] = [
  {
    name: "find_paths_by_name",
    description: "Return device paths whose names contain a substring; supports simple extension filters and wildcard-aware firmware search.",
    summary: "Container-aware discovery wrapper using firmware file wildcard search.",
    inputSchema: findPathsByNameArgsSchema.jsonSchema,
    tags: ["files", "discover"],
    async execute(args, ctx) {
      try {
        const parsed = findPathsByNameArgsSchema.parse(args ?? {});
        const root = parsed.root ?? "/";
        const needle = parsed.caseInsensitive ? (parsed.nameContains as string).toLowerCase() : (parsed.nameContains as string);

        const exts = (parsed.extensions ?? []) as string[];
        const patterns: string[] = exts.length > 0
          ? exts.map((e) => `${root}/**/*${parsed.nameContains}*.${e}`)
          : [`${root}/**/*${parsed.nameContains}*`];

        const seen = new Set<string>();
        const results: string[] = [];
        for (const pattern of patterns) {
          const info = await (ctx.client as any).filesInfo(pattern);
          if (Array.isArray(info)) {
            for (const p of info) {
              if (typeof p !== "string") continue;
              const name = parsed.caseInsensitive ? p.toLowerCase() : p;
              if (name.includes(needle) && !seen.has(p)) {
                seen.add(p);
                results.push(p);
                if (results.length >= (parsed.maxResults ?? 50)) break;
              }
            }
          } else if (info && typeof info === "object" && Array.isArray((info as any).paths)) {
            for (const p of (info as any).paths) {
              if (typeof p !== "string") continue;
              const name = parsed.caseInsensitive ? p.toLowerCase() : p;
              if (name.includes(needle) && !seen.has(p)) {
                seen.add(p);
                results.push(p);
                if (results.length >= (parsed.maxResults ?? 50)) break;
              }
            }
          }
          if (results.length >= (parsed.maxResults ?? 50)) break;
        }
        return jsonResult({ root, pattern: parsed.nameContains, results }, { success: true, count: results.length });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
  {
    name: "filesystem_stats_by_extension",
    description: "Walk the filesystem (and container contents) under a root and compute counts plus size statistics grouped by extension.",
    summary: "Aggregates file counts/bytes per extension with folder and container rollups.",
    inputSchema: filesystemStatsArgsSchema.jsonSchema,
    tags: ["files", "discover", "stats"],
    async execute(args, ctx) {
      try {
        const parsed = filesystemStatsArgsSchema.parse(args ?? {});
        const root = parsed.root ?? "/";
        const extensionList = ((parsed.extensions ?? []) as string[]).map((ext) => ext.replace(/^\./, "").toLowerCase());
        const filterSet = new Set(extensionList);
        const filterApplied = filterSet.size > 0;
        const includeContainers = parsed.includeContainers !== false;
        const sampleLimit = parsed.maxSamplesPerExtension ?? 3;

        const patterns = (filterApplied ? Array.from(filterSet, (ext) => buildSearchPattern(root, ext)) : [buildSearchPattern(root)]);
        const uniquePatterns = Array.from(new Set(patterns));

        const collected = new Map<string, FileInfoEntry>();

        for (const pattern of uniquePatterns) {
          try {
            const info = await (ctx.client as any).filesInfo(pattern);
            const extracted = extractEntriesFromInfo(info);
            for (const entry of extracted) {
              const existing = collected.get(entry.path);
              if (!existing) {
                collected.set(entry.path, { ...entry });
              } else {
                if (existing.size === null && entry.size !== null) existing.size = entry.size;
                existing.isContainer = existing.isContainer || entry.isContainer;
              }
            }
          } catch (err) {
            ctx.logger.warn?.("filesInfo pattern failed", { pattern, error: err instanceof Error ? err.message : String(err) });
          }
        }

        const allEntries = Array.from(collected.values());
        const extensionMap = new Map<string, ExtensionAccumulator>();
        const folderMap = new Map<string, StatsAccumulator>();
        const containerMap = new Map<string, StatsAccumulator>();
        const overall = createStatsAccumulator();

        let insideContainerCount = 0;

        for (const entry of allEntries) {
          const { path, size, isContainer } = entry;
          const { raw: rawExtension, normalised: extensionName } = extensionKey(path);

          if (filterApplied && !filterSet.has(rawExtension)) continue;

          const isContainerHost = isContainer && !path.includes("#");
          if (isContainerHost && !includeContainers) continue;

          recordSize(overall, size);

          let extAcc = extensionMap.get(extensionName);
          if (!extAcc) {
            extAcc = createExtensionAccumulator();
            extensionMap.set(extensionName, extAcc);
          }
          recordExtension(extAcc, size, path, sampleLimit);

          const folderKey = resolveHostFolder(path);
          let folderAcc = folderMap.get(folderKey);
          if (!folderAcc) {
            folderAcc = createStatsAccumulator();
            folderMap.set(folderKey, folderAcc);
          }
          recordSize(folderAcc, size);

          const containerPath = resolveContainerPath(path);
          if (containerPath) {
            insideContainerCount += 1;
            let containerAcc = containerMap.get(containerPath);
            if (!containerAcc) {
              containerAcc = createStatsAccumulator();
              containerMap.set(containerPath, containerAcc);
            }
            recordSize(containerAcc, size);
          }
        }

        const extensionStats = toSummaryArray(extensionMap, "extension", { includeSamples: true, sampleLimit });
        extensionStats.sort((a, b) => {
          const bytesA = (a.totalBytes as number) ?? 0;
          const bytesB = (b.totalBytes as number) ?? 0;
          if (bytesA !== bytesB) return bytesB - bytesA;
          return (b.count as number) - (a.count as number);
        });

        const folderSummaries = toSummaryArray(folderMap, "folder", { includeSamples: false, sampleLimit });
        folderSummaries.sort((a, b) => String(a.folder).localeCompare(String(b.folder)));

        const containerSummaries = toSummaryArray(containerMap, "container", { includeSamples: false, sampleLimit });
        containerSummaries.sort((a, b) => String(a.container).localeCompare(String(b.container)));

        const resultData = {
          root,
          patterns: uniquePatterns,
          totals: {
            files: overall.count,
            knownSizes: overall.withSize,
            unknownSizes: overall.count - overall.withSize,
            totalBytes: overall.totalBytes,
            minBytes: overall.minBytes,
            maxBytes: overall.maxBytes,
            meanBytes: deriveMean(overall),
          },
          extensions: extensionStats,
          folders: folderSummaries,
          containers: containerSummaries,
          insideContainerEntries: insideContainerCount,
        };

        return jsonResult(resultData, {
          success: true,
          files: overall.count,
          extensions: extensionStats.length,
          containers: containerSummaries.length,
          filterApplied,
        });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
    {
      name: "find_and_run_program_by_name",
      description: "Search under a root for the first PRG/CRT whose name contains a substring and run it.",
      summary: "Finds and executes programs by name, recording recent searches for quick replay.",
      inputSchema: findAndRunProgramArgsSchema.jsonSchema,
      tags: ["files", "discover", "programs"],
      examples: [
        {
          name: "Run game",
          description: "Find the first GALAGA program under /USB0 and run it",
          arguments: { root: "/USB0", nameContains: "galaga", sort: "alphabetical" },
        },
      ],
      async execute(args, ctx) {
        try {
          const parsed = findAndRunProgramArgsSchema.parse(args ?? {});
          const root = parsed.root ?? "/";
          const caseInsensitive = parsed.caseInsensitive !== false;
          const extensions = ((parsed.extensions && parsed.extensions.length > 0) ? parsed.extensions : ["prg", "crt"]) as string[];
          const needle = caseInsensitive ? (parsed.nameContains as string).toLowerCase() : parsed.nameContains as string;
          const seen = new Set<string>();
          const candidates: string[] = [];

          for (const ext of extensions) {
            const pattern = `${root}/**/*${needle}*.${ext}`;
            try {
              const info = await (ctx.client as any).filesInfo(pattern);
              const paths = extractPaths(info);
              for (const raw of paths) {
                if (typeof raw !== "string" || raw.length === 0) continue;
                const normalised = normalisePath(raw, caseInsensitive);
                if (!normalised.includes(needle)) continue;
                if (seen.has(raw)) continue;
                const extCandidate = extractExtension(raw);
                if (extensions.length > 0 && !extensions.some((e) => e.toLowerCase() === extCandidate)) continue;
                seen.add(raw);
                candidates.push(raw);
              }
            } catch (err) {
              ctx.logger.warn?.("filesInfo pattern failed", { pattern, error: err instanceof Error ? err.message : String(err) });
            }
          }

          if (candidates.length === 0) {
            throw new ToolExecutionError("No matching program found", { details: { root, pattern: parsed.nameContains, extensions } });
          }

          if ((parsed.sort ?? "discovered") === "alphabetical") {
            const collator = caseInsensitive ? CASE_INSENSITIVE_COLLATOR : CASE_SENSITIVE_COLLATOR;
            candidates.sort((a, b) => collator.compare(a, b));
          }

          const matchedPath = candidates[0];
          const extension = extractExtension(matchedPath);
          let result: { success: boolean; details?: unknown };
          if (extension === "crt") {
            result = await (ctx.client as any).runCrtFile(matchedPath);
          } else if (extension === "prg") {
            result = await (ctx.client as any).runPrgFile(matchedPath);
          } else {
            throw new ToolExecutionError("Unsupported program extension", { details: { matchedPath, extension } });
          }

          if (!result?.success) {
            throw new ToolExecutionError("Firmware failed to run program", { details: { matchedPath, extension, response: result?.details } });
          }

          const limit = Math.min(parsed.captureCandidates ?? 10, candidates.length);
          const topCandidates = candidates.slice(0, limit);

          const stateDir = resolvePath(joinPath(getTasksHomeDir(), "meta"));
          const statePath = resolvePath(joinPath(stateDir, "find_and_run_program_by_name.json"));
          const entry: FindRunStateEntry = {
            root,
            pattern: parsed.nameContains as string,
            extensions,
            matched: matchedPath,
            timestamp: formatTimestampSpec(),
          };
          try {
            await persistState(statePath, entry, matchedPath);
          } catch (stateError) {
            ctx.logger.warn?.("Failed to persist find/run state", { error: stateError instanceof Error ? stateError.message : String(stateError) });
          }

          if ((parsed.waitMs ?? 0) > 0) {
            await new Promise((resolve) => setTimeout(resolve, parsed.waitMs ?? 0));
          }

          return jsonResult({
            root,
            pattern: parsed.nameContains,
            matchedPath,
            extension,
            candidates: topCandidates,
            statePath,
          }, { success: true });
        } catch (error) {
          if (error instanceof ToolError) return toolErrorResult(error);
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "drive_mount_and_verify",
      description: "Mount a disk image with retry logic and verification. Powers on drive if needed, mounts image, resets drive, and verifies state.",
      summary: "Reliably mount and verify disk images with retry logic.",
      inputSchema: objectSchema({
        description: "Mount image with optional retries and verification.",
        properties: {
          drive: stringSchema({ description: "Drive identifier (e.g., drive8)", minLength: 1 }),
          imagePath: stringSchema({ description: "Path to disk image on host filesystem", minLength: 1 }),
          mode: optionalSchema(stringSchema({ description: "Drive mode (1541/1571/1581)", enum: ["1541", "1571", "1581"] })),
          powerOnIfNeeded: optionalSchema(booleanSchema({ description: "Power on drive if off", default: true }), true),
          resetAfterMount: optionalSchema(booleanSchema({ description: "Reset drive after mounting", default: true }), true),
          maxRetries: optionalSchema(numberSchema({ description: "Maximum mount retry attempts", integer: true, minimum: 0, maximum: 5, default: 2 }), 2),
          retryDelayMs: optionalSchema(numberSchema({ description: "Delay between retries in milliseconds", integer: true, minimum: 0, maximum: 5000, default: 500 }), 500),
          verifyMount: optionalSchema(booleanSchema({ description: "Verify mount by checking drive list", default: true }), true),
        },
        required: ["drive", "imagePath"],
        additionalProperties: false,
      }).jsonSchema,
      tags: ["storage", "drives", "mount"],
      examples: [
        {
          name: "Mount with defaults",
          description: "Mount image with power-on and verification",
          arguments: { drive: "drive8", imagePath: "/media/games/test.d64" },
        },
        {
          name: "Mount with mode",
          description: "Mount 1581 image with specified mode",
          arguments: { drive: "drive8", imagePath: "/media/work.d81", mode: "1581" },
        },
      ],
      async execute(args, ctx) {
        try {
          const parsed = objectSchema({
            description: "Mount image with optional retries and verification.",
            properties: {
              drive: stringSchema({ description: "Drive identifier", minLength: 1 }),
              imagePath: stringSchema({ description: "Image path", minLength: 1 }),
              mode: optionalSchema(stringSchema({ description: "Drive mode", enum: ["1541", "1571", "1581"] })),
              powerOnIfNeeded: optionalSchema(booleanSchema({ description: "Power on if needed", default: true }), true),
              resetAfterMount: optionalSchema(booleanSchema({ description: "Reset after mount", default: true }), true),
              maxRetries: optionalSchema(numberSchema({ description: "Max retries", integer: true, minimum: 0, maximum: 5, default: 2 }), 2),
              retryDelayMs: optionalSchema(numberSchema({ description: "Retry delay ms", integer: true, minimum: 0, maximum: 5000, default: 500 }), 500),
              verifyMount: optionalSchema(booleanSchema({ description: "Verify mount", default: true }), true),
            },
            required: ["drive", "imagePath"],
            additionalProperties: false,
          }).parse(args ?? {});

          const drive = String(parsed.drive);
          const imagePath = String(parsed.imagePath);
          const mode = parsed.mode as string | undefined;
          const powerOnIfNeeded = parsed.powerOnIfNeeded !== false;
          const resetAfterMount = parsed.resetAfterMount !== false;
          const maxRetries = Math.max(0, parsed.maxRetries ?? 2);
          const retryDelayMs = Math.max(0, parsed.retryDelayMs ?? 500);
          const verifyMount = parsed.verifyMount !== false;

          const log: Array<{ step: string; success: boolean; details?: unknown; error?: string }> = [];

          // Step 1: Check if drive exists and power it on if needed
          if (powerOnIfNeeded) {
            try {
              const drives = await (ctx.client as any).drivesList();
              const targetDrive = Array.isArray(drives) ? findListedDrive(drives, drive) : null;
              
              if (!targetDrive) {
                log.push({ step: "check_drive_exists", success: false, error: `Drive ${drive} not found` });
                throw new ToolExecutionError(`Drive ${drive} not found in firmware drive list`, { details: { drive } });
              }

              if (targetDrive.power === "off" || targetDrive.power === "OFF") {
                const powerOn = await (ctx.client as any).driveOn(drive);
                log.push({ step: "power_on", success: powerOn.success === true, details: powerOn.details });
                if (!powerOn.success) {
                  throw new ToolExecutionError(`Failed to power on drive ${drive}`, { details: powerOn.details });
                }
                // Small delay after power on
                await new Promise((resolve) => setTimeout(resolve, 200));
              } else {
                log.push({ step: "check_power", success: true, details: { power: targetDrive.power } });
              }
            } catch (error) {
              if (error instanceof ToolError) throw error;
              log.push({ step: "power_check", success: false, error: error instanceof Error ? error.message : String(error) });
              throw new ToolExecutionError("Failed to check or power on drive", { details: { error: error instanceof Error ? error.message : String(error) } });
            }
          }

          // Step 2: Switch the drive emulation mode. The mount's own "mode"
          // option is the read/write attachment mode, not the drive type.
          if (mode) {
            const setMode = await (ctx.client as any).driveSetMode(drive, mode);
            log.push({ step: "set_mode", success: setMode.success === true, details: setMode.details });
            if (!setMode.success) {
              throw new ToolExecutionError(`Failed to set drive ${drive} to ${mode} mode`, { details: setMode.details });
            }
          }

          // Step 3: Mount with retries
          let mountSuccess = false;
          let lastMountError: unknown = null;
          let attempts = 0;

          for (let attempt = 0; attempt <= maxRetries && !mountSuccess; attempt += 1) {
            attempts = attempt + 1;
            try {
              const mount = await (ctx.client as any).driveMount(drive, imagePath);
              if (mount.success) {
                mountSuccess = true;
                log.push({ step: `mount_attempt_${attempts}`, success: true, details: mount.details });
              } else {
                lastMountError = mount.details;
                log.push({ step: `mount_attempt_${attempts}`, success: false, details: mount.details });
                if (attempt < maxRetries) {
                  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                }
              }
            } catch (error) {
              lastMountError = error;
              log.push({ 
                step: `mount_attempt_${attempts}`, 
                success: false, 
                error: error instanceof Error ? error.message : String(error) 
              });
              if (attempt < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
              }
            }
          }

          if (!mountSuccess) {
            throw new ToolExecutionError(`Failed to mount ${imagePath} after ${attempts} attempts`, { 
              details: { lastError: lastMountError } 
            });
          }

          // Step 4: Reset drive if requested
          if (resetAfterMount) {
            try {
              const reset = await (ctx.client as any).driveReset(drive);
              log.push({ step: "reset", success: reset.success === true, details: reset.details });
              if (!reset.success) {
                ctx.logger.warn?.("Drive reset failed after mount", { details: reset.details });
              }
            } catch (error) {
              log.push({ 
                step: "reset", 
                success: false, 
                error: error instanceof Error ? error.message : String(error) 
              });
              ctx.logger.warn?.("Drive reset threw error", { error });
            }
          }

          // Step 5: Verify mount
          let verificationResult: any = null;
          if (verifyMount) {
            try {
              const drives = await (ctx.client as any).drivesList();
              const targetDrive = Array.isArray(drives) ? findListedDrive(drives, drive) : null;
              
              if (!targetDrive) {
                log.push({ step: "verify", success: false, error: "Drive not found in list" });
                throw new ToolExecutionError("Drive disappeared after mount", { details: { drive } });
              }

              const imageMatches = targetDrive.image === imagePath || 
                                  (typeof targetDrive.image === "string" && targetDrive.image.endsWith(imagePath));
              
              verificationResult = {
                drive: targetDrive.id,
                power: targetDrive.power,
                image: targetDrive.image,
                imageMatches,
              };
              
              log.push({ step: "verify", success: imageMatches, details: verificationResult });
              
              if (!imageMatches) {
                ctx.logger.warn?.("Mount verification: image path mismatch", { 
                  expected: imagePath, 
                  actual: targetDrive.image 
                });
              }
            } catch (error) {
              if (error instanceof ToolError) throw error;
              log.push({ 
                step: "verify", 
                success: false, 
                error: error instanceof Error ? error.message : String(error) 
              });
              throw new ToolExecutionError("Failed to verify mount", { 
                details: { error: error instanceof Error ? error.message : String(error) } 
              });
            }
          }

          return jsonResult({
            mounted: true,
            drive,
            imagePath,
            mode,
            attempts,
            verification: verificationResult,
            log,
          }, { success: true });

        } catch (error) {
          if (error instanceof ToolError) return toolErrorResult(error);
          return unknownErrorResult(error);
        }
      },
    },
  ];
