import { defineToolModule } from "./types.js";
import {
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "./schema.js";
import { textResult } from "./responses.js";
import {
  ToolError,
  ToolExecutionError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";

function createNoArgsSchema(description: string) {
  return objectSchema<Record<string, never>>({
    description,
    properties: {},
    additionalProperties: false,
  });
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

const drivesListArgsSchema = createNoArgsSchema(
  "No arguments are required to list the Ultimate drive slots and their current images.",
);

const driveIdentifierSchema = stringSchema({
  description: "Drive identifier such as drive8, drive9, or unit name defined in the Ultimate UI.",
  minLength: 1,
});

const diskImagePathSchema = stringSchema({
  description: "Absolute or Ultimate filesystem path to the disk image to mount or manage.",
  minLength: 1,
});

const driveMountArgsSchema = objectSchema({
  description: "Parameters for mounting a disk image onto a specific Ultimate drive slot.",
  properties: {
    drive: driveIdentifierSchema,
    image: diskImagePathSchema,
    type: optionalSchema(stringSchema({
      description: "Override the disk image type when auto-detection is incorrect.",
      enum: ["d64", "g64", "d71", "g71", "d81"],
    })),
    mode: optionalSchema(stringSchema({
      description: "Attachment mode controlling how the firmware treats the mounted image.",
      enum: ["readwrite", "readonly", "unlinked"],
    })),
  },
  required: ["drive", "image"],
  additionalProperties: false,
});

const driveOnlyArgsSchema = objectSchema({
  description: "Parameters requiring only the target drive identifier.",
  properties: {
    drive: driveIdentifierSchema,
  },
  required: ["drive"],
  additionalProperties: false,
});

const driveModeArgsSchema = objectSchema({
  description: "Parameters for setting the Ultimate drive emulation mode.",
  properties: {
    drive: driveIdentifierSchema,
    mode: stringSchema({
      description: "Drive hardware profile to emulate.",
      enum: ["1541", "1571", "1581"],
    }),
  },
  required: ["drive", "mode"],
  additionalProperties: false,
});

const driveLoadRomArgsSchema = objectSchema({
  description: "Parameters for loading a custom ROM into an Ultimate drive slot.",
  properties: {
    drive: driveIdentifierSchema,
    path: diskImagePathSchema,
  },
  required: ["drive", "path"],
  additionalProperties: false,
});

const fileInfoArgsSchema = objectSchema({
  description: "Parameters for inspecting a file on the Ultimate filesystem.",
  properties: {
    path: diskImagePathSchema,
  },
  required: ["path"],
  additionalProperties: false,
});

const diskNameSchema = optionalSchema(stringSchema({
  description: "Optional disk label (max 16 characters, converted to PETSCII by the firmware).",
  minLength: 1,
  maxLength: 16,
}));

const createD64ArgsSchema = objectSchema({
  description: "Parameters for creating a blank D64 disk image on the Ultimate filesystem.",
  properties: {
    path: diskImagePathSchema,
    tracks: optionalSchema(numberSchema({
      description: "Track count (35 for standard, 40 for extended).",
      integer: true,
      minimum: 35,
      maximum: 40,
    })),
    diskname: diskNameSchema,
  },
  required: ["path"],
  additionalProperties: false,
});

const createD71ArgsSchema = objectSchema({
  description: "Parameters for creating a blank D71 disk image on the Ultimate filesystem.",
  properties: {
    path: diskImagePathSchema,
    diskname: diskNameSchema,
  },
  required: ["path"],
  additionalProperties: false,
});

const createD81ArgsSchema = objectSchema({
  description: "Parameters for creating a blank D81 disk image on the Ultimate filesystem.",
  properties: {
    path: diskImagePathSchema,
    diskname: diskNameSchema,
  },
  required: ["path"],
  additionalProperties: false,
});

const createDnpArgsSchema = objectSchema({
  description: "Parameters for creating a blank DNP disk image on the Ultimate filesystem.",
  properties: {
    path: diskImagePathSchema,
    tracks: numberSchema({
      description: "Number of tracks to allocate in the CMD-native DNP image.",
      integer: true,
      minimum: 1,
      maximum: 255,
    }),
    diskname: diskNameSchema,
  },
  required: ["path", "tracks"],
  additionalProperties: false,
});

export const storageModule = defineToolModule({
  domain: "storage",
  summary: "Drive management, disk image creation, and file inspection utilities.",
  supportedPlatforms: ["c64u", "u2", "vice"] as const,
  resources: ["c64://guide/bootstrap"],
  prompts: ["memory-debug"],
  defaultTags: ["drive", "storage"],
  workflowHints: [
    "Reach for storage tools when the user mentions drives, disk images, or Ultimate slots.",
    "Spell out which slot or path you touched so the user can replicate actions on hardware.",
  ],
  tools: [
    {
      name: "drives_list",
      description: "List Ultimate drive slots and their currently mounted images. Read c64://guide/bootstrap for drive safety.",
      summary: "Fetches firmware drive status including mounted images, power state, and modes.",
      inputSchema: drivesListArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["drive", "status"],
      prerequisites: [],
      examples: [
        {
          name: "Enumerate drives",
          description: "List drives and images",
          arguments: {},
        },
      ],
      workflowHints: [
        "Call first when you need to orient on current drive state; summarise mounted images and power flags for the user.",
      ],
      async execute(args, ctx) {
        try {
          drivesListArgsSchema.parse(args ?? {});
          ctx.logger.info("Listing Ultimate drives");

          const details = await ctx.client.drivesList();
          return textResult("Retrieved Ultimate drive status.", {
            success: true,
            drives: details,
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
      name: "drive_mount",
      description: "Mount a disk image onto a specific Ultimate drive slot.",
      summary: "Validates parameters and instructs the firmware to mount an image with optional type/mode overrides.",
      inputSchema: driveMountArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["drive", "mount"],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Mount D64",
          description: "Mount demo.d64 on drive8",
          arguments: { drive: "drive8", image: "/tmp/demo.d64", type: "d64", mode: "readwrite" },
        },
      ],
      workflowHints: [
        "Use when the user provides an image path; confirm drive slot, type, and mode in the reply.",
        "Suggest running drive_on if the slot was powered down before mounting.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = driveMountArgsSchema.parse(args ?? {});
          ctx.logger.info("Mounting disk image", {
            drive: parsed.drive,
            image: parsed.image,
            type: parsed.type ?? null,
            mode: parsed.mode ?? null,
          });

          const result = await ctx.client.driveMount(parsed.drive, parsed.image, {
            type: parsed.type as any,
            mode: parsed.mode as any,
          });
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while mounting disk image", {
              details: normaliseFailure(result.details),
            });
          }

          const details = toRecord(result.details) ?? {};
          const finalMode = typeof details.mode === "string" ? details.mode : parsed.mode ?? null;
          const finalType = typeof details.type === "string" ? details.type : parsed.type ?? null;

          return textResult(`Mounted ${parsed.image} on ${parsed.drive}.`, {
            success: true,
            drive: parsed.drive,
            image: parsed.image,
            type: finalType,
            mode: finalMode,
            details,
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
      name: "drive_remove",
      description: "Remove the currently mounted disk image from an Ultimate drive slot.",
      summary: "Ejects the image and leaves the drive empty without powering it off.",
      inputSchema: driveOnlyArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["drive", "unmount"],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Eject drive8",
          description: "Remove current image",
          arguments: { drive: "drive8" },
        },
      ],
      workflowHints: [
        "Call after confirming the user wants to eject an image; tell them the slot is now empty.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = driveOnlyArgsSchema.parse(args ?? {});
          ctx.logger.info("Removing disk image", { drive: parsed.drive });

          const result = await ctx.client.driveRemove(parsed.drive);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while removing disk image", {
              details: normaliseFailure(result.details),
            });
          }

          return textResult(`Removed mounted image from ${parsed.drive}.`, {
            success: true,
            drive: parsed.drive,
            details: toRecord(result.details) ?? {},
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
      name: "drive_reset",
      description: "Reset the selected Ultimate drive slot.",
      summary: "Issues a IEC reset for the chosen drive without cycling the entire machine.",
      inputSchema: driveOnlyArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["drive", "reset"],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Reset drive8",
          description: "IEC reset",
          arguments: { drive: "drive8" },
        },
      ],
      workflowHints: [
        "Use when drive firmware needs a kick after errors; mention that mounted images remain but state resets.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = driveOnlyArgsSchema.parse(args ?? {});
          ctx.logger.info("Resetting drive", { drive: parsed.drive });

          const result = await ctx.client.driveReset(parsed.drive);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while resetting drive", {
              details: normaliseFailure(result.details),
            });
          }

          return textResult(`Drive ${parsed.drive} reset issued.`, {
            success: true,
            drive: parsed.drive,
            details: toRecord(result.details) ?? {},
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
      name: "drive_on",
      description: "Power on a specific Ultimate drive slot.",
      summary: "Ensures the selected drive is reported as powered and ready on the IEC bus.",
      inputSchema: driveOnlyArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["drive", "power"],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Power on",
          description: "Turn on drive8",
          arguments: { drive: "drive8" },
        },
      ],
      workflowHints: [
        "Power a slot on before mounting or accessing disks; note the previous state in your response.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = driveOnlyArgsSchema.parse(args ?? {});
          ctx.logger.info("Powering on drive", { drive: parsed.drive });

          const result = await ctx.client.driveOn(parsed.drive);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while powering on drive", {
              details: normaliseFailure(result.details),
            });
          }

          return textResult(`Drive ${parsed.drive} powered on.`, {
            success: true,
            drive: parsed.drive,
            power: "on",
            details: toRecord(result.details) ?? {},
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
      name: "drive_off",
      description: "Power off a specific Ultimate drive slot.",
      summary: "Disables the drive without altering mounted media so it can be re-enabled later.",
      inputSchema: driveOnlyArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["drive", "power"],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Power off",
          description: "Turn off drive8",
          arguments: { drive: "drive8" },
        },
      ],
      workflowHints: [
        "Warn the user that powering off ejects the drive from C64 view; suggest unmounting images if necessary first.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = driveOnlyArgsSchema.parse(args ?? {});
          ctx.logger.info("Powering off drive", { drive: parsed.drive });

          const result = await ctx.client.driveOff(parsed.drive);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while powering off drive", {
              details: normaliseFailure(result.details),
            });
          }

          return textResult(`Drive ${parsed.drive} powered off.`, {
            success: true,
            drive: parsed.drive,
            power: "off",
            details: toRecord(result.details) ?? {},
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
      name: "drive_load_rom",
      description: "Temporarily load a custom ROM into an Ultimate drive slot.",
      summary: "Points the drive at an alternative ROM file without flashing permanent storage.",
      inputSchema: driveLoadRomArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["drive", "rom"],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Load ROM",
          description: "Load custom.rom to drive8",
          arguments: { drive: "drive8", path: "/roms/custom.rom" },
        },
      ],
      workflowHints: [
        "Use when the user requests custom DOS ROMs; remind them a reset may be required afterwards.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = driveLoadRomArgsSchema.parse(args ?? {});
          ctx.logger.info("Loading drive ROM", { drive: parsed.drive, path: parsed.path });

          const result = await ctx.client.driveLoadRom(parsed.drive, parsed.path);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while loading drive ROM", {
              details: normaliseFailure(result.details),
            });
          }

          return textResult(`Drive ${parsed.drive} ROM loaded from ${parsed.path}.`, {
            success: true,
            drive: parsed.drive,
            path: parsed.path,
            details: toRecord(result.details) ?? {},
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
      name: "drive_mode",
      description: "Set the emulation mode for an Ultimate drive slot (1541/1571/1581).",
      summary: "Switches the drive hardware profile to match the mounted media and desired behaviour.",
      inputSchema: driveModeArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["drive", "mode"],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Set mode",
          description: "Set drive8 to 1571",
          arguments: { drive: "drive8", mode: "1571" },
        },
      ],
      workflowHints: [
        "Invoke when the user needs to switch between 1541/1571/1581 behaviours; restate the resulting mode in your reply.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = driveModeArgsSchema.parse(args ?? {});
          ctx.logger.info("Setting drive mode", { drive: parsed.drive, mode: parsed.mode });

          const result = await ctx.client.driveSetMode(parsed.drive, parsed.mode as "1541" | "1571" | "1581");
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while setting drive mode", {
              details: normaliseFailure(result.details),
            });
          }

          return textResult(`Drive ${parsed.drive} set to ${parsed.mode} mode.`, {
            success: true,
            drive: parsed.drive,
            mode: parsed.mode,
            details: toRecord(result.details) ?? {},
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
      name: "file_info",
      description: "Inspect metadata for a file on the Ultimate filesystem.",
      summary: "Queries the REST API for file size, type, and other details useful when managing disk images.",
      inputSchema: fileInfoArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["storage", "info"],
      prerequisites: [],
      examples: [
        {
          name: "Inspect file",
          description: "Read info for /tmp/demo.d64",
          arguments: { path: "/tmp/demo.d64" },
        },
      ],
      workflowHints: [
        "Use to inspect Ultimate filesystem paths before mounting; report size and type so the user can validate the asset.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = fileInfoArgsSchema.parse(args ?? {});
          ctx.logger.info("Fetching file info", { path: parsed.path });

          const details = await ctx.client.filesInfo(parsed.path);
          return textResult(`Retrieved file info for ${parsed.path}.`, {
            success: true,
            path: parsed.path,
            details,
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
      name: "create_d64",
      description: "Create a blank D64 disk image on the Ultimate filesystem.",
      summary: "Allocates a 35 or 40 track D64 image with an optional disk name.",
      inputSchema: createD64ArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["disk", "create"],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Create D64",
          description: "Create /tmp/new.d64",
          arguments: { path: "/tmp/new.d64", tracks: 35, diskname: "DISK1" },
        },
      ],
      workflowHints: [
        "Use when the user needs a new D64 image; confirm track count and disk name in your summary.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = createD64ArgsSchema.parse(args ?? {});
          ctx.logger.info("Creating D64 image", {
            path: parsed.path,
            tracks: parsed.tracks ?? null,
            diskname: parsed.diskname ?? null,
          });

          const result = await ctx.client.filesCreateD64(parsed.path, {
            tracks: parsed.tracks as 35 | 40 | undefined,
            diskname: parsed.diskname,
          });
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while creating D64 image", {
              details: normaliseFailure(result.details),
            });
          }

          return textResult(`Created D64 image at ${parsed.path}.`, {
            success: true,
            path: parsed.path,
            tracks: parsed.tracks ?? null,
            diskname: parsed.diskname ?? null,
            details: toRecord(result.details) ?? {},
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
      name: "create_d71",
      description: "Create a blank D71 disk image on the Ultimate filesystem.",
      summary: "Allocates a 1571-compatible disk image with optional labelling.",
      inputSchema: createD71ArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["disk", "create"],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Create D71",
          description: "Create /tmp/new.d71",
          arguments: { path: "/tmp/new.d71", diskname: "DISK2" },
        },
      ],
      workflowHints: [
        "Reach for this when the user wants a 1571 disk; mention track count and that the image is double-sided.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = createD71ArgsSchema.parse(args ?? {});
          ctx.logger.info("Creating D71 image", {
            path: parsed.path,
            diskname: parsed.diskname ?? null,
          });

          const result = await ctx.client.filesCreateD71(parsed.path, {
            diskname: parsed.diskname,
          });
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while creating D71 image", {
              details: normaliseFailure(result.details),
            });
          }

          return textResult(`Created D71 image at ${parsed.path}.`, {
            success: true,
            path: parsed.path,
            diskname: parsed.diskname ?? null,
            details: toRecord(result.details) ?? {},
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
      name: "create_d81",
      description: "Create a blank D81 disk image on the Ultimate filesystem.",
      summary: "Allocates a 1581-compatible disk image with optional labelling.",
      inputSchema: createD81ArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["disk", "create"],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Create D81",
          description: "Create /tmp/new.d81",
          arguments: { path: "/tmp/new.d81", diskname: "DISK3" },
        },
      ],
      workflowHints: [
        "Use when the user needs a 1581 disk; remind them about 40 track layout and optional disk name.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = createD81ArgsSchema.parse(args ?? {});
          ctx.logger.info("Creating D81 image", {
            path: parsed.path,
            diskname: parsed.diskname ?? null,
          });

          const result = await ctx.client.filesCreateD81(parsed.path, {
            diskname: parsed.diskname,
          });
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while creating D81 image", {
              details: normaliseFailure(result.details),
            });
          }

          return textResult(`Created D81 image at ${parsed.path}.`, {
            success: true,
            path: parsed.path,
            diskname: parsed.diskname ?? null,
            details: toRecord(result.details) ?? {},
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
      name: "create_dnp",
      description: "Create a blank DNP disk image on the Ultimate filesystem.",
      summary: "Allocates a CMD-native DNP image with custom track count and optional label.",
      inputSchema: createDnpArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["disk", "create"],
      prerequisites: [
        "drives_list"
      ],
      examples: [
        {
          name: "Create DNP",
          description: "Create /tmp/new.dnp with 80 tracks",
          arguments: { path: "/tmp/new.dnp", tracks: 80, diskname: "DISK4" },
        },
      ],
      workflowHints: [
        "Use for CMD-native DNP images; clarify track count and remind about CMD hardware compatibility.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = createDnpArgsSchema.parse(args ?? {});
          ctx.logger.info("Creating DNP image", {
            path: parsed.path,
            tracks: parsed.tracks,
            diskname: parsed.diskname ?? null,
          });

          const result = await ctx.client.filesCreateDnp(parsed.path, parsed.tracks, {
            diskname: parsed.diskname,
          });
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while creating DNP image", {
              details: normaliseFailure(result.details),
            });
          }

          return textResult(`Created DNP image at ${parsed.path}.`, {
            success: true,
            path: parsed.path,
            tracks: parsed.tracks,
            diskname: parsed.diskname ?? null,
            details: toRecord(result.details) ?? {},
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
