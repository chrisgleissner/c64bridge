import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { C64Client } from "../src/c64Client.js";
import { getDiagnosticsSessionInfo, readDiagnosticRecords, resetDiagnosticsStateForTesting, writeDiagnosticEvent } from "../src/diagnostics.js";

// HARD05-012: a hostile stream of malformed video datagrams must not flood the diagnostics file.

test("ignored video datagrams are reported at a bounded rate with a count", (t) => {
  const previousDir = process.env.C64BRIDGE_DIAGNOSTICS_DIR;
  const previousEnable = process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-hard05-diag-"));
  t.after(() => {
    resetDiagnosticsStateForTesting();
    if (previousDir === undefined) delete process.env.C64BRIDGE_DIAGNOSTICS_DIR;
    else process.env.C64BRIDGE_DIAGNOSTICS_DIR = previousDir;
    if (previousEnable === undefined) delete process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS;
    else process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS = previousEnable;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  process.env.C64BRIDGE_DIAGNOSTICS_DIR = tempDir;
  process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS = "1";
  resetDiagnosticsStateForTesting();
  writeDiagnosticEvent("test_start");
  const filePath = getDiagnosticsSessionInfo().filePath;

  const client = new C64Client("http://127.0.0.1:1");
  for (let index = 0; index < 1000; index += 1) {
    assert.equal(client.parseVideoPacketOrNull(Buffer.alloc(5)), null);
  }
  const ignored = () => readDiagnosticRecords(filePath).filter((record) => record.event === "capture_video_packet_ignored");
  assert.ok(ignored().length <= 2, `${ignored().length} diagnostic records for 1000 ignored datagrams`);
  assert.equal(ignored()[0].details.ignoredPackets, 1);

  // After the report interval the next ignored datagram reports how many were ignored since the last record.
  client.ignoredVideoReportAt -= 60_000;
  client.parseVideoPacketOrNull(Buffer.alloc(5));
  const records = ignored();
  assert.equal(records.length, 2);
  assert.equal(records[1].details.ignoredPackets, 1000);
});
