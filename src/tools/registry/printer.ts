import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
  OPERATION_DISCRIMINATOR,
  type JsonSchema,
} from "../types.js";
import { printerModule } from "../printer.js";
import {
  buildDescriptorIndex,
  ensureDescriptor,
  extendSchemaWithOp,
  createOperationHandlers,
  type GroupedOperationConfig,
  type GenericOperationMap,
} from "./utils.js";
import {
  arraySchema,
  booleanSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "../schema.js";
import { ToolValidationError } from "../errors.js";

const printerDescriptorIndex = buildDescriptorIndex(printerModule);

type PrintBitmapArgs = {
  printer: string;
  columns: readonly number[];
  repeats?: number;
  useSubRepeat?: number;
  secondaryAddress?: number;
  ensureMsb: boolean;
  mode?: string;
  density?: number;
  timesPerLine?: number;
};

const printBitmapArgsSchema = objectSchema<PrintBitmapArgs>({
  description: "Print a bitmap row using Commodore or Epson workflows.",
  properties: {
    printer: stringSchema({
      description: "Target printer family.",
      enum: ["commodore", "epson"],
      default: "commodore",
    }),
    columns: arraySchema(numberSchema({
      description: "Bitmap column byte (0-255).",
      integer: true,
      minimum: 0,
      maximum: 255,
    }), {
      description: "Sequence of bitmap columns.",
      minItems: 1,
    }),
    repeats: optionalSchema(numberSchema({
      description: "Number of times to repeat the row (1-255).",
      integer: true,
      minimum: 1,
      maximum: 255,
    })),
    useSubRepeat: optionalSchema(numberSchema({
      description: "Repeat the next byte this many times (Commodore BIM SUB).",
      integer: true,
      minimum: 1,
      maximum: 255,
    })),
    secondaryAddress: optionalSchema(numberSchema({
      description: "Secondary address for device 4 (0 or 7).",
      integer: true,
      minimum: 0,
      maximum: 7,
    })),
    ensureMsb: booleanSchema({
      description: "Ensure MSB set for Commodore printers.",
      default: true,
    }),
    mode: optionalSchema(stringSchema({
      description: "Epson ESC/P graphics mode (K/L/Y/Z/*).",
      minLength: 1,
      maxLength: 1,
    })),
    density: optionalSchema(numberSchema({
      description: "Density parameter when using Epson mode '*'.",
      integer: true,
      minimum: 0,
      maximum: 3,
    })),
    timesPerLine: optionalSchema(numberSchema({
      description: "Number of times to print the row per line (1-10).",
      integer: true,
      minimum: 1,
      maximum: 10,
    })),
  },
  required: ["printer", "columns"],
  additionalProperties: false,
});

const printerOperations: GroupedOperationConfig[] = [
  {
    op: "print_text",
    schema: extendSchemaWithOp(
      "print_text",
      ensureDescriptor(printerDescriptorIndex, "print_text").inputSchema,
      { description: "Generate BASIC that prints text to device 4." },
    ),
    handler: async (rawArgs, ctx) => invokePrintTool("print_text", rawArgs, ctx),
  },
  {
    op: "print_bitmap",
    schema: extendSchemaWithOp(
      "print_bitmap",
      printBitmapArgsSchema.jsonSchema as JsonSchema,
      { description: "Print a bitmap row via Commodore (BIM) or Epson ESC/P workflows." },
    ),
    handler: async (rawArgs, ctx) => {
      const { [OPERATION_DISCRIMINATOR]: _ignored, ...rest } = rawArgs;
      const parsed = printBitmapArgsSchema.parse(rest);
      const printer = parsed.printer as "commodore" | "epson";

      if (parsed.secondaryAddress !== undefined && parsed.secondaryAddress !== 0 && parsed.secondaryAddress !== 7) {
        throw new ToolValidationError("secondaryAddress must be 0 or 7", {
          path: "$.secondaryAddress",
          details: { received: parsed.secondaryAddress },
        });
      }

      if (printer === "commodore") {
        const payload: Record<string, unknown> = {
          columns: parsed.columns,
          repeats: parsed.repeats,
          useSubRepeat: parsed.useSubRepeat,
          secondaryAddress: parsed.secondaryAddress,
          ensureMsb: parsed.ensureMsb,
        };
        return printerModule.invoke("print_bitmap_commodore", payload, ctx);
      }

      const payload: Record<string, unknown> = {
        columns: parsed.columns,
        mode: parsed.mode,
        density: parsed.density,
        repeats: parsed.repeats,
        timesPerLine: parsed.timesPerLine,
      };
      return printerModule.invoke("print_bitmap_epson", payload, ctx);
    },
  },
  {
    op: "define_chars",
    schema: extendSchemaWithOp(
      "define_chars",
      ensureDescriptor(printerDescriptorIndex, "define_printer_chars").inputSchema,
      { description: "Define custom printer characters (Commodore DLL mode)." },
    ),
    handler: async (rawArgs, ctx) => invokePrintTool("define_printer_chars", rawArgs, ctx),
  },
];

const printerOperationHandlers = createOperationHandlers(printerOperations);

function invokePrintTool(toolName: string, rawArgs: Record<string, unknown>, ctx: Parameters<typeof printerModule.invoke>[2]) {
  const { [OPERATION_DISCRIMINATOR]: _ignored, ...rest } = rawArgs;
  return printerModule.invoke(toolName, rest, ctx);
}

export const printerModuleGroup = defineToolModule({
  domain: "printer",
  supportedPlatforms: ["c64u", "u2"],
  summary: "Grouped printer text, bitmap, and character definition helpers.",
  resources: ["c64://guide/bootstrap"],
  defaultTags: ["printer", "device"],
  workflowHints: [
    "Mention device/secondary addresses so the user knows which printer workflow ran.",
    "When defining characters, remind the user to send the BASIC program returned in the payload.",
  ],
  tools: [
    {
      name: "c64_printer",
      description: "Grouped entry point for Commodore and Epson printing helpers.",
      summary: "Print text or bitmaps and define custom characters for Commodore or Epson printers.",
      inputSchema: discriminatedUnionSchema({
        description: "Printer operations available via the c64_printer tool.",
        variants: printerOperations.map((operation) => operation.schema),
      }),
      tags: ["printer", "device", "grouped"],
      examples: [
        {
          name: "Print text",
          description: "Generate BASIC for device 4",
          arguments: { op: "print_text", text: "HELLO", ensureReturn: true },
        },
        {
          name: "Print bitmap",
          description: "Send Epson graphics row",
          arguments: { op: "print_bitmap", printer: "epson", columns: [0, 255, 0], mode: "*", density: 3 },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_printer",
        printerOperationHandlers,
      ),
    },
  ],
});
