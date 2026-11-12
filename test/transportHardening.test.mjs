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
  const results = await Promise.all([1, 2, 3, 4].map(() => client.instance.get("/x")));
  assert.equal(results.length, 4);
  assert.equal(max, 1);

  // A timed-out request releases the queue for the next one.
  const slow = createLoggingHttpClient({ baseURL: `http://127.0.0.1:${server.address().port}`, timeout: 20 }, undefined, new RequestQueue());
  const settled = await Promise.allSettled([slow.instance.get("/x"), slow.instance.get("/x")]);
  assert.deepEqual(settled.map((entry) => entry.status), ["rejected", "rejected"]);
});
