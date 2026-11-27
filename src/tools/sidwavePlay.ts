/**
 * `c64_sound` op `play`: any readable music file or SIDWave score, converted when needed and started on the active
 * backend with the same deployment functions as `compile_play`.
 */
import { randomUUID } from "node:crypto";
import { compileSidwaveToPrg, convert, parseSidFile, parseSidwave, type ConvertResult } from "sidwave";
import { defaultHostOutputDir, resolveHostPath } from "../hostPaths.js";
import { hostSidwaveReadOptions } from "../sidwaveHost.js";
import { cancelGeneratedSidPlayback, playbackSetupWarnings, resolveSidSystem, startCompiledSidwave } from "./audio.js";
import { clearViceSymbols } from "./translation/symbolRegistry.js";
import { ToolExecutionError, ToolValidationError } from "./errors.js";
import type { ToolExecutionContext } from "./types.js";
import {
  approximation, backendOf, detectInput, engineFactory, lossReport, parseScore, planOutput, readInput, scoreText, SCORE,
  type Args, type Definition, type Input,
} from "./sidwaveShared.js";

type Facade = Parameters<typeof resolveSidSystem>[2];

/** Seconds of a SID tune reconstructed for VICE by default: a few seconds of work; 180 s takes over a minute. */
const SID_HORIZON_SECONDS = 30;

/** Stops generated playback, starts the new program and fails with the saved files when the machine refuses it. */
async function deploy(ctx: ToolExecutionContext, start: () => Promise<{ success: boolean; details?: unknown }>, files: Record<string, unknown>) {
  ctx.signal?.throwIfAborted();
  await cancelGeneratedSidPlayback(ctx.client);
  const started = await start();
  if (!started.success) {
    throw new ToolExecutionError("The backend reported a failure while starting playback", { details: { response: started.details, ...files } });
  }
  clearViceSymbols();
}

/** A PRG runs as it is. */
async function playProgram(input: Input, ctx: ToolExecutionContext, backend: string, facade: Facade) {
  if (input.file === undefined) throw new ToolValidationError("A PRG is a host file; pass inputPath", { path: "$.inputPath" });
  if (input.bytes.length < 3) throw new ToolValidationError(`${input.name} is too short to be a PRG`, { path: "$.inputPath" });
  await deploy(ctx, () => ctx.client.runPrg(input.bytes, facade), {});
  const loadAddress = input.bytes.readUInt16LE(0);
  return {
    summary: `Running ${input.name} (PRG, load address $${loadAddress.toString(16).toUpperCase().padStart(4, "0")}) on ${backend}.`,
    playing: true, backend, method: "run_prg", conversion: "none", program: { inputPath: input.file }, loadAddress,
  };
}

/** The Ultimate firmware plays the original SID file. */
async function playSid(args: Args, input: Input, ctx: ToolExecutionContext, backend: string) {
  const file = parseSidFile(input.bytes);
  if (args.song !== undefined && args.song > file.songs) {
    throw new ToolValidationError(`song must be 0..${file.songs} for this SID file (0: its start song)`, { path: "$.song" });
  }
  const song = args.song || file.startSong;
  await deploy(ctx, () => ctx.client.sidplayAttachment(input.bytes, args.song ? { songnr: song } : undefined), {});
  return {
    summary: `Playing '${file.name}' by ${file.author} (original SID, song ${song} of ${file.songs}) on ${backend}.`,
    playing: true, backend, method: "sidplay", conversion: "none", title: file.name, author: file.author, song, songs: file.songs,
    clock: file.clock, sidModels: file.sidModels, program: { inputPath: input.file },
  };
}

export const playDefinition: Definition = {
  op: "play", effect: "write",
  description: "Play any music file (SIDWave, SID, MIDI, MOD, tracker and notation formats, PRG): detects, converts, runs, reports losses.",
  optional: [...SCORE, "from", "song", "voices", "system", "durationSeconds", "configure", "outputDir"],
  run: async (args, ctx) => {
    const input = await readInput(args);
    const detected = detectInput(input, args.from);
    const format = detected.format;
    const facade = await ctx.client.pinFacade?.();
    const backend = facade?.type ?? backendOf(ctx);
    const found = {
      format: format.id, name: format.name, detectedBy: detected.by, confidence: detected.confidence,
    };
    if (format.id === "prg") return { ...(await playProgram(input, ctx, backend, facade)), detected: found };
    if (format.id === "sid" && backend !== "vice") return { ...(await playSid(args, input, ctx, backend)), detected: found };

    const directory = args.outputDir !== undefined
      ? resolveHostPath(args.outputDir, { purpose: "write" })
      : defaultHostOutputDir("artifacts", "sidwave");
    const stem = `${input.stem}-${randomUUID().slice(0, 8)}`;
    const save = async (extension: string, content: Uint8Array | string) =>
      planOutput({ outputPath: `${directory}/${stem}${extension}` }, stem, extension, [input.file]).write(content, ctx);

    const native = format.id === "sidwave";
    const machine = await resolveSidSystem(ctx, args.system as "PAL" | "NTSC" | undefined, facade);
    let converted: ConvertResult | undefined;
    const notices: string[] = [];
    if (!native) {
      converted = await convert(input.bytes, {
        inputName: input.name, to: "sidwave", from: format.id, song: args.song || undefined, voices: args.voices,
        mode: machine.system, seconds: args.durationSeconds ?? (format.id === "sid" ? SID_HORIZON_SECONDS : undefined),
        title: format.id === "sid" ? parseSidFile(input.bytes).name || undefined : undefined,
        readOptions: input.read, createEngine: engineFactory(ctx),
        signal: ctx.signal, notice: (message) => notices.push(message),
      });
      ctx.signal?.throwIfAborted();
    }
    const document = converted ? parseSidwave(Buffer.from(converted.output).toString("utf8"), hostSidwaveReadOptions) : parseScore(input);
    const songs = document.songs?.length ?? 1;
    if (native && args.song !== undefined && args.song > songs) {
      throw new ToolValidationError(`song must be 0..${songs} for this score`, { path: "$.song" });
    }
    // A score file stays where it is; converted and inline scores are saved so that they can be edited.
    const score = converted ? await save(".sidwave.yaml", Buffer.from(converted.output))
      : input.file !== undefined ? { inputPath: input.file }
      : await save(".sidwave.yaml", scoreText(input));
    const saved = "outputPath" in score ? score.outputPath : score.inputPath;

    const song = native && args.song && document.songs ? args.song - 1 : undefined;
    const compiled = compileSidwaveToPrg(document, song === undefined ? {} : { song });
    const program = { ...(await save(".prg", compiled.prg)), entryAddress: compiled.entryAddress };

    await deploy(ctx, () => startCompiledSidwave(ctx.client, document, compiled, backend, { configure: args.configure, facade }),
      { score: saved, program: program.outputPath });

    const reconstructed = converted && format.readIsApproximate;
    const label = converted ? approximation(format.id) : {};
    const report = reconstructed ? converted!.reports.read as { strictExact?: boolean; registerStateExact?: boolean; horizon?: { seconds: number } } : undefined;
    const warnings = [...compiled.warnings, ...playbackSetupWarnings(document, backend, args.configure)];
    if (document.song.mode !== machine.system) {
      warnings.push(`The score is ${document.song.mode} but the machine is ${machine.system}; use op retarget to adapt it.`);
    }
    if (label.approximateNote) warnings.push(label.approximateNote);
    if (format.id === "sid") {
      warnings.push(`VICE cannot start a SID file, so an approximate score was reconstructed from the first ${report?.horizon?.seconds} s and played (durationSeconds sets the length). On c64u or u2 the original SID plays unchanged.`);
    }
    const losses = converted ? lossReport(converted.losses, 15) : undefined;
    const title = document.song.title;
    const duration = Math.round(compiled.durationSeconds * 10) / 10;
    const loops = document.songs ? document.songs[song ?? 0]!.loop : !document.end;
    const kind = reconstructed ? "reconstructed (approximate)" : label.approximate ? "converted (approximate)" : "converted";
    const how = converted ? `${format.name}, ${kind}` : "SIDWave score";
    const lossCount = losses ? losses.total : 0;
    return {
      summary: `Playing '${title}' (${how}; ${document.voices.length} voice${document.voices.length === 1 ? "" : "s"}, ${document.song.mode}, ${duration} s ${loops ? "loop" : "once"}) on ${backend}.`
        + (converted ? ` ${lossCount ? `${lossCount} kind${lossCount === 1 ? "" : "s"} of conversion loss, see losses.` : "No conversion losses."}` : ""),
      playing: true, backend, method: "run_prg", detected: found,
      conversion: !converted ? "none" : reconstructed ? "reconstructed" : "converted",
      ...(label.approximate ? { approximate: true } : {}),
      ...(report ? { verdict: { strictExact: report.strictExact, registerStateExact: report.registerStateExact } } : {}),
      title, system: document.song.mode, systemSource: machine.source, voices: document.voices.length, sids: document.sids.length,
      durationSeconds: duration, score, program,
      ...(converted ? {
        severity: converted.severity, losses: losses!.losses, ...(losses!.omitted ? { lossesOmitted: losses!.omitted } : {}),
        droppedVoices: converted.plan.dropped,
      } : {}),
      notices: [...new Set([...detected.warnings, ...notices, ...(converted?.notices ?? [])])],
      warnings,
    };
  },
};
