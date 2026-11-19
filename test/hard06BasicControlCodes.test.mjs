import test from "#test/runner";
import assert from "#test/assert";
import { basicToPrg, basicToPrgDetailed } from "../src/tools/translation/basicTokenizer.js";
import { detokenizeLine, listBasicProgram } from "../src/tools/translation/basicDetokenizer.js";

// HARD06 TRANSLATE-1, 2, 9, 10, 11 / MEDIA-9: one control-code table, exact listing round trip.

const lineBytes = (source) => {
  const prg = basicToPrg(source);
  return [...prg].slice(6, prg.length - 3);
};

test("colour, cursor and function-key names in strings become their PETSCII codes", () => {
  assert.deepEqual(lineBytes('10 PRINT"{clr}{wht}{red}{down}{rvs on}{f1}{blk}{lblu}"'), [0x99, 0x22, 147, 5, 28, 17, 18, 133, 144, 154, 0x22]);
  assert.deepEqual(lineBytes('10 PRINT"{$93}{147}{$1C}"'), [0x99, 0x22, 147, 147, 28, 0x22]);
});

test("an unknown {name} in a string is an error that names the line", () => {
  assert.throws(
    () => basicToPrg('10 PRINT "X"\n20 PRINT "{sparkle}"'),
    (error) => error.name === "ToolValidationError" && /line 2/.test(error.message) && /\{sparkle\}/.test(error.message),
  );
  assert.throws(() => basicToPrg('10 PRINT "{300}"'), /line 1/);
  // Text without a closing brace or with other characters stays literal.
  assert.deepEqual(lineBytes('10 PRINT"{ A,B"'), [0x99, 0x22, 0x7b, 0x20, 0x41, 0x2c, 0x42, 0x22]);
});

test("a NUL or other control character cannot reach the tokenised line", () => {
  for (const source of ['10 PRINT "A\u0000B"', "10 REM A\u0000B", "10 A=1\u0000:B=2", '10 PRINT "{$00}"', '10 PRINT "{0}"', '10 PRINT "A\tB"']) {
    assert.throws(() => basicToPrg(source), (error) => error.name === "ToolValidationError" && /line 1/.test(error.message), JSON.stringify(source));
  }
});

test("listing then tokenising reproduces every byte $01-$FF inside a string", () => {
  const body = [];
  for (let byte = 1; byte <= 255; byte += 1) if (byte !== 0x22) body.push(byte);
  const text = detokenizeLine(Uint8Array.from([0x22, ...body, 0x22]));
  assert.deepEqual(lineBytes(`10 PRINT${text}`), [0x99, 0x22, ...body, 0x22]);
  for (const byte of body) {
    const single = detokenizeLine(Uint8Array.of(0x22, byte, 0x22));
    assert.deepEqual(lineBytes(`10 ${single}`), [0x22, byte, 0x22], `byte $${byte.toString(16)} listed as ${single}`);
  }
  // Names where the byte has one, hex codes otherwise.
  assert.equal(detokenizeLine(Uint8Array.of(0x22, 0x93, 0x1c, 0x61, 0xc1, 0x22)), '"{clr}{red}{$61}{$C1}"');
});

test("the whole program survives list and tokenise, and pi is token $FF outside strings", () => {
  const source = '10 PRINT "{clr}{blu}HELLO{$C1}":X=π\n20 GOTO 10';
  const prg = basicToPrg(source);
  const listed = listBasicProgram(new Uint8Array(prg.subarray(2)), 0x801).lines.map((l) => `${l.number} ${l.text}`).join("\n");
  assert.deepEqual([...basicToPrg(listed)], [...prg]);
  assert.equal(detokenizeLine(Uint8Array.of(0x58, 0xb2, 0xff)), "X=π");
});

test("replaced line numbers are returned", () => {
  const result = basicToPrgDetailed('10 PRINT "A"\n20 PRINT "B"\n10 PRINT "C"\n10 PRINT "D"');
  assert.deepEqual(result.replacedLines, [10]);
  assert.deepEqual(basicToPrgDetailed('10 PRINT\n20 PRINT').replacedLines, []);
  assert.deepEqual([...result.prg], [...basicToPrg('20 PRINT "B"\n10 PRINT "D"')]);
});
