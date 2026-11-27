/**
 * Arguments, confined host input and output, engines and error mapping shared by the SIDWave operations of
 * `c64_sound`.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import YAML from "yaml";
import { classifyError, convert, parseSidwave, SIDWAVE_ASSEMBLERS, SIDWAVE_SYMBOL_FORMATS, MUSIC_STYLES, type ConvertResult, type SidwaveReadOptions } from "sidwave";
import { createLibsidplayfpEngine, type SidEmulation, type SidEngine, type TraceRequest, type RenderRequest } from "sidwave/engine";
import { detectFormat, findFormat, formatDefinitions, type FormatDefinition } from "sidwave/export";
import { formatSidwave } from "sidwave/format";
import { SidwaveTransformError } from "sidwave/transform";
import { defaultHostOutputDir, readHostFile, resolveHostChildPath, resolveHostPath } from "../hostPaths.js";
import { hostSidwaveReadOptions, hostSidwaveReadOptionsFor } from "../sidwaveHost.js";
import { getPlatformStatus } from "../platform.js";
import { NOTE_PATTERN, resolveSidSystem } from "./audio.js";
import { cancelledResult, type ToolExecutionContext, type ToolRunResult } from "./types.js";
import {
  arraySchema, booleanSchema, literalSchema, numberSchema, objectSchema, optionalSchema, stringSchema, type Schema,
} from "./schema.js";
import { ToolError, ToolExecutionError, ToolValidationError, toolErrorResult } from "./errors.js";
import { jsonResult } from "./responses.js";
import type { ToolEffect } from "./access.js";
import type { GroupedOperationConfig } from "./registry/utils.js";

// Argument values after schema parsing; every property is optional unless the operation lists it as required.
export type Args = {
  sidwave?: string | Record<string, unknown>; inputPath?: string; comparePath?: string; outputPath?: string; outputDir?: string;
  overwrite?: boolean; includeScore?: boolean; configure?: boolean; from?: string; to?: string; strict?: boolean; verify?: boolean; song?: number;
  voices?: number; system?: "PAL" | "NTSC"; model?: "6581" | "8580"; durationSeconds?: number; loop?: boolean;
  output?: "prg" | "sid" | "game"; origin?: number; dataOrigin?: number; zeroPage?: number; symbols?: readonly string[]; assembler?: string; relocation?: boolean; maxCycles?: number;
  name?: string; licence?: string; author?: string; fields?: Record<string, unknown>; durations?: string; includeOriginal?: boolean; rightsPermitted?: boolean;
  forDevice?: boolean; action?: string; semitones?: number; bpm?: number; factor?: number; order?: readonly string[];
  grid?: number; seed?: number; maxShift?: number; scope?: { voices?: string[]; sections?: string[] }; sids?: number;
  budgetCycles?: number; budgetBytes?: number; allowChanges?: boolean; level?: "T0" | "T1" | "A0" | "A1"; ladder?: boolean;
  songlengthsPath?: string; stilPath?: string; hvscDir?: string; hvscPath?: string; sidIdPath?: string; style?: string;
  profile?: string; root?: string; cycleBudget?: number; bars?: number; voice?: number; target?: number; bass?: number;
  drums?: number; section?: string; after?: string; at?: number; harmony?: "arp" | "line"; instrument?: string;
};
export type ArgName = keyof Args;

const text = (extra: { enum?: readonly string[]; description?: string; pattern?: RegExp } = {}) => optionalSchema(stringSchema({ minLength: 1, ...extra }));
const flag = (description?: string) => optionalSchema(booleanSchema(description ? { description } : {}));
const int = (minimum: number, maximum?: number, description?: string) => optionalSchema(numberSchema({
  integer: true, minimum, ...(maximum === undefined ? {} : { maximum }), ...(description ? { description } : {}),
}));
const num = (description?: string) => optionalSchema(numberSchema(description ? { description } : {}));

const scoreSchema: Schema<string | Record<string, unknown> | undefined> = {
  jsonSchema: { description: "Inline score (text or object).", type: ["string", "object"] },
  parse(value, path) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    throw new ToolValidationError("Expected SIDWAVE string or object", { path: path ?? "$" });
  },
};

export const PROPERTIES: { [K in ArgName]-?: Schema<unknown> } = {
  sidwave: scoreSchema,
  inputPath: text({ description: "Host input file." }),
  comparePath: text({ description: "Second file." }),
  outputPath: text(),
  outputDir: text(),
  overwrite: flag("Replace existing files."),
  includeScore: flag(),
  configure: flag("Set up SID playback."),
  from: text(),
  to: text(),
  strict: flag("Write nothing if content is lost."),
  verify: flag(),
  song: int(0, 256),
  voices: int(1, 24),
  system: text({ enum: ["PAL", "NTSC"] }),
  model: text({ enum: ["6581", "8580"] }),
  durationSeconds: optionalSchema(numberSchema({ minimum: 0.5, maximum: 600 })),
  loop: flag(),
  output: text({ enum: ["prg", "sid", "game"] }),
  origin: int(0, 0xffff, "Game build address."),
  dataOrigin: int(0, 0xffff),
  zeroPage: int(2, 0xfb),
  symbols: optionalSchema(arraySchema(stringSchema({ enum: [...SIDWAVE_SYMBOL_FORMATS] }))),
  assembler: text({ enum: [...SIDWAVE_ASSEMBLERS], description: "Also write a source include." }),
  relocation: flag("Also write a relocation table."),
  maxCycles: int(1, undefined, "Limit per play call."),
  name: text(),
  licence: text(),
  author: text(),
  fields: optionalSchema(objectSchema({ properties: {}, additionalProperties: true })),
  durations: text(),
  includeOriginal: flag(),
  rightsPermitted: flag("You may redistribute the original."),
  forDevice: flag("Use the machine's clock and SID model, not its SID count."),
  action: text(),
  semitones: int(-96, 96),
  bpm: num(),
  factor: num(),
  order: optionalSchema(arraySchema(stringSchema({ minLength: 1 }), { minItems: 1 })),
  grid: num("Beats."),
  seed: int(0, 0xffffffff, "Random seed (compose: 65)."),
  maxShift: num(),
  scope: optionalSchema(objectSchema({
    properties: {
      voices: optionalSchema(arraySchema(stringSchema({ minLength: 1 }))),
      sections: optionalSchema(arraySchema(stringSchema({ minLength: 1 }))),
    },
  })),
  sids: int(1, 8),
  budgetCycles: int(1),
  budgetBytes: int(1),
  allowChanges: flag("Allow lossy steps."),
  level: text({ enum: ["T0", "T1", "A0", "A1"] }),
  ladder: flag(),
  songlengthsPath: text(),
  stilPath: text(),
  hvscDir: text(),
  hvscPath: text(),
  sidIdPath: text({ description: "sidid.cfg" }),
  style: optionalSchema(stringSchema({ enum: Object.keys(MUSIC_STYLES), default: "chiptune" }), "chiptune"),
  profile: text({ description: "e.g. funk-vc-dorian" }),
  root: text({ pattern: NOTE_PATTERN, description: "Tonic and lead register." }),
  cycleBudget: int(1),
  bars: int(1, 1024),
  voice: int(1, 24),
  target: int(1, 24),
  bass: int(1, 24),
  drums: int(1, 24),
  section: text(),
  after: text(),
  at: int(1),
  harmony: text({ enum: ["arp", "line"] }),
  instrument: text(),
};

/* ------------------------------------------------------------------------------------------------ host input/output */

export interface Input { bytes: Buffer; name: string; stem: string; file?: string; read: SidwaveReadOptions }

/** The input of an operation: the host file `inputPath`, or the inline score `sidwave`. Exactly one is required. */
export async function readInput(args: Args): Promise<Input> {
  if ((args.inputPath === undefined) === (args.sidwave === undefined)) {
    throw new ToolValidationError("Provide exactly one of inputPath and sidwave", { path: "$.inputPath" });
  }
  if (args.inputPath === undefined) {
    const source = typeof args.sidwave === "string" ? args.sidwave : JSON.stringify(args.sidwave);
    return { bytes: Buffer.from(source, "utf8"), name: "score.yaml", stem: "score", read: hostSidwaveReadOptionsFor() };
  }
  return readFileInput(args.inputPath);
}

export async function readFileInput(inputPath: string): Promise<Input> {
  const file = resolveHostPath(inputPath, { purpose: "read" });
  let bytes: Buffer;
  try {
    bytes = await readHostFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ToolValidationError(`Host file not found: ${file}`, { path: file });
    throw error;
  }
  const name = basename(file);
  const stem = basename(name, extname(name)).replace(/\.sidwave$/i, "");
  // Libraries of a score's `imports` are resolved next to the score and may not leave its directory.
  return { bytes, name, stem, file, read: hostSidwaveReadOptionsFor(file) };
}

export const scoreText = (input: Input) => input.bytes.toString("utf8");
export const parseScore = (input: Input) => parseSidwave(scoreText(input), input.read);
export const isSid = (bytes: Uint8Array) => bytes.length >= 4 && /^[PR]SID$/.test(String.fromCharCode(...bytes.subarray(0, 4)));

export interface Artifact { outputPath: string; bytes: number; sha256: string }

export const existsError = (path: string, argument: string) =>
  new ToolValidationError(`${path} exists; pass overwrite: true to replace it`, { path: argument });

/**
 * Resolves and checks an output file before any long work starts. Without `outputPath` the file gets a new name in
 * `directory`, by default the artifacts directory. An existing file is replaced only with `overwrite`.
 */
export function planOutput(args: Args, defaultStem: string, extension: string, protect: readonly (string | undefined)[] = [], directory?: string) {
  const path = args.outputPath !== undefined
    ? resolveHostPath(args.outputPath, { purpose: "write" })
    : resolveHostChildPath(directory ?? defaultHostOutputDir("artifacts", "sidwave"), `${defaultStem}-${randomUUID().slice(0, 8)}${extension}`);
  if (protect.includes(path)) throw new ToolValidationError(`The output file is an input file: ${path}`, { path: "$.outputPath" });
  if (args.overwrite !== true && existsSync(path)) throw existsError(path, "$.outputPath");
  return { path, write: (content: Uint8Array | string, ctx: ToolExecutionContext) => writeArtifact(path, content, args.overwrite === true, ctx) };
}

export async function writeArtifact(path: string, content: Uint8Array | string, overwrite: boolean, ctx: ToolExecutionContext): Promise<Artifact> {
  await cancellationPoint(ctx);
  return storeArtifact(path, content, overwrite);
}

/**
 * Writes a set of files that belong together. A cancellation stops the call before the first file; after that the set
 * is completed. A function as content is evaluated when its file is written.
 */
export async function writeArtifacts(
  files: ReadonlyArray<{ path: string; content: Uint8Array | string | (() => Uint8Array) }>, overwrite: boolean, ctx: ToolExecutionContext,
): Promise<Artifact[]> {
  await cancellationPoint(ctx);
  const written: Artifact[] = [];
  for (const { path, content } of files) written.push(await storeArtifact(path, typeof content === "function" ? content() : content, overwrite));
  return written;
}

/** A replaced file is written next to the target and renamed over it, so it never holds a part of the new content. */
async function replaceFile(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.c64bridge-${randomUUID()}.tmp`);
  const previous = await stat(path).catch(() => undefined);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    if (previous) await chmod(temporary, previous.mode & 0o777);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function storeArtifact(path: string, content: Uint8Array | string, overwrite: boolean): Promise<Artifact> {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  await mkdir(dirname(path), { recursive: true });
  if (overwrite) {
    await replaceFile(path, bytes);
  } else {
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw existsError(path, "$.outputPath");
      throw error;
    }
  }
  return { outputPath: path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Writes a score produced by an operation and returns the artifact, with the text when `includeScore` is set. A score
 * with `imports` is written next to its input file by default, because the library paths are relative to the score.
 */
export async function writeScore(args: Args, input: Pick<Input, "stem" | "file">, suffix: string, score: string, ctx: ToolExecutionContext) {
  const directory = input.file !== undefined && record(YAML.parse(score)).imports !== undefined ? dirname(input.file) : undefined;
  const artifact = await planOutput(args, `${input.stem}-${suffix}`, ".sidwave.yaml", [], directory).write(score, ctx);
  return { ...artifact, ...(args.includeScore ? { sidwave: score } : {}) };
}

export const documentText = (score: unknown) => formatSidwave(YAML.stringify(score));

/**
 * Runs before anything is written: reads a cancellation that arrived while synchronous library work blocked the event
 * loop. That work itself runs to its end.
 */
async function cancellationPoint(ctx: ToolExecutionContext): Promise<void> {
  if (!ctx.signal) return;
  // The timer starts a new turn of the event loop, whose input phase runs before the immediate.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setImmediate(resolve));
  ctx.signal.throwIfAborted();
}

/* ------------------------------------------------------------------------------------------------ approximations */

const RECOVERED = "Experimental recovery from register writes: an approximate score with a verdict.";
/**
 * Importers that read a file only in part, beyond the losses they count. The library itself marks only the formats it
 * recovers from register writes.
 */
const PARTIAL_IMPORTS: Readonly<Record<string, string>> = {
  abc: "ABC import is approximate: ornaments, chord symbols and voice overlays are omitted.",
  jch: "JCH import is approximate: the filter, most commands and per-voice looping are not imported.",
  sf2: "SID Factory II import (driver 11) is approximate: playback differs from the original driver.",
  cheesecutter: "CheeseCutter import is approximate: playback differs from the original player.",
};

/** Formats whose export embeds a driver file of the user, for which no operation has an argument. */
export const DRIVER_EXPORTS: ReadonlySet<string> = new Set(["sf2", "cheesecutter"]);

/** The label of a conversion that is approximate by nature, by its source format. */
export function approximation(from: string): { approximate?: true; approximateNote?: string } {
  const note = PARTIAL_IMPORTS[from] ?? (findFormat(from)?.readIsApproximate ? RECOVERED : undefined);
  return note === undefined ? {} : { approximate: true, approximateNote: note };
}

/* ------------------------------------------------------------------------------------------------ engine and device */

/**
 * libsidplayfp engines bound to the call: every render and trace gets the cancellation signal and reports progress as
 * 100 units per engine pass.
 */
export function engineFactory(ctx: ToolExecutionContext): (emulation: SidEmulation) => SidEngine {
  let passes = 0;
  let reported = -1;
  const control = <T extends RenderRequest | TraceRequest>(request: T, emulation: SidEmulation): T => {
    const pass = passes++;
    return {
      ...request,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onProgress: (fraction: number) => {
        const completed = pass * 100 + Math.floor(fraction * 20) * 5;
        if (completed > reported) {
          reported = completed;
          ctx.reportProgress?.(completed, undefined, `${emulation} pass ${pass + 1}`);
        }
        request.onProgress?.(fraction);
      },
    };
  };
  return (emulation) => {
    // The engine is an optional peer of sidwave that c64bridge installs, so it is resolved from here.
    const engine = createLibsidplayfpEngine({ emulation, importModule: () => import("libsidplayfp-wasm") });
    return {
      id: engine.id,
      get version() { return engine.version; },
      render: (request) => engine.render(control(request, emulation)),
      trace: (request) => engine.trace(control(request, emulation)),
    };
  };
}

export const backendOf = (ctx: ToolExecutionContext) => ctx.platform?.id ?? getPlatformStatus().id;
export const record = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : {});

/**
 * Model of the SID at $D400 on Ultimate hardware, when a fitted socket chip is the only decoder mapped there.
 * An UltiSID at $D400 has no single model, so the answer is undefined.
 */
async function primarySidModel(ctx: ToolExecutionContext): Promise<"6581" | "8580" | undefined> {
  const settings = async (category: string) => {
    const reply = record(await ctx.client.configGet(category));
    const values = record(reply[category] ?? reply);
    return (name: string) => String(record(values[name]).current ?? values[name] ?? "");
  };
  try {
    const address = await settings("SID Addressing");
    if ([1, 2].some((n) => address(`UltiSID ${n} Address`).toUpperCase() === "$D400")) return undefined;
    const sockets = await settings("SID Sockets Configuration");
    const models = [1, 2]
      .filter((n) => address(`SID Socket ${n} Address`).toUpperCase() === "$D400" && sockets(`SID Socket ${n}`) === "Enabled")
      .map((n) => sockets(`SID Detected Socket ${n}`).trim());
    return models.length === 1 && (models[0] === "6581" || models[0] === "8580") ? models[0] : undefined;
  } catch {
    return undefined;
  }
}

export async function deviceFacts(ctx: ToolExecutionContext) {
  const backend = backendOf(ctx);
  const { system, source } = await resolveSidSystem(ctx, undefined);
  const model = backend === "vice" ? undefined : await primarySidModel(ctx);
  return { backend, system, systemSource: source, ...(model ? { sidModel: model } : {}) };
}

/* ------------------------------------------------------------------------------------------------ operations */

/**
 * The input format of an operation: `from` when given, SIDWave for an inline score, else detected from the content and
 * the file name. A PRG has no header, so its extension decides.
 */
export function detectInput(input: Input, from?: string): { format: FormatDefinition; by: string; confidence: number; warnings: string[] } {
  const readable = formatDefinitions().filter((format) => format.read !== undefined).map((format) => format.id).concat("prg");
  const chosen = (id: string, by: string, confidence: number, warnings: string[] = []) => {
    const format = findFormat(id)!;
    if (!readable.includes(format.id)) {
      throw new ToolValidationError(`${input.name} is ${format.name}, which can be written but not read`, { path: "$.inputPath", details: { allowed: readable } });
    }
    return { format, by, confidence, warnings };
  };
  if (from !== undefined) {
    if (!findFormat(from)) throw new ToolValidationError(`Unknown format "${from}"`, { path: "$.from", details: { allowed: readable } });
    return chosen(from, "from", 1);
  }
  if (input.file === undefined) return chosen("sidwave", "inline score", 1);
  const detection = detectFormat(input.bytes, input.name);
  if (detection.best) return chosen(detection.best.id, detection.best.by, detection.best.confidence, detection.warnings);
  if (detection.candidates.length === 1 && detection.candidates[0]!.id === "prg") return chosen("prg", "extension", 0.5);
  const hint = /\.(d64|d71|d81|g64)$/i.test(input.name) ? " A disk image is mounted with c64_disk."
    : /\.crt$/i.test(input.name) ? " A cartridge starts with c64_program op run_crt." : "";
  const candidates = detection.candidates.map((candidate) => `${candidate.id} (${candidate.confidence})`).join(", ");
  throw new ToolValidationError(
    candidates ? `Cannot tell the format of ${input.name}; it could be ${candidates}. Pass from.${hint}`
      : `${input.name} is not a supported music file: neither its content nor its extension matches a format.${hint}`,
    { path: "$.inputPath", details: { allowed: readable } },
  );
}

/** The input of an operation as a SIDWave score; an input in another format is converted first. */
export async function scoreOf(input: Input, args: Args, ctx: ToolExecutionContext) {
  const { format } = detectInput(input, args.from);
  if (format.id === "sidwave") return { text: scoreText(input), document: parseScore(input), converted: undefined };
  if (format.read === undefined) throw new ToolValidationError(`${format.name} holds no score to read`, { path: "$.inputPath" });
  const converted = await convert(input.bytes, {
    inputName: input.name, to: "sidwave", from: format.id, song: args.song || undefined, seconds: args.durationSeconds,
    readOptions: input.read, createEngine: engineFactory(ctx), signal: ctx.signal,
  });
  ctx.signal?.throwIfAborted();
  const text = Buffer.from(converted.output).toString("utf8");
  return { text, document: parseSidwave(text, hostSidwaveReadOptions), converted };
}

/** Conversion losses, the worst first, cut to `limit` entries. */
export function lossReport(losses: ConvertResult["losses"], limit: number) {
  const rank = { lost: 0, approx: 1, info: 2 };
  const shown = capped([...losses].sort((a, b) => rank[a.severity] - rank[b.severity]), limit);
  return { losses: shown.items, omitted: shown.omitted, total: losses.length };
}

export const capped = <T>(items: readonly T[], limit: number) => (items.length > limit
  ? { items: items.slice(0, limit), omitted: items.length - limit }
  : { items, omitted: 0 });

type Run = (args: Args, ctx: ToolExecutionContext) => Promise<Record<string, unknown>>;

export function required(args: Args, name: ArgName): NonNullable<Args[ArgName]> {
  const value = args[name];
  if (value === undefined) throw new ToolValidationError(`Missing required property for this operation or action`, { path: `$.${name}` });
  return value;
}

export function failure(ctx: ToolExecutionContext, error: unknown): ToolRunResult {
  if (ctx.signal?.aborted) return cancelledResult();
  if (error instanceof ToolError) return toolErrorResult(error);
  if (error instanceof SidwaveTransformError) {
    return toolErrorResult(new ToolValidationError(error.message, { details: { code: error.code } }));
  }
  const { category, message, details } = classifyError(error);
  if (category === "aborted") return cancelledResult();
  if (category === "usage" || category === "input" || category === "validation") {
    return toolErrorResult(new ToolValidationError(message, { path: typeof details.path === "string" ? details.path : undefined, details }));
  }
  return toolErrorResult(new ToolExecutionError(message, { code: category, details }));
}

export interface Definition { op: string; effect: ToolEffect; description: string; required?: ArgName[]; optional?: ArgName[]; run: Run }

export const SCORE: ArgName[] = ["sidwave", "inputPath"];
export const SCORE_OUT: ArgName[] = [...SCORE, "outputPath", "overwrite", "includeScore"];

export function operation({ op, description, required: requiredNames = [], optional = [], run }: Definition): GroupedOperationConfig {
  const properties: Record<string, Schema<unknown>> = { op: literalSchema(op) };
  for (const name of [...requiredNames, ...optional]) properties[name] = PROPERTIES[name];
  const schema = objectSchema<Record<string, unknown>>({
    description,
    properties,
    required: ["op", ...requiredNames],
  });
  return {
    op,
    schema: schema.jsonSchema,
    handler: async (rawArgs, ctx) => {
      try {
        const args = schema.parse(rawArgs) as Args;
        if (ctx.signal?.aborted) return cancelledResult();
        const data = await run(args, ctx);
        return jsonResult(data, { success: true });
      } catch (error) {
        return failure(ctx, error);
      }
    },
  };
}
