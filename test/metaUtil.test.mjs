import test from "#test/runner";
import assert from "#test/assert";
import { sleep, normalizeErrorDetails, formatTimestampSpec, parseTimestampSpec } from "../src/tools/meta/util.js";

test("sleep waits for specified milliseconds", async () => {
  const start = Date.now();
  await sleep(50);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 45, `Expected >= 45ms, got ${elapsed}ms`);
});

test("normalizeErrorDetails handles undefined and null", () => {
  assert.equal(normalizeErrorDetails(undefined), undefined);
  assert.equal(normalizeErrorDetails(null), undefined);
});

test("normalizeErrorDetails handles objects", () => {
  const obj = { code: 42, message: "error" };
  assert.deepEqual(normalizeErrorDetails(obj), obj);
});

test("normalizeErrorDetails wraps primitives", () => {
  assert.deepEqual(normalizeErrorDetails("error"), { value: "error" });
  assert.deepEqual(normalizeErrorDetails(123), { value: 123 });
  assert.deepEqual(normalizeErrorDetails(true), { value: true });
});

test("formatTimestampSpec formats current date", () => {
  const ts = formatTimestampSpec();
  assert.ok(ts.includes("T"));
  assert.ok(ts.endsWith("Z"));
  // Should be parseable as ISO 8601
  const parsed = new Date(ts);
  assert.ok(!isNaN(parsed.getTime()));
});

test("formatTimestampSpec formats provided date", () => {
  const date = new Date("2024-01-15T12:34:56.789Z");
  const ts = formatTimestampSpec(date);
  assert.equal(ts, "2024-01-15T12:34:56.789Z");
});

test("parseTimestampSpec handles valid ISO strings", () => {
  const iso = "2024-01-15T12:34:56.789Z";
  const parsed = parseTimestampSpec(iso);
  assert.ok(parsed instanceof Date);
  assert.equal(parsed.toISOString(), iso);
});

test("parseTimestampSpec returns null for invalid strings", () => {
  assert.equal(parseTimestampSpec("not a date"), null);
  assert.equal(parseTimestampSpec(""), null);
  assert.equal(parseTimestampSpec(null), null);
  assert.equal(parseTimestampSpec(undefined), null);
});
