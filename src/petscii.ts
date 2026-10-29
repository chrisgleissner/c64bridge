/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { getChargenGlyphs, type ChargenGlyph } from "./chargen.js";

const PETSCII_TO_ASCII: Record<number, string> = {
  0x00: " ",
  0x07: "\u0007",
  0x0d: "\n",
  0x11: "\n",
  0x8d: "\n",
  0xa0: " ",
};

const SCREEN_CODE_TO_ASCII = new Map<number, string>();
let screenCodeMapInitialised = false;

function isPrintableAscii(char: string | undefined): boolean {
  if (!char || char.length === 0) {
    return false;
  }
  const code = char.charCodeAt(0);
  return code === 0x20 || (code >= 0x21 && code <= 0x7e);
}

function petsciiByteToChar(byte: number): string {
  if (PETSCII_TO_ASCII[byte]) {
    return PETSCII_TO_ASCII[byte];
  }

  if (byte >= 0x20 && byte <= 0x7e) {
    return String.fromCharCode(byte);
  }

  if (byte >= 0xc1 && byte <= 0xda) {
    return String.fromCharCode(byte - 0x80);
  }

  if (byte >= 0x41 && byte <= 0x5a) {
    return String.fromCharCode(byte);
  }

  return " ";
}

export function petsciiToAscii(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(petsciiByteToChar)
    .join("");
}

function deriveGlyphChar(glyph: ChargenGlyph): string {
  if (glyph.basic && glyph.basic.length === 1 && isPrintableAscii(glyph.basic)) {
    return glyph.basic;
  }

  const ascii = petsciiByteToChar(glyph.petsciiCode & 0xff);
  return isPrintableAscii(ascii) ? ascii : " ";
}

function ensureScreenCodeMap(): void {
  if (screenCodeMapInitialised) {
    return;
  }

  for (const glyph of getChargenGlyphs()) {
    const code = glyph.screenCode & 0xff;
    if (SCREEN_CODE_TO_ASCII.has(code)) {
      continue;
    }
    SCREEN_CODE_TO_ASCII.set(code, deriveGlyphChar(glyph));
  }

  screenCodeMapInitialised = true;
}

export interface ScreenAsciiOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly trimTrailingSpaces?: boolean;
  readonly trimTrailingEmptyRows?: boolean;
}

export function screenCodesToAscii(bytes: Uint8Array, options?: ScreenAsciiOptions): string {
  ensureScreenCodeMap();

  const columns = options?.columns && options.columns > 0 ? options.columns : 40;
  const maxRows = options?.rows && options.rows > 0 ? options.rows : undefined;
  const trimSpaces = options?.trimTrailingSpaces !== false;
  const trimEmptyRows = options?.trimTrailingEmptyRows !== false;

  const lines: string[] = [];
  const totalCells = maxRows ? Math.min(bytes.length, columns * maxRows) : bytes.length;

  for (let index = 0; index < totalCells; index += columns) {
    const end = Math.min(index + columns, totalCells);
    if (index >= end) {
      break;
    }

    let line = "";
    for (let idx = index; idx < end; idx += 1) {
      const code = bytes[idx] ?? 0;
      const char = SCREEN_CODE_TO_ASCII.get(code & 0xff) ?? petsciiByteToChar(code & 0xff);
      line += char;
    }

    if (trimSpaces) {
      line = line.replace(/\s+$/, "");
    }

    lines.push(line);
  }

  if (trimEmptyRows) {
    while (lines.length > 0 && lines[lines.length - 1]!.length === 0) {
      lines.pop();
    }
  }

  return lines.join("\n");
}

/**
 * Minimal ASCII→PETSCII mapping used by the encoder.
 * For now we pass through printable ASCII and a handful of control codes.
 */
export function asciiToPetscii(char: string): number {
  if (char.length !== 1) {
    throw new Error("Expected a single character");
  }

  const code = char.charCodeAt(0);
  if (code < 0 || code > 255) {
    throw new Error(`Character out of PETSCII range: ${char}`);
  }

  return code;
}

/** Named PETSCII and control codes that are commonly used on the C64. */
const NAMED_CHARS: Record<string, number> = Object.freeze({
  // Control characters (BASIC CHR$ values)
  "clear": 147, // CLR/HOME (clears screen)
  "clr": 147,
  "home": 19,
  "bell": 7,
  "beep": 7,
  "newline": 13,
  "return": 13,
  "cr": 13,
  "lf": 10,
  "reverse_on": 18,
  "rvon": 18,
  "reverse_off": 146,
  "rvoff": 146,
  "cursor_up": 145,
  "cursor_down": 17,
  "cursor_right": 29,
  "cursor_left": 157,

  // Graphic glyphs (commonly referenced by name)
  // Note: Exact byte shown on screen depends on mode; these are PETSCII/CHR$ values
  "heart": 115, // $73 (shifted S); $51 would print the letter Q
  "up_arrow": 94,
  "uparrow": 94,
  "left_arrow": 95,
  "leftarrow": 95,
  "pi": 222,
});

export function lookupNamedPetscii(name: string): number | undefined {
  const key = name.trim().toLowerCase().replace(/\s+/g, "_");
  // Own keys only, so names like "constructor" don't resolve to Object.prototype members.
  return Object.prototype.hasOwnProperty.call(NAMED_CHARS, key) ? NAMED_CHARS[key] : undefined;
}

/**
 * Try to parse a named character token starting at the given index.
 * Supported forms: {name}, :name:, <name>
 * Returns the PETSCII code and index of the first character AFTER the token
 * when matched, otherwise null.
 */
export function parseNamedCharToken(source: string, startIndex: number): { value: number; endIndex: number } | null {
  const open = source[startIndex];
  if (open !== "{" && open !== ":" && open !== "<") {
    return null;
  }

  const close = open === "{" ? "}" : open === ":" ? ":" : ">";
  const idx = source.indexOf(close, startIndex + 1);
  if (idx < 0) {
    return null;
  }

  // Only sane name characters; anything else is ordinary text that happens to use the delimiters.
  // Multi-word names such as {cursor up} need braces: ":" and "<" also appear in
  // ordinary text ("Mode: reverse on: yes"), so they only delimit single words.
  const name = source.slice(startIndex + 1, idx).trim();
  const namePattern = open === "{" ? /^[A-Za-z0-9_\s-]+$/ : /^[A-Za-z0-9_-]+$/;
  if (!namePattern.test(name)) {
    return null;
  }

  const value = lookupNamedPetscii(name.replace(/[-\s]+/g, "_"));
  if (value === undefined) {
    return null;
  }

  return { value, endIndex: idx + 1 };
}

/**
 * Encode a text containing optional named tokens into PETSCII bytes.
 * Named tokens may appear as {heart}, :heart:, or <heart>.
 */
export function encodeStringWithNames(input: string, options: { foldLowercase?: boolean } = {}): Uint8Array {
  const bytes: number[] = [];
  let i = 0;
  while (i < input.length) {
    const maybe = parseNamedCharToken(input, i);
    if (maybe) {
      bytes.push(maybe.value & 0xff);
      i = maybe.endIndex;
      continue;
    }

    // ASCII a-z are PETSCII graphics characters in the default character set,
    // so callers can fold them to the letters $41-$5A. Named codes are not folded.
    const char = input[i]!;
    bytes.push(asciiToPetscii(options.foldLowercase && char >= "a" && char <= "z" ? char.toUpperCase() : char));
    i += 1;
  }
  return Uint8Array.from(bytes);
}
