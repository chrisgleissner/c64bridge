import test from "#test/runner";
import assert from "#test/assert";
import { encodeStringWithNames, lookupNamedPetscii, parseBraceToken, petsciiControlName, petsciiToScreenCode, screenCodesToAscii, SCREEN_GRAPHIC_PLACEHOLDER } from "../src/petscii.js";

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

test("control-code names follow mist64/c64ref control_codes_c64.txt (HARD06 fact check)", () => {
  // Every C64 control code of c64ref with its value; the names are this module's spellings.
  const c64ref = {
    stop: 0x03, white: 0x05, dis_case_switch: 0x08, ena_case_switch: 0x09, return: 0x0d, lowercase: 0x0e,
    crsr_down: 0x11, rvs_on: 0x12, crsr_home: 0x13, del: 0x14, red: 0x1c, crsr_right: 0x1d, green: 0x1e,
    blue: 0x1f, orange: 0x81, run: 0x83, f1: 0x85, f3: 0x86, f5: 0x87, f7: 0x88, f2: 0x89, f4: 0x8a,
    f6: 0x8b, f8: 0x8c, shift_return: 0x8d, uppercase: 0x8e, black: 0x90, crsr_up: 0x91, rvs_off: 0x92,
    clear: 0x93, inst: 0x94, brown: 0x95, light_red: 0x96, dark_gray: 0x97, medium_gray: 0x98,
    light_green: 0x99, light_blue: 0x9a, light_gray: 0x9b, purple: 0x9c, crsr_left: 0x9d, yellow: 0x9e, cyan: 0x9f,
  };
  for (const [name, code] of Object.entries(c64ref)) {
    assert.equal(lookupNamedPetscii(name), code, name);
    assert.ok(petsciiControlName(code), `listing name for $${code.toString(16)}`);
  }
  // 7 and 10 have no function on the C64: still accepted, but a listing writes the code.
  assert.equal(lookupNamedPetscii("bell"), 7);
  assert.equal(petsciiControlName(7), undefined);
  assert.equal(petsciiControlName(10), undefined);
  // $FF prints as the pi sign $DE (c64ref generate.py), screen code $5E.
  assert.equal(petsciiToScreenCode(0xff), petsciiToScreenCode(0xde));
});
