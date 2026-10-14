/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { ChargenGlyph, findGlyphByBasicChar, getChargenGlyphs } from "./chargen.js";

export interface Bitmap {
  width: number;
  height: number;
  pixels: Uint8Array; // row-major, values 0 (white) or 1 (black)
}

export interface CreatePetsciiArtOptions {
  prompt?: string;
  text?: string;
  maxWidth?: number;
  maxHeight?: number;
  borderColor?: number;
  backgroundColor?: number;
  foregroundColor?: number;
  bitmap?: Bitmap;
}

export interface PetsciiArtResult {
  program: string;
  bitmap: Bitmap;
  bitmapHex: string;
  rowHex: string[];
  charColumns: number;
  charRows: number;
  petsciiCodes: number[];
  glyphs: ChargenGlyph[];
  sourceText?: string;
  usedShape?: string;
}

const POPCOUNT = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    let count = 0;
    let value = i;
    while (value) {
      value &= value - 1;
      count += 1;
    }
    table[i] = count;
  }
  return table;
})();

const RVS_ON = 18;
const RVS_OFF = 146;
// Marks the end of a character row in the generated DATA statements.
const ROW_END = -1;

const SCREEN_COLUMNS = 40;
const DEFAULT_MAX_WIDTH = 320;
const DEFAULT_MAX_HEIGHT = 200;

const SHAPES: Array<{ keywords: RegExp; name: string; pattern: string[] }> = [
  {
    name: "heart",
    keywords: /\b(heart|love)\b/i,
    pattern: [
      "0011110000111100",
      "0111111001111110",
      "1111111111111111",
      "1111111111111111",
      "1111111111111111",
      "0111111111111110",
      "0011111111111100",
      "0001111111111000",
      "0000111111110000",
      "0000011111100000",
      "0000001111000000",
      "0000000110000000",
      "0000000100000000",
    ],
  },
  {
    name: "smiley",
    keywords: /\b(face|smile|smiley|happy)\b/i,
    pattern: [
      "0000011111100000",
      "0001111111110000",
      "0011111111111000",
      "0111100000011100",
      "0111001100111100",
      "1110011111001110",
      "1110011111001110",
      "1110011111001110",
      "1110011111001110",
      "1110011111001110",
      "1110011111001110",
      "1110000000001110",
      "0111000000001110",
      "0111110000111110",
      "0011111111111100",
      "0001111111111000",
      "0000011111100000",
    ],
  },
  {
    name: "star",
    keywords: /\b(star|sparkle)\b/i,
    pattern: [
      "0000001110000000",
      "0000011111000000",
      "0000111111100000",
      "0001111111110000",
      "1111111111111111",
      "0011111111111000",
      "0001111111110000",
      "0000111111100000",
      "0000011111000000",
      "0000001110000000",
    ],
  },
];

export function bitmapToHexRows(bitmap: Bitmap): string[] {
  const rows: string[] = [];
  for (let y = 0; y < bitmap.height; y += 1) {
    let nibbleValue = 0;
    let nibbleSize = 0;
    let hexRow = "";
    for (let x = 0; x < bitmap.width; x += 1) {
      const pixel = bitmap.pixels[y * bitmap.width + x] ?? 0;
      nibbleValue = (nibbleValue << 1) | (pixel ? 1 : 0);
      nibbleSize += 1;
      if (nibbleSize === 4) {
        hexRow += nibbleValue.toString(16);
        nibbleValue = 0;
        nibbleSize = 0;
      }
    }
    if (nibbleSize > 0) {
      const shift = 4 - nibbleSize;
      hexRow += ((nibbleValue << shift) & 0xf).toString(16);
    }
    rows.push(hexRow);
  }
  return rows;
}

function detectShape(prompt?: string): { name: string; bitmap: Bitmap } | undefined {
  if (!prompt) {
    return undefined;
  }
  for (const shape of SHAPES) {
    if (shape.keywords.test(prompt)) {
      return { name: shape.name, bitmap: patternToBitmap(shape.pattern) };
    }
  }
  return undefined;
}

function patternToBitmap(pattern: string[]): Bitmap {
  const height = pattern.length;
  const width = pattern.reduce((max, row) => Math.max(max, row.length), 0);
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = pattern[y] ?? "";
    for (let x = 0; x < width; x += 1) {
      const ch = row[x] ?? "0";
      const bit = ch === "1" || ch === "#" || ch === "X" || ch === "@";
      pixels[y * width + x] = bit ? 1 : 0;
    }
  }
  return { width, height, pixels };
}

function deriveText(options: CreatePetsciiArtOptions): { text: string; sourceText?: string } {
  if (options.text && options.text.trim().length > 0) {
    return { text: options.text.trim(), sourceText: options.text.trim() };
  }

  const prompt = options.prompt?.trim();
  if (!prompt || prompt.length === 0) {
    throw new Error("Expected either prompt or text to describe the image");
  }

  const quoted = prompt.match(/"([^"]+)"/);
  if (quoted?.[1]) {
    return { text: quoted[1].trim(), sourceText: quoted[1].trim() };
  }

  const backtick = prompt.match(/`([^`]+)`/);
  if (backtick?.[1]) {
    return { text: backtick[1].trim(), sourceText: backtick[1].trim() };
  }

  const short = prompt.length <= 40 ? prompt : prompt.slice(0, 40);
  return { text: short.trim(), sourceText: short.trim() };
}

function wrapTextLines(source: string, maxCols: number, maxRows: number): string[] {
  const lines: string[] = [];
  const rawLines = source.split(/\r?\n/);

  for (const rawLine of rawLines) {
    let line = rawLine.trim();
    if (line.length === 0) {
      if (lines.length < maxRows) {
        lines.push("");
      }
      continue;
    }

    line = line.replace(/\s+/g, " ");
    while (line.length > 0 && lines.length < maxRows) {
      if (line.length <= maxCols) {
        lines.push(line);
        line = "";
      } else {
        // Try to break on whitespace
        let breakIndex = line.lastIndexOf(" ", maxCols);
        if (breakIndex <= 0) {
          breakIndex = maxCols;
        }
        const chunk = line.slice(0, breakIndex);
        lines.push(chunk.trim());
        line = line.slice(breakIndex).trim();
      }
    }
    if (lines.length >= maxRows) {
      break;
    }
  }

  if (lines.length === 0) {
    lines.push("");
  }
  return lines;
}

function renderTextToBitmap(text: string, options: { maxWidth: number; maxHeight: number }): Bitmap {
  const maxCols = Math.max(1, Math.min(40, Math.floor(options.maxWidth / 8)));
  const maxRows = Math.max(1, Math.min(25, Math.floor(options.maxHeight / 8)));

  const lines = wrapTextLines(text, maxCols, maxRows);
  const glyphs = getChargenGlyphs();
  const spaceGlyph = findGlyphByBasicChar(" ") ?? glyphs.find((g) => g.petsciiCode === 32);
  const questionGlyph = findGlyphByBasicChar("?") ?? spaceGlyph;

  const maxLineLength = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const width = Math.max(1, Math.min(options.maxWidth, maxLineLength * 8));
  const height = Math.max(1, Math.min(options.maxHeight, lines.length * 8));
  const pixels = new Uint8Array(width * height);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const char = line[charIndex]!;
      const glyph = findGlyphByBasicChar(char) ?? findGlyphByBasicChar(char.toUpperCase())
        ?? findGlyphByBasicChar(char.toLowerCase()) ?? questionGlyph ?? spaceGlyph;
      if (!glyph) {
        continue;
      }
      for (let row = 0; row < 8; row += 1) {
        const glyphRow = glyph.bitmap[row] ?? 0;
        for (let col = 0; col < 8; col += 1) {
          const bit = (glyphRow >> (7 - col)) & 0x1;
          const x = charIndex * 8 + col;
          const y = lineIndex * 8 + row;
          if (x >= width || y >= height) {
            continue;
          }
          pixels[y * width + x] = bit;
        }
      }
    }
  }

  return { width, height, pixels };
}

function splitIntoBlocks(bitmap: Bitmap): { blocks: Uint8Array[]; columns: number; rows: number } {
  const columns = Math.max(1, Math.ceil(bitmap.width / 8));
  const rows = Math.max(1, Math.ceil(bitmap.height / 8));
  const blocks: Uint8Array[] = [];

  for (let rowBlock = 0; rowBlock < rows; rowBlock += 1) {
    for (let colBlock = 0; colBlock < columns; colBlock += 1) {
      const block = new Uint8Array(8);
      for (let localRow = 0; localRow < 8; localRow += 1) {
        let value = 0;
        for (let localCol = 0; localCol < 8; localCol += 1) {
          const x = colBlock * 8 + localCol;
          const y = rowBlock * 8 + localRow;
          value = (value << 1) | (x < bitmap.width && y < bitmap.height ? (bitmap.pixels[y * bitmap.width + x] ?? 0) : 0);
        }
        block[localRow] = value & 0xff;
      }
      blocks.push(block);
    }
  }

  return { blocks, columns, rows };
}

function distanceBetween(block: Uint8Array, glyph: ChargenGlyph): number {
  let score = 0;
  for (let i = 0; i < 8; i += 1) {
    const blockRow = block[i] ?? 0;
    const glyphRow = glyph.bitmap[i] ?? 0;
    score += POPCOUNT[blockRow ^ glyphRow];
  }
  return score;
}

/**
 * Match each 8x8 block to a glyph. `glyphs` has one entry per cell; `codes` is the
 * PETSCII stream that prints them, with each run of reverse-video glyphs (screen
 * codes $80-$FF) wrapped in RVS ON/RVS OFF. `rowCodes` holds that stream per row.
 */
export function bitmapToPetsciiCodes(bitmap: Bitmap): {
  codes: number[];
  rowCodes: number[][];
  glyphs: ChargenGlyph[];
  columns: number;
  rows: number;
} {
  const { blocks, columns, rows } = splitIntoBlocks(bitmap);
  const glyphs = getChargenGlyphs();
  const matchedGlyphs: ChargenGlyph[] = [];

  for (const block of blocks) {
    let bestMatch: ChargenGlyph | undefined;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const glyph of glyphs) {
      const score = distanceBetween(block, glyph);
      if (score < bestScore) {
        bestScore = score;
        bestMatch = glyph;
        if (score === 0) {
          break;
        }
      }
    }

    matchedGlyphs.push(bestMatch ?? glyphs[0]!);
  }

  const rowCodes: number[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const stream: number[] = [];
    let reverse = false;
    for (const glyph of matchedGlyphs.slice(row * columns, (row + 1) * columns)) {
      const glyphReverse = (glyph.screenCode & 0x80) !== 0;
      if (glyphReverse !== reverse) {
        stream.push(glyphReverse ? RVS_ON : RVS_OFF);
        reverse = glyphReverse;
      }
      stream.push(glyph.petsciiCode);
    }
    if (reverse) {
      stream.push(RVS_OFF);
    }
    rowCodes.push(stream);
  }

  return { codes: rowCodes.flat(), rowCodes, glyphs: matchedGlyphs, columns, rows };
}

function buildBasicProgram(params: {
  rowCodes: number[][];
  columns: number;
  rows: number;
  borderColor?: number;
  backgroundColor?: number;
  foregroundColor?: number;
}): string {
  const lines: string[] = [];
  let lineNumber = 10;
  const border = Number.isFinite(params.borderColor) ? Number(params.borderColor) & 0xff : 6;
  const background = Number.isFinite(params.backgroundColor) ? Number(params.backgroundColor) & 0xff : 0;

  lines.push(`${lineNumber} POKE 53280,${border}:POKE 53281,${background}:PRINT CHR$(147)`);
  lineNumber += 10;

  if (Number.isFinite(params.foregroundColor)) {
    const fg = Number(params.foregroundColor) & 0xff;
    lines.push(`${lineNumber} POKE 646,${fg}`);
    lineNumber += 10;
  }

  // Rows vary in length because of the RVS ON/OFF codes, so each row's DATA ends with ROW_END.
  lines.push(`${lineNumber} FORY=0TO${Math.max(0, params.rows - 1)}`);
  lineNumber += 10;
  const readLine = lineNumber;
  // POKE212,0 clears quote mode: after a printed '"' glyph the editor would
  // otherwise draw the following RVS ON/OFF codes as characters.
  lines.push(`${readLine} READC:IFC>=0THENPRINT CHR$(C);:POKE212,0:GOTO${readLine}`);
  lineNumber += 10;
  // A full 40-column row already wraps the cursor; an extra PRINT would leave a blank line.
  lines.push(params.columns >= SCREEN_COLUMNS ? `${lineNumber} NEXTY` : `${lineNumber} PRINT:NEXTY`);
  lineNumber += 10;

  const data = params.rowCodes.flatMap((row) => [...row, ROW_END]);
  const chunkSize = 16;
  for (let i = 0; i < data.length; i += chunkSize) {
    const slice = data.slice(i, i + chunkSize);
    const dataLine = slice.join(",");
    lines.push(`${lineNumber} DATA ${dataLine}`);
    lineNumber += 10;
  }

  lines.push(`${lineNumber} END`);
  return lines.join("\n");
}

export function createPetsciiArt(options: CreatePetsciiArtOptions): PetsciiArtResult {
  const maxWidth = Math.max(1, Math.min(DEFAULT_MAX_WIDTH, options.maxWidth ?? DEFAULT_MAX_WIDTH));
  const maxHeight = Math.max(1, Math.min(DEFAULT_MAX_HEIGHT, options.maxHeight ?? DEFAULT_MAX_HEIGHT));

  let bitmap: Bitmap;
  let usedShape: string | undefined;
  let sourceText: string | undefined;

  if (options.bitmap) {
    bitmap = options.bitmap;
  } else {
    const detectedShape = detectShape(options.prompt);
    if (detectedShape) {
      bitmap = detectedShape.bitmap;
      usedShape = detectedShape.name;
    } else {
      const derived = deriveText(options);
      sourceText = derived.sourceText;
      bitmap = renderTextToBitmap(derived.text, { maxWidth, maxHeight });
    }
  }

  const rowHex = bitmapToHexRows(bitmap);
  const bitmapHex = rowHex.join("");
  const converted = bitmapToPetsciiCodes(bitmap);
  const codes = converted.codes;

  const program = buildBasicProgram({
    rowCodes: converted.rowCodes,
    columns: converted.columns,
    rows: converted.rows,
    borderColor: options.borderColor,
    backgroundColor: options.backgroundColor,
    foregroundColor: options.foregroundColor,
  });

  return {
    program,
    bitmap,
    bitmapHex,
    rowHex,
    charColumns: converted.columns,
    charRows: converted.rows,
    petsciiCodes: codes,
    glyphs: converted.glyphs,
    sourceText,
    usedShape,
  };
}
