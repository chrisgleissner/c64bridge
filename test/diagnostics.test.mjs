import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginDiagnosticSpan,
  createOutputTailCapture,
  installProcessDiagnostics,
  pruneDiagnosticsDirectory,
  resetDiagnosticsStateForTesting,
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

test("diagnostics retention keeps the newest files, removes old ones, and only touches matching regular files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-diag-prune-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const make = (name, ageMs) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "{}\n");
    const when = new Date(now - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  };
  const name = (i, comp = "mcp") => `2026-01-01T00-00-0${i}-000Z-${1000 + i}-${comp}.ndjson`;
  const kept = [make(name(1), 1000), make(name(2), 2000)];
  const overCount = make(name(3), 3000);
  const tooOld = make(name(4), 31 * 24 * 3600 * 1000);
  const unrelated = make("notes.txt", 99 * 24 * 3600 * 1000);
  const subdir = path.join(dir, name(5));
  fs.mkdirSync(subdir);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-diag-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, "target.txt");
  fs.writeFileSync(target, "keep me");
  const link = path.join(dir, name(6));
  fs.symlinkSync(target, link);
  const current = make(name(7), 0);

  pruneDiagnosticsDirectory(dir, { keep: 3, currentFile: current, now });

  assert.ok(fs.existsSync(kept[0]), "newest file kept");
  assert.ok(fs.existsSync(kept[1]), "second file kept");
  assert.ok(!fs.existsSync(overCount), "file beyond the count removed");
  assert.ok(!fs.existsSync(tooOld), "file older than 30 days removed");
  assert.ok(fs.existsSync(unrelated), "non-matching file untouched");
  assert.ok(fs.existsSync(subdir), "directory untouched");
  assert.ok(fs.existsSync(current), "current session file untouched");
  assert.equal(fs.readFileSync(target, "utf8"), "keep me", "symlink target untouched");
});

function withDiagnosticsEnv(t, dir, keep) {
  const names = ["C64BRIDGE_DIAGNOSTICS_DIR", "C64BRIDGE_ENABLE_TEST_DIAGNOSTICS", "C64BRIDGE_DIAGNOSTICS_KEEP"];
  const prev = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  t.after(() => {
    resetDiagnosticsStateForTesting();
    for (const n of names) {
      if (prev[n] === undefined) delete process.env[n];
      else process.env[n] = prev[n];
    }
  });
  process.env.C64BRIDGE_DIAGNOSTICS_DIR = dir;
  process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS = "1";
  if (keep === undefined) delete process.env.C64BRIDGE_DIAGNOSTICS_KEEP;
  else process.env.C64BRIDGE_DIAGNOSTICS_KEEP = keep;
  resetDiagnosticsStateForTesting();
}

test("diagnostics creates a new directory 0700 and files 0600", (t) => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-diag-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "new", "diagnostics");
  withDiagnosticsEnv(t, dir, undefined);
  const info = installProcessDiagnostics("mode-test");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(info.filePath).mode & 0o777, 0o600);
});

test("diagnostics does not change the mode of an existing directory", (t) => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-diag-existing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o755);
  withDiagnosticsEnv(t, dir, undefined);
  installProcessDiagnostics("mode-test");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
});

test("diagnostics startup applies C64BRIDGE_DIAGNOSTICS_KEEP", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-diag-keep-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 4; i += 1) {
    const f = path.join(dir, `2026-01-01T00-00-0${i}-000Z-${i}-mcp.ndjson`);
    fs.writeFileSync(f, "{}\n");
    const when = new Date(Date.now() - (i + 1) * 1000);
    fs.utimesSync(f, when, when);
  }
  withDiagnosticsEnv(t, dir, "2");
  const info = installProcessDiagnostics("keep-test");
  const remaining = fs.readdirSync(dir).sort();
  assert.equal(remaining.length, 2);
  assert.ok(remaining.includes(path.basename(info.filePath)));
  assert.ok(remaining.includes("2026-01-01T00-00-00-000Z-0-mcp.ndjson"), "newest old file kept");
});
