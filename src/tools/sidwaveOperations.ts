/**
 * Offline SIDWave operations of `c64_sound`. Each operation reads confined host input, calls one library function of
 * the `sidwave` package, writes its artifacts and returns a compact summary. Playback stays with the existing
 * `compile_play`, `pipeline` and program operations.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import YAML from "yaml";
import {
  compileSidwaveBytes, compileSidwave, completeScore, convert, describeSidwave,
  generateSidwave, renderSidwaveGameInclude, sidwaveRelocationTable, hvscDatabases, hvscPathOf, identifySidPlayer, lintSidwave, parseSidFile, parseSidIdConfig,
  parseSonglengths, parseStil, PROFILES, queryStil, sidInfo, validationFailure,
  DEFAULT_MUSIC_SEED, MUSIC_STYLES, type MusicStyle, type SidwaveAssembler, type SidwaveGameOptions, type SidwaveSymbolFormat,
} from "sidwave";
import { analyzeScore, analyzeSid, compare } from "sidwave/analyze";
import {
  ambiguityMessage, detectFormat, findFormat, formatDefinitions, listFormats, parseSiddump, parseViceDump,
  reconstructFromTrace, resolveTarget,
} from "sidwave/export";
import { formatSidwave } from "sidwave/format";
import { reconstructSid } from "sidwave/reconstruct";
import { retargetSidwave } from "sidwave/retarget";
import { humanise, quantise, restructure, scaleTempo, setTempo, substituteInstrument, transpose } from "sidwave/transform";
import { DEFAULT_MAX_READ_BYTES, defaultHostOutputDir, readHostFile, resolveHostChildPath, resolveHostPath } from "../hostPaths.js";
import { playbackSetupWarnings, resolveSidSystem } from "./audio.js";
import { ToolError, ToolExecutionError, ToolValidationError } from "./errors.js";
import type { ToolEffect } from "./access.js";
import type { GroupedOperationConfig } from "./registry/utils.js";
import { playDefinition } from "./sidwavePlay.js";
import { renderDefinition } from "./sidwaveRender.js";
import { extractInstrumentsDefinition, preserveDefinition, sidEditDefinition } from "./sidwaveArchive.js";
import {
  approximation, backendOf, cancellationPoint, capped, deviceFacts, documentText, engineFactory, existsError, isSid, lossReport, operation, parseScore,
  planOutput, readFileInput, readInput, record, required, SCORE, SCORE_OUT, scoreText, writeArtifact, writeScore,
  type ArgName, type Artifact, type Definition, type Input,
} from "./sidwaveShared.js";

/* ------------------------------------------------------------------------------------------------ summaries */

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

const definitions: Definition[] = [
  playDefinition,
  renderDefinition,
  extractInstrumentsDefinition,
  {
    op: "formats", effect: "read", description: "List conversion formats.", optional: ["from"],
    run: async ({ from }) => {
      const all = listFormats();
      if (from === undefined) {
        return {
          formats: all.map((f) => ({
            id: f.id, extensions: f.extensions, read: !f.read ? "no" : approximation(f.id).approximate ? "approximate" : "yes",
            write: f.write, losses: f.lossSummary, ...approximation(f.id),
          })),
        };
      }
      const id = findFormat(from)?.id;
      const format = all.find((f) => f.id === id);
      if (!format) throw new ToolValidationError(`Unknown format "${from}"`, { path: "$.from", details: { allowed: all.map((f) => f.id) } });
      const label = approximation(format.id);
      return { format: { ...format, ...(label.approximate ? { readApproximate: format.read } : {}) }, ...label };
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
        readable: format.read !== undefined, writable: format.write !== undefined, ...approximation(format.id),
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
      const losses = lossReport(result.losses, 30);
      return {
        written: !strictFailed,
        ...(artifact ?? { note: "strict: content would be lost, so nothing was written" }),
        from: result.from, to: result.to, chain: result.chain, ...approximation(result.from, result.to),
        detectedBy: result.detected.viaFrom ? "from" : result.detected.by,
        severity: result.severity, losses: losses.losses, ...(losses.omitted ? { lossesOmitted: losses.omitted } : {}),
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
    optional: [...SCORE, "output", "outputPath", "outputDir", "overwrite", "loop", "song", "origin", "dataOrigin", "zeroPage", "symbols", "assembler", "relocation", "maxCycles", "forDevice"],
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
        const gameOnly = (["assembler", "relocation", "maxCycles"] as const).find((name) => args[name] !== undefined);
        if (gameOnly) throw new ToolValidationError(`${gameOnly} needs output: "game"`, { path: "$.output" });
        const compiled = compileSidwaveBytes(document, { format: kind, loop: args.loop, song: args.song });
        const artifact = await planOutput(args, input.stem, `.${kind}`, [input.file]).write(compiled.bytes, ctx);
        const { warnings: compileWarnings, ...summary } = compiled.summary;
        return { ...artifact, ...summary, ...target, warnings: [...compileWarnings, ...warnings] };
      }

      const origin = required(args, "origin") as number;
      if (args.outputPath !== undefined) throw new ToolValidationError("A game build writes several files; pass outputDir", { path: "$.outputPath" });
      const options: SidwaveGameOptions = {
        target: "game", origin, dataOrigin: args.dataOrigin, zeroPage: args.zeroPage,
        symbols: args.symbols as SidwaveSymbolFormat[] | undefined, loop: args.loop, maxCycles: args.maxCycles,
      };
      // Everything that can fail is computed before the first file is written.
      const build = compileSidwave(document, options);
      const include = args.assembler === undefined
        ? undefined
        : renderSidwaveGameInclude(build, args.assembler as SidwaveAssembler, document.song.title);
      const relocation = args.relocation ? sidwaveRelocationTable(document, options) : undefined;
      const directory = args.outputDir !== undefined
        ? resolveHostPath(args.outputDir, { purpose: "write" })
        : resolveHostChildPath(defaultHostOutputDir("artifacts", "sidwave"), `${input.stem}-game-${randomUUID().slice(0, 8)}`);
      const outputs: Array<[string, Uint8Array | string]> = [
        [`${input.stem}.bin`, build.data ? build.player : build.combined],
        ...(build.data ? [[`${input.stem}.data.bin`, build.data] as [string, Uint8Array]] : []),
        ...Object.entries(build.symbols).map(([format, content]) =>
          [`${input.stem}.${format === "json" ? "symbols.json" : format}`, content] as [string, string]),
        ...(include === undefined ? [] : [[`${input.stem}.inc`, include] as [string, string]]),
        ...(relocation === undefined ? [] : [[`${input.stem}.reloc.json`, `${JSON.stringify(relocation)}\n`] as [string, string]]),
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
        ...(relocation ? {
          relocation: { playerOffsets: relocation.player.length, dataOffsets: relocation.data.length, granularity: relocation.granularity },
        } : {}),
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
      await cancellationPoint(ctx);
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
    op: "reconstruct", effect: "write", description: "Experimental: approximate score from a SID file or register trace, with a verdict.",
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
    op: "analyze_music", effect: "read", description: "Musical analysis of a score or SID (key, form, techniques); audio check: analyze.",
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
  sidEditDefinition,
  preserveDefinition,
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
      await cancellationPoint(ctx);
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
      await cancellationPoint(ctx);
      return {
        action, targets: result.targets, entries: result.entries, addedBars: result.addedBars,
        ...(result.protected ? { protected: result.protected } : {}),
        ...(await writeScore(args, input, action, documentText(result.score), ctx)),
      };
    },
  },
];

export const sidwaveOperations: readonly GroupedOperationConfig[] = definitions.map(operation);

export const sidwaveOperationEffects: Readonly<Record<string, ToolEffect>> = Object.fromEntries(
  definitions.map(({ op, effect }) => [op, effect]),
);
