import test from "#test/runner";
import assert from "#test/assert";
import http from "node:http";
import { createFacade } from "../src/device.ts";
import { C64Client } from "../src/c64Client.ts";
import { toolRegistry } from "../src/tools/registry/index.ts";

// DEVICE-5 (D2): the firmware's `errors` text reaches the error message, also on binary routes.

const routes = {
  "/v1/machine:readmem": [400, "Memory read exceeds location $FFFF"],
  "/v1/machine:menu_screen": [503, "No user interface"],
  "/v1/runners:run_prg": [404, "Cannot open file"],
  "/v1/configs/Audio%20Mixer/Vol%20UltiSid%201": [404, "Item not found"],
};

async function withDevice(fn) {
  const server = http.createServer((req, res) => {
    const hit = routes[req.url.split("?")[0]];
    if (hit) {
      res.writeHead(hit[0], { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ errors: [hit[1]] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"errors":[]}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("backend errors carry the firmware text, and a binary route's error body is decoded", async () => {
  await withDevice(async (baseUrl) => {
    const { facade } = await createFacade(undefined, { preferredC64uBaseUrl: baseUrl });
    await assert.rejects(facade.readMemory(0xfff0, 16), (error) =>
      error.message.endsWith(": Memory read exceeds location $FFFF")
      && error.response.status === 400
      && Array.isArray(error.response.data.errors));
    await assert.rejects(facade.readMenuScreen(), (error) => error.message.endsWith(": No user interface"));
    await assert.rejects(facade.runPrgFile("/Usb0/game.prg"), (error) => error.message.endsWith(": Cannot open file"));
  });
});

test("tool results name the firmware error in their text", async () => {
  await withDevice(async (baseUrl) => {
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    const ctx = {
      client: new C64Client(baseUrl),
      logger: quiet,
      rag: {},
      platform: { id: "c64u", features: [], limitedFeatures: [] },
      setPlatform: () => ({ id: "c64u", features: [], limitedFeatures: [] }),
    };
    const cases = [
      ["c64_memory", { op: "read", address: "$FFF0", length: 16 }, "Memory read exceeds location $FFFF"],
      ["c64_program", { op: "run_prg", path: "/Usb0/game.prg" }, "Cannot open file"],
      ["c64_config", { op: "get", category: "Audio Mixer", item: "Vol UltiSid 1" }, "Item not found"],
    ];
    for (const [tool, args, expected] of cases) {
      const result = await toolRegistry.invoke(tool, args, ctx);
      const text = result.content.map((entry) => entry.text).join(" ");
      assert.equal(result.isError, true, tool);
      assert.ok(text.includes(expected), `${tool}: ${text}`);
    }
  });
});
