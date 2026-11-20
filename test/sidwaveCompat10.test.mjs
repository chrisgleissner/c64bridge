import test from "#test/runner";
import assert from "#test/assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.js";

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
