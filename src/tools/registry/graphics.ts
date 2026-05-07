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
import { jsonResult } from "../responses.js";
import {
  ToolError,
  toolErrorResult,
  unknownErrorResult,
} from "../errors.js";

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

// ---------------------------------------------------------------------------
// get_display_state helpers — VIC-II register decoding
// ---------------------------------------------------------------------------
function parseVicState(d011: number, d016: number, d018: number, dd00: number, d020: number, d021: number) {
  const bank = (~dd00) & 0x03; // CIA2 Port A bits 0-1 select VIC bank (inverted)
  const bankBase = bank * 0x4000;
  const bitmapMode = (d011 & 0x20) !== 0;
  const extendedColor = (d011 & 0x40) !== 0;
  const multicolor = (d016 & 0x10) !== 0;
  const screenVisible = (d011 & 0x10) !== 0;
  const raster8 = (d011 & 0x80) !== 0;
  const vertScroll = d011 & 0x07;
  const horizScroll = d016 & 0x07;
  const columns40 = (d016 & 0x08) !== 0;
  const rows25 = (d011 & 0x08) !== 0;
  // D018 bits 4-7 = screen RAM offset (× $0400); bits 1-3 = char/bitmap pointer (× $0800)
  const screenRamOffset = ((d018 >> 4) & 0x0f) * 0x0400;
  const screenRamAddress = bankBase + screenRamOffset;
  const charOrBitmapPointer = ((d018 >> 1) & 0x07) * 0x0800;
  const charOrBitmapAddress = bankBase + charOrBitmapPointer;
  let mode: string;
  if (bitmapMode && multicolor) mode = "multicolor_bitmap";
  else if (bitmapMode) mode = "hires_bitmap";
  else if (extendedColor) mode = "extended_color_text";
  else if (multicolor) mode = "multicolor_text";
  else mode = "standard_text";
  return {
    mode,
    bank,
    bankBase: `$${bankBase.toString(16).toUpperCase().padStart(4, "0")}`,
    screenRamAddress: `$${screenRamAddress.toString(16).toUpperCase().padStart(4, "0")}`,
    charOrBitmapAddress: `$${charOrBitmapAddress.toString(16).toUpperCase().padStart(4, "0")}`,
    screenVisible,
    bitmapMode,
    extendedColor,
    multicolor,
    rows25,
    columns40,
    vertScroll,
    horizScroll,
    raster8,
    borderColor: d020 & 0x0f,
    backgroundColor: d021 & 0x0f,
    registers: {
      d011: `$${d011.toString(16).toUpperCase().padStart(2, "0")}`,
      d016: `$${d016.toString(16).toUpperCase().padStart(2, "0")}`,
      d018: `$${d018.toString(16).toUpperCase().padStart(2, "0")}`,
      d020: `$${d020.toString(16).toUpperCase().padStart(2, "0")}`,
      d021: `$${d021.toString(16).toUpperCase().padStart(2, "0")}`,
      dd00: `$${dd00.toString(16).toUpperCase().padStart(2, "0")}`,
    },
  };
}

const getDisplayStateArgsSchema = objectSchema({
  description: "Read VIC-II and CIA2 registers to determine the current graphics mode and memory layout (VICE only).",
  properties: {
    op: literalSchema("get_display_state"),
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
  {
    op: "get_display_state",
    schema: getDisplayStateArgsSchema.jsonSchema,
    handler: async (_rawArgs, ctx) => {
      try {
        // Read $D011, $D016, $D018 from VIC-II (3 bytes starting at $D011)
        const vicRegs = await ctx.client.viceMemGet(0xD011, 8);
        // Read $D020 (border colour) and $D021 (background 0)
        const colorRegs = await ctx.client.viceMemGet(0xD020, 2);
        // Read CIA2 Port A ($DD00) for VIC bank
        const cia2 = await ctx.client.viceMemGet(0xDD00, 1);
        const d011 = vicRegs[0] ?? 0;
        const d016 = vicRegs[5] ?? 0; // $D016 = $D011 + 5
        const d018 = vicRegs[7] ?? 0; // $D018 = $D011 + 7
        const d020 = colorRegs[0] ?? 0;
        const d021 = colorRegs[1] ?? 0;
        const dd00 = cia2[0] ?? 0x03;
        const state = parseVicState(d011, d016, d018, dd00, d020, d021);
        ctx.logger.info("Read VIC-II display state", { mode: state.mode, bank: state.bank });
        return jsonResult(state, { success: true, mode: state.mode });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
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
      operationPlatforms: { get_display_state: ["vice"] },
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
        {
          name: "Read VIC-II state",
          description: "Decode graphics mode, memory layout, and colours from VIC-II registers (VICE only)",
          arguments: { op: "get_display_state" },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_graphics",
        graphicsOperationHandlers,
      ),
    },
  ],
});
