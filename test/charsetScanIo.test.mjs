import test from "#test/runner";
import assert from "#test/assert";
import { metaModule } from "../src/tools/meta/index.js";
import { createLogger } from "./meta/helpers.mjs";

function recordingCtx(reads) {
  return {
    platform: { id: "c64u" },
    client: {
      async pause() { return { success: true }; },
      async resume() { return { success: true }; },
      async readMemory(address, length) {
        reads.push({ start: Number.parseInt(String(address).replace("$", ""), 16), length: Number(length) });
        return { success: true, data: `$${"00".repeat(Number(length))}` };
      },
    },
    logger: createLogger(),
  };
}

test("rip_charset_from_ram scans never read $D000-$DFFF for common or full ranges (HARD03-039)", async () => {
  for (const scanRange of ["common", "full"]) {
    const reads = [];
    const result = await metaModule.invoke("rip_charset_from_ram", { scanRange }, recordingCtx(reads));
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.ok(reads.length > 0, scanRange);
    for (const { start, length } of reads) {
      assert.ok(start + length - 1 < 0xD000 || start > 0xDFFF, `${scanRange}: read $${start.toString(16)} length ${length}`);
    }
  }
});
