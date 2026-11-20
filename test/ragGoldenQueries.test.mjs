import test from "#test/runner";
import assert from "#test/assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalMiniHashEmbedding } from "../src/rag/embeddings.ts";
import { loadIndexes } from "../src/rag/indexer.ts";
import { LocalRagRetriever } from "../src/rag/retriever.ts";

// Golden set (KNOWLEDGE-2): realistic C64 game development questions, each with the document
// URI(s) that must appear in the top 3. A query lists several URIs only where more than one
// document answers it. Ranking changes must be general; do not add query-specific rules.
const T = "c64://gamedev/techniques";
const ARCH = "c64://gamedev/architecture";
const TOOL = "c64://gamedev/toolchain";
const VIC = "c64://graphics/vic/spec";
const CIA = "c64://io/cia/spec";
const SID = "c64://sound/sid/spec";
const GOLDEN = [
  // docs scope (no language filter)
  ["docs", "sprite multiplexer", [T]],
  ["docs", "set up a raster interrupt at line 100", [T]],
  ["docs", "stable raster interrupt double IRQ", [T]],
  ["docs", "how many cycles per raster line PAL", [ARCH, VIC]],
  ["docs", "bad line cycle stealing", [VIC, ARCH]],
  ["docs", "smooth horizontal scrolling with $D016", [T]],
  ["docs", "read joystick port 2 fire button", [T, CIA]],
  ["docs", "SID filter cutoff", [SID]],
  ["docs", "disable BASIC and KERNAL ROM", [ARCH, "c64://memory/map", "c64://memory/zero-page-and-workspace"]],
  ["docs", "turbo mode register 48 MHz", ["c64://ultimate/hardware"]],
  ["docs", "CIA timer 1 interrupt", [CIA]],
  ["docs", "VIC bank select dd00", [ARCH, CIA, "c64://io/spec"]],
  ["docs", "REU DMA transfer", ["c64://ultimate/reu"]],
  ["docs", "open top and bottom border", [VIC, "c64://graphics/sprite-charset/best-practices"]],
  ["docs", "KERNAL SETLFS SETNAM LOAD calling convention", ["c64://kernal/rom-routines"]],
  ["docs", "NMI disable restore key", [T, CIA]],
  ["docs", "exomizer decrunch", [T, TOOL]],
  ["docs", "PETSCII screen code conversion", ["c64://graphics/petscii/style-guide", "c64://basic/pitfalls", "c64://graphics/character-set"]],
  ["docs", "custom charset memory d018", ["c64://graphics/sprite-charset/best-practices", VIC]],
  ["docs", "collision detection sprite d01e", [T, VIC]],
  ["docs", "cc65 linker config c64 memory layout", [TOOL]],
  ["docs", "llvm-mos c64", [TOOL]],
  ["docs", "SID play routine IRQ music player", [T]],
  ["docs", "detect PAL or NTSC at start", [T]],
  ["docs", "UCI command interface", ["c64://ultimate/uci"]],
  ["docs", "PSID header load address init play", ["c64://sound/sid/file-format"]],
  ["docs", "Pressure Glass SIDWAVE acid line resonance accents", ["c64://sound/examples/acid_line"]],
  ["docs", "An Atlas of Wind 24 voice SIDWAVE orchestra unison strings", ["c64://sound/examples/ultisid_orchestra"]],
  ["docs", "Gilt Footsteps waltz three independent voices 3/4", ["c64://sound/examples/chamber_waltz"]],
  // asm scope
  ["asm", "sprite multiplexer", [T]],
  ["asm", "scroll screen left one column", [T]],
  ["asm", "read joystick port 2 fire button", [T, CIA]],
  ["asm", "raster interrupt acknowledge d019", [T]],
  ["asm", "6502 instruction cycle counts", ["c64://assembly/6510-spec"]],
  // basic scope
  ["basic", "read joystick PEEK(56320)", ["c64://basic/spec"]],
  ["basic", "BASIC variable names only first two characters significant", ["c64://basic/pitfalls"]],
  ["basic", "PRINT to printer device 4", ["c64://basic/spec", "c64://printer/spec", "c64://printer/commodore/text"]],
];

const model = new LocalMiniHashEmbedding(384);
const retriever = new LocalRagRetriever(model, await loadIndexes({
  // scripts/run-tests sets RAG_EMBEDDINGS_DIR to an empty fixture directory, so the shipped
  // indexes are named explicitly instead of resolved from the environment.
  embeddingsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data"),
}));

test("RAGGOLD-001 golden queries return the expected document in the top 3", async () => {
  const failures = [];
  for (const [scope, query, expected] of GOLDEN) {
    const hits = await retriever.retrieve(query, 3, scope === "docs" ? undefined : scope);
    const uris = hits.map((hit) => (hit.uri ?? "").split("#")[0]);
    if (!expected.some((uri) => uris.includes(uri))) {
      failures.push(`[${scope}] ${JSON.stringify(query)} expected ${expected.join(" | ")} got ${uris.join(", ")}`);
    }
  }
  assert.ok(GOLDEN.length >= 25);
  assert.deepEqual(failures, [], `${failures.length} of ${GOLDEN.length} golden queries failed:\n${failures.join("\n")}`);
});
