/**
 * Offline SIDWave operations of `c64_sound`. Each operation reads confined host input, calls one library function of
 * the `sidwave` package, writes its artifacts and returns a compact summary. Playback stays with the existing
 * `compile_play`, `pipeline` and program operations.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import YAML from "yaml";
import {
  classifyError, compileSidwaveBytes, compileSidwave, completeScore, convert, describeSidwave,
  generateSidwave, hvscDatabases, hvscPathOf, identifySidPlayer, lintSidwave, parseSidFile, parseSidIdConfig,
  parseSidwave, parseSonglengths, parseStil, PROFILES, queryStil, SIDWAVE_SYMBOL_FORMATS, sidInfo, validationFailure,
  DEFAULT_MUSIC_SEED, MUSIC_STYLES, type MusicStyle, type SidwaveReadOptions, type SidwaveSymbolFormat,
} from "sidwave";
import { analyzeScore, analyzeSid, compare } from "sidwave/analyze";
import { createLibsidplayfpEngine, type SidEmulation, type SidEngine, type TraceRequest, type RenderRequest } from "sidwave/engine";
import {
  ambiguityMessage, detectFormat, findFormat, formatDefinitions, listFormats, parseSiddump, parseViceDump,
  reconstructFromTrace, resolveTarget,
} from "sidwave/export";
import { formatSidwave } from "sidwave/format";
import { reconstructSid } from "sidwave/reconstruct";
import { retargetSidwave } from "sidwave/retarget";
import {
  humanise, quantise, restructure, scaleTempo, setTempo, SidwaveTransformError, substituteInstrument, transpose,
} from "sidwave/transform";
import { DEFAULT_MAX_READ_BYTES, defaultHostOutputDir, readHostFile, resolveHostChildPath, resolveHostPath } from "../hostPaths.js";
import { hostSidwaveImportResolver, hostSidwaveReadOptions } from "../sidwaveHost.js";
import { getPlatformStatus } from "../platform.js";
import { playbackSetupWarnings, resolveSidSystem } from "./audio.js";
import { cancelledResult, type ToolExecutionContext, type ToolRunResult } from "./types.js";
import {
  arraySchema, booleanSchema, literalSchema, numberSchema, objectSchema, optionalSchema, stringSchema, type Schema,
} from "./schema.js";
import { ToolError, ToolExecutionError, ToolValidationError, toolErrorResult } from "./errors.js";
import { jsonResult } from "./responses.js";
import type { ToolEffect } from "./access.js";
import type { GroupedOperationConfig } from "./registry/utils.js";

// Argument values after schema parsing; every property is optional unless the operation lists it as required.
type Args = {
  sidwave?: string | Record<string, unknown>; inputPath?: string; comparePath?: string; outputPath?: string; outputDir?: string;
  overwrite?: boolean; includeScore?: boolean; from?: string; to?: string; strict?: boolean; verify?: boolean; song?: number;
  voices?: number; system?: "PAL" | "NTSC"; model?: "6581" | "8580"; durationSeconds?: number; loop?: boolean;
  output?: "prg" | "sid" | "game"; origin?: number; dataOrigin?: number; zeroPage?: number; symbols?: readonly string[];
  forDevice?: boolean; action?: string; semitones?: number; bpm?: number; factor?: number; order?: readonly string[];
  grid?: number; seed?: number; maxShift?: number; scope?: { voices?: string[]; sections?: string[] }; sids?: number;
  budgetCycles?: number; budgetBytes?: number; allowChanges?: boolean; level?: "T0" | "T1" | "A0" | "A1"; ladder?: boolean;
  songlengthsPath?: string; stilPath?: string; hvscDir?: string; hvscPath?: string; sidIdPath?: string; style?: string;
  profile?: string; root?: string; cycleBudget?: number; bars?: number; voice?: number; target?: number; bass?: number;
  drums?: number; section?: string; after?: string; at?: number; harmony?: "arp" | "line"; instrument?: string;
};
type ArgName = keyof Args;

const text = (extra: { enum?: readonly string[]; description?: string } = {}) => optionalSchema(stringSchema({ minLength: 1, ...extra }));
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

const PROPERTIES: { [K in ArgName]-?: Schema<unknown> } = {
  sidwave: scoreSchema,
  inputPath: text({ description: "Host input file." }),
  comparePath: text({ description: "Second file." }),
  outputPath: text(),
  outputDir: text(),
  overwrite: flag("Replace existing files."),
  includeScore: flag(),
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
  forDevice: flag("Use the machine's clock and SID model."),
  action: text(),
  semitones: int(-96, 96),
  bpm: num(),
  factor: num(),
  order: optionalSchema(arraySchema(stringSchema({ minLength: 1 }), { minItems: 1 })),
  grid: num("Beats."),
  seed: int(0, 0xffffffff),
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
  style: text({ enum: Object.keys(MUSIC_STYLES) }),
  profile: text({ description: "e.g. funk-vc-dorian" }),
  root: text(),
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

interface Input { bytes: Buffer; name: string; stem: string; file?: string; read: SidwaveReadOptions }

/** The input of an operation: the host file `inputPath`, or the inline score `sidwave`. Exactly one is required. */
async function readInput(args: Args): Promise<Input> {
  if ((args.inputPath === undefined) === (args.sidwave === undefined)) {
    throw new ToolValidationError("Provide exactly one of inputPath and sidwave", { path: "$.inputPath" });
  }
  if (args.inputPath === undefined) {
    const source = typeof args.sidwave === "string" ? args.sidwave : JSON.stringify(args.sidwave);
    return { bytes: Buffer.from(source, "utf8"), name: "score.yaml", stem: "score", read: hostSidwaveReadOptions };
  }
  return readFileInput(args.inputPath);
}

async function readFileInput(inputPath: string): Promise<Input> {
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
  return { bytes, name, stem, file, read: { ...hostSidwaveReadOptions, imports: hostSidwaveImportResolver(file) } };
}

const scoreText = (input: Input) => input.bytes.toString("utf8");
const parseScore = (input: Input) => parseSidwave(scoreText(input), input.read);
const isSid = (bytes: Uint8Array) => bytes.length >= 4 && /^[PR]SID$/.test(String.fromCharCode(...bytes.subarray(0, 4)));

interface Artifact { outputPath: string; bytes: number; sha256: string }

const existsError = (path: string, argument: string) =>
  new ToolValidationError(`${path} exists; pass overwrite: true to replace it`, { path: argument });

/**
 * Resolves and checks an output file before any long work starts. Without `outputPath` the file gets a new name in
 * `directory`, by default the artifacts directory. An existing file is replaced only with `overwrite`.
 */
function planOutput(args: Args, defaultStem: string, extension: string, protect: readonly (string | undefined)[] = [], directory?: string) {
  const path = args.outputPath !== undefined
    ? resolveHostPath(args.outputPath, { purpose: "write" })
    : resolveHostChildPath(directory ?? defaultHostOutputDir("artifacts", "sidwave"), `${defaultStem}-${randomUUID().slice(0, 8)}${extension}`);
  if (protect.includes(path)) throw new ToolValidationError(`The output file is an input file: ${path}`, { path: "$.outputPath" });
  if (args.overwrite !== true && existsSync(path)) throw existsError(path, "$.outputPath");
  return { path, write: (content: Uint8Array | string, ctx: ToolExecutionContext) => writeArtifact(path, content, args.overwrite === true, ctx) };
}

async function writeArtifact(path: string, content: Uint8Array | string, overwrite: boolean, ctx: ToolExecutionContext): Promise<Artifact> {
  ctx.signal?.throwIfAborted();
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: overwrite ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw existsError(path, "$.outputPath");
    }
    throw error;
  }
  return { outputPath: path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Writes a score produced by an operation and returns the artifact, with the text when `includeScore` is set. A score
 * with `imports` is written next to its input file by default, because the library paths are relative to the score.
 */
async function writeScore(args: Args, input: Pick<Input, "stem" | "file">, suffix: string, score: string, ctx: ToolExecutionContext) {
  const directory = input.file !== undefined && record(YAML.parse(score)).imports !== undefined ? dirname(input.file) : undefined;
  const artifact = await planOutput(args, `${input.stem}-${suffix}`, ".sidwave.yaml", [], directory).write(score, ctx);
  return { ...artifact, ...(args.includeScore ? { sidwave: score } : {}) };
}

const documentText = (score: unknown) => formatSidwave(YAML.stringify(score));

/* ------------------------------------------------------------------------------------------------ engine and device */

/**
 * libsidplayfp engines bound to the call: every render and trace gets the cancellation signal and reports progress as
 * 100 units per engine pass.
 */
function engineFactory(ctx: ToolExecutionContext): (emulation: SidEmulation) => SidEngine {
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

const backendOf = (ctx: ToolExecutionContext) => ctx.platform?.id ?? getPlatformStatus().id;
const record = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : {});

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

async function deviceFacts(ctx: ToolExecutionContext) {
  const backend = backendOf(ctx);
  const { system, source } = await resolveSidSystem(ctx, undefined);
  const model = backend === "vice" ? undefined : await primarySidModel(ctx);
  return { backend, system, systemSource: source, ...(model ? { sidModel: model } : {}) };
}

/* ------------------------------------------------------------------------------------------------ summaries */

const capped = <T>(items: readonly T[], limit: number) => (items.length > limit
  ? { items: items.slice(0, limit), omitted: items.length - limit }
  : { items, omitted: 0 });

/** Register classes with differences, from a reconstruction or comparison F-diff. */
function fdiffSummary(diff: { equal: boolean; comparedCalls: number; differingCalls: number; classes: Record<string, { differingCalls: number; matchShare: number }>; first?: unknown }) {
  return {
    equal: diff.equal,
    comparedCalls: diff.comparedCalls,
    differingCalls: diff.differingCalls,
    differingClasses: Object.fromEntries(Object.entries(diff.classes)
      .filter(([, value]) => value.differingCalls > 0)
      .map(([name, value]) => [name, { differingCalls: value.differingCalls, matchShare: value.matchShare }])),
    ...(diff.first ? { first: diff.first } : {}),
  };
}

/* ------------------------------------------------------------------------------------------------ operations */

type Run = (args: Args, ctx: ToolExecutionContext) => Promise<Record<string, unknown>>;

function required(args: Args, name: ArgName): NonNullable<Args[ArgName]> {
  const value = args[name];
  if (value === undefined) throw new ToolValidationError(`Missing required property for this operation or action`, { path: `$.${name}` });
  return value;
}

function failure(ctx: ToolExecutionContext, error: unknown): ToolRunResult {
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

interface Definition { op: string; effect: ToolEffect; description: string; required?: ArgName[]; optional?: ArgName[]; run: Run }

const SCORE: ArgName[] = ["sidwave", "inputPath"];
const SCORE_OUT: ArgName[] = [...SCORE, "outputPath", "overwrite", "includeScore"];

const definitions: Definition[] = [
  {
    op: "formats", effect: "read", description: "List conversion formats.", optional: ["from"],
    run: async ({ from }) => {
      const all = listFormats();
      if (from === undefined) {
        return {
          formats: all.map((f) => ({ id: f.id, extensions: f.extensions, read: f.read ? (f.readApproximate ? "approximate" : "yes") : "no", write: f.write, losses: f.lossSummary })),
        };
      }
      const id = findFormat(from)?.id;
      const format = all.find((f) => f.id === id);
      if (!format) throw new ToolValidationError(`Unknown format "${from}"`, { path: "$.from", details: { allowed: all.map((f) => f.id) } });
      return { format };
    },
  },
  {
    op: "inspect", effect: "read", description: "Detect and describe a music file.", optional: [...SCORE, "from"],
    run: async (args) => {
      const input = await readInput(args);
      const detection = detectFormat(input.bytes, input.name);
      const format = args.from !== undefined ? findFormat(args.from) : formatDefinitions().find((f) => f.id === detection.best?.id);
      if (!format) {
        throw new ToolValidationError(args.from !== undefined ? `Unknown format "${args.from}"` : ambiguityMessage(input.name, detection, input.bytes.length), { path: "$.from" });
      }
      let details: Record<string, unknown> = {};
      try {
        // The format's own description parses a score without read options and so rejects imports and sample files.
        details = format.id === "sidwave" ? { ...describeSidwave(parseScore(input)) } : format.describe?.(input.bytes) ?? {};
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolValidationError(`${input.name} is not a valid ${format.id} file: ${(error as Error).message}`, { path: "$.inputPath" });
      }
      return {
        format: format.id, name: format.name, bytes: input.bytes.length,
        detectedBy: args.from !== undefined ? "from" : detection.best!.by,
        confidence: args.from !== undefined ? 1 : detection.best!.confidence,
        readable: format.read !== undefined, writable: format.write !== undefined,
        details, warnings: detection.warnings, candidates: detection.candidates,
      };
    },
  },
  {
    op: "convert", effect: "write", description: "Convert between music formats.",
    optional: [...SCORE, "to", "from", "outputPath", "overwrite", "strict", "verify", "song", "voices", "system", "model", "durationSeconds", "includeScore"],
    run: async (args, ctx) => {
      const input = await readInput(args);
      const target = resolveTarget(args.to, args.outputPath === undefined ? undefined : basename(args.outputPath));
      const output = planOutput(args, input.stem, target.extensions[0]!, [input.file]);
      const notices: string[] = [];
      const result = await convert(input.bytes, {
        inputName: input.name, to: target.id, from: args.from, song: args.song, voices: args.voices, mode: args.system,
        model: args.model, seconds: args.durationSeconds, verify: args.verify === true, readOptions: input.read,
        createEngine: engineFactory(ctx), signal: ctx.signal, notice: (message) => notices.push(message),
      });
      const strictFailed = args.strict === true && result.severity === "lost";
      const artifact = strictFailed ? undefined : await output.write(result.output, ctx);
      const rank = { lost: 0, approx: 1, info: 2 };
      const losses = capped([...result.losses].sort((a, b) => rank[a.severity] - rank[b.severity]), 30);
      return {
        written: !strictFailed,
        ...(artifact ?? { note: "strict: content would be lost, so nothing was written" }),
        from: result.from, to: result.to, chain: result.chain,
        detectedBy: result.detected.viaFrom ? "from" : result.detected.by,
        severity: result.severity, losses: losses.items, ...(losses.omitted ? { lossesOmitted: losses.omitted } : {}),
        ...(result.metrics ? { metrics: result.metrics } : {}),
        voices: result.plan.voices, droppedVoices: result.plan.dropped,
        notices: [...new Set([...result.detected.warnings, ...notices, ...result.notices])],
        defaults: result.defaults,
        ...(args.includeScore ? { sidwave: result.score } : {}),
      };
    },
  },
  {
    op: "validate", effect: "read", description: "Check a score.", optional: SCORE,
    run: async (args) => {
      const input = await readInput(args);
      try {
        return { valid: true, ...describeSidwave(parseScore(input)) };
      } catch (error) {
        const invalid = validationFailure(error);
        if (!invalid) throw error;
        return { valid: false, ...invalid };
      }
    },
  },
  {
    op: "lint", effect: "read", description: "List a score's musical and hardware problems.", optional: [...SCORE, "loop"],
    run: async (args) => {
      const report = lintSidwave(parseScore(await readInput(args)), { loop: args.loop });
      return { actionable: report.actionable, findings: report.formatted };
    },
  },
  {
    op: "format", effect: "write", description: "Write a score in canonical form.", optional: SCORE_OUT,
    run: async (args, ctx) => {
      const input = await readInput(args);
      parseScore(input);
      const formatted = formatSidwave(scoreText(input));
      return { changed: formatted !== scoreText(input), ...(await writeScore(args, input, "formatted", formatted, ctx)) };
    },
  },
  {
    op: "compile", effect: "write", description: "Compile a score to PRG, SID or game files, without playing.",
    optional: [...SCORE, "output", "outputPath", "outputDir", "overwrite", "loop", "song", "origin", "dataOrigin", "zeroPage", "symbols", "forDevice"],
    run: async (args, ctx) => {
      const input = await readInput(args);
      const document = parseScore(input);
      const kind = args.output ?? "prg";
      const backend = backendOf(ctx);
      const device = args.forDevice ? await deviceFacts(ctx) : undefined;
      const warnings = playbackSetupWarnings(document, backend);
      if (device && document.song.mode !== device.system) {
        warnings.push(`The score is ${document.song.mode} but the machine is ${device.system}; use op retarget with forDevice.`);
      }
      const otherModels = device?.sidModel ? document.sids.filter((sid) => sid.model && sid.model !== device.sidModel) : [];
      if (otherModels.length) warnings.push(`The score declares ${otherModels[0]!.model} but the machine's SID at $D400 is ${device!.sidModel}.`);
      const target = { backend, ...(device ? { device } : {}) };

      if (kind !== "game") {
        const compiled = compileSidwaveBytes(document, { format: kind, loop: args.loop, song: args.song });
        const artifact = await planOutput(args, input.stem, `.${kind}`, [input.file]).write(compiled.bytes, ctx);
        const { warnings: compileWarnings, ...summary } = compiled.summary;
        return { ...artifact, ...summary, ...target, warnings: [...compileWarnings, ...warnings] };
      }

      const origin = required(args, "origin") as number;
      if (args.outputPath !== undefined) throw new ToolValidationError("A game build writes several files; pass outputDir", { path: "$.outputPath" });
      const build = compileSidwave(document, {
        target: "game", origin, dataOrigin: args.dataOrigin, zeroPage: args.zeroPage,
        symbols: args.symbols as SidwaveSymbolFormat[] | undefined, loop: args.loop,
      });
      const directory = args.outputDir !== undefined
        ? resolveHostPath(args.outputDir, { purpose: "write" })
        : resolveHostChildPath(defaultHostOutputDir("artifacts", "sidwave"), `${input.stem}-game-${randomUUID().slice(0, 8)}`);
      const outputs: Array<[string, Uint8Array | string]> = [
        [`${input.stem}.bin`, build.data ? build.player : build.combined],
        ...(build.data ? [[`${input.stem}.data.bin`, build.data] as [string, Uint8Array]] : []),
        ...Object.entries(build.symbols).map(([format, content]) =>
          [`${input.stem}.${format === "json" ? "symbols.json" : format}`, content] as [string, string]),
      ];
      const planned = outputs.map(([name, content]) => ({ path: resolveHostChildPath(directory, name), content }));
      // Check every file first, so a refusal does not leave half of a build behind.
      if (planned.some(({ path }) => path === input.file)) {
        throw new ToolValidationError(`The output file is an input file: ${input.file}`, { path: "$.outputDir" });
      }
      const existing = args.overwrite ? undefined : planned.find(({ path }) => existsSync(path));
      if (existing) throw existsError(existing.path, "$.outputDir");
      const files: Artifact[] = [];
      for (const { path, content } of planned) files.push(await writeArtifact(path, content, args.overwrite === true, ctx));
      const { entryPoints, memory, zeroPage, sidRegisters, registers, interrupts, maxStackBytes, playCallsPerFrame, songs, effects, system } = build.contract;
      return {
        outputDir: directory, files, ...target,
        contract: { system, entryPoints, registers, memory, zeroPage, sidRegisters, interrupts, maxStackBytes, playCallsPerFrame, songs, effects },
        cycles: build.cycles, durationSeconds: build.durationSeconds, warnings: [...build.warnings, ...warnings],
      };
    },
  },
  {
    op: "transform", effect: "write",
    description: "Edit a score by action: transpose (semitones), set_tempo (bpm), scale_tempo (factor), restructure (order), quantise (grid), humanise (seed, maxShift), substitute_instrument (from, to).",
    required: ["action"], optional: [...SCORE_OUT, "semitones", "bpm", "factor", "order", "grid", "seed", "maxShift", "from", "to", "scope"],
    run: async (args, ctx) => {
      const input = await readInput(args);
      const source = scoreText(input);
      const read = input.read;
      const value = <T>(name: ArgName) => required(args, name) as T;
      const actions = {
        transpose: () => transpose(source, { semitones: value("semitones"), scope: args.scope, read }),
        set_tempo: () => setTempo(source, { bpm: value("bpm"), read }),
        scale_tempo: () => scaleTempo(source, { factor: value("factor"), read }),
        restructure: () => restructure(source, { order: value<string[]>("order"), read }),
        quantise: () => quantise(source, { grid: value("grid"), read }),
        humanise: () => humanise(source, { seed: value("seed"), maxShift: value("maxShift"), scope: args.scope, read }),
        substitute_instrument: () => substituteInstrument(source, { from: value("from"), to: value("to"), read }),
      };
      if (!Object.prototype.hasOwnProperty.call(actions, args.action!)) {
        throw new ToolValidationError("Unknown transform action", { path: "$.action", details: { allowed: Object.keys(actions) } });
      }
      const result = actions[args.action as keyof typeof actions]();
      return { action: args.action, report: result.report, ...(await writeScore(args, input, args.action!, result.text, ctx)) };
    },
  },
  {
    op: "retarget", effect: "write", description: "Adapt a score to a clock, SID model, SID count or budget.",
    optional: [...SCORE_OUT, "system", "model", "sids", "budgetCycles", "budgetBytes", "allowChanges", "forDevice"],
    run: async (args, ctx) => {
      const input = await readInput(args);
      const device = args.forDevice ? await deviceFacts(ctx) : undefined;
      const clock = args.system ?? device?.system;
      const model = args.model ?? device?.sidModel;
      if ([clock, model, args.sids, args.budgetCycles, args.budgetBytes].every((value) => value === undefined)) {
        throw new ToolValidationError("Name a target: system, model, sids, budgetCycles, budgetBytes or forDevice", { path: "$.system" });
      }
      const result = retargetSidwave(scoreText(input), {
        clock, model, sids: args.sids, budgetCycles: args.budgetCycles, budgetBytes: args.budgetBytes,
        allowChanges: args.allowChanges, read: input.read,
      });
      const { changes, sids, ...report } = result.report;
      const shown = capped(changes, 20);
      const voices = capped(sids?.voices ?? [], 12);
      return {
        ...report, changes: shown.items, ...(shown.omitted ? { changesOmitted: shown.omitted } : {}),
        ...(sids ? { sids: { ...sids, voices: voices.items, ...(voices.omitted ? { voicesOmitted: voices.omitted } : {}) } } : {}),
        ...(device ? { device } : {}),
        ...(await writeScore(args, input, "retargeted", result.text, ctx)),
      };
    },
  },
  {
    op: "reconstruct", effect: "write", description: "Recover a score from a SID file or register trace, with a verdict.",
    required: ["inputPath"], optional: ["outputPath", "overwrite", "includeScore", "song", "durationSeconds", "from", "system"],
    run: async (args, ctx) => {
      const input = await readFileInput(args.inputPath!);
      const output = planOutput(args, `${input.stem}-reconstructed`, ".sidwave.yaml", [input.file]);
      const engine = engineFactory(ctx)("sidlite");
      let result;
      if (isSid(input.bytes)) {
        const songs = parseSidFile(input.bytes).songs;
        if (args.song !== undefined && (args.song < 1 || args.song > songs)) {
          throw new ToolValidationError(`song must be 1..${songs} for this SID file`, { path: "$.song" });
        }
        result = await reconstructSid(input.bytes, { engine, song: args.song, seconds: args.durationSeconds });
      } else {
        const format = findFormat(args.from ?? detectFormat(input.bytes, input.name).best?.id ?? "")?.id;
        if (format !== "vice-dump" && format !== "siddump") {
          throw new ToolValidationError("reconstruct reads SID files, VICE dumps and siddump tables; use op convert for other formats", { path: "$.inputPath" });
        }
        const parse = format === "vice-dump" ? parseViceDump : parseSiddump;
        result = await reconstructFromTrace(parse(input.bytes, { clock: args.system }), { engine, seconds: args.durationSeconds });
      }
      // The library records a failed second pass in the report, so a cancelled pass must be checked here.
      ctx.signal?.throwIfAborted();
      const { report, score } = result;
      const artifact = await output.write(score, ctx);
      const unsupported = capped(report.unsupported, 10);
      return {
        verdict: report.compile?.ok === false ? "recompile_failed"
          : report.strictExact ? "strict_exact" : report.registerStateExact ? "register_state_exact" : "differs",
        strictExact: report.strictExact, registerStateExact: report.registerStateExact,
        ...artifact, ...(args.includeScore ? { sidwave: score } : {}),
        horizon: report.horizon, compile: report.compile,
        fdiff: fdiffSummary(report.fdiffState),
        recovery: {
          notes: report.recovery.noteCount, instruments: report.recovery.instrumentCount, patterns: report.recovery.patternCount,
          tempo: report.recovery.tempo, speed: report.recovery.speed,
        },
        unsupported: unsupported.items, ...(unsupported.omitted ? { unsupportedOmitted: unsupported.omitted } : {}),
        ...("trace" in result ? { trace: result.trace } : {}),
      };
    },
  },
  {
    op: "analyze_music", effect: "read", description: "Key, form, voices, techniques and resources of a score or SID.",
    optional: [...SCORE, "song", "durationSeconds"],
    run: async (args, ctx) => {
      const input = await readInput(args);
      const engine = engineFactory(ctx)("sidlite");
      const report = isSid(input.bytes)
        ? await analyzeSid(input.bytes, { engine, song: args.song, seconds: args.durationSeconds, signal: ctx.signal })
        : await analyzeScore(scoreText(input), { read: input.read, engine, seconds: args.durationSeconds });
      ctx.signal?.throwIfAborted();
      const { motifs, techniques, ...rest } = report;
      const shownMotifs = capped(motifs, 5);
      const shownTechniques = capped(techniques, 20);
      return {
        ...rest, motifs: shownMotifs.items, techniques: shownTechniques.items,
        omitted: { motifs: shownMotifs.omitted, techniques: shownTechniques.omitted },
      };
    },
  },
  {
    op: "compare", effect: "read", description: "Compare two scores or SIDs: register differences and verification level.",
    required: ["comparePath"], optional: [...SCORE, "song", "durationSeconds", "level", "ladder"],
    run: async (args, ctx) => {
      const side = (input: Input) => isSid(input.bytes)
        ? { kind: "sid" as const, bytes: input.bytes, source: input.name }
        : { kind: "score" as const, text: scoreText(input), source: input.name, read: input.read };
      const a = side(await readInput(args));
      const b = side(await readFileInput(args.comparePath!));
      const engines = engineFactory(ctx);
      const report = await compare(a, b, {
        engine: engines("sidlite"), a1Engine: engines("residfp"), song: args.song, seconds: args.durationSeconds,
        level: args.level, noLadder: args.ladder === false, signal: ctx.signal,
      });
      ctx.signal?.throwIfAborted();
      return {
        equal: report.equal, horizon: report.horizon, fdiff: fdiffSummary(report.fdiffState),
        voices: report.voices,
        ...(report.ladder ? {
          verification: {
            verdict: report.ladder.verdict, requestedLevel: report.ladder.requestedLevel, level: report.ladder.level,
            levels: report.ladder.levels, notes: report.ladder.notes,
          },
        } : {}),
        ...(report.musical ? { musical: { ...report.musical, first: report.musical.first.slice(0, 10) } } : {}),
      };
    },
  },
  {
    op: "sid_info", effect: "read", description: "SID header, song lengths, STIL notes and player.",
    required: ["inputPath"], optional: ["songlengthsPath", "stilPath", "hvscDir", "hvscPath", "sidIdPath"],
    run: async (args) => {
      const input = await readFileInput(args.inputPath!);
      let { songlengthsPath, stilPath, hvscPath } = args;
      if (args.hvscDir !== undefined) {
        // Confinement check only: a directory is not a readable file.
        const root = resolveHostPath(args.hvscDir, { purpose: "write" });
        const databases = hvscDatabases(root);
        songlengthsPath ??= databases.songlengths;
        stilPath ??= databases.stil;
        hvscPath ??= hvscPathOf(root, input.file!);
      }
      const latin = async (path: string) => (await readHostFile(path, { maxBytes: DEFAULT_MAX_READ_BYTES })).toString("latin1");
      const songlengths = songlengthsPath === undefined ? undefined : parseSonglengths(await latin(songlengthsPath));
      if (args.stilPath !== undefined && hvscPath === undefined) {
        throw new ToolValidationError("A STIL lookup needs hvscPath or hvscDir", { path: "$.hvscPath" });
      }
      const stil = stilPath === undefined || hvscPath === undefined ? undefined : queryStil(parseStil(await latin(stilPath)), hvscPath);
      const players = args.sidIdPath === undefined
        ? undefined
        : identifySidPlayer(input.bytes, parseSidIdConfig(await latin(args.sidIdPath)))
          .slice(0, 3).map(({ player, confidence }) => ({ player, confidence }));
      return {
        ...sidInfo(input.bytes, { songlengths }),
        ...(hvscPath === undefined ? {} : { hvscPath }),
        ...(stil ? { stil } : {}),
        ...(players ? { players } : {}),
      };
    },
  },
  {
    op: "compose", effect: "write", description: "Compose a new score with form and harmony, without playing.",
    optional: ["style", "profile", "seed", "system", "root", "cycleBudget", "outputPath", "overwrite", "includeScore"],
    run: async (args, ctx) => {
      const { system, source } = await resolveSidSystem(ctx, args.system);
      const style = (args.style ?? "chiptune") as MusicStyle;
      const seed = args.seed ?? DEFAULT_MUSIC_SEED;
      const profiles = PROFILES.map((profile) => profile.name);
      if (args.profile !== undefined && !profiles.includes(args.profile)) {
        throw new ToolValidationError("Unknown composer profile", { path: "$.profile", details: { allowed: profiles } });
      }
      const result = generateSidwave({
        composer: 2, style, seed, system, preset: "classic", profile: args.profile, cycleBudget: args.cycleBudget,
        root: args.root as string,
      });
      if (!("sections" in result)) throw new ToolExecutionError("The composer returned no arrangement");
      const artifact = await writeScore(args, { stem: `${args.profile ?? style}-${seed}` }, "composed", documentText(result.score), ctx);
      return {
        ...artifact, style, seed, system, systemSource: source, profile: result.profile.name, key: result.key,
        tempo: result.tempo, bars: result.bars, speed: result.speed,
        sections: result.sections.map(({ name, role, startBar, bars, key, cadence }) => ({ name, role, startBar, bars, key, cadence })),
        cycles: result.cycles, repairs: result.repairs, warnings: "warnings" in result ? result.warnings : [],
      };
    },
  },
  {
    op: "complete", effect: "write",
    description: "Extend a score by action: continue (bars), harmonise (voice, target), accompany (bass, drums), fill-section (section).",
    required: ["action"], optional: [...SCORE_OUT, "bars", "voice", "target", "bass", "drums", "section", "after", "at", "seed", "harmony", "instrument", "verify"],
    run: async (args, ctx) => {
      const actions = ["continue", "harmonise", "accompany", "fill-section"] as const;
      const action = actions.find((candidate) => candidate === args.action);
      if (!action) throw new ToolValidationError("Unknown complete action", { path: "$.action", details: { allowed: actions } });
      const input = await readInput(args);
      parseScore(input);
      const { bars, voice, target, bass, drums, section, after, at, seed, harmony, instrument, verify } = args;
      const result = completeScore(scoreText(input), action, {
        bars, voice, target, bass, drums, section, after, at, seed, style: harmony, instrument, verify, readOptions: input.read,
      });
      return {
        action, targets: result.targets, entries: result.entries, addedBars: result.addedBars,
        ...(result.protected ? { protected: result.protected } : {}),
        ...(await writeScore(args, input, action, documentText(result.score), ctx)),
      };
    },
  },
];

function operation({ op, description, required: requiredNames = [], optional = [], run }: Definition): GroupedOperationConfig {
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

export const sidwaveOperations: readonly GroupedOperationConfig[] = definitions.map(operation);

export const sidwaveOperationEffects: Readonly<Record<string, ToolEffect>> = Object.fromEntries(
  definitions.map(({ op, effect }) => [op, effect]),
);
