/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { petsciiToAscii } from "../../petscii.js";
import { basicTokenText } from "./basicTokenizer.js";
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

function plainChar(byte: number): string {
  if (byte === 0x20 || byte === 0xa0) return " ";
  const ch = petsciiToAscii(Uint8Array.of(byte));
  return ch.length === 1 && ch > " " && ch <= "~" ? ch : `{$${byte.toString(16).toUpperCase().padStart(2, "0")}}`;
}

/** Expands tokens outside quotes like LIST; quoted text is never detokenised. */
export function detokenizeLine(bytes: Uint8Array): string {
  let out = "";
  let inString = false;
  for (const byte of bytes) {
    if (byte === 0x22) {
      inString = !inString;
      out += '"';
      continue;
    }
    if (!inString && byte >= 0x80) {
      out += basicTokenText(byte) ?? plainChar(byte);
      continue;
    }
    out += plainChar(byte);
  }
  return out;
}

/**
 * Walks the link pointers of a tokenised BASIC program held in `image`, which
 * starts at memory address `base`. Throws when a link does not move forward or
 * leaves the image, so a corrupt program cannot loop.
 */
export function listBasicProgram(image: Uint8Array, base: number): BasicListingLine[] {
  if (image.length > MAX_BASIC_IMAGE_BYTES) {
    throw new ToolExecutionError("BASIC program image is larger than 64 KiB", { details: { length: image.length } });
  }
  const lines: BasicListingLine[] = [];
  let offset = 0;
  while (offset + 2 <= image.length) {
    const link = image[offset]! | (image[offset + 1]! << 8);
    if (link === 0) return lines;
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
  return lines;
}
