import test from "#test/runner";
import assert from "#test/assert";
import http from "node:http";
import { Api } from "../generated/c64/index.js";
import { createLoggingHttpClient } from "../src/loggingHttpClient.js";

// HARD05-002: a REST response is bounded in size and total time.

async function withServer(handler, fn) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

const readmem = (client) => new Api(client).v1.machineReadmemList(":readmem", { address: "0400", length: 16 }, { format: "arraybuffer" });

test("a response body above maxContentLength is rejected while it streams", async () => {
  const chunk = Buffer.alloc(256 * 1024, 0x41);
  let written = 0;
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const pump = () => { while (written < 64 * 1024 * 1024 && res.write(chunk)) written += chunk.length; };
    res.on("drain", pump);
    pump();
    req.on("close", () => res.destroy());
  }, async (baseUrl) => {
    const client = createLoggingHttpClient({ baseURL: baseUrl, timeout: 5_000, maxContentLength: 1024 * 1024 });
    await assert.rejects(readmem(client), /maxContentLength/);
    assert.ok(written < 32 * 1024 * 1024, `server stopped near the limit (wrote ${written})`);
  });
});

test("a default client rejects a body above 16 MiB", async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x41);
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    let sent = 0;
    const pump = () => { while (sent < 18 && res.write(chunk)) sent += 1; if (sent >= 18) res.end(); };
    res.on("drain", pump);
    pump();
  }, async (baseUrl) => {
    const client = createLoggingHttpClient({ baseURL: baseUrl, timeout: 5_000 });
    await assert.rejects(readmem(client), /maxContentLength/);
  });
});

test("a body that trickles past the idle timeout ends at the total deadline", async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const timer = setInterval(() => res.write("x"), 20);
    res.on("close", () => clearInterval(timer));
  }, async (baseUrl) => {
    const client = createLoggingHttpClient({ baseURL: baseUrl, timeout: 5_000 }, undefined, undefined, { totalDeadlineMs: 300 });
    const started = Date.now();
    await assert.rejects(readmem(client), /total deadline/);
    assert.ok(Date.now() - started < 3_000);
  });
});

test("an ordinary response and a call with its own longer timeout still succeed", async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.alloc(16, 7));
  }, async (baseUrl) => {
    const client = createLoggingHttpClient({ baseURL: baseUrl, timeout: 5_000 });
    const response = await readmem(client);
    assert.equal(response.data.byteLength, 16);
    const longer = await new Api(client).v1.machineReadmemList(":readmem", { address: "0400", length: 16 }, { format: "arraybuffer", timeout: 200_000 });
    assert.equal(longer.data.byteLength, 16);
  });
});
