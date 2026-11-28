import test from "#test/runner";
import assert from "#test/assert";
import { setTimeout as delay } from "node:timers/promises";
import { borderColumnX, missingFrameNumbers, profileBorder, standardFromHeight, visiblePicture } from "../src/testing/borderProfile.js";
import { realVice, realViceSession } from "./helpers/gd1Vice.mjs";

const WIDTH = 384;
const HEIGHT = 272;

/** An idle frame (colour 0) with the marker colour in the rows [first, first + rows), wrapping at the frame end. */
function frame(first, rows, color = 2, height = HEIGHT) {
  const pixels = new Uint8Array(WIDTH * height);
  for (let row = first; row < first + rows; row += 1) pixels.fill(color, (row % height) * WIDTH, ((row % height) + 1) * WIDTH);
  return { width: WIDTH, height, pixels };
}

const profile = (frames, extra = {}) => profileBorder(frames, { markers: [{ name: "work", color: 2 }], column: "left", standard: "pal", ...extra })[0];

test("a marker of 10 rows is reported as 10 lines", () => {
  const report = profile([frame(100, 10), frame(100, 10)]);
  assert.deepEqual(report.lines, { min: 10, max: 10, mean: 10 });
  assert.deepEqual(report.firstLine, { min: 100, max: 100 });
  assert.deepEqual(report.approxCycles, { min: 630, max: 630, mean: 630 });
  assert.equal(report.jitterLines, 0);
  assert.equal(report.framesSeen, 2);
  assert.equal(report.overrun, false);
});

test("NTSC lines count 65 cycles", () => {
  assert.equal(profile([frame(100, 10)], { standard: "ntsc" }).approxCycles.mean, 650);
});

test("frames of 9 and 11 rows give a jitter of 2", () => {
  const report = profile([frame(100, 9), frame(100, 11)]);
  assert.equal(report.jitterLines, 2);
  assert.deepEqual(report.lines, { min: 9, max: 11, mean: 10 });
});

test("a marker in the last or the first captured row is an overrun", () => {
  assert.equal(profile([frame(HEIGHT - 5, 5)]).overrun, true);
  assert.equal(profile([frame(0, 5)]).overrun, true);
  assert.equal(profile([frame(100, 10), frame(HEIGHT - 5, 10)]).overrun, true);
});

test("a colour that never appears is seen in no frame", () => {
  const report = profile([frame(100, 10, 5)]);
  assert.equal(report.framesSeen, 0);
  assert.equal(report.lines, null);
  assert.equal(report.overrun, false);
});

test("only the chosen border column is read, and the longest run counts", () => {
  const two = frame(20, 4);
  two.pixels.set(frame(100, 7).pixels.subarray(100 * WIDTH, 107 * WIDTH), 100 * WIDTH);
  assert.equal(profile([two]).lines.max, 7);
  const rightOnly = frame(0, 0);
  for (let row = 50; row < 53; row += 1) rightOnly.pixels[row * WIDTH + borderColumnX(WIDTH, "right")] = 2;
  assert.equal(profile([rightOnly]).framesSeen, 0);
  assert.equal(profile([rightOnly], { column: "right" }).lines.max, 3);
});

test("the standard follows the frame height, and frame number gaps are counted", () => {
  assert.equal(standardFromHeight(272), "pal");
  assert.equal(standardFromHeight(312), "pal");
  assert.equal(standardFromHeight(240), "ntsc");
  assert.equal(standardFromHeight(263), "ntsc");
  assert.equal(missingFrameNumbers([10, 11, 14]), 2);
  assert.equal(missingFrameNumbers([0xffff, 0]), 0);
  assert.equal(missingFrameNumbers([null, null]), 0);
});

test("the blanking of a VICE canvas is removed before rows are counted", () => {
  // x64sc: 504 x 312, picture of 384 x 272 at (104, 15). Colour 2 in the whole left border.
  const pixels = new Uint8Array(504 * 312);
  for (let row = 15; row < 15 + 272; row += 1) pixels.fill(2, row * 504 + 104, row * 504 + 136);
  const canvas = { width: 504, height: 312, pixels };
  assert.equal(visiblePicture(canvas).height, 272);
  const report = profile([canvas]);
  assert.deepEqual(report.lines, { min: 272, max: 272, mean: 272 });
  assert.deepEqual(report.firstLine, { min: 0, max: 0 });
  assert.equal(report.overrun, true);
  assert.equal(visiblePicture({ width: 520, height: 263, pixels: new Uint8Array(520 * 263) }).height, 247);
});

/** Colours the border from raster line `from` to raster line `to`. */
const bar = (from, to) => `
* = $C000
start:  sei
        lda #$00
        sta $d020
loop:   lda #${from}
top:    cmp $d012
        bne top
        lda #$02
        sta $d020
        lda #${to}
bottom: cmp $d012
        bne bottom
        lda #$00
        sta $d020
        jmp loop
`;

test("real VICE: a routine of 10 raster lines, and one that runs past the last visible line", { skip: !realVice }, async () => {
  await realViceSession({ port: 6520, display: ":120" }, async (call) => {
    const request = { op: "profile_border", markers: [{ name: "work", color: 2 }], idleColor: 0, frames: 8 };

    await call("c64_program", { op: "upload_run_asm", program: bar(128, 138) });
    await delay(3_000);
    const padded = await call("c64_debug", request);
    console.log(JSON.stringify(padded));
    assert.equal(padded.source, "vice");
    assert.equal(padded.standard, "pal");
    assert.equal(padded.markers[0].framesSeen, 8);
    assert.ok(Math.abs(padded.markers[0].lines.min - 10) <= 1 && Math.abs(padded.markers[0].lines.max - 10) <= 1);
    assert.equal(padded.markers[0].overrun, false);

    await call("c64_program", { op: "upload_run_asm", program: bar(240, 64) });
    await delay(3_000);
    const late = await call("c64_debug", request);
    console.log(JSON.stringify(late));
    assert.equal(late.markers[0].overrun, true);
  });
});
