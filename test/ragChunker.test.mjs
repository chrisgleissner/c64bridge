import test from "#test/runner";
import assert from "#test/assert";
import { chunkMarkdownSections } from "../src/rag/indexer.ts";

const LIMIT = 2500;

function fenceBalanced(text) {
  return (text.match(/^\s*```/gm) ?? []).length % 2 === 0;
}

test("CHUNK-001 a long first paragraph does not produce a header-only or empty chunk", () => {
  const md = `## Heading\n\n${"word ".repeat(700)}\n\nsecond paragraph\n`;
  const chunks = chunkMarkdownSections(md, "doc/x.md");
  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.trim().length > 0, "no empty chunk");
    assert.notEqual(chunk.text.trim(), "## Heading", "no header-only chunk");
    assert.ok(chunk.text.length <= LIMIT, `chunk of ${chunk.text.length} chars exceeds the limit`);
  }
});

test("CHUNK-002 a table without blank lines is split to the size limit and keeps its header row", () => {
  const rows = Array.from({ length: 400 }, (_, i) => `| $${i.toString(16).padStart(4, "0")} | routine ${i} | does something useful |`);
  const md = `## Routines\n\n| Address | Name | Notes |\n|---|---|---|\n${rows.join("\n")}\n`;
  const chunks = chunkMarkdownSections(md, "doc/x.md");
  assert.ok(chunks.length > 3);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= LIMIT, `chunk of ${chunk.text.length} chars exceeds the limit`);
    assert.match(chunk.text, /\| Address \| Name \| Notes \|/, "each piece repeats the table header");
  }
  const joined = chunks.map((c) => c.text).join("\n");
  for (const row of [rows[0], rows[200], rows[399]]) assert.ok(joined.includes(row), "no row is lost");
});

test("CHUNK-003 a long code fence is split on lines and every piece has balanced fences", () => {
  const code = Array.from({ length: 600 }, (_, i) => `  lda #$${(i % 256).toString(16)} ; line ${i}`).join("\n");
  const md = `## Listing\n\n\`\`\`asm\n${code}\n\`\`\`\n`;
  const chunks = chunkMarkdownSections(md, "doc/x.md");
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= LIMIT);
    assert.ok(fenceBalanced(chunk.text), "fences are balanced in every piece");
  }
});

test("CHUNK-004 sections that contain only a heading are dropped", () => {
  const md = `# Title\n\n## Empty\n\n## Real\n\nbody text\n`;
  const chunks = chunkMarkdownSections(md, "doc/x.md");
  assert.deepEqual(chunks.map((c) => c.origin.split("#").slice(1).join("#")), ["Real"]);
});
