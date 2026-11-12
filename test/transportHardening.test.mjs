import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "#test/runner";
import assert from "#test/assert";
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
