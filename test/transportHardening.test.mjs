import http from "node:http";
import net from "node:net";
import test from "#test/runner";
import assert from "#test/assert";
import { probeUltimateReachable } from "../src/device.js";

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

