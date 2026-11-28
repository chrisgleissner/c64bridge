/**
 * Border-bar raster profile: a profiled routine writes a marker colour to $D020 at entry and the
 * idle colour at exit. The rows of one border column that show a marker colour measure its run time.
 */

export type VideoStandard = "pal" | "ntsc";
export type BorderColumn = "left" | "right";

export interface BorderMarker {
  readonly name: string;
  readonly color: number;
}

export interface BorderFrame {
  readonly width: number;
  readonly height: number;
  /** One palette index per pixel, row by row. */
  readonly pixels: Uint8Array;
}

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface MeanRange extends Range {
  readonly mean: number;
}

export interface BorderMarkerReport {
  readonly name: string;
  readonly color: number;
  readonly framesSeen: number;
  /** Rows count from the top of the visible picture. The four values are null when no frame shows the colour. */
  readonly firstLine: Range | null;
  readonly lines: MeanRange | null;
  readonly jitterLines: number | null;
  readonly approxCycles: MeanRange | null;
  /** The colour is in the first or the last captured row of at least one frame. */
  readonly overrun: boolean;
  /** Frames in which the colour is in more than one run of rows; only the longest run is measured. */
  readonly splitFrames: number;
}

/** CPU cycles of one raster line: PAL 6569, NTSC 6567R8. Bad lines and sprite DMA are not subtracted. */
export const CYCLES_PER_LINE: Readonly<Record<VideoStandard, number>> = { pal: 63, ntsc: 65 };

/** Distance of the sampled pixel column from the frame edge; the side borders are at least 32 pixels wide. */
const COLUMN_INSET = 16;

/**
 * A PAL frame has at least 272 rows (272 on the video stream, 312 on the VICE canvas); an NTSC
 * frame has fewer (240 on the stream, 263 on the VICE canvas).
 */
export function standardFromHeight(height: number): VideoStandard {
  return height >= 270 ? "pal" : "ntsc";
}

/**
 * VICE returns the whole raster, with black blanking around the picture (measured with x64sc 3.10:
 * 504 x 312 PAL and 520 x 263 NTSC canvas). The video stream returns the picture only.
 */
const VICE_CANVAS_MIN_WIDTH = 480;
const VICE_PICTURE = { x: 104, width: 384, pal: { y: 15, height: 272 }, ntsc: { y: 8, height: 247 } } as const;

/** The visible picture of a frame, without the blanking of a VICE canvas. */
export function visiblePicture(frame: BorderFrame): BorderFrame {
  if (frame.width < VICE_CANVAS_MIN_WIDTH) return frame;
  const { y, height } = VICE_PICTURE[standardFromHeight(frame.height)];
  const { x, width } = VICE_PICTURE;
  const pixels = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const from = (y + row) * frame.width + x;
    pixels.set(frame.pixels.subarray(from, from + width), row * width);
  }
  return { width, height, pixels };
}

export function borderColumnX(width: number, column: BorderColumn): number {
  const inset = Math.min(COLUMN_INSET, Math.floor((width - 1) / 2));
  return column === "left" ? inset : width - 1 - inset;
}

/**
 * Longest run of consecutive rows showing `color`, the first one when two runs have the same length,
 * and whether there is more than one run.
 */
function longestRun(column: readonly number[], color: number): { first: number; length: number; split: boolean } | null {
  let best: { first: number; length: number } | null = null;
  let runs = 0;
  let start = -1;
  for (let row = 0; row <= column.length; row += 1) {
    if (row < column.length && column[row] === color) {
      if (start < 0) start = row;
      continue;
    }
    if (start >= 0) {
      runs += 1;
      if (!best || row - start > best.length) best = { first: start, length: row - start };
    }
    start = -1;
  }
  return best ? { ...best, split: runs > 1 } : null;
}

function range(values: readonly number[]): Range {
  return { min: Math.min(...values), max: Math.max(...values) };
}

function meanRange(values: readonly number[]): MeanRange {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { ...range(values), mean: Math.round(mean * 100) / 100 };
}

export function profileBorder(
  frames: readonly BorderFrame[],
  options: { readonly markers: readonly BorderMarker[]; readonly column: BorderColumn; readonly standard: VideoStandard },
): BorderMarkerReport[] {
  const columns = frames.map(visiblePicture).map((frame) => {
    const x = borderColumnX(frame.width, options.column);
    return Array.from({ length: frame.height }, (_, row) => frame.pixels[row * frame.width + x]! & 0x0f);
  });
  const cycles = CYCLES_PER_LINE[options.standard];
  return options.markers.map((marker) => {
    const firsts: number[] = [];
    const lengths: number[] = [];
    let overrun = false;
    let splitFrames = 0;
    for (const column of columns) {
      const run = longestRun(column, marker.color);
      if (!run) continue;
      firsts.push(run.first);
      lengths.push(run.length);
      if (run.split) splitFrames += 1;
      if (column[0] === marker.color || column[column.length - 1] === marker.color) overrun = true;
    }
    const seen = lengths.length;
    const lines = seen > 0 ? meanRange(lengths) : null;
    return {
      name: marker.name,
      color: marker.color,
      framesSeen: seen,
      firstLine: seen > 0 ? range(firsts) : null,
      lines,
      jitterLines: lines ? lines.max - lines.min : null,
      approxCycles: seen > 0 ? meanRange(lengths.map((length) => length * cycles)) : null,
      overrun,
      splitFrames,
    };
  });
}

/** Frames missing between the first and the last captured video frame number (16-bit counter). */
export function missingFrameNumbers(frameNumbers: ReadonlyArray<number | null>): number {
  let missing = 0;
  let previous: number | null = null;
  for (const number of frameNumbers) {
    if (number !== null && previous !== null) missing += Math.max(0, ((number - previous) & 0xffff) - 1);
    previous = number;
  }
  return missing;
}
