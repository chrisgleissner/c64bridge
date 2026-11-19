// Graphics-related meta tools (sprites, charsets)
import type { ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, numberSchema, optionalSchema, booleanSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolExecutionError, ToolValidationError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { normalizeErrorDetails } from "./util.js";
import { promises as fs } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { resolveHostChildPath, resolveHostPath } from "../../hostPaths.js";
import { rangeOverlapsIo } from "../../ioRange.js";
import { parseNumericLiteral, assertNotBareHex, assertAddressRange } from "../../numericArg.js";
import { acquireOwnedPause, resumeWarning } from "../pauseGuard.js";

function supportsMachinePause(ctx: { platform?: { id?: string }; client?: { type?: string } }): boolean {
  const platformId = ctx.platform?.id ?? ctx.client?.type;
  return platformId !== "vice";
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

function formatAddressHex(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function hexClean(input: string): string {
  const trimmed = input.trim();
  const withoutPrefix = trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
  return withoutPrefix.replace(/[^0-9A-Fa-f]/g, "").toLowerCase();
}

function hexToBytes(input: string): Uint8Array {
  const cleaned = hexClean(input);
  if (cleaned.length === 0) return new Uint8Array();
  if (cleaned.length % 2 !== 0) {
    throw new ToolExecutionError("Firmware returned odd-length hex payload", { details: { hexLength: cleaned.length } });
  }
  return Uint8Array.from(Buffer.from(cleaned, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return `$${Buffer.from(bytes).toString("hex").toUpperCase()}`;
}

async function readByte(ctx: { client: unknown }, address: number, pinned: unknown): Promise<number | undefined> {
  try {
    const read = await (ctx.client as any).readMemory(`$${formatAddressHex(address)}`, "1", pinned);
    if (!read?.success || typeof read.data !== "string") return undefined;
    return hexToBytes(read.data)[0];
  } catch {
    return undefined;
  }
}

function countBits(byte: number): number {
  let b = byte & 0xFF;
  b = b - ((b >> 1) & 0x55);
  b = (b & 0x33) + ((b >> 2) & 0x33);
  return (b + (b >> 4)) & 0x0F;
}

interface SpriteAnalysis {
  address: string;
  offset: number;
  bytesHex: string;
  base64?: string;
  filePath?: string;
  nonZeroRows: number;
  totalSetBits: number;
  boundingBox: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number } | null;
  rowActivations?: Array<{ row: number; setBits: number; firstBit: number | null; lastBit: number | null }>;
  /** VIC bank (0-3) of the block and the sprite data pointer value that selects it within that bank. */
  vicBank?: number;
  pointer?: string;
}

function analyzeSprite(bytes: Uint8Array, startAddress: number): SpriteAnalysis | null {
  if (bytes.length !== 63) return null;
  let nonZeroRows = 0;
  let totalSetBits = 0;
  let minX = 24;
  let maxX = -1;
  let minY = 21;
  let maxY = -1;
  const rows: Array<{ row: number; setBits: number; firstBit: number | null; lastBit: number | null }> = [];

  for (let row = 0; row < 21; row += 1) {
    const start = row * 3;
    const rowBytes = bytes.subarray(start, start + 3);
    const rowBits = countBits(rowBytes[0] ?? 0) + countBits(rowBytes[1] ?? 0) + countBits(rowBytes[2] ?? 0);
    totalSetBits += rowBits;
    if (rowBits === 0) {
      rows.push({ row, setBits: 0, firstBit: null, lastBit: null });
      continue;
    }
    nonZeroRows += 1;
    let firstBit: number | null = null;
    let lastBit: number | null = null;
    for (let bit = 0; bit < 24; bit += 1) {
      const byteIndex = Math.floor(bit / 8);
      const bitIndex = 7 - (bit % 8);
      const isSet = ((rowBytes[byteIndex] ?? 0) >> bitIndex) & 0x01;
      if (isSet) {
        if (firstBit === null) firstBit = bit;
        lastBit = bit;
      }
    }
    if (firstBit !== null && firstBit < minX) minX = firstBit;
    if (lastBit !== null && lastBit > maxX) maxX = lastBit;
    minY = Math.min(minY, row);
    maxY = Math.max(maxY, row);
    rows.push({ row, setBits: rowBits, firstBit, lastBit });
  }

  const boundingBox = nonZeroRows > 0 && minX <= maxX && minY <= maxY
    ? ({ minX, maxX, minY, maxY, width: (maxX - minX) + 1, height: (maxY - minY) + 1 })
    : null;

  return {
    address: `$${formatAddressHex(startAddress)}`,
    offset: 0,
    bytesHex: bytesToHex(bytes),
    nonZeroRows,
    totalSetBits,
    boundingBox,
    rowActivations: rows,
  };
}

const extractSpritesArgsSchema = objectSchema({
  description: "Scan RAM for likely sprite data and export matches.",
  properties: {
    address: stringSchema({ description: "Start address ($HHHH or decimal)", minLength: 1 }),
    length: numberSchema({ description: "Number of bytes to scan", integer: true, minimum: 63, maximum: 65536 }),
    stride: optionalSchema(numberSchema({ description: "Stride between sprite candidates in bytes (at least 63; sprite blocks are 64 bytes apart)", integer: true, minimum: 63, default: 64 }), 64),
    maxSprites: optionalSchema(numberSchema({ description: "Maximum sprites to return", integer: true, minimum: 1, maximum: 256, default: 16 }), 16),
    minNonZeroRows: optionalSchema(numberSchema({ description: "Minimum non-empty rows required", integer: true, minimum: 1, maximum: 21, default: 4 }), 4),
    minSetBits: optionalSchema(numberSchema({ description: "Minimum number of set bits required", integer: true, minimum: 1, maximum: 504, default: 12 }), 12),
    includeBase64: optionalSchema(booleanSchema({ description: "Also include each sprite as base64 (bytesHex already carries the data)", default: false }), false),
    includeRows: optionalSchema(booleanSchema({ description: "Include the per-row bit activation of each sprite", default: false }), false),
    outputDir: optionalSchema(stringSchema({ description: "Directory to write .spr files", minLength: 1 })),
    pauseDuringRead: optionalSchema(booleanSchema({ description: "Pause the machine during memory read", default: true }), true),
  },
  required: ["address", "length"],
  additionalProperties: false,
});

interface CharsetAnalysis {
  address: string;
  sizeBytes: number;
  entropy: number;
  nonEmptyChars: number;
  averageSetBits: number;
}

function analyzeCharset(bytes: Uint8Array, startAddress: number): CharsetAnalysis {
  const charsetSize = bytes.length;
  const numChars = charsetSize / 8;
  let nonEmptyChars = 0;
  let totalSetBits = 0;
  const charEntropies: number[] = [];

  for (let charIndex = 0; charIndex < numChars; charIndex += 1) {
    const charBytes = bytes.subarray(charIndex * 8, (charIndex + 1) * 8);
    let charSetBits = 0;
    for (const byte of charBytes) {
      charSetBits += countBits(byte);
    }
    totalSetBits += charSetBits;
    if (charSetBits > 0) {
      nonEmptyChars += 1;
    }

    // Calculate entropy for this character
    const bitCounts = new Array(2).fill(0);
    for (const byte of charBytes) {
      for (let bit = 0; bit < 8; bit += 1) {
        bitCounts[(byte >> bit) & 1] += 1;
      }
    }
    const total = bitCounts[0] + bitCounts[1];
    let entropy = 0;
    for (const count of bitCounts) {
      if (count > 0) {
        const p = count / total;
        entropy -= p * Math.log2(p);
      }
    }
    charEntropies.push(entropy);
  }

  const averageEntropy = charEntropies.reduce((sum, e) => sum + e, 0) / charEntropies.length;
  const averageSetBits = totalSetBits / numChars;

  return {
    address: `$${formatAddressHex(startAddress)}`,
    sizeBytes: charsetSize,
    entropy: averageEntropy,
    nonEmptyChars,
    averageSetBits,
  };
}

const ripCharsetArgsSchema = objectSchema({
  description: "Locate and extract character set data from RAM; without an address it checks the charset in use ($D018/$DD00) and the common RAM locations.",
  properties: {
    address: optionalSchema(stringSchema({ description: "Start address to scan ($HHHH or decimal). If not provided, checks the active charset and common locations ($0800, $2000, $2800, $3000, $3800).", minLength: 1 })),
    scanRange: optionalSchema(stringSchema({ description: "Range to scan if address not provided: 'common' or 'full'", enum: ["common", "full"] }), "common"),
    outputPath: optionalSchema(stringSchema({ description: "File path to write charset binary", minLength: 1 })),
    pauseDuringRead: optionalSchema(booleanSchema({ description: "Pause the machine during memory read", default: true }), true),
    minNonEmptyChars: optionalSchema(numberSchema({ description: "Minimum non-empty characters required", integer: true, minimum: 1, maximum: 256, default: 32 }), 32),
    minEntropy: optionalSchema(numberSchema({ description: "Minimum average entropy threshold", minimum: 0, maximum: 1, default: 0.3 }), 0.3),
  },
  required: [],
  additionalProperties: false,
});

export const tools: ToolDefinition[] = [
  {
    name: "extract_sprites_from_ram",
    description: "Scan a RAM region, detect sprite blobs, and optionally save them as .spr files.",
    summary: "Detect and export sprite data from RAM.",
    inputSchema: extractSpritesArgsSchema.jsonSchema,
    tags: ["graphics", "sprites", "extract"],
    examples: [
      {
        name: "Scan sprite page",
        description: "Scan $2000-$27FF with stride 64",
        arguments: { address: "$2000", length: 2048, stride: 64, maxSprites: 8 },
      },
    ],
    async execute(args, ctx) {
      try {
        const parsed = extractSpritesArgsSchema.parse(args ?? {});
        const startAddress = parseAddressNumeric(parsed.address);
        const length = parsed.length as number;
        const stride = Math.max(1, parsed.stride ?? 64);
        const maxSprites = parsed.maxSprites ?? 16;
        const minNonZeroRows = parsed.minNonZeroRows ?? 4;
        const minSetBits = parsed.minSetBits ?? 12;
        const includeBase64 = parsed.includeBase64 === true;
        const includeRows = parsed.includeRows === true;
        const pauseDuringRead = parsed.pauseDuringRead !== false;

        if (startAddress + length - 1 > 0xFFFF) {
          throw new ToolValidationError("Scan range extends past end of address space", { details: { address: parsed.address, length } });
        }
        if (stride < 63) {
          throw new ToolValidationError("Stride must be at least 63 bytes to avoid overlapping sprites", { path: "$.stride" });
        }

        const canPause = pauseDuringRead && supportsMachinePause(ctx as any);
        const owned = await acquireOwnedPause(ctx.client, canPause);
        const pinned = owned.facade;
        if (canPause && !owned.result.success) {
          throw new ToolExecutionError("Pause failed before sprite scan", { details: normalizeErrorDetails(owned.result.details) });
        }

        let released = false;
        try {
          const read = await (ctx.client as any).readMemory(`$${formatAddressHex(startAddress)}`, String(length), pinned);
          if (!read.success || typeof read.data !== "string") {
            throw new ToolExecutionError("C64 backend reported failure while reading memory", { details: normalizeErrorDetails(read.details) });
          }
          const bytes = hexToBytes(read.data);
          if (bytes.length < length) {
            throw new ToolExecutionError("Firmware returned fewer bytes than requested", { details: { expected: length, received: bytes.length } });
          }

          const sprites: SpriteAnalysis[] = [];
          let candidates = 0;
          for (let offset = 0; offset + 63 <= length && sprites.length < maxSprites; offset += stride) {
            const window = bytes.subarray(offset, offset + 63);
            candidates += 1;
            if (!window.some((b) => b !== 0)) continue;
            const analysis = analyzeSprite(window, (startAddress + offset) & 0xFFFF);
            if (!analysis) continue;
            if (analysis.nonZeroRows < minNonZeroRows) continue;
            if (analysis.totalSetBits < minSetBits) continue;
            if (includeBase64) {
              analysis.base64 = Buffer.from(window).toString("base64");
            }
            analysis.offset = offset;
            const spriteAddress = (startAddress + offset) & 0xFFFF;
            // Sprite data pointer: the block number inside the 16 KB VIC bank (address within the bank / 64).
            analysis.vicBank = spriteAddress >> 14;
            analysis.pointer = `$${(((spriteAddress & 0x3FFF) >> 6) & 0xFF).toString(16).toUpperCase().padStart(2, "0")}`;
            if (!includeRows) delete (analysis as Partial<SpriteAnalysis>).rowActivations;
            sprites.push(analysis);
          }

          let outputFiles: Array<{ path: string; address: string }> = [];
          if (parsed.outputDir && sprites.length > 0) {
            const resolvedDir = resolveHostPath(String(parsed.outputDir), { purpose: "write" });
            await fs.mkdir(resolvedDir, { recursive: true });
            outputFiles = await Promise.all(sprites.map(async (sprite) => {
              const filePath = resolveHostChildPath(resolvedDir, `sprite_${sprite.address.replace("$", "").toLowerCase()}.spr`);
              await fs.mkdir(dirname(filePath), { recursive: true });
              await fs.writeFile(filePath, Buffer.from(hexClean(sprite.bytesHex), "hex"));
              sprite.filePath = filePath;
              return { path: filePath, address: sprite.address };
            }));
          }

          let warnings: string[] | undefined;
          if (canPause) {
            released = true;
            const result = await owned.release();
            if (!result.success) {
              warnings = [resumeWarning(result.details)];
              ctx.logger.warn("C64 resume reported failure after sprite scan", { details: result.details });
            }
          }
          if (startAddress % 64 !== 0) {
            // Sprite data starts on a 64-byte block boundary (pointer x 64), so a scan from another address sees shifted windows.
            warnings = [...(warnings ?? []), `address $${formatAddressHex(startAddress)} is not a multiple of 64; real sprite blocks start at multiples of 64 ($${formatAddressHex(startAddress - (startAddress % 64))}, +64, ...), so these windows are probably shifted`];
          }
          return jsonResult({
            scanned: {
              address: `$${formatAddressHex(startAddress)}`,
              length,
              stride,
              candidates,
              paused: canPause,
            },
            sprites,
            outputFiles,
            ...(warnings ? { warnings } : {}),
          }, { success: true });
        } finally {
          if (canPause && !released) {
            const result = await owned.release();
            if (!result.success) ctx.logger.warn("C64 resume reported failure after sprite scan", { details: result.details });
          }
        }
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
  {
    name: "rip_charset_from_ram",
    description: "Locate and extract 2KB character sets from RAM by structure and entropy checks. Exports as binary.",
    summary: "Extract character set data from RAM.",
    inputSchema: ripCharsetArgsSchema.jsonSchema,
    tags: ["graphics", "charset", "extract"],
    examples: [
      {
        name: "Extract charset from custom location",
        description: "Extract charset from $3000",
        arguments: { address: "$3000", outputPath: "/tmp/charset.bin" },
      },
      {
        name: "Scan common locations",
        description: "Scan ROM and RAM for charsets",
        arguments: { scanRange: "common" },
      },
    ],
    async execute(args, ctx) {
      try {
        const parsed = ripCharsetArgsSchema.parse(args ?? {});
        const pauseDuringRead = parsed.pauseDuringRead !== false;
        const minNonEmptyChars = parsed.minNonEmptyChars ?? 32;
        const minEntropy = parsed.minEntropy ?? 0.3;
        const charsetSize = 2048; // 256 chars * 8 bytes each

        // Common charset locations in VIC bank 0 ($D018 bits 1-3 select a 2 KB block: $0800, $2000, $2800, $3000, $3800).
        // $D000-$DFFF is not listed: a read there returns the I/O view (and clears CIA interrupt flags
        // on hardware), never the character ROM.
        const commonLocations = [0x3800, 0x3000, 0x2800, 0x2000, 0x0800];

        const scanLocations: number[] = [];
        if (parsed.address) {
          const address = parseAddressNumeric(parsed.address);
          assertAddressRange(address, charsetSize, "$.address");
          if (rangeOverlapsIo(address, charsetSize)) {
            throw new ToolValidationError("Charset read must not overlap $D000-$DFFF I/O registers", { path: "$.address" });
          }
          scanLocations.push(address);
        } else if (parsed.scanRange === "full") {
          // Every 2 KB block outside the I/O area; read below in two large blocks, not one request per block.
          for (let addr = 0; addr <= 0x10000 - charsetSize; addr += 0x800) {
            if (rangeOverlapsIo(addr, charsetSize)) continue;
            scanLocations.push(addr);
          }
        } else {
          // Default: scan common locations
          scanLocations.push(...commonLocations);
        }

        const canPause = pauseDuringRead && supportsMachinePause(ctx as any);
        const owned = await acquireOwnedPause(ctx.client, canPause);
        const pinned = owned.facade;
        if (canPause && !owned.result.success) {
          throw new ToolExecutionError("Pause failed before charset scan", { details: normalizeErrorDetails(owned.result.details) });
        }

        let released = false;
        try {
          const candidates: Array<CharsetAnalysis & { bytes?: Uint8Array }> = [];

          // The charset the VIC-II uses now: $D018 bits 1-3 (x $800) inside the bank chosen by $DD00 bits 0-1 (inverted, x $4000).
          // Both are plain register reads (no side effects). Skipped when the reads fail or both read $00.
          let active: { address: number; inRom: boolean } | undefined;
          if (!parsed.address) {
            const d018 = await readByte(ctx, 0xd018, pinned);
            const dd00 = await readByte(ctx, 0xdd00, pinned);
            if (d018 !== undefined && dd00 !== undefined && !(d018 === 0 && dd00 === 0)) {
              const bank = 3 - (dd00 & 0x03);
              const offset = ((d018 >> 1) & 0x07) * 0x0800;
              // Banks 0 and 2 show the character ROM at offsets $1000-$1FFF instead of RAM; the CPU cannot read that image.
              const inRom = (bank === 0 || bank === 2) && offset >= 0x1000 && offset < 0x2000;
              active = { address: bank * 0x4000 + offset, inRom };
              if (!inRom && !rangeOverlapsIo(active.address, charsetSize) && !scanLocations.includes(active.address)) {
                scanLocations.unshift(active.address);
              }
            }
          }

          const analyse = (startAddress: number, bytes: Uint8Array): void => {
            const analysis = analyzeCharset(bytes, startAddress);
            // Apply heuristics to determine if this looks like a charset
            if (analysis.nonEmptyChars >= minNonEmptyChars && analysis.entropy >= minEntropy) {
              candidates.push({ ...analysis, bytes });
            }
          };

          if (parsed.scanRange === "full" && !parsed.address) {
            const blocks: Array<[number, number]> = [[0x0000, 0xd000], [0xe000, 0x10000]];
            for (const [from, to] of blocks) {
              const read = await (ctx.client as any).readMemory(`$${formatAddressHex(from)}`, String(to - from), pinned);
              if (!read.success || typeof read.data !== "string") continue;
              const all = hexToBytes(read.data);
              if (all.length < to - from) continue;
              for (const startAddress of scanLocations) {
                if (startAddress >= from && startAddress + charsetSize <= to) analyse(startAddress, all.subarray(startAddress - from, startAddress - from + charsetSize));
              }
            }
          } else {
            for (const startAddress of scanLocations) {
              if (startAddress + charsetSize - 1 > 0xFFFF) continue;

              const read = await (ctx.client as any).readMemory(`$${formatAddressHex(startAddress)}`, String(charsetSize), pinned);
              if (!read.success || typeof read.data !== "string") {
                continue; // Skip this location if read fails
              }

              const bytes = hexToBytes(read.data);
              if (bytes.length < charsetSize) continue;
              analyse(startAddress, bytes);
            }
          }

          const activeInfo = (): Record<string, unknown> => active === undefined ? {} : {
            activeCharset: active.inRom
              ? { address: `$${formatAddressHex(active.address)}`, inRom: true, note: "The VIC-II shows the character ROM image here; the CPU cannot read it as RAM." }
              : { address: `$${formatAddressHex(active.address)}`, inRom: false },
          };

          // Resume as soon as the reads are done, so a failure can be reported in the result.
          let warnings: string[] | undefined;
          if (canPause) {
            released = true;
            const result = await owned.release();
            if (!result.success) {
              warnings = [resumeWarning(result.details)];
              ctx.logger.warn("C64 resume reported failure after charset scan", { details: result.details });
            }
          }

          if (candidates.length === 0) {
            return jsonResult({
              found: false,
              scanned: scanLocations.length,
              ...activeInfo(),
              message: "No valid charsets found matching criteria",
              ...(warnings ? { warnings } : {}),
            }, { success: true });
          }

          // The charset in use comes first; the others follow by non-empty chars, then by entropy (both descending).
          candidates.sort((a, b) => {
            const activeA = active !== undefined && a.address === `$${formatAddressHex(active.address)}` ? 1 : 0;
            const activeB = active !== undefined && b.address === `$${formatAddressHex(active.address)}` ? 1 : 0;
            if (activeA !== activeB) return activeB - activeA;
            const diffNonEmpty = b.nonEmptyChars - a.nonEmptyChars;
            if (diffNonEmpty !== 0) return diffNonEmpty;
            return b.entropy - a.entropy;
          });

          const bestCandidate = candidates[0]!;

          let outputFile: { path: string; address: string } | null = null;
          if (parsed.outputPath && bestCandidate.bytes) {
            const resolvedPath = resolveHostPath(String(parsed.outputPath), { purpose: "write" });
            await fs.mkdir(dirname(resolvedPath), { recursive: true });
            await fs.writeFile(resolvedPath, Buffer.from(bestCandidate.bytes));
            outputFile = { path: resolvedPath, address: bestCandidate.address };
          }

          const { bytes: _, ...analysisWithoutBytes } = bestCandidate;

          return jsonResult({
            found: true,
            charset: analysisWithoutBytes,
            candidates: candidates.length,
            candidateAddresses: candidates.map((entry) => entry.address),
            ...activeInfo(),
            outputFile,
            paused: canPause,
            ...(warnings ? { warnings } : {}),
          }, { success: true });
        } finally {
          if (canPause && !released) {
            const result = await owned.release();
            if (!result.success) ctx.logger.warn("C64 resume reported failure after charset scan", { details: result.details });
          }
        }
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
];
