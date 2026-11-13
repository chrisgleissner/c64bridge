import test from "#test/runner";
import assert from "#test/assert";
import http from "node:http";

process.env.C64BRIDGE_SKIP_AUTO_START = "1";
const { RequestQueue } = await import("../src/loggingHttpClient.js");
const { probeUltimateReachableQueued } = await import("../src/device.js");
const { logConnectivity } = await import("../src/mcp-server.js");

async function startSlowServer(delayMs = 150) {
  const state = { active: 0, max: 0, requests: 0 };
  const server = http.createServer((req, res) => {
    state.active += 1;
    state.requests += 1;
    state.max = Math.max(state.max, state.active);
    setTimeout(() => {
      state.active -= 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, delayMs);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { state, port, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function inFlightRequest(baseUrl, run) {
  const { default: axios } = await import("axios");
  const queued = RequestQueue.forDevice(baseUrl).run(() => axios.get(`${baseUrl}/v1/slow`));
  await new Promise((r) => setTimeout(r, 40));
  const probe = run();
  await Promise.all([queued, probe]);
}

test("startup connectivity probe waits for the per-device queue", async () => {
  const srv = await startSlowServer();
  try {
    const client = { getBackendType: async () => "c64u" };
    await inFlightRequest(srv.baseUrl, () => logConnectivity(client, srv.baseUrl));
    assert.equal(srv.state.requests, 2);
    assert.equal(srv.state.max, 1);
  } finally {
    await srv.close();
  }
});

test("fallback reachability probe waits for the per-device queue", async () => {
  const srv = await startSlowServer();
  try {
    await inFlightRequest(srv.baseUrl, async () => {
      assert.equal(await probeUltimateReachableQueued(srv.baseUrl, 2000), true);
    });
    assert.equal(srv.state.requests, 2);
    assert.equal(srv.state.max, 1);
  } finally {
    await srv.close();
  }
});

test("startup connectivity probe reports a 403 as an authentication failure, not as unreachable", async () => {
  const server = http.createServer((_req, res) => { res.writeHead(403); res.end("{}"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const lines = [];
  const originalError = console.error;
  console.error = (...args) => { lines.push(args.join(" ")); };
  try {
    let memoryReads = 0;
    const client = { getBackendType: async () => "c64u", readMemory: async () => { memoryReads += 1; return { success: false }; } };
    await logConnectivity(client, baseUrl);
    const text = lines.join("\n");
    assert.match(text, /authentication failed/i);
    assert.equal(/no hardware REST base reachable/.test(text), false);
    assert.equal(memoryReads, 0, "the zero-page probe is skipped when authentication fails");
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("device probes do not use HTTP proxies", async () => {
  const proxy = http.createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const target = http.createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  let proxied = 0;
  proxy.removeAllListeners("request");
  proxy.on("request", (_req, res) => { proxied += 1; res.writeHead(200); res.end("{}"); });
  try {
    process.env.HTTP_PROXY = process.env.http_proxy = `http://127.0.0.1:${proxy.address().port}`;
    delete process.env.NO_PROXY; delete process.env.no_proxy;
    const baseUrl = `http://127.0.0.1:${target.address().port}`;
    assert.equal(await probeUltimateReachableQueued(baseUrl, 2000), true);
    assert.equal(proxied, 0);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  }
});
