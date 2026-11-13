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
