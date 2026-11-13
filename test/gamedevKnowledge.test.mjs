import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listKnowledgeResources, readKnowledgeResource } from "../src/rag/knowledgeIndex.js";
import { RESOURCE_URIS } from "../src/rag/resourceUris.js";
import { createPromptRegistry } from "../src/prompts/registry.js";
import { LocalMiniHashEmbedding } from "../src/rag/embeddings.js";
import { LocalRagRetriever } from "../src/rag/retriever.js";
import { loadIndexes } from "../src/rag/indexer.js";
import { ragModule } from "../src/tools/rag.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GAMEDEV_URIS = [
  RESOURCE_URIS.gamedev.index,
  RESOURCE_URIS.gamedev.architecture,
  RESOURCE_URIS.gamedev.techniques,
  RESOURCE_URIS.gamedev.toolchain,
  RESOURCE_URIS.gamedev.references,
  RESOURCE_URIS.ultimate.hardware,
  RESOURCE_URIS.ultimate.uci,
  RESOURCE_URIS.ultimate.reu,
  RESOURCE_URIS.ultimate.upic,
  RESOURCE_URIS.ultimate.bench,
];

test("game development and Ultimate resources are listed with usable descriptions", () => {
  const resources = listKnowledgeResources();
  const uris = resources.map((resource) => resource.uri);
  for (const uri of GAMEDEV_URIS) {
    const resource = resources.find((entry) => entry.uri === uri);
    assert.ok(resource, `${uri} should be listed`);
    assert.ok(resource.description.trim().length > 40, `${uri} should have a descriptive description`);
    assert.match(resource.description, /^(CRITICAL: )?Read /, `${uri} description should say when to read it`);
    assert.equal(resource.mimeType, "text/markdown");
  }
  for (const uri of GAMEDEV_URIS.filter((entry) => entry.startsWith("c64://ultimate/"))) {
    assert.match(resources.find((r) => r.uri === uri).description, /modern C64U\/Ultimate/);
  }
  const index = resources.find((entry) => entry.uri === RESOURCE_URIS.gamedev.index);
  assert.equal(index.metadata.priority, "critical");
  assert.ok(index.description.startsWith("CRITICAL:"));
  assert.match(index.description, /modern/);
  assert.match(index.description, /stock C64/);
  // The index is the first resource after the workflow guides.
  assert.equal(uris.indexOf(RESOURCE_URIS.gamedev.index), uris.indexOf(RESOURCE_URIS.guide.fastPaths) + 1);
  // Existing hardware resources link to the game development entry point.
  for (const uri of [RESOURCE_URIS.memory.map, RESOURCE_URIS.graphics.vic.spec, RESOURCE_URIS.io.cia.spec, RESOURCE_URIS.sound.sid.spec]) {
    assert.ok(resources.find((r) => r.uri === uri).metadata.relatedResources.includes(RESOURCE_URIS.gamedev.index));
  }
});

test("game development resources return their file content", () => {
  for (const uri of GAMEDEV_URIS) {
    const resource = listKnowledgeResources().find((entry) => entry.uri === uri);
    const result = readKnowledgeResource(uri, projectRoot);
    assert.ok(result, `${uri} should be readable`);
    assert.equal(result.text, fs.readFileSync(path.join(projectRoot, resource.relativePath), "utf8"));
    assert.ok(result.text.length > 1000, `${uri} should not be empty`);
  }
});

test("game-development prompt defaults to the modern target", () => {
  const registry = createPromptRegistry();
  const result = registry.resolve("game-development", {});
  assert.deepEqual(result.arguments, { target: "modern" });
  assert.equal(result.resources[0].uri, RESOURCE_URIS.gamedev.index);
  assert.ok(result.resources.some((r) => r.uri === RESOURCE_URIS.ultimate.hardware));
  const text = result.messages.map((m) => m.content).join("\n");
  assert.match(text, /\.github\/skills\/game-development\/SKILL\.md/);
  assert.match(text, /c64:\/\/gamedev\/index/);
  assert.match(text, /target is `modern`/);
});

test("game-development prompt supports the authentic target, genre and idea", () => {
  const registry = createPromptRegistry();
  const result = registry.resolve("game-development", { target: "Authentic", genre: "platformer", idea: "a cat jumping" });
  assert.deepEqual(result.arguments, { target: "authentic", genre: "platformer", idea: "a cat jumping" });
  assert.equal(result.resources.some((r) => r.uri === RESOURCE_URIS.ultimate.hardware), false);
  assert.ok(result.resources.some((r) => r.uri === RESOURCE_URIS.graphics.spriteCharset.bestPractices));
  const text = result.messages.map((m) => m.content).join("\n");
  assert.match(text, /Do not use turbo/);
  assert.match(text, /platformer/);
  assert.throws(() => registry.resolve("game-development", { target: "arcade" }), /Expected one of: modern, authentic/);
  const listed = registry.list().find((entry) => entry.descriptor.name === "game-development");
  assert.deepEqual(listed.arguments.find((a) => a.name === "target").options, ["modern", "authentic"]);
});

const DOCS_QUERIES = [
  ["REU streaming", /data\/(ultimate\/reu|gamedev\/architecture)\.md/],
  ["UCI palette", /data\/ultimate\/(uci|upic)\.md/],
  ["turbo D031", /data\/ultimate\/hardware\.md/],
  ["sprite multiplexing", /data\/gamedev\/techniques\.md/],
  ["upic", /data\/ultimate\/upic\.md/],
];

test("unfiltered docs retrieval returns the new docs in the top 3", async () => {
  const model = new LocalMiniHashEmbedding(384);
  const retriever = new LocalRagRetriever(model, await loadIndexes({ embeddingsDir: path.join(projectRoot, "data") }));
  for (const [query, expected] of DOCS_QUERIES) {
    const refs = await retriever.retrieve(query, 3);
    assert.ok(
      refs.some((ref) => expected.test(ref.origin ?? ref.sourcePath ?? "")),
      `"${query}" should return ${expected} in the top 3, got: ${refs.map((r) => r.origin).join(" | ")}`,
    );
  }
});

test("rag_retrieve_docs searches without a language filter", async () => {
  const calls = [];
  const ctx = {
    client: {},
    rag: { async retrieve(query, limit, language) { calls.push({ query, limit, language }); return []; } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const result = await ragModule.invoke("rag_retrieve_docs", { q: "REU streaming" }, ctx);
  assert.deepEqual(calls, [{ query: "REU streaming", limit: 3, language: undefined }]);
  assert.match(result.content[0].text, /c64:\/\/gamedev\/index/);
});
