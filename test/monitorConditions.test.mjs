import test from "#test/runner";
import assert from "#test/assert";
import { parseCondition, readPlan, describeTarget, evaluate, decodeInteger } from "../src/monitor/conditions.js";
import { parseAddressArg } from "../src/tools/memory.js";
import { setViceSymbols, clearViceSymbols } from "../src/tools/translation/symbolRegistry.js";

const resolve = (raw, path) => parseAddressArg(raw, path);
const parse = (raw) => parseCondition(raw, resolve);
const bytes = (...values) => ({ kind: "bytes", bytes: Uint8Array.from(values) });
const screen = (text) => ({ kind: "screen", text });

test.afterEach(() => clearViceSymbols());

function validationPath(raw) {
  try { parse(raw); } catch (error) { return { path: error.path, message: error.message, kind: error.kind }; }
  return undefined;
}

const num = (type, extra) => ({ type, address: "$C000", width: 2, ...extra });

// ---------------------------------------------------------------- validation, exact error paths
const invalid = [
  ["not an object", "x", "$.condition"],
  ["array", [], "$.condition"],
  ["missing type", { address: "$C000" }, "$.condition.type"],
  ["unknown type", { type: "predicate", expr: "1" }, "$.condition.type"],
  ["unknown key", { type: "equals", address: "$C000", bytes: "01", extra: 1 }, "$.condition.extra"],
  ["key of another type", { type: "equals", address: "$C000", bytes: "01", mask: 1 }, "$.condition.mask"],
  ["missing address", { type: "equals", bytes: "01" }, "$.condition.address"],
  ["bare hex address", { type: "equals", address: "C000", bytes: "01" }, "$.condition.address"],
  ["bare hex address digits and letters", { type: "equals", address: "0400", bytes: "01" }, "$.condition.address"],
  ["address above $FFFF", { type: "equals", address: "$10000", bytes: "01" }, "$.condition.address"],
  ["negative numeric address", { type: "equals", address: -1, bytes: "01" }, "$.condition.address"],
  ["fractional numeric address", { type: "equals", address: 1.5, bytes: "01" }, "$.condition.address"],
  ["unknown symbol", { type: "equals", address: "nosuchlabel", bytes: "01" }, "$.condition.address"],
  ["bytes missing", { type: "equals", address: "$C000" }, "$.condition.bytes"],
  ["bytes empty", { type: "equals", address: "$C000", bytes: "" }, "$.condition.bytes"],
  ["bytes odd digits", { type: "equals", address: "$C000", bytes: "ABC" }, "$.condition.bytes"],
  ["bytes not hex", { type: "not_equals", address: "$C000", bytes: "ZZ" }, "$.condition.bytes"],
  ["bytes too long", { type: "equals", address: "$C000", bytes: "00".repeat(1025) }, "$.condition.bytes"],
  ["bytes overflow past $FFFF", { type: "equals", address: "$FFFF", bytes: "0102" }, "$.condition.address"],
  ["mask above 255", { type: "masked", address: "$C000", mask: 256, value: 0 }, "$.condition.mask"],
  ["mask negative", { type: "masked", address: "$C000", mask: -1, value: 0 }, "$.condition.mask"],
  ["mask bare hex", { type: "masked", address: "$C000", mask: "FF", value: 0 }, "$.condition.mask"],
  ["mask missing", { type: "masked", address: "$C000", value: 0 }, "$.condition.mask"],
  ["value outside mask", { type: "masked", address: "$C000", mask: 0x0f, value: 0x10 }, "$.condition.value"],
  ["value above 255", { type: "masked", address: "$C000", mask: 255, value: 256 }, "$.condition.value"],
  ["width missing", { type: "range", address: "$C000", min: 0, max: 1 }, "$.condition.width"],
  ["width 3", num("range", { width: 3, min: 0, max: 1 }), "$.condition.width"],
  ["width 8", num("threshold", { width: 8, comparison: "gt", value: 1 }), "$.condition.width"],
  ["width as string", num("range", { width: "2", min: 0, max: 1 }), "$.condition.width"],
  ["signed not boolean", num("range", { min: 0, max: 1, signed: "yes" }), "$.condition.signed"],
  ["endian invalid", num("range", { min: 0, max: 1, endian: "middle" }), "$.condition.endian"],
  ["range min above max", num("range", { min: 5, max: 4 }), "$.condition.min"],
  ["range max above width", num("range", { width: 1, min: 0, max: 256 }), "$.condition.max"],
  ["range min below signed width", num("range", { width: 1, signed: true, min: -129, max: 0 }), "$.condition.min"],
  ["range 16 bit above", num("range", { min: 0, max: 65536 }), "$.condition.max"],
  ["range 32 bit above", num("range", { width: 4, min: 0, max: 4294967296 }), "$.condition.max"],
  ["range 32 bit signed above", num("range", { width: 4, signed: true, min: 0, max: 2147483648 }), "$.condition.max"],
  ["range fractional", num("range", { min: 0.5, max: 1 }), "$.condition.min"],
  ["range width overflow past $FFFF", num("range", { address: "$FFFF", width: 2, min: 0, max: 1 }), "$.condition.address"],
  ["threshold width 4 at $FFFD", num("threshold", { address: "$FFFD", width: 4, comparison: "gt", value: 0 }), "$.condition.address"],
  ["comparison invalid", num("threshold", { comparison: "eq", value: 1 }), "$.condition.comparison"],
  ["comparison missing", num("threshold", { value: 1 }), "$.condition.comparison"],
  ["threshold value missing", num("threshold", { comparison: "gt" }), "$.condition.value"],
  ["threshold value too big", num("threshold", { comparison: "gt", value: 65536 }), "$.condition.value"],
  ["threshold value not a number", num("threshold", { comparison: "gt", value: {} }), "$.condition.value"],
  ["changed length missing", { type: "changed", address: "$C000" }, "$.condition.length"],
  ["changed length 0", { type: "changed", address: "$C000", length: 0 }, "$.condition.length"],
  ["changed length too long", { type: "changed", address: "$C000", length: 1025 }, "$.condition.length"],
  ["changed overflow past $FFFF", { type: "changed", address: "$FFFF", length: 2 }, "$.condition.address"],
  ["screen_text missing text", { type: "screen_text" }, "$.condition.text"],
  ["screen_text empty", { type: "screen_text", text: "" }, "$.condition.text"],
  ["screen_text too long", { type: "screen_text", text: "x".repeat(1001) }, "$.condition.text"],
  ["screen_text present not boolean", { type: "screen_text", text: "A", present: 1 }, "$.condition.present"],
  ["screen_text caseInsensitive not boolean", { type: "screen_text", text: "A", caseInsensitive: "no" }, "$.condition.caseInsensitive"],
  ["screen_changed with address", { type: "screen_changed", address: "$0400" }, "$.condition.address"],
  ["checkpoint kind invalid", { type: "checkpoint", address: "$C000", kind: "step" }, "$.condition.kind"],
  ["checkpoint address missing", { type: "checkpoint" }, "$.condition.address"],
];

for (const [name, raw, path] of invalid) {
  test(`condition validation: ${name} -> ${path}`, () => {
    const failure = validationPath(raw);
    assert.ok(failure, "must throw");
    assert.equal(failure.kind, "validation");
    assert.equal(failure.path, path, failure.message);
  });
}

test("condition validation: a custom base path is used for every error", () => {
  assert.throws(() => parseCondition({ type: "equals", address: "$C000" }, resolve, "$.cond"), (error) => error.path === "$.cond.bytes");
});

test("condition validation: bare hex message tells how to write the address", () => {
  assert.match(validationPath({ type: "equals", address: "C000", bytes: "01" }).message, /\$C000/);
});

// ---------------------------------------------------------------- parsing, resolved fields
test("parse: addresses accept $, 0x, decimal, numbers, labels with offsets; resolved to numbers", () => {
  setViceSymbols([["counter", 0xc010]]);
  const forms = [["$C000", 0xc000], ["0xC000", 0xc000], ["49152", 0xc000], [49152, 0xc000], ["counter", 0xc010], ["counter+2", 0xc012], ["$FFFF", 0xffff]];
  for (const [raw, expected] of forms) {
    assert.equal(parse({ type: "equals", address: raw, bytes: "01" }).address, expected, String(raw));
  }
});

test("parse: bytes accept separators and prefixes and are upper/lower case insensitive", () => {
  for (const raw of ["$A9 00", "a9_00", "$A900", "A9 00", "$a9 $00"]) {
    assert.deepEqual([...parse({ type: "equals", address: 1024, bytes: raw }).bytes], [0xa9, 0]);
  }
});

test("parse: numeric values accept JSON numbers and literal strings, also negative strings", () => {
  const c = parse(num("range", { width: 2, signed: true, min: "-$10".replace("$", "0x"), max: "$7FFF" }));
  assert.equal(c.min, -16);
  assert.equal(c.max, 0x7fff);
  assert.equal(parse({ type: "masked", address: "$C000", mask: "$F0", value: "0x30" }).value, 0x30);
});

test("parse: defaults are little endian, unsigned, present and case-insensitive, exec", () => {
  const range = parse(num("range", { min: 0, max: 1 }));
  assert.equal(range.endian, "little");
  assert.equal(range.signed, false);
  const text = parse({ type: "screen_text", text: "READY." });
  assert.equal(text.present, true);
  assert.equal(text.caseInsensitive, true);
  assert.equal(parse({ type: "checkpoint", address: "$C000" }).kind, "exec");
});

test("parse: boundary addresses and lengths at the end of the address space are accepted", () => {
  assert.equal(parse({ type: "equals", address: "$FFFF", bytes: "00" }).address, 0xffff);
  assert.equal(parse(num("range", { address: "$FFFE", width: 2, min: 0, max: 1 })).address, 0xfffe);
  assert.equal(parse({ type: "changed", address: "$FFFF", length: 1 }).length, 1);
  assert.equal(parse({ type: "changed", address: "$0000", length: 1024 }).length, 1024);
  assert.equal(parse({ type: "equals", address: "$0000", bytes: "00" }).address, 0);
});

test("parse: the resolver is called exactly once per address, with the path of the field", () => {
  const calls = [];
  parseCondition({ type: "equals", address: "sym", bytes: "01" }, (raw, path) => { calls.push([raw, path]); return 0x1234; });
  assert.deepEqual(calls, [["sym", "$.condition.address"]]);
});

// ---------------------------------------------------------------- read plan
const plans = [
  [{ type: "equals", address: "$C000", bytes: "010203" }, { kind: "memory", address: 0xc000, length: 3 }, { type: "memory", address: "$C000", length: 3 }],
  [{ type: "not_equals", address: "$0400", bytes: "01" }, { kind: "memory", address: 0x400, length: 1 }, { type: "memory", address: "$0400", length: 1 }],
  [{ type: "masked", address: "$D020", mask: 15, value: 1 }, { kind: "memory", address: 0xd020, length: 1 }, { type: "memory", address: "$D020", length: 1 }],
  [num("range", { width: 4, min: 0, max: 1 }), { kind: "memory", address: 0xc000, length: 4 }, { type: "memory", address: "$C000", length: 4 }],
  [num("threshold", { width: 2, comparison: "gt", value: 1 }), { kind: "memory", address: 0xc000, length: 2 }, { type: "memory", address: "$C000", length: 2 }],
  [{ type: "changed", address: "$C000", length: 40 }, { kind: "memory", address: 0xc000, length: 40 }, { type: "memory", address: "$C000", length: 40 }],
  [{ type: "screen_text", text: "A" }, { kind: "screen" }, { type: "screen" }],
  [{ type: "screen_changed" }, { kind: "screen" }, { type: "screen" }],
  [{ type: "checkpoint", address: "$0810", kind: "store" }, { kind: "checkpoint", address: 0x810, access: "store" }, { type: "checkpoint", address: "$0810", kind: "store" }],
];
for (const [raw, plan, described] of plans) {
  test(`read plan: ${raw.type} ${JSON.stringify(plan)}`, () => {
    const condition = parse(raw);
    assert.deepEqual(readPlan(condition), plan);
    assert.deepEqual(describeTarget(readPlan(condition)), described);
  });
}

// ---------------------------------------------------------------- evaluation tables
const hb = (hex) => Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
const evaluations = [
  // equals / not_equals
  ["equals met", { type: "equals", address: 0, bytes: hb("A900") }, bytes(0xa9, 0), true, "$A900"],
  ["equals not met", { type: "equals", address: 0, bytes: hb("A900") }, bytes(0xa9, 1), false, "$A901"],
  ["equals 0x00", { type: "equals", address: 0, bytes: hb("00") }, bytes(0), true, "$00"],
  ["equals 0xFF", { type: "equals", address: 0, bytes: hb("FF") }, bytes(255), true, "$FF"],
  ["not_equals met", { type: "not_equals", address: 0, bytes: hb("00") }, bytes(1), true, "$01"],
  ["not_equals not met", { type: "not_equals", address: 0, bytes: hb("00") }, bytes(0), false, "$00"],
  // masked
  ["masked met", { type: "masked", address: 0, mask: 0x0f, value: 0x05 }, bytes(0xa5), true, "$A5"],
  ["masked not met", { type: "masked", address: 0, mask: 0x0f, value: 0x05 }, bytes(0xa6), false, "$A6"],
  ["masked mask 0x00 always met with value 0", { type: "masked", address: 0, mask: 0, value: 0 }, bytes(0xff), true, "$FF"],
  ["masked mask 0xFF is equality (met)", { type: "masked", address: 0, mask: 255, value: 255 }, bytes(255), true, "$FF"],
  ["masked mask 0xFF is equality (not met)", { type: "masked", address: 0, mask: 255, value: 255 }, bytes(254), false, "$FE"],
  ["masked single bit set", { type: "masked", address: 0, mask: 0x80, value: 0x80 }, bytes(0x80), true, "$80"],
  ["masked single bit clear", { type: "masked", address: 0, mask: 0x80, value: 0x00 }, bytes(0x7f), true, "$7F"],
];
const spec = (width, signed = false, endian = "little") => ({ width, signed, endian });
const numeric = [
  // range
  ["range 8 bit inclusive low", { type: "range", address: 0, min: 10, max: 20, ...spec(1) }, bytes(10), true, 10],
  ["range 8 bit inclusive high", { type: "range", address: 0, min: 10, max: 20, ...spec(1) }, bytes(20), true, 20],
  ["range 8 bit below", { type: "range", address: 0, min: 10, max: 20, ...spec(1) }, bytes(9), false, 9],
  ["range 8 bit above", { type: "range", address: 0, min: 10, max: 20, ...spec(1) }, bytes(21), false, 21],
  ["range 8 bit 0..0 at 0", { type: "range", address: 0, min: 0, max: 0, ...spec(1) }, bytes(0), true, 0],
  ["range 8 bit 255..255 at 255", { type: "range", address: 0, min: 255, max: 255, ...spec(1) }, bytes(255), true, 255],
  ["range 8 bit signed negative", { type: "range", address: 0, min: -128, max: -1, ...spec(1, true) }, bytes(0xff), true, -1],
  ["range 8 bit signed -128", { type: "range", address: 0, min: -128, max: -128, ...spec(1, true) }, bytes(0x80), true, -128],
  ["range 8 bit signed 127", { type: "range", address: 0, min: 127, max: 127, ...spec(1, true) }, bytes(0x7f), true, 127],
  ["range 8 bit signed 0x80 is not positive", { type: "range", address: 0, min: 0, max: 127, ...spec(1, true) }, bytes(0x80), false, -128],
  ["range 16 bit little endian", { type: "range", address: 0, min: 0x1234, max: 0x1234, ...spec(2) }, bytes(0x34, 0x12), true, 0x1234],
  ["range 16 bit big endian", { type: "range", address: 0, min: 0x1234, max: 0x1234, ...spec(2, false, "big") }, bytes(0x12, 0x34), true, 0x1234],
  ["range 16 bit big endian is not little", { type: "range", address: 0, min: 0x1234, max: 0x1234, ...spec(2, false, "big") }, bytes(0x34, 0x12), false, 0x3412],
  ["range 16 bit max", { type: "range", address: 0, min: 65535, max: 65535, ...spec(2) }, bytes(0xff, 0xff), true, 65535],
  ["range 16 bit signed min", { type: "range", address: 0, min: -32768, max: -32768, ...spec(2, true) }, bytes(0x00, 0x80), true, -32768],
  ["range 16 bit signed -1", { type: "range", address: 0, min: -1, max: -1, ...spec(2, true) }, bytes(0xff, 0xff), true, -1],
  ["range 32 bit max", { type: "range", address: 0, min: 4294967295, max: 4294967295, ...spec(4) }, bytes(0xff, 0xff, 0xff, 0xff), true, 4294967295],
  ["range 32 bit little endian", { type: "range", address: 0, min: 0x01020304, max: 0x01020304, ...spec(4) }, bytes(4, 3, 2, 1), true, 0x01020304],
  ["range 32 bit big endian", { type: "range", address: 0, min: 0x01020304, max: 0x01020304, ...spec(4, false, "big") }, bytes(1, 2, 3, 4), true, 0x01020304],
  ["range 32 bit 0x80000000 unsigned", { type: "range", address: 0, min: 2147483648, max: 2147483648, ...spec(4) }, bytes(0, 0, 0, 0x80), true, 2147483648],
  ["range 32 bit signed min", { type: "range", address: 0, min: -2147483648, max: -2147483648, ...spec(4, true) }, bytes(0, 0, 0, 0x80), true, -2147483648],
  ["range 32 bit signed max", { type: "range", address: 0, min: 2147483647, max: 2147483647, ...spec(4, true) }, bytes(0xff, 0xff, 0xff, 0x7f), true, 2147483647],
  ["range 32 bit signed -1", { type: "range", address: 0, min: -1, max: -1, ...spec(4, true) }, bytes(0xff, 0xff, 0xff, 0xff), true, -1],
  // threshold
  ["threshold gt met", { type: "threshold", address: 0, comparison: "gt", value: 5, ...spec(1) }, bytes(6), true, 6],
  ["threshold gt equal not met", { type: "threshold", address: 0, comparison: "gt", value: 5, ...spec(1) }, bytes(5), false, 5],
  ["threshold gte equal met", { type: "threshold", address: 0, comparison: "gte", value: 5, ...spec(1) }, bytes(5), true, 5],
  ["threshold gte below", { type: "threshold", address: 0, comparison: "gte", value: 5, ...spec(1) }, bytes(4), false, 4],
  ["threshold lt met", { type: "threshold", address: 0, comparison: "lt", value: 5, ...spec(1) }, bytes(4), true, 4],
  ["threshold lt equal not met", { type: "threshold", address: 0, comparison: "lt", value: 5, ...spec(1) }, bytes(5), false, 5],
  ["threshold lte equal met", { type: "threshold", address: 0, comparison: "lte", value: 5, ...spec(1) }, bytes(5), true, 5],
  ["threshold lte above", { type: "threshold", address: 0, comparison: "lte", value: 5, ...spec(1) }, bytes(6), false, 6],
  ["threshold gt 0 with 0", { type: "threshold", address: 0, comparison: "gt", value: 0, ...spec(1) }, bytes(0), false, 0],
  ["threshold gte 255 with 255", { type: "threshold", address: 0, comparison: "gte", value: 255, ...spec(1) }, bytes(255), true, 255],
  ["threshold lt 0 signed negative", { type: "threshold", address: 0, comparison: "lt", value: 0, ...spec(1, true) }, bytes(0xff), true, -1],
  ["threshold lt 0 unsigned never", { type: "threshold", address: 0, comparison: "lt", value: 0, ...spec(1) }, bytes(0xff), false, 255],
  ["threshold gt 16 bit", { type: "threshold", address: 0, comparison: "gt", value: 255, ...spec(2) }, bytes(0, 1), true, 256],
  ["threshold gt 16 bit big endian", { type: "threshold", address: 0, comparison: "gt", value: 255, ...spec(2, false, "big") }, bytes(0, 1), false, 1],
  ["threshold gte 32 bit", { type: "threshold", address: 0, comparison: "gte", value: 4294967295, ...spec(4) }, bytes(255, 255, 255, 255), true, 4294967295],
  ["threshold lt 32 bit signed", { type: "threshold", address: 0, comparison: "lt", value: -2147483647, ...spec(4, true) }, bytes(0, 0, 0, 0x80), true, -2147483648],
];

for (const [name, condition, observation, met, observed] of [...evaluations, ...numeric]) {
  test(`evaluate: ${name}`, () => {
    const result = evaluate(condition, observation, observation);
    assert.equal(result.met, met);
    assert.equal(result.observed, observed);
    assert.equal(typeof result.expected, "string");
    assert.ok(result.expected.length > 0);
  });
}

test("decodeInteger: all widths, endians and signs at the limits", () => {
  const cases = [
    [[0x80], spec(1, true), -128], [[0x80], spec(1), 128], [[0x7f], spec(1, true), 127],
    [[0x00, 0x80], spec(2, true), -32768], [[0x80, 0x00], spec(2, true, "big"), -32768],
    [[0xff, 0xff], spec(2), 65535], [[0xff, 0xff, 0xff, 0xff], spec(4), 4294967295],
    [[0xff, 0xff, 0xff, 0xff], spec(4, true), -1], [[0, 0, 0, 0x80], spec(4, true), -2147483648],
    [[0x80, 0, 0, 0], spec(4, true, "big"), -2147483648],
  ];
  for (const [input, s, expected] of cases) assert.equal(decodeInteger(Uint8Array.from(input), s), expected, JSON.stringify([input, s]));
});

test("evaluate: changed compares against the initial snapshot, never the first read itself", () => {
  const condition = { type: "changed", address: 0, length: 2 };
  const first = bytes(1, 2);
  assert.equal(evaluate(condition, first, first).met, false);
  assert.equal(evaluate(condition, bytes(1, 2), first).met, false);
  const changed = evaluate(condition, bytes(1, 3), first);
  assert.equal(changed.met, true);
  assert.equal(changed.observed, "$0103");
  assert.match(changed.expected, /\$0102/);
  assert.equal(evaluate(condition, bytes(0, 2), first).met, true);
});

const screenCases = [
  ["found", { text: "READY.", present: true, caseInsensitive: true }, "  READY.\n", true],
  ["found case-insensitive default", { text: "ready.", present: true, caseInsensitive: true }, "READY.", true],
  ["case-sensitive mismatch", { text: "ready.", present: true, caseInsensitive: false }, "READY.", false],
  ["case-sensitive match", { text: "READY.", present: true, caseInsensitive: false }, "READY.", true],
  ["absent expected, text missing", { text: "LOADING", present: false, caseInsensitive: true }, "READY.", true],
  ["absent expected, text present", { text: "loading", present: false, caseInsensitive: true }, "LOADING", false],
  ["not found", { text: "ERROR", present: true, caseInsensitive: true }, "READY.", false],
  ["multi-row text is matched as written", { text: "A\nB", present: true, caseInsensitive: true }, "A\nB", true],
  ["punctuation is literal, not a regex", { text: "R.ADY", present: true, caseInsensitive: true }, "READY", false],
];
for (const [name, fields, text, met] of screenCases) {
  test(`evaluate screen_text: ${name}`, () => {
    const result = evaluate({ type: "screen_text", ...fields }, screen(text), screen(""));
    assert.equal(result.met, met);
    assert.equal(result.observed, text);
  });
}

test("evaluate: screen_changed against the initial screen", () => {
  const condition = { type: "screen_changed" };
  assert.equal(evaluate(condition, screen("A"), screen("A")).met, false);
  assert.equal(evaluate(condition, screen("B"), screen("A")).met, true);
});

test("evaluate: checkpoint needs at least one hit", () => {
  const condition = { type: "checkpoint", address: 0xc000, kind: "exec" };
  assert.equal(evaluate(condition, { kind: "hits", count: 0 }, { kind: "hits", count: 0 }).met, false);
  const hit = evaluate(condition, { kind: "hits", count: 3 }, { kind: "hits", count: 0 });
  assert.equal(hit.met, true);
  assert.equal(hit.observed, 3);
});

test("evaluate: an observation of the wrong kind is a programming error, not a silent miss", () => {
  assert.throws(() => evaluate({ type: "equals", address: 0, bytes: Uint8Array.of(1) }, screen("x"), screen("x")));
  assert.throws(() => evaluate({ type: "screen_changed" }, bytes(1), bytes(1)));
  assert.throws(() => evaluate({ type: "checkpoint", address: 0, kind: "exec" }, bytes(1), bytes(1)));
});
