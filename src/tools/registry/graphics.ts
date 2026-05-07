import { Buffer } from "node:buffer";
import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
} from "../types.js";
import { graphicsModule, graphicsOperationHandlers as groupedGraphicsHandlers } from "../graphics.js";
import {
  booleanSchema,
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
  type GroupedOperationConfig,
  type GenericOperationMap,
} from "./utils.js";
import {
  ToolError,
  toolErrorResult,
  unknownErrorResult,
} from "../errors.js";
import { jsonResult } from "../responses.js";

const graphicsDescriptorIndex = buildDescriptorIndex(graphicsModule);

const captureFrameArgsSchema = objectSchema({
  description: "Capture one or more complete video frames from the active backend.",
  properties: {
    op: literalSchema("capture_frame"),
    count: optionalSchema(numberSchema({
      description: "Number of frames to capture.",
      integer: true,
      minimum: 1,
      maximum: 32,
      default: 1,
    }), 1),
    includePixels: optionalSchema(booleanSchema({
      description: "Include pixel payload bytes in the response.",
      default: true,
    }), true),
    encoding: optionalSchema(stringSchema({
      description: "Encoding used for the pixel payload when included.",
      enum: ["base64", "hex"],
      default: "base64",
    }), "base64"),
  },
  required: ["op"],
  additionalProperties: false,
});

const graphicsOperations: GroupedOperationConfig[] = [
  {
    op: "capture_frame",
    schema: captureFrameArgsSchema.jsonSchema,
    handler: async (rawArgs, ctx) => {
      try {
        const parsed = captureFrameArgsSchema.parse(rawArgs);
        ctx.logger.info("Capturing frame buffer", {
          count: parsed.count,
          includePixels: parsed.includePixels,
          encoding: parsed.encoding,
        });

        const capture = await ctx.client.captureFrames({ count: parsed.count });
        const includePixels = parsed.includePixels !== false;
        const encoding = parsed.encoding ?? "base64";
        const frames = capture.frames.map((frame, index) => {
          const pixels = includePixels
            ? {
                encoding,
                data: encoding === "hex"
                  ? Buffer.from(frame.pixels).toString("hex")
                  : Buffer.from(frame.pixels).toString("base64"),
              }
            : undefined;

          return {
            index,
            frameNumber: frame.frameNumber,
            width: frame.width,
            height: frame.height,
            bitsPerPixel: frame.bitsPerPixel,
            byteLength: frame.pixels.length,
            complete: frame.complete,
            ...(pixels ? { pixels } : {}),
          };
        });

        return jsonResult(
          {
            backend: capture.backend,
            count: frames.length,
            frames,
          },
          {
            success: true,
            backend: capture.backend,
            count: frames.length,
            includePixels,
            encoding: includePixels ? encoding : null,
          },
        );
      } catch (error) {
        if (error instanceof ToolError) {
          return toolErrorResult(error);
        }
        return unknownErrorResult(error);
      }
    },
  },
  {
    op: "render_petscii_art",
    schema: extendSchemaWithOp(
      "render_petscii_art",
      ensureDescriptor(graphicsDescriptorIndex, "render_petscii_art").inputSchema,
      { description: "Create PETSCII art from prompts, text, or explicit bitmap data, and optionally display it on the C64." },
    ),
    handler: groupedGraphicsHandlers.render_petscii_art,
  },
  {
    op: "render_petscii_text",
    schema: extendSchemaWithOp(
      "render_petscii_text",
      ensureDescriptor(graphicsDescriptorIndex, "render_petscii_text").inputSchema,
      { description: "Display PETSCII text with optional border and background colours." },
    ),
    handler: groupedGraphicsHandlers.render_petscii_text,
  },
  {
    op: "render_sprite",
    schema: extendSchemaWithOp(
      "render_sprite",
      ensureDescriptor(graphicsDescriptorIndex, "render_sprite").inputSchema,
      { description: "Display supplied 63-byte sprite data at the requested position and colour by writing memory and patching VIC-II registers directly." },
    ),
    handler: groupedGraphicsHandlers.render_sprite,
  },
  {
    op: "render_bitmap",
    schema: extendSchemaWithOp(
      "render_bitmap",
      ensureDescriptor(graphicsDescriptorIndex, "render_bitmap").inputSchema,
      { description: "Import an image file, convert it to VIC-II bitmap memory, write it into RAM, and display it." },
    ),
    handler: groupedGraphicsHandlers.render_bitmap,
  },
];

const graphicsOperationHandlers = createOperationHandlers(graphicsOperations);

export const graphicsModuleGroup = defineToolModule({
  domain: "graphics",
  summary: "Grouped frame capture and graphics rendering helpers.",
  resources: ["c64://graphics/vic/spec", "c64://basic/spec", "c64://assembly/6510-spec"],
  prompts: ["graphics-demo", "basic-program", "assembly-program"],
  defaultTags: ["graphics", "vic"],
  workflowHints: [
    "Use render helpers for PETSCII text, PETSCII art, sprites, and bitmaps; clarify whether PETSCII art executed or stayed a dry run.",
    "Mention sprite positions/colours so follow-up memory inspection stays grounded.",
  ],
  supportedPlatforms: ["c64u", "vice"],
  tools: [
    {
      name: "c64_graphics",
      description: "Grouped entry point for frame capture and graphics rendering workflows.",
      summary: "Captures frames, renders PETSCII text or art, previews sprites, and displays bitmap images from one tool.",
      inputSchema: discriminatedUnionSchema({
        description: "Graphics operations available via the c64_graphics tool.",
        variants: graphicsOperations.map((operation) => operation.schema),
      }),
      tags: ["graphics", "vic", "grouped"],
      examples: [
        {
          name: "Capture one frame",
          description: "Grab the current framebuffer from the active backend",
          arguments: { op: "capture_frame" },
        },
        {
          name: "Create PETSCII art (dry run)",
          description: "Synthesize art without uploading to the C64",
          arguments: { op: "render_petscii_art", prompt: "duck on a pond", dryRun: true },
        },
        {
          name: "Render PETSCII text",
          description: "Print HELLO with blue border",
          arguments: { op: "render_petscii_text", text: "HELLO", borderColor: 6 },
        },
        {
          name: "Display sprite",
          description: "Show sprite data at coordinates",
          arguments: { op: "render_sprite", sprite: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
        },
        {
          name: "Import bitmap image",
          description: "Convert a PNG into VIC bitmap memory and display it",
          arguments: { op: "render_bitmap", imagePath: "./artifacts/sample.png", format: "hires" },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_graphics",
        graphicsOperationHandlers,
      ),
    },
  ],
});
