import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCoverageBatches,
  chunkFiles,
  copyCoverageOutput,
  dropNonCodeLines,
  resolveCoverageShardSize,
} from "../../scripts/run-coverage.mjs";

test("run-coverage shards the broad suite and preserves targeted supplements", () => {
  const testFiles = [
    "test/a.test.mjs",
    "test/b.test.mjs",
    "test/c.test.mjs",
    "test/d.test.mjs",
    "test/e.test.mjs",
  ];
  const extraTests = ["test/supplemental.test.mjs"];

  const batches = buildCoverageBatches(testFiles, extraTests, {
    C64BRIDGE_COVERAGE_SHARD_SIZE: "2",
  });

  assert.deepEqual(batches, [
    { label: "all-01", files: ["test/a.test.mjs", "test/b.test.mjs"] },
    { label: "all-02", files: ["test/c.test.mjs", "test/d.test.mjs"] },
    { label: "all-03", files: ["test/e.test.mjs"] },
    { label: "supplemental.test", files: ["test/supplemental.test.mjs"] },
  ]);
});

test("run-coverage keeps a single all batch when shard size covers the suite", () => {
  const batches = buildCoverageBatches(
    ["test/a.test.mjs", "test/b.test.mjs"],
    ["test/supplemental.test.mjs"],
    { C64BRIDGE_COVERAGE_SHARD_SIZE: "5" },
  );

  assert.deepEqual(batches, [
    { label: "all", files: ["test/a.test.mjs", "test/b.test.mjs"] },
    { label: "supplemental.test", files: ["test/supplemental.test.mjs"] },
  ]);
});

test("run-coverage resolves shard size defaults and chunks files safely", () => {
  assert.equal(resolveCoverageShardSize(undefined), 12);
  assert.equal(resolveCoverageShardSize("0"), 12);
  assert.equal(resolveCoverageShardSize("7"), 7);

  assert.deepEqual(chunkFiles([], 3), [[]]);
  assert.deepEqual(chunkFiles(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
});

test("run-coverage copies stable lcov output when present", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "c64bridge-coverage-"));
  const out = path.join(dir, "out.lcov.info");

  await fs.writeFile(path.join(dir, "lcov.info"), "TN:\nSF:src/a.ts\nDA:1,1\nend_of_record\n", "utf8");
  await copyCoverageOutput(dir, out);

  assert.match(await fs.readFile(out, "utf8"), /SF:src\/a\.ts/);
});

test("run-coverage falls back to a new Bun temporary lcov output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "c64bridge-coverage-"));
  const oldTmp = path.join(dir, ".lcov.info.old.tmp");
  const newTmp = path.join(dir, ".lcov.info.new.tmp");
  const out = path.join(dir, "out.lcov.info");

  await fs.writeFile(oldTmp, "old", "utf8");
  const known = new Set([oldTmp]);
  await fs.writeFile(newTmp, "new", "utf8");
  await copyCoverageOutput(dir, out, known);

  assert.equal(await fs.readFile(out, "utf8"), "new");
});

test("run-coverage reports missing shard coverage clearly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "c64bridge-coverage-"));
  await assert.rejects(
    () => copyCoverageOutput(dir, path.join(dir, "out.lcov.info")),
    /no LCOV report was produced/,
  );
});

test("dropNonCodeLines removes blank and comment-only lines that Bun reports as executable", async () => {
  const source = [
    "function f() {",        // 1
    "  // explain the next line", // 2
    "  const x = 1;",        // 3
    "",                      // 4
    "  /* block */",         // 5
    "   * continued",        // 6
    "  return x; // trailing comment keeps the line", // 7
    "}",                     // 8
  ].join("\n");
  const report = new Map([["src/a.ts", { lines: new Map([[1, 1], [2, 0], [3, 1], [4, 0], [5, 0], [6, 0], [7, 0], [8, 1]]) }]]);
  const filtered = await dropNonCodeLines(report, async () => source);
  assert.deepEqual([...filtered.get("src/a.ts").lines.entries()], [[1, 1], [3, 1], [7, 0], [8, 1]]);

  // A file that cannot be read is kept as reported.
  const unreadable = await dropNonCodeLines(report, async () => { throw new Error("missing"); });
  assert.equal(unreadable.get("src/a.ts").lines.size, 8);
});
