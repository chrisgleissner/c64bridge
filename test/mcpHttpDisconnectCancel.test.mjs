import test from "#test/runner";
import assert from "#test/assert";
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
  // Both runtimes log differently, so detect a still-running wait by its polling of the mock device:
  // each poll replaces `state.lastRequest`. Give the cancellation a moment, then watch for new polls.
  await sleep(700);
  const seen = server.mock.state.lastRequest;
  await sleep(1000);
  return server.mock.state.lastRequest === seen;
}

test("legacy HTTP client disconnect cancels a long wait_for_text repeatedly", { timeout: 120_000 }, async (t) => {
  const server = await startServer(t, { transport: "http", execPath: process.versions.bun ? "node" : process.execPath });
  let stillRunning = 0;
  for (let i = 0; i < RUNS; i++) {
    if (!(await disconnectOnce(server, "wait_for_text", { pattern: "NEVERAPPEARS", timeoutMs: 20000 }))) stillRunning++;
  }
  console.log(server.getStderr().split("\n").slice(-8).join("\n"));
  console.log(`wait_for_text still running after disconnect: ${stillRunning}/${RUNS}`);
  assert.equal(stillRunning, 0);
});

test("legacy HTTP client disconnect cancels a long wait_until repeatedly", { timeout: 120_000 }, async (t) => {
  const server = await startServer(t, { transport: "http", execPath: process.versions.bun ? "node" : process.execPath });
  let stillRunning = 0;
  for (let i = 0; i < RUNS; i++) {
    if (!(await disconnectOnce(server, "wait_until", { condition: { type: "equals", address: "$C000", bytes: "01" }, timeoutMs: 20000 }))) stillRunning++;
  }
  console.log(`wait_until still running after disconnect: ${stillRunning}/${RUNS}`);
  assert.equal(stillRunning, 0);
});
