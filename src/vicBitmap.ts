import { Jimp } from "jimp";

export type VicBitmapMode = "hires" | "multicolor";

export interface RgbaImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface BitmapImportOptions {
  readonly imagePath: string;
  readonly mode: VicBitmapMode;
  readonly preserveAspect?: boolean;
  readonly backgroundColor?: number;
  readonly borderColor?: number;
}

export interface PreparedVicBitmap {
  readonly mode: VicBitmapMode;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly backgroundColor: number;
  readonly borderColor: number;
  readonly bitmapData: Uint8Array;
  readonly screenRam: Uint8Array;
  readonly colorRam: Uint8Array;
}

export interface VicBitmapMemoryLayout {
  readonly bank: number;
  readonly bankBase: number;
  readonly bitmapAddress: number;
  readonly screenAddress: number;
  readonly colorRamAddress: number;
  readonly d018: number;
}

export interface VicBitmapRegisters {
  readonly dd00: number;
  readonly d011: number;
  readonly d016: number;
  readonly d018: number;
  readonly d020: number;
  readonly d021: number;
}

interface JimpBitmapLike {
  readonly bitmap: {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8Array | Buffer;
  };
  clone(): JimpBitmapLike;
  resize(options: { w: number; h: number }): JimpBitmapLike;
  composite(source: JimpBitmapLike, x: number, y: number): JimpBitmapLike;
}

const VIC_BANK_SIZE = 0x4000;
const BITMAP_BYTE_LENGTH = 8000;
const SCREEN_RAM_BYTE_LENGTH = 1000;
const COLOR_RAM_BYTE_LENGTH = 1000;
const COLOR_RAM_ADDRESS = 0xD800;
const CHAR_ROM_SHADOW_OFFSET = 0x1000;
const CHAR_ROM_SHADOW_LENGTH = 0x1000;

const VIC_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0x00, 0x00, 0x00],
  [0xFF, 0xFF, 0xFF],
  [0x81, 0x33, 0x38],
  [0x75, 0xCE, 0xC8],
  [0x8E, 0x3C, 0x97],
  [0x56, 0xAC, 0x4D],
  [0x2E, 0x2C, 0x9B],
  [0xED, 0xF1, 0x71],
  [0x8E, 0x50, 0x29],
  [0x55, 0x38, 0x00],
  [0xC4, 0x6C, 0x71],
  [0x4A, 0x4A, 0x4A],
  [0x7B, 0x7B, 0x7B],
  [0xA9, 0xFF, 0x9F],
  [0x70, 0x6D, 0xEB],
  [0xB2, 0xB2, 0xB2],
];

export async function importImageAsVicBitmap(options: BitmapImportOptions): Promise<PreparedVicBitmap> {
  const image = await Jimp.read(options.imagePath);
  const sourceWidth = image.bitmap.width;
  const sourceHeight = image.bitmap.height;
  const logicalWidth = options.mode === "multicolor" ? 160 : 320;
  const logicalHeight = 200;
  const backgroundColor = normaliseColorIndex(options.backgroundColor ?? 0);
  const borderColor = normaliseColorIndex(options.borderColor ?? backgroundColor);
  const rgba = await renderImageToLogicalCanvas(image, {
    width: logicalWidth,
    height: logicalHeight,
    preserveAspect: options.preserveAspect !== false,
    backgroundColor,
  });

  const prepared = convertRgbaToVicBitmap(rgba, {
    mode: options.mode,
    backgroundColor,
    borderColor,
  });

  return {
    ...prepared,
    sourceWidth,
    sourceHeight,
  };
}

export function convertRgbaToVicBitmap(
  image: RgbaImageData,
  options: {
    readonly mode: VicBitmapMode;
    readonly backgroundColor?: number;
    readonly borderColor?: number;
  },
): PreparedVicBitmap {
  if (image.width <= 0 || image.height <= 0) {
    throw new Error("Bitmap image must have positive dimensions");
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error("RGBA image buffer length must equal width * height * 4");
  }

  const backgroundColor = normaliseColorIndex(options.backgroundColor ?? 0);
  const borderColor = normaliseColorIndex(options.borderColor ?? backgroundColor);
  const quantized = quantizeRgbaImage(image, backgroundColor);

  return options.mode === "multicolor"
    ? convertMulticolorBitmap(quantized, backgroundColor, borderColor)
    : convertHiresBitmap(quantized, backgroundColor, borderColor);
}

export function resolveVicBitmapMemoryLayout(
  bitmapAddress = 0x2000,
  screenAddress = 0x0400,
): VicBitmapMemoryLayout {
  validateAddress(bitmapAddress, BITMAP_BYTE_LENGTH, "bitmapAddress");
  validateAddress(screenAddress, SCREEN_RAM_BYTE_LENGTH, "screenAddress");

  const bank = Math.floor(bitmapAddress / VIC_BANK_SIZE);
  const bankBase = bank * VIC_BANK_SIZE;
  if (Math.floor(screenAddress / VIC_BANK_SIZE) !== bank) {
    throw new Error("Bitmap RAM and screen RAM must be within the same 16 KB VIC bank");
  }

  const bitmapOffset = bitmapAddress - bankBase;
  const screenOffset = screenAddress - bankBase;
  if (bitmapOffset !== 0x0000 && bitmapOffset !== 0x2000) {
    throw new Error("Bitmap RAM must be aligned to $0000 or $2000 within the selected VIC bank");
  }
  if (screenOffset % 0x0400 !== 0) {
    throw new Error("Screen RAM must be aligned to a 1 KB boundary within the selected VIC bank");
  }
  if (screenOffset > 0x3C00) {
    throw new Error("Screen RAM must fit entirely inside the selected VIC bank");
  }
  if (rangesOverlap(bitmapAddress, BITMAP_BYTE_LENGTH, screenAddress, SCREEN_RAM_BYTE_LENGTH)) {
    throw new Error("Bitmap RAM and screen RAM must not overlap");
  }
  // In banks 0 and 2 the VIC reads the character ROM, not RAM, at bank offsets $1000-$1FFF.
  if (bank === 0 || bank === 2) {
    const shadowStart = bankBase + CHAR_ROM_SHADOW_OFFSET;
    const shadowRange = `$${formatHex(shadowStart)}-$${formatHex(shadowStart + CHAR_ROM_SHADOW_LENGTH - 1)}`;
    if (rangesOverlap(bitmapOffset, BITMAP_BYTE_LENGTH, CHAR_ROM_SHADOW_OFFSET, CHAR_ROM_SHADOW_LENGTH)) {
      throw new Error(`Bitmap RAM must not overlap the character ROM shadow at ${shadowRange} in VIC bank ${bank}`);
    }
    if (rangesOverlap(screenOffset, SCREEN_RAM_BYTE_LENGTH, CHAR_ROM_SHADOW_OFFSET, CHAR_ROM_SHADOW_LENGTH)) {
      throw new Error(`Screen RAM must not overlap the character ROM shadow at ${shadowRange} in VIC bank ${bank}`);
    }
  }

  const screenNibble = ((screenOffset / 0x0400) & 0x0F) << 4;
  const bitmapBit = bitmapOffset === 0x2000 ? 0x08 : 0x00;
  return {
    bank,
    bankBase,
    bitmapAddress,
    screenAddress,
    colorRamAddress: COLOR_RAM_ADDRESS,
    d018: screenNibble | bitmapBit,
  };
}

export function buildVicBitmapRegisters(
  layout: VicBitmapMemoryLayout,
  options: {
    readonly mode: VicBitmapMode;
    readonly backgroundColor?: number;
    readonly borderColor?: number;
    readonly currentDd00?: number;
  },
): VicBitmapRegisters {
  const backgroundColor = normaliseColorIndex(options.backgroundColor ?? 0);
  const borderColor = normaliseColorIndex(options.borderColor ?? backgroundColor);
  const bankBits = (~layout.bank) & 0x03;
  return {
    dd00: ((options.currentDd00 ?? 0) & 0xFC) | bankBits,
    d011: 0x3B,
    d016: options.mode === "multicolor" ? 0x18 : 0x08,
    d018: layout.d018,
    d020: borderColor,
    d021: backgroundColor,
  };
}

async function renderImageToLogicalCanvas(
  image: JimpBitmapLike,
  options: { readonly width: number; readonly height: number; readonly preserveAspect: boolean; readonly backgroundColor: number },
): Promise<RgbaImageData> {
  const background = paletteColorToJimp(normaliseColorIndex(options.backgroundColor));
  if (!options.preserveAspect) {
    const stretched = image.clone().resize({ w: options.width, h: options.height });
    return {
      width: stretched.bitmap.width,
      height: stretched.bitmap.height,
      data: Uint8Array.from(stretched.bitmap.data),
    };
  }

  const scale = Math.min(options.width / image.bitmap.width, options.height / image.bitmap.height);
  const renderWidth = Math.max(1, Math.round(image.bitmap.width * scale));
  const renderHeight = Math.max(1, Math.round(image.bitmap.height * scale));
  const resized = image.clone().resize({ w: renderWidth, h: renderHeight });
  const canvas = new Jimp({ width: options.width, height: options.height, color: background });
  const offsetX = Math.floor((options.width - renderWidth) / 2);
  const offsetY = Math.floor((options.height - renderHeight) / 2);
  canvas.composite(resized, offsetX, offsetY);
  return {
    width: canvas.bitmap.width,
    height: canvas.bitmap.height,
    data: Uint8Array.from(canvas.bitmap.data),
  };
}

function quantizeRgbaImage(image: RgbaImageData, transparentColor: number): Uint8Array {
  const quantized = new Uint8Array(image.width * image.height);
  for (let index = 0; index < quantized.length; index += 1) {
    const offset = index * 4;
    const r = image.data[offset] ?? 0;
    const g = image.data[offset + 1] ?? 0;
    const b = image.data[offset + 2] ?? 0;
    const a = image.data[offset + 3] ?? 0xFF;
    quantized[index] = a < 64 ? transparentColor : nearestPaletteIndex(r, g, b);
  }
  return quantized;
}

function convertHiresBitmap(
  quantized: Uint8Array,
  backgroundColor: number,
  borderColor: number,
): PreparedVicBitmap {
  if (quantized.length !== 320 * 200) {
    throw new Error("Hi-res bitmap conversion requires a 320x200 logical image");
  }
  const bitmapData = new Uint8Array(BITMAP_BYTE_LENGTH);
  const screenRam = new Uint8Array(SCREEN_RAM_BYTE_LENGTH);
  const colorRam = new Uint8Array(COLOR_RAM_BYTE_LENGTH);

  for (let cellY = 0; cellY < 25; cellY += 1) {
    for (let cellX = 0; cellX < 40; cellX += 1) {
      const cellIndex = (cellY * 40) + cellX;
      const [background, foreground] = pickDominantColors(quantized, 320, cellX * 8, cellY * 8, 8, 8, 2);
      screenRam[cellIndex] = ((foreground & 0x0F) << 4) | (background & 0x0F);
      colorRam[cellIndex] = backgroundColor & 0x0F;

      for (let row = 0; row < 8; row += 1) {
        let byte = 0;
        for (let col = 0; col < 8; col += 1) {
          const pixelIndex = ((cellY * 8 + row) * 320) + (cellX * 8 + col);
          const pixelColor = quantized[pixelIndex] ?? background;
          const bit = chooseNearestCandidate(pixelColor, [background, foreground]) === foreground ? 1 : 0;
          byte = (byte << 1) | bit;
        }
        bitmapData[(cellIndex * 8) + row] = byte;
      }
    }
  }

  return {
    mode: "hires",
    sourceWidth: 320,
    sourceHeight: 200,
    logicalWidth: 320,
    logicalHeight: 200,
    displayWidth: 320,
    displayHeight: 200,
    backgroundColor,
    borderColor,
    bitmapData,
    screenRam,
    colorRam,
  };
}

function convertMulticolorBitmap(
  quantized: Uint8Array,
  backgroundColor: number,
  borderColor: number,
): PreparedVicBitmap {
  if (quantized.length !== 160 * 200) {
    throw new Error("Multicolor bitmap conversion requires a 160x200 logical image");
  }
  const bitmapData = new Uint8Array(BITMAP_BYTE_LENGTH);
  const screenRam = new Uint8Array(SCREEN_RAM_BYTE_LENGTH);
  const colorRam = new Uint8Array(COLOR_RAM_BYTE_LENGTH);

  for (let cellY = 0; cellY < 25; cellY += 1) {
    for (let cellX = 0; cellX < 40; cellX += 1) {
      const cellIndex = (cellY * 40) + cellX;
      const selected = fillMissingColors(
        pickDominantColors(quantized, 160, cellX * 4, cellY * 8, 4, 8, 3, backgroundColor),
        backgroundColor,
      );
      const color01 = selected[0];
      const color10 = selected[1];
      const color11 = selected[2];
      screenRam[cellIndex] = ((color01 & 0x0F) << 4) | (color10 & 0x0F);
      colorRam[cellIndex] = color11 & 0x0F;

      for (let row = 0; row < 8; row += 1) {
        let byte = 0;
        for (let col = 0; col < 4; col += 1) {
          const pixelIndex = ((cellY * 8 + row) * 160) + (cellX * 4 + col);
          const pixelColor = quantized[pixelIndex] ?? backgroundColor;
          const nearest = chooseNearestCandidate(pixelColor, [backgroundColor, color01, color10, color11]);
          const code = nearest === color01 ? 0x01 : nearest === color10 ? 0x02 : nearest === color11 ? 0x03 : 0x00;
          byte = (byte << 2) | code;
        }
        bitmapData[(cellIndex * 8) + row] = byte;
      }
    }
  }

  return {
    mode: "multicolor",
    sourceWidth: 160,
    sourceHeight: 200,
    logicalWidth: 160,
    logicalHeight: 200,
    displayWidth: 320,
    displayHeight: 200,
    backgroundColor,
    borderColor,
    bitmapData,
    screenRam,
    colorRam,
  };
}

function pickDominantColors(
  quantized: Uint8Array,
  stride: number,
  startX: number,
  startY: number,
  width: number,
  height: number,
  count: number,
  excludedColor?: number,
): number[] {
  const counts = new Uint32Array(16);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = quantized[((startY + y) * stride) + startX + x] ?? 0;
      if (color === excludedColor) {
        continue;
      }
      counts[color] += 1;
    }
  }

  const ranked = Array.from({ length: 16 }, (_, color) => color)
    .filter((color) => counts[color] > 0)
    .sort((left, right) => {
      const countDiff = counts[right] - counts[left];
      return countDiff !== 0 ? countDiff : left - right;
    });

  if (excludedColor === undefined && ranked.length === 1) {
    ranked.push(ranked[0]);
  }

  return ranked.slice(0, count);
}

function fillMissingColors(colors: number[], fallback: number): [number, number, number] {
  const values = [...colors];
  while (values.length < 3) {
    values.push(fallback);
  }
  return [values[0] ?? fallback, values[1] ?? fallback, values[2] ?? fallback];
}

function chooseNearestCandidate(color: number, candidates: readonly number[]): number {
  let best = candidates[0] ?? 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = paletteDistance(color, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function nearestPaletteIndex(red: number, green: number, blue: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < VIC_PALETTE.length; index += 1) {
    const [candidateRed, candidateGreen, candidateBlue] = VIC_PALETTE[index];
    const distance = squaredDistance(red, green, blue, candidateRed, candidateGreen, candidateBlue);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

function paletteDistance(left: number, right: number): number {
  const [leftRed, leftGreen, leftBlue] = VIC_PALETTE[left] ?? VIC_PALETTE[0];
  const [rightRed, rightGreen, rightBlue] = VIC_PALETTE[right] ?? VIC_PALETTE[0];
  return squaredDistance(leftRed, leftGreen, leftBlue, rightRed, rightGreen, rightBlue);
}

function squaredDistance(
  leftRed: number,
  leftGreen: number,
  leftBlue: number,
  rightRed: number,
  rightGreen: number,
  rightBlue: number,
): number {
  const red = leftRed - rightRed;
  const green = leftGreen - rightGreen;
  const blue = leftBlue - rightBlue;
  return (red * red) + (green * green) + (blue * blue);
}

function paletteColorToJimp(index: number): number {
  const [red, green, blue] = VIC_PALETTE[index] ?? VIC_PALETTE[0];
  return (red << 24) | (green << 16) | (blue << 8) | 0xFF;
}

function normaliseColorIndex(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 15) {
    throw new Error(`VIC colour indices must be integers between 0 and 15 (received ${value})`);
  }
  return value;
}

function validateAddress(address: number, length: number, label: string): void {
  if (!Number.isInteger(address) || address < 0 || address > 0xFFFF) {
    throw new Error(`${label} must be an integer address within $0000-$FFFF`);
  }
  if (address + length - 1 > 0xFFFF) {
    throw new Error(`${label} range must fit within 64 KB address space`);
  }
}

function formatHex(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function rangesOverlap(leftStart: number, leftLength: number, rightStart: number, rightLength: number): boolean {
  const leftEnd = leftStart + leftLength - 1;
  const rightEnd = rightStart + rightLength - 1;
  return leftStart <= rightEnd && rightStart <= leftEnd;
}
