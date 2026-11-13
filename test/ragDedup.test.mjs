import test from "#test/runner";
import assert from "#test/assert";
import { deduplicateAndDiversify } from "../src/rag/retriever.ts";

const cand = (snippet, origin, score = 1) => ({ snippet, origin, score });

test("DEDUP-001 the fill pass does not re-add candidates rejected as duplicates", () => {
  const same = "Identical snippet text about sprite multiplexing and raster interrupts";
  const out = deduplicateAndDiversify([cand(same, "a.md#1"), cand(same, "b.md#1"), cand(same, "c.md#1")], 5);
  assert.equal(out.length, 1);
});

test("DEDUP-002 snippets that share their first 100 characters but differ later are both kept", () => {
  const prefix = "This reference section starts with the same boilerplate heading text that is longer than one hundred characters in total. ";
  assert.ok(prefix.length > 100);
  const a = cand(prefix + "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon", "a.md#1", 2);
  const b = cand(prefix + "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen", "b.md#1", 1);
  const out = deduplicateAndDiversify([a, b], 1 + 1);
  assert.equal(out.length, 2);
  assert.equal(deduplicateAndDiversify([a, b], 1).length, 1);
});

test("DEDUP-003 whitespace-only differences are treated as duplicates", () => {
  const out = deduplicateAndDiversify([cand("a  b\n c d e f g h", "x#1"), cand("a b c d e f g h", "y#1")], 3);
  assert.equal(out.length, 1);
});
