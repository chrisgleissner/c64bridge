/** `c64_sound` op `render`: WAV files of a mix, of stems, or of the music with one voice alone or muted. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { compileSidwaveBytes, parseSidFile, renderTune } from "sidwave";
import { isolateVoice } from "sidwave/analyze";
import { keepVoices, renderStems, stemVoiceGroups, StemsRefusedError, writeWav } from "sidwave/export";
import { defaultHostOutputDir, resolveHostChildPath, resolveHostPath } from "../hostPaths.js";
import { ToolValidationError } from "./errors.js";
import {
  engineFactory, existsError, isSid, lossReport, planOutput, readInput, scoreOf, SCORE, writeArtifact,
  type Artifact, type Definition,
} from "./sidwaveShared.js";

const SAMPLE_RATE = 48_000;
const MAX_SECONDS = 600;
/** Seconds rendered of a SID file, which does not record its length. */
const SID_SECONDS = 30;
const ACTIONS = ["mix", "stems", "solo", "mute"] as const;

export const renderDefinition: Definition = {
  op: "render", effect: "write",
  description: "Render WAV by action: mix (default), stems (not SID), solo or mute (voice).",
  optional: [...SCORE, "action", "voice", "from", "song", "durationSeconds", "model", "outputPath", "outputDir", "overwrite"],
  run: async (args, ctx) => {
    const action = ACTIONS.find((candidate) => candidate === (args.action ?? "mix"));
    if (!action) throw new ToolValidationError("Unknown render action", { path: "$.action", details: { allowed: [...ACTIONS] } });
    const single = action === "solo" || action === "mute";
    if (single && args.voice === undefined) throw new ToolValidationError(`Action ${action} needs voice`, { path: "$.voice" });
    if (!single && args.voice !== undefined) throw new ToolValidationError("voice applies to the actions solo and mute", { path: "$.voice" });
    if (action === "stems" && args.outputPath !== undefined) throw new ToolValidationError("Stems are several files; pass outputDir", { path: "$.outputPath" });
    if (action !== "stems" && args.outputDir !== undefined) throw new ToolValidationError(`Action ${action} writes one file; pass outputPath`, { path: "$.outputDir" });
    const input = await readInput(args);
    const engines = engineFactory(ctx);
    const suffix = single ? `${action}${args.voice}` : "mix";
    const output = () => planOutput(args, `${input.stem}-${suffix}`, ".wav", [input.file]);

    if (isSid(input.bytes)) {
      const file = parseSidFile(input.bytes);
      if (args.song !== undefined && (args.song < 1 || args.song > file.songs)) {
        throw new ToolValidationError(`song must be 1..${file.songs} for this SID file`, { path: "$.song" });
      }
      if (action === "stems") {
        throw new ToolValidationError("Stems need a score: use action solo for each voice of a SID file, or recover a score with op reconstruct first", { path: "$.action" });
      }
      const seconds = args.durationSeconds ?? SID_SECONDS;
      const target = output();
      if (action === "mix") {
        const tune = { source: input.name, kind: "sid" as const, bytes: input.bytes, md5: createHash("md5").update(input.bytes).digest("hex") };
        const { wav, summary } = await renderTune(tune, { seconds, song: args.song, model: args.model, createEngine: engines, signal: ctx.signal });
        return { action, ...(await target.write(wav, ctx)), seconds: summary.seconds, sampleRate: summary.sampleRate, engine: summary.engine };
      }
      if (args.model !== undefined) throw new ToolValidationError("model does not apply to a voice of a SID file", { path: "$.model" });
      const result = await isolateVoice(input.bytes, {
        voice: args.voice!, mode: action, engine: engines("sidlite"), renderEngine: engines("residfp"), song: args.song, seconds,
        sampleRate: SAMPLE_RATE, signal: ctx.signal,
      });
      ctx.signal?.throwIfAborted();
      return {
        action, voice: result.voice, ...(await target.write(result.wav, ctx)), seconds: result.horizon.seconds,
        sampleRate: result.horizon.sampleRate, engine: result.engine, method: result.method,
        note: "Diagnostic audio from a reconstructed score, not a stem of the original player.",
        reconstructionStrictExact: result.reconstructionStrictExact, coupling: result.coupling,
      };
    }

    const { document, converted } = await scoreOf(input, args, ctx);
    // A converted input already holds only the requested song.
    const songs = document.songs?.length ?? 1;
    const wanted = converted ? 1 : args.song || 1;
    if (wanted > songs) throw new ToolValidationError(`song must be 1..${songs} for this score`, { path: "$.song" });
    const song = wanted - 1;
    const conversion = converted ? (() => {
      const { losses, omitted } = lossReport(converted.losses, 10);
      return { from: converted.from, severity: converted.severity, losses, ...(omitted ? { lossesOmitted: omitted } : {}) };
    })() : undefined;

    if (action === "stems") {
      const directory = args.outputDir !== undefined
        ? resolveHostPath(args.outputDir, { purpose: "write" })
        : resolveHostChildPath(defaultHostOutputDir("artifacts", "sidwave"), `${input.stem}-stems-${randomUUID().slice(0, 8)}`);
      const groups = stemVoiceGroups(document, song);
      const paths = [`${input.stem}.mix.wav`, ...groups.map((group) => `${input.stem}.v${group.join("+v")}.wav`)]
        .map((name) => resolveHostChildPath(directory, name));
      // Check every file before rendering, so a refusal costs no time and leaves no partial set.
      if (paths.includes(input.file ?? "")) throw new ToolValidationError(`The output file is an input file: ${input.file}`, { path: "$.outputDir" });
      const existing = args.overwrite ? undefined : paths.find((path) => existsSync(path));
      if (existing) throw existsError(existing, "$.outputDir");
      let result;
      try {
        result = await renderStems(document, {
          engine: engines("residfp"), emulation: "residfp", sampleRate: SAMPLE_RATE,
          seconds: args.durationSeconds, song: document.songs ? song : undefined, model: args.model, signal: ctx.signal,
        });
      } catch (error) {
        if (error instanceof StemsRefusedError) throw new ToolValidationError(error.message, { path: "$.action" });
        throw error;
      }
      const files: Array<Artifact & { voices?: number[] }> = [];
      for (const [index, path] of paths.entries()) {
        const stem = index === 0 ? undefined : result.stems[index - 1]!;
        const artifact = await writeArtifact(path, writeWav(stem ? stem.samples : result.mix, result.sampleRate), args.overwrite === true, ctx);
        files.push({ ...artifact, outputPath: basename(artifact.outputPath), ...(stem ? { voices: stem.voices } : {}) });
      }
      return {
        action, outputDir: directory, files: files.map(({ outputPath, ...file }) => ({ file: outputPath, ...file })),
        seconds: result.seconds, sampleRate: result.sampleRate, engine: result.engine,
        additive: result.additive, energyRatio: result.sumError.energyRatio, coupling: result.coupling,
        ...(conversion ? { conversion } : {}),
      };
    }

    let rendered = document;
    let sounding: number[] | undefined;
    if (single) {
      const ids = document.voices.map((voice) => voice.id);
      const groups = stemVoiceGroups(document, song);
      const index = ids.indexOf(args.voice!);
      if (index < 0) throw new ToolValidationError(`The score has no voice ${args.voice}`, { path: "$.voice", details: { allowed: ids } });
      // A voice that echoes, follows or doubles another one sounds only together with its source.
      sounding = action === "solo" ? groups[index]! : ids.filter((_, other) => !groups[other]!.includes(args.voice!));
      rendered = keepVoices(document, new Set(sounding));
    }
    const compiled = compileSidwaveBytes(rendered, { format: "sid", ...(document.songs ? { song } : {}) });
    const seconds = args.durationSeconds ?? Math.min(MAX_SECONDS, Math.max(1, Math.ceil(compiled.summary.durationSeconds)));
    const target = output();
    const tune = { source: input.name, kind: "score" as const, bytes: compiled.bytes, md5: createHash("md5").update(compiled.bytes).digest("hex") };
    const { wav, summary } = await renderTune(tune, { seconds, song: song + 1, model: args.model, createEngine: engines, signal: ctx.signal });
    return {
      action, ...(single ? { voice: args.voice, soundingVoices: sounding } : {}), ...(await target.write(wav, ctx)),
      seconds: summary.seconds, sampleRate: summary.sampleRate, engine: summary.engine, ...(conversion ? { conversion } : {}),
    };
  },
};
