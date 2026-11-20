import test from "#test/runner";
import assert from "#test/assert";
import { programRunnersModule } from "../src/tools/programRunners.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = (id) => ({ id, features: [], limitedFeatures: [] });

test("HIL F1 ASM verification compares against the screen from before SYS", async () => {
  let started = false;
  const client = {
    async readScreen() { return started ? "PROGRAM OUTPUT" : "READY."; },
    async uploadAndRunAsm() { started = true; return { success: true }; },
    async readMemoryRaw(_address, length) { return Uint8Array.from({ length }, (_, i) => [0x4c, 0x00, 0xc0][i] ?? 0); },
  };
  const result = await programRunnersModule.invoke("upload_run_asm", {
    program: "*=$C000\nloop: jmp loop", verify: true,
  }, { client, logger, platform: platform("vice") });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.equal(result.structuredContent.data.verified, true);
});
