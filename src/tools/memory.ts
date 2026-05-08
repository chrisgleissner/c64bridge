import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import {
  defineToolModule,
  OPERATION_DISCRIMINATOR,
  type OperationHandlerMap,
  type OperationMap,
  type ToolExecutionContext,
  type ToolRunResult,
} from "./types.js";
import { booleanSchema, numberSchema, objectSchema, optionalSchema, stringSchema } from "./schema.js";
import { jsonResult, textResult } from "./responses.js";
import {
  ToolError,
  ToolExecutionError,
  ToolValidationError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";
import { disassemble, formatDisassembly } from "./translation/disassembler.js";
import { getViceSymbols } from "./translation/symbolRegistry.js";
import { resolveAddressSymbol } from "../knowledge.js";

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

interface HexParseResult {
  readonly bytes: Uint8Array;
  readonly canonical: string;
}

function cleanHex(input: string): string {
  const trimmed = input.trim();
  const withoutPrefix = trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
  return withoutPrefix.replace(/[\s_]/g, "").toUpperCase();
}

function parseHexInternal(value: string, path: string): HexParseResult {
  const cleaned = cleanHex(value);
  if (cleaned.length % 2 !== 0) {
    throw new ToolValidationError("Hex string must have an even number of characters", {
      path,
      details: { value },
    });
  }

  if (cleaned.length === 0) {
    return { bytes: new Uint8Array(), canonical: "$" };
  }

  if (!/^[0-9A-F]+$/.test(cleaned)) {
    throw new ToolValidationError("Hex string contains non-hexadecimal characters", {
      path,
      details: { value },
    });
  }

  const bytes = Uint8Array.from(Buffer.from(cleaned, "hex"));
  return { bytes, canonical: `$${cleaned}` };
}

function parseUserHex(value: string, path: string): HexParseResult {
  return parseHexInternal(value, path);
}

function parseFirmwareHex(value: unknown, stage: string): HexParseResult {
  if (typeof value !== "string") {
    throw new ToolExecutionError(`Firmware returned invalid ${stage} hex data`, {
      details: { value },
    });
  }

  try {
    return parseHexInternal(value, stage);
  } catch (error) {
    if (error instanceof ToolValidationError) {
      throw new ToolExecutionError(`Firmware returned malformed ${stage} hex data`, {
        details: { value },
      });
    }
    throw error;
  }
}

function formatByte(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

function resolveAddressLabel(details: Record<string, unknown>, fallback: string): string {
  if (typeof details.address === "number") {
    return `$${details.address.toString(16).toUpperCase().padStart(4, "0")}`;
  }

  if (typeof details.address === "string" && details.address.length > 0) {
    return details.address.startsWith("$")
      ? details.address
      : `$${details.address.toUpperCase()}`;
  }

  return fallback.startsWith("$") ? fallback : `$${fallback}`;
}

function resolveLength(details: Record<string, unknown>): number | undefined {
  return typeof details.length === "number" ? details.length : undefined;
}

function supportsMachinePause(ctx: { platform?: { id?: string } }): boolean {
  const platformId = ctx.platform?.id;
  return platformId !== "vice";
}

export const __memoryHelpersForTests = {
  toRecord,
  normaliseFailure,
  cleanHex,
  parseUserHex,
  parseFirmwareHex,
  formatByte,
  resolveAddressLabel,
  resolveLength,
  supportsMachinePause,
  stripOperationDiscriminator,
};

const readScreenArgsSchema = objectSchema<Record<string, never>>({
  description: "No arguments are required for reading the current screen contents.",
  properties: {},
  additionalProperties: false,
});

const readMemoryArgsSchema = objectSchema({
  description: "Parameters for reading a block of memory from the C64.",
  properties: {
    address: stringSchema({
      description: "Start address expressed as $HHHH, decimal, or a documented symbol name.",
      minLength: 1,
    }),
    length: numberSchema({
      description: "Number of bytes to read starting from the resolved address.",
      integer: true,
      minimum: 1,
      maximum: 4096,
      default: 256,
    }),
  },
  required: ["address"],
  additionalProperties: false,
});

const writeMemoryArgsSchema = objectSchema({
  description: "Parameters for writing hexadecimal bytes into C64 memory.",
  properties: {
    address: stringSchema({
      description: "Destination address expressed as $HHHH, decimal, or a documented symbol name.",
      minLength: 1,
    }),
    bytes: stringSchema({
      description: "Hex byte sequence like $AABBCC or AA BB CC to write starting at the resolved address.",
      minLength: 2,
      pattern: /^[\s_0-9A-Fa-f$]+$/,
    }),
    verify: booleanSchema({
      description: "When true, verify the write by reading before and after the change; Ultimate hardware also pauses during verification.",
      default: false,
    }),
    expected: optionalSchema(stringSchema({
      description: "Optional hex data expected before the write (verifies before writing).",
      minLength: 2,
      pattern: /^[\s_0-9A-Fa-f$]+$/,
    })),
    mask: optionalSchema(stringSchema({
      description: "Optional verification mask (hex); only bits set in the mask are compared.",
      minLength: 2,
      pattern: /^[\s_0-9A-Fa-f$]+$/,
    })),
    abortOnMismatch: booleanSchema({
      description: "Abort the write when the pre-write verification fails.",
      default: true,
    }),
  },
  required: ["address", "bytes"],
  additionalProperties: false,
});

type OperationlessArgs<T extends Record<string, unknown>> = Omit<T, typeof OPERATION_DISCRIMINATOR>;

function stripOperationDiscriminator<T extends Record<string, unknown>>(
  value: T,
): OperationlessArgs<T> {
  const { [OPERATION_DISCRIMINATOR]: _ignored, ...rest } = value;
  return rest as OperationlessArgs<T>;
}

async function executeReadScreen(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    readScreenArgsSchema.parse(rawArgs ?? {});
    ctx.logger.info("Reading C64 screen contents");

    const screen = await ctx.client.readScreen();

    return textResult(`Current screen contents:\n${screen}`, {
      success: true,
      screen,
      length: screen.length,
    });
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return unknownErrorResult(error);
  }
}

async function executeReadMemory(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = readMemoryArgsSchema.parse(rawArgs ?? {});
    ctx.logger.info("Reading C64 memory", { address: parsed.address, length: parsed.length });

    const result = await ctx.client.readMemory(parsed.address, String(parsed.length));
    if (!result.success) {
      throw new ToolExecutionError("C64 firmware reported failure while reading memory", {
        details: normaliseFailure(result.details),
      });
    }

    const detailRecord = toRecord(result.details) ?? {};
    const resolvedAddress = resolveAddressLabel(detailRecord, parsed.address);
    const resolvedLength = resolveLength(detailRecord) ?? parsed.length;
    const data = {
      success: true,
      address: resolvedAddress,
      length: resolvedLength,
      hexData: result.data ?? null,
      details: detailRecord,
    };

    const base = textResult(`Read ${resolvedLength} bytes starting at ${resolvedAddress}.`, data);
    return {
      ...base,
      structuredContent: {
        type: "json",
        data,
      },
    };
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return unknownErrorResult(error);
  }
}

async function executeWriteMemory(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = writeMemoryArgsSchema.parse(rawArgs ?? {});
    ctx.logger.info("Writing C64 memory", { address: parsed.address, bytesLength: parsed.bytes.length });

    const writeInfo = parseUserHex(parsed.bytes, "$.bytes");
    const expectedInfo = parsed.expected ? parseUserHex(parsed.expected, "$.expected") : undefined;
    const maskInfo = parsed.mask ? parseUserHex(parsed.mask, "$.mask") : undefined;
    const shouldVerify = parsed.verify || Boolean(expectedInfo) || Boolean(maskInfo);

    if (!shouldVerify) {
      const result = await ctx.client.writeMemory(parsed.address, writeInfo.canonical);
      if (!result.success) {
        throw new ToolExecutionError("C64 firmware reported failure while writing memory", {
          details: normaliseFailure(result.details),
        });
      }

      const detailRecord = toRecord(result.details) ?? {};
      const resolvedAddress = resolveAddressLabel(detailRecord, parsed.address);
      const resolvedLength = resolveLength(detailRecord);

      return textResult(`Wrote ${resolvedLength ?? "the provided"} bytes starting at ${resolvedAddress}.`, {
        success: true,
        address: resolvedAddress,
        length: resolvedLength ?? null,
        bytes: writeInfo.canonical,
        details: detailRecord,
      });
    }

    const canPause = supportsMachinePause(ctx);
    let paused = false;
    try {
      if (canPause) {
        const pauseResult = await ctx.client.pause();
        if (!pauseResult.success) {
          throw new ToolExecutionError("C64 firmware reported failure while pausing", {
            details: normaliseFailure(pauseResult.details),
          });
        }
        paused = true;
      }

      const expectedBytes = expectedInfo?.bytes ?? new Uint8Array();
      const maskBytes = maskInfo?.bytes;
      const readLength = Math.max(1, Math.max(writeInfo.bytes.length, expectedBytes.length));

      const preRead = await ctx.client.readMemory(parsed.address, String(readLength));
      if (!preRead.success) {
        throw new ToolExecutionError("C64 firmware reported failure while reading memory", {
          details: normaliseFailure(preRead.details),
        });
      }

      const preInfo = parseFirmwareHex(preRead.data ?? "$", "pre-read");

      const preMismatches: Array<{ offset: number; expected: string; actual: string; mask?: string }> = [];
      if (expectedBytes.length > 0) {
        for (let i = 0; i < expectedBytes.length; i += 1) {
          const actual = preInfo.bytes[i] ?? 0x00;
          const expected = expectedBytes[i] ?? 0x00;
          const mask = maskBytes ? maskBytes[i] ?? 0xFF : 0xFF;

          if ((actual & mask) !== (expected & mask)) {
            preMismatches.push({
              offset: i,
              expected: formatByte(expected),
              actual: formatByte(actual),
              ...(maskBytes ? { mask: formatByte(mask) } : {}),
            });
          }
        }

        if (preMismatches.length > 0 && parsed.abortOnMismatch !== false) {
          throw new ToolExecutionError("Verification failed before write", {
            details: { mismatches: preMismatches, address: parsed.address },
          });
        }
      }

      const writeResult = await ctx.client.writeMemory(parsed.address, writeInfo.canonical);
      if (!writeResult.success) {
        throw new ToolExecutionError("C64 firmware reported failure while writing memory", {
          details: normaliseFailure(writeResult.details),
        });
      }

      const postRead = await ctx.client.readMemory(parsed.address, String(Math.max(1, writeInfo.bytes.length)));
      if (!postRead.success) {
        throw new ToolExecutionError("C64 firmware reported failure while reading back memory", {
          details: normaliseFailure(postRead.details),
        });
      }

      const postInfo = parseFirmwareHex(postRead.data ?? "$", "post-read");

      const diffs: Array<{ offset: number; before: string; after: string; expected: string }> = [];
      for (let i = 0; i < writeInfo.bytes.length; i += 1) {
        const before = preInfo.bytes[i] ?? 0x00;
        const after = postInfo.bytes[i] ?? 0x00;
        const expected = writeInfo.bytes[i] ?? 0x00;

        if (after !== expected) {
          diffs.push({
            offset: i,
            before: formatByte(before),
            after: formatByte(after),
            expected: formatByte(expected),
          });
        }
      }

      if (diffs.length > 0) {
        throw new ToolExecutionError("Post-write verification failed", {
          details: { address: parsed.address, diffs },
        });
      }

      const detailRecord = toRecord(writeResult.details) ?? {};
      const resolvedAddress = resolveAddressLabel(detailRecord, parsed.address);
      const resolvedLength = resolveLength(detailRecord);

      const verificationMetadata: Record<string, unknown> = {
        written: writeInfo.canonical,
        preRead: preInfo.canonical,
        postRead: postInfo.canonical,
        readLength,
      };

      if (expectedInfo) {
        verificationMetadata.expected = expectedInfo.canonical;
      }

      if (maskInfo) {
        verificationMetadata.mask = maskInfo.canonical;
      }

      if (preMismatches.length > 0) {
        verificationMetadata.preReadMismatches = preMismatches;
      }

      return textResult(`Wrote ${resolvedLength ?? "the provided"} bytes starting at ${resolvedAddress} (verified).`, {
        success: true,
        address: resolvedAddress,
        length: resolvedLength ?? null,
        bytes: writeInfo.canonical,
        details: detailRecord,
        verified: true,
        verification: verificationMetadata,
        paused,
      });
    } finally {
      if (paused) {
        try {
          const resumeResult = await ctx.client.resume();
          if (!resumeResult.success) {
            ctx.logger.warn("C64 resume reported failure after write", {
              details: normaliseFailure(resumeResult.details),
            });
          }
        } catch (resumeError) {
          ctx.logger.warn("Failed to resume C64 after write", {
            error: resumeError instanceof Error ? {
              name: resumeError.name,
              message: resumeError.message,
            } : { value: resumeError },
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return unknownErrorResult(error);
  }
}

const disassembleArgsSchema = objectSchema({
  description: "Parameters for disassembling a block of VICE memory into 6502/6510 instructions.",
  properties: {
    address: stringSchema({
      description: "Start address as $HHHH, decimal, or symbol name.",
      minLength: 1,
    }),
    length: numberSchema({
      description: "Number of bytes to read and disassemble.",
      integer: true,
      minimum: 1,
      maximum: 4096,
      default: 64,
    }),
    instructionCount: optionalSchema(numberSchema({
      description: "Stop after this many instructions (overrides length as a termination condition).",
      integer: true,
      minimum: 1,
      maximum: 512,
    })),
  },
  required: ["address"],
  additionalProperties: false,
});

async function executeDisassemble(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = disassembleArgsSchema.parse(rawArgs ?? {});
    const length = parsed.length ?? 64;
    ctx.logger.info("Disassembling VICE memory", { address: parsed.address, length });

    const address = parseAddressArg(parsed.address, "$.address");
    validateRangeWithinAddressSpace(address, length, "$.address");

    const bytes = await ctx.client.readMemoryRaw(address, length);
  const symbols = ctx.platform?.id === "vice" ? getViceSymbols() : undefined;
    const lines = disassemble(bytes, address, parsed.instructionCount, symbols);
    const text = formatDisassembly(lines);

    const addrHex = `$${address.toString(16).toUpperCase().padStart(4, "0")}`;
    return textResult(`Disassembly of ${lines.length} instructions starting at ${addrHex}:\n\n${text}`, {
      success: true,
      address: addrHex,
      bytesRead: bytes.length,
      instructionCount: lines.length,
    });
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return unknownErrorResult(error);
  }
}

// ---------------------------------------------------------------------------
// Shared address-parsing helper
// ---------------------------------------------------------------------------
function parseAddressArg(raw: string, fieldPath: string): number {
  const trimmed = raw.trim();
  let addr: number;
  if (/^\$[0-9A-Fa-f]+$/.test(trimmed)) {
    addr = parseInt(trimmed.slice(1), 16);
  } else if (/^0[xX][0-9A-Fa-f]+$/.test(trimmed)) {
    addr = parseInt(trimmed.slice(2), 16);
  } else if (/^[0-9]+$/.test(trimmed)) {
    addr = parseInt(trimmed, 10);
  } else {
    const resolved = resolveAddressSymbol(trimmed);
    if (resolved === undefined) {
      throw new ToolValidationError(`Unknown address or symbol: ${trimmed}`, { path: fieldPath });
    }
    addr = resolved;
  }
  if (!Number.isInteger(addr) || addr < 0 || addr > 0xffff) {
    throw new ToolValidationError("Address must be in range $0000-$FFFF", { path: fieldPath });
  }
  return addr;
}

function fmtAddr(addr: number): string {
  return `$${addr.toString(16).toUpperCase().padStart(4, "0")}`;
}

function validateRangeWithinAddressSpace(start: number, length: number, fieldPath: string): void {
  const end = start + length - 1;
  if (end > 0xffff) {
    throw new ToolValidationError(
      `${fieldPath} range exceeds address space; ${fmtAddr(start)} + ${length} bytes would pass $FFFF.`,
      { path: fieldPath },
    );
  }
}

// ---------------------------------------------------------------------------
// copy_memory
// ---------------------------------------------------------------------------
const copyMemoryArgsSchema = objectSchema({
  description: "Copy a region of RAM from one address to another.",
  properties: {
    source: stringSchema({ description: "Source start address ($HHHH, decimal, or symbol).", minLength: 1 }),
    dest: stringSchema({ description: "Destination start address.", minLength: 1 }),
    length: numberSchema({ description: "Number of bytes to copy (1–16384).", integer: true, minimum: 1, maximum: 16384 }),
  },
  required: ["source", "dest", "length"],
  additionalProperties: false,
});

async function executeCopyMemory(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = copyMemoryArgsSchema.parse(rawArgs ?? {});
    const src = parseAddressArg(parsed.source, "$.source");
    const dst = parseAddressArg(parsed.dest, "$.dest");
    const len = parsed.length;
    validateRangeWithinAddressSpace(src, len, "$.source");
    validateRangeWithinAddressSpace(dst, len, "$.dest");
    ctx.logger.info("Copying memory", { src: fmtAddr(src), dst: fmtAddr(dst), len });
    const bytes = await ctx.client.readMemoryRaw(src, len);
    await ctx.client.writeMemoryRaw(dst, bytes);
    return textResult(`Copied ${bytes.length} bytes from ${fmtAddr(src)} to ${fmtAddr(dst)}.`, {
      success: true, source: fmtAddr(src), dest: fmtAddr(dst), bytesCopied: bytes.length,
    });
  } catch (error) {
    if (error instanceof ToolError) return toolErrorResult(error);
    return unknownErrorResult(error);
  }
}

// ---------------------------------------------------------------------------
// fill_memory
// ---------------------------------------------------------------------------
const fillMemoryArgsSchema = objectSchema({
  description: "Fill a memory region with a repeating byte pattern.",
  properties: {
    address: stringSchema({ description: "Start address ($HHHH, decimal, or symbol).", minLength: 1 }),
    length: numberSchema({ description: "Number of bytes to fill (1–16384).", integer: true, minimum: 1, maximum: 16384 }),
    pattern: stringSchema({
      description: "Hex bytes to repeat, e.g. 'FF' or 'AA 55'. Space-separated or run together.",
      minLength: 2,
      pattern: /^[\s0-9A-Fa-f$]+$/,
    }),
  },
  required: ["address", "length", "pattern"],
  additionalProperties: false,
});

async function executeFillMemory(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = fillMemoryArgsSchema.parse(rawArgs ?? {});
    const addr = parseAddressArg(parsed.address, "$.address");
    validateRangeWithinAddressSpace(addr, parsed.length, "$.address");
    const { bytes: patternBytes } = parseUserHex(parsed.pattern, "$.pattern");
    if (patternBytes.length === 0) throw new ToolValidationError("Pattern must not be empty", { path: "$.pattern" });
    const buf = new Uint8Array(parsed.length);
    for (let i = 0; i < parsed.length; i++) buf[i] = patternBytes[i % patternBytes.length]!;
    await ctx.client.writeMemoryRaw(addr, buf);
    ctx.logger.info("Filled memory", { address: fmtAddr(addr), length: parsed.length, pattern: parsed.pattern });
    return textResult(`Filled ${parsed.length} bytes at ${fmtAddr(addr)} with pattern ${parsed.pattern.trim()}.`, {
      success: true, address: fmtAddr(addr), length: parsed.length, pattern: parsed.pattern.trim(),
    });
  } catch (error) {
    if (error instanceof ToolError) return toolErrorResult(error);
    return unknownErrorResult(error);
  }
}

// ---------------------------------------------------------------------------
// search_memory
// ---------------------------------------------------------------------------
const searchMemoryArgsSchema = objectSchema({
  description: "Search for a byte pattern within a memory range.",
  properties: {
    startAddress: stringSchema({ description: "Start of search range ($HHHH, decimal, or symbol).", minLength: 1 }),
    endAddress: stringSchema({ description: "End of search range (inclusive).", minLength: 1 }),
    pattern: stringSchema({
      description: "Hex bytes to find, e.g. 'A9 00' for LDA #$00.",
      minLength: 2,
      pattern: /^[\s0-9A-Fa-f$]+$/,
    }),
    maxResults: optionalSchema(numberSchema({ description: "Maximum matches to return (default 10).", integer: true, minimum: 1, maximum: 100, default: 10 })),
  },
  required: ["startAddress", "endAddress", "pattern"],
  additionalProperties: false,
});

async function executeSearchMemory(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = searchMemoryArgsSchema.parse(rawArgs ?? {});
    const start = parseAddressArg(parsed.startAddress, "$.startAddress");
    const end = parseAddressArg(parsed.endAddress, "$.endAddress");
    if (end < start) throw new ToolValidationError("endAddress must be ≥ startAddress", { path: "$.endAddress" });
    const { bytes: needle } = parseUserHex(parsed.pattern, "$.pattern");
    if (needle.length === 0) throw new ToolValidationError("Pattern must not be empty", { path: "$.pattern" });
    const maxResults = parsed.maxResults ?? 10;
    const len = end - start + 1;
    ctx.logger.info("Searching memory", { start: fmtAddr(start), end: fmtAddr(end), pattern: parsed.pattern });
    const haystack = await ctx.client.readMemoryRaw(start, len);
    const matches: string[] = [];
    outer: for (let i = 0; i <= haystack.length - needle.length && matches.length < maxResults; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      matches.push(fmtAddr(start + i));
    }
    return jsonResult(
      { found: matches.length, matches, pattern: parsed.pattern.trim(), range: { start: fmtAddr(start), end: fmtAddr(end) } },
      { success: true, found: matches.length },
    );
  } catch (error) {
    if (error instanceof ToolError) return toolErrorResult(error);
    return unknownErrorResult(error);
  }
}

// ---------------------------------------------------------------------------
// compare_memory
// ---------------------------------------------------------------------------
const compareMemoryArgsSchema = objectSchema({
  description: "Compare two memory regions and report differing bytes.",
  properties: {
    address1: stringSchema({ description: "First region start address.", minLength: 1 }),
    address2: stringSchema({ description: "Second region start address.", minLength: 1 }),
    length: numberSchema({ description: "Number of bytes to compare (1–16384).", integer: true, minimum: 1, maximum: 16384 }),
    maxDiffs: optionalSchema(numberSchema({ description: "Max differences to report (default 10).", integer: true, minimum: 1, maximum: 200, default: 10 })),
  },
  required: ["address1", "address2", "length"],
  additionalProperties: false,
});

async function executeCompareMemory(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = compareMemoryArgsSchema.parse(rawArgs ?? {});
    const a1 = parseAddressArg(parsed.address1, "$.address1");
    const a2 = parseAddressArg(parsed.address2, "$.address2");
    const len = parsed.length;
    const maxDiffs = parsed.maxDiffs ?? 10;
    validateRangeWithinAddressSpace(a1, len, "$.address1");
    validateRangeWithinAddressSpace(a2, len, "$.address2");
    ctx.logger.info("Comparing memory regions", { a1: fmtAddr(a1), a2: fmtAddr(a2), len });
    const [r1, r2] = await Promise.all([
      ctx.client.readMemoryRaw(a1, len),
      ctx.client.readMemoryRaw(a2, len),
    ]);
    type Diff = { offset: number; address1: string; address2: string; value1: string; value2: string };
    const diffs: Diff[] = [];
    for (let i = 0; i < len && diffs.length < maxDiffs; i++) {
      if (r1[i] !== r2[i]) {
        diffs.push({
          offset: i,
          address1: fmtAddr(a1 + i),
          address2: fmtAddr(a2 + i),
          value1: formatByte(r1[i] ?? 0),
          value2: formatByte(r2[i] ?? 0),
        });
      }
    }
    const identical = diffs.length === 0;
    return jsonResult(
      { identical, diffCount: diffs.length, diffs, region1: fmtAddr(a1), region2: fmtAddr(a2), length: len },
      { success: true, identical, diffCount: diffs.length },
    );
  } catch (error) {
    if (error instanceof ToolError) return toolErrorResult(error);
    return unknownErrorResult(error);
  }
}

// ---------------------------------------------------------------------------
// save_memory
// ---------------------------------------------------------------------------
const saveMemoryArgsSchema = objectSchema({
  description: "Dump a memory region to a local file, optionally with a PRG load-address header.",
  properties: {
    startAddress: stringSchema({ description: "Start address of region to save.", minLength: 1 }),
    endAddress: stringSchema({ description: "End address (inclusive).", minLength: 1 }),
    filePath: stringSchema({ description: "Absolute or relative path for the output file.", minLength: 1 }),
    asPrg: optionalSchema(booleanSchema({ description: "Prepend a 2-byte little-endian load-address header (PRG format). Default: true.", default: true })),
  },
  required: ["startAddress", "endAddress", "filePath"],
  additionalProperties: false,
});

async function executeSaveMemory(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = saveMemoryArgsSchema.parse(rawArgs ?? {});
    const start = parseAddressArg(parsed.startAddress, "$.startAddress");
    const end = parseAddressArg(parsed.endAddress, "$.endAddress");
    if (end < start) throw new ToolValidationError("endAddress must be ≥ startAddress", { path: "$.endAddress" });
    const asPrg = parsed.asPrg !== false;
    const len = end - start + 1;
    const resolvedPath = path.resolve(parsed.filePath);
    ctx.logger.info("Saving memory to file", { start: fmtAddr(start), end: fmtAddr(end), filePath: resolvedPath, asPrg });
    const bytes = await ctx.client.readMemoryRaw(start, len);
    const header = asPrg ? Buffer.from([start & 0xff, (start >> 8) & 0xff]) : Buffer.alloc(0);
    await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.promises.writeFile(resolvedPath, Buffer.concat([header, Buffer.from(bytes)]));
    const fileSize = bytes.length + header.length;
    return textResult(
      `Saved ${bytes.length} bytes (${fmtAddr(start)}–${fmtAddr(end)}) to ${resolvedPath}${asPrg ? " (PRG, with load address header)" : ""}.`,
      { success: true, filePath: resolvedPath, bytesRead: bytes.length, fileSize, asPrg, startAddress: fmtAddr(start), endAddress: fmtAddr(end) },
    );
  } catch (error) {
    if (error instanceof ToolError) return toolErrorResult(error);
    return unknownErrorResult(error);
  }
}

export interface MemoryOperationMap extends OperationMap {
  readonly read: { readonly address: string; readonly length?: number };
  readonly write: {
    readonly address: string; readonly bytes: string; readonly verify?: boolean;
    readonly expected?: string; readonly mask?: string; readonly abortOnMismatch?: boolean;
  };
  readonly read_screen: Record<string, never>;
  readonly disassemble: { readonly address: string; readonly length?: number; readonly instructionCount?: number };
  readonly copy_memory: { readonly source: string; readonly dest: string; readonly length: number };
  readonly fill_memory: { readonly address: string; readonly length: number; readonly pattern: string };
  readonly search_memory: { readonly startAddress: string; readonly endAddress: string; readonly pattern: string; readonly maxResults?: number };
  readonly compare_memory: { readonly address1: string; readonly address2: string; readonly length: number; readonly maxDiffs?: number };
  readonly save_memory: { readonly startAddress: string; readonly endAddress: string; readonly filePath: string; readonly asPrg?: boolean };
}

export const memoryOperationHandlers: OperationHandlerMap<MemoryOperationMap> = {
  read: async (args, ctx) => executeReadMemory(stripOperationDiscriminator(args), ctx),
  write: async (args, ctx) => executeWriteMemory(stripOperationDiscriminator(args), ctx),
  read_screen: async (args, ctx) => executeReadScreen(stripOperationDiscriminator(args), ctx),
  disassemble: async (args, ctx) => executeDisassemble(stripOperationDiscriminator(args), ctx),
  copy_memory: async (args, ctx) => executeCopyMemory(stripOperationDiscriminator(args), ctx),
  fill_memory: async (args, ctx) => executeFillMemory(stripOperationDiscriminator(args), ctx),
  search_memory: async (args, ctx) => executeSearchMemory(stripOperationDiscriminator(args), ctx),
  compare_memory: async (args, ctx) => executeCompareMemory(stripOperationDiscriminator(args), ctx),
  save_memory: async (args, ctx) => executeSaveMemory(stripOperationDiscriminator(args), ctx),
};

export {
  disassembleArgsSchema,
  copyMemoryArgsSchema,
  fillMemoryArgsSchema,
  searchMemoryArgsSchema,
  compareMemoryArgsSchema,
  saveMemoryArgsSchema,
};

export const memoryModule = defineToolModule({
  domain: "memory",
  summary: "Screen, main memory, and low-level inspection utilities.",
  supportedPlatforms: ["c64u", "vice"] as const,
  resources: [
    "c64://guide/bootstrap",
    "c64://basic/spec",
    "c64://assembly/6510-spec",
  ],
  prompts: ["memory-debug", "basic-program", "assembly-program"],
  defaultTags: ["memory", "debug"],
  workflowHints: [
    "Pair memory operations with documentation snippets so addresses and symbols stay meaningful to the user.",
    "Confirm intent before mutating RAM and explain how the change affects the running program.",
  ],
  tools: [
    {
      name: "read_screen",
      description: "Read the current text screen (40x25) and return its ASCII representation. For PETSCII details, see c64://basic/spec.",
      summary: "Fetches screen RAM, converts from PETSCII, and returns the printable output.",
      inputSchema: readScreenArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap", "c64://basic/spec"],
      relatedPrompts: ["memory-debug", "basic-program", "assembly-program"],
      tags: ["screen", "memory"],
      prerequisites: [],
      examples: [
        {
          name: "Capture screen",
          description: "Read current 40x25 text",
          arguments: {},
        },
      ],
      workflowHints: [
        "Call after running a program when the user asks to see what is on screen; echo the captured text back to them.",
      ],
      async execute(args, ctx) {
        return executeReadScreen(args, ctx);
      },
    },
    {
      name: "read",
      description: "Read a range of bytes from main memory and return the data as hexadecimal. Consult c64://assembly/6510-spec and docs index.",
      summary: "Resolves symbols, reads memory, and returns a hex dump with addressing metadata.",
      inputSchema: readMemoryArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap", "c64://assembly/6510-spec", "c64://guide/index"],
      relatedPrompts: ["memory-debug", "assembly-program"],
      tags: ["memory", "hex"],
      prerequisites: [],
      examples: [
        {
          name: "Read screen memory",
          description: "Read 8 bytes at $0400",
          arguments: { address: "$0400", length: 8 },
        },
      ],
      workflowHints: [
        "Resolve symbol names before calling so you can explain the chosen address in the response.",
        "Keep reads at or below 4096 bytes; split larger requests into multiple calls if needed.",
      ],
      async execute(args, ctx) {
        return executeReadMemory(args, ctx);
      },
    },
    {
      name: "write",
      description: "Write a hexadecimal byte sequence into main memory at the specified address. See c64://guide/bootstrap for safety rules.",
      summary: "Resolves symbols, validates hex data, and writes bytes to RAM.",
      inputSchema: writeMemoryArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap", "c64://assembly/6510-spec", "c64://guide/index"],
      relatedPrompts: ["memory-debug", "assembly-program"],
      tags: ["memory", "hex", "write"],
        prerequisites: ["read"],
      examples: [
        {
          name: "Write to screen",
          description: "Write $AA55 at $0400",
          arguments: { address: "$0400", bytes: "$AA55" },
        },
      ],
      workflowHints: [
        "Double-check with the user before writing memory and describe the exact bytes you applied.",
        "Consider reading the region first so they can compare before and after states.",
      ],
      async execute(args, ctx) {
        return executeWriteMemory(args, ctx);
      },
    },
  ],
});
