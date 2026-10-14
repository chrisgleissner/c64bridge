import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./helpers.mjs";

test("verify_and_write_memory writes and verifies", async () => {
  let written = false;
  let paused = false;
  let resumed = false;
  const ctx = {
    platform: { id: "c64u" },
    client: {
      async pause() { paused = true; return { success: true }; },
      async resume() { resumed = true; return { success: true }; },
      async readMemory() {
        if (!written) return { success: true, data: "$0000" };
        return { success: true, data: "$AA55" };
      },
      async writeMemory(addr, bytes) { assert.equal(bytes, "$AA55"); written = true; return { success: true }; },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("verify_and_write_memory", { address: "$0400", expected: "$0000", bytes: "$AA55" }, ctx);
  assert.equal(res.metadata?.success, true);
  assert.equal(paused, true);
  assert.equal(resumed, true);
});

test("verify_and_write_memory accepts a $ prefix on each byte group", async () => {
  let written = false;
  const ctx = {
    platform: { id: "c64u" },
    client: {
      async pause() { return { success: true }; },
      async resume() { return { success: true }; },
      async readMemory() { return { success: true, data: written ? "$AA55" : "$0000" }; },
      async writeMemory(addr, bytes) { assert.equal(bytes, "$AA55"); written = true; return { success: true }; },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("verify_and_write_memory", { address: "$0400", expected: "$00 $00", bytes: "$AA $55" }, ctx);
  assert.equal(res.metadata?.success, true, JSON.stringify(res.content));
  assert.equal(written, true);
});

test("verify_and_write_memory aborts on pre-verify mismatch", async () => {
  let resumed = false;
  const ctx = {
    platform: { id: "c64u" },
    client: {
      async pause() { return { success: true }; },
      async resume() { resumed = true; return { success: true }; },
      async readMemory() { return { success: true, data: "$0102" }; },
      async writeMemory() { throw new Error("should not write"); },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("verify_and_write_memory", { address: "$0400", expected: "$0000", bytes: "$AA55" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
  assert.equal(resumed, true);
});

test("memory_dump_to_file writes hex and manifest", async () => {
  const { file, dir } = tmpPath("memory", "dump.hex");
  await fs.mkdir(dir, { recursive: true });
  const ctx = {
    client: {
      async pause() { return { success: true }; },
      async resume() { return { success: true }; },
      async readMemory(address, length) {
        const len = Number(length);
        const bytes = Array.from({ length: len }, (_, i) => i & 0xff);
        const hex = "$" + Buffer.from(bytes).toString("hex").toUpperCase();
        return { success: true, data: hex };
      },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("memory_dump_to_file", { address: "$C000", length: 32, outputPath: file, format: "hex", chunkSize: 8 }, ctx);
  assert.equal(res.metadata?.success, true);
  const stat = await fs.stat(file);
  assert.ok(stat.size > 0);
  const manifest = JSON.parse(await fs.readFile(`${file}.json`, "utf8"));
  assert.equal(manifest.length, 32);
  assert.ok(manifest.checksum);
});
