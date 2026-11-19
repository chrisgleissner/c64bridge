/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

const PETSCII_TO_ASCII: Record<number, string> = {
  0x00: " ",
  0x07: "\u0007",
  0x0d: "\n",
  0x11: "\n",
  0x8d: "\n",
  0xa0: " ",
};

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

export interface ScreenAsciiOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly trimTrailingSpaces?: boolean;
  readonly trimTrailingEmptyRows?: boolean;
  /**
   * Character set the screen codes are shown in. "upper" (default) is the
   * upper-case/graphics set; "lower" is the lower-case/upper-case set, where
   * screen codes 1-26 are a-z and 65-90 are A-Z.
   */
  readonly charset?: "upper" | "lower";
}

/**
 * Shown for screen codes that are graphics, not text (card suits, lines, blocks, shifted
 * symbols), so a screen full of block graphics does not read as blank. U+2592 never occurs
 * as a C64 text character.
 */
export const SCREEN_GRAPHIC_PLACEHOLDER = "\u2592";

/**
 * Text of one screen code. Screen codes $00-$3F are the same in both character sets
 * (@, A-Z or a-z at 1-26, [ pound ] up-arrow left-arrow at $1B-$1F, then ASCII $20-$3F);
 * the upper-case/graphics set has only graphics at $40-$7F, the lower-case set has
 * upper-case letters at $41-$5A and graphics elsewhere in $40-$7F. Reverse video (+$80)
 * shows the same character. Source: C64 Programmer's Reference Guide appendix B, and
 * data/graphics/character-set.csv (every row maps PETSCII to the screen code by the
 * KERNAL rule in petsciiToScreenCode). The pound sign is shown as a backslash, the arrows
 * as ^ and _ (ASCII approximations, unchanged from earlier versions).
 */
function screenCodeChar(code: number, lowerCase: boolean): string {
  const base = code & 0x7f;
  if (base === 0) return "@";
  if (base <= 26) return String.fromCharCode((lowerCase ? 0x60 : 0x40) + base);
  if (base < 0x40) return String.fromCharCode(base < 0x20 ? 0x40 + base : base);
  if (lowerCase && base >= 0x41 && base <= 0x5a) return String.fromCharCode(base);
  return SCREEN_GRAPHIC_PLACEHOLDER;
}

export function screenCodesToAscii(bytes: Uint8Array, options?: ScreenAsciiOptions): string {
  const columns = options?.columns && options.columns > 0 ? options.columns : 40;
  const maxRows = options?.rows && options.rows > 0 ? options.rows : undefined;
  const trimSpaces = options?.trimTrailingSpaces !== false;
  const trimEmptyRows = options?.trimTrailingEmptyRows !== false;
  const lowerCase = options?.charset === "lower";

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
      line += screenCodeChar(code & 0xff, lowerCase);
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

/**
 * Names accepted by the older ":name:" and "<name>" forms. Kept unchanged so that
 * ordinary text with colons or angle brackets is not turned into control codes;
 * the "{name}" form accepts the full table below.
 */
const LEGACY_NAMES: ReadonlySet<string> = new Set([
  "clear", "clr", "home", "bell", "beep", "newline", "return", "cr", "lf", "reverse_on", "rvon", "reverse_off",
  "rvoff", "cursor_up", "cursor_down", "cursor_right", "cursor_left", "heart", "up_arrow", "uparrow",
  "left_arrow", "leftarrow", "pi",
]);

/**
 * Shared PETSCII control-code table for "{name}", "{$xx}" and "{nn}" in BASIC string
 * text. The first name of every row is the canonical one used when listing a program.
 * Sources: C64 Programmer's Reference Guide, appendix C (PETSCII codes: 5 WHT, 13 RETURN,
 * 14 lower case, 17 CRSR down, 18 RVS ON, 19 HOME, 20 DEL, 28 RED, 29 CRSR right, 30 GRN,
 * 31 BLU, 129 ORANGE, 133-140 F1-F8, 141 SHIFT RETURN, 142 upper case, 144 BLK, 145 CRSR up,
 * 146 RVS OFF, 147 CLR, 148 INST, 149 BROWN, 150 LT RED, 151-152 GREY 1-2, 153 LT GREEN,
 * 154 LT BLUE, 155 GREY 3, 156 PURPLE, 157 CRSR left, 158 YELLOW, 159 CYAN), cross-checked
 * against the independent table in src/tools/input.ts and the petcat names (VICE). Codes
 * 0 is not offered: a NUL ends a tokenised BASIC line. 7 (bell), 10 (lf), 115 (heart),
 * 94/95 (arrows) and 222 (pi) are the older names of this module (115 = SHIFT+S, 222 = pi).
 */
const CONTROL_CODE_ROWS: ReadonlyArray<readonly [number, ReadonlyArray<string>]> = [
  [3, ["stop"]],
  [5, ["wht", "white"]],
  [7, ["bell", "beep"]],
  [10, ["lf"]],
  [13, ["return", "cr", "newline"]],
  [14, ["lowercase", "swlc"]],
  [17, ["down", "cursor_down", "crsr_down"]],
  [18, ["rvs_on", "reverse_on", "rvon"]],
  [19, ["home", "cursor_home"]],
  [20, ["del", "delete"]],
  [28, ["red"]],
  [29, ["right", "cursor_right", "crsr_right"]],
  [30, ["grn", "green"]],
  [31, ["blu", "blue"]],
  [94, ["up_arrow", "uparrow"]],
  [95, ["left_arrow", "leftarrow"]],
  [115, ["heart"]],
  [129, ["org", "orange"]],
  [131, ["run"]],
  [133, ["f1"]],
  [134, ["f3"]],
  [135, ["f5"]],
  [136, ["f7"]],
  [137, ["f2"]],
  [138, ["f4"]],
  [139, ["f6"]],
  [140, ["f8"]],
  [141, ["shift_return"]],
  [142, ["uppercase", "swuc"]],
  [144, ["blk", "black"]],
  [145, ["up", "cursor_up", "crsr_up"]],
  [146, ["rvs_off", "reverse_off", "rvoff"]],
  [147, ["clr", "clear"]],
  [148, ["inst", "ins", "insert"]],
  [149, ["brn", "brown"]],
  [150, ["lred", "light_red"]],
  [151, ["dgry", "dark_grey", "dark_gray", "gry1"]],
  [152, ["mgry", "medium_grey", "medium_gray", "gry2"]],
  [153, ["lgrn", "light_green"]],
  [154, ["lblu", "light_blue"]],
  [155, ["lgry", "light_grey", "light_gray", "gry3"]],
  [156, ["pur", "purple"]],
  [157, ["left", "cursor_left", "crsr_left"]],
  [158, ["yel", "yellow"]],
  [159, ["cyn", "cyan"]],
  [222, ["pi"]],
];

const NAMED_CHARS: ReadonlyMap<string, number> = new Map(
  CONTROL_CODE_ROWS.flatMap(([code, names]) => names.map((name) => [name, code] as const)),
);
const CANONICAL_NAMES: ReadonlyMap<number, string> = new Map(
  CONTROL_CODE_ROWS.map(([code, names]) => [code, names[0]!.replace(/_/g, " ")] as const),
);

/** Canonical brace name for a PETSCII byte (for listings), or undefined. */
export function petsciiControlName(byte: number): string | undefined {
  return CANONICAL_NAMES.get(byte);
}

export function lookupNamedPetscii(name: string): number | undefined {
  const key = name.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return NAMED_CHARS.get(key);
}

export type BraceToken =
  | { readonly ok: true; readonly value: number; readonly endIndex: number }
  | { readonly ok: false; readonly token: string; readonly reason: string; readonly endIndex: number };

/**
 * Parses "{name}", "{$xx}" (hex) or "{nn}" (decimal 0-255) at `startIndex`. Returns null when
 * the text is not a brace token candidate (no closing brace, or characters a token never
 * contains), so ordinary text such as "{" or "{a,b}" stays literal.
 */
export function parseBraceToken(source: string, startIndex: number): BraceToken | null {
  if (source[startIndex] !== "{") return null;
  const close = source.indexOf("}", startIndex + 1);
  if (close < 0) return null;
  const inner = source.slice(startIndex + 1, close).trim();
  if (!/^[A-Za-z0-9_$\s-]+$/.test(inner)) return null;
  const endIndex = close + 1;
  const token = source.slice(startIndex, endIndex);
  const hex = /^\$([0-9a-fA-F]{1,2})$/.exec(inner);
  if (hex) return { ok: true, value: parseInt(hex[1]!, 16), endIndex };
  if (/^[0-9]+$/.test(inner)) {
    const value = Number.parseInt(inner, 10);
    return value <= 255 && inner.length <= 3
      ? { ok: true, value, endIndex }
      : { ok: false, token, reason: "decimal codes are 0-255", endIndex };
  }
  const value = lookupNamedPetscii(inner);
  return value === undefined
    ? { ok: false, token, reason: "unknown control-code name", endIndex }
    : { ok: true, value, endIndex };
}

/**
 * Try to parse a named character token starting at the given index.
 * Supported forms: {name}, :name:, <name>. Only {name} accepts the full control-code
 * table, "{$xx}" and "{nn}"; the colon and angle forms keep the older short list.
 * Returns the PETSCII code and index of the first character AFTER the token
 * when matched, otherwise null.
 */
export function parseNamedCharToken(source: string, startIndex: number): { value: number; endIndex: number } | null {
  const open = source[startIndex];
  if (open === "{") {
    const token = parseBraceToken(source, startIndex);
    return token?.ok ? { value: token.value, endIndex: token.endIndex } : null;
  }
  if (open !== ":" && open !== "<") {
    return null;
  }

  const close = open === ":" ? ":" : ">";
  const idx = source.indexOf(close, startIndex + 1);
  if (idx < 0) {
    return null;
  }

  // Multi-word names need braces: ":" and "<" also appear in ordinary text
  // ("Mode: reverse on: yes"), so they only delimit single words.
  const name = source.slice(startIndex + 1, idx).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return null;
  }
  const key = name.toLowerCase().replace(/-+/g, "_");
  const value = LEGACY_NAMES.has(key) ? NAMED_CHARS.get(key) : undefined;
  return value === undefined ? null : { value, endIndex: idx + 1 };
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

/**
 * PETSCII code to screen code, the rule the KERNAL applies when it prints a character:
 * $20-$3F unchanged, $40-$5F minus $40, $60-$7F minus $20, $A0-$BF minus $40,
 * $C0-$FE minus $80, $FF gives $5E. Control codes ($00-$1F, $80-$9F) have no screen code.
 * Source: C64 Programmer's Reference Guide appendix B/C; verified against all 256 rows
 * of data/graphics/character-set.csv (src/chargen.ts) in test/petscii.test.mjs.
 */
export function petsciiToScreenCode(petscii: number): number | undefined {
  const p = petscii & 0xff;
  if (p < 0x20 || (p >= 0x80 && p < 0xa0)) return undefined;
  if (p < 0x40) return p;
  if (p < 0x60) return p - 0x40;
  if (p < 0x80) return p - 0x20;
  if (p < 0xc0) return p - 0x40;
  if (p < 0xff) return p - 0x80;
  return 0x5e;
}
