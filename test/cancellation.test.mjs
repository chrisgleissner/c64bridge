import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeCtx(clientOverrides, signal) {
  return {
    client: { async getActiveBackendType() { return "c64u"; }, ...clientOverrides },
    rag: {},
    logger,
    platform: { id: "c64u", features: [], limitedFeatures: [] },
    setPlatform: () => ({ id: "c64u", features: [], limitedFeatures: [] }),
    signal,
  };
}

test("HARD03-012 wait_for_text returns within one poll interval of an abort and reads nothing more", async () => {
  const controller = new AbortController();
  let reads = 0;
  const ctx = makeCtx({
    async readScreen() {
      reads += 1;
      if (reads === 2) controller.abort();
      return "NO MATCH HERE";
    },
  }, controller.signal);
  const started = Date.now();
  const result = await toolRegistry.invoke("c64_memory", { op: "wait_for_text", pattern: "READY.", timeoutMs: 20_000, intervalMs: 200 }, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.metadata.cancelled, true);
  assert.match(result.content[0].text, /cancelled/);
  assert.equal(reads, 2, "no device read after the abort");
  assert.ok(Date.now() - started < 1000);
});

test("HARD03-012 wait_for_text with a signal that is already aborted does not read the screen", async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const ctx = makeCtx({ async readScreen() { reads += 1; return ""; } }, controller.signal);
  const result = await toolRegistry.invoke("c64_memory", { op: "wait_for_text", pattern: "READY." }, ctx);
  assert.equal(result.metadata.cancelled, true);
  assert.equal(reads, 0);
});

test("HARD03-012 c64_batch stops before the next command once the signal is aborted", async () => {
  const controller = new AbortController();
  const calls = [];
  const ctx = makeCtx({
    async readMemory(address, length) {
      calls.push(address);
      if (calls.length === 1) controller.abort();
      return { success: true, details: { address: String(address), length: Number(length), bytes: "$00" } };
    },
  }, controller.signal);
  const command = { tool: "c64_memory", args: { op: "read", address: "$0400", length: 1 } };
  const result = await toolRegistry.invoke("c64_batch", { commands: [command, command, command] }, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.metadata.cancelled, true);
  assert.equal(result.structuredContent.data.results.length, 1);
  assert.equal(result.structuredContent.data.executed, 1);
  assert.match(result.content[0].text, /cancelled/);
  assert.equal(calls.length, 1);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("HARD03-012 batch_run stops during the run duration, resets the machine and reports the cancellation", async () => {
  const controller = new AbortController();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-cancel-"));
  let resets = 0;
  let reads = 0;
  const ctx = makeCtx({
    async runPrgFile() { setTimeout(() => controller.abort(), 50); return { success: true }; },
    async readScreen() { reads += 1; return ""; },
    async reset() { resets += 1; return { success: true }; },
  }, controller.signal);
  try {
    const started = Date.now();
    const result = await toolRegistry.invoke("c64_program", {
      op: "batch_run",
      programs: [
        { path: "/a.prg", assertions: [{ type: "screen_contains", pattern: "X" }] },
        { path: "/b.prg" },
      ],
      durationMs: 60_000,
      resetDelayMs: 0,
      outputPath: out,
    }, ctx);
    assert.ok(Date.now() - started < 2000, "the run duration was cut short");
    assert.equal(result.isError, true);
    assert.equal(result.metadata.cancelled, true);
    assert.equal(resets, 1, "the machine is reset by the existing cleanup and the second program never starts");
    assert.equal(reads, 0, "no assertion read after the abort");
    assert.equal(result.structuredContent.data.summary.passed, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("HARD03-012 shuffle stops before the next program once aborted", async () => {
  const controller = new AbortController();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-cancel-"));
  const ran = [];
  const ctx = makeCtx({
    async filesInfo() { return ["/a.prg", "/b.prg", "/c.prg"]; },
    async runPrgFile(file) { ran.push(file); setTimeout(() => controller.abort(), 30); return { success: true }; },
    async readScreen() { return ""; },
    async reset() { return { success: true }; },
  }, controller.signal);
  try {
    const result = await toolRegistry.invoke("c64_config", { op: "shuffle", durationMs: 60_000, resetDelayMs: 0, outputPath: out, extensions: ["prg"] }, ctx);
    assert.equal(result.metadata.cancelled, true);
    assert.deepEqual(ran, ["/a.prg"]);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("HARD03-012 the new maxima are validation errors", async () => {
  const ctx = makeCtx({});
  const cases = [
    ["c64_program", { op: "batch_run", programs: [{ path: "/a.prg" }], durationMs: 600_001 }],
    ["c64_config", { op: "shuffle", durationMs: 600_001 }],
    ["c64_extract", { op: "memory_dump", address: "$0400", length: 1, outputPath: "/tmp/x.hex", retries: 11 }],
  ];
  for (const [tool, args] of cases) {
    const result = await toolRegistry.invoke(tool, args, ctx);
    assert.equal(result.isError, true, `${tool} ${args.op}`);
    assert.match(result.content[0].text, /above maximum/, `${tool} ${args.op}: ${result.content[0].text}`);
  }
});

test("HARD03-012 memory_dump stops between chunks once aborted and writes no file", async () => {
  const controller = new AbortController();
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-cancel-")), "dump.hex");
  let reads = 0;
  const ctx = makeCtx({
    async readMemory(address, length) {
      reads += 1;
      controller.abort();
      return { success: true, data: "00".repeat(Number(length)) };
    },
  }, controller.signal);
  try {
    const result = await toolRegistry.invoke("c64_extract", { op: "memory_dump", address: "$0400", length: 2048, chunkSize: 512, pauseDuringRead: false, outputPath: out }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cancelled/);
    assert.equal(reads, 1);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test("HARD03-012 reset with waitForReady returns promptly with cancelled:true when aborted mid-wait", async () => {
  const controller = new AbortController();
  let resets = 0;
  let reads = 0;
  const ctx = makeCtx({
    async reset() { resets += 1; return { success: true, details: {} }; },
    async readScreen() {
      reads += 1;
      if (reads === 3) controller.abort();
      return "NOT READY YET";
    },
  }, controller.signal);
  const started = Date.now();
  const result = await toolRegistry.invoke("c64_system", { op: "reset", waitForReady: true, readyTimeoutMs: 60_000 }, ctx);
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.isError, true);
  assert.equal(result.metadata.cancelled, true);
  assert.match(result.content[0].text, /command had already been sent/);
  assert.equal(resets, 1);
  assert.equal(reads, 3, "no read after the abort");
});

test("HARD03-012 power_cycle with an already aborted signal sends no menu input", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  const ctx = makeCtx({}, controller.signal);
  ctx.client = new Proxy({ getActiveBackendType: async () => "c64u" }, {
    get(target, property) {
      if (property in target) return target[property];
      return async () => { calls.push(String(property)); return { success: true, details: {} }; };
    },
  });
  const result = await toolRegistry.invoke("c64_system", { op: "power_cycle", waitForReady: true }, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.metadata.cancelled, true);
  assert.deepEqual(calls, []);
});
