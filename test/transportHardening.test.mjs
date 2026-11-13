import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "#test/runner";
import assert from "#test/assert";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";
import { C64Client } from "../src/c64Client.js";
import { RequestQueue, createLoggingHttpClient } from "../src/loggingHttpClient.js";
import { assertMonitorPortFree, startViceProcess, waitForPort } from "../src/vice/process.js";
import { createFacade, probeUltimateReachable } from "../src/device.js";

async function closedLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startStatusServer(statusFor, seen = []) {
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, password: req.headers["x-password"] });
    res.statusCode = statusFor(req.url);
    res.end("x");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withEnv(overrides, fn) {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("R-09 reachability probe treats any HTTP response as reachable and requests /v1/version", async (t) => {
  for (const status of [200, 403, 404]) {
    const seen = [];
    const s = await startStatusServer(() => status, seen);
    t.after(() => s.close());
    assert.equal(await probeUltimateReachable(`http://127.0.0.1:${s.port}/proxy/`, 1000, "sesame"), true, `status ${status}`);
    assert.deepEqual(seen, [{ url: "/proxy/v1/version", password: "sesame" }]);
  }
  const port = await closedLoopbackPort();
  assert.equal(await probeUltimateReachable(`http://127.0.0.1:${port}`, 1000), false);
});

test("R-08 an endpoint environment variable selects c64u even when the device is offline", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "c64-r08-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "empty.json");
  writeFileSync(file, "{}", "utf8");
  const port = await closedLoopbackPort();
  await withEnv({
    C64BRIDGE_CONFIG: file,
    C64_MODE: undefined,
    C64U_HOST: "127.0.0.1",
    C64U_PORT: String(port),
    C64U_PASSWORD: undefined,
    U2_HOST: undefined,
    U2_PORT: undefined,
    U2_PASSWORD: undefined,
  }, async () => {
    const { facade, selected } = await createFacade();
    assert.equal(selected, "c64u");
    assert.equal(facade.type, "c64u");
    assert.equal(await facade.ping(), false);
  });
});

// ---- R-06 request serialisation -------------------------------------------

test("R-06 parallel facade calls reach the device one at a time, in call order", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const { facade } = await createFacade(undefined, { preferredC64uBaseUrl: mock.baseUrl });
  mock.state.responseDelayMs = 15;
  mock.state.maxInFlight = 0;
  mock.state.requestOrder.length = 0;

  const blocks = Array.from({ length: 8 }, (_, index) => ({ address: 0x2000 + index * 0x10, bytes: Uint8Array.of(index + 1) }));
  await Promise.all([
    facade.writeMemoryBlocks(blocks),
    facade.readMemory(0x0400, 4),
    facade.ping(),
    facade.readMemory(0x0500, 4),
  ]);

  assert.equal(mock.state.maxInFlight, 1);
  const writes = mock.state.requestOrder.filter((entry) => entry.includes("writemem"));
  assert.equal(writes.length, 8);
  const addresses = writes.map((entry) => /address=([0-9A-F]+)/i.exec(entry)[1].toUpperCase());
  assert.deepEqual(addresses, blocks.map((block) => block.address.toString(16).toUpperCase().padStart(4, "0")));
  assert.equal(mock.state.memory[0x2070], 8);
  // The ping probe went through the same queue (it is the third call made).
  assert.ok(mock.state.requestOrder.some((entry) => entry === "GET /v1/version"));
});

test("R-06 parallel C64Client reads never overlap on the device", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  mock.state.responseDelayMs = 10;
  mock.state.maxInFlight = 0;
  await Promise.all([
    client.readMemory("$0400", "4"),
    client.readMemory("$0500", "4"),
    client.readMemory("$0600", "4"),
  ]);
  assert.equal(mock.state.maxInFlight, 1);
});

test("R-06 a failed request releases the queue", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const { facade } = await createFacade(undefined, { preferredC64uBaseUrl: mock.baseUrl });
  const failing = facade.loadPrgFile("/nope").catch((error) => error);
  const results = await Promise.all([failing, facade.readMemory(0x0400, 2)]);
  assert.ok(results[1] instanceof Uint8Array);

  const queue = new RequestQueue();
  const order = [];
  await Promise.allSettled([
    queue.run(async () => { order.push("a"); throw new Error("boom"); }),
    queue.run(async () => { order.push("b"); }),
  ]);
  assert.deepEqual(order, ["a", "b"]);
});

test("R-06 time spent waiting in the queue does not count against a request timeout", async (t) => {
  let active = 0;
  let max = 0;
  const server = http.createServer((req, res) => {
    active += 1;
    max = Math.max(max, active);
    setTimeout(() => {
      active -= 1;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    }, 80);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = createLoggingHttpClient({ baseURL: `http://127.0.0.1:${server.address().port}`, timeout: 150 }, undefined, new RequestQueue());
  // Four requests of 80 ms each take 320 ms in total; the last one waits 240 ms,
  // longer than the 150 ms timeout, yet must not time out.
  // The generated client sends every request through `instance.request`.
  const get = (http) => http.instance.request({ url: "/x", method: "get" });
  const results = await Promise.all([1, 2, 3, 4].map(() => get(client)));
  assert.equal(results.length, 4);
  assert.equal(max, 1);

  // A timed-out request releases the queue for the next one.
  const slow = createLoggingHttpClient({ baseURL: `http://127.0.0.1:${server.address().port}`, timeout: 20 }, undefined, new RequestQueue());
  const settled = await Promise.allSettled([get(slow), get(slow)]);
  assert.deepEqual(settled.map((entry) => entry.status), ["rejected", "rejected"]);
});

test("R-06 the backend and C64Client's fallback HTTP client share one queue per device", async (t) => {
  let active = 0;
  let max = 0;
  const server = http.createServer((req, res) => {
    active += 1;
    max = Math.max(max, active);
    setTimeout(() => {
      active -= 1;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    }, 40);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new C64Client(baseUrl);
  const facade = await client.pinFacade();
  // C64Client's own client (used for the readmem/writemem fallbacks) and the backend's client.
  const own = client.http.instance.request({ url: "/v1/version", method: "get" });
  const backend = facade.version();
  await Promise.all([own, backend, client.http.instance.request({ url: "/v1/info", method: "get" })]);
  assert.equal(max, 1);
});

test("R-06 a request that fails before it is sent releases the queue", async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = createLoggingHttpClient({ baseURL: `http://127.0.0.1:${server.address().port}`, timeout: 500 }, undefined, new RequestQueue());
  // A BigInt body cannot be serialised, so axios fails in transformRequest,
  // before the adapter is called.
  await assert.rejects(client.instance.request({ url: "/x", method: "post", data: { value: 1n } }));
  const next = await Promise.race([
    client.instance.request({ url: "/x", method: "get" }).then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("stalled"), 1000)),
  ]);
  assert.equal(next, "completed");
});

// ---- R-07 pause ownership -------------------------------------------------

// ---- R-07 pause ownership -------------------------------------------------

import { metaModule } from "../src/tools/meta/index.js";
import { machineControlModule } from "../src/tools/machineControl.js";

const quietLogger = () => ({ debug() {}, info() {}, warn(...args) { quietLogger.warnings.push(args); }, error() {} });
quietLogger.warnings = [];

function deviceCalls(mock, suffix) {
  return mock.state.requestOrder.filter((entry) => entry === `PUT /v1/machine:${suffix}`).length;
}

async function writeCall(ctx, address, byte) {
  return metaModule.invoke("verify_and_write_memory", { address, bytes: `$${byte}` }, ctx);
}

test("R-07 overlapping tool calls send one device pause and one device resume", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const ctx = { platform: { id: "c64u" }, client, logger: quietLogger() };
  mock.state.responseDelayMs = 10;
  mock.state.requestOrder.length = 0;
  const results = await Promise.all([writeCall(ctx, "$0400", "AA"), writeCall(ctx, "$0410", "BB"), writeCall(ctx, "$0420", "CC")]);
  for (const result of results) assert.equal(result.metadata?.success, true, JSON.stringify(result.content));
  assert.equal(deviceCalls(mock, "pause"), 1);
  assert.equal(deviceCalls(mock, "resume"), 1);
  assert.equal(mock.state.paused, false);
});

test("R-07 an explicit pause survives a tool call that pauses and resumes", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const ctx = { platform: { id: "c64u" }, client, logger: quietLogger() };

  const paused = await machineControlModule.invoke("pause", {}, ctx);
  assert.equal(paused.isError, undefined);
  mock.state.requestOrder.length = 0;
  const written = await writeCall(ctx, "$0400", "AA");
  assert.equal(written.metadata?.success, true);
  assert.equal(deviceCalls(mock, "resume"), 0);
  assert.equal(mock.state.paused, true);

  const resumed = await machineControlModule.invoke("resume", {}, ctx);
  assert.equal(resumed.isError, undefined);
  assert.equal(mock.state.paused, false);
});

test("R-07 a reset ends an explicit pause, so the next tool call pauses the device itself", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const ctx = { platform: { id: "c64u" }, client, logger: quietLogger() };

  assert.equal((await machineControlModule.invoke("pause", {}, ctx)).isError, undefined);
  assert.equal((await machineControlModule.invoke("reset_c64", {}, ctx)).isError, undefined);
  mock.state.requestOrder.length = 0;
  const written = await writeCall(ctx, "$0400", "AA");
  assert.equal(written.metadata?.success, true, JSON.stringify(written.content));
  assert.equal(deviceCalls(mock, "pause"), 1);
  assert.equal(deviceCalls(mock, "resume"), 1);
});

test("R-07 an explicit resume during a tool call leaves the device resume to the call", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const facade = await client.pinFacade();
  assert.equal((await client.acquirePause(facade)).success, true);
  await client.explicitPause(facade);
  await client.explicitResume(facade);
  assert.equal(mock.state.paused, true);
  assert.equal((await client.releasePause(facade)).success, true);
  assert.equal(mock.state.paused, false);
});

test("R-07 the resume goes to the facade pinned at the start even if the backend switches", async () => {
  const calls = [];
  const makeFacade = (name) => ({
    pause: async () => { calls.push(`${name}:pause`); return { success: true }; },
    resume: async () => { calls.push(`${name}:resume`); return { success: true }; },
  });
  const a = makeFacade("a");
  const b = makeFacade("b");
  let active = a;
  const real = new C64Client("http://127.0.0.1:9", { forceC64uFacade: true });
  const client = {
    pinFacade: async () => active,
    acquirePause: (f) => real.acquirePause(f),
    releasePause: (f) => real.releasePause(f),
    pause: async () => ({ success: true }),
    resume: async () => ({ success: true }),
    async readMemory() { active = b; return { success: true, data: "$AA" }; },
    async writeMemory() { return { success: true }; },
  };
  const ctx = { platform: { id: "c64u" }, client, logger: quietLogger() };
  const result = await writeCall(ctx, "$0400", "AA");
  assert.equal(result.metadata?.success, true, JSON.stringify(result.content));
  assert.deepEqual(calls, ["a:pause", "a:resume"]);
});

test("R-07 a failed resume is reported as a warning in the result", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const logger = quietLogger();
  quietLogger.warnings.length = 0;
  const ctx = { platform: { id: "c64u" }, client, logger };
  mock.state.forcedErrors = ["resume refused"];
  mock.state.forcedErrorsUrlMatch = "machine:resume";
  const result = await writeCall(ctx, "$0400", "AA");
  assert.equal(result.metadata?.success, true, JSON.stringify(result.content));
  const payload = JSON.stringify(result.structuredContent ?? result.content);
  assert.match(payload, /could not be resumed/);
  assert.ok(quietLogger.warnings.length >= 1);
});

// ---- R-13 video capture -----------------------------------------------------


test("R-13 a failed stream stop after a successful capture is a warning, not a failure", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  mock.state.forcedErrors = ["stop refused"];
  mock.state.forcedErrorsUrlMatch = "video:stop";
  const result = await client.captureFrames({ count: 1 });
  assert.equal(result.frames.length, 1);
  assert.equal(result.warnings?.length, 1);
  assert.match(result.warnings[0], /stop/);
});

test("R-13 a failed stream stop does not mask the capture error", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const facade = await client.pinFacade();
  // Start "succeeds" but no packets are ever sent, so the capture times out; stop fails too.
  const stub = Object.create(facade);
  stub.streamStart = async () => ({ success: true });
  stub.streamStop = async () => ({ success: false, details: { errors: ["stop refused"] } });
  await assert.rejects(() => client.captureC64uVideoFrames(stub, 1), /Timed out/);
});

test("R-13 capture fails clearly when no local address reaches a non-loopback device", async () => {
  const client = new C64Client("http://127.0.0.1:9");
  // An invalid host argument makes the route lookup fail without any network traffic.
  await assert.rejects(() => client.resolveLocalCaptureAddress({}, false), /Cannot find a local network address/);
  assert.equal(await client.resolveLocalCaptureAddress({}, true), "127.0.0.1");
});

test("R-13 capture accepts packets only from the device address", async () => {
  const client = new C64Client("http://127.0.0.1:9");
  const loopback = await client.resolveCaptureEndpoint("127.0.0.1");
  assert.equal(loopback.acceptsSource("127.0.0.1"), true);
  assert.equal(loopback.acceptsSource("192.0.2.9"), false);
  // A non-loopback IP literal needs no DNS. The route lookup may legitimately fail on a host without a route.
  try {
    const remote = await client.resolveCaptureEndpoint("192.0.2.5");
    assert.equal(remote.acceptsSource("192.0.2.5"), true);
    assert.equal(remote.acceptsSource("192.0.2.6"), false);
    assert.equal(remote.acceptsSource("127.0.0.1"), false);
  } catch (error) {
    assert.match(error.message, /Cannot find a local network address/);
  }
});

test("R-13 packets from another source address are ignored", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const facade = await client.pinFacade();
  const stub = Object.create(facade);
  // Inject a packet from a non-loopback-range source would need a second interface; instead
  // verify the filter wiring: with the filter replaced to reject everything, nothing is captured.
  const original = client.resolveCaptureEndpoint.bind(client);
  client.resolveCaptureEndpoint = async (host) => ({ ...(await original(host)), acceptsSource: () => false });
  await assert.rejects(() => client.captureC64uVideoFrames(stub, 1), /Timed out/);
});

// ---- R-14 VICE monitor port already in use ---------------------------------

test("R-14 a foreign listener on the monitor port is detected before VICE is spawned", async (t) => {
  const listener = net.createServer((socket) => socket.end());
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const { port } = listener.address();

  // Confirms the defect: the readiness check is satisfied by the foreign listener.
  await waitForPort("127.0.0.1", port, 500);

  await assert.rejects(() => assertMonitorPortFree("127.0.0.1", port), new RegExp(`port ${port}`));
  // The check runs first: a binary that does not exist is never spawned.
  await assert.rejects(
    () => startViceProcess({ binary: "/nonexistent/x64sc", host: "127.0.0.1", port, headless: true }),
    new RegExp(`port ${port} on 127\\.0\\.0\\.1 is already in use`),
  );

  const free = await closedLoopbackPort();
  await assertMonitorPortFree("127.0.0.1", free);
});

// ---- reset while an explicit pause is held (Ultimate) ------------------------

function requestsAfter(mock, first, second) {
  const order = mock.state.requestOrder;
  const a = order.indexOf(first);
  const b = order.indexOf(second, a + 1);
  return a >= 0 && b > a;
}

{
  const platform = "c64u";
  test(`reset while explicitly paused resumes the machine afterwards on ${platform}`, async (t) => {
    const mock = await startMockC64Server();
    t.after(() => mock.close());
    const client = new C64Client(mock.baseUrl);
    const ctx = { platform: { id: platform }, client, logger: quietLogger() };

    assert.equal((await machineControlModule.invoke("pause", {}, ctx)).isError, undefined);
    assert.equal(mock.state.paused, true);
    mock.state.requestOrder.length = 0;
    const reset = await machineControlModule.invoke("reset_c64", {}, ctx);
    assert.equal(reset.isError, undefined, JSON.stringify(reset.content));
    assert.ok(requestsAfter(mock, "PUT /v1/machine:reset", "PUT /v1/machine:resume"), `order: ${mock.state.requestOrder.join(", ")}`);
    assert.equal(mock.state.paused, false);
    // The explicit flag is cleared: the next owned pause is sent to the device.
    mock.state.requestOrder.length = 0;
    assert.equal((await writeCall(ctx, "$0400", "AA")).metadata?.success, true);
    assert.equal(deviceCalls(mock, "pause"), 1);
  });
}

test("reset while explicitly paused resumes the machine on a u2 facade", async () => {
  const calls = [];
  const facade = {
    type: "u2",
    pause: async () => { calls.push("pause"); return { success: true }; },
    resume: async () => { calls.push("resume"); return { success: true }; },
    reset: async () => { calls.push("reset"); return { success: true, details: {} }; },
  };
  const client = new C64Client("http://127.0.0.1:9", { forceC64uFacade: true });
  client.facadePromise = Promise.resolve(facade);
  assert.equal((await client.explicitPause(facade)).success, true);
  assert.equal((await client.reset()).success, true);
  assert.deepEqual(calls, ["pause", "reset", "resume"]);
});

test("reboot while explicitly paused sends no resume", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const ctx = { platform: { id: "c64u" }, client, logger: quietLogger() };

  assert.equal((await machineControlModule.invoke("pause", {}, ctx)).isError, undefined);
  mock.state.requestOrder.length = 0;
  assert.equal((await machineControlModule.invoke("reboot_c64", {}, ctx)).isError, undefined);
  assert.equal(deviceCalls(mock, "reboot"), 1);
  assert.equal(deviceCalls(mock, "resume"), 0);
});

test("reset without a pause sends no resume", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const ctx = { platform: { id: "c64u" }, client, logger: quietLogger() };
  assert.equal((await machineControlModule.invoke("reset_c64", {}, ctx)).isError, undefined);
  assert.equal(deviceCalls(mock, "resume"), 0);
});

test("a failed resume after a reset is reported and keeps the explicit pause recorded", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const ctx = { platform: { id: "c64u" }, client, logger: quietLogger() };

  assert.equal((await machineControlModule.invoke("pause", {}, ctx)).isError, undefined);
  mock.state.forcedErrors = ["resume refused"];
  mock.state.forcedErrorsUrlMatch = "machine:resume";
  const reset = await machineControlModule.invoke("reset_c64", { waitForReady: true, readyTimeoutMs: 1000 }, ctx);
  assert.equal(reset.metadata?.success, true);
  assert.match(String(reset.metadata?.warning), /could not be resumed/);
  assert.match(JSON.stringify(reset.content), /could not be resumed/);
  assert.equal(mock.state.paused, true);
  // The flag still matches reality, so a later explicit resume works.
  mock.state.requestOrder.length = 0;
  assert.equal((await machineControlModule.invoke("resume", {}, ctx)).isError, undefined);
  assert.equal(deviceCalls(mock, "resume"), 1);
  assert.equal(mock.state.paused, false);
});
