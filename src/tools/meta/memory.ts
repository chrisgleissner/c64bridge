// Memory-related meta tools
import { cancelledResult, type ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, numberSchema, optionalSchema, booleanSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolExecutionError, ToolValidationError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { resolveHostPath } from "../../hostPaths.js";
import { createHash } from "node:crypto";
import { normalizeErrorDetails } from "./util.js";
import { parseNumericLiteral, assertNotBareHex, assertAddressRange } from "../../numericArg.js";
import { stripHexByteSeparators } from "../hex.js";
import { acquireOwnedPause, resumeWarning } from "../pauseGuard.js";

function supportsMachinePause(ctx: { platform?: { id?: string }; client?: { type?: string } }): boolean {
  const platformId = ctx.platform?.id ?? ctx.client?.type;
  return platformId !== "vice";
}

function hexClean(input: string): string {
  return stripHexByteSeparators(input).toLowerCase();
}

function hexToBytes(input: string): Uint8Array {
  const cleaned = hexClean(input);
  if (cleaned.length === 0) return new Uint8Array();
  if (cleaned.length % 2 !== 0) {
    throw new ToolValidationError("Hex string must have an even number of characters", { path: "$.bytes" });
  }
  return Uint8Array.from(Buffer.from(cleaned, "hex"));
}

function parseAddressNumeric(value: string): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolValidationError("Address must be a non-empty string", { path: "$.address" });
  }
  const parsed = parseNumericLiteral(value, "$.address");
  if (parsed === undefined) {
    assertNotBareHex(value, "$.address");
    throw new ToolValidationError("Invalid address value", { path: "$.address", details: { value } });
  }
  assertAddressRange(parsed, undefined, "$.address");
  return parsed;
}

function formatAddressHex(address: number): string {
  return address.toString(16).toUpperCase().padStart(4, "0");
}

const memoryDumpToFileArgsSchema = objectSchema({
  description: "Dump a memory range to a file in hex or binary, with optional pause/resume.",
  properties: {
    address: stringSchema({ description: "Start address ($HHHH or decimal)", minLength: 1 }),
    length: numberSchema({ description: "Number of bytes to dump", integer: true, minimum: 1, maximum: 65536 }),
    outputPath: stringSchema({ description: "Destination file path", minLength: 1 }),
    format: optionalSchema(stringSchema({ description: "Output format: hex|binary", enum: ["hex", "binary"], default: "hex" as any }), "hex" as any),
    chunkSize: optionalSchema(numberSchema({ description: "Bytes per read request (default: the whole range in one read)", integer: true, minimum: 1, maximum: 65536 })),
    pauseDuringRead: optionalSchema(booleanSchema({ description: "Pause/resume around dump", default: true }), true),
    retries: optionalSchema(numberSchema({ description: "Retries per chunk on failure", integer: true, minimum: 0, maximum: 10, default: 1 }), 1),
  },
  required: ["address", "length", "outputPath"],
  additionalProperties: false,
});

export const tools: ToolDefinition[] = [
  {
    name: "memory_dump_to_file",
    description: "Chunked memory dump with retries; optional pause/resume; writes hex or binary and a manifest.",
    summary: "Safe large-range memory dump to disk with checksum.",
    inputSchema: memoryDumpToFileArgsSchema.jsonSchema,
    tags: ["memory", "dump", "file"],
    async execute(args, ctx) {
      try {
        const parsed = memoryDumpToFileArgsSchema.parse(args ?? {});
        if (ctx.signal?.aborted) return cancelledResult("memory_dump was cancelled before reading; no file was written");
        const startAddr = parseAddressNumeric(parsed.address);
        const length = parsed.length as number;
        if (startAddr + length > 0x10000) {
          throw new ToolValidationError(
            `Dump of ${length} bytes from $${formatAddressHex(startAddr)} would pass $FFFF (at most ${0x10000 - startAddr} bytes can be read from there)`,
            { path: "$.length" },
          );
        }
        const chunk = Math.min(Math.max(1, parsed.chunkSize ?? length), 65536);
        const pause = parsed.pauseDuringRead !== false;
        const outputPath = resolveHostPath(String(parsed.outputPath), { purpose: "write" });
        const outDir = dirname(outputPath);
        await fs.mkdir(outDir, { recursive: true });

        const canPause = pause && supportsMachinePause(ctx as any);
        const owned = await acquireOwnedPause(ctx.client, canPause);
        const pinned = owned.facade;
        if (canPause && !owned.result.success) {
          throw new ToolExecutionError("Pause failed before dump", { details: normalizeErrorDetails(owned.result.details) });
        }

        const buf = Buffer.alloc(length);
        let offset = 0;
        let released = false;
        try {
          while (offset < length) {
            if (ctx.signal?.aborted) {
              return cancelledResult(`memory_dump was cancelled by the client after ${offset} of ${length} bytes; no file was written`);
            }
            const remaining = length - offset;
            const take = Math.min(chunk, remaining);
            const addr = startAddr + offset;
            if (addr + take > 0x10000) {
              throw new ToolExecutionError("Dump would wrap past end of address space", { details: { address: `$${formatAddressHex(addr)}`, remaining: take } });
            }

            let attempts = 0;
            let success = false;
            let lastErr: unknown = null;
            while (!success && attempts <= (parsed.retries ?? 1)) {
              attempts += 1;
              try {
                const r = await (ctx.client as any).readMemory(`$${formatAddressHex(addr)}`, String(take), pinned);
                if (ctx.signal?.aborted) return cancelledResult(`memory_dump was cancelled after ${offset} of ${length} bytes; no file was written`);
                if (!r.success || typeof r.data !== "string") {
                  throw new ToolExecutionError("Firmware returned failure for chunk", { details: normalizeErrorDetails(r.details) });
                }
                const bytes = hexToBytes(r.data);
                if (bytes.length !== take) {
                  throw new ToolExecutionError(`Firmware returned ${bytes.length} bytes for a ${take}-byte chunk at $${formatAddressHex(addr)}`);
                }
                Buffer.from(bytes).copy(buf, offset, 0, take);
                success = true;
              } catch (e) {
                if (ctx.signal?.aborted) return cancelledResult(`memory_dump was cancelled after ${offset} of ${length} bytes; no file was written`);
                lastErr = e;
                if (attempts > (parsed.retries ?? 1)) {
                  throw e;
                }
              }
            }
            if (!success) {
              throw lastErr ?? new Error("Unknown failure while dumping memory");
            }
            offset += take;
          }

          if (String(parsed.format).toLowerCase() === "binary") {
            await fs.writeFile(outputPath, buf);
          } else {
            const hex = Buffer.from(buf).toString("hex").toUpperCase();
            await fs.writeFile(outputPath, hex, "utf8");
          }

          const checksum = createHash("sha256").update(buf).digest("hex").toUpperCase();
          const manifest = {
            address: `$${formatAddressHex(startAddr)}`,
            length,
            chunkSize: chunk,
            format: (parsed.format ?? "hex").toString().toLowerCase(),
            checksum,
            outputPath,
            paused: canPause,
            createdAt: new Date().toISOString(),
          };
          await fs.writeFile(resolveHostPath(`${outputPath}.json`, { purpose: "write" }), JSON.stringify(manifest, null, 2), "utf8");
          let warnings: string[] | undefined;
          if (canPause) {
            released = true;
            const result = await owned.release();
            if (!result.success) {
              warnings = [resumeWarning(result.details)];
              ctx.logger.warn("C64 resume reported failure after dump", { details: result.details });
            }
          }
          return jsonResult({ manifest, ...(warnings ? { warnings } : {}) }, { success: true });
        } finally {
          if (canPause && !released) {
            const result = await owned.release();
            if (!result.success) ctx.logger.warn("C64 resume reported failure after dump", { details: result.details });
          }
        }
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
];
