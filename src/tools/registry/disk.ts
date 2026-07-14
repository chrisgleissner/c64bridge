import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
  OPERATION_DISCRIMINATOR,
  type JsonSchema,
} from "../types.js";
import { storageModule } from "../storage.js";
import { metaModule } from "../meta/index.js";
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
  arraySchema,
  booleanSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "../schema.js";
import { ToolValidationError } from "../errors.js";

const storageDescriptorIndex = buildDescriptorIndex(storageModule);
const metaDescriptorIndex = buildDescriptorIndex(metaModule);

type DiskAttachmentMode = "readwrite" | "readonly" | "unlinked";
type DiskImageFormat = "d64" | "d71" | "d81" | "dnp";
type DiskTypeOverride = "d64" | "g64" | "d71" | "g71" | "d81";
type DriveMode = "1541" | "1571" | "1581";

type DiskMountArgs = {
  drive: string;
  image: string;
  type?: string;
  attachmentMode?: string;
  driveMode?: string;
  verify: boolean;
  powerOnIfNeeded: boolean;
  resetAfterMount: boolean;
  maxRetries: number;
  retryDelayMs: number;
};

type CreateImageArgs = {
  format: string;
  path: string;
  diskname?: string;
  tracks?: number;
};

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

const diskMountArgsSchema = objectSchema<DiskMountArgs>({
  description: "Mount a disk image with optional verification and drive preparation.",
  properties: {
    drive: stringSchema({
      description: "Drive identifier (for example drive8).",
      minLength: 1,
    }),
    image: stringSchema({
      description: "Absolute or Ultimate filesystem path to the disk image.",
      minLength: 1,
    }),
    type: optionalSchema(stringSchema({
      description: "Override detected image type when firmware guesses incorrectly.",
      enum: ["d64", "g64", "d71", "g71", "d81"],
    })),
    attachmentMode: optionalSchema(stringSchema({
      description: "Attachment mode controlling how the firmware treats the mounted image.",
      enum: ["readwrite", "readonly", "unlinked"],
    })),
    driveMode: optionalSchema(stringSchema({
      description: "Drive emulation mode to switch to during verification.",
      enum: ["1541", "1571", "1581"],
    })),
    verify: booleanSchema({
      description: "When true, power on/reset/verify using the reliability workflow.",
      default: false,
    }),
    powerOnIfNeeded: booleanSchema({
      description: "Power on the drive automatically before mounting when verify=true.",
      default: true,
    }),
    resetAfterMount: booleanSchema({
      description: "Issue a drive reset after mounting when verify=true.",
      default: true,
    }),
    maxRetries: numberSchema({
      description: "Maximum number of mount retries when verify=true.",
      integer: true,
      minimum: 0,
      maximum: 5,
      default: 2,
    }),
    retryDelayMs: numberSchema({
      description: "Delay between mount retry attempts when verify=true.",
      integer: true,
      minimum: 0,
      maximum: 5000,
      default: 500,
    }),
  },
  required: ["drive", "image"],
  additionalProperties: false,
});

const createImageArgsSchema = objectSchema<CreateImageArgs>({
  description: "Create a blank disk image (D64/D71/D81/DNP).",
  properties: {
    format: stringSchema({
      description: "Disk image format to create.",
      enum: ["d64", "d71", "d81", "dnp"],
    }),
    path: stringSchema({
      description: "Destination path on the Ultimate filesystem.",
      minLength: 1,
    }),
    diskname: optionalSchema(stringSchema({
      description: "Optional disk label (1-16 characters, converted to PETSCII).",
      minLength: 1,
      maxLength: 16,
    })),
    tracks: optionalSchema(numberSchema({
      description: "Track count (D64 supports 35 or 40; DNP requires explicit tracks).",
      integer: true,
      minimum: 1,
      maximum: 255,
    })),
  },
  required: ["format", "path"],
  additionalProperties: false,
});

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

const diskOperations: GroupedOperationConfig[] = [
  {
    op: "list_drives",
    schema: extendSchemaWithOp(
      "list_drives",
      ensureDescriptor(storageDescriptorIndex, "drives_list").inputSchema,
      { description: "List Ultimate drive slots and their mounted images." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(storageModule, "drives_list", rawArgs, ctx),
  },
  {
    op: "mount",
    schema: extendSchemaWithOp(
      "mount",
      diskMountArgsSchema.jsonSchema as JsonSchema,
      { description: "Mount a disk image with optional verification and retries." },
    ),
    handler: async (rawArgs, ctx) => {
      const { [OPERATION_DISCRIMINATOR]: _ignored, ...rest } = rawArgs;
      const { verify, type, attachmentMode, driveMode, powerOnIfNeeded, resetAfterMount, maxRetries, retryDelayMs, ...parsed } = diskMountArgsSchema.parse(rest);
      const typedType = type as DiskTypeOverride | undefined;
      const typedAttachment = attachmentMode as DiskAttachmentMode | undefined;
      const typedDriveMode = driveMode as DriveMode | undefined;

      if (verify) {
        return metaModule.invoke("drive_mount_and_verify", {
          drive: parsed.drive,
          imagePath: parsed.image,
          mode: typedDriveMode,
          powerOnIfNeeded,
          resetAfterMount,
          maxRetries,
          retryDelayMs,
          verifyMount: true,
        }, ctx);
      }

      const payload: Record<string, unknown> = {
        drive: parsed.drive,
        image: parsed.image,
      };
      if (typedType) {
        payload.type = typedType;
      }
      if (typedAttachment) {
        payload.mode = typedAttachment;
      }

      return storageModule.invoke("drive_mount", payload, ctx);
    },
  },
  {
    op: "unmount",
    schema: extendSchemaWithOp(
      "unmount",
      ensureDescriptor(storageDescriptorIndex, "drive_remove").inputSchema,
      { description: "Remove the mounted image from an Ultimate drive slot." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(storageModule, "drive_remove", rawArgs, ctx),
  },
  {
    op: "file_info",
    schema: extendSchemaWithOp(
      "file_info",
      ensureDescriptor(storageDescriptorIndex, "file_info").inputSchema,
      { description: "Inspect metadata for a file on the Ultimate filesystem." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(storageModule, "file_info", rawArgs, ctx),
  },
  {
    op: "create_image",
    schema: extendSchemaWithOp(
      "create_image",
      createImageArgsSchema.jsonSchema as JsonSchema,
      { description: "Create a blank disk image of the specified format." },
    ),
    handler: async (rawArgs, ctx) => {
      const { [OPERATION_DISCRIMINATOR]: _ignored, ...rest } = rawArgs;
      const parsed = createImageArgsSchema.parse(rest);
      const format = parsed.format as DiskImageFormat;
      const { path, diskname, tracks } = parsed;

      switch (format) {
        case "d64":
          if (tracks !== undefined && tracks !== 35 && tracks !== 40) {
            throw new ToolValidationError("D64 images support 35 or 40 tracks", {
              path: "$.tracks",
              details: { allowed: [35, 40], received: tracks },
            });
          }
          return storageModule.invoke("create_d64", { path, tracks, diskname }, ctx);
        case "d71":
          if (tracks !== undefined) {
            throw new ToolValidationError("tracks is not used for D71 images", {
              path: "$.tracks",
            });
          }
          return storageModule.invoke("create_d71", { path, diskname }, ctx);
        case "d81":
          if (tracks !== undefined) {
            throw new ToolValidationError("tracks is not used for D81 images", {
              path: "$.tracks",
            });
          }
          return storageModule.invoke("create_d81", { path, diskname }, ctx);
        case "dnp":
          if (tracks === undefined) {
            throw new ToolValidationError("tracks is required for DNP images", {
              path: "$.tracks",
            });
          }
          return storageModule.invoke("create_dnp", { path, tracks, diskname }, ctx);
        default:
          throw new ToolValidationError("Unsupported disk format", {
            path: "$.format",
            details: { format },
          });
      }
    },
  },
  {
    op: "find_and_run",
    schema: extendSchemaWithOp(
      "find_and_run",
      ensureDescriptor(metaDescriptorIndex, "find_and_run_program_by_name").inputSchema,
      { description: "Search for a PRG/CRT by name substring and run the first match." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "find_and_run_program_by_name", rawArgs, ctx),
  },
];

const diskOperationHandlers = createOperationHandlers(diskOperations);

export const diskModuleGroup = defineToolModule({
  domain: "storage",
  summary: "Grouped disk image management, mounting, and discovery tools.",
  supportedPlatforms: ["c64u", "u2", "vice"],
  resources: ["c64://guide/bootstrap"],
  prompts: ["drive-management"],
  defaultTags: ["storage", "drive"],
  workflowHints: [
    "Summarise drive state before and after mounts so the user can confirm hardware changes.",
    "Call out when verification retries succeed or fail so follow-up actions are clear.",
  ],
  tools: [
    {
      name: "c64_disk",
      description: "Grouped entry point for disk mounts, listings, image creation, and program discovery.",
      summary: "Mount or unmount images, create new disks, list drives, and find programs from one tool.",
      inputSchema: discriminatedUnionSchema({
        description: "Disk operations available via the c64_disk tool.",
        variants: diskOperations.map((operation) => operation.schema),
      }),
      tags: ["storage", "drive", "grouped"],
      operationPlatforms: { file_info: ["c64u", "u2"], create_image: ["c64u", "u2"], find_and_run: ["c64u", "u2"] },
      operationToolNames: {
        file_info: "file_info",
        create_image: "create_image",
        find_and_run: "find_and_run_program_by_name",
      },
      examples: [
        {
          name: "Mount image with verification",
          description: "Power on drive8, mount image, and verify",
          arguments: { op: "mount", drive: "drive8", image: "/tmp/demo.d64", verify: true },
        },
        {
          name: "Create D81",
          description: "Create blank D81 image",
          arguments: { op: "create_image", format: "d81", path: "/tmp/new.d81" },
        },
        {
          name: "List drives",
          description: "Fetch drive status",
          arguments: { op: "list_drives" },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_disk",
        diskOperationHandlers,
      ),
    },
  ],
});
