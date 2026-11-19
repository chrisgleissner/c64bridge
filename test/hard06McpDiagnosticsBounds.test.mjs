import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getDiagnosticsSessionInfo,
  readDiagnosticRecords,
  resetDiagnosticsStateForTesting,
  writeDiagnosticEvent,
} from "../src/diagnostics.ts";

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("MCP-13 a session's diagnostics file rotates at the size limit and keeps at most four parts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h6-diag-"));
  try {
    withEnv({ C64BRIDGE_DIAGNOSTICS_DIR: dir, C64BRIDGE_ENABLE_TEST_DIAGNOSTICS: "1", C64BRIDGE_DIAGNOSTICS_MAX_FILE_BYTES: "4000" }, () => {
      resetDiagnosticsStateForTesting();
      for (let index = 0; index < 400; index += 1) {
        writeDiagnosticEvent("perf_span_end", { index, name: "read_screen", padding: "x".repeat(100) });
      }
      const files = fs.readdirSync(dir);
      assert.ok(files.length <= 4, `${files.length} files: ${files.join(", ")}`);
      for (const file of files) {
        assert.ok(fs.statSync(path.join(dir, file)).size < 4000 + 1000, file);
      }
      const current = getDiagnosticsSessionInfo().filePath;
      assert.match(path.basename(current), /-part\d+\.ndjson$/);
      assert.equal(readDiagnosticRecords(current)[0].event, "diagnostics_rotated");
    });
  } finally {
    resetDiagnosticsStateForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-13 reading a large diagnostics file reads only its tail, from a whole line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h6-diag-"));
  try {
    const file = path.join(dir, "big.ndjson");
    const lines = [];
    for (let index = 0; index < 2000; index += 1) {
      lines.push(JSON.stringify({ ts: "2026-11-19T00:00:00.000Z", event: "e", details: { index } }));
    }
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const records = readDiagnosticRecords(file, 10_000);
    assert.ok(records.length > 0 && records.length < 300, `${records.length} records`);
    assert.equal(records.at(-1).details.index, 1999);
    const indexes = records.map((record) => record.details.index);
    assert.equal(indexes[0] + indexes.length - 1, 1999, "consecutive whole records from the end");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
