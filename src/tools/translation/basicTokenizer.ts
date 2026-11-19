/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from "node:buffer";
import { parseBraceToken } from "../../petscii.js";
import { ToolValidationError } from "../errors.js";

const DEFAULT_START_ADDRESS = 0x0801;
const REM_TOKEN = 0x8f;
const DATA_TOKEN = 0x83;
const PRINT_TOKEN = 0x99;
// Highest line number the BASIC V2 line parser (LINGET) accepts; larger values give ?SYNTAX ERROR.
const MAX_LINE_NUMBER = 63999;
// BASIC text and variables live below the BASIC ROM at $A000.
const BASIC_RAM_END = 0xa000;
// The 80-character (two screen line) limit of the C64 line editor is not
// enforced: basicToPrg builds a PRG that the firmware loads directly, and LIST
// and RUN handle tokenised lines longer than the editor accepts.

type TokenEntry = {
  text: string;
  byte: number;
};

const TOKEN_TABLE: TokenEntry[] = buildTokenTable();

/** Keyword text for a BASIC V2 token byte (0x80-0xCB), or undefined. */
export function basicTokenText(byte: number): string | undefined {
  return TOKEN_TABLE.find((entry) => entry.byte === byte)?.text;
}

export interface BasicPrgResult {
  readonly prg: Buffer;
  /**
   * Line numbers whose earlier text was replaced by a later line with the same number
   * (as when typing a line again on the C64), in source order, without repeats.
   */
  readonly replacedLines: number[];
}

export function basicToPrg(source: string, options?: { startAddress?: number }): Buffer {
  return basicToPrgDetailed(source, options).prg;
}

export function basicToPrgDetailed(source: string, options?: { startAddress?: number }): BasicPrgResult {
  const replacedLines: number[] = [];
  const startAddress = options?.startAddress ?? DEFAULT_START_ADDRESS;
  const normalizedSource = normalize(source);
  const lines = normalizedSource.split("\n");

  // Like typing lines into the C64, lines are kept in ascending order, a later
  // duplicate replaces the earlier line, and a bare line number deletes it.
  const programLines = new Map<number, Uint8Array>();

  for (const [lineIndex, rawLine] of lines.entries()) {
    const trimmedRight = rawLine.replace(/\s+$/u, "");
    if (trimmedRight === "") {
      continue;
    }

    const match = /^\s*(\d+)\s*(.*)$/u.exec(trimmedRight);
    if (!match) {
      throw new ToolValidationError(`Expected a line number at the start of line ${lineIndex + 1} of the program: "${rawLine}"`, { path: "$.program" });
    }

    const lineNumber = Number.parseInt(match[1], 10);
    if (!Number.isInteger(lineNumber) || lineNumber < 0 || lineNumber > MAX_LINE_NUMBER) {
      throw new ToolValidationError(`Line number out of range: ${match[1]} on line ${lineIndex + 1} of the program (C64 BASIC accepts 0-${MAX_LINE_NUMBER})`, { path: "$.program" });
    }

    const content = match[2] ?? "";
    if (content === "") {
      programLines.delete(lineNumber);
      continue;
    }
    const tokenised = tokenize(content, lineIndex + 1);
    if (programLines.has(lineNumber) && !replacedLines.includes(lineNumber)) replacedLines.push(lineNumber);
    programLines.set(lineNumber, tokenised);
  }

  const lineBuffers: Buffer[] = [];
  let currentAddress = startAddress;

  for (const lineNumber of [...programLines.keys()].sort((a, b) => a - b)) {
    const tokenised = programLines.get(lineNumber)!;
    const lineLength = 2 + 2 + tokenised.length + 1;
    const nextAddress = currentAddress + lineLength;
    const endLimit = startAddress < BASIC_RAM_END ? BASIC_RAM_END : 0x10000;
    if (nextAddress + 2 > endLimit) {
      throw new ToolValidationError(
        `BASIC program is too large: line ${lineNumber} would end at $${(nextAddress + 2).toString(16).toUpperCase()}, past the end of BASIC memory ($${(endLimit - 1).toString(16).toUpperCase()}) when loaded at $${startAddress.toString(16).toUpperCase()}`,
        { path: "$.program" },
      );
    }

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

  return { prg: Buffer.concat([header, ...lineBuffers, Buffer.from([0x00, 0x00])]), replacedLines };
}

function normalize(input: string): string {
  const unified = input.replace(/\r\n?/g, "\n");
  const withoutTrailingNewlines = unified.replace(/\n+$/u, "");
  return `${withoutTrailingNewlines}\n`;
}

function describeCharacter(char: string): string {
  const codePoint = char.codePointAt(0) ?? 0;
  return `${codePoint < 0x20 ? "control character" : `'${char}'`} (U+${codePoint.toString(16).toUpperCase().padStart(4, "0")})`;
}

/**
 * One source character to its PETSCII byte. `inCode` is true outside strings, REM and DATA,
 * where the pi sign is the BASIC token $FF; elsewhere it is the PETSCII pi glyph $DE.
 * ASCII a-z become the letters $41-$5A (lowercase would be graphics); the pound sign is
 * $5C. Everything else outside printable ASCII is an error naming the line: a raw byte
 * such as NUL would end the line, and "e acute" or curly quotes have no PETSCII letter.
 */
function encodeSourceChar(char: string, lineNumber: number, inCode: boolean): number {
  const code = char.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) {
    return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
  }
  if (char === "\u00a3") return 0x5c;
  if (char === "\u03c0") return inCode ? 0xff : 0xde;
  throw new ToolValidationError(
    `Source line ${lineNumber} contains ${describeCharacter(char)}, which has no PETSCII equivalent in a BASIC program. Use a {name} or {$xx} code in a string, or CHR$(n).`,
    { path: "$.program" },
  );
}

/**
 * Handles "{name}", "{$xx}" and "{nn}" at `index`. Inside a string an unknown name is an
 * error; elsewhere an unknown brace stays literal text. Code 0 is refused: a NUL byte ends
 * a tokenised line. Returns undefined when `{` is not a token candidate.
 */
function encodeBraceToken(text: string, index: number, lineNumber: number, strict: boolean): { value: number; endIndex: number } | undefined {
  const token = parseBraceToken(text, index);
  if (!token) return undefined;
  if (!token.ok) {
    if (!strict) return undefined;
    throw new ToolValidationError(
      `Source line ${lineNumber}: ${token.token} is not a known control code (${token.reason}). Use a name such as {clr}, {red}, {down}, {rvs on}, {f1}, a code such as {$93} or {147}, or CHR$(123) for a literal brace.`,
      { path: "$.program" },
    );
  }
  if (token.value === 0) {
    throw new ToolValidationError(
      `Source line ${lineNumber}: ${text.slice(index, token.endIndex)} would put a NUL byte in the line, which ends the BASIC line; use CHR$(0) in the program instead.`,
      { path: "$.program" },
    );
  }
  return { value: token.value, endIndex: token.endIndex };
}

function tokenize(content: string, lineNumber = 0): Uint8Array {
  // ASCII-only folding keeps every index aligned with content; full Unicode
  // upper-casing changes the length for characters such as the German sharp s.
  const upper = content.replace(/[a-z]/g, (letter) => letter.toUpperCase());
  const bytes: number[] = [];
  let index = 0;
  let inString = false;
  let inRemark = false;
  // As in the ROM CRUNCH routine, DATA items are copied literally until the
  // next ':' outside quotes, and '?' outside strings, REM, and DATA becomes PRINT.
  let inData = false;

  while (index < content.length) {
    if (!inString && !inRemark && !inData) {
      if (upper[index] === "?") {
        bytes.push(PRINT_TOKEN);
        index += 1;
        continue;
      }
      const token = matchToken(upper, index);
      if (token) {
        bytes.push(token.byte);
        index += token.text.length;
        if (token.byte === REM_TOKEN) {
          inRemark = true;
        } else if (token.byte === DATA_TOKEN) {
          inData = true;
        }
        continue;
      }
    }

    // Use code points so characters above U+FFFF are reported whole.
    const char = String.fromCodePoint(content.codePointAt(index)!);

    // Special handling for string literals: encode the inner text in one go
    if (!inRemark && char === '"') {
      bytes.push(0x22);
      inString = !inString;
      index += 1;

      if (inString) {
        // capture until next quote or end of line
        let end = index;
        while (end < content.length && content[end] !== '"') {
          end += 1;
        }
        while (index < end) {
          if (content[index] === "{") {
            const brace = encodeBraceToken(content.slice(0, end), index, lineNumber, true);
            if (brace) {
              bytes.push(brace.value);
              index = brace.endIndex;
              continue;
            }
          }
          const stringChar = String.fromCodePoint(content.codePointAt(index)!);
          bytes.push(encodeSourceChar(stringChar, lineNumber, false));
          index += stringChar.length;
        }
      }
      continue;
    }

    if (char === "{" && !inString) {
      const brace = encodeBraceToken(content, index, lineNumber, false);
      if (brace) {
        bytes.push(brace.value);
        index = brace.endIndex;
        continue;
      }
    }

    // Outside a string a tab is just a space; the other control characters are errors.
    const plainChar = char === "\t" ? " " : char;
    bytes.push(encodeSourceChar(plainChar, lineNumber, !inRemark && !inData));
    if (inData && !inString && plainChar === ":") {
      inData = false;
    }
    index += char.length;
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
    ["DATA", DATA_TOKEN],
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
    ["PRINT", PRINT_TOKEN],
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
