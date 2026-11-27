import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { defaultHostOutputDir, resolveHostChildPath, resolveHostPath } from "../../hostPaths.js";
import { renderSample, sampleWav } from "sidwave/pcm";
import { hostSidwaveReadOptions } from "../../sidwaveHost.js";
import { Buffer } from "node:buffer";
import {
  cancelledResult,
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
} from "../types.js";
import { audioModule, MUSIC_GENERATE_DESCRIPTION } from "../audio.js";
import { metaModule } from "../meta/index.js";
import {
  literalSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "../schema.js";
import {
  buildDescriptorIndex,
  ensureDescriptor,
  extendSchemaWithOp,
  createOperationHandlers,
  invokeModuleTool,
  type GroupedOperationConfig,
  type GenericOperationMap,
} from "./utils.js";
import {
  ToolError,
  ToolValidationError,
  toolErrorResult,
  unknownErrorResult,
} from "../errors.js";
import { jsonResult } from "../responses.js";
import { sidwaveOperationEffects, sidwaveOperations } from "../sidwaveOperations.js";

const audioDescriptorIndex = buildDescriptorIndex(audioModule);
const metaDescriptorIndex = buildDescriptorIndex(metaModule);

/** Largest encoded PCM payload one capture_samples response may carry. */
const MAX_SAMPLE_PAYLOAD_BYTES = 2 * 1024 * 1024;

const captureSamplesArgsSchema = objectSchema({
  description: "Capture Ultimate stereo PCM.",
  properties: {
    op: literalSchema("capture_samples"),
    count: optionalSchema(numberSchema({
      description: "Stereo pairs (max 65536).",
      integer: true,
      minimum: 1,
      maximum: 65536,
      default: 256,
    }), 256),
    encoding: optionalSchema(stringSchema({
      description: "PCM encoding.",
      enum: ["base64", "hex"],
      default: "base64",
    }), "base64"),
  },
  required: ["op"],
  additionalProperties: false,
});

const sampleRenderArgsSchema = objectSchema({
  description: "Render a SIDWAVE sample to WAV.",
  properties: {
    op: literalSchema("sample_render"),
    definition: optionalSchema(objectSchema({ properties: {}, additionalProperties: true })),
    rate: optionalSchema(numberSchema({ integer: true, minimum: 16, maximum: 8000 }), 4000),
    outputDir: optionalSchema(stringSchema({ minLength: 1 })),
  },
  required: ["op"],
});

const soundOperations: GroupedOperationConfig[] = [
  // First, because it is the one operation that plays whatever the user has.
  ...sidwaveOperations.filter(({ op }) => op === "play"),
  {
    op: "sample_render",
    schema: sampleRenderArgsSchema.jsonSchema,
    handler: async (rawArgs, ctx) => {
      try {
        const { definition, rate, outputDir } = sampleRenderArgsSchema.parse(rawArgs);
        if (ctx.signal?.aborted) return cancelledResult();
        const sample = renderSample(definition ?? { kit: "kick" }, rate ?? 4000, hostSidwaveReadOptions);
        const dir = outputDir ? resolveHostPath(outputDir, { purpose: "write" }) : defaultHostOutputDir("artifacts", "samples");
        await mkdir(dir, { recursive: true });
        const outputPath = resolveHostChildPath(dir, `sample-${randomUUID()}.wav`);
        await writeFile(outputPath, sampleWav(sample), { flag: "wx", signal: ctx.signal });
        return jsonResult({ outputPath, stats: sample.stats });
      } catch (error) {
        if (ctx.signal?.aborted) return cancelledResult();
        return toolErrorResult(error instanceof ToolError ? error :
          new ToolValidationError(error instanceof Error ? error.message : String(error)));
      }
    },
  },
  {
    op: "capture_samples",
    schema: captureSamplesArgsSchema.jsonSchema,
    handler: async (rawArgs, ctx) => {
      try {
        const parsed = captureSamplesArgsSchema.parse(rawArgs);
        ctx.logger.info("Capturing audio samples", {
          count: parsed.count,
          encoding: parsed.encoding,
        });

        const capture = await ctx.client.captureSamples({ count: parsed.count, signal: ctx.signal });
        const samplesBuffer = Buffer.from(
          capture.samples.buffer,
          capture.samples.byteOffset,
          capture.samples.byteLength,
        );

        const encodedBytes = parsed.encoding === "hex" ? samplesBuffer.length * 2 : Math.ceil(samplesBuffer.length / 3) * 4;
        if (encodedBytes > MAX_SAMPLE_PAYLOAD_BYTES) {
          throw new ToolValidationError(
            `Sample response would be ${encodedBytes} bytes, above the ${MAX_SAMPLE_PAYLOAD_BYTES} byte limit; lower count`,
            { path: "$.count", details: { count: parsed.count, encodedBytes, limitBytes: MAX_SAMPLE_PAYLOAD_BYTES } },
          );
        }

        return jsonResult(
          {
            backend: capture.backend,
            channels: capture.channels,
            sampleRateHz: capture.sampleRateHz,
            samplePairs: capture.samplePairs,
            byteLength: samplesBuffer.length,
            ...(capture.warnings && capture.warnings.length > 0 ? { warnings: [...capture.warnings] } : {}),
            samples: {
              encoding: parsed.encoding,
              data: parsed.encoding === "hex"
                ? samplesBuffer.toString("hex")
                : samplesBuffer.toString("base64"),
            },
          },
          {
            success: true,
            backend: capture.backend,
            samplePairs: capture.samplePairs,
            sampleRateHz: capture.sampleRateHz,
            channels: capture.channels,
          },
        );
      } catch (error) {
        if (ctx.signal?.aborted) return cancelledResult("Audio capture was cancelled by the client.");
        if (error instanceof ToolError) {
          return toolErrorResult(error);
        }
        return unknownErrorResult(error);
      }
    },
  },
  {
    op: "set_volume",
    schema: extendSchemaWithOp(
      "set_volume",
      ensureDescriptor(audioDescriptorIndex, "sid_volume").inputSchema,
      { description: "Set SID volume ($D418)." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(audioModule, "sid_volume", rawArgs, ctx),
  },
  {
    op: "reset",
    schema: extendSchemaWithOp(
      "reset",
      ensureDescriptor(audioDescriptorIndex, "sid_reset").inputSchema,
      { description: "Reset SID registers." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(audioModule, "sid_reset", rawArgs, ctx),
  },
  {
    op: "note_on",
    schema: extendSchemaWithOp(
      "note_on",
      ensureDescriptor(audioDescriptorIndex, "sid_note_on").inputSchema,
      { description: "Start a SID voice." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(audioModule, "sid_note_on", rawArgs, ctx),
  },
  {
    op: "note_off",
    schema: extendSchemaWithOp(
      "note_off",
      ensureDescriptor(audioDescriptorIndex, "sid_note_off").inputSchema,
      { description: "Release a SID voice." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(audioModule, "sid_note_off", rawArgs, ctx),
  },
  {
    op: "silence_all",
    schema: extendSchemaWithOp(
      "silence_all",
      ensureDescriptor(audioDescriptorIndex, "sid_silence_all").inputSchema,
      { description: "Silence all SID voices." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(audioModule, "sid_silence_all", rawArgs, ctx),
  },
  {
    op: "play_sid_file",
    schema: extendSchemaWithOp(
      "play_sid_file",
      ensureDescriptor(audioDescriptorIndex, "sidplay_file").inputSchema,
      { description: "Play an Ultimate SID file." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(audioModule, "sidplay_file", rawArgs, ctx),
  },
  {
    op: "play_mod_file",
    schema: extendSchemaWithOp(
      "play_mod_file",
      ensureDescriptor(audioDescriptorIndex, "modplay_file").inputSchema,
      { description: "Play an Ultimate MOD file." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(audioModule, "modplay_file", rawArgs, ctx),
  },
  {
    op: "generate",
    schema: extendSchemaWithOp(
      "generate",
      ensureDescriptor(audioDescriptorIndex, "music_generate").inputSchema,
      { description: MUSIC_GENERATE_DESCRIPTION },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(audioModule, "music_generate", rawArgs, ctx),
  },
  {
    op: "compile_play",
    schema: extendSchemaWithOp(
      "compile_play",
      ensureDescriptor(audioDescriptorIndex, "music_compile_and_play").inputSchema,
      { description: "Compile and optionally play SIDWAVE." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(audioModule, "music_compile_and_play", rawArgs, ctx),
  },
  {
    op: "play_preset",
    schema: extendSchemaWithOp(
      "play_preset",
      ensureDescriptor(metaDescriptorIndex, "music_play_preset").inputSchema,
      { description: "Compile and play a built-in SID preset." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "music_play_preset", rawArgs, ctx),
  },
  {
    op: "pipeline",
    schema: extendSchemaWithOp(
      "pipeline",
      ensureDescriptor(metaDescriptorIndex, "music_compile_play_analyze").inputSchema,
      { description: "Compile, play and analyze SIDWAVE." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "music_compile_play_analyze", rawArgs, ctx),
  },
  {
    op: "analyze",
    schema: extendSchemaWithOp(
      "analyze",
      ensureDescriptor(audioDescriptorIndex, "analyze_audio").inputSchema,
      { description: "Check SID audio or a host WAV (musical structure: analyze_music)." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(audioModule, "analyze_audio", rawArgs, ctx),
  },
  {
    op: "record_analyze",
    schema: extendSchemaWithOp(
      "record_analyze",
      ensureDescriptor(audioDescriptorIndex, "record_and_analyze_audio").inputSchema,
      { description: "Analyze a recording from the Ultimate stream or host microphone on other backends." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(audioModule, "record_and_analyze_audio", rawArgs, ctx),
  },
  ...sidwaveOperations.filter(({ op }) => op !== "play"),
];

const soundOperationHandlers = createOperationHandlers(soundOperations);

export const soundModuleGroup = defineToolModule({
  domain: "audio",
  summary: "Grouped SID control, playback, composition, and analysis operations.",
  supportedPlatforms: ["c64u", "u2", "vice"],
  resources: ["c64://sound/sid/spec", "c64://sound/sidwave/spec", "c64://sound/sid/file-format"],
  prompts: ["sid-music"],
  defaultTags: ["sid", "audio"],
  workflowHints: [
    "Trigger note_on or generate when the user wants immediate SID playback.",
    "Follow up playback changes with analyze or silence verification to provide confident audio feedback.",
  ],
  tools: [
    {
      name: "c64_sound",
      description: "Play any music file (op play). SID control, composition, SIDWave conversion, audio analysis.",
      summary: "Adjusts SID registers, plays files, composes music, and runs verification captures.",
      inputSchema: discriminatedUnionSchema({
        description: "Sound operations.",
        variants: soundOperations.map((operation) => operation.schema),
      }),
      operationEffects: {
        sample_render: "write", capture_samples: "read", set_volume: "write", reset: "write", note_on: "write", note_off: "write",
        silence_all: "write", play_sid_file: "write", play_mod_file: "write", generate: "write",
        compile_play: "write", play_preset: "write", pipeline: "write", analyze: "read", record_analyze: "read",
        ...sidwaveOperationEffects,
      },
      tags: ["sid", "audio", "grouped"],
      operationPlatforms: {
        capture_samples: ["c64u"],
        play_sid_file: ["c64u", "u2"],
        play_mod_file: ["c64u", "u2"],
        pipeline: ["c64u", "u2", "vice"],
        analyze: ["c64u", "u2", "vice"],
        record_analyze: ["c64u", "u2", "vice"],
      },
      operationToolNames: {
        play_sid_file: "sidplay_file",
        play_mod_file: "modplay_file",
        play_preset: "music_play_preset",
        pipeline: "music_compile_play_analyze",
        analyze: "analyze_audio",
        record_analyze: "record_and_analyze_audio",
      },
      examples: [
        {
          name: "Capture samples",
          description: "Grab 256 stereo sample pairs from the Ultimate audio stream",
          arguments: { op: "capture_samples" },
        },
        {
          name: "Trigger SID voice",
          description: "Start voice 1 on C4 with a triangle waveform",
          arguments: { op: "note_on", voice: 1, note: "C4", waveform: "tri" },
        },
        {
          name: "Play Für Elise",
          description: "Compile and play the built-in Für Elise preset on the active backend",
          arguments: { op: "play_preset", preset: "fuer_elise" },
        },
        {
          name: "List formats",
          description: "See which music formats can be converted, with what each conversion loses",
          arguments: { op: "formats" },
        },
        {
          name: "Verify silence",
          description: "Stop all voices and confirm the SID output is quiet",
          arguments: { op: "silence_all", verify: true },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_sound",
        soundOperationHandlers,
      ),
    },
  ],
});
