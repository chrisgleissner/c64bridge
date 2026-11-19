import test from "#test/runner";
import assert from "#test/assert";
import http from "node:http";
import { C64Client } from "../src/c64Client.js";
import { toolRegistry } from "../src/tools/registry/index.js";

// HARD05-008: a memory read returns exactly the requested bytes or fails.

const logger = { debug() {}, info() {}, warn() {}, error() {} };

async function withDevice(readmem, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url.split("?")[0]}`);
    if (req.url.startsWith("/v1/machine:readmem")) {
      const { status = 200, type = "application/octet-stream", body } = readmem(new URL(req.url, "http://x").searchParams);
      res.writeHead(status, { "content-type": type });
      res.end(body);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"errors":[]}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(new C64Client(`http://127.0.0.1:${server.address().port}`), seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("readMemoryRaw accepts an exact read, including the last address", async () => {
  await withDevice((q) => ({ body: Buffer.alloc(Number(q.get("length")), 0x42) }), async (client) => {
    assert.equal((await client.readMemoryRaw(0x0400, 16)).length, 16);
    assert.equal((await client.readMemoryRaw(0xffff, 1)).length, 1);
    const result = await client.readMemory("$FFF0", "16");
    assert.equal(result.success, true);
  });
});

test("short, long and JSON error bodies are errors", async () => {
  const bodies = {
    short: () => ({ body: Buffer.alloc(3) }),
    long: () => ({ body: Buffer.alloc(40) }),
    empty: () => ({ body: Buffer.alloc(0) }),
    jsonError: () => ({ type: "application/json", body: JSON.stringify({ errors: ["Address out of range"] }) }),
  };
  for (const [name, handler] of Object.entries(bodies)) {
    await withDevice(handler, async (client) => {
      await assert.rejects(client.readMemoryRaw(0x0400, 16), /bytes instead of|without data/, name);
      const result = await client.readMemory("$0400", "16");
      assert.equal(result.success, false, name);
    });
  }
  await withDevice(bodies.jsonError, async (client) => {
    await assert.rejects(client.readMemoryRaw(0x0400, 16), /Address out of range/);
  });
});

test("copy_memory stops before the write when the read is not the requested length", async () => {
  await withDevice(() => ({ body: Buffer.alloc(40) }), async (client, seen) => {
    const platform = { id: "c64u", features: [], limitedFeatures: [] };
    const ctx = { client, logger, rag: {}, platform, setPlatform: () => platform };
    const result = await toolRegistry.invoke("c64_memory", { op: "copy_memory", source: "$0400", dest: "$C000", length: 16 }, ctx);
    assert.equal(result.isError, true);
    assert.equal(seen.filter((entry) => entry.includes("writemem")).length, 0);
  });
});
