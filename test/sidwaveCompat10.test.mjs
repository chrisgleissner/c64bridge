import test from "#test/runner";
import assert from "#test/assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.js";
import { getMusicPresetSidwave } from "../src/tools/meta/audio.js";
import { generateSidwave } from "../src/audio/generateSidwave.js";

// SHA-256 of the PRG and PSID that the 1.3.0 compiler produced for these SIDWAVE 1.0 documents.
// SIDWAVE 1.1 features must not change the output of a 1.0 document.
const EXPECTED = {
  "all-fx.yaml": {
    "prg": "948ca36307f54168bfac0ef8d7912c6f21cc43a029d36c06218b2f26bf007f29",
    "sid": "465c546ccaf76864e00d9614ca0725767c81810c59498af53fb793bd390cbaed"
  },
  "fuer-elise.yaml": {
    "prg": "eb6cfa38039cdf03348586528190bcbafae5fb1ca15373463e0c96f1c86c4121",
    "sid": "277ac7eab5c53a63f3ee740455811eab50007fde0ea6e83462a5c994fcc5152b"
  },
  "spec-example.yaml": {
    "prg": "f8fb09ba4ab6cbc29662e25867b4bf285047fe8ee46c1b0dd51f8e2caa0aa32a",
    "sid": "aea3aada47dc2a3ee1bddd5468824cc6d821b1d6aace5051739ca1bbf6dac5a8"
  }
};

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sidwave-1.0");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

for (const [file, expected] of Object.entries(EXPECTED)) {
  test(`SIDWAVE 1.0 document ${file} compiles to the same PRG and PSID as in 1.3.0`, () => {
    const doc = parseSidwave(fs.readFileSync(path.join(dir, file), "utf8"));
    const result = compileSidwaveToPrg(doc);
    const sid = compileSidwaveToSid(doc, result.prg, { initAddress: result.initAddress, playAddress: result.playAddress }).sid;
    assert.equal(sha(result.prg), expected.prg);
    assert.equal(sha(sid), expected.sid);
  });
}

// These are pre-1.2 compiler fingerprints for 1.1 sources: built-in music presets and
// the deterministic music_generate output in each style (seed 65, C3, PAL, classic).
const EXPECTED_11 = {
  chiptune_drive: ["bb7244ec524456ba4ffec89b99789f3e24c289122201f3c860985eb25e0eb61b", "b502baca6735f82b54340112985439b4ec7d51e54b5b570a97d86d07622d4086"],
  ambient_filter: ["fadb9b8f1cfb33046bcbb7de7358e1541f2aece45943afbe4bbee0e8d8e3aac3", "1db7010a62f79cb13803584957fbf1d615b55db6336a6466d7fde311bb40f294"],
  funk_bass: ["d49ac9250b7fe9bb6a5b5b5766c5edca60b4b385f71d6066116608c680d456c4", "ee6b75147c3e3d67bba710586d9de3b18303197ab69d6cdb24c1bb7cc915bc68"],
  generated_chiptune: ["5df9be8f8ea46eb056b4eb58131abb0a995c53b6cd0caf6097ffff68d5b4263a", "02ee37b484f9a5e67314069b15c5a8eab7eaa511fda74ca2ad0453afa2d7a9d8"],
  generated_ambient: ["70a83c1f7a6b5c2ad949eaf5296272420959c88ccace6df7b0443c6004ca924c", "833613c2f964da8fb262725cda550a5624fe48ff05706cfdf94ad3ecc7db29d5"],
  generated_funk: ["3fc08567b3bbe568e21c255295c0a392b31de7e02c6fee9d755c167ce54e8474", "966858ce079996cb9ad17640dd514fdb5a3dfd6d5767a89a6d7299714fdd21cb"],
};
const sources11 = Object.fromEntries(["chiptune_drive", "ambient_filter", "funk_bass"].map((name) => [name, getMusicPresetSidwave(name)]));
for (const style of ["chiptune", "ambient", "funk"]) {
  sources11[`generated_${style}`] = generateSidwave({ style, system: "PAL", seed: 65, preset: "classic", root: "C3" }).score;
}
for (const [name, source] of Object.entries(sources11)) {
  test(`SIDWAVE 1.1 ${name} keeps its compiler PRG and PSID bytes`, () => {
    const doc = parseSidwave(source);
    const result = compileSidwaveToPrg(doc);
    const sid = compileSidwaveToSid(doc, result.prg, { initAddress: result.initAddress, playAddress: result.playAddress }).sid;
    assert.equal(sha(result.prg), EXPECTED_11[name][0]);
    assert.equal(sha(sid), EXPECTED_11[name][1]);
  });
}
