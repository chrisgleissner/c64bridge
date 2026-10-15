import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginDiagnosticSpan,
  createOutputTailCapture,
  installProcessDiagnostics,
  resolveDiagnosticSessionFile,
  readDiagnosticRecords,
  summarizeDiagnosticsSession,
  writeDiagnosticEvent,
} from "../src/diagnostics.ts";

test("installProcessDiagnostics writes an NDJSON session log", (t) => {
  const previousDir = process.env.C64BRIDGE_DIAGNOSTICS_DIR;
  const previousEnable = process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-diag-"));

  t.after(() => {
    if (previousDir === undefined) delete process.env.C64BRIDGE_DIAGNOSTICS_DIR;
    else process.env.C64BRIDGE_DIAGNOSTICS_DIR = previousDir;
    if (previousEnable === undefined) delete process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS;
    else process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS = previousEnable;
  });

  process.env.C64BRIDGE_DIAGNOSTICS_DIR = tempDir;
  process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS = "1";

  const info = installProcessDiagnostics("unit-test");
  writeDiagnosticEvent("custom_event", {
    message: "diagnostics smoke test",
    nested: { ok: true },
  });

  const records = fs.readFileSync(info.filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(records[0].event, "session_start");
  assert.equal(records.at(-1)?.event, "custom_event");
  assert.equal(records.at(-1)?.details?.nested?.ok, true);
});

test("createOutputTailCapture keeps byte counts and tails bounded", () => {
  const capture = createOutputTailCapture("vice", 12);

  capture.pushStdout("0123456789");
  capture.pushStdout("abcdef");
  capture.pushStderr("stderr-one\n");
  capture.pushStderr("stderr-two");

  const snapshot = capture.snapshot();
  assert.equal(snapshot.name, "vice");
  assert.equal(snapshot.stdoutBytes, 16);
  assert.equal(snapshot.stderrBytes, 21);
  assert.equal(snapshot.stdoutTail, "456789abcdef");
  assert.equal(snapshot.stderrTail, "e\nstderr-two");
});

test("diagnostics spans and summaries capture hot paths", (t) => {
  const previousDir = process.env.C64BRIDGE_DIAGNOSTICS_DIR;
  const previousEnable = process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-diag-summary-"));

  t.after(() => {
    if (previousDir === undefined) delete process.env.C64BRIDGE_DIAGNOSTICS_DIR;
    else process.env.C64BRIDGE_DIAGNOSTICS_DIR = previousDir;
    if (previousEnable === undefined) delete process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS;
    else process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS = previousEnable;
  });

  process.env.C64BRIDGE_DIAGNOSTICS_DIR = tempDir;
  process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS = "1";

  const info = installProcessDiagnostics("summary-test");
  const span = beginDiagnosticSpan("tool", "programs.c64_program", { operation: "cross_platform_greeting" });
  span.end("ok");
  writeDiagnosticEvent("mcp_call_tool_ok", { name: "c64_program", latencyMs: 12.5, isError: false });

  const resolved = resolveDiagnosticSessionFile("current");
  assert.equal(resolved, info.filePath);

  const summary = summarizeDiagnosticsSession(info.filePath, { includeTimeline: true, maxEntries: 10 });
  assert.equal(summary.filePath, info.filePath);
  assert.equal(summary.topSpans[0]?.category, "tool");
  assert.equal(summary.topSpans[0]?.name, "programs.c64_program");
  assert.equal(summary.toolCalls[0]?.name, "c64_program");
  assert.ok(Array.isArray(summary.timeline));
});
test("readDiagnosticRecords skips a partially written line", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-diag-partial-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const file = path.join(tempDir, "session.ndjson");
  fs.writeFileSync(file, '{"type":"event","name":"a"}\n{"type":"event","name":"b"}\n{"type":"ev', "utf8");

  const records = readDiagnosticRecords(file);
  assert.deepEqual(records.map((record) => record.name), ["a", "b"]);
  assert.doesNotThrow(() => summarizeDiagnosticsSession(file));
});
