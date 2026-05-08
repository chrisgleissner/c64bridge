/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from "node:buffer";
import { asciiToPetscii, encodeStringWithNames } from "../../petscii.js";

const DEFAULT_START_ADDRESS = 0x0801;
const REM_TOKEN = 0x8f;

type TokenEntry = {
  text: string;
  byte: number;
};

const TOKEN_TABLE: TokenEntry[] = buildTokenTable();

export function basicToPrg(source: string, options?: { startAddress?: number }): Buffer {
  const startAddress = options?.startAddress ?? DEFAULT_START_ADDRESS;
  const normalizedSource = normalize(source);
  const lines = normalizedSource.split("\n");

  const lineBuffers: Buffer[] = [];
  let currentAddress = startAddress;

  for (const rawLine of lines) {
    const trimmedRight = rawLine.replace(/\s+$/u, "");
    if (trimmedRight === "") {
      continue;
    }

    const match = /^\s*(\d+)\s*(.*)$/u.exec(trimmedRight);
    if (!match) {
      throw new Error(`Expected line number at: "${rawLine}"`);
    }

    const lineNumber = Number.parseInt(match[1], 10);
    if (!Number.isInteger(lineNumber) || lineNumber < 0 || lineNumber > 65535) {
      throw new Error(`Line number out of range: ${match[1]}`);
    }

    const content = match[2] ?? "";
    const tokenised = tokenize(content);
    const lineLength = 2 + 2 + tokenised.length + 1;
    const nextAddress = currentAddress + lineLength;

    const lineBuffer = Buffer.alloc(lineLength);
    lineBuffer.writeUInt16LE(nextAddress, 0);
    lineBuffer.writeUInt16LE(lineNumber, 2);
    Buffer.from(tokenised).copy(lineBuffer, 4);
    lineBuffer[4 + tokenised.length] = 0x00;

    lineBuffers.push(lineBuffer);
    currentAddress = nextAddress;
  }

  const header = Buffer.alloc(2);
  header.writeUInt16LE(startAddress, 0);

  return Buffer.concat([header, ...lineBuffers, Buffer.from([0x00, 0x00])]);
}

function normalize(input: string): string {
  const unified = input.replace(/\r\n?/g, "\n");
  const withoutTrailingNewlines = unified.replace(/\n+$/u, "");
  return `${withoutTrailingNewlines}\n`;
}

function tokenize(content: string): Uint8Array {
  const upper = content.toUpperCase();
  const bytes: number[] = [];
  let index = 0;
  let inString = false;
  let inRemark = false;

  while (index < content.length) {
    if (!inString && !inRemark) {
      const token = matchToken(upper, index);
      if (token) {
        bytes.push(token.byte);
        index += token.text.length;
        if (token.byte === REM_TOKEN) {
          inRemark = true;
        }
        continue;
      }
    }

    const char = content[index]!;

    // Special handling for string literals: encode the inner text in one go
    if (!inRemark && char === '"') {
      bytes.push(asciiToPetscii('"'));
      inString = !inString;
      index += 1;

      if (inString) {
        // capture until next quote or end of line
        const start = index;
        let end = start;
        while (end < content.length && content[end] !== '"') {
          end += 1;
        }
        const segment = content.slice(start, end);
        const encoded = encodeStringWithNames(segment);
        for (const b of encoded) bytes.push(b);
        index = end; // leave closing quote to be processed next iteration
      }
      continue;
    }

    const plainChar = (!inString && !inRemark ? upper[index]! : char) ?? char;
    bytes.push(asciiToPetscii(plainChar));
    index += 1;
  }

  if (bytes.length === 0) {
    bytes.push(0x20);
  }

  return Uint8Array.from(bytes);
}

function matchToken(upperSource: string, startIndex: number): TokenEntry | undefined {
  for (const entry of TOKEN_TABLE) {
    if (upperSource.startsWith(entry.text, startIndex)) {
      return entry;
    }
  }
  return undefined;
}

// asciiToPetscii is imported from petscii.ts

function buildTokenTable(): TokenEntry[] {
  const baseTokens: Array<[string, number]> = [
    ["END", 0x80],
    ["FOR", 0x81],
    ["NEXT", 0x82],
    ["DATA", 0x83],
    ["INPUT#", 0x84],
    ["INPUT", 0x85],
    ["DIM", 0x86],
    ["READ", 0x87],
    ["LET", 0x88],
    ["GOTO", 0x89],
    ["RUN", 0x8a],
    ["IF", 0x8b],
    ["RESTORE", 0x8c],
    ["GOSUB", 0x8d],
    ["RETURN", 0x8e],
    ["REM", REM_TOKEN],
    ["STOP", 0x90],
    ["ON", 0x91],
    ["WAIT", 0x92],
    ["LOAD", 0x93],
    ["SAVE", 0x94],
    ["VERIFY", 0x95],
    ["DEF", 0x96],
    ["POKE", 0x97],
    ["PRINT#", 0x98],
    ["PRINT", 0x99],
    ["CONT", 0x9a],
    ["LIST", 0x9b],
    ["CLR", 0x9c],
    ["CMD", 0x9d],
    ["SYS", 0x9e],
    ["OPEN", 0x9f],
    ["CLOSE", 0xa0],
    ["GET", 0xa1],
    ["NEW", 0xa2],
    ["TAB(", 0xa3],
    ["TO", 0xa4],
    ["FN", 0xa5],
    ["SPC(", 0xa6],
    ["THEN", 0xa7],
    ["NOT", 0xa8],
    ["STEP", 0xa9],
    ["+", 0xaa],
    ["-", 0xab],
    ["*", 0xac],
    ["/", 0xad],
    ["^", 0xae],
    ["AND", 0xaf],
    ["OR", 0xb0],
    [">", 0xb1],
    ["=", 0xb2],
    ["<", 0xb3],
    ["SGN", 0xb4],
    ["INT", 0xb5],
    ["ABS", 0xb6],
    ["USR", 0xb7],
    ["FRE", 0xb8],
    ["POS", 0xb9],
    ["SQR", 0xba],
    ["RND", 0xbb],
    ["LOG", 0xbc],
    ["EXP", 0xbd],
    ["COS", 0xbe],
    ["SIN", 0xbf],
    ["TAN", 0xc0],
    ["ATN", 0xc1],
    ["PEEK", 0xc2],
    ["LEN", 0xc3],
    ["STR$", 0xc4],
    ["VAL", 0xc5],
    ["ASC", 0xc6],
    ["CHR$", 0xc7],
    ["LEFT$", 0xc8],
    ["RIGHT$", 0xc9],
    ["MID$", 0xca],
    ["GO", 0xcb],
  ];

  return baseTokens
    .slice()
    .sort((a, b) => b[0].length - a[0].length)
    .map(([text, byte]) => ({ text, byte }));
}
