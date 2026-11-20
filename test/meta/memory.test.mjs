import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./helpers.mjs";

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

test("memory_dump_to_file rejects a range that would pass $FFFF without reading", async () => {
  const { file, dir } = tmpPath("memory", "wrap.hex");
  await fs.mkdir(dir, { recursive: true });
  const reads = [];
  const ctx = {
    client: {
      async pause() { return { success: true }; },
      async resume() { return { success: true }; },
      async readMemory(address, length) { reads.push(address); return { success: true, data: "$" + "00".repeat(Number(length)) }; },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("memory_dump_to_file", { address: "$FF00", length: 512, chunkSize: 256, outputPath: file }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "validation");
  assert.deepEqual(reads, []);
  const ok = await metaModule.invoke("memory_dump_to_file", { address: "$FF00", length: 256, chunkSize: 256, outputPath: file }, ctx);
  assert.equal(ok.metadata?.success, true);
});

test("memory_dump_to_file fails when the firmware returns fewer bytes than requested", async () => {
  const { file, dir } = tmpPath("memory", "short.hex");
  await fs.mkdir(dir, { recursive: true });
  const ctx = {
    client: {
      async pause() { return { success: true }; },
      async resume() { return { success: true }; },
      async readMemory() { return { success: true, data: "$0000" }; },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("memory_dump_to_file", { address: "$C000", length: 8, outputPath: file, retries: 0 }, ctx);
  assert.equal(res.isError, true);
});
