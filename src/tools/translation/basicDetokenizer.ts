/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { petsciiControlName } from "../../petscii.js";
import { basicTokenText, tokenizeLineContent } from "./basicTokenizer.js";
import { ToolExecutionError } from "../errors.js";

export interface BasicListingLine {
  readonly number: number;
  readonly text: string;
}

/** Largest program image accepted, matching the 64 KiB address space. */
export const MAX_BASIC_IMAGE_BYTES = 0x10000;

function hex16(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function hexCode(byte: number): string {
  return `{$${byte.toString(16).toUpperCase().padStart(2, "0")}}`;
}

const REM_TOKEN = 0x8f;
const DATA_TOKEN = 0x83;
/** Characters that are tokens on their own outside strings, REM and DATA: + - * / ^ > = < and ? (PRINT). */
const SINGLE_CHARACTER_TOKENS = new Set([0x2b, 0x2d, 0x2a, 0x2f, 0x5e, 0x3e, 0x3d, 0x3c, 0x3f]);

/** Text of a byte that the tokeniser does not read back as itself: its {name} or {$xx}. */
function codeFor(byte: number): string {
  const name = petsciiControlName(byte);
  return name !== undefined ? `{${name}}` : hexCode(byte);
}

/**
 * Lists one tokenised line so that tokenising the text again (basicToPrg) gives the same bytes.
 * The tokeniser folds a-z to $41-$5A, turns "?" into PRINT outside strings, REM and DATA, reads
 * {name}/{$xx} codes, keeps REM and DATA text untokenised and drops spaces at both ends of a line.
 * So:
 *  - outside REM and DATA, token bytes $80-$CB are their keywords and $FF is the pi sign;
 *  - after REM and in DATA (up to the next ":" outside quotes), every byte is text, as the ROM
 *    tokeniser stores it, so a byte that looks like a token is written as a code;
 *  - only $20-$5F are written as themselves; outside strings, REM and DATA the characters that
 *    are tokens on their own (+ - * / ^ > = < ?) are codes too;
 *  - a space at the start or end of the line is written as {$20}.
 * A line that still does not tokenise back to its bytes (letters that spell a keyword but are
 * stored as plain text, which only a hand-made image contains) is listed again with every
 * character outside strings, REM and DATA as a code.
 * Unlike the C64's LIST, a shifted character after REM is not shown as a keyword.
 */
export function detokenizeLine(bytes: Uint8Array): string {
  const text = listLine(bytes, false);
  const again = tokenizeLineContent(text);
  return again !== undefined && again.length === bytes.length && again.every((byte, index) => byte === bytes[index])
    ? text
    : listLine(bytes, true);
}

function listLine(bytes: Uint8Array, escapeCode: boolean): string {
  const parts: string[] = [];
  let mode: "code" | "string" | "rem" | "data" | "dataString" = "code";
  for (const byte of bytes) {
    const literal = byte >= 0x20 && byte <= 0x5f;
    switch (mode) {
      case "code":
        if (byte === 0x22) {
          mode = "string";
          parts.push('"');
        } else if (byte >= 0x80 && byte <= 0xcb) {
          parts.push(basicTokenText(byte) ?? codeFor(byte));
          if (byte === REM_TOKEN) mode = "rem";
          else if (byte === DATA_TOKEN) mode = "data";
        } else if (byte === 0xff) {
          parts.push("\u03c0");
        } else {
          parts.push(literal && !escapeCode && !SINGLE_CHARACTER_TOKENS.has(byte) ? String.fromCharCode(byte) : codeFor(byte));
        }
        break;
      case "string":
      case "dataString":
        if (byte === 0x22) mode = mode === "string" ? "code" : "data";
        parts.push(literal ? String.fromCharCode(byte) : codeFor(byte));
        break;
      case "data":
        if (byte === 0x22) mode = "dataString";
        else if (byte === 0x3a) mode = "code";
        parts.push(literal ? String.fromCharCode(byte) : codeFor(byte));
        break;
      case "rem":
        parts.push(literal ? String.fromCharCode(byte) : codeFor(byte));
        break;
    }
  }
  if (bytes[0] === 0x20) parts[0] = "{$20}";
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0x20) parts[parts.length - 1] = "{$20}";
  return parts.join("");
}

/**
 * Walks the link pointers of a tokenised BASIC program held in `image`, which
 * starts at memory address `base`. Throws when a link does not move forward or
 * leaves the image, so a corrupt program cannot loop, and when the image ends
 * without the 00 00 terminator, which is returned as corruption metadata.
 */
export function listBasicProgram(image: Uint8Array, base: number): { lines: BasicListingLine[]; corrupt?: { address: string; message: string } } {
  if (image.length > MAX_BASIC_IMAGE_BYTES) {
    throw new ToolExecutionError("BASIC program image is larger than 64 KiB", { details: { length: image.length } });
  }
  const lines: BasicListingLine[] = [];
  let offset = 0;
  while (offset + 2 <= image.length) {
    const link = image[offset]! | (image[offset + 1]! << 8);
    if (link === 0) return { lines };
    const linkOffset = link - base;
    const address = hex16(base + offset);
    if (linkOffset <= offset + 4) {
      throw new ToolExecutionError(`Corrupt BASIC link at ${address}: link ${hex16(link)} does not point past the line`, {
        details: { address, link },
      });
    }
    if (linkOffset > image.length) {
      throw new ToolExecutionError(`Corrupt BASIC link at ${address}: link ${hex16(link)} is outside the program area`, {
        details: { address, link },
      });
    }
    const number = image[offset + 2]! | (image[offset + 3]! << 8);
    let end = offset + 4;
    while (end < linkOffset && image[end] !== 0) end += 1;
    if (end >= linkOffset) {
      throw new ToolExecutionError(`Corrupt BASIC line ${number} at ${address}: no end-of-line byte before the next link`, {
        details: { address, number },
      });
    }
    lines.push({ number, text: detokenizeLine(image.subarray(offset + 4, end)) });
    offset = linkOffset;
  }
  // The loop only ends here when the last link pointed at the end of the image, so the 00 00 terminator is absent.
  const address = hex16(base + offset);
  return { lines, corrupt: { address, message: `BASIC program has no 00 00 terminator after the last line at ${address}; the lines parsed so far are returned` } };
}
