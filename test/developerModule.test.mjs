import test from "#test/runner";
import assert from "#test/assert";
import { developerModule } from "../src/tools/developer.js";

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

const platform = (process.env.C64_MODE ?? "").toLowerCase() === "vice" ? "vice" : "c64u";
const isVice = platform === "vice";
const testC64uOnly = isVice ? test.skip : test;

test("config_list returns categories", async () => {
  const ctx = {
    client: {
      async configsList() {
        return { categories: ["Audio", "Video"] };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("config_list", {}, ctx);

  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), {
    categories: ["Audio", "Video"],
  });
  assert.equal(result.structuredContent.type, "json");
  assert.deepEqual(result.structuredContent.data, {
    categories: ["Audio", "Video"],
  });
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.categoryCount, 2);
});

test("config_get forwards category and item", async () => {
  const calls = [];
  const ctx = {
    client: {
      async configGet(category, item) {
        calls.push({ category, item });
        return { Volume: "10" };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke(
    "config_get",
    { category: "Audio", item: "Volume" },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), {
    value: { Volume: "10" },
  });
  assert.equal(result.structuredContent.type, "json");
  assert.deepEqual(result.structuredContent.data, {
    value: { Volume: "10" },
  });
  assert.deepEqual(calls, [{ category: "Audio", item: "Volume" }]);
});

test("config_set reports firmware failure", async () => {
  const ctx = {
    client: {
      async configSet() {
        return { success: false, details: { reason: "denied" } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke(
    "config_set",
    { category: "Audio", item: "Volume", value: 8 },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "execution");
  assert.deepEqual(result.metadata.error.details, { reason: "denied" });
});

test("config_batch_update validates payload", async () => {
  const ctx = {
    client: {
      async configBatchUpdate() {
        throw new Error("should not run");
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("config_batch_update", {}, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
});

test("config_list normalizes non-object payloads", async () => {
  const ctx = {
    client: {
      async configsList() {
        return ["Audio", "Video"];
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("config_list", {}, ctx);

  assert.equal(result.structuredContent.type, "json");
  assert.deepEqual(result.structuredContent.data, {
    categories: ["Audio", "Video"],
  });
  assert.equal(result.metadata.categoryCount, 2);
});

test("config_get reads category without item", async () => {
  const calls = [];
  const ctx = {
    client: {
      async configGet(category, item) {
        calls.push({ category, item });
        return { Palette: "colodore" };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke(
    "config_get",
    { category: "Video" },
    ctx,
  );

  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.category, "Video");
  assert.equal(result.metadata.item, null);
  assert.deepEqual(result.structuredContent.data, {
    value: { Palette: "colodore" },
  });
  assert.deepEqual(calls, [{ category: "Video", item: undefined }]);
});

test("config_set stringifies primitive values on success", async () => {
  const calls = [];
  const ctx = {
    client: {
      async configSet(category, item, value) {
        calls.push({ category, item, value });
        return { success: true, details: { updated: true } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke(
    "config_set",
    { category: "Audio", item: "Muted", value: false },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.value, false);
  assert.deepEqual(result.metadata.details, { updated: true });
  assert.deepEqual(calls, [{ category: "Audio", item: "Muted", value: "false" }]);
});

test("config_batch_update stringifies nested primitive values on success", async () => {
  const calls = [];
  const ctx = {
    client: {
      async configBatchUpdate(payload) {
        calls.push(payload);
        return { success: true, details: { applied: 2 } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke(
    "config_batch_update",
    { Audio: { Volume: 10, Muted: false } },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.categoryCount, 1);
  assert.deepEqual(result.metadata.details, { applied: 2 });
  assert.deepEqual(calls, [{ Audio: { Volume: "10", Muted: "false" } }]);
});

test("config_batch_update rejects non-primitive values", async () => {
  const ctx = {
    client: {
      async configBatchUpdate() {
        throw new Error("should not run");
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke(
    "config_batch_update",
    { Audio: { Filters: ["on"] } },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
});

testC64uOnly("config_reset_to_default succeeds", async () => {
  const ctx = {
    client: {
      async configResetToDefault() {
        return { success: true, details: { rebootRequired: true } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("config_reset_to_default", {}, ctx);

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
  assert.deepEqual(result.metadata.details, { rebootRequired: true });
});

test("info returns diagnostics payload", async () => {
  const ctx = {
    client: {
      async info() {
        return { emulator: "vice", port: 6502 };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("info", {}, ctx);

  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), { emulator: "vice", port: 6502 });
  assert.deepEqual(result.structuredContent?.data, { emulator: "vice", port: 6502 });
  assert.deepEqual(result.metadata.details, { emulator: "vice", port: 6502 });
});

testC64uOnly("debugreg_read returns uppercase value", async () => {
  const ctx = {
    client: {
      async debugregRead() {
        return { success: true, value: "1a", details: { raw: "1a" } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("debugreg_read", {}, ctx);

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.value, "1A");
  assert.deepEqual(result.metadata.details, { raw: "1a" });
});

testC64uOnly("debugreg_read reports firmware failure", async () => {
  const ctx = {
    client: {
      async debugregRead() {
        return { success: false, details: { raw: "ff" } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("debugreg_read", {}, ctx);

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "execution");
  assert.deepEqual(result.metadata.error.details, { raw: "ff" });
});

testC64uOnly("debugreg_write validates input", async () => {
  const ctx = {
    client: {
      async debugregWrite() {
        throw new Error("should not run");
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("debugreg_write", {}, ctx);

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
});

testC64uOnly("debugreg_write normalizes hex value on success", async () => {
  const calls = [];
  const ctx = {
    client: {
      async debugregWrite(value) {
        calls.push(value);
        return { success: true, details: { latched: value } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("debugreg_write", { value: "0f" }, ctx);

  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.value, "0F");
  assert.deepEqual(result.metadata.details, { latched: "0F" });
  assert.deepEqual(calls, ["0F"]);
});

testC64uOnly("debugreg_write reports firmware failure", async () => {
  const ctx = {
    client: {
      async debugregWrite() {
        return { success: false, details: "write failed" };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("debugreg_write", { value: "AA" }, ctx);

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "execution");
  assert.deepEqual(result.metadata.error.details, { value: "write failed" });
});

test("version returns firmware payload", async () => {
  const ctx = {
    client: {
      async version() {
        return { version: "1.2.3" };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("version", {}, ctx);

  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), { version: "1.2.3" });
  assert.equal(result.structuredContent?.type, "json");
  assert.deepEqual(result.structuredContent?.data, { version: "1.2.3" });
});

test("version wraps primitive payloads into objects", async () => {
  const ctx = {
    client: {
      async version() {
        return "1.2.4";
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("version", {}, ctx);

  assert.deepEqual(result.structuredContent?.data, { value: "1.2.4" });
  assert.deepEqual(result.metadata.details, { value: "1.2.4" });
});

test("config_set with firmware failure", async () => {
  const ctx = {
    client: {
      async configSet() {
        return { success: false, details: { error: "invalid value" } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke(
    "config_set",
    { category: "Test", item: "Item", value: "bad" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("backend reported failure"));
});

test("config_batch_update with firmware failure", async () => {
  const ctx = {
    client: {
      async configBatchUpdate() {
        return { success: false, details: { error: "batch failed" } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke(
    "config_batch_update",
    { Audio: { Volume: "10" } },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("batch configuration update"));
});

testC64uOnly("config_load_from_flash success", async () => {
  const ctx = {
    client: {
      async configLoadFromFlash() {
        return { success: true, details: { loaded: true } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("config_load_from_flash", {}, ctx);

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
});

testC64uOnly("config_load_from_flash failure", async () => {
  const ctx = {
    client: {
      async configLoadFromFlash() {
        return { success: false, details: { error: "flash read error" } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("config_load_from_flash", {}, ctx);

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("backend reported failure"));
});

testC64uOnly("config_save_to_flash success", async () => {
  const ctx = {
    client: {
      async configSaveToFlash() {
        return { success: true, details: { saved: true } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("config_save_to_flash", {}, ctx);

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
});

testC64uOnly("config_save_to_flash failure", async () => {
  const ctx = {
    client: {
      async configSaveToFlash() {
        return { success: false, details: { error: "flash write error" } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("config_save_to_flash", {}, ctx);

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("backend reported failure"));
});

testC64uOnly("config_reset_to_default failure", async () => {
  const ctx = {
    client: {
      async configResetToDefault() {
        return { success: false, details: { error: "reset failed" } };
      },
    },
    logger: createLogger(),
  };

  const result = await developerModule.invoke("config_reset_to_default", {}, ctx);

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("backend reported failure"));
});

if (isVice) {
  test("developer tools are unavailable on vice", async () => {
    const ctx = {
      client: {
        async configSaveToFlash() {
          throw new Error("should not run");
        },
      },
      logger: createLogger(),
      platform: { id: /** @type {"vice"} */ ("vice"), features: [], limitedFeatures: [] },
    };

    await assert.rejects(
      () => developerModule.invoke("config_save_to_flash", {}, ctx),
      (error) => error?.name === "ToolUnsupportedPlatformError",
    );
  });
}
