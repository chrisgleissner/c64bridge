import test from "#test/runner";
import assert from "#test/assert";
import http from "node:http";
import { createFacade, probeUltimateReachable } from "../src/device.ts";

// DEVICE-7 (D4): no redirect from the device is followed, so X-Password never reaches another host.

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

async function withRedirectingDevice(fn) {
  const reached = [];
  const target = await listen((req, res) => {
    reached.push({ url: req.url, password: req.headers["x-password"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"errors":[]}');
  });
  const device = await listen((req, res) => {
    res.writeHead(307, { location: `http://localhost:${target.port}/elsewhere${req.url}` });
    res.end();
  });
  try {
    await fn(`http://127.0.0.1:${device.port}`, reached);
  } finally {
    await new Promise((resolve) => device.server.close(resolve));
    await new Promise((resolve) => target.server.close(resolve));
  }
}

test("a REST call does not follow a redirect from the device", async () => {
  await withRedirectingDevice(async (baseUrl, reached) => {
    const { facade } = await createFacade(undefined, { preferredC64uBaseUrl: baseUrl, preferredC64uNetworkPassword: "s3cret-pw" });
    await assert.rejects(facade.reset(), (error) => error?.response?.status === 307);
    await assert.rejects(facade.writeMemory(0x0400, new Uint8Array(200)), (error) => error?.response?.status === 307);
    assert.deepEqual(reached, []);
  });
});

test("the reachability probe does not follow a redirect either", async () => {
  await withRedirectingDevice(async (baseUrl, reached) => {
    assert.equal(await probeUltimateReachable(baseUrl, 2000, "s3cret-pw"), true);
    assert.deepEqual(reached, []);
  });
});
