import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { screenCodesToAscii } from "../src/petscii.js";

// HARD06 CLIENT-3: the direct-write greeting writes every character of the upper-case set
// (ASCII $20-$3F keep their codes, @ A-Z [ ] map to $00-$1D), wraps long text at spaces, and
// names characters it could not write.

async function render(message) {
  const writes = [];
  const client = new C64Client("http://127.0.0.1:1", { forceC64uFacade: true });
  Reflect.set(client, "facadePromise", Promise.resolve({
    type: "c64u",
    async readMemory() { return Uint8Array.of(0x97); },
    async writeMemoryBlocks(blocks) { writes.push(...blocks); },
  }));
  const result = await client.renderGreetingScreen({ message });
  const screen = writes.find((write) => write.address === 0x0400).bytes;
  const text = screenCodesToAscii(screen, { columns: 40, rows: 25 });
  return { result, text, normalised: text.replace(/\s+/g, " ").trim() };
}

test("punctuation, @ and brackets reach the screen unchanged", async () => {
  const message = "HELLO (C64U) #1 + 2 = 3 @HOME [OK] \"$%&'*<>?/";
  const { result, normalised } = await render(message);
  assert.equal(result.success, true);
  assert.ok(normalised.includes(message), normalised);
  assert.equal(result.details.warnings, undefined);
});

test("a message longer than one row wraps at a space and stays readable", async () => {
  const message = "HAVE A GREAT DAY, C64U! THIS GREETING IS LONGER THAN FORTY COLUMNS";
  const { result, normalised, text } = await render(message);
  assert.ok(normalised.includes(message), normalised);
  assert.equal(result.details.rows, 2);
  assert.ok(text.includes("READY."));
});

test("characters without a glyph are named in a warning", async () => {
  const { result } = await render("TILDE ~ HERE");
  assert.equal(result.success, true);
  assert.match(result.details.warnings.join(" "), /"~"/);
});
