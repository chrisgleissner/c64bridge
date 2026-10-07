import { compileSidwaveToPrg, compileSidwaveToSid } from "../../sidwaveCompiler.js";
import { parseSidwave } from "../../sidwave.js";
import { recordAndAnalyzeAudio } from "../../audio/record_and_analyze_audio.js";
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
type MusicPresetName = "fuer_elise";

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

const MUSIC_PRESETS: Record<MusicPresetName, MusicPresetDefinition> = {
  fuer_elise: {
    key: "fuer_elise",
    title: "Für Elise",
    description: "Play a compact SID arrangement of Beethoven's Bagatelle in A minor.",
    sidwave: FUER_ELISE_SIDWAVE,
  },
};

const silenceAndVerifyArgsSchema = objectSchema({
  description: "Arguments for the silence_and_verify meta tool",
  properties: {
    durationSeconds: optionalSchema(numberSchema({ description: "Recording length in seconds for the silence probe.", minimum: 0.5, maximum: 10 }), DEFAULT_SILENCE_DURATION_SECONDS),
    rmsThreshold: optionalSchema(numberSchema({ description: "Maximum allowed RMS to consider the capture silent.", minimum: 0, maximum: 1 }), DEFAULT_RMS_THRESHOLD),
    waitBeforeCaptureMs: optionalSchema(numberSchema({ description: "Delay in milliseconds after silencing before recording starts.", minimum: 0, maximum: 5000 }), DEFAULT_SILENCE_WAIT_MS),
  },
  additionalProperties: false,
});

const musicCompilePlayAnalyzeArgsSchema = objectSchema({
  description: "Compile a SIDWAVE score, play it, then record and analyze the audio output.",
  properties: {
    sidwave: optionalSchema(stringSchema({ description: "SIDWAVE source in YAML or JSON format.", minLength: 1 })),
    cpg: optionalSchema(stringSchema({ description: "Legacy CPG input format.", minLength: 1 })),
    output: optionalSchema(stringSchema({ description: "Playback artifact format. PRG works on all backends; SID attachment playback requires C64U/U64 or U2.", enum: ["prg", "sid"], default: "prg" }), "prg"),
    waitBeforeCaptureMs: optionalSchema(numberSchema({ description: "Delay between starting playback and beginning analysis capture (milliseconds).", minimum: 0, maximum: 5000 }), DEFAULT_PLAYBACK_WAIT_MS),
    analysisDurationSeconds: optionalSchema(numberSchema({ description: "Audio capture length in seconds.", minimum: 0.5, maximum: 20 }), DEFAULT_ANALYSIS_DURATION_SECONDS),
    expectedSidwave: optionalSchema(stringSchema({ description: "Optional expected SIDWAVE used to refine analysis comparisons.", minLength: 1 })),
    verifySilenceBefore: optionalSchema(booleanSchema({ description: "Run silence verification before playback to ensure a quiet baseline.", default: true }), true),
    verifySilenceAfter: optionalSchema(booleanSchema({ description: "Run silence verification after playback to ensure voices are released.", default: true }), true),
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
    preset: optionalSchema(stringSchema({
      description: "Named SID preset to compile and play. Canonical public preset: fuer_elise.",
      minLength: 1,
      default: "fuer_elise",
    }), "fuer_elise"),
    platforms: optionalSchema(arraySchema(stringSchema({
      description: "Backends to target in sequence.",
      enum: ["vice", "c64u", "u2"],
      minLength: 1,
    }))),
    verify: optionalSchema(booleanSchema({
      description: "Capture and analyze audio after playback starts: native streaming on C64U/U64, host audio input on U2/VICE (PortAudio required).",
      default: true,
    }), true),
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

function resolveAnalyzer(context: ToolExecutionContext): AnalyzeAudioFn {
  const { client } = context;
  if (client && typeof (client as any).recordAndAnalyzeAudio === "function") {
    return (args) => (client as any).recordAndAnalyzeAudio(args);
  }

  return recordAndAnalyzeAudio;
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
  const requestedKey = preset?.trim().toLowerCase() || "fuer_elise";
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

async function performSilenceCheck(
  context: ToolExecutionContext,
  analyzer: AnalyzeAudioFn,
  options: SilenceCheckOptions,
): Promise<SilenceCheckResult> {
  const { logger } = context;
  const label = options.label ?? "silence";

  logger?.debug?.("silence_and_verify: running silence check", {
    stage: label,
    durationSeconds: options.durationSeconds,
    rmsThreshold: options.rmsThreshold,
    waitBeforeCaptureMs: options.waitBeforeCaptureMs,
  });

  await silenceSid(context);

  if (options.waitBeforeCaptureMs > 0) {
    await sleep(options.waitBeforeCaptureMs);
  }

  const analysis = await analyzer({ durationSeconds: options.durationSeconds });
  const metrics = extractRmsMetrics((analysis?.analysis?.global_metrics ?? {}) as Record<string, unknown>);

  if (metrics.average === null && metrics.max === null) {
    throw new ToolExecutionError("Audio analysis did not include RMS metrics", {
      details: { globalMetrics: analysis?.analysis?.global_metrics ?? {} },
    });
  }

  const averageRms = metrics.average ?? metrics.max ?? 0;
  const maxRms = metrics.max ?? metrics.average ?? 0;
  const silent = maxRms <= options.rmsThreshold;

  logger?.debug?.("silence_and_verify: silence check metrics", {
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
        const verify = parsed.verify !== false;
        const waitBeforeCaptureMs = parsed.waitBeforeCaptureMs ?? DEFAULT_PRESET_WAIT_MS;
        const analysisDurationSeconds = parsed.analysisDurationSeconds ?? DEFAULT_PRESET_ANALYSIS_DURATION_SECONDS;
        const restoreActiveBackend = parsed.restoreActiveBackend !== false;
        const results: Array<Record<string, unknown>> = [];
        let restoreError: string | undefined;

        try {
          for (const backend of requestedBackends) {
            context.client.switchBackend(backend);
            context.setPlatform(backend);
            await trySilenceSid(context);

            const playback = await context.client.runPrg(compiled.prg);
            const backendResult: Record<string, unknown> = {
              backend,
              preset: preset.key,
              title: preset.title,
              details: playback.details ?? null,
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
              const analysis = await analyzer({
                durationSeconds: analysisDurationSeconds,
                expectedSidwave: preset.sidwave,
              });
              const metrics = extractRmsMetrics((analysis?.analysis?.global_metrics ?? {}) as Record<string, unknown>);
              verification = {
                mode: "audio-analysis",
                durationSeconds: analysis.analysis?.durationSeconds ?? analysisDurationSeconds,
                averageRms: metrics.average,
                maxRms: metrics.max,
                voices: analysis.analysis?.voices ?? [],
                analysis,
              };
            }

            await trySilenceSid(context);

            backendResult.verification = verification;
            backendResult.success = true;
            results.push(backendResult);
          }
        } finally {
          if (restoreActiveBackend) {
            try {
              context.client.switchBackend(startingBackend);
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
    name: "silence_and_verify",
    description:
      "Silence all SID voices, capture a short sample, and ensure the output is below an RMS threshold.",
    inputSchema: silenceAndVerifyArgsSchema.jsonSchema,
    async execute(args, context) {
      try {
        const parsed = silenceAndVerifyArgsSchema.parse(args ?? {});
        const durationSeconds = parsed.durationSeconds ?? DEFAULT_SILENCE_DURATION_SECONDS;
        const rmsThreshold = parsed.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
        const waitBeforeCaptureMs = parsed.waitBeforeCaptureMs ?? DEFAULT_SILENCE_WAIT_MS;

        const analyzer = resolveAnalyzer(context);
        const check = await performSilenceCheck(context, analyzer, {
          durationSeconds,
          rmsThreshold,
          waitBeforeCaptureMs,
          label: "primary",
        });

        return jsonResult(
          {
            silent: check.silent,
            durationSeconds: check.durationSeconds,
            waitBeforeCaptureMs,
            threshold: rmsThreshold,
            metrics: check.metrics,
          },
          {
            success: check.silent,
            silent: check.silent,
          },
        );
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
        const verifySilenceBefore = parsed.verifySilenceBefore ?? true;
        const verifySilenceAfter = parsed.verifySilenceAfter ?? true;
        const silenceDurationSeconds = parsed.silenceDurationSeconds ?? DEFAULT_SILENCE_DURATION_SECONDS;
        const silenceRmsThreshold = parsed.silenceRmsThreshold ?? DEFAULT_RMS_THRESHOLD;
        const postSilenceWaitMs = parsed.postSilenceWaitMs ?? DEFAULT_POST_SILENCE_WAIT_MS;
        const silenceWaitMs = parsed.silenceWaitMs ?? DEFAULT_SILENCE_WAIT_MS;
        const expectedSidwave = normalizeSidwaveInput(parsed.expectedSidwave ?? parsed.sidwave ?? parsed.cpg);

        const analyzer = resolveAnalyzer(context);
        let preSilence: SilenceCheckResult | null = null;
        if (verifySilenceBefore) {
          preSilence = await performSilenceCheck(context, analyzer, {
            durationSeconds: silenceDurationSeconds,
            rmsThreshold: silenceRmsThreshold,
            waitBeforeCaptureMs: silenceWaitMs,
            label: "pre",
          });

          if (!preSilence.silent) {
            throw new ToolExecutionError("Pre-playback silence check failed", {
              details: { metrics: preSilence.metrics },
            });
          }
        }

        const document = parseSidwave(source as any);
        const compiled = compileSidwaveToPrg(document);

        const playbackMethod = format === "sid" ? "sidplay_attachment" : "run_prg";
        let playbackDetails: Record<string, unknown> | null = null;

        if (format === "sid") {
          const sid = compileSidwaveToSid(document, compiled.prg, { entryAddress: compiled.entryAddress });
          const playback = await context.client.sidplayAttachment(sid.sid);
          playbackDetails = normaliseDetails(playback.details);
          if (!playback.success) {
            throw new ToolExecutionError("Playback failed", {
              details: { response: playbackDetails ?? playback.details ?? playback },
            });
          }
        } else {
          const playback = await context.client.runPrg(compiled.prg);
          playbackDetails = normaliseDetails(playback.details);
          if (!playback.success) {
            throw new ToolExecutionError("Playback failed", {
              details: { response: playbackDetails ?? playback.details ?? playback },
            });
          }
        }

        if (waitBeforeCaptureMs > 0) {
          await sleep(waitBeforeCaptureMs);
        }

        const analysisParams: AnalyzeAudioParams = { durationSeconds: analysisDurationSeconds };
        if (expectedSidwave) {
          analysisParams.expectedSidwave = expectedSidwave;
        }

        const analysis = await analyzer(analysisParams);
        const analysisMetrics = extractRmsMetrics((analysis?.analysis?.global_metrics ?? {}) as Record<string, unknown>);

        if (analysisMetrics.average === null && analysisMetrics.max === null) {
          throw new ToolExecutionError("Audio analysis did not include RMS metrics", {
            details: { globalMetrics: analysis?.analysis?.global_metrics ?? {} },
          });
        }

        let postSilence: SilenceCheckResult | null = null;
        if (verifySilenceAfter) {
          if (postSilenceWaitMs > 0) {
            await sleep(postSilenceWaitMs);
          }

          postSilence = await performSilenceCheck(context, analyzer, {
            durationSeconds: silenceDurationSeconds,
            rmsThreshold: silenceRmsThreshold,
            waitBeforeCaptureMs: silenceWaitMs,
            label: "post",
          });

          if (!postSilence.silent) {
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
            after: postSilence
              ? {
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
