import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import { toolRegistry } from "../src/tools/registry/index.js";
import { graphicsModule } from "../src/tools/graphics.js";
import { setViceSymbols, clearViceSymbols } from "../src/tools/translation/symbolRegistry.js";
import { lookupNamedPetscii } from "../src/petscii.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("disassemble returns operandLabel in the structured lines and the text", async () => {
  setViceSymbols([["target", 0x0820]]);
  try {
    const ctx = {
      client: { async readMemoryRaw() { return Uint8Array.of(0x4c, 0x20, 0x08); } },
      logger,
      platform: { id: "c64u", features: [], limitedFeatures: [] },
    };
    const res = await toolRegistry.invoke("c64_memory", { op: "disassemble", address: "$0810", length: 3 }, ctx);
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.data.lines[0].operandLabel, "target");
    assert.match(res.content[0].text, /; target/);
  } finally {
    clearViceSymbols();
  }
});

test("render_sprite passes the optional dataAddress to the client", async () => {
  const calls = [];
  const ctx = { client: { async generateAndRunSpritePrg(o) { calls.push(o); return { success: true, details: {} }; } }, logger };
  const sprite = Buffer.alloc(63, 1).toString("base64");
  await graphicsModule.invoke("render_sprite", { sprite, dataAddress: 0x3000 }, ctx);
  await graphicsModule.invoke("render_sprite", { sprite }, ctx);
  assert.equal(calls[0].dataAddress, 0x3000);
  assert.equal("dataAddress" in calls[1], false);
  const bad = await graphicsModule.invoke("render_sprite", { sprite, dataAddress: 70000 }, ctx);
  assert.equal(bad.isError, true);
});

test("c64_input tokens come from the shared control-code table", async () => {
  const writes = [];
  const ctx = {
    client: { async injectKeyboardQueue(bytes) { writes.push(Uint8Array.from(bytes)); return { delivered: bytes.length }; } },
    logger,
    platform: { id: "c64u", features: [], limitedFeatures: [] },
  };
  // MEDIUM_GREY and the abbreviation {GRY2} exist only in the shared table (code 152).
  assert.equal(lookupNamedPetscii("gry2"), 152);
  const res = await toolRegistry.invoke("c64_input", { op: "write_text", text: "{gry2}{rvs_on}" }, ctx);
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  assert.deepEqual([...writes[0]], [152, 18]);
});
