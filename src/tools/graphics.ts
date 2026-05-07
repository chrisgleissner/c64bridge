import { Buffer } from "node:buffer";
import { createPetsciiArt, type Bitmap } from "../petsciiArt.js";
import { importImageAsVicBitmap, type VicBitmapMode } from "../vicBitmap.js";
import {
  defineToolModule,
  OPERATION_DISCRIMINATOR,
  type OperationHandlerMap,
  type OperationMap,
  type ToolExecutionContext,
  type ToolRunResult,
} from "./types.js";
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

interface SpriteArgs extends Record<string, unknown> {
  sprite: Uint8Array;
  index: number;
  x: number;
  y: number;
  color: number;
  multicolour: boolean;
}

interface PetsciiImageArgs extends Record<string, unknown> {
  prompt?: string;
  text?: string;
  maxWidth?: number;
  maxHeight?: number;
  borderColor?: number;
  backgroundColor?: number;
  foregroundColor?: number;
  dryRun: boolean;
  bitmap?: Bitmap;
}

interface GenerateBitmapArgs extends Record<string, unknown> {
  imagePath: string;
  format: VicBitmapMode;
  bitmapAddress?: number;
  screenAddress?: number;
  borderColor?: number;
  backgroundColor?: number;
  preserveAspect: boolean;
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

function decodeSpriteString(value: string, path: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ToolValidationError("Sprite string must not be empty", { path });
  }

  const collapsed = trimmed.replace(/\s+/g, "");
  const base64Pattern = /^(?:[A-Za-z0-9+\/_-]{4})*(?:[A-Za-z0-9+\/_-]{2}(?:==)?|[A-Za-z0-9+\/_-]{3}=)?$/;

  if (collapsed.length % 4 === 0 && base64Pattern.test(collapsed)) {
    try {
      const decoded = Buffer.from(collapsed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (decoded.length === 63) {
        return Uint8Array.from(decoded);
      }
    } catch {
      // Fallback to hex parsing below
    }
  }

  const withoutPrefix = collapsed.startsWith("$") ? collapsed.slice(1) : collapsed;
  const cleaned = withoutPrefix.replace(/[^0-9A-Fa-f]/g, "");
  if (cleaned.length !== 63 * 2) {
    throw new ToolValidationError("Sprite hex string must contain exactly 126 hex characters", { path });
  }
  try {
    return Uint8Array.from(Buffer.from(cleaned, "hex"));
  } catch (error) {
    throw new ToolValidationError("Unable to parse sprite hex string", { path, cause: error });
  }
}

function parseAddressValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalised = trimmed.startsWith("$") ? `0x${trimmed.slice(1)}` : trimmed;
  const parsed = Number(normalised);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xFFFF) {
    return null;
  }
  return parsed;
}

const addressSchema: Schema<number> = {
  jsonSchema: {
    description: "Absolute C64 memory address, provided as an integer or hex string such as $2000.",
    type: ["integer", "string"],
  },
  parse(value: unknown, path?: string): number {
    const resolvedPath = path ?? "$";
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xFFFF) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = parseAddressValue(value);
      if (parsed !== null) {
        return parsed;
      }
    }
    throw new ToolValidationError("Address must be an integer or hex string within $0000-$FFFF", { path: resolvedPath });
  },
};

const spriteBytesSchema: Schema<Uint8Array> = {
  jsonSchema: {
    description: "63-byte sprite definition provided as base64/hex string or array of bytes.",
    type: ["string", "array"],
    items: {
      type: "integer",
      minimum: 0,
      maximum: 255,
    },
    minItems: 63,
    maxItems: 63,
  },
  parse(value: unknown, path?: string): Uint8Array {
    const resolvedPath = path ?? "$";
    if (typeof value === "string") {
      return decodeSpriteString(value, resolvedPath);
    }
    if (Array.isArray(value)) {
      if (value.length !== 63) {
        throw new ToolValidationError("Sprite byte array must contain exactly 63 entries", { path: resolvedPath });
      }
      const bytes = new Uint8Array(63);
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i];
        if (typeof item !== "number" || !Number.isFinite(item)) {
          throw new ToolValidationError("Sprite byte array must contain numbers", { path: `${resolvedPath}[${i}]` });
        }
        if (item < 0 || item > 255) {
          throw new ToolValidationError("Sprite byte values must be between 0 and 255", {
            path: `${resolvedPath}[${i}]`,
            details: { value: item },
          });
        }
        bytes[i] = item & 0xff;
      }
      return bytes;
    }
    throw new ToolValidationError("Sprite must be provided as a string or 63-byte array", { path: resolvedPath });
  },
};

const spriteArgsSchema = objectSchema<SpriteArgs>({
  description: "Display a single sprite by writing supplied sprite data into RAM and patching the relevant VIC-II registers.",
  properties: {
    sprite: spriteBytesSchema,
    index: numberSchema({
      description: "Sprite index (0-7) to configure in screen memory.",
      integer: true,
      minimum: 0,
      maximum: 7,
      default: 0,
    }),
    x: numberSchema({
      description: "Sprite X position (0-511).",
      integer: true,
      minimum: 0,
      maximum: 511,
      default: 100,
    }),
    y: numberSchema({
      description: "Sprite Y position (0-255).",
      integer: true,
      minimum: 0,
      maximum: 255,
      default: 100,
    }),
    color: numberSchema({
      description: "Sprite colour index (0-15).",
      integer: true,
      minimum: 0,
      maximum: 15,
      default: 1,
    }),
    multicolour: booleanSchema({
      description: "Enable multicolour mode for the sprite.",
      default: false,
    }),
  },
  required: ["sprite"],
  additionalProperties: false,
});

const bitmapSchema: Schema<Bitmap> = {
  jsonSchema: {
    description: "Explicit bitmap definition for PETSCII rendering.",
    type: "object",
    properties: {
      width: { type: "integer", minimum: 1, maximum: 320 },
      height: { type: "integer", minimum: 1, maximum: 200 },
      pixels: {
        type: "array",
        items: { type: "integer", minimum: 0, maximum: 1 },
      },
    },
    required: ["width", "height", "pixels"],
    additionalProperties: false,
  },
  parse(value: unknown, path?: string): Bitmap {
    const resolvedPath = path ?? "$";
    if (!value || typeof value !== "object") {
      throw new ToolValidationError("Bitmap definition must be an object", { path: resolvedPath });
    }
    const input = value as Record<string, unknown>;
    const width = Number(input.width);
    const height = Number(input.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new ToolValidationError("Bitmap width and height must be numbers", { path: resolvedPath });
    }
    if (width <= 0 || height <= 0 || width > 320 || height > 200) {
      throw new ToolValidationError("Bitmap dimensions must be within 1..320 x 1..200", { path: resolvedPath, details: { width, height } });
    }
    const pixels = input.pixels;
    if (!Array.isArray(pixels)) {
      throw new ToolValidationError("Bitmap pixels must be an array", { path: `${resolvedPath}.pixels` });
    }
    if (pixels.length !== width * height) {
      throw new ToolValidationError("Bitmap pixel array length must equal width*height", {
        path: `${resolvedPath}.pixels`,
        details: { expected: width * height, received: pixels.length },
      });
    }
    const out = new Uint8Array(width * height);
    for (let i = 0; i < pixels.length; i += 1) {
      const valueAt = pixels[i];
      if (typeof valueAt !== "number" || !Number.isFinite(valueAt)) {
        throw new ToolValidationError("Bitmap pixels must be numeric", { path: `${resolvedPath}.pixels[${i}]` });
      }
      out[i] = valueAt > 0 ? 1 : 0;
    }
    return { width, height, pixels: out };
  },
};

const petsciiImageArgsSchema = objectSchema<PetsciiImageArgs>({
  description: "Generate PETSCII art from text, prompts, or explicit bitmap data.",
  properties: {
    prompt: optionalSchema(stringSchema({
      description: "Natural language prompt describing the desired PETSCII art.",
      minLength: 1,
    })),
    text: optionalSchema(stringSchema({
      description: "Exact text to render in PETSCII (overrides prompt derivation).",
      minLength: 1,
    })),
    maxWidth: optionalSchema(numberSchema({
      description: "Maximum bitmap width in pixels (1-320).",
      integer: true,
      minimum: 1,
      maximum: 320,
    })),
    maxHeight: optionalSchema(numberSchema({
      description: "Maximum bitmap height in pixels (1-200).",
      integer: true,
      minimum: 1,
      maximum: 200,
    })),
    borderColor: optionalSchema(numberSchema({
      description: "Border colour index (0-15).",
      integer: true,
      minimum: 0,
      maximum: 15,
    })),
    backgroundColor: optionalSchema(numberSchema({
      description: "Background colour index (0-15).",
      integer: true,
      minimum: 0,
      maximum: 15,
    })),
    foregroundColor: optionalSchema(numberSchema({
      description: "Foreground colour index (0-15).",
      integer: true,
      minimum: 0,
      maximum: 15,
    })),
    dryRun: booleanSchema({
      description: "When true, skip uploading the generated BASIC program to the C64.",
      default: false,
    }),
    bitmap: optionalSchema(bitmapSchema),
  },
  additionalProperties: false,
});

const renderPetsciiScreenArgsSchema = objectSchema<{
  text: string;
  borderColor?: number;
  backgroundColor?: number;
}>({
  description: "Arguments for rendering PETSCII text on the main screen.",
  properties: {
    text: stringSchema({
      description: "The PETSCII text to print after clearing the screen.",
      minLength: 1,
    }),
    borderColor: optionalSchema(numberSchema({
      description: "Border colour index (0-15).",
      integer: true,
      minimum: 0,
      maximum: 15,
    })),
    backgroundColor: optionalSchema(numberSchema({
      description: "Background colour index (0-15).",
      integer: true,
      minimum: 0,
      maximum: 15,
    })),
  },
  required: ["text"],
  additionalProperties: false,
});

const vicBitmapModeSchema: Schema<VicBitmapMode> = {
  jsonSchema: {
    description: "Bitmap encoding mode to generate for the VIC-II display.",
    type: "string",
    enum: ["hires", "multicolor"],
  },
  parse(value: unknown, path?: string): VicBitmapMode {
    if (value === "hires" || value === "multicolor") {
      return value;
    }
    throw new ToolValidationError("Bitmap format must be either hires or multicolor", { path: path ?? "$" });
  },
};

const generateBitmapArgsSchema = objectSchema<GenerateBitmapArgs>({
  description: "Import an image file, convert it to a VIC-II bitmap, write it into RAM, and enable bitmap mode.",
  properties: {
    imagePath: stringSchema({
      description: "Filesystem path of the source image (PNG, JPEG, BMP, GIF, TIFF, and other Jimp-supported formats).",
      minLength: 1,
    }),
    format: vicBitmapModeSchema,
    bitmapAddress: optionalSchema(addressSchema, 0x2000),
    screenAddress: optionalSchema(addressSchema, 0x0400),
    borderColor: optionalSchema(numberSchema({
      description: "Border colour index (0-15).",
      integer: true,
      minimum: 0,
      maximum: 15,
    }), 0),
    backgroundColor: optionalSchema(numberSchema({
      description: "Background colour index (0-15). Used for multicolor mode and aspect-ratio padding.",
      integer: true,
      minimum: 0,
      maximum: 15,
    }), 0),
    preserveAspect: booleanSchema({
      description: "Preserve the source image aspect ratio and pad with the background colour.",
      default: true,
    }),
  },
  required: ["imagePath", "format"],
  additionalProperties: false,
});

type OperationlessArgs<T extends Record<string, unknown>> = Omit<T, typeof OPERATION_DISCRIMINATOR>;

function stripOperationDiscriminator<T extends Record<string, unknown>>(
  value: T,
): OperationlessArgs<T> {
  const { [OPERATION_DISCRIMINATOR]: _ignored, ...rest } = value;
  return rest as OperationlessArgs<T>;
}

async function executeGenerateSprite(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = spriteArgsSchema.parse(rawArgs ?? {});
    ctx.logger.info("Rendering sprite", {
      index: parsed.index,
      x: parsed.x,
      y: parsed.y,
      color: parsed.color,
      multicolour: parsed.multicolour,
    });

    const result = await ctx.client.generateAndRunSpritePrg({
      spriteBytes: parsed.sprite,
      spriteIndex: parsed.index,
      x: parsed.x,
      y: parsed.y,
      color: parsed.color,
      multicolour: parsed.multicolour,
    });

    if (!result.success) {
      throw new ToolExecutionError("C64 firmware reported failure while rendering sprite", {
        details: normaliseFailure(result.details),
      });
    }

    return textResult("Sprite rendered successfully.", {
      success: true,
      index: parsed.index,
      x: parsed.x,
      y: parsed.y,
      color: parsed.color,
      multicolour: parsed.multicolour,
      spriteByteLength: parsed.sprite.length,
      details: toRecord(result.details) ?? null,
    });
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return toolErrorResult(new ToolExecutionError("Unable to render sprite", {
      details: normaliseFailure(error instanceof Error ? { message: error.message } : error),
    }));
  }
}

async function executeRenderPetscii(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = renderPetsciiScreenArgsSchema.parse(rawArgs ?? {});
    ctx.logger.info("Rendering PETSCII screen", {
      textLength: parsed.text.length,
      borderColor: parsed.borderColor,
      backgroundColor: parsed.backgroundColor,
    });

    const result = await ctx.client.renderPetsciiScreenAndRun(parsed);
    if (!result.success) {
      throw new ToolExecutionError("C64 firmware reported failure while rendering PETSCII text", {
        details: normaliseFailure(result.details),
      });
    }

    return textResult("PETSCII screen rendered successfully.", {
      success: true,
      textLength: parsed.text.length,
      borderColor: parsed.borderColor ?? null,
      backgroundColor: parsed.backgroundColor ?? null,
      details: toRecord(result.details) ?? null,
    });
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return toolErrorResult(new ToolExecutionError("Unable to render PETSCII screen", {
      details: normaliseFailure(error instanceof Error ? { message: error.message } : error),
    }));
  }
}

async function executeGenerateBitmap(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = generateBitmapArgsSchema.parse(rawArgs ?? {});
    ctx.logger.info("Rendering bitmap", {
      imagePath: parsed.imagePath,
      format: parsed.format,
      bitmapAddress: parsed.bitmapAddress,
      screenAddress: parsed.screenAddress,
      preserveAspect: parsed.preserveAspect,
    });

    const prepared = await importImageAsVicBitmap({
      imagePath: parsed.imagePath,
      mode: parsed.format,
      preserveAspect: parsed.preserveAspect,
      backgroundColor: parsed.backgroundColor,
      borderColor: parsed.borderColor,
    });

    const result = await ctx.client.displayBitmap(prepared, {
      bitmapAddress: parsed.bitmapAddress,
      screenAddress: parsed.screenAddress,
    });
    if (!result.success) {
      throw new ToolExecutionError("C64 firmware reported failure while displaying bitmap image", {
        details: normaliseFailure(result.details),
      });
    }

    const details = toRecord(result.details) ?? {};
    const data = {
      mode: prepared.mode,
      imagePath: parsed.imagePath,
      sourceWidth: prepared.sourceWidth,
      sourceHeight: prepared.sourceHeight,
      logicalWidth: prepared.logicalWidth,
      logicalHeight: prepared.logicalHeight,
      displayWidth: prepared.displayWidth,
      displayHeight: prepared.displayHeight,
      backgroundColor: prepared.backgroundColor,
      borderColor: prepared.borderColor,
      bitmapAddress: details.bitmapAddress ?? null,
      screenAddress: details.screenAddress ?? null,
      colorRamAddress: details.colorRamAddress ?? null,
      bank: details.bank ?? null,
      registers: details.registers ?? null,
      bitmapBytes: prepared.bitmapData.length,
      screenBytes: prepared.screenRam.length,
      colorRamBytes: prepared.colorRam.length,
    };

    return jsonResult(data, {
      success: true,
      mode: prepared.mode,
      bank: details.bank ?? null,
      bitmapAddress: details.bitmapAddress ?? null,
      screenAddress: details.screenAddress ?? null,
      sourceWidth: prepared.sourceWidth,
      sourceHeight: prepared.sourceHeight,
    });
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return toolErrorResult(new ToolExecutionError("Unable to import or display bitmap image", {
      details: normaliseFailure(error instanceof Error ? { message: error.message } : error),
    }));
  }
}

async function executeCreatePetscii(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = petsciiImageArgsSchema.parse(rawArgs ?? {});
    if (!parsed.prompt && !parsed.text && !parsed.bitmap) {
      throw new ToolValidationError("Provide a prompt, text, or explicit bitmap definition", { path: "$.prompt" });
    }

    ctx.logger.info("Generating PETSCII art", {
      hasPrompt: Boolean(parsed.prompt),
      hasText: Boolean(parsed.text),
      dryRun: parsed.dryRun,
      hasBitmap: Boolean(parsed.bitmap),
      maxWidth: parsed.maxWidth,
      maxHeight: parsed.maxHeight,
    });

    const art = createPetsciiArt({
      prompt: parsed.prompt,
      text: parsed.text,
      maxWidth: parsed.maxWidth,
      maxHeight: parsed.maxHeight,
      borderColor: parsed.borderColor,
      backgroundColor: parsed.backgroundColor,
      foregroundColor: parsed.foregroundColor,
      bitmap: parsed.bitmap,
    });

    let runResult: { success: boolean; details?: unknown } | undefined;
    if (!parsed.dryRun) {
      runResult = await ctx.client.uploadAndRunBasic(art.program);
      if (!runResult.success) {
        throw new ToolExecutionError("C64 firmware reported failure while rendering PETSCII art", {
          details: normaliseFailure(runResult.details),
        });
      }
    }

    const ranOnC64 = !parsed.dryRun && Boolean(runResult?.success);
    const data = {
      success: parsed.dryRun ? true : Boolean(runResult?.success ?? true),
      ranOnC64,
      runDetails: runResult?.details ?? null,
      program: art.program,
      bitmapHex: art.bitmapHex,
      rowHex: art.rowHex,
      width: art.bitmap.width,
      height: art.bitmap.height,
      charColumns: art.charColumns,
      charRows: art.charRows,
      petsciiCodes: art.petsciiCodes,
      usedShape: art.usedShape ?? null,
      sourceText: art.sourceText ?? null,
      ragRefs: null,
    };

    return jsonResult(data, {
      ranOnC64,
      dryRun: parsed.dryRun,
      width: art.bitmap.width,
      height: art.bitmap.height,
      charColumns: art.charColumns,
      charRows: art.charRows,
    });
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return unknownErrorResult(error);
  }
}

export interface GraphicsOperationMap extends OperationMap {
  readonly render_petscii_art: PetsciiImageArgs;
  readonly render_bitmap: GenerateBitmapArgs;
  readonly render_petscii_text: {
    readonly text: string;
    readonly borderColor?: number;
    readonly backgroundColor?: number;
  };
  readonly render_sprite: SpriteArgs;
}

export const graphicsOperationHandlers: OperationHandlerMap<GraphicsOperationMap> = {
  render_petscii_art: async (args, ctx) => executeCreatePetscii(stripOperationDiscriminator(args), ctx),
  render_bitmap: async (args, ctx) => executeGenerateBitmap(stripOperationDiscriminator(args), ctx),
  render_petscii_text: async (args, ctx) => executeRenderPetscii(stripOperationDiscriminator(args), ctx),
  render_sprite: async (args, ctx) => executeGenerateSprite(stripOperationDiscriminator(args), ctx),
};

export const graphicsModule = defineToolModule({
  domain: "graphics",
  summary: "PETSCII art, sprite workflows, and VIC-II graphics helpers.",
  resources: [
    "c64://graphics/vic/spec",
    "c64://assembly/6510-spec",
    "c64://basic/spec",
  ],
  prompts: ["graphics-demo", "basic-program", "assembly-program"],
  defaultTags: ["graphics", "vic"],
  workflowHints: [
    "Suggest graphics helpers when the user asks for sprites, PETSCII art, or screen layout tweaks.",
    "Mention how VIC-II state changes (colours, sprite positions) affect follow-up memory operations.",
  ],
  tools: [
    {
      name: "render_sprite",
      description: "Display supplied 63-byte sprite data at the requested position and colour by writing memory and patching VIC-II registers directly. See c64://graphics/vic/spec for registers.",
      summary: "Writes sprite data into RAM, updates the sprite pointer table, and patches VIC-II registers to render a sprite preview.",
      inputSchema: spriteArgsSchema.jsonSchema,
      relatedResources: ["c64://graphics/vic/spec"],
      relatedPrompts: ["graphics-demo", "assembly-program"],
      tags: ["sprite", "assembly", "pal-ntsc"],
  prerequisites: ["upload_run_asm"],
      examples: [
        {
          name: "Render sprite 0",
          description: "Show sprite at 100,100",
          arguments: { sprite: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", index: 0, x: 100, y: 100, color: 1, multicolour: false },
        },
      ],
      workflowHints: [
        "Use when the user supplies sprite bytes or asks to preview graphics quickly; describe resulting coordinates and colours.",
        "Remind the user that sprites live in banked memory so further tweaks may require write_memory calls.",
      ],
      supportedPlatforms: ["c64u", "vice"] as const,
      async execute(args, ctx) {
        return executeGenerateSprite(args, ctx);
      },
    },
    {
      name: "render_bitmap",
      description: "Import an image file, convert it to a VIC-II bitmap, write it into RAM, and display it.",
      summary: "Decodes a source image, quantizes it into C64 colours, writes bitmap/screen/color RAM, and displays it in hires or multicolor bitmap mode.",
      inputSchema: generateBitmapArgsSchema.jsonSchema,
      relatedResources: ["c64://graphics/vic/spec", "c64://guide/bootstrap"],
      relatedPrompts: ["graphics-demo"],
      tags: ["bitmap", "vic", "image"],
      workflowHints: [
        "Use when the user wants to display an external image on screen rather than generate PETSCII art.",
        "Call out the selected bitmap and screen RAM addresses so follow-up memory inspection or raster work stays grounded.",
      ],
      supportedPlatforms: ["c64u", "vice"] as const,
      async execute(args, ctx) {
        return executeGenerateBitmap(args, ctx);
      },
    },
    {
      name: "render_petscii_text",
      description: "Display PETSCII text with optional border and background colours. See c64://basic/spec.",
      summary: "Generates a BASIC program that clears the screen, sets colours, and prints text.",
      inputSchema: renderPetsciiScreenArgsSchema.jsonSchema,
      relatedResources: ["c64://basic/spec", "c64://guide/bootstrap"],
      relatedPrompts: ["basic-program", "graphics-demo"],
      tags: ["basic", "screen"],
  prerequisites: ["upload_run_basic"],
      examples: [
        {
          name: "Render text",
          description: "Blue border, black background",
          arguments: { text: "HELLO", borderColor: 6, backgroundColor: 0 },
        },
      ],
      workflowHints: [
        "Call after generating PETSCII text or when the user wants border/background colour changes applied.",
        "Echo the colour indices and mention CLEAR + PRINT so the user knows what ran.",
      ],
      supportedPlatforms: ["c64u", "vice"] as const,
      async execute(args, ctx) {
        return executeRenderPetscii(args, ctx);
      },
    },
    {
      name: "render_petscii_art",
      description: "Create PETSCII art from prompts, text, or bitmap input, and optionally display it on the C64. Returns metadata including PETSCII codes and glyphs. See c64://basic/spec, c64://graphics/vic/spec, and c64://graphics/character-set.",
      summary: "Synthesises PETSCII art, generates a BASIC program with preview metadata (petsciiCodes, glyphs, dimensions), and uploads it unless dry-run is requested.",
      inputSchema: petsciiImageArgsSchema.jsonSchema,
      relatedResources: ["c64://basic/spec", "c64://graphics/vic/spec", "c64://graphics/character-set"],
      relatedPrompts: ["graphics-demo", "basic-program"],
      tags: ["petscii", "basic", "pal-ntsc"],
  prerequisites: ["upload_run_basic"],
      examples: [
        {
          name: "Generate PETSCII",
          description: "Run art with default colours",
          arguments: { prompt: "cat", dryRun: false },
        },
      ],
      workflowHints: [
        "Trigger when the user provides creative prompts; clarify whether you ran the art or left it as a dry run.",
        "Response includes petsciiCodes array and glyphs for character-level inspection.",
        "Provide follow-up suggestions like saving the PRG or capturing the screen after rendering.",
      ],
      supportedPlatforms: ["c64u", "vice"] as const,
      async execute(args, ctx) {
        return executeCreatePetscii(args, ctx);
      },
    },
  ],
});
