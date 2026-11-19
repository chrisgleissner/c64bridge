import test from "#test/runner";
import assert from "#test/assert";
import { ragModule } from "../src/tools/rag.js";

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

test("rag_retrieve_basic returns refs", async () => {
  const calls = [];
  const ctx = {
    client: {},
    rag: {
      async retrieve(query, limit, language) {
        calls.push({ query, limit, language });
        return [
          {
            snippet: '10 PRINT "HELLO"',
            origin: "doc/basic/example.md#Loop",
            uri: "https://example.com/basic/example#Loop",
            score: 0.9876,
            sourcePath: "doc/basic/example.md",
          },
        ];
      },
    },
    logger: createLogger(),
  };

  const result = await ragModule.invoke("rag_retrieve_basic", { q: "hello world" }, ctx);

  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /Supplemental RAG references:/);
  assert.match(result.content[0].text, /10 PRINT "HELLO"/);
  assert.match(result.content[0].text, /score=/);
  assert.equal(result.structuredContent?.type, "json");
  assert.deepEqual(result.structuredContent?.data?.refs, [
    {
      snippet: '10 PRINT "HELLO"',
      score: 0.9876,
      origin: "doc/basic/example.md#Loop",
      uri: "https://example.com/basic/example#Loop",
      sourcePath: "doc/basic/example.md",
    },
  ]);
  assert.ok(Array.isArray(result.structuredContent?.data?.primaryResources));
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.language, "basic");
  assert.equal(result.metadata.limit, 3);
  assert.equal(result.metadata.count, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { query: "hello world", limit: 3, language: "basic" });
});

test("rag_retrieve_asm passes through custom limit", async () => {
  const calls = [];
  const ctx = {
    client: {},
    rag: {
      async retrieve(query, limit, language) {
        calls.push({ query, limit, language });
        return [
          { snippet: "LDX #$00", score: 0.8 },
          { snippet: "JMP LOOP", score: 0.7 },
        ];
      },
    },
    logger: createLogger(),
  };

  const result = await ragModule.invoke("rag_retrieve_asm", { q: "border color", k: 5 }, ctx);

  assert.equal(result.metadata.limit, 5);
  assert.equal(result.metadata.language, "asm");
  assert.equal(result.metadata.count, 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { query: "border color", limit: 5, language: "asm" });
});

test("rag retrieval validates query", async () => {
  const ctx = {
    client: {},
    rag: {
      async retrieve() {
        throw new Error("should not be called");
      },
    },
    logger: createLogger(),
  };

  const result = await ragModule.invoke("rag_retrieve_basic", { q: "" }, ctx);

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
});

test("rag_retrieve_basic formats reference metadata and truncated snippets", async () => {
  const longSnippet = "B".repeat(320);
  const ctx = {
    client: {},
    rag: {
      async retrieve() {
        return [
          {
            snippet: '10 PRINT "HI"',
            origin: "c64://basic/spec#Printing",
            uri: "https://example.com/basic#printing",
            score: 0.75,
          },
          {
            snippet: longSnippet,
            sourcePath: "doc/basic/long.md",
            score: 0.5,
          },
          {
            snippet: "POKE 53280,0",
            uri: "https://example.com/basic#border",
            score: 0.25,
          },
        ];
      },
    },
    logger: createLogger(),
  };

  const result = await ragModule.invoke("rag_retrieve_basic", { q: "print border" }, ctx);
  const text = result.content[0].text;

  assert.match(text, /1\. c64:\/\/basic\/spec#Printing \| link: https:\/\/example.com\/basic#printing \(score=0\.750\)\n   10 PRINT "HI"/);
  assert.match(text, /2\. doc\/basic\/long\.md \(score=0\.500\)\n   B{320}\n/);  // MEDIA-11: the text block uses the structured budget, no 240-character cut
  assert.match(text, /3\. link: https:\/\/example.com\/basic#border \(score=0\.250\)\n   POKE 53280,0/);

  const refs = result.structuredContent?.data?.refs ?? [];
  assert.equal(refs.length, 3);
  assert.equal(refs[0].origin, "c64://basic/spec#Printing");
  assert.equal(refs[1].sourcePath, "doc/basic/long.md");
  assert.equal(refs[2].uri, "https://example.com/basic#border");
});

for (const scope of ["basic", "asm", "docs"]) {
  test(`HARD03-010 ${scope} rejects queries over 500 characters before retrieval`, async () => {
    let calls = 0;
    const ctx = { client: {}, logger: createLogger(), rag: { async retrieve() { calls++; return []; } } };
    const result = await ragModule.invoke(`rag_retrieve_${scope}`, { q: "a".repeat(600) }, ctx);
    assert.equal(result.isError, true);
    assert.equal(result.metadata.error.kind, "validation");
    assert.equal(calls, 0);
  });
}

test("MEDIA-11 the text block keeps line breaks of code and cuts at the structured budget", async () => {
  const code = "loop:  lda $d012\n       cmp #$80\n       bne loop\n\n       rts";
  const huge = `${"x".repeat(1500)}`;
  const ctx = { client: {}, logger: createLogger(), rag: { async retrieve() { return [{ snippet: code, origin: "c64://gamedev/techniques#1", score: 0.9 }, { snippet: huge, origin: "big", score: 0.5 }]; } } };
  const result = await ragModule.invoke("rag_retrieve_docs", { q: "raster wait" }, ctx);
  const text = result.content[0].text;
  assert.ok(text.includes("\n   loop:  lda $d012\n          cmp #$80\n          bne loop\n\n          rts"), text);
  const second = text.split("2. big")[1];
  assert.ok(second.includes("…") && !second.includes("..."), "cut at the budget with an ellipsis");
  assert.ok(second.trim().length > 900, "budget is 1200 characters, not 240");
});

test("KNOWLEDGE-4 a query of only spaces is rejected before retrieval", async () => {
  let calls = 0;
  const ctx = { client: {}, logger: createLogger(), rag: { async retrieve() { calls++; return []; } } };
  for (const q of ["     ", "\t \n  "]) {
    const result = await ragModule.invoke("rag_retrieve_docs", { q }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /at least 3 non-space/);
  }
  assert.equal(calls, 0);
});
