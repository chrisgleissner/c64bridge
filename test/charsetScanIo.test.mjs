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
      // HARD06 META-13: the two single-byte register reads ($D018, $DD00) that locate the active charset are allowed.
      if (length === 1 && (start === 0xD018 || start === 0xDD00)) continue;
      assert.ok(start + length - 1 < 0xD000 || start > 0xDFFF, `${scanRange}: read $${start.toString(16)} length ${length}`);
    }
  }
});

test("I4 explicit charset addresses reject every overlap with I/O before pausing", async () => {
  for (const address of ["$D000", "$D800", "$CC01", "$CFFF"]) {
    const reads = [];
    const ctx = recordingCtx(reads);
    let pauses = 0;
    ctx.client.pause = async () => { pauses += 1; return { success: true }; };
    const result = await metaModule.invoke("rip_charset_from_ram", { address }, ctx);
    assert.equal(result.metadata?.error?.kind, "validation", address);
    assert.equal(reads.length, 0);
    assert.equal(pauses, 0);
  }
  for (const address of ["$C800", "$E000"]) {
    const reads = [];
    const result = await metaModule.invoke("rip_charset_from_ram", { address }, recordingCtx(reads));
    assert.equal(result.isError, undefined, address);
    assert.equal(reads.length, 1);
  }
});
