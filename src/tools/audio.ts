import { SIDWAVE_EXAMPLES_URI } from "sidwave/examples";
import { DEFAULT_MUSIC_SEED, generateSidwave, MUSIC_STYLES, type MusicStyle } from "sidwave/generate";
import { clearViceSymbols } from "./translation/symbolRegistry.js";
import { compileSidwaveToPrg, compileSidwaveToSid, type CompileResult } from "sidwave/compiler";
import { midiToHz, noteNameToMidi, parseSidwave, type ParsedSidwave } from "sidwave/sidwave";
import { analyzePcm, noAudioMeasurement, recordAndAnalyzeAudio } from "../audio/record_and_analyze_audio.js";
import { cancelledResult, defineToolModule, type JsonSchema, type ToolExecutionContext } from "./types.js";
import {
  booleanSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
  type Schema,
} from "./schema.js";
import { jsonResult, textResult } from "./responses.js";
import {
  ToolError,
  ToolExecutionError,
  ToolValidationError,
  ToolUnsupportedPlatformError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";

import { sidwaveSetupWarnings, validateViceSidwaveMap } from "../sidwavePlaybackConfig.js";
import { getPlatformStatus } from "../platform.js";
import { readPcmFile } from "sidwave/pcm";
import { hostSidwaveFileReader, hostSidwaveReadOptions, hostSidwaveReadOptionsFor } from "../sidwaveHost.js";
import { resolveHostPath } from "../hostPaths.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const NOTE_PATTERN = /^([A-Ga-g])([#b]?)(-?\d+)$/;

const DEFAULT_SILENCE_VERIFY_DURATION_SECONDS = 1.5;
const DEFAULT_SILENCE_VERIFY_RMS_THRESHOLD = 0.02;
const DEFAULT_SILENCE_VERIFY_WAIT_MS = 150;
type AudioClient = ToolExecutionContext["client"];
type PinnedFacade = Awaited<ReturnType<AudioClient["pinFacade"]>>;
const generatedPlaybacks = new WeakMap<AudioClient, { facade?: PinnedFacade; started: Promise<unknown> }>();

/** Detach a generated score before another tool takes over the machine or SID. */
export async function cancelGeneratedSidPlayback(client: AudioClient): Promise<void> {
  const playback = generatedPlaybacks.get(client);
  if (!playback) {
    await client.stopManagedSidwavePlayback?.();
    return;
  }
  await playback.started.catch(() => {});
  if (generatedPlaybacks.get(client) !== playback) return;
  await client.stopSidwavePlayback?.(playback.facade);
  if (generatedPlaybacks.get(client) === playback) generatedPlaybacks.delete(client);
}

export async function startCompiledSidwave(
  client: AudioClient, document: ParsedSidwave, compiled: CompileResult, backend: string,
  options: { configure?: boolean; sid?: Uint8Array; facade?: PinnedFacade } = {},
) {
  if (backend === "vice") validateViceSidwaveMap(document);
  if (typeof client.playSidwave === "function") return client.playSidwave(document, compiled, options);
  // Lightweight clients used by callers for a plain one-SID playback.
  if (options.configure) throw new ToolExecutionError("This client does not support SIDWAVE configuration");
  return options.sid ? client.sidplayAttachment(options.sid) : client.runPrg(compiled.prg, options.facade);
}

export function playbackSetupWarnings(document: ParsedSidwave, backend: string, configured?: boolean): string[] {
  return configured && backend !== "vice" ? [] : sidwaveSetupWarnings(document, backend);
}

function toRecord(details: unknown): Record<string, unknown> | undefined {
  if (details && typeof details === "object") {
    return details as Record<string, unknown>;
  }
  return undefined;
}

function normaliseFailure(details: unknown): Record<string, unknown> | undefined {
  if (details === undefined || details === null) {
    return undefined;
  }
  if (typeof details === "object") {
    return details as Record<string, unknown>;
  }
  return { value: details };
}

function normaliseAddress(value: unknown, fallback: string): string {
  if (typeof value === "number") {
    return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  if (typeof value === "string" && value.length > 0) {
    return value.startsWith("$") ? value : `$${value.toUpperCase()}`;
  }
  return fallback;
}

const sidVolumeArgsSchema = objectSchema({
  description: "Set the SID master volume (0-15).",
  properties: {
    volume: numberSchema({
      description: "SID master volume 0-15. Writes all of $D418, clearing filter mode bits.",
      minimum: 0,
      maximum: 15,
    }),
    filterMode: optionalSchema(numberSchema({
      description: "Optional $D418 bits 4-7 (0-15: low-pass, band-pass, high-pass, voice 3 off). Default 0 clears them.",
      integer: true,
      minimum: 0,
      maximum: 15,
    })),
  },
  required: ["volume"],
  additionalProperties: false,
});

const sidResetArgsSchema = objectSchema({
  description: "Reset or silence the SID chip.",
  properties: {
    hard: booleanSchema({
      description: "If true, perform a hard register scrub; otherwise silence voices softly.",
      default: false,
    }),
  },
  additionalProperties: false,
});

const sidNoteOnArgsSchema = objectSchema({
  description: "Parameters for starting a SID note on a specific voice.",
  properties: {
    voice: numberSchema({
      description: "SID voice to trigger (1-3).",
      integer: true,
      minimum: 1,
      maximum: 3,
      default: 1,
    }),
    note: optionalSchema(stringSchema({
      description: "Musical note like A4, C#5, or Bb3. Overrides frequencyHz if provided.",
      pattern: NOTE_PATTERN,
    })),
    frequencyHz: optionalSchema(numberSchema({
      description: "Explicit frequency in Hz. Used when note is omitted.",
      minimum: 1,
    })),
    system: optionalSchema(stringSchema({
      description: "PAL or NTSC for the note frequency. Default: read from the machine ($02A6).",
      enum: ["PAL", "NTSC"],
    })),
    waveform: stringSchema({
      description: "SID waveform to enable.",
      enum: ["pulse", "saw", "tri", "noise"],
      default: "pulse",
    }),
    pulseWidth: numberSchema({
      description: "Pulse width (0-4095). Used for pulse waveform.",
      integer: true,
      minimum: 0,
      maximum: 0x0fff,
      default: 0x0800,
    }),
    attack: numberSchema({
      description: "Attack rate nibble (0-15).",
      integer: true,
      minimum: 0,
      maximum: 15,
      default: 1,
    }),
    decay: numberSchema({
      description: "Decay rate nibble (0-15).",
      integer: true,
      minimum: 0,
      maximum: 15,
      default: 1,
    }),
    sustain: numberSchema({
      description: "Sustain level nibble (0-15).",
      integer: true,
      minimum: 0,
      maximum: 15,
      default: 15,
    }),
    release: numberSchema({
      description: "Release rate nibble (0-15).",
      integer: true,
      minimum: 0,
      maximum: 15,
      default: 3,
    }),
  },
  additionalProperties: false,
});

const sidNoteOffArgsSchema = objectSchema({
  description: "Parameters for releasing a SID voice.",
  properties: {
    voice: numberSchema({
      description: "SID voice to release (1-3).",
      integer: true,
      minimum: 1,
      maximum: 3,
    }),
  },
  required: ["voice"],
  additionalProperties: false,
});

const sidSilenceArgsSchema = objectSchema({
  description: "Silence all SID voices with an optional verification capture.",
  properties: {
    verify: optionalSchema(booleanSchema({
      description: "Record audio after silencing to confirm the output is quiet.",
      default: false,
    }), false),
  },
  additionalProperties: false,
});

const sidFileSchema = stringSchema({
  description: "SID, PRG or audio file path (absolute or Ultimate).",
  minLength: 1,
});

const sidplayFileArgsSchema = objectSchema({
  description: "Parameters for playing a SID file that already resides on the Ultimate filesystem.",
  properties: {
    path: sidFileSchema,
    songnr: optionalSchema(numberSchema({
      description: "Song number within the SID file (0-based index).",
      integer: true,
      minimum: 0,
    })),
  },
  required: ["path"],
  additionalProperties: false,
});

const modplayFileArgsSchema = objectSchema({
  description: "Parameters for playing a MOD tracker module via the Ultimate SID player.",
  properties: {
    path: sidFileSchema,
  },
  required: ["path"],
  additionalProperties: false,
});

export const MUSIC_GENERATE_DESCRIPTION = "Compose and play a seeded SIDWAVE PRG (replaces the program in memory).";

const musicGenerateArgsSchema = objectSchema({
  description: "Compose and play a seeded SIDWAVE piece.",
  properties: {
    includeScore: optionalSchema(booleanSchema()),
    configure: optionalSchema(booleanSchema({ description: "Set up SID playback." })),
    root: stringSchema({ description: "Tonic and lead register.", pattern: NOTE_PATTERN, default: "C4" }),
    pattern: optionalSchema(stringSchema({ description: "Repeating lead semitone offsets from root.", minLength: 1 })),
    steps: optionalSchema(numberSchema({ description: "Lead notes to play.", integer: true, minimum: 1, maximum: 128 })),
    tempoMs: optionalSchema(numberSchema({ description: "Classic lead spacing in ms.", integer: true, minimum: 20, maximum: 2000 })),
    waveform: optionalSchema(stringSchema({ description: "Lead waveform override.", enum: ["pulse", "saw", "tri", "noise"] })),
    preset: stringSchema({ description: "Classic or varied lead phrasing.", enum: ["classic", "expression"], default: "classic" }),
    system: optionalSchema(stringSchema({ description: "PAL/NTSC timing. Defaults to the machine.", enum: ["PAL", "NTSC"] })),
    style: stringSchema({ description: "Arrangement style.", enum: Object.keys(MUSIC_STYLES), default: "chiptune" }),
    seed: numberSchema({ description: "Reproducible composition seed.", integer: true, minimum: 0, maximum: 0xffffffff, default: DEFAULT_MUSIC_SEED }),
  },
  additionalProperties: false,
});

const sidwaveSourceSchema: Schema<string | Record<string, unknown>> = {
  jsonSchema: {
    description: "SIDWAVE composition represented as YAML/JSON text or an already parsed object.",
    type: ["string", "object"],
  } satisfies JsonSchema,
  parse(value: unknown, path?: string) {
    const resolvedPath = path ?? "$";
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        throw new ToolValidationError("SIDWAVE string must not be empty", { path: resolvedPath });
      }
      return trimmed;
    }
    if (value && typeof value === "object") {
      return value as Record<string, unknown>;
    }
    throw new ToolValidationError("Expected SIDWAVE string or object", { path: resolvedPath });
  },
};

const musicCompileArgsSchema = objectSchema({
  description: "Compile a SIDWAVE composition and optionally play it immediately.",
  properties: {
    configure: optionalSchema(booleanSchema({ description: "Set up SID playback." })),
    sidwave: optionalSchema(sidwaveSourceSchema),
    cpg: optionalSchema(sidwaveSourceSchema),
    format: optionalSchema(stringSchema({
      description: "Source format hint when providing raw text.",
      enum: ["yaml", "json"],
    })),
    output: optionalSchema(stringSchema({
      description: "Target format. PRG works everywhere; SID playback needs C64U/U64 or U2 (SID export with dryRun works everywhere).",
      enum: ["prg", "sid"],
      default: "prg",
    }), "prg"),
    dryRun: optionalSchema(booleanSchema({
      description: "Skip playback; return only compilation metadata.",
      default: false,
    }), false),
    outputPath: optionalSchema(stringSchema({
      description: "Host file for the compiled PRG or SID (allowed directories only). Works with dryRun.",
      minLength: 1,
    })),
  },
  additionalProperties: false,
});

const recordAndAnalyzeArgsSchema = objectSchema({
  description: "Record audio and analyze SID playback characteristics. On the c64u backend the audio comes from the Ultimate audio stream; on other backends it is recorded from the host default input device (microphone).",
  properties: {
    durationSeconds: numberSchema({
      description: "Capture duration in seconds (0.5 - 30).",
      minimum: 0.5,
      maximum: 30,
    }),
    expectedSidwave: optionalSchema(sidwaveSourceSchema),
  },
  required: ["durationSeconds"],
  additionalProperties: false,
});

const analyzeAudioArgsSchema = objectSchema({
  description: "Analyze recent SID playback when a verification-style request is detected.",
  properties: {
    wavPath: optionalSchema(stringSchema({ minLength: 1 })),
    request: optionalSchema(stringSchema({
      description: "Verification goal wording; \"does it sound right\" requests add a verdict.",
      minLength: 1,
    }), "analyze the SID output"),
    durationSeconds: optionalSchema(numberSchema({
      description: "Override capture duration in seconds.",
      minimum: 0.5,
      maximum: 30,
    })),
    expectedSidwave: optionalSchema(sidwaveSourceSchema),
  },
  additionalProperties: false,
});

function parseIntervals(pattern: string): number[] {
  const intervals = pattern
    .split(/[\s,]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));

  if (intervals.length === 0) {
    throw new ToolValidationError("Pattern must contain at least one semitone offset", { path: "$.pattern" });
  }
  return intervals;
}

/** Highest frequency the SID's 16-bit frequency register can produce (about 3848 Hz PAL, 3995 Hz NTSC). */
/**
 * The SID frequency tables differ for PAL and NTSC. When the caller gives no system, read the KERNAL
 * PAL/NTSC flag at $02A6 (1 = PAL, 0 = NTSC; Mapping the Commodore 64) from the active machine, which
 * works the same on Ultimate hardware and VICE, and say where the value came from.
 */
export async function resolveSidSystem(
  ctx: ToolExecutionContext,
  given: "PAL" | "NTSC" | undefined,
  facade?: PinnedFacade,
): Promise<{ system: "PAL" | "NTSC"; source: string }> {
  if (given) return { system: given, source: "given" };
  try {
    const flag = (await ctx.client.readMemoryRaw(0x02a6, 1, facade))[0];
    if (flag === 0) return { system: "NTSC", source: "read from the machine ($02A6 = 0)" };
    if (flag === 1) return { system: "PAL", source: "read from the machine ($02A6 = 1)" };
  } catch {
    // Fall through to the default below.
  }
  return { system: "PAL", source: "default PAL; $02A6 could not be read" };
}

function maxSidFrequencyHz(system: "PAL" | "NTSC"): number {
  return (0xffff * (system === "PAL" ? 985_248 : 1_022_727)) / 16_777_216;
}

/** Reject a note or frequency the SID cannot play instead of letting playback clamp or skip it. */
function assertPlayableFrequency(hz: number, label: string, system: "PAL" | "NTSC", path: string): void {
  const max = maxSidFrequencyHz(system);
  if (hz > max + 0.5) {
    throw new ToolValidationError(`${label} (${hz.toFixed(1)} Hz) is above the SID's highest ${system} frequency of ${max.toFixed(1)} Hz`, { path });
  }
}

function noteHz(note: string): number {
  const midi = noteNameToMidi(note);
  return midi === undefined ? Number.NaN : midiToHz(midi);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

type AudioAnalyzer = (options: {
  durationSeconds: number;
  expectedSidwave?: string | Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<Awaited<ReturnType<typeof recordAndAnalyzeAudio>>>;

function resolveAnalyzer(ctx: ToolExecutionContext): AudioAnalyzer {
  const candidate = (ctx.client as { recordAndAnalyzeAudio?: unknown } | undefined)?.recordAndAnalyzeAudio;
  if (typeof candidate === "function") {
    return (options) => {
      ctx.signal?.throwIfAborted();
      return (candidate as AudioAnalyzer).call(ctx.client, { ...options, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    };
  }
  return (options) => recordAndAnalyzeAudio({ ...options, ...(ctx.signal ? { signal: ctx.signal } : {}) });
}

function audioMeasurementError(ctx: ToolExecutionContext, error: unknown) {
  const verification = noAudioMeasurement(ctx.platform?.id ?? getPlatformStatus().id, error);
  const result = toolErrorResult(new ToolExecutionError(verification.message, {
    cause: error instanceof Error ? error : undefined,
  }));
  return { ...textResult(verification.message, { ...result.metadata, verification }), isError: true as const };
}

/**
 * Measure whether the SID is silent by capturing audio (the Ultimate audio
 * stream on C64U, otherwise the host microphone). The SID's control registers
 * are write-only, so reading them back cannot show whether a voice sounds.
 */
export async function measureSidSilence(ctx: ToolExecutionContext): Promise<{ silent: boolean; averageRms: number; maxRms: number; threshold: number }> {
  if (DEFAULT_SILENCE_VERIFY_WAIT_MS > 0) {
    await sleep(DEFAULT_SILENCE_VERIFY_WAIT_MS);
  }
  const analysis = await resolveAnalyzer(ctx)({ durationSeconds: DEFAULT_SILENCE_VERIFY_DURATION_SECONDS });
  const { average, max } = extractRmsMetrics((analysis?.analysis?.global_metrics ?? {}) as Record<string, unknown>);
  if (average === null && max === null) {
    throw new ToolExecutionError("Audio analysis did not provide RMS metrics for silence verification");
  }
  const maxRms = max ?? average ?? 0;
  return {
    silent: maxRms <= DEFAULT_SILENCE_VERIFY_RMS_THRESHOLD,
    averageRms: average ?? maxRms,
    maxRms,
    threshold: DEFAULT_SILENCE_VERIFY_RMS_THRESHOLD,
  };
}

function extractRmsMetrics(globalMetrics: Record<string, unknown>): { average: number | null; max: number | null } {
  const average = typeof globalMetrics.average_rms === "number" ? globalMetrics.average_rms : null;
  const max = typeof globalMetrics.max_rms === "number" ? globalMetrics.max_rms : null;
  return { average, max };
}

function normaliseSidwaveInput(input?: string | Record<string, unknown>): string | Record<string, unknown> | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (input && typeof input === "object") {
    return input;
  }
  return undefined;
}

function generateAudioFeedback(analysisResult: unknown, userRequest: string): string {
  try {
    const analysis = (analysisResult as Record<string, any> | undefined)?.analysis;
    if (!analysis) {
      return "Audio analysis completed but no musical content was detected. Ensure the C64 is playing audio.";
    }

    const voices = Array.isArray(analysis.voices) ? analysis.voices : [];
    const globalMetrics = (analysis.global_metrics ?? {}) as Record<string, unknown>;

    let feedback = `Audio analysis of the mixed SID output over ${Math.round((analysis.durationSeconds ?? 0) * 10) / 10}s (voices are not separated):\n\n`;

    voices.forEach((voice: any, index: number) => {
      const notes = Array.isArray(voice?.detected_notes) ? voice.detected_notes : [];
      const validNotes = notes.filter((n: any) => n?.note && n?.frequency);
      const voiceId = voice?.id ?? index + 1;
      const label = voiceId === 0 ? "Mix" : `Voice ${voiceId}`;

      if (validNotes.length > 0) {
        const preview = validNotes.slice(0, 5).map((n: any) => `${n.note}(${Math.round(n.frequency)}Hz)`);
        const extra = validNotes.length > preview.length ? "..." : "";
        feedback += `${label}: ${validNotes.length} note(s) - ${preview.join(", ")}${extra}`;
        if (typeof voice?.average_deviation === "number") {
          feedback += ` [avg deviation: ${Math.round(voice.average_deviation * 10) / 10} cents]`;
        }
        feedback += "\n";
      } else {
        feedback += `${label}: No clear notes detected\n`;
      }
    });

    if (typeof globalMetrics.average_pitch_deviation === "number") {
      feedback += `\nOverall pitch accuracy: ${Math.round(globalMetrics.average_pitch_deviation * 10) / 10} cents deviation`;
    }
    if (typeof globalMetrics.detected_bpm === "number") {
      feedback += `\nDetected tempo: ${Math.round(globalMetrics.detected_bpm)} BPM`;
    }

    if (/(sound.*right|sound.*good|sound.*correct)/.test(userRequest.toLowerCase())) {
      const rawDeviation = globalMetrics.average_pitch_deviation;
      const notesDetected = voices.some((voice: any) =>
        Array.isArray(voice?.detected_notes) && voice.detected_notes.some((n: any) => n?.note && n?.frequency));
      const deviation = typeof rawDeviation === "number" && Number.isFinite(rawDeviation) ? Math.abs(rawDeviation) : 0;
      if (typeof rawDeviation !== "number" || !Number.isFinite(rawDeviation) || !notesDetected) {
        feedback += "\n\nNo audio was detected, so there is no verdict on the music. Check that the SID is playing and the audio source is connected.";
      } else if (deviation < 20) {
        feedback += "\n\n✓ The music sounds accurate with good pitch stability.";
      } else if (deviation < 50) {
        feedback += "\n\n⚠ The music has some pitch variation but is generally recognizable.";
      } else {
        feedback += "\n\n✗ The music shows significant pitch deviation - check SID programming or playback.";
      }
    }

    return feedback;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Audio feedback generation failed: ${message}`;
  }
}

export const audioModule = defineToolModule({
  domain: "audio",
  summary: "SID composition, playback, and audio analysis workflows.",
  resources: [
    "c64://sound/sid/spec",
    "c64://sound/sidwave/spec",
    "c64://sound/sid/file-format",
  ],
  prompts: ["sid-music"],
  defaultTags: ["sid", "audio"],
  supportedPlatforms: ["c64u", "u2", "vice"] as const,
  workflowHints: [
    "Reach for SID helpers when the user talks about sound design, playback quality, or stuck notes.",
    "After changing playback state, suggest verify-by-ear steps such as analyze_audio so the user gets concrete feedback.",
  ],
  tools: [
    {
      name: "sid_volume",
      description: "Set the SID master volume register at $D418. See c64://sound/sid/spec.",
      summary: "Clamps the requested volume and writes it to the SID master volume register.",
      inputSchema: sidVolumeArgsSchema.jsonSchema,
      tags: ["sid", "control"],
      prerequisites: [],
      examples: [
        { name: "Set volume", description: "Volume 12", arguments: { volume: 12 } },
      ],
      workflowHints: [
        "Adjust volume when the user mentions level issues and remind them the valid range is 0-15.",
        "Offer to run analyze_audio if the listener still cannot confirm the change.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = sidVolumeArgsSchema.parse(args ?? {});
          const appliedVolume = Math.max(0, Math.min(15, Math.floor(parsed.volume)));
          ctx.logger.info("Setting SID master volume", {
            requested: parsed.volume,
            applied: appliedVolume,
          });

          const result = await ctx.client.sidSetVolume(parsed.volume, undefined, parsed.filterMode === undefined ? undefined : { filterMode: parsed.filterMode });
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while setting SID volume", {
              details: normaliseFailure(result.details),
            });
          }

          const detailRecord = toRecord(result.details) ?? {};
          const address = normaliseAddress(detailRecord.address, "$D418");

          const notice = typeof detailRecord.notice === "string" ? ` ${detailRecord.notice}` : "";
          return textResult(`SID master volume set to ${appliedVolume}.${notice}`, {
            success: true,
            requestedVolume: parsed.volume,
            appliedVolume,
            address,
            bytes: detailRecord.bytes ?? null,
            details: detailRecord,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "sid_reset",
      description: "Reset the SID chip either softly (silence) or with a full register scrub.",
      summary: "Invokes the Ultimate firmware to silence or fully reset SID registers.",
      inputSchema: sidResetArgsSchema.jsonSchema,
      tags: ["sid", "control"],
      prerequisites: [],
      examples: [
        { name: "Hard reset", description: "Full register scrub", arguments: { hard: true } },
      ],
      workflowHints: [
        "Use after glitches or hanging notes and tell the user whether you performed a soft or hard reset.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = sidResetArgsSchema.parse(args ?? {});
          ctx.logger.info("Resetting SID", { mode: parsed.hard ? "hard" : "soft" });

          await cancelGeneratedSidPlayback(ctx.client);
          const result = await ctx.client.sidReset(parsed.hard);
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while resetting SID", {
              details: normaliseFailure(result.details),
            });
          }

          const detailRecord = toRecord(result.details) ?? {};

          return textResult(`SID ${parsed.hard ? "hard" : "soft"} reset completed.`, {
            success: true,
            mode: parsed.hard ? "hard" : "soft",
            details: detailRecord,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "sid_note_on",
      description: "Trigger a SID voice with configurable waveform, pulse width, and ADSR envelope. See c64://sound/sid/spec.",
      summary: "Resolves note or frequency, clamps parameters, and writes the SID voice registers.",
      inputSchema: sidNoteOnArgsSchema.jsonSchema,
      tags: ["sid", "control", "music", "pal-ntsc"],
      prerequisites: ["sid_volume"],
      examples: [
        { name: "Note on", description: "Voice 1 C4 triangle", arguments: { voice: 1, note: "C4", waveform: "tri" } },
      ],
      workflowHints: [
        "Invoke when the user wants to audition a single voice; summarise waveform, ADSR, and pitch afterwards.",
        "Translate note descriptions into frequencies yourself if the request is ambiguous.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = sidNoteOnArgsSchema.parse(args ?? {});
          await cancelGeneratedSidPlayback(ctx.client);
          const voice = Math.max(1, Math.min(3, Math.floor(parsed.voice ?? 1))) as 1 | 2 | 3;
          const { system, source: systemSource } = await resolveSidSystem(ctx, parsed.system as "PAL" | "NTSC" | undefined);
          if (parsed.note) {
            assertPlayableFrequency(noteHz(parsed.note), parsed.note, system, "$.note");
          } else if (parsed.frequencyHz !== undefined) {
            assertPlayableFrequency(parsed.frequencyHz, `${parsed.frequencyHz} Hz`, system, "$.frequencyHz");
          }
          ctx.logger.info("Starting SID voice", {
            voice,
            note: parsed.note ?? null,
            frequencyHz: parsed.frequencyHz ?? null,
            waveform: parsed.waveform,
          });

          const result = await ctx.client.sidNoteOn({
            voice,
            note: parsed.note ?? undefined,
            frequencyHz: parsed.frequencyHz ?? undefined,
            system,
            waveform: (parsed.waveform ?? "pulse") as "pulse" | "saw" | "tri" | "noise",
            pulseWidth: parsed.pulseWidth,
            attack: parsed.attack,
            decay: parsed.decay,
            sustain: parsed.sustain,
            release: parsed.release,
          });
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while starting SID voice", {
              details: normaliseFailure(result.details),
            });
          }

          const detailRecord = toRecord(result.details) ?? {};
          const systemNote = `Using ${system} timing (${systemSource}).`;
          const volumeSet = detailRecord.volumeSet === 15 ? " Master volume was set to 15 because it was muted." : "";

          return textResult(`Started SID voice ${voice}${parsed.note ? ` with note ${parsed.note.toUpperCase()}` : ""}.${volumeSet} ${systemNote}`, {
            success: true,
            voice,
            note: parsed.note ?? null,
            frequencyHz: parsed.frequencyHz ?? null,
            system,
            systemSource,
            systemReminder: "$02A6 holds the KERNAL PAL/NTSC flag: 1 = PAL, 0 = NTSC",
            waveform: parsed.waveform ?? "pulse",
            pulseWidth: parsed.pulseWidth,
            envelope: {
              attack: parsed.attack,
              decay: parsed.decay,
              sustain: parsed.sustain,
              release: parsed.release,
            },
            details: detailRecord,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "sid_note_off",
      description: "Release a SID voice by clearing its GATE bit.",
      summary: "Clears the GATE bit of the voice control register, keeping the waveform last sent by note_on so the release phase is heard.",
      inputSchema: sidNoteOffArgsSchema.jsonSchema,
      tags: ["sid", "control", "music"],
      prerequisites: ["sid_note_on"],
      examples: [
        { name: "Note off", description: "Release voice 1", arguments: { voice: 1 } },
      ],
      workflowHints: [
        "Stop individual voices after prior note_on calls and confirm which voice you released.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = sidNoteOffArgsSchema.parse(args ?? {});
          await cancelGeneratedSidPlayback(ctx.client);
          const voice = Math.max(1, Math.min(3, Math.floor(parsed.voice))) as 1 | 2 | 3;
          ctx.logger.info("Stopping SID voice", { voice });

          const result = await ctx.client.sidNoteOff(voice);
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while stopping SID voice", {
              details: normaliseFailure(result.details),
            });
          }

          const detailRecord = toRecord(result.details) ?? {};

          return textResult(`Released SID voice ${voice}.`, {
            success: true,
            voice,
            details: detailRecord,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "sid_silence_all",
      description: "Silence all SID voices by clearing control and envelope registers.",
      summary: "Performs a soft reset of SID voices, ensuring audio output stops.",
      inputSchema: sidSilenceArgsSchema.jsonSchema,
      tags: ["sid", "control"],
      prerequisites: [],
      examples: [
        { name: "Silence", description: "Stop all voices", arguments: {} },
      ],
      workflowHints: [
        "Run when the user asks to stop all audio or before switching to a new composition.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = sidSilenceArgsSchema.parse(args ?? {});
          const verify = Boolean(parsed.verify);

          ctx.logger.info("Silencing all SID voices", { verify });

          await cancelGeneratedSidPlayback(ctx.client);
          const result = await ctx.client.sidSilenceAll();
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while silencing SID", {
              details: normaliseFailure(result.details),
            });
          }

          const detailRecord = toRecord(result.details) ?? {};

          if (!verify) {
            return textResult("SID voices silenced.", {
              success: true,
              details: detailRecord,
              verify: false,
              verification: null,
            });
          }

          ctx.logger.info("Verifying SID silence via audio capture", {
            durationSeconds: DEFAULT_SILENCE_VERIFY_DURATION_SECONDS,
            waitBeforeCaptureMs: DEFAULT_SILENCE_VERIFY_WAIT_MS,
            rmsThreshold: DEFAULT_SILENCE_VERIFY_RMS_THRESHOLD,
          });

          const analyzer = resolveAnalyzer(ctx);

          if (DEFAULT_SILENCE_VERIFY_WAIT_MS > 0) {
            await sleep(DEFAULT_SILENCE_VERIFY_WAIT_MS);
          }

          let analysis: Awaited<ReturnType<AudioAnalyzer>>;
          try {
            analysis = await analyzer({ durationSeconds: DEFAULT_SILENCE_VERIFY_DURATION_SECONDS });
          } catch (error) {
            if (ctx.signal?.aborted) return cancelledResult();
            const verification = noAudioMeasurement(ctx.platform?.id ?? getPlatformStatus().id, error);
            return textResult(`SID voices silenced. ${verification.message}`, {
              success: true,
              details: detailRecord,
              verify: true,
              verification,
            });
          }

          const globalMetrics = (analysis?.analysis?.global_metrics ?? {}) as Record<string, unknown>;
          const { average, max } = extractRmsMetrics(globalMetrics);

          if (average === null && max === null) {
            return audioMeasurementError(ctx, new Error("Audio analysis did not provide RMS metrics for silence verification"));
          }

          const averageRms = average ?? max ?? 0;
          const maxRms = max ?? average ?? 0;
          const silent = maxRms <= DEFAULT_SILENCE_VERIFY_RMS_THRESHOLD;

          ctx.logger.info("Silence verification completed", {
            silent,
            averageRms,
            maxRms,
            threshold: DEFAULT_SILENCE_VERIFY_RMS_THRESHOLD,
          });

          const verification = {
            silent,
            durationSeconds: analysis?.analysis?.durationSeconds ?? DEFAULT_SILENCE_VERIFY_DURATION_SECONDS,
            waitBeforeCaptureMs: DEFAULT_SILENCE_VERIFY_WAIT_MS,
            threshold: DEFAULT_SILENCE_VERIFY_RMS_THRESHOLD,
            averageRms,
            maxRms,
            analysis,
          } as const;

          if (!silent) {
            throw new ToolExecutionError("SID silence verification detected residual audio above threshold", {
              details: verification,
            });
          }

          const message = `SID voices silenced. Verified silence (max RMS ${maxRms.toFixed(3)} <= ${DEFAULT_SILENCE_VERIFY_RMS_THRESHOLD.toFixed(3)}).`;

          return textResult(message, {
            success: true,
            details: detailRecord,
            verify: true,
            verification,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "sidplay_file",
      description: "Play a SID file stored on the Ultimate filesystem via the firmware player.",
      summary: "Instructs the SID player to load the given file and optional song number.",
      inputSchema: sidplayFileArgsSchema.jsonSchema,
      relatedResources: ["c64://sound/sid/spec"],
      tags: ["sid", "playback"],
      prerequisites: ["drives_list"],
      examples: [
        { name: "Play SID", description: "song 0", arguments: { path: "//USB0/tune.sid", songnr: 0 } },
      ],
      workflowHints: [
        "Use when the user references an existing SID file path; surface song numbers if the firmware reports them.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = sidplayFileArgsSchema.parse(args ?? {});
          await cancelGeneratedSidPlayback(ctx.client);
          ctx.logger.info("Playing SID file", { path: parsed.path, songnr: parsed.songnr ?? null });

          const result = await ctx.client.sidplayFile(parsed.path, parsed.songnr);
          if (result.success) clearViceSymbols(); // labels belong to one program
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while starting SID playback", {
              details: normaliseFailure(result.details),
            });
          }

          const details = toRecord(result.details) ?? {};
          return textResult(`SID file ${parsed.path} queued for playback.`, {
            success: true,
            path: parsed.path,
            songnr: parsed.songnr ?? null,
            details,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "modplay_file",
      description: "Play a MOD tracker module stored on the Ultimate filesystem.",
      summary: "Sends the module to the Ultimate SID player and starts playback.",
      inputSchema: modplayFileArgsSchema.jsonSchema,
      relatedResources: ["c64://sound/sid/spec"],
      tags: ["sid", "playback"],
      prerequisites: ["drives_list"],
      examples: [
        { name: "Play MOD", description: "module.mod", arguments: { path: "//USB0/module.mod" } },
      ],
      workflowHints: [
        "Trigger for MOD playback requests and confirm the module path is reachable on Ultimate storage.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = modplayFileArgsSchema.parse(args ?? {});
          await cancelGeneratedSidPlayback(ctx.client);
          ctx.logger.info("Playing MOD file", { path: parsed.path });

          const result = await ctx.client.modplayFile(parsed.path);
          if (result.success) clearViceSymbols(); // labels belong to one program
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while starting MOD playback", {
              details: normaliseFailure(result.details),
            });
          }

          const details = toRecord(result.details) ?? {};
          return textResult(`MOD file ${parsed.path} queued for playback.`, {
            success: true,
            path: parsed.path,
            details,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "music_generate",
      description: MUSIC_GENERATE_DESCRIPTION,
      summary: "Plays a seeded three-voice composition as a PRG.",
      inputSchema: musicGenerateArgsSchema.jsonSchema,
      relatedResources: ["c64://sound/sidwave/spec"],
      relatedPrompts: ["sid-music"],
      tags: ["sid", "music", "generator", "pal-ntsc"],
      examples: [
        { name: "Chiptune", description: "An eight-bar piece", arguments: {} },
        { name: "Ambient in D", description: "A seeded ambient arrangement", arguments: { root: "D4", style: "ambient", seed: 9 } },
      ],
      async execute(args, ctx) {
        try {
          const parsed = musicGenerateArgsSchema.parse(args ?? {});
          const intervals = parsed.pattern === undefined ? undefined : parseIntervals(parsed.pattern);
          const facade = await ctx.client.pinFacade?.();
          const { system, source: systemSource } = await resolveSidSystem(ctx, parsed.system as "PAL" | "NTSC" | undefined, facade);
          const style = parsed.style as MusicStyle;
          const preset = parsed.preset as "classic" | "expression";
          const { score, key, progression, tempo, bars, speed, leadTimeline } = generateSidwave({
            ...parsed, intervals, system, style, preset,
            waveform: parsed.waveform as "pulse" | "saw" | "tri" | "noise" | undefined,
          });
          for (const { note } of leadTimeline) assertPlayableFrequency(noteHz(note), note, system, "$.root");
          const sidwave = JSON.stringify(score);
          const document = parseSidwave(sidwave, hostSidwaveReadOptions);
          const compiled = compileSidwaveToPrg(document, { loop: false });
          const backend = facade?.type ?? ctx.platform?.id ?? getPlatformStatus().id;
          const warnings = [...compiled.warnings, ...playbackSetupWarnings(document, backend, parsed.configure)];
          await cancelGeneratedSidPlayback(ctx.client);
          const started = startCompiledSidwave(ctx.client, document, compiled, backend, { configure: parsed.configure, facade }).then((result) => {
            if (!result.success) throw new ToolExecutionError("C64 backend reported failure while running compiled PRG", {
              details: normaliseFailure(result.details),
            });
            clearViceSymbols();
          });
          const playback = { facade, started };
          generatedPlaybacks.set(ctx.client, playback);
          try {
            await started;
          } catch (error) {
            if (generatedPlaybacks.get(ctx.client) === playback) generatedPlaybacks.delete(ctx.client);
            throw error;
          }

          return textResult(`Playing ${bars} ${bars === 1 ? "bar" : "bars"} of ${style} in ${key} at ${tempo} BPM (${progression.join("–")}, seed ${parsed.seed}).`, {
            success: true,
            key, progression, tempo, style, seed: parsed.seed, bars, speed,
            styleExampleUri: `${SIDWAVE_EXAMPLES_URI}/${{ ambient: "ambient_filter", chiptune: "chiptune_drive", funk: "funk_bass" }[style]}`,
            ...(parsed.includeScore ? { sidwave } : {}),
            root: parsed.root, intervals, steps: parsed.steps ?? (leadTimeline.length || undefined),
            tempoMs: parsed.tempoMs, waveform: parsed.waveform ?? "pulse", preset, system, systemSource,
            durationSeconds: compiled.totalFrames / compiled.framesPerSecond,
            ...(parsed.includeScore && leadTimeline.length ? { timeline: leadTimeline } : {}),
            prgSize: compiled.prg.length,
            ...(warnings.length ? { warnings } : {}),
          });
        } catch (error) {
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "music_compile_and_play",
      description: "Compile a SIDWAVE composition to PRG or SID and optionally play it immediately.",
      summary: "Parses SIDWAVE/CPG input, compiles to a PRG, and plays via PRG or SID attachment.",
      inputSchema: musicCompileArgsSchema.jsonSchema,
      relatedResources: ["c64://sound/sid/spec", "c64://sound/sidwave/spec", "c64://sound/sid/file-format"],
      relatedPrompts: ["sid-music"],
      tags: ["sid", "music", "compiler"],
      prerequisites: [],
      examples: [
        {
          name: "Compile PRG",
          description: "Play compiled PRG",
          arguments: {
            sidwave: "sidwave: 1.0\ntitle: Demo\ntempo: 120\nmode: PAL\nvoices:\n  - id: 1\n    waveform: triangle\n    patterns: { A: { groove: [C4, E4, G4, C5] } }\ntimeline:\n  - { bars: 2, layers: { v1: A } }\n",
            output: "prg",
            dryRun: false,
          },
        },
      ],
      workflowHints: [
        "Use when the user provides SIDWAVE/CPG scores or asks for export to PRG/SID; share any generated download URIs in your response.",
        "Suggest analyze_audio afterwards if they want objective feedback on the compiled performance.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = musicCompileArgsSchema.parse(args ?? {});
          const source = normaliseSidwaveInput(parsed.sidwave) ?? normaliseSidwaveInput(parsed.cpg);
          if (!source) {
            throw new ToolValidationError("Provide sidwave or cpg source", { path: "$.sidwave" });
          }

          const outputFormat = parsed.output ?? "prg";
          const platform = ctx.platform?.id ?? getPlatformStatus().id;
          if (outputFormat === "sid" && !parsed.dryRun && platform === "vice") {
            throw new ToolUnsupportedPlatformError("sidplay_attachment (use output: prg or dryRun: true on VICE)", platform, ["c64u", "u2"]);
          }

          ctx.logger.info("Compiling SIDWAVE composition", {
            output: outputFormat,
            dryRun: parsed.dryRun,
          });

          const document = parseSidwave(source, hostSidwaveReadOptionsFor());
          if (!parsed.dryRun && platform === "vice") validateViceSidwaveMap(document);
          const compiled = compileSidwaveToPrg(document);
          const sidFile = outputFormat === "sid" ? compileSidwaveToSid(document, compiled.prg, { entryAddress: compiled.entryAddress }) : undefined;
          let outputFile: string | undefined;
          if (parsed.outputPath) {
            outputFile = resolveHostPath(parsed.outputPath, { purpose: "write" });
            await mkdir(dirname(outputFile), { recursive: true });
            await writeFile(outputFile, sidFile ? sidFile.sid : compiled.prg);
          }

          let ranOnC64 = false;
          let runDetails: Record<string, unknown> | null = null;

          if (!parsed.dryRun) {
            await cancelGeneratedSidPlayback(ctx.client);
            const result = await startCompiledSidwave(ctx.client, document, compiled, platform, {
              configure: parsed.configure,
              sid: sidFile?.sid,
            });
            if (!result.success) throw new ToolExecutionError("C64 backend reported failure while playing SIDWAVE", {
              details: normaliseFailure(result.details),
            });
            clearViceSymbols();
            ranOnC64 = true;
            runDetails = toRecord(result.details) ?? null;
          }
          const warnings = [...compiled.warnings, ...playbackSetupWarnings(document, platform, !parsed.dryRun && parsed.configure)];

          const durationSeconds = Math.round((compiled.totalFrames / compiled.framesPerSecond) * 10) / 10;
          const entry = `$${compiled.entryAddress.toString(16).toUpperCase().padStart(4, "0")}`;
          const message = `Compiled '${document.song.title}' to ${outputFormat.toUpperCase()}${parsed.dryRun ? " (dry run)" : ""}: ${compiled.prg.length} bytes, ${durationSeconds} s per loop (${compiled.totalFrames} frames at ${Math.round(compiled.framesPerSecond * 100) / 100} Hz), PRG entry ${entry} (SYS ${compiled.entryAddress})${outputFile ? `, written to ${outputFile}` : ""}.`;
          const voiceSummaries = document.voices.map((voice) => ({
            id: voice.id,
            name: voice.name,
            waveform: voice.waveform,
            pulse_width: voice.pulse_width,
            adsr: voice.adsr,
          }));

          // Warnings (for example a PRG that leaves no room for BASIC) go into the text that clients show.
          const warningText = warnings.length > 0 ? `\nWarning: ${warnings.join("\nWarning: ")}` : "";
          return textResult(`${message}${warningText}`, {
            success: true,
            ranOnC64,
            dryRun: parsed.dryRun,
            format: outputFormat,
            prgSize: compiled.prg.length,
            ...(sidFile ? { sidSize: sidFile.sid.length } : {}),
            ...(outputFile ? { outputPath: outputFile } : {}),
            totalFrames: compiled.totalFrames,
            framesPerSecond: compiled.framesPerSecond,
            durationSeconds,
            entryAddress: compiled.entryAddress,
            basicFreeBytes: compiled.basicFreeBytes,
            worstCaseCyclesPerCall: compiled.worstCaseCyclesPerCall,
            streamBytes: compiled.streamBytes,
            ...(compiled.arrangement ? { arrangement: compiled.arrangement, loopTo: compiled.loopTo, lint: compiled.lint } : {}),
            ...(document.samples && {
              sampleDefinitions: compiled.sampleDefinitions,
              sampleBytes: compiled.sampleBytes,
              bytesBelowD000: compiled.bytesBelowD000,
              digiCyclesPerCall: compiled.digiCyclesPerCall,
              digiWorstCaseCyclesPerNmi: compiled.digiWorstCaseCyclesPerNmi,
            }),
            warnings,
            song: document.song,
            voices: voiceSummaries,
            runDetails,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "record_and_analyze_audio",
      description: "Record audio and analyze SID playback characteristics. On the c64u backend the audio comes from the Ultimate audio stream; on other backends it is recorded from the host default input device (microphone).",
      summary: "Captures PCM data, extracts notes, tempo, and deviation metrics for SID verification workflows.",
      inputSchema: recordAndAnalyzeArgsSchema.jsonSchema,
      relatedResources: ["c64://sound/sid/spec", "c64://sound/sid/file-format"],
      relatedPrompts: ["sid-music"],
      tags: ["sid", "analysis"],
      prerequisites: [],
      examples: [
        { name: "Analyze 3s", description: "Quick capture", arguments: { durationSeconds: 3 } },
      ],
      workflowHints: [
        "Recommend after playback when the user wants tuning confirmation; mention capture duration in your summary.",
        "If the user sounded uncertain about audio quality, run this proactively for objective metrics.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = recordAndAnalyzeArgsSchema.parse(args ?? {});
          if (ctx.signal?.aborted) return cancelledResult();
          ctx.logger.info("Recording audio for analysis", { durationSeconds: parsed.durationSeconds });

          const analyzer = resolveAnalyzer(ctx);
          const result = await analyzer({
            durationSeconds: parsed.durationSeconds,
            expectedSidwave: normaliseSidwaveInput(parsed.expectedSidwave),
          });

          return jsonResult(result, {
            success: true,
            durationSeconds: result.analysis?.durationSeconds ?? parsed.durationSeconds,
            voices: result.analysis?.voices ?? [],
            globalMetrics: result.analysis?.global_metrics ?? {},
          });
        } catch (error) {
          if (ctx.signal?.aborted) return cancelledResult("Audio recording was cancelled by the client.");
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          const executionError = new ToolExecutionError(
            error instanceof Error ? error.message : String(error),
            { cause: error instanceof Error ? error : undefined },
          );
          return toolErrorResult(executionError);
        }
      },
    },
    {
      name: "analyze_audio",
      description: "Record a short clip (default 3 s) of the SID output and return the detected notes, pitch deviation, tempo and level.",
      summary: "Records a short clip and returns musical feedback; requests such as 'does it sound right' add a verdict.",
      inputSchema: analyzeAudioArgsSchema.jsonSchema,
      relatedResources: ["c64://sound/sid/spec", "c64://sound/sid/file-format"],
      relatedPrompts: ["sid-music"],
      tags: ["sid", "analysis"],
      prerequisites: [],
      examples: [
        { name: "Check music", description: "Verify by ear", arguments: { request: "does the music sound right?" } },
      ],
      workflowHints: [
        "Invoke when the user asks to check or verify the music so you can return measured results.",
        "Translate the analysis into concrete next steps like ADSR or tempo tweaks in your response.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = analyzeAudioArgsSchema.parse(args ?? {});
          if (ctx.signal?.aborted) return cancelledResult();
          const request = parsed.request ?? "analyze the SID output";
          const duration = parsed.durationSeconds ?? 3;
          ctx.logger.info("Auto-analyzing SID audio", { durationSeconds: duration });

          let analysis: Awaited<ReturnType<AudioAnalyzer>>;
          const expected = normaliseSidwaveInput(parsed.expectedSidwave);
          if (parsed.wavPath) {
            const { data, rate } = readPcmFile(parsed.wavPath, undefined, hostSidwaveFileReader);
            if (!data.length) throw new ToolValidationError("WAV contains no audio frames");
            const limit = Math.max(1, Math.floor((parsed.durationSeconds ?? 120) * rate));
            analysis = await analyzePcm(Float32Array.from(data.subarray(0, limit)), rate, "wav", expected, undefined, ctx.signal);
          } else {
            try {
              analysis = await resolveAnalyzer(ctx)({ durationSeconds: duration, expectedSidwave: expected });
            } catch (error) {
              if (ctx.signal?.aborted) return cancelledResult("Audio recording was cancelled by the client.");
              return audioMeasurementError(ctx, error);
            }
          }
          const metrics = analysis?.analysis?.global_metrics;
          const { average, max } = extractRmsMetrics(metrics ?? {});
          const hasMusicalMeasurement = Number.isFinite(metrics?.average_pitch_deviation)
            || Number.isFinite(metrics?.detected_bpm)
            || analysis?.analysis?.voices?.some((voice) => voice.detected_notes.some((note) => Number.isFinite(note.frequency)));
          if (average === null && max === null && !hasMusicalMeasurement) {
            const verification = noAudioMeasurement(ctx.platform?.id ?? getPlatformStatus().id,
              "Audio analysis found no musical content or RMS measurements.");
            return textResult(verification.message, { analyzed: false, request, verification });
          }

          const feedback = generateAudioFeedback(analysis, request);
          return textResult(feedback, {
            analyzed: true,
            request,
            durationSeconds: analysis.analysis?.durationSeconds ?? duration,
            analysis,
          });
        } catch (error) {
          if (ctx.signal?.aborted) return cancelledResult("Audio recording was cancelled by the client.");
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          const executionError = new ToolExecutionError(
            error instanceof Error ? error.message : String(error),
            { cause: error instanceof Error ? error : undefined },
          );
          return toolErrorResult(executionError);
        }
      },
    },
  ],
});
