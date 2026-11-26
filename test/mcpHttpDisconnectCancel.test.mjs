import test from "#test/runner";
import assert from "#test/assert";
import { spawnSync } from "node:child_process";
import { startServer } from "./helpers/modernClient.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RUNS = 10;

async function disconnectOnce(server, op, args) {
  const ac = new AbortController();
  const pending = fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    signal: ac.signal,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "c64_memory", arguments: { op, ...args } } }),
  }).then((r) => r.text()).catch(() => "aborted");
  await sleep(400);
  ac.abort();
  await pending;
  // Detect a still-running wait by its polling of the mock device: each poll (every 100 ms) replaces
  // `state.lastRequest`. A cancelled call goes quiet; an uncancelled one keeps polling until its 20 s
  // timeout. The call counts as cancelled when the mock sees no request for 1 s within 8 s of the
  // disconnect, so a cancellation delayed by a loaded machine is not mistaken for a call that runs on.
  const abortedAt = Date.now();
  while (Date.now() - abortedAt < STOP_DEADLINE_MS) {
    const seen = server.mock.state.lastRequest;
    await sleep(QUIET_MS);
    if (server.mock.state.lastRequest === seen) return true;
  }
  console.log(`${op}: the mock was still polled ${STOP_DEADLINE_MS} ms after the disconnect; last request ${server.mock.state.lastRequest?.method} ${server.mock.state.lastRequest?.url}`);
  return false;
}
const QUIET_MS = 1000;
const STOP_DEADLINE_MS = 8000;

// The supported server runtime is Node (package.json engines). Bun's node:http server does not report a
// client disconnect, so these tests run the server under Node even when the test runner is Bun.
const SERVER_EXEC = process.versions.bun ? "node" : process.execPath;
const bunExecutable = process.versions.bun ? process.execPath : spawnSync("bun", ["--version"]).status === 0 ? "bun" : undefined;

test("HTTP transport under Bun warns that a client disconnect does not cancel a call", { timeout: 60_000, skip: bunExecutable ? false : "bun is not installed" }, async (t) => {
  const server = await startServer(t, { transport: "http", execPath: bunExecutable });
  assert.match(server.getStderr(), /HTTP transport is running under Bun/);
});

test("HTTP transport under Node does not print the Bun warning", { timeout: 60_000 }, async (t) => {
  const server = await startServer(t, { transport: "http", execPath: SERVER_EXEC });
  assert.ok(!/HTTP transport is running under Bun/.test(server.getStderr()));
});

test("legacy HTTP client disconnect cancels a long wait_for_text repeatedly", { timeout: 120_000 }, async (t) => {
  const server = await startServer(t, { transport: "http", execPath: SERVER_EXEC });
  let stillRunning = 0;
  for (let i = 0; i < RUNS; i++) {
    if (!(await disconnectOnce(server, "wait_for_text", { pattern: "NEVERAPPEARS", timeoutMs: 20000 }))) stillRunning++;
  }
  console.log(server.getStderr().split("\n").slice(-8).join("\n"));
  console.log(`wait_for_text still running after disconnect: ${stillRunning}/${RUNS}`);
  assert.equal(stillRunning, 0);
});

test("legacy HTTP client disconnect cancels a long wait_until repeatedly", { timeout: 120_000 }, async (t) => {
  const server = await startServer(t, { transport: "http", execPath: SERVER_EXEC });
  let stillRunning = 0;
  for (let i = 0; i < RUNS; i++) {
    if (!(await disconnectOnce(server, "wait_until", { condition: { type: "equals", address: "$C000", bytes: "01" }, timeoutMs: 20000 }))) stillRunning++;
  }
  console.log(`wait_until still running after disconnect: ${stillRunning}/${RUNS}`);
  assert.equal(stillRunning, 0);
});
