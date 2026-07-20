import { compileSidwaveToPrg, compileSidwaveToSid } from "../sidwaveCompiler.js";
import { parseSidwave } from "../sidwave.js";
import { recordAndAnalyzeAudio } from "../audio/record_and_analyze_audio.js";
import { defineToolModule, type JsonSchema, type ToolExecutionContext } from "./types.js";
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
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";

const NOTE_PATTERN = /^([A-Ga-g])([#b]?)(-?\d+)$/;

const DEFAULT_SILENCE_VERIFY_DURATION_SECONDS = 1.5;
const DEFAULT_SILENCE_VERIFY_RMS_THRESHOLD = 0.02;
const DEFAULT_SILENCE_VERIFY_WAIT_MS = 150;
const generatedPlaybacks = new Set<AbortController>();

export function cancelGeneratedSidPlayback(): void {
  for (const controller of generatedPlaybacks) controller.abort();
  generatedPlaybacks.clear();
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
      description: "Desired SID master volume. Values outside 0-15 are clamped.",
      minimum: 0,
      maximum: 15,
    }),
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
    system: stringSchema({
      description: "Video system for frequency calculation.",
      enum: ["PAL", "NTSC"],
      default: "PAL",
    }),
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
      description: "When true, record audio after silencing to confirm the SID output is quiet.",
      default: false,
    }), false),
  },
  additionalProperties: false,
});

const sidFileSchema = stringSchema({
  description: "Absolute or Ultimate filesystem path to the SID, PRG, or audio file.",
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

const musicGenerateArgsSchema = objectSchema({
  description: "Generate a simple arpeggio pattern and schedule playback on voice 1.",
  properties: {
    root: stringSchema({
      description: "Root note for the arpeggio such as C4 or A#3.",
      pattern: NOTE_PATTERN,
      default: "C4",
    }),
    pattern: stringSchema({
      description: "Comma-separated semitone offsets (e.g. '0,4,7').",
      minLength: 1,
      default: "0,4,7",
    }),
    steps: numberSchema({
      description: "Number of notes to schedule.",
      integer: true,
      minimum: 1,
      maximum: 128,
      default: 16,
    }),
    tempoMs: numberSchema({
      description: "Delay in milliseconds between notes.",
      integer: true,
      minimum: 20,
      maximum: 2000,
      default: 120,
    }),
    waveform: stringSchema({
      description: "Waveform for playback.",
      enum: ["pulse", "saw", "tri", "noise"],
      default: "tri",
    }),
    preset: optionalSchema(stringSchema({
      description: "Optional musical preset to influence timing/expression.",
      enum: ["classic", "expression"],
    }), "classic"),
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
    sidwave: optionalSchema(sidwaveSourceSchema),
    cpg: optionalSchema(sidwaveSourceSchema),
    format: optionalSchema(stringSchema({
      description: "Source format hint when providing raw text.",
      enum: ["yaml", "json"],
    })),
    output: optionalSchema(stringSchema({
      description: "Playback target format.",
      enum: ["prg", "sid"],
      default: "prg",
    }), "prg"),
    dryRun: optionalSchema(booleanSchema({
      description: "When true, skip playback and only return compilation metadata.",
      default: false,
    }), false),
  },
  additionalProperties: false,
});

const recordAndAnalyzeArgsSchema = objectSchema({
  description: "Record audio from the default input and analyze SID playback characteristics.",
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
    request: stringSchema({
      description: "Natural language user request describing the verification goal.",
      minLength: 1,
    }),
    durationSeconds: optionalSchema(numberSchema({
      description: "Override capture duration in seconds.",
      minimum: 0.5,
      maximum: 30,
    })),
    expectedSidwave: optionalSchema(sidwaveSourceSchema),
  },
  required: ["request"],
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

function transposeNote(note: string, semitones: number): string {
  const match = NOTE_PATTERN.exec((note ?? "").trim());
  if (!match) {
    return note;
  }

  const [, letterRaw, accidentalRaw, octaveRaw] = match;
  const letter = (letterRaw ?? "C").toUpperCase();
  const accidental = accidentalRaw ?? "";
  const octave = Number(octaveRaw ?? "0");
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let midi = (octave + 1) * 12 + (base[letter] ?? 0);
  if (accidental === "#") midi += 1;
  if (accidental === "b") midi -= 1;
  midi += semitones;
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const wrapped = ((midi % 12) + 12) % 12;
  const newOctave = Math.floor(midi / 12) - 1;
  return `${names[wrapped]!}${newOctave}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldAutoAnalyze(request: string): boolean {
  const lowered = request.toLowerCase();
  const actionMatch = /(check|verify|test|analyze|listen|hear)/.test(lowered);
  const subjectMatch = /(sid|audio|music|sound|song|play)/.test(lowered);
  const qualitativeMatch = /(does.*sound|how.*sound|sound.*right|sound.*good|sound.*correct)/.test(lowered);
  return (actionMatch && subjectMatch) || qualitativeMatch;
}

type AudioAnalyzer = (options: {
  durationSeconds: number;
  expectedSidwave?: string | Record<string, unknown>;
}) => Promise<Awaited<ReturnType<typeof recordAndAnalyzeAudio>>>;

function resolveAnalyzer(ctx: ToolExecutionContext): AudioAnalyzer {
  const candidate = (ctx.client as { recordAndAnalyzeAudio?: unknown } | undefined)?.recordAndAnalyzeAudio;
  if (typeof candidate === "function") {
    return (options) => (candidate as AudioAnalyzer).call(ctx.client, options);
  }
  return (options) => recordAndAnalyzeAudio(options);
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

    let feedback = `Audio analysis detected ${voices.length} voice(s) over ${Math.round((analysis.durationSeconds ?? 0) * 10) / 10}s:\n\n`;

    voices.forEach((voice: any, index: number) => {
      const notes = Array.isArray(voice?.detected_notes) ? voice.detected_notes : [];
      const validNotes = notes.filter((n: any) => n?.note && n?.frequency);
      const voiceId = voice?.id ?? index + 1;

      if (validNotes.length > 0) {
        const preview = validNotes.slice(0, 5).map((n: any) => `${n.note}(${Math.round(n.frequency)}Hz)`);
        const extra = validNotes.length > preview.length ? "..." : "";
        feedback += `Voice ${voiceId}: ${validNotes.length} note(s) - ${preview.join(", ")}${extra}`;
        if (typeof voice?.average_deviation === "number") {
          feedback += ` [avg deviation: ${Math.round(voice.average_deviation * 10) / 10} cents]`;
        }
        feedback += "\n";
      } else {
        feedback += `Voice ${voiceId}: No clear notes detected\n`;
      }
    });

    if (typeof globalMetrics.average_pitch_deviation === "number") {
      feedback += `\nOverall pitch accuracy: ${Math.round(globalMetrics.average_pitch_deviation * 10) / 10} cents deviation`;
    }
    if (typeof globalMetrics.detected_bpm === "number") {
      feedback += `\nDetected tempo: ${Math.round(globalMetrics.detected_bpm)} BPM`;
    }

    if (/(sound.*right|sound.*good|sound.*correct)/.test(userRequest.toLowerCase())) {
      const deviation = Math.abs((globalMetrics.average_pitch_deviation as number) ?? 0);
      if (deviation < 20) {
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

          const result = await ctx.client.sidSetVolume(parsed.volume);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while setting SID volume", {
              details: normaliseFailure(result.details),
            });
          }

          const detailRecord = toRecord(result.details) ?? {};
          const address = normaliseAddress(detailRecord.address, "$D418");

          return textResult(`SID master volume set to ${appliedVolume}.`, {
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

          cancelGeneratedSidPlayback(); // Reset is the documented way to stop a generated arpeggio.
          const result = await ctx.client.sidReset(parsed.hard);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while resetting SID", {
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
          const voice = Math.max(1, Math.min(3, Math.floor(parsed.voice ?? 1))) as 1 | 2 | 3;
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
            system: (parsed.system ?? "PAL") as "PAL" | "NTSC",
            waveform: (parsed.waveform ?? "pulse") as "pulse" | "saw" | "tri" | "noise",
            pulseWidth: parsed.pulseWidth,
            attack: parsed.attack,
            decay: parsed.decay,
            sustain: parsed.sustain,
            release: parsed.release,
          });
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while starting SID voice", {
              details: normaliseFailure(result.details),
            });
          }

          const detailRecord = toRecord(result.details) ?? {};
          const systemNote = parsed.system
            ? `Using ${parsed.system} timing.`
            : "Using default PAL timing. For NTSC, pass system: 'NTSC'. Check $02A6 memory location to verify system.";

          return textResult(`Started SID voice ${voice}${parsed.note ? ` with note ${parsed.note.toUpperCase()}` : ""}. ${systemNote}`, {
            success: true,
            voice,
            note: parsed.note ?? null,
            frequencyHz: parsed.frequencyHz ?? null,
            system: parsed.system ?? "PAL",
            systemReminder: "$02A6 contains PAL/NTSC flag (1=NTSC, 0=PAL)",
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
      summary: "Writes zero to the selected voice control register to stop playback.",
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
          const voice = Math.max(1, Math.min(3, Math.floor(parsed.voice))) as 1 | 2 | 3;
          ctx.logger.info("Stopping SID voice", { voice });

          const result = await ctx.client.sidNoteOff(voice);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while stopping SID voice", {
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

          cancelGeneratedSidPlayback(); // Otherwise its remaining notes would resume writing right after this silences the chip.
          const result = await ctx.client.sidSilenceAll();
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while silencing SID", {
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

          const analysis = await analyzer({
            durationSeconds: DEFAULT_SILENCE_VERIFY_DURATION_SECONDS,
          });

          const globalMetrics = (analysis?.analysis?.global_metrics ?? {}) as Record<string, unknown>;
          const { average, max } = extractRmsMetrics(globalMetrics);

          if (average === null && max === null) {
            throw new ToolExecutionError("Audio analysis did not provide RMS metrics for silence verification", {
              details: globalMetrics,
            });
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
          ctx.logger.info("Playing SID file", { path: parsed.path, songnr: parsed.songnr ?? null });

          const result = await ctx.client.sidplayFile(parsed.path, parsed.songnr);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while starting SID playback", {
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
          ctx.logger.info("Playing MOD file", { path: parsed.path });

          const result = await ctx.client.modplayFile(parsed.path);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while starting MOD playback", {
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
      description: "Generate a lightweight arpeggio and schedule playback on SID voice 1.",
      summary: "Builds a note timeline from semitone offsets and triggers SID playback asynchronously.",
      lifecycle: "fire-and-forget",
      inputSchema: musicGenerateArgsSchema.jsonSchema,
      relatedResources: ["c64://sound/sid/spec"],
      relatedPrompts: ["sid-music"],
      tags: ["sid", "music", "generator", "pal-ntsc"],
      prerequisites: ["sid_volume"],
      examples: [
        { name: "C major", description: "C4 arpeggio (triangle)", arguments: { root: "C4", pattern: "0,4,7", steps: 8, tempoMs: 120, waveform: "tri" } },
        { name: "Expressive C major", description: "C4 arpeggio with phrasing", arguments: { root: "C4", pattern: "0,4,7", steps: 8, preset: "expression" } },
      ],
      workflowHints: [
        "Offer as a quick inspiration loop when the user wants to hear something immediately; explain how to tweak pattern or tempo.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = musicGenerateArgsSchema.parse(args ?? {});
          const intervals = parseIntervals(parsed.pattern);
          const timeline: Array<{ t: number; note: string; durationMs: number }> = [];
          let timestamp = 0;
          const expressiveDurations = [250, 180, 180, 400];
          for (let i = 0; i < parsed.steps; i += 1) {
            const iv = intervals[i % intervals.length]!;
            const note = transposeNote(parsed.root, iv);
            const durationMs = parsed.preset === "expression" ? expressiveDurations[i % expressiveDurations.length]! : parsed.tempoMs;
            timeline.push({ t: timestamp, note, durationMs });
            timestamp += durationMs;
          }

          ctx.logger.info("Scheduling SID arpeggio", {
            root: parsed.root,
            intervals,
            steps: parsed.steps,
            tempoMs: parsed.tempoMs,
            waveform: parsed.waveform,
          });

          cancelGeneratedSidPlayback(); // Replace any prior generated arpeggio rather than letting two run at once.
          const controller = new AbortController();
          generatedPlaybacks.add(controller);
          const pinnedFacadePromise = ctx.client.pinFacade ? ctx.client.pinFacade() : Promise.resolve(undefined); // Pin once so a later select_backend can't retarget notes mid-arpeggio (HARD01-030).
          void (async () => {
            try {
              const pinnedFacade = await pinnedFacadePromise;
              await ctx.client.sidSetVolume(8, pinnedFacade);
              for (let i = 0; i < parsed.steps; i += 1) {
                if (controller.signal.aborted) break;
                const iv = intervals[i % intervals.length]!;
                const note = transposeNote(parsed.root, iv);
                await ctx.client.sidNoteOn({
                  voice: 1,
                  note,
                  waveform: (parsed.waveform ?? "tri") as "pulse" | "saw" | "tri" | "noise",
                  pulseWidth: 0x0800,
                  attack: 1,
                  decay: 7,
                  sustain: 15,
                  release: 0,
                }, pinnedFacade);
                const durationMs = parsed.preset === "expression" ? expressiveDurations[i % expressiveDurations.length]! : parsed.tempoMs;
                await sleep(Math.max(1, Math.min(20, Math.floor(durationMs / 8)))); // Clear GATE between notes so every note retriggers ADSR.
                await ctx.client.sidNoteOff(1, pinnedFacade);
                if (!controller.signal.aborted) await sleep(Math.max(0, durationMs - Math.max(1, Math.min(20, Math.floor(durationMs / 8)))));
              }
              await ctx.client.sidNoteOff(1, pinnedFacade);
            } catch (playbackError) {
              const message = playbackError instanceof Error ? playbackError.message : String(playbackError);
              ctx.logger.warn("music_generate playback failed", { error: message });
            } finally {
              generatedPlaybacks.delete(controller);
            }
          })();

          return textResult(`Scheduled ${parsed.steps} note arpeggio starting on ${parsed.root}. Playback is running and will be replaced by the next generated sequence.`, {
            success: true,
            root: parsed.root,
            intervals,
            steps: parsed.steps,
            tempoMs: parsed.tempoMs,
            waveform: parsed.waveform ?? "tri",
            preset: parsed.preset ?? "classic",
            timeline,
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
      name: "music_compile_and_play",
      description: "Compile a SIDWAVE composition to PRG or SID and optionally play it immediately.",
      summary: "Parses SIDWAVE/CPG input, compiles to a PRG, and plays via PRG or SID attachment.",
      inputSchema: musicCompileArgsSchema.jsonSchema,
      relatedResources: ["c64://sound/sid/spec", "c64://sound/sidwave/spec", "c64://sound/sid/file-format"],
      relatedPrompts: ["sid-music"],
      tags: ["sid", "music", "compiler"],
      prerequisites: [],
      examples: [
        { name: "Compile PRG", description: "Play compiled PRG", arguments: { sidwave: "song: { title: 'Demo' }", output: "prg", dryRun: false } },
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

          ctx.logger.info("Compiling SIDWAVE composition", {
            output: outputFormat,
            dryRun: parsed.dryRun,
          });

          const document = parseSidwave(source);
          const compiled = compileSidwaveToPrg(document);

          let ranOnC64 = false;
          let runDetails: Record<string, unknown> | null = null;

          if (!parsed.dryRun) {
            if (outputFormat === "sid") {
              const sid = compileSidwaveToSid(document, compiled.prg, { entryAddress: compiled.entryAddress });
              const result = await ctx.client.sidplayAttachment(sid.sid);
              if (!result.success) {
                throw new ToolExecutionError("C64 firmware reported failure while playing compiled SID", {
                  details: normaliseFailure(result.details),
                });
              }
              ranOnC64 = true;
              runDetails = toRecord(result.details) ?? null;
            } else {
              const result = await ctx.client.runPrg(compiled.prg);
              if (!result.success) {
                throw new ToolExecutionError("C64 firmware reported failure while running compiled PRG", {
                  details: normaliseFailure(result.details),
                });
              }
              ranOnC64 = true;
              runDetails = toRecord(result.details) ?? null;
            }
          }

          const message = `Compiled '${document.song.title}' to ${outputFormat.toUpperCase()}${parsed.dryRun ? " (dry run)" : ""}.`;
          const voiceSummaries = document.voices.map((voice) => ({
            id: voice.id,
            name: voice.name,
            waveform: voice.waveform,
            pulse_width: voice.pulse_width,
            adsr: voice.adsr,
          }));

          return textResult(message, {
            success: true,
            ranOnC64,
            dryRun: parsed.dryRun,
            format: outputFormat,
            prgSize: compiled.prg.length,
            entryAddress: compiled.entryAddress,
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
      description: "Record audio from the default input device and analyze SID playback characteristics.",
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
          ctx.logger.info("Recording audio for analysis", { durationSeconds: parsed.durationSeconds });

          const result = await recordAndAnalyzeAudio({
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
      description: "Automatically analyze SID playback when the user requests verification feedback.",
      summary: "Detects verification intent in natural language, records a short clip, and returns musical feedback.",
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
          if (!shouldAutoAnalyze(parsed.request)) {
            return textResult(
              "No audio verification keywords detected. Use phrases like 'check the music' or 'verify the SID playback'.",
              {
                analyzed: false,
                request: parsed.request,
              },
            );
          }

          const duration = parsed.durationSeconds ?? 3;
          ctx.logger.info("Auto-analyzing SID audio", { durationSeconds: duration });

            const analyzer = resolveAnalyzer(ctx);
            const analysis = await analyzer({
            durationSeconds: duration,
            expectedSidwave: normaliseSidwaveInput(parsed.expectedSidwave),
          });

          const feedback = generateAudioFeedback(analysis, parsed.request);
          return textResult(feedback, {
            analyzed: true,
            request: parsed.request,
            durationSeconds: analysis.analysis?.durationSeconds ?? duration,
            analysis,
          });
        } catch (error) {
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
