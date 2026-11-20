import test from "#test/runner";
import assert from "#test/assert";
import { LocalMiniHashEmbedding } from "../src/rag/embeddings.ts";
import { LocalRagRetriever, BASIC_SIGNAL_RE, ASM_SIGNAL_RE } from "../src/rag/retriever.ts";

const model = new LocalMiniHashEmbedding(64);
async function record(text, sourcePath, origin) {
  return { name: sourcePath, language: "other", vector: Array.from(await model.embed(text)), text, sourcePath, sourceMtimeMs: 0, origin };
}
const index = (records) => ({ dim: 64, model: "test", records });

test("KNOWLEDGE-5 language signals do not match ordinary prose", () => {
  for (const prose of ["Read the manual and use the quick brown fox", "Read and write the register", "The bit and the inc are English words", "Data is read from input"]) {
    assert.equal(BASIC_SIGNAL_RE.test(prose), false, prose);
    assert.equal(ASM_SIGNAL_RE.test(prose), false, prose);
  }
  assert.equal(BASIC_SIGNAL_RE.test('10 PRINT "HI"'), true);
  assert.equal(BASIC_SIGNAL_RE.test("X=PEEK(56320)"), true);
  assert.equal(ASM_SIGNAL_RE.test("loop:  lda #$01\n       sta $d020"), true);
  assert.equal(ASM_SIGNAL_RE.test("        INC $D020"), true);
  assert.equal(ASM_SIGNAL_RE.test("        rts ; done"), true);
});

test("KNOWLEDGE-1 asm and basic scopes find reference documents in any index and drop the other language's examples", async () => {
  const doc = await record("## 2. Sprite multiplexing\nSprite multiplexing reuses the eight hardware sprites below each other.", "data/gamedev/techniques.md", "data/gamedev/techniques.md#2. Sprite multiplexing");
  const noise = await record("## Math Helpers\nBASIC ROM floating point helper routines and constants.", "data/basic/rom-routines.md", "data/basic/rom-routines.md#Math Helpers");
  const basicExample = await record("10 REM sprite multiplexing demo\n20 PRINT \"SPRITE\"", "data/basic/examples/sprite.bas");
  const asmExample = await record("sprite multiplexing\n  lda #$01\n  sta $d015", "data/assembly/examples/mux.asm");
  const retriever = new LocalRagRetriever(model, { basic: index([basicExample]), asm: index([asmExample, noise]), other: index([doc]) });

  const asm = await retriever.retrieve("sprite multiplexing", 3, "asm");
  assert.ok(asm.some((hit) => hit.sourcePath === "data/gamedev/techniques.md"), "asm scope reaches a document stored in the 'other' index");
  assert.equal(asm.some((hit) => hit.sourcePath.endsWith(".bas")), false, "asm scope drops BASIC example sources");

  const basic = await retriever.retrieve("sprite multiplexing", 3, "basic");
  assert.ok(basic.some((hit) => hit.sourcePath === "data/gamedev/techniques.md"));
  assert.equal(basic.some((hit) => hit.sourcePath.endsWith(".asm")), false, "basic scope drops assembly example sources");
});

test("KNOWLEDGE-2 a focused chunk outranks a long table that repeats the query words", async () => {
  const focused = await record("## 2. Sprite multiplexing\nSort sprites by Y, then reuse each hardware sprite.", "data/gamedev/techniques.md", "data/gamedev/techniques.md#2. Sprite multiplexing");
  const longTable = await record(`## Games\n${"| Cadaver | sprite multiplexer, multiplexer demo | MIT |\n".repeat(12)}`, "data/gamedev/references.md", "data/gamedev/references.md#Games");
  const filler = await Promise.all(["SID filter registers", "CIA timer registers", "KERNAL jump table", "REU commands"].map((t) => record(`## ${t}\n${t} reference text`, "data/x.md", `data/x.md#${t}`)));
  const retriever = new LocalRagRetriever(model, { other: index([longTable, focused, ...filler]) });
  const hits = await retriever.retrieve("sprite multiplexer", 2);
  assert.equal(hits[0].sourcePath, "data/gamedev/techniques.md");
});
