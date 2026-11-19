import test from "#test/runner";
import assert from "#test/assert";
import { encodeStringWithNames, lookupNamedPetscii, parseBraceToken, petsciiToScreenCode, screenCodesToAscii, SCREEN_GRAPHIC_PLACEHOLDER } from "../src/petscii.js";
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

test("screenCodesToAscii shows block graphics $60-$7F and $E0-$FF as a visible placeholder, not letters or blanks", () => {
  for (let code = 0x60; code <= 0x7f; code += 1) {
    for (const screenCode of [code, code | 0x80]) {
      const text = screenCodesToAscii(Uint8Array.of(0x01, screenCode, 0x01), { trimTrailingSpaces: false });
      assert.equal(text, `A${SCREEN_GRAPHIC_PLACEHOLDER}A`, `screen code $${screenCode.toString(16)} decoded as ${JSON.stringify(text)}`);
    }
  }
  // A screen of graphics is not blank (MEDIA-17).
  assert.equal(screenCodesToAscii(new Uint8Array(3).fill(0x66)), SCREEN_GRAPHIC_PLACEHOLDER.repeat(3));
});

test("screenCodesToAscii keeps letters, digits and punctuation exact in both character sets", () => {
  const all = Uint8Array.from({ length: 64 }, (_, index) => index);
  assert.equal(screenCodesToAscii(all, { columns: 64 }), "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !\"#$%&'()*+,-./0123456789:;<=>?");
  assert.equal(screenCodesToAscii(all, { columns: 64, charset: "lower" }), "@abcdefghijklmnopqrstuvwxyz[\\]^_ !\"#$%&'()*+,-./0123456789:;<=>?");
  // Upper-case/graphics set: $41-$5A are card suits and lines; lower-case set: capital letters.
  const high = Uint8Array.from({ length: 26 }, (_, index) => 0x41 + index);
  assert.equal(screenCodesToAscii(high), SCREEN_GRAPHIC_PLACEHOLDER.repeat(26));
  assert.equal(screenCodesToAscii(high, { charset: "lower" }), "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  // Reverse video shows the same character.
  assert.equal(screenCodesToAscii(Uint8Array.of(0x81, 0xb1)), "A1");
});

test("petsciiToScreenCode follows the KERNAL rule and matches every row of the repository chargen table", () => {
  for (const glyph of getChargenGlyphs()) {
    assert.equal(petsciiToScreenCode(glyph.petsciiCode), glyph.screenCode & 0x7f, `PETSCII $${glyph.petsciiCode.toString(16)}`);
  }
  assert.equal(petsciiToScreenCode(0x41), 1);
  assert.equal(petsciiToScreenCode(0x0d), undefined);
});

test("brace tokens accept names, $xx and decimal codes and reject unknown names", () => {
  const code = (text) => parseBraceToken(text, 0);
  assert.deepEqual(code("{red}"), { ok: true, value: 28, endIndex: 5 });
  assert.equal(code("{$93}").value, 147);
  assert.equal(code("{147}").value, 147);
  assert.equal(code("{rvs on}").value, 18);
  assert.equal(code("{f8}").value, 140);
  assert.equal(code("{256}").ok, false);
  assert.equal(code("{nope}").ok, false);
  assert.equal(code("{a,b}"), null);
  assert.equal(code("{open"), null);
  const colours = { blk: 144, wht: 5, red: 28, cyn: 159, pur: 156, grn: 30, blu: 31, yel: 158, org: 129, brn: 149, lred: 150, dgry: 151, mgry: 152, lgrn: 153, lblu: 154, lgry: 155 };
  for (const [name, value] of Object.entries(colours)) assert.equal(code(`{${name}}`).value, value, name);
  // The older colon and angle forms stay limited to the short list.
  assert.deepEqual([...encodeStringWithNames(":red:")], [...Buffer.from(":red:")]);
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
