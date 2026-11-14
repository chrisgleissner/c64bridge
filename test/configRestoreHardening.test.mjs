import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import { metaModule } from "../src/tools/meta/index.js";
import { developerModule } from "../src/tools/developer.js";
import { createLogger, tmpPath } from "./meta/helpers.mjs";

function makeClient(state) {
  return {
    async version() { return { version: "1.0.0" }; },
    async info() { return { device: "u64" }; },
    async configsList() {
      return { categories: Object.entries(state.firmware).map(([name, items]) => ({ name, items: Object.keys(items) })) };
    },
    async configGet(category, item) {
      state.reads.push(item ? `${category}/${item}` : category);
      const items = state.firmware[category] ?? {};
      if (!item) return { [category]: items };
      return { [category]: { [item]: items[item] } };
    },
    async configBatchUpdate(payload) { state.batches.push(payload); return { success: true }; },
    async configSaveToFlash() { state.saves += 1; return { success: true }; },
  };
}

function newState(firmware) {
  return { firmware, reads: [], batches: [], saves: 0 };
}

async function writeSnapshot(name, text) {
  const { file, dir } = tmpPath("config", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, text);
  return file;
}

test("restore rejects a __proto__ category and leaves Object.prototype unchanged", async () => {
  const state = newState({ Audio: { Volume: "10" } });
  const ctx = { platform: { id: "c64u" }, client: makeClient(state), logger: createLogger() };
  const file = await writeSnapshot("restore-proto.json", '{"categories":{"__proto__":{"polluted":"yes"}}}');
  const result = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file }, ctx);
  assert.notEqual(result.metadata?.success, true);
  assert.match(JSON.stringify(result), /__proto__/);
  assert.equal({}.polluted, undefined, "Object.prototype must not be modified");
  assert.equal(state.batches.length, 0);
});

test("restore and diff reject constructor and prototype names at category and item level", async () => {
  const state = newState({ Audio: { Volume: "10" } });
  const ctx = { platform: { id: "c64u" }, client: makeClient(state), logger: createLogger() };
  const cases = [
    '{"categories":{"constructor":{"Volume":"1"}}}',
    '{"categories":{"Audio":{"prototype":"1"}}}',
    '{"categories":{"Audio":{"Volume":{"Audio":{"__proto__":{"x":"1"}}}}}}',
  ];
  for (const [index, text] of cases.entries()) {
    const file = await writeSnapshot(`restore-unsafe-${index}.json`, text);
    for (const action of ["restore", "diff"]) {
      const result = await metaModule.invoke("config_snapshot_and_restore", { action, path: file }, ctx);
      assert.notEqual(result.metadata?.success, true, `${action} ${text}`);
    }
  }
  assert.equal(state.batches.length, 0);
});

test("config batch_update rejects __proto__ category names without polluting Object.prototype", async () => {
  const state = newState({ Audio: { Volume: "10" } });
  const ctx = { platform: { id: "c64u" }, client: makeClient(state), logger: createLogger() };
  const args = JSON.parse('{"updates":{"__proto__":{"polluted":"yes"}}}');
  const result = await developerModule.invoke("config_batch_update", args, ctx);
  assert.notEqual(result.metadata?.success, true);
  assert.equal({}.polluted, undefined);
  assert.equal(state.batches.length, 0);
});

function debugLogger() {
  const lines = [];
  const record = (...args) => lines.push(JSON.stringify(args));
  return { lines, info: record, warn: record, error: record, debug: record, isDebugEnabled: () => true };
}

test("debug HTTP logging never writes credential values from configuration responses", async () => {
  const { createLoggingHttpClient } = await import("../src/loggingHttpClient.js");
  const logger = debugLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);
  const onResponse = client.instance.interceptors.response.handlers[0].fulfilled;
  const meta = (path) => ({ startedAt: Date.now(), method: "GET", path });
  const cases = [
    ["/v1/configs/Network%20settings", { "Network settings": { "Network Password": "SECRET-A", "FTP Password": "SECRET-B", Hostname: "c64u" } }],
    ["/v1/configs/WiFi%20settings/Password", { "WiFi settings": { Password: { current: "SECRET-C", default: "SECRET-D" } } }],
    ["/v1/configs", JSON.stringify({ "Network settings": { "Telnet Password": "SECRET-E" } })],
  ];
  for (const [path, data] of cases) {
    onResponse({ status: 200, data, headers: {}, config: { method: "get", url: path, __c64Meta: meta(path) } });
  }
  const text = logger.lines.join("\n");
  for (const secret of ["SECRET-A", "SECRET-B", "SECRET-C", "SECRET-D", "SECRET-E"]) {
    assert.ok(!text.includes(secret), `${secret} must not be logged`);
  }
  assert.ok(text.includes("c64u"), "non-credential values stay visible");
});

test("debug HTTP logging redacts the value of a credential item write", async () => {
  const { createLoggingHttpClient } = await import("../src/loggingHttpClient.js");
  const logger = debugLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);
  const onResponse = client.instance.interceptors.response.handlers[0].fulfilled;
  const path = "/v1/configs/Network%20settings/Network%20Password?value=SECRET-F";
  onResponse({
    status: 200, data: { errors: [] }, headers: {},
    config: { method: "put", url: path, __c64Meta: { startedAt: Date.now(), method: "PUT", path, params: { value: "SECRET-F" } } },
  });
  assert.ok(!logger.lines.join("\n").includes("SECRET-F"));
});

test("restore of a snapshot reads only the categories the snapshot contains", async () => {
  const state = newState({
    Audio: { Volume: "10" },
    "Network settings": { "Network Password": "SECRET-G", Hostname: "c64u" },
  });
  const ctx = { platform: { id: "c64u" }, client: makeClient(state), logger: createLogger() };
  const file = await writeSnapshot("restore-audio-only.json", JSON.stringify({
    categories: { Audio: { Volume: { Audio: { Volume: "7" } } } },
  }));
  const result = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file }, ctx);
  assert.equal(result.metadata?.success, true);
  assert.deepEqual(state.batches, [{ Audio: { Volume: "7" } }]);
  assert.ok(state.reads.every((read) => read.startsWith("Audio")), `unexpected reads: ${state.reads.join(", ")}`);
});
