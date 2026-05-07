import { defineToolModule } from "./types.js";
import {
  arraySchema,
  booleanSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
  type Schema,
} from "./schema.js";
import { textResult } from "./responses.js";
import {
  ToolExecutionError,
  ToolValidationError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";
import { ToolError } from "./errors.js";

interface PrintTextArgs extends Record<string, unknown> {
  text: string;
  target: "commodore" | "epson";
  secondaryAddress?: 0 | 7;
  formFeed: boolean;
}

interface CommodoreBitmapArgs extends Record<string, unknown> {
  columns: readonly number[];
  repeats?: number;
  useSubRepeat?: number;
  secondaryAddress?: 0 | 7;
  ensureMsb: boolean;
}

interface EpsonBitmapArgs extends Record<string, unknown> {
  columns: readonly number[];
  mode: "K" | "L" | "Y" | "Z" | "*";
  density?: number;
  repeats?: number;
  timesPerLine?: number;
}

interface CommodoreDllChar extends Record<string, unknown> {
  a?: 0 | 1;
  columns: readonly number[];
}

interface CommodoreDllArgs extends Record<string, unknown> {
  firstChar: number;
  chars: readonly CommodoreDllChar[];
  secondaryAddress?: 0 | 7;
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

const secondaryAddressSchema: Schema<0 | 7> = {
  jsonSchema: {
    description: "Secondary address for device 4 (0 = upper/graphics, 7 = lowercase).",
    type: "integer",
    enum: [0, 7],
  },
  parse(value: unknown, path?: string): 0 | 7 {
    const resolvedPath = path ?? "$";
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new ToolValidationError("Secondary address must be an integer", { path: resolvedPath });
    }
    if (value !== 0 && value !== 7) {
      throw new ToolValidationError("Secondary address must be 0 or 7", { path: resolvedPath });
    }
    return value as 0 | 7;
  },
};

const printerTargetSchema: Schema<"commodore" | "epson"> = {
  jsonSchema: {
    description: "Printer target: Commodore MPS (PETSCII) or Epson FX (ESC/P).",
    type: "string",
    enum: ["commodore", "epson"],
    default: "commodore",
  },
  parse(value: unknown, path?: string): "commodore" | "epson" {
    if (value === undefined || value === null) {
      return "commodore";
    }
    const resolvedPath = path ?? "$";
    if (typeof value !== "string") {
      throw new ToolValidationError("Printer target must be a string", { path: resolvedPath });
    }
    const lowered = value.toLowerCase();
    if (lowered !== "commodore" && lowered !== "epson") {
      throw new ToolValidationError("Printer target must be 'commodore' or 'epson'", { path: resolvedPath });
    }
    return lowered as "commodore" | "epson";
  },
};

const printTextArgsSchema = objectSchema<PrintTextArgs>({
  description: "Generate a BASIC program that prints text to device 4 and executes it on the C64.",
  properties: {
    text: stringSchema({
      description: "Text to print on the connected printer.",
      minLength: 1,
    }),
    target: printerTargetSchema,
    secondaryAddress: optionalSchema(secondaryAddressSchema),
    formFeed: booleanSchema({
      description: "Emit a form-feed (CHR$(12)) at the end of the job.",
      default: false,
    }),
  },
  required: ["text"],
  additionalProperties: false,
});

const commodoreBitmapArgsSchema = objectSchema<CommodoreBitmapArgs>({
  description: "Print a Commodore MPS bit-image row via generated BASIC.",
  properties: {
    columns: arraySchema(
      numberSchema({
        description: "Column byte (0-255).",
        integer: true,
        minimum: 0,
        maximum: 255,
      }),
      {
        description: "Sequence of bitmap columns.",
        minItems: 1,
      },
    ),
    repeats: optionalSchema(numberSchema({
      description: "Number of times to repeat the row (1-255).",
      integer: true,
      minimum: 1,
      maximum: 255,
    })),
    useSubRepeat: optionalSchema(numberSchema({
      description: "Use BIM SUB to repeat the next byte this many times (1-255).",
      integer: true,
      minimum: 1,
      maximum: 255,
    })),
    secondaryAddress: optionalSchema(secondaryAddressSchema),
    ensureMsb: booleanSchema({
      description: "Ensure the MSB of each byte is set (Commodore printers expect bit7=1).",
      default: true,
    }),
  },
  required: ["columns"],
  additionalProperties: false,
});

const epsonModeSchema: Schema<"K" | "L" | "Y" | "Z" | "*"> = {
  jsonSchema: {
    description: "ESC/P graphics mode.",
    type: "string",
    enum: ["K", "L", "Y", "Z", "*"],
    default: "K",
  },
  parse(value: unknown, path?: string): "K" | "L" | "Y" | "Z" | "*" {
    if (value === undefined || value === null) {
      return "K";
    }
    const resolvedPath = path ?? "$";
    if (typeof value !== "string") {
      throw new ToolValidationError("ESC/P mode must be a string", { path: resolvedPath });
    }
    const upper = value.toUpperCase();
    if (!(["K", "L", "Y", "Z", "*"] as const).includes(upper as any)) {
      throw new ToolValidationError("Invalid ESC/P mode", { path: resolvedPath });
    }
    return upper as "K" | "L" | "Y" | "Z" | "*";
  },
};

const commodoreDllAttributeSchema: Schema<0 | 1> = {
  jsonSchema: {
    description: "Attribute flag (0=normal, 1=graphics).",
    type: "integer",
    enum: [0, 1],
  },
  parse(value: unknown, path?: string): 0 | 1 {
    const resolvedPath = path ?? "$";
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new ToolValidationError("Attribute must be 0 or 1", { path: resolvedPath });
    }
    if (value !== 0 && value !== 1) {
      throw new ToolValidationError("Attribute must be 0 or 1", { path: resolvedPath });
    }
    return value as 0 | 1;
  },
};

const epsonBitmapArgsSchema = objectSchema<EpsonBitmapArgs>({
  description: "Print an Epson FX bitmap row using ESC/P commands.",
  properties: {
    columns: arraySchema(
      numberSchema({
        description: "Column byte (0-255).",
        integer: true,
        minimum: 0,
        maximum: 255,
      }),
      {
        description: "Sequence of bitmap columns.",
        minItems: 1,
      },
    ),
    mode: epsonModeSchema,
    density: optionalSchema(numberSchema({
      description: "Density parameter used with '*' mode (0-3).",
      integer: true,
      minimum: 0,
      maximum: 3,
    })),
    repeats: optionalSchema(numberSchema({
      description: "Number of times to repeat the row (1-255).",
      integer: true,
      minimum: 1,
      maximum: 255,
    })),
    timesPerLine: optionalSchema(numberSchema({
      description: "Number of times to print the row per line (1-10).",
      integer: true,
      minimum: 1,
      maximum: 10,
    })),
  },
  required: ["columns"],
  additionalProperties: false,
});

const commodoreDllCharSchema = objectSchema<CommodoreDllChar>({
  description: "Commodore MPS DLL character definition (11 columns).",
  properties: {
    a: optionalSchema(commodoreDllAttributeSchema),
    columns: arraySchema(
      numberSchema({
        description: "Column byte (0-255).",
        integer: true,
        minimum: 0,
        maximum: 255,
      }),
      {
        description: "11 column bytes describing the character.",
        minItems: 11,
        maxItems: 11,
      },
    ),
  },
  required: ["columns"],
  additionalProperties: false,
});

const commodoreDllArgsSchema = objectSchema<CommodoreDllArgs>({
  description: "Define custom character bitmaps on Commodore MPS printers via DLL mode.",
  properties: {
    firstChar: numberSchema({
      description: "PETSCII code of first character to redefine (33-126).",
      integer: true,
      minimum: 33,
      maximum: 126,
    }),
    chars: arraySchema(commodoreDllCharSchema, {
      description: "Character definitions to upload (1-32).",
      minItems: 1,
      maxItems: 32,
    }),
    secondaryAddress: optionalSchema(secondaryAddressSchema),
  },
  required: ["firstChar", "chars"],
  additionalProperties: false,
});

function validateEpsonDensity(args: EpsonBitmapArgs): void {
  if (args.mode === "*" && args.density === undefined) {
    throw new ToolValidationError("density is required when mode '*' is selected", { path: "$.density" });
  }
}

export const printerModule = defineToolModule({
  domain: "printer",
  summary: "Printer workflow helpers for Commodore MPS and Epson FX devices, including prompt templates.",
  resources: [
    "c64://printer/spec",
    "c64://printer/commodore/text",
    "c64://printer/commodore/bitmap",
    "c64://printer/epson/text",
    "c64://printer/epson/bitmap",
    "c64://printer/prompt-guide",
  ],
  prompts: ["printer-job"],
  defaultTags: ["printer"],
  workflowHints: [
    "Reach for printer tools when the user references device 4, hardcopy output, or specific printer models.",
    "Clarify which workflow (Commodore vs Epson) you chose so the user can prepare matching paper or ribbons.",
  ],
  tools: [
    {
      name: "print_text",
      description: "Print text on device 4 using Commodore or Epson workflows. See c64://printer/spec.",
      summary: "Generates printer BASIC, opens device 4, prints text, and optionally emits a form feed.",
      inputSchema: printTextArgsSchema.jsonSchema,
      relatedResources: ["c64://printer/spec"],
      relatedPrompts: ["printer-job"],
      tags: ["text"],
  prerequisites: ["upload_run_basic"],
      examples: [
        {
          name: "Print line",
          description: "Print via Commodore device 4",
          arguments: { text: "HELLO", target: "commodore", formFeed: true },
        },
      ],
      workflowHints: [
        "Invoke when the user wants BASIC-generated printer output; state which target (Commodore or Epson) you selected.",
        "Mention whether you appended a form feed so they know if the page advanced.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = printTextArgsSchema.parse(args ?? {});
          ctx.logger.info("Printing text via BASIC program", {
            target: parsed.target,
            textLength: parsed.text.length,
            secondaryAddress: parsed.secondaryAddress,
            formFeed: parsed.formFeed,
          });

          const result = await ctx.client.printTextOnPrinterAndRun({
          text: parsed.text,
          target: parsed.target,
          secondaryAddress: parsed.secondaryAddress,
          formFeed: parsed.formFeed,
        });

        if (!result.success) {
          throw new ToolExecutionError("C64 firmware reported failure while printing text", {
            details: normaliseFailure(result.details),
          });
        }

        return textResult("Printer job completed successfully.", {
          success: true,
          target: parsed.target,
          textLength: parsed.text.length,
          secondaryAddress: parsed.secondaryAddress ?? null,
          formFeed: parsed.formFeed,
          details: toRecord(result.details) ?? null,
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
      name: "print_bitmap_commodore",
      description: "Print a Commodore MPS bit-image row using BIM BASIC helpers.",
      summary: "Generates BASIC that emits Commodore BIM commands for the provided bitmap columns.",
      inputSchema: commodoreBitmapArgsSchema.jsonSchema,
      relatedResources: ["c64://printer/commodore/bitmap"],
      relatedPrompts: ["printer-job"],
      tags: ["bitmap", "commodore"],
  prerequisites: ["upload_run_basic"],
      examples: [
        {
          name: "Print row",
          description: "Commodore bitmap columns",
          arguments: { columns: [255,0,255], repeats: 2 },
        },
      ],
      workflowHints: [
        "Use for Commodore MPS graphics rows; highlight column count and repeats in your response.",
        "Suggest running define_printer_chars first if the user needs custom glyphs alongside bitmaps.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = commodoreBitmapArgsSchema.parse(args ?? {});
          ctx.logger.info("Printing Commodore bitmap row", {
            columnCount: parsed.columns.length,
            repeats: parsed.repeats,
            useSubRepeat: parsed.useSubRepeat,
            secondaryAddress: parsed.secondaryAddress,
            ensureMsb: parsed.ensureMsb,
          });

          const result = await ctx.client.printBitmapOnCommodoreAndRun({
          columns: Array.from(parsed.columns, (value) => value & 0xff),
          repeats: parsed.repeats,
          useSubRepeat: parsed.useSubRepeat,
          secondaryAddress: parsed.secondaryAddress,
          ensureMsb: parsed.ensureMsb,
        });

        if (!result.success) {
          throw new ToolExecutionError("C64 firmware reported failure while printing Commodore bitmap", {
            details: normaliseFailure(result.details),
          });
        }

        return textResult("Commodore bitmap row printed successfully.", {
          success: true,
          columnCount: parsed.columns.length,
          repeats: parsed.repeats ?? 1,
          useSubRepeat: parsed.useSubRepeat ?? null,
          secondaryAddress: parsed.secondaryAddress ?? null,
          ensureMsb: parsed.ensureMsb,
          details: toRecord(result.details) ?? null,
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
      name: "print_bitmap_epson",
      description: "Print an Epson FX bit-image row using ESC/P commands.",
      summary: "Generates BASIC that emits ESC/P graphics commands for Epson printers.",
      inputSchema: epsonBitmapArgsSchema.jsonSchema,
      relatedResources: ["c64://printer/epson/bitmap"],
      relatedPrompts: ["printer-job"],
      tags: ["bitmap", "epson"],
  prerequisites: ["upload_run_basic"],
      examples: [
        {
          name: "Epson row",
          description: "ESC/P graphics",
          arguments: { columns: [170,85,170], mode: "K", repeats: 1 },
        },
      ],
      workflowHints: [
        "Pick this for Epson FX graphics; confirm ESC/P mode and density so the user can match expectations.",
        "Warn if the bitmap is very wide and recommend batching columns to avoid memory limits.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = epsonBitmapArgsSchema.parse(args ?? {});
          validateEpsonDensity(parsed);
          ctx.logger.info("Printing Epson bitmap row", {
            columnCount: parsed.columns.length,
            mode: parsed.mode,
            density: parsed.density,
            repeats: parsed.repeats,
            timesPerLine: parsed.timesPerLine,
          });

          const result = await ctx.client.printBitmapOnEpsonAndRun({
          columns: Array.from(parsed.columns, (value) => value & 0xff),
          mode: parsed.mode,
          density: parsed.density,
          repeats: parsed.repeats,
          timesPerLine: parsed.timesPerLine,
        });

        if (!result.success) {
          throw new ToolExecutionError("C64 firmware reported failure while printing Epson bitmap", {
            details: normaliseFailure(result.details),
          });
        }

        return textResult("Epson bitmap row printed successfully.", {
          success: true,
          columnCount: parsed.columns.length,
          mode: parsed.mode,
          density: parsed.density ?? null,
          repeats: parsed.repeats ?? 1,
          timesPerLine: parsed.timesPerLine ?? 1,
          details: toRecord(result.details) ?? null,
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
      name: "define_printer_chars",
      description: "Define custom characters on Commodore MPS printers using DLL mode.",
      summary: "Uploads custom glyph data (11 columns each) for device 4 DLL mode.",
      inputSchema: commodoreDllArgsSchema.jsonSchema,
      relatedResources: ["c64://printer/commodore/bitmap"],
      relatedPrompts: ["printer-job"],
      tags: ["dll", "commodore"],
  prerequisites: ["upload_run_basic"],
      examples: [
        {
          name: "Define glyphs",
          description: "Two custom chars from columns",
          arguments: { firstChar: 65, chars: [{ columns: [0,0,0,0,0,0,0,0,0,0,0] }, { columns: [255,255,255,255,255,255,255,255,255,255,255] }] },
        },
      ],
      workflowHints: [
        "Use to preload custom glyphs; remind the user about firstChar offsets and max 32 characters per call.",
        "Suggest printing a short sample afterwards so they can verify the new character set.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = commodoreDllArgsSchema.parse(args ?? {});
          ctx.logger.info("Defining Commodore DLL characters", {
            firstChar: parsed.firstChar,
            count: parsed.chars.length,
            secondaryAddress: parsed.secondaryAddress,
          });

          const chars = parsed.chars.map((char) => ({
            a: char.a,
            columns: Array.from(char.columns, (value) => value & 0xff),
          }));

        const result = await ctx.client.defineCustomCharsOnCommodoreAndRun({
          firstChar: parsed.firstChar,
          chars,
          secondaryAddress: parsed.secondaryAddress,
        });

        if (!result.success) {
          throw new ToolExecutionError("C64 firmware reported failure while defining DLL characters", {
            details: normaliseFailure(result.details),
          });
        }

        return textResult("Custom printer characters defined successfully.", {
          success: true,
          firstChar: parsed.firstChar,
          count: parsed.chars.length,
          secondaryAddress: parsed.secondaryAddress ?? null,
          details: toRecord(result.details) ?? null,
        });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
  ],
});
