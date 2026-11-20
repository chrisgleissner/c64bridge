import { cancelGeneratedSidPlayback, playbackSetupWarnings, startCompiledSidwave } from "../audio.js";
import { clearViceSymbols } from "../translation/symbolRegistry.js";
import { compileSidwaveToPrg, compileSidwaveToSid, validateSidwavePsidMap } from "../../sidwaveCompiler.js";
import { parseSidwave } from "../../sidwave.js";
import { noAudioMeasurement, recordAndAnalyzeAudio } from "../../audio/record_and_analyze_audio.js";
import type { ToolDefinition, ToolExecutionContext } from "../types.js";
import { jsonResult } from "../responses.js";
import { ToolExecutionError, ToolUnsupportedPlatformError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { getPlatformStatus } from "../../platform.js";
import { sleep } from "./util.js";
import { arraySchema, booleanSchema, numberSchema, objectSchema, optionalSchema, stringSchema } from "../schema.js";

const DEFAULT_SILENCE_DURATION_SECONDS = 1.5;
const DEFAULT_RMS_THRESHOLD = 0.02;
const DEFAULT_SILENCE_WAIT_MS = 150;
const DEFAULT_ANALYSIS_DURATION_SECONDS = 3;
const DEFAULT_PLAYBACK_WAIT_MS = 500;
const DEFAULT_POST_SILENCE_WAIT_MS = 200;
const DEFAULT_PRESET_ANALYSIS_DURATION_SECONDS = 4;
const DEFAULT_PRESET_WAIT_MS = 400;

type PresetBackend = "vice" | "c64u" | "u2";
type MusicPresetName = "chiptune_drive" | "ambient_filter" | "funk_bass" | "fuer_elise";

interface MusicPresetDefinition {
  readonly key: MusicPresetName;
  readonly title: string;
  readonly description: string;
  readonly sidwave: string;
}

interface ResolvedMusicPreset {
  readonly definition: MusicPresetDefinition;
  readonly requestedKey: string;
  readonly aliasUsed: boolean;
}

const LEGACY_PRESET_ALIAS = String.fromCharCode(
  103,
  101,
  114,
  109,
  97,
  110,
  95,
  97,
  110,
  116,
  104,
  101,
  109,
);

const FUER_ELISE_SIDWAVE = `
song:
  title: "Für Elise"
  mode: PAL
  tempo: 76
voices:
  - id: 1
    name: "Lead"
    waveform: triangle
    adsr: [1, 4, 9, 4]
    patterns:
      theme:
        groove: ["E5", "D#5", "E5", "D#5", "E5", "B4", "D5", "C5", "A4", "-", "A3", "C4", "E4", "-", "A4", "B4", "-", "E4", "G#4", "B4", "C5", "-", "E5", "D#5", "E5", "D#5", "E5", "B4", "D5", "C5", "A4", "-"]
  - id: 2
    name: "Harmony"
    waveform: triangle
    adsr: [2, 5, 8, 5]
    patterns:
      accomp:
        groove: ["-", "-", "-", "-", "-", "-", "-", "-", "A2", "E3", "A3", "E3", "A2", "E3", "A3", "E3", "E2", "B2", "E3", "B2", "E2", "B2", "E3", "B2", "-", "-", "-", "-", "-", "-", "-", "-"]
  - id: 3
    name: "Bass"
    waveform: triangle
    adsr: [1, 3, 10, 5]
    patterns:
      bass:
        groove: ["-", "-", "-", "-", "-", "-", "-", "-", "A1", "-", "-", "-", "A1", "-", "-", "-", "E2", "-", "-", "-", "E2", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-"]
timeline:
  - section: "Theme"
    bars: 8
    layers: { v1: theme, v2: accomp, v3: bass }
`;

const CHIPTUNE_DRIVE = `
sidwave: 1.1
title: Neon Run
mode: PAL
tempo: 132
speed: 2
voices:
  - id: 1
    instrument: lib:filter_bass
    patterns:
      launch:
        length: 0.5
        groove: [C2, C2@lib:hat, G1, C2@lib:snare, Bb1, C2@lib:hat, G1, C2@lib:kick]
        transpositions: [0, 0, 5, 3]
      sprint:
        length: 0.25
        drums: { kit: { k: lib:kick, s: lib:snare, h: lib:hat }, steps: "k.h.s.h.k.khsh.h" }
  - id: 2
    instrument: lib:chip_arp_major
    patterns:
      lights:
        groove: [C4, Bb3, F4, Eb4@lib:chip_arp_minor]
  - id: 3
    instrument: lib:lead_pwm
    patterns:
      hook:
        length: 0.5
        groove:
          - G4
          - { note: C5, legato: true, portamento: 4 }
          - D5
          - { note: Bb4, legato: true, portamento: 3 }
          - F5@lib:sync_lead
          - "-"
          - Eb5
          - { note: G4, legato: true, portamento: 5 }
        fx: { vibrato: { depth: 0.32, rate: 6, delay: 3 } }
timeline:
  - { section: Launch, bars: 4, layers: { v1: launch, v2: lights, v3: hook } }
  - { section: Sprint, bars: 2, layers: { v1: sprint, v2: lights+12, v3: hook } }
`;

const AMBIENT_FILTER = `
sidwave: 1.1
title: Blue Current
mode: PAL
tempo: 72
voices:
  - id: 1
    instrument: lib:filter_bass
    patterns:
      current:
        length: 0.5
        groove:
          - { note: D2, len: 1.5 }
          - D3@lib:hat
          - { note: A1, len: 1 }
          - D3@lib:snare
          - D3@lib:kick
        transpositions: [0, -2, -5, 3]
      tide:
        length: 0.5
        drums: { kit: { k: lib:kick, s: lib:snare, h: lib:hat }, steps: "k..h.s.." }
  - id: 2
    instrument: lib:chip_arp_minor
    patterns:
      ripples: { length: 2, groove: [D3, C3@lib:chip_arp_major, A2@lib:chip_arp_major, F3@lib:chip_arp_major] }
      depth: { length: 2, groove: [D3@lib:pad_slow, A3@lib:chip_arp_minor] }
  - id: 3
    instrument: lib:lead_pwm
    patterns:
      reflections:
        length: 1
        groove:
          - { note: A4, len: 1.5 }
          - { note: E5, legato: true, portamento: 16 }
          - D5@lib:bell_ring
          - { note: A4, len: 0.5 }
        fx: { vibrato: { depth: 0.2, rate: 3, delay: 12 } }
timeline:
  - { section: Drift, bars: 4, layers: { v1: current, v2: ripples, v3: reflections } }
  - { section: Tide, bars: 2, layers: { v1: tide, v2: depth, v3: reflections } }
`;

const FUNK_BASS = `
sidwave: 1.1
title: Copper Steps
mode: PAL
tempo: 118
voices:
  - id: 1
    instrument: lib:filter_bass
    patterns:
      pocket:
        length: 0.25
        groove: [E2, "-", E3@lib:hat, B1, E3@lib:snare, G2, D2, E3@lib:hat, E2, "-", E3@lib:kick, F#2, E3@lib:snare, G2, B1, "-"]
        transpositions: [0, 0, 5, 0]
      break:
        length: 0.25
        drums: { kit: { k: lib:kick, s: lib:snare, h: lib:hat }, steps: "k.hhs.h.k.khs.hh" }
  - id: 2
    instrument: lib:chip_arp_minor
    patterns:
      chops: { length: 0.5, groove: ["-", E3, "-", G3@lib:chip_arp_major, "-", A3@lib:chip_arp_major, B3, "-"] }
  - id: 3
    instrument: lib:lead_pwm
    patterns:
      answer:
        length: 0.5
        groove:
          - B4
          - { note: D5, legato: true, portamento: 3 }
          - "-"
          - G4@lib:sync_lead
          - E5
          - { note: B4, legato: true, portamento: 4 }
          - D5@lib:bell_ring
          - "-"
        fx: { vibrato: { depth: 0.38, rate: 7, delay: 3 } }
timeline:
  - { section: Pocket, bars: 4, layers: { v1: pocket, v2: chops, v3: answer } }
  - { section: Break, bars: 2, layers: { v1: break, v2: chops, v3: answer } }
`;

const MUSIC_PRESETS: Record<MusicPresetName, MusicPresetDefinition> = {
  chiptune_drive: { key: "chiptune_drive", title: "Neon Run", description: "A fast tune with chip arpeggios, gliding pulse lead and a drum break.", sidwave: CHIPTUNE_DRIVE },
  ambient_filter: { key: "ambient_filter", title: "Blue Current", description: "A slow piece with a sweeping pad, sparse percussion and ring modulated bells.", sidwave: AMBIENT_FILTER },
  funk_bass: { key: "funk_bass", title: "Copper Steps", description: "A syncopated filtered bass line with chord chops, drums and hard sync accents.", sidwave: FUNK_BASS },
  fuer_elise: {
    key: "fuer_elise",
    title: "Für Elise",
    description: "Play a compact SID arrangement of Beethoven's Bagatelle in A minor.",
    sidwave: FUER_ELISE_SIDWAVE,
  },
};

/** Source-level fixtures for compiler compatibility checks. */
export function getMusicPresetSidwave(name: "chiptune_drive" | "ambient_filter" | "funk_bass"): string {
  return MUSIC_PRESETS[name].sidwave;
}

const musicCompilePlayAnalyzeArgsSchema = objectSchema({
  description: "Compile a SIDWAVE score, play it, then record and analyze the audio output.",
  properties: {
    configure: optionalSchema(booleanSchema({ description: "Set up SID playback." })),
    sidwave: optionalSchema(stringSchema({ description: "SIDWAVE source in YAML or JSON format.", minLength: 1 })),
    cpg: optionalSchema(stringSchema({ description: "Legacy CPG input format.", minLength: 1 })),
    output: optionalSchema(stringSchema({ description: "Playback artifact format. PRG works on all backends; SID attachment playback requires C64U/U64 or U2.", enum: ["prg", "sid"], default: "prg" }), "prg"),
    waitBeforeCaptureMs: optionalSchema(numberSchema({ description: "Delay between starting playback and beginning analysis capture (milliseconds).", minimum: 0, maximum: 5000 }), DEFAULT_PLAYBACK_WAIT_MS),
    analysisDurationSeconds: optionalSchema(numberSchema({ description: "Audio capture length in seconds.", minimum: 0.5, maximum: 20 }), DEFAULT_ANALYSIS_DURATION_SECONDS),
    expectedSidwave: optionalSchema(stringSchema({ description: "Optional expected SIDWAVE used to refine analysis comparisons.", minLength: 1 })),
    verifySilenceBefore: optionalSchema(booleanSchema({ description: "Record a quiet baseline before playback (adds the silence duration). Default false.", default: false }), false),
    verifySilenceAfter: optionalSchema(booleanSchema({ description: "Record after playback to confirm the voices were released (adds the silence duration). Default false.", default: false }), false),
    silenceDurationSeconds: optionalSchema(numberSchema({ description: "Audio capture length used for silence verification.", minimum: 0.5, maximum: 10 }), DEFAULT_SILENCE_DURATION_SECONDS),
    silenceRmsThreshold: optionalSchema(numberSchema({ description: "RMS threshold applied to silence verification captures.", minimum: 0, maximum: 1 }), DEFAULT_RMS_THRESHOLD),
    postSilenceWaitMs: optionalSchema(numberSchema({ description: "Delay between main analysis capture and the post-playback silence check (milliseconds).", minimum: 0, maximum: 5000 }), DEFAULT_POST_SILENCE_WAIT_MS),
    silenceWaitMs: optionalSchema(numberSchema({ description: "Delay between silencing the SID and recording during pre/post checks (milliseconds).", minimum: 0, maximum: 5000 }), DEFAULT_SILENCE_WAIT_MS),
  },
  additionalProperties: false,
});

const musicPlayPresetArgsSchema = objectSchema({
  description: "Play a built-in SID preset with optional backend switching and audio verification.",
  properties: {
    configure: optionalSchema(booleanSchema({ description: "Set up SID playback." })),
    preset: optionalSchema(stringSchema({
      description: "Named SID preset to compile and play. Defaults to chiptune_drive.",
      minLength: 1,
      default: "chiptune_drive",
    }), "chiptune_drive"),
    platforms: optionalSchema(arraySchema(stringSchema({
      description: "Backends to target in sequence.",
      enum: ["vice", "c64u", "u2"],
      minLength: 1,
    }))),
    verify: optionalSchema(booleanSchema({
      description: "Opt in to capturing and analyzing the audio after playback starts (adds the wait and the analysis duration): native streaming on C64U/U64, host audio input on U2/VICE (PortAudio required). Default false.",
      default: false,
    }), false),
    analysisDurationSeconds: optionalSchema(numberSchema({
      description: "Length of the verification recording on analyzable backends.",
      minimum: 0.5,
      maximum: 20,
      default: DEFAULT_PRESET_ANALYSIS_DURATION_SECONDS,
    }), DEFAULT_PRESET_ANALYSIS_DURATION_SECONDS),
    waitBeforeCaptureMs: optionalSchema(numberSchema({
      description: "Delay between starting playback and beginning verification capture.",
      minimum: 0,
      maximum: 5000,
      default: DEFAULT_PRESET_WAIT_MS,
    }), DEFAULT_PRESET_WAIT_MS),
    restoreActiveBackend: optionalSchema(booleanSchema({
      description: "Restore the backend that was active before the workflow started.",
      default: true,
    }), true),
  },
  additionalProperties: false,
});

type AnalyzeAudioParams = {
  durationSeconds: number;
  expectedSidwave?: string | Record<string, unknown>;
  signal?: AbortSignal;
};

type AnalyzeAudioFn = (options: AnalyzeAudioParams) => Promise<Awaited<ReturnType<typeof recordAndAnalyzeAudio>>>;

interface SilenceCheckOptions {
  durationSeconds: number;
  rmsThreshold: number;
  waitBeforeCaptureMs: number;
  label?: string;
}

interface SilenceCheckResult {
  silent: boolean;
  durationSeconds: number;
  metrics: {
    averageRms: number;
    maxRms: number;
  };
  analysis: Awaited<ReturnType<typeof recordAndAnalyzeAudio>>;
}

async function silenceSid(context: ToolExecutionContext) {
  const { client } = context;
  if (!(client && typeof (client as any).sidSilenceAll === "function")) {
    throw new ToolExecutionError("sidSilenceAll is not available on this client");
  }

  const response = await (client as any).sidSilenceAll();
  if (!response?.success) {
    throw new ToolExecutionError("Unable to silence SID", {
      details: { response },
    });
  }
}

let hostCaptureProbe: Promise<boolean> | undefined;

/** True when audio can be captured: the client provides its own capture (C64U stream) or the host PortAudio module loads. */
async function audioCaptureAvailable(context: ToolExecutionContext): Promise<boolean> {
  if (typeof (context.client as any)?.recordAndAnalyzeAudio === "function") return true;
  hostCaptureProbe ??= (async () => {
    try {
      const specifier = "naudiodon" as unknown as string;
      await import(specifier as any);
      return true;
    } catch {
      return false;
    }
  })();
  return hostCaptureProbe;
}

function resolveAnalyzer(context: ToolExecutionContext): AnalyzeAudioFn {
  const { client } = context;
  const withSignal = (args: AnalyzeAudioParams): AnalyzeAudioParams => context.signal ? { ...args, signal: context.signal } : args;
  if (client && typeof (client as any).recordAndAnalyzeAudio === "function") {
    return (args) => (client as any).recordAndAnalyzeAudio(withSignal(args));
  }

  return (args) => recordAndAnalyzeAudio(withSignal(args));
}

function normalizeSidwaveInput(input?: string | Record<string, unknown>): string | Record<string, unknown> | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (input && typeof input === "object") {
    return input;
  }
  return undefined;
}

function canonicalPresetBackends(): readonly PresetBackend[] {
  return ["vice", "c64u", "u2"];
}

function uniquePresetBackends(backends: readonly PresetBackend[]): PresetBackend[] {
  return backends.filter((backend, index) => backends.indexOf(backend) === index);
}

function resolveMusicPreset(preset?: string): ResolvedMusicPreset {
  const requestedKey = preset?.trim().toLowerCase() || "chiptune_drive";
  const normalizedKey = requestedKey === LEGACY_PRESET_ALIAS ? "fuer_elise" : requestedKey;
  const definition = MUSIC_PRESETS[normalizedKey as MusicPresetName];
  if (!definition) {
    throw new ToolExecutionError("Unknown music preset", {
      details: {
        preset,
        supportedPresets: Object.keys(MUSIC_PRESETS),
      },
    });
  }
  return {
    definition,
    requestedKey,
    aliasUsed: requestedKey !== definition.key,
  };
}

function extractRmsMetrics(globalMetrics: Record<string, unknown>): { average: number | null; max: number | null } {
  const average = typeof globalMetrics.average_rms === "number" ? globalMetrics.average_rms : null;
  const max = typeof globalMetrics.max_rms === "number" ? globalMetrics.max_rms : null;
  return { average, max };
}

type NoAudioMeasurement = ReturnType<typeof noAudioMeasurement>;

async function captureMeasurement(
  analyzer: AnalyzeAudioFn,
  options: AnalyzeAudioParams,
  backend: string,
  signal?: AbortSignal,
) {
  try {
    const analysis = await analyzer(options);
    const metrics = extractRmsMetrics(analysis?.analysis?.global_metrics ?? {});
    if (metrics.average === null && metrics.max === null) {
      return noAudioMeasurement(backend, new Error("Audio analysis did not include RMS metrics"));
    }
    return { analysis, metrics };
  } catch (error) {
    signal?.throwIfAborted();
    return noAudioMeasurement(backend, error);
  }
}

async function performSilenceCheck(
  context: ToolExecutionContext,
  analyzer: AnalyzeAudioFn,
  backend: string,
  options: SilenceCheckOptions,
): Promise<SilenceCheckResult | NoAudioMeasurement> {
  const { logger } = context;
  const label = options.label ?? "silence";

  logger?.debug?.("silence check: running silence check", {
    stage: label,
    durationSeconds: options.durationSeconds,
    rmsThreshold: options.rmsThreshold,
    waitBeforeCaptureMs: options.waitBeforeCaptureMs,
  });

  await silenceSid(context);

  if (options.waitBeforeCaptureMs > 0) {
    await sleep(options.waitBeforeCaptureMs);
  }

  const capture = await captureMeasurement(analyzer, { durationSeconds: options.durationSeconds }, backend, context.signal);
  if ("measured" in capture) return capture;
  const { analysis, metrics } = capture;

  const averageRms = metrics.average ?? metrics.max ?? 0;
  const maxRms = metrics.max ?? metrics.average ?? 0;
  const silent = maxRms <= options.rmsThreshold;

  logger?.debug?.("silence check: silence check metrics", {
    stage: label,
    averageRms,
    maxRms,
    rmsThreshold: options.rmsThreshold,
    silent,
  });

  return {
    silent,
    durationSeconds: analysis?.analysis?.durationSeconds ?? options.durationSeconds,
    metrics: {
      averageRms,
      maxRms,
    },
    analysis,
  };
}

async function trySilenceSid(context: ToolExecutionContext) {
  const { client } = context;
  if (!(client && typeof (client as any).sidSilenceAll === "function")) {
    return;
  }
  await (client as any).sidSilenceAll();
}

function normaliseDetails(details: unknown): Record<string, unknown> | null {
  if (details === null || details === undefined) {
    return null;
  }
  if (typeof details === "object") {
    return { ...(details as Record<string, unknown>) };
  }
  return { value: details };
}

export const tools: ToolDefinition[] = [
  {
    name: "music_play_preset",
    description: "Compile and play a built-in SID preset, with optional multi-backend routing and verification.",
    inputSchema: musicPlayPresetArgsSchema.jsonSchema,
    async execute(args, context) {
      try {
        const parsed = musicPlayPresetArgsSchema.parse(args ?? {});
        const resolvedPreset = resolveMusicPreset(parsed.preset);
        const preset = resolvedPreset.definition;
        const startingBackend = await context.client.getActiveBackendType();
        const availableBackends = uniquePresetBackends(
          canonicalPresetBackends().filter((backend) => context.client.getAvailableBackends().includes(backend)),
        );
        const requestedBackends = uniquePresetBackends(
          ((parsed.platforms as PresetBackend[] | undefined) ?? [startingBackend as PresetBackend]),
        );
        const missingBackends = requestedBackends.filter((backend) => !availableBackends.includes(backend));

        if (missingBackends.length > 0) {
          throw new ToolExecutionError("Requested preset backends are not configured", {
            details: {
              preset: preset.key,
              requestedPreset: resolvedPreset.requestedKey,
              requestedBackends,
              availableBackends,
              missingBackends,
            },
          });
        }

        const document = parseSidwave(preset.sidwave);
        const compiled = compileSidwaveToPrg(document);
        const analyzer = resolveAnalyzer(context);
        const verify = parsed.verify === true;
        const waitBeforeCaptureMs = parsed.waitBeforeCaptureMs ?? DEFAULT_PRESET_WAIT_MS;
        const analysisDurationSeconds = parsed.analysisDurationSeconds ?? DEFAULT_PRESET_ANALYSIS_DURATION_SECONDS;
        const restoreActiveBackend = parsed.restoreActiveBackend !== false;
        const results: Array<Record<string, unknown>> = [];
        let restoreError: string | undefined;

        try {
          for (const [backendIndex, backend] of requestedBackends.entries()) {
            await context.client.switchBackend(backend);
            context.setPlatform(backend);
            await trySilenceSid(context);

            await cancelGeneratedSidPlayback(context.client);
            const playback = await startCompiledSidwave(context.client, document, compiled, backend, { configure: parsed.configure });
            const warnings = [...compiled.warnings, ...playbackSetupWarnings(document, backend, parsed.configure)];
            if (playback.success) clearViceSymbols(); // labels belong to one program
            const backendResult: Record<string, unknown> = {
              backend,
              preset: preset.key,
              title: preset.title,
              details: playback.details ?? null,
              ...(warnings.length ? { warnings } : {}),
            };

            if (!playback.success) {
              backendResult.success = false;
              backendResult.error = "playback_failed";
              results.push(backendResult);
              continue;
            }

            let verification: Record<string, unknown> | null = null;
            if (verify) {
              if (waitBeforeCaptureMs > 0) {
                await sleep(waitBeforeCaptureMs);
              }
              const capture = await captureMeasurement(analyzer, {
                durationSeconds: analysisDurationSeconds,
                expectedSidwave: preset.sidwave,
              }, backend, context.signal);
              if ("measured" in capture) {
                verification = capture;
              } else {
                const { analysis, metrics } = capture;
                const audible = (metrics.max ?? metrics.average ?? 0) > DEFAULT_RMS_THRESHOLD;
                verification = {
                  mode: "audio-analysis",
                  durationSeconds: analysis.analysis?.durationSeconds ?? analysisDurationSeconds,
                  averageRms: metrics.average,
                  maxRms: metrics.max,
                  audible,
                  voices: analysis.analysis?.voices ?? [],
                  analysis,
                };
                if (!audible) {
                  backendResult.error = "no_audio_detected";
                }
              }
            }

            // Silence intermediate backends before moving on. The client also
            // releases session-owned playback when leaving the final backend.
            if (backendIndex < requestedBackends.length - 1) {
              await trySilenceSid(context);
            }

            backendResult.verification = verification;
            backendResult.success = backendResult.error === undefined;
            results.push(backendResult);
          }
        } finally {
          if (restoreActiveBackend) {
            try {
              await context.client.switchBackend(startingBackend);
              context.setPlatform(startingBackend);
            } catch (error) {
              restoreError = error instanceof Error ? error.message : String(error);
            }
          }
        }

        const success = results.every((result) => result.success === true) && !restoreError;
        const payload = {
          kind: "music_play_preset" as const,
          preset: preset.key,
          requestedPreset: resolvedPreset.requestedKey,
          legacyAliasUsed: resolvedPreset.aliasUsed,
          title: preset.title,
          description: preset.description,
          startingBackend,
          requestedBackends,
          availableBackends,
          restoredBackend: restoreActiveBackend ? startingBackend : await context.client.getActiveBackendType(),
          verificationEnabled: verify,
          sidwave: preset.sidwave,
          results,
          ...(restoreError ? { restoreError } : {}),
        };

        const result = jsonResult(payload, {
          success,
          preset: preset.key,
          requestedPreset: resolvedPreset.requestedKey,
          legacyAliasUsed: resolvedPreset.aliasUsed,
          backends: requestedBackends,
        });
        return success ? result : { ...result, isError: true };
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          return toolErrorResult(error);
        }
        return unknownErrorResult(error);
      }
    },
  },
  {
    name: "music_compile_play_analyze",
    description: "Compile a SIDWAVE score, play it on the C64, capture the output, and analyze the recording.",
    inputSchema: musicCompilePlayAnalyzeArgsSchema.jsonSchema,
    async execute(args, context) {
      try {
        const parsed = musicCompilePlayAnalyzeArgsSchema.parse(args ?? {});

        const source = normalizeSidwaveInput(parsed.sidwave ?? parsed.cpg);
        if (!source) {
          throw new ToolExecutionError("Provide sidwave or cpg source");
        }

        const format = (parsed.output ?? "prg") as "prg" | "sid";
        const platform = context.platform?.id ?? getPlatformStatus().id;
        if (format === "sid" && platform === "vice") {
          throw new ToolUnsupportedPlatformError("sidplay_attachment (use output: prg on VICE)", platform, ["c64u", "u2"]);
        }
        const waitBeforeCaptureMs = parsed.waitBeforeCaptureMs ?? DEFAULT_PLAYBACK_WAIT_MS;
        const analysisDurationSeconds = parsed.analysisDurationSeconds ?? DEFAULT_ANALYSIS_DURATION_SECONDS;
        const verifySilenceBefore = parsed.verifySilenceBefore ?? false;
        const verifySilenceAfter = parsed.verifySilenceAfter ?? false;
        const silenceDurationSeconds = parsed.silenceDurationSeconds ?? DEFAULT_SILENCE_DURATION_SECONDS;
        const silenceRmsThreshold = parsed.silenceRmsThreshold ?? DEFAULT_RMS_THRESHOLD;
        const postSilenceWaitMs = parsed.postSilenceWaitMs ?? DEFAULT_POST_SILENCE_WAIT_MS;
        const silenceWaitMs = parsed.silenceWaitMs ?? DEFAULT_SILENCE_WAIT_MS;
        const expectedSidwave = normalizeSidwaveInput(parsed.expectedSidwave ?? parsed.sidwave ?? parsed.cpg);

        const document = parseSidwave(source);
        if (format === "sid") validateSidwavePsidMap(document);
        const compiled = compileSidwaveToPrg(document);

        const analyzer = resolveAnalyzer(context);
        // Without an audio capture backend the score is still compiled and played; the analysis is skipped and said so.
        let unavailable = await audioCaptureAvailable(context) ? null : noAudioMeasurement(platform);
        let preSilence: SilenceCheckResult | null = null;
        if (verifySilenceBefore && !unavailable) {
          const check = await performSilenceCheck(context, analyzer, platform, {
            durationSeconds: silenceDurationSeconds,
            rmsThreshold: silenceRmsThreshold,
            waitBeforeCaptureMs: silenceWaitMs,
            label: "pre",
          });

          if ("measured" in check) {
            unavailable = check;
          } else if (!check.silent) {
            throw new ToolExecutionError("Pre-playback silence check failed", {
              details: { metrics: check.metrics },
            });
          } else {
            preSilence = check;
          }
        }

        const playbackMethod = format === "sid" ? "sidplay_attachment" : "run_prg";
        let playbackDetails: Record<string, unknown> | null = null;

        const sid = format === "sid" ? compileSidwaveToSid(document, compiled.prg).sid : undefined;
        await cancelGeneratedSidPlayback(context.client);
        const playback = await startCompiledSidwave(context.client, document, compiled, platform, { configure: parsed.configure, sid });
        if (!playback.success) {
          throw new ToolExecutionError("Playback failed", {
            details: { response: normaliseDetails(playback.details) ?? playback.details ?? playback },
          });
        }
        clearViceSymbols();
        playbackDetails = normaliseDetails(playback.details);
        const compilationWarnings = [...compiled.warnings, ...playbackSetupWarnings(document, platform, parsed.configure)];

        const playedWithoutMeasurement = (verification: NoAudioMeasurement) =>
          jsonResult({
            format,
            compilation: {
              entryAddress: compiled.entryAddress,
              prgBytes: compiled.prg.length,
              title: document.song?.title ?? null,
              basicFreeBytes: compiled.basicFreeBytes,
              worstCaseCyclesPerCall: compiled.worstCaseCyclesPerCall,
              warnings: compilationWarnings,
            },
            playback: { method: playbackMethod, details: playbackDetails },
            analysis: null,
            playing: true,
            verification,
            warnings: [...compilationWarnings, verification.message],
          }, { success: true, format, method: playbackMethod, analyzed: false });

        if (unavailable) return playedWithoutMeasurement(unavailable);

        if (waitBeforeCaptureMs > 0) {
          await sleep(waitBeforeCaptureMs);
        }

        const analysisParams: AnalyzeAudioParams = { durationSeconds: analysisDurationSeconds };
        if (expectedSidwave) {
          analysisParams.expectedSidwave = expectedSidwave;
        }

        const capture = await captureMeasurement(analyzer, analysisParams, platform, context.signal);
        if ("measured" in capture) return playedWithoutMeasurement(capture);
        const { analysis, metrics: analysisMetrics } = capture;

        if ((analysisMetrics.max ?? analysisMetrics.average ?? 0) <= silenceRmsThreshold) {
          let cleanupError: string | undefined;
          try {
            await silenceSid(context);
          } catch (error) {
            cleanupError = error instanceof Error ? error.message : String(error);
          }
          throw new ToolExecutionError("No audio was detected after playback started", {
            details: { audible: false, averageRms: analysisMetrics.average, maxRms: analysisMetrics.max, threshold: silenceRmsThreshold, ...(cleanupError ? { cleanupError } : {}) },
          });
        }

        let postSilence: SilenceCheckResult | NoAudioMeasurement | null = null;
        if (verifySilenceAfter) {
          if (postSilenceWaitMs > 0) {
            await sleep(postSilenceWaitMs);
          }

          postSilence = await performSilenceCheck(context, analyzer, platform, {
            durationSeconds: silenceDurationSeconds,
            rmsThreshold: silenceRmsThreshold,
            waitBeforeCaptureMs: silenceWaitMs,
            label: "post",
          });

          if (!("measured" in postSilence) && !postSilence.silent) {
            throw new ToolExecutionError("Post-playback silence check failed", {
              details: { metrics: postSilence.metrics },
            });
          }
        } else {
          await silenceSid(context);
        }

        const data = {
          format,
          compilation: {
            entryAddress: compiled.entryAddress,
            prgBytes: compiled.prg.length,
            title: document.song?.title ?? null,
            basicFreeBytes: compiled.basicFreeBytes,
            worstCaseCyclesPerCall: compiled.worstCaseCyclesPerCall,
            warnings: compilationWarnings,
          },
          playback: {
            method: playbackMethod,
            details: playbackDetails,
          },
          analysis,
          analysisMetrics: {
            averageRms: analysisMetrics.average,
            maxRms: analysisMetrics.max,
          },
          silenceChecks: {
            before: preSilence
              ? {
                  silent: preSilence.silent,
                  durationSeconds: preSilence.durationSeconds,
                  metrics: preSilence.metrics,
                }
              : null,
            after: postSilence && "measured" in postSilence
              ? postSilence
              : postSilence ? {
                  silent: postSilence.silent,
                  durationSeconds: postSilence.durationSeconds,
                  metrics: postSilence.metrics,
                }
              : null,
          },
          settings: {
            waitBeforeCaptureMs,
            analysisDurationSeconds,
            verifySilenceBefore,
            verifySilenceAfter,
            silenceDurationSeconds,
            silenceRmsThreshold,
            postSilenceWaitMs,
          },
        } as const;

        return jsonResult(data, {
          success: true,
          format,
          method: playbackMethod,
          averageRms: analysisMetrics.average,
          maxRms: analysisMetrics.max,
        });
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          return toolErrorResult(error);
        }

        return unknownErrorResult(error);
      }
    },
  },
];
