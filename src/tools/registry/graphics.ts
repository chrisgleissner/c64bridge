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
import { Jimp } from "jimp";
import { jsonResult } from "../responses.js";
import { VIC_PALETTE } from "../../vicBitmap.js";
import type { ToolResponseContentImage } from "../types.js";
import {
  ToolError,
  ToolValidationError,
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
      description: "Include raw pixel payload bytes in the response. Off by default because a frame is about 100 KB; the response is rejected above 2 MiB, so lower count when it is on.",
      default: false,
    }), false),
    format: optionalSchema(stringSchema({
      description: "Set to png to receive each frame as an MCP image block (C64 palette). At most 4 frames per call.",
      enum: ["png"],
    })),
    encoding: optionalSchema(stringSchema({
      description: "Encoding used for the pixel payload when included.",
      enum: ["base64", "hex"],
      default: "base64",
    }), "base64"),
  },
  required: ["op"],
  additionalProperties: false,
});

/** Largest raw pixel payload (encoded size, all frames) one capture_frame response may carry. */
export const MAX_CAPTURE_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_PNG_FRAMES = 4;

/**
 * What the PNG rendering changes silently: frameToPngContent masks every pixel
 * with 0x0f, so an index above 15 is drawn in the colour of its low four bits,
 * and the pixels of an incomplete frame are not all captured data.
 */
export function pngRenderingWarnings(frames: ReadonlyArray<{ readonly pixels: Uint8Array; readonly width: number; readonly height: number; readonly complete: boolean }>): {
  outOfPalettePixels: number;
  incompleteFrames: number;
  warnings: string[];
} {
  let outOfPalettePixels = 0;
  let incompleteFrames = 0;
  for (const frame of frames) {
    if (!frame.complete) incompleteFrames += 1;
    const count = Math.min(frame.pixels.length, frame.width * frame.height);
    for (let i = 0; i < count; i += 1) {
      if (frame.pixels[i]! > 0x0f) outOfPalettePixels += 1;
    }
  }
  const warnings: string[] = [];
  if (outOfPalettePixels > 0) {
    warnings.push(`${outOfPalettePixels} pixel(s) have a palette index above 15 and are drawn with their low four bits; the PNG colours for them are wrong.`);
  }
  if (incompleteFrames > 0) {
    warnings.push(`${incompleteFrames} frame(s) are incomplete; missing pixels are drawn as palette index 0 (black).`);
  }
  return { outOfPalettePixels, incompleteFrames, warnings };
}

/** Renders one captured frame (one palette index per byte) as a PNG image content block. */
export async function frameToPngContent(frame: {
  readonly width: number;
  readonly height: number;
  readonly bitsPerPixel: number;
  readonly pixels: Uint8Array;
}): Promise<ToolResponseContentImage> {
  const { width, height } = frame;
  if (frame.bitsPerPixel > 8 || frame.pixels.length < width * height) {
    throw new ToolValidationError("PNG output needs indexed frames with one byte per pixel; use includePixels for raw data", {
      path: "$.format",
      details: { bitsPerPixel: frame.bitsPerPixel, width, height, byteLength: frame.pixels.length },
    });
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const [r, g, b] = VIC_PALETTE[frame.pixels[i]! & 0x0f]!;
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 0xff;
  }
  const image = new Jimp({ width, height, data: rgba });
  const png = await image.getBuffer("image/png");
  return { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" };
}

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
  description: "Read VIC-II and CIA2 registers to determine the current graphics mode and memory layout. The same shared-memory path is used on C64U/U64, U2-family hardware, and VICE, so the response shape is identical.",
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
          format: parsed.format,
        });

        if (parsed.format === "png" && (parsed.count ?? 1) > MAX_PNG_FRAMES) {
          throw new ToolValidationError(`count must be at most ${MAX_PNG_FRAMES} when format is png`, {
            path: "$.count",
            details: { count: parsed.count, maximum: MAX_PNG_FRAMES },
          });
        }

        const capture = await ctx.client.captureFrames({ count: parsed.count });
        const includePixels = parsed.includePixels === true;
        const encoding = parsed.encoding ?? "base64";
        if (includePixels) {
          const rawBytes = capture.frames.reduce((sum, frame) => sum + frame.pixels.length, 0);
          const encodedBytes = encoding === "hex" ? rawBytes * 2 : Math.ceil(rawBytes / 3) * 4;
          if (encodedBytes > MAX_CAPTURE_PAYLOAD_BYTES) {
            throw new ToolValidationError(
              `Raw pixel response would be ${encodedBytes} bytes, above the ${MAX_CAPTURE_PAYLOAD_BYTES} byte limit; lower count or use format png`,
              { path: "$.count", details: { count: parsed.count, encodedBytes, limitBytes: MAX_CAPTURE_PAYLOAD_BYTES } },
            );
          }
        }
        const images = parsed.format === "png"
          ? await Promise.all(capture.frames.map((frame) => frameToPngContent(frame)))
          : [];
        const pngWarnings = parsed.format === "png" ? pngRenderingWarnings(capture.frames) : undefined;
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

        const result = jsonResult(
          {
            backend: capture.backend,
            count: frames.length,
            frames,
            ...(pngWarnings && pngWarnings.warnings.length > 0 ? { warnings: pngWarnings.warnings } : {}),
          },
          {
            success: true,
            backend: capture.backend,
            count: frames.length,
            includePixels,
            encoding: includePixels ? encoding : null,
            format: parsed.format ?? null,
            ...(pngWarnings ? { outOfPalettePixels: pngWarnings.outOfPalettePixels, incompleteFrames: pngWarnings.incompleteFrames } : {}),
          },
        );
        return images.length > 0 ? { ...result, content: [...result.content, ...images] } : result;
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
        // Use cross-platform memory reads so the same handler works on both
        // C64U and VICE. The VIC-II and CIA2 registers live in machine memory
        // either way; the underlying facade hides the transport difference.
        const vicRegs = await ctx.client.readMemoryRaw(0xD011, 8);
        const colorRegs = await ctx.client.readMemoryRaw(0xD020, 2);
        const cia2 = await ctx.client.readMemoryRaw(0xDD00, 1);
        const d011 = vicRegs[0] ?? 0;
        const d016 = vicRegs[5] ?? 0; // $D016 = $D011 + 5
        const d018 = vicRegs[7] ?? 0; // $D018 = $D011 + 7
        const d020 = colorRegs[0] ?? 0;
        const d021 = colorRegs[1] ?? 0;
        const dd00 = cia2[0] ?? 0x03;
        const backend = await ctx.client.getActiveBackendType();
        const state = { ...parseVicState(d011, d016, d018, dd00, d020, d021), backend };
        ctx.logger.info("Read VIC-II display state", { mode: state.mode, bank: state.bank, backend });
        return jsonResult(state, { success: true, mode: state.mode, backend });
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
  supportedPlatforms: ["c64u", "u2", "vice"],
  tools: [
    {
      name: "c64_graphics",
      operationPlatforms: { capture_frame: ["c64u", "vice"] },
      description: "Grouped entry point for frame capture and graphics rendering workflows.",
      summary: "Captures frames, renders PETSCII text or art, previews sprites, and displays bitmap images from one tool.",
      inputSchema: discriminatedUnionSchema({
        description: "Graphics operations available via the c64_graphics tool.",
        variants: graphicsOperations.map((operation) => operation.schema),
      }),
      operationEffects: {
        capture_frame: "read", render_petscii_art: "write", render_petscii_text: "write",
        render_sprite: "write", render_bitmap: "write", get_display_state: "read",
      },
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
        {
          name: "Read VIC-II state",
          description: "Decode graphics mode, memory layout, and colours from VIC-II registers (cross-platform)",
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
