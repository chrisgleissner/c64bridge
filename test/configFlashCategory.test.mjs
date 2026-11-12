import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { developerModule } from "../src/tools/developer.js";
import { toolRegistry } from "../src/tools/registry/index.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("per-category flash operations touch only the named category on the mock", async () => {
  const mock = await startMockC64Server();
  try {
    const client = new C64Client(mock.baseUrl);
    await client.configSet("Audio", "Volume", "3");
    await client.configSet("Video", "Mode", "NTSC");

    assert.equal((await client.configSaveToFlash("Audio")).success, true);
    assert.deepEqual(mock.state.lastConfigAction, { action: "save_to_flash", category: "Audio" });
    assert.deepEqual(Object.keys(mock.state.flashSnapshot), ["Audio"]);

    await client.configSet("Audio", "Volume", "9");
    assert.equal((await client.configLoadFromFlash("Audio")).success, true);
    assert.equal(mock.state.configs.Audio.Volume, "3");
    assert.equal(mock.state.configs.Video.Mode, "NTSC", "other categories stay untouched");

    assert.equal((await client.configResetToDefault("Audio")).success, true);
    assert.equal(mock.state.configs.Audio.Volume, "6");
    assert.equal(mock.state.configs.Video.Mode, "NTSC");

    // The category is URL-encoded in the request path.
    assert.equal((await client.configSaveToFlash("U64 Specific Settings")).success, true);
    assert.equal(mock.state.lastConfigAction.category, "U64 Specific Settings");

    const missing = await client.configSaveToFlash("No Such Category");
    assert.equal(missing.success, false);

    // Whole-device forms are unchanged.
    assert.equal((await client.configResetToDefault()).success, true);
    assert.deepEqual(mock.state.lastConfigAction, { action: "reset_to_default" });
    assert.equal(mock.state.configs.Video.Mode, "PAL");
  } finally {
    await mock.close();
  }
});

test("c64_config flash ops pass category to the client and keep the destructive effect", async () => {
  const calls = [];
  const client = {
    async configLoadFromFlash(category) { calls.push(["load", category]); return { success: true }; },
    async configSaveToFlash(category) { calls.push(["save", category]); return { success: true }; },
    async configResetToDefault(category) { calls.push(["reset", category]); return { success: true }; },
  };
  const ctx = { client, logger, platform: { id: "c64u", features: [], limitedFeatures: [] } };
  await toolRegistry.invoke("c64_config", { op: "load_flash", category: "Audio" }, ctx);
  await toolRegistry.invoke("c64_config", { op: "save_flash", category: "Audio Mixer" }, ctx);
  const reset = await toolRegistry.invoke("c64_config", { op: "reset_defaults", category: "Video" }, ctx);
  await toolRegistry.invoke("c64_config", { op: "save_flash" }, ctx);
  assert.deepEqual(calls, [["load", "Audio"], ["save", "Audio Mixer"], ["reset", "Video"], ["save", undefined]]);
  assert.match(reset.content[0].text, /category Video/);

  const descriptor = toolRegistry.list().find((tool) => tool.name === "c64_config");
  for (const op of ["load_flash", "save_flash", "reset_defaults"]) {
    assert.equal(descriptor.metadata.operationEffects[op], "destructive");
    assert.deepEqual([...descriptor.metadata.operationPlatforms[op]].sort(), ["c64u", "u2"]);
  }

  const bad = await developerModule.invoke("config_save_to_flash", { category: "" }, ctx);
  assert.equal(bad.isError, true);
});
