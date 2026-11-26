import { SidwaveValidationError, type SidModel } from "./sidwave.js";

// Cutoff curves, FC register value (0-2047) to cutoff frequency in Hz.
// Source: reSID 0.16 filter.cc, Filter::f0_points_6581 and Filter::f0_points_8580, read from the copy
// vendored in DOSBox-X (src/hardware/reSID/filter.cpp, github.com/joncampbell123/dosbox-x). Current
// libsidplayfp/resid master replaced these tables with a transistor-level model, so there is no
// equivalent table to cite there. reSID interpolates the points with a cubic spline; this module
// interpolates linearly, so values between the points are approximate. The curves are nominal: the
// 6581 varies strongly from chip to chip, and the UltiSID range for split parts is not verified in
// data/ultimate/multisid.md.
const POINTS: Record<SidModel, ReadonlyArray<readonly [number, number]>> = {
  "6581": [
    [0, 220], [128, 230], [256, 250], [384, 300], [512, 420], [640, 780], [768, 1600],
    [832, 2300], [896, 3200], [960, 4300], [992, 5000], [1008, 5400], [1016, 5700],
    [1023, 6000], [1024, 4600], [1032, 4800], [1056, 5300], [1088, 6000], [1120, 6600],
    [1152, 7200], [1280, 9500], [1408, 12000], [1536, 14500], [1664, 16000],
    [1792, 17100], [1920, 17700], [2047, 18000],
  ],
  "8580": [
    [0, 0], [128, 800], [256, 1600], [384, 2500], [512, 3300], [640, 4100], [768, 4800],
    [896, 5600], [1024, 6500], [1152, 7500], [1280, 8400], [1408, 9200], [1536, 9800],
    [1664, 10500], [1792, 11000], [1920, 11700], [2047, 12500],
  ],
};

/** Marks the tables as approximate in compile output and documentation. */
export const FILTER_CURVE_NOTE = "nominal reSID 0.16 f0_points tables, linearly interpolated; real chips vary";

export function cutoffHz(units: number, model: SidModel = "8580"): number {
  const points = POINTS[model];
  const code = Math.max(0, Math.min(2047, units));
  const next = points.findIndex(([reg]) => reg >= code);
  if (next <= 0) return points[0]![1];
  const [left, low] = points[next - 1]!;
  const [right, high] = points[next]!;
  return low + (high - low) * (code - left) / (right - left);
}

/** Parses `900Hz` or `1.2kHz`; undefined when the text is not a frequency. */
export function parseHz(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?|\.\d+)(k?)Hz$/i.exec(raw);
  return match ? parseFloat(match[1]!) * (match[2] ? 1000 : 1) : undefined;
}

/** Register units for a cutoff given in Hz; the lowest code wins where the 6581 curve is not monotonic. */
export function resolveCutoff(raw: number | string, model: SidModel | undefined, path: string): number {
  if (typeof raw === "number") return Math.round(raw);
  const target = parseHz(raw);
  if (target === undefined) throw new SidwaveValidationError(path, "expected a number or a frequency such as 900Hz");
  const chip = model ?? "8580";
  let nearest = 0;
  let error = Infinity;
  for (let code = 0; code <= 2047; code++) {
    const delta = Math.abs(cutoffHz(code, chip) - target);
    if (delta < error - 1e-9) { nearest = code; error = delta; }
  }
  return nearest;
}
