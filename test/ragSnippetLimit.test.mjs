import test from "#test/runner";
import assert from "#test/assert";
import { ragModule } from "../src/tools/rag.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("RAGLIMIT-001 structured hits carry capped snippets and flag truncation", async () => {
  const big = "x".repeat(14000);
  const refs = Array.from({ length: 12 }, (_, i) => ({ snippet: big, origin: `AGENTS.md#${i}`, uri: "c64://guide/index", score: 1 - i / 100 }));
  const ctx = { rag: { async retrieve() { return refs; } }, logger };
  const result = await ragModule.invoke("rag_retrieve_docs", { q: "reu", k: 12 }, ctx);
  const hits = result.structuredContent.data.refs;
  assert.equal(hits.length, 12);
  const total = hits.reduce((n, h) => n + h.snippet.length, 0);
  assert.ok(total <= 6500, `total snippet characters ${total}`);
  for (const hit of hits) {
    assert.equal(hit.truncated, true);
    assert.equal(hit.snippetChars, 14000);
    assert.equal(hit.uri, "c64://guide/index");
  }
  assert.ok(JSON.stringify(result).length < 25000, `response is ${JSON.stringify(result).length} bytes`);
});

test("RAGLIMIT-002 short snippets are returned unchanged", async () => {
  const ctx = { rag: { async retrieve() { return [{ snippet: "short text", origin: "a#b", score: 0.5 }]; } }, logger };
  const result = await ragModule.invoke("rag_retrieve_basic", { q: "print hello" }, ctx);
  const hit = result.structuredContent.data.refs[0];
  assert.equal(hit.snippet, "short text");
  assert.equal(hit.truncated, undefined);
});
