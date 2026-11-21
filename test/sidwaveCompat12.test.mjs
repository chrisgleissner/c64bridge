import test from "#test/runner";
import assert from "#test/assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";

// SHA-256 of the PRG compiled from each example as shipped with c64bridge 1.3.2 (SIDWAVE 1.2, plus the
// 1.0 fuer_elise), without and with looping. The files under fixtures/sidwave-1.2 are frozen copies of
// data/sound/examples at that release, so the pin survives a rewrite of the live examples.
const EXPECTED = {
  "acid_line.yaml": ["2414600aecb44fd93ae4fda044f097a2d926f40be3a6f6df33cf94db6bcd2819", "2414600aecb44fd93ae4fda044f097a2d926f40be3a6f6df33cf94db6bcd2819"],
  "ambient_filter.yaml": ["0bc79375688350badc79ee4edf4833ccbfff3b913bd9ecde15caa1245b025ce4", "609bac2cddd44065dacdd502cb7d2149ac000849fa6293dea86c0b7a2f991b4f"],
  "arp_ballad.yaml": ["d49809782792deb939d9bf6e72f1d1855a8dc7170aaf1000e42bcf150fff98b6", "d49809782792deb939d9bf6e72f1d1855a8dc7170aaf1000e42bcf150fff98b6"],
  "chamber_waltz.yaml": ["649e702d028024f8843eea73f6993f0c2591e5ad4eda8cdb1878a8d5f750f168", "649e702d028024f8843eea73f6993f0c2591e5ad4eda8cdb1878a8d5f750f168"],
  "chiptune_drive.yaml": ["48c9b8612ca6da644e31b4c653c0e5cf9eb70e17bff07533c9e9c76e5c8737cc", "48c9b8612ca6da644e31b4c653c0e5cf9eb70e17bff07533c9e9c76e5c8737cc"],
  "digi_groove.yaml": ["a0cd76e6ea8460af63aab7bbe9cda27d1a4c0d3d5d293d078aa7c57af7f7df95", "a0cd76e6ea8460af63aab7bbe9cda27d1a4c0d3d5d293d078aa7c57af7f7df95"],
  "drum_and_bass.yaml": ["c3dba7058ba3d04b79a4dcb7a464e7719a9604257859bec30a82548a5b976cc0", "c3dba7058ba3d04b79a4dcb7a464e7719a9604257859bec30a82548a5b976cc0"],
  "fuer_elise.yaml": ["41b52252d93d029e0809cc5fdcd8de2de0078c226882e9e5dccc5de9a7cf9b55", "eb6cfa38039cdf03348586528190bcbafae5fb1ca15373463e0c96f1c86c4121"],
  "funk_bass.yaml": ["a2db313eb381adfe34d3ac4e76c735bd50d091f64a490ee7b9557d2aa4654107", "a2db313eb381adfe34d3ac4e76c735bd50d091f64a490ee7b9557d2aa4654107"],
  "metal_sync.yaml": ["b78a0cdbb4b222c087a9609d5b01abeb5cf10de28cb9f9355791fd2d25ca4d83", "b78a0cdbb4b222c087a9609d5b01abeb5cf10de28cb9f9355791fd2d25ca4d83"],
  "stereo_echo.yaml": ["8d11bc8a32aec609c7f44576462b9ffc47ab4aa7c46cf3fb729f3329b7d5775f", "8d11bc8a32aec609c7f44576462b9ffc47ab4aa7c46cf3fb729f3329b7d5775f"],
  "title_fanfare.yaml": ["d09817664c79bee541399040c302748ae84f534a289ac8ccef7e8aba899c1b78", "d09817664c79bee541399040c302748ae84f534a289ac8ccef7e8aba899c1b78"],
  "ultisid_orchestra.yaml": ["fdc655a4d81690d38971549727441438fe0313ff14f0709f23bcda18b1aa2b33", "fdc655a4d81690d38971549727441438fe0313ff14f0709f23bcda18b1aa2b33"],
  "wall_of_sid.yaml": ["b97b262d8911638f125fd83e4f42986ed0a58bb5a6c182d688cd057ba1ac1eb7", "b97b262d8911638f125fd83e4f42986ed0a58bb5a6c182d688cd057ba1ac1eb7"],
};

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sidwave-1.2");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

test("the frozen example copies are exactly the pinned files", () => {
  assert.deepEqual(fs.readdirSync(dir).filter((file) => file.endsWith(".yaml")).sort(), Object.keys(EXPECTED).sort());
});

for (const [file, [once, looped]] of Object.entries(EXPECTED)) {
  test(`example ${file} keeps its 1.3.2 PRG bytes with and without looping`, () => {
    const doc = parseSidwave(fs.readFileSync(path.join(dir, file), "utf8"));
    assert.equal(sha(compileSidwaveToPrg(doc, { loop: false }).prg), once);
    assert.equal(sha(compileSidwaveToPrg(doc, { loop: true }).prg), looped);
  });
}
