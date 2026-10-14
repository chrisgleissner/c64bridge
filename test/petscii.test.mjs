import test from "#test/runner";
import assert from "#test/assert";
import { encodeStringWithNames, lookupNamedPetscii, screenCodesToAscii } from "../src/petscii.js";
import { getChargenGlyphs } from "../src/chargen.js";

function buildCharToScreenMap() {
  const map = new Map();
  for (const glyph of getChargenGlyphs()) {
    if (!glyph || typeof glyph.screenCode !== "number") {
      continue;
    }
    if (glyph.basic && glyph.basic.length === 1 && !map.has(glyph.basic)) {
      map.set(glyph.basic, glyph.screenCode & 0xff);
    }
  }
  return map;
}

test("screenCodesToAscii converts screen memory into readable rows", () => {
  const charToScreen = buildCharToScreenMap();
  const spaceCode = charToScreen.get(" ") ?? 0x20;
  const message = "?SYNTAX ERROR IN 80";
  const buffer = new Uint8Array(40);
  buffer.fill(spaceCode);
  for (let i = 0; i < message.length; i += 1) {
    const char = message[i];
    buffer[i] = charToScreen.get(char) ?? spaceCode;
  }

  const text = screenCodesToAscii(buffer, { columns: 40, rows: 1 });
  assert.equal(text, message);
});

test("screenCodesToAscii trims trailing rows by default", () => {
  const charToScreen = buildCharToScreenMap();
  const spaceCode = charToScreen.get(" ") ?? 0x20;
  const buffer = new Uint8Array(80);
  buffer.fill(spaceCode);
  const label = "READY.";
  for (let i = 0; i < label.length; i += 1) {
    buffer[i] = charToScreen.get(label[i]) ?? spaceCode;
  }

  const text = screenCodesToAscii(buffer, { columns: 40, rows: 2 });
  assert.equal(text, label);
});

test("encodeStringWithNames recognises multi-word names", () => {
  assert.equal(lookupNamedPetscii("cursor up"), 145);
  assert.deepEqual(Array.from(encodeStringWithNames("{cursor up}X{Cursor-Down}")), [145, 0x58, 17]);
  // Braced text that is not a known name, or contains other characters, stays literal.
  assert.deepEqual(Array.from(encodeStringWithNames("{a b}")), Array.from("{a b}", (ch) => ch.charCodeAt(0)));
  assert.deepEqual(Array.from(encodeStringWithNames("{he!art}")), Array.from("{he!art}", (ch) => ch.charCodeAt(0)));
});

test("screenCodesToAscii decodes screen code $00 as @", () => {
  // USER@HOST in screen codes; reverse @ ($80) already decoded as @.
  const bytes = Uint8Array.of(0x15, 0x13, 0x05, 0x12, 0x00, 0x08, 0x0f, 0x13, 0x14, 0x20, 0x80);
  assert.equal(screenCodesToAscii(bytes), "USER@HOST @");
});

test("screenCodesToAscii does not decode block graphics $60-$7F and $E0-$FF as letters", () => {
  for (let code = 0x60; code <= 0x7f; code += 1) {
    for (const screenCode of [code, code | 0x80]) {
      const text = screenCodesToAscii(Uint8Array.of(0x01, screenCode, 0x01), { trimTrailingSpaces: false });
      assert.equal(text, "A A", `screen code $${screenCode.toString(16)} decoded as ${JSON.stringify(text)}`);
    }
  }
});

test("named PETSCII lookup ignores Object.prototype member names", () => {
  assert.equal(lookupNamedPetscii("constructor"), undefined);
  assert.equal(lookupNamedPetscii("toString"), undefined);
  // An unknown name stays literal text instead of becoming byte 0.
  assert.equal(Buffer.from(encodeStringWithNames("{constructor}")).toString("latin1"), "{constructor}");
});

test("multi-word named codes need braces, so ordinary text with colons is kept", () => {
  assert.deepEqual([...encodeStringWithNames("{reverse on}")], [18]);
  assert.equal(Buffer.from(encodeStringWithNames("Mode: reverse on: yes")).toString("latin1"), "Mode: reverse on: yes");
  assert.deepEqual([...encodeStringWithNames(":heart:")], [0x73]);
});
