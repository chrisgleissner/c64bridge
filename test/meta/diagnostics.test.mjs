import test from "#test/runner";
import assert from "#test/assert";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger } from "./helpers.mjs";

test("firmware_info_and_healthcheck reports healthy when endpoints work", async () => {
  const ctx = {
    client: {
      async version() { return { version: "1.0.0" }; },
      async info() { return { device: "u64" }; },
      async readMemory() { return { success: true, data: "$00", details: { address: "0000", length: 1 } }; },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("firmware_info_and_healthcheck", {}, ctx);
  assert.equal(res.structuredContent?.type, "json");
  assert.equal(res.metadata?.success, true);
  assert.equal(res.structuredContent?.data?.isHealthy, true);
});

test("firmware_info_and_healthcheck reports unhealthy on failures", async () => {
  const ctx = {
    client: {
      async version() { throw new Error("offline"); },
      async info() { return { device: "u64" }; },
      async readMemory() { return { success: true, data: "$00" }; },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("firmware_info_and_healthcheck", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.success, false);
  assert.equal(res.structuredContent?.data?.isHealthy, false);
});
