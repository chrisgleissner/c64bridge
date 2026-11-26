import test from "#test/runner";
import assert from "#test/assert";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, SKILLS_EXT, startServer } from "./helpers/modernClient.mjs";

// Skill catalogue served over the MCP Skills extension and as c64://skills/<name>.
// The expected names come from the skill directories, minus the one deliberately excluded skill.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(repoRoot, ".github", "skills");
const EXCLUDED_SKILLS = new Set(["pr-converge"]);
const EXPECTED_NAMES = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !EXCLUDED_SKILLS.has(entry.name))
  .map((entry) => entry.name)
  .sort();

const TRANSPORTS = ["stdio", "http"];
const PAGE_SIZE = 5;
const INVALID_PARAMS_CODE = -32602;

const TEST_OPTIONS = { timeout: 180_000 };

const SKILL_URI_PREFIX = "skill://";
const LEGACY_URI_PREFIX = "c64://skills/";
const skillUri = (name) => `${SKILL_URI_PREFIX}${name}/SKILL.md`;
const legacyUri = (name) => `${LEGACY_URI_PREFIX}${name}`;
const nameFromSkillUri = (uri) => uri.slice(SKILL_URI_PREFIX.length, -"/SKILL.md".length);

const NOT_FOUND_URIS = [
  "skill://nope/SKILL.md",
  "skill://pr-converge/SKILL.md",
  "skill://hello-world/missing.md",
  "skill://hello-world/../basic-program/SKILL.md",
  "skill://hello-world/%2e%2e/basic-program/SKILL.md",
  "skill://../etc/passwd",
  "skill:///etc/passwd",
  "skill://hello-world/",
];

const INVALID_CURSORS = [
  ["not base64url", "!!!"],
  ["base64url of non-JSON text", "bm90LWpzb24"],
];

function sha256Digest(text) {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

/** Text of the first content block of a `resources/read` result. */
function readText(result, uri) {
  const block = result?.contents?.[0];
  assert.ok(block, `resources/read ${uri}: no contents in ${JSON.stringify(result)}`);
  assert.equal(typeof block.text, "string", `resources/read ${uri}: text missing`);
  return block.text;
}

/** Follows `nextCursor` until the listing ends; returns the concatenated items. */
async function listAll(client, method, key) {
  const items = [];
  let cursor;
  do {
    const result = await client.ok(method, cursor === undefined ? {} : { cursor });
    items.push(...result[key]);
    cursor = result.nextCursor;
  } while (cursor !== undefined);
  return items;
}

function assertRpcError(reply, code, label) {
  assert.equal(reply.result, undefined, `${label}: expected an error, got a result`);
  assert.ok(reply.error, `${label}: expected an error, got ${JSON.stringify(reply)}`);
  assert.equal(reply.error.code, code, `${label}: ${JSON.stringify(reply.error)}`);
}

async function checkModernSkillsList(client) {
  const result = await client.ok("skills/list", {});
  assert.deepEqual(result.skills.map((entry) => entry.uri), EXPECTED_NAMES.map(skillUri), "skills/list uris in name order");
  assert.equal(result.nextCursor, undefined, "skills/list without paging returns no nextCursor");
  assert.ok(Number.isInteger(result.ttlMs) && result.ttlMs >= 0, `ttlMs ${JSON.stringify(result.ttlMs)}`);
  assert.ok(["public", "private"].includes(result.cacheScope), `cacheScope ${JSON.stringify(result.cacheScope)}`);

  for (const entry of result.skills) {
    const name = nameFromSkillUri(entry.uri);
    assert.equal(entry.frontmatter?.name, name, `frontmatter.name of ${entry.uri}`);
    assert.ok(typeof entry.frontmatter?.description === "string" && entry.frontmatter.description.trim() !== "", `description of ${name}`);
    const descriptor = entry.resources.find((resource) => resource.uri === entry.uri);
    assert.ok(descriptor, `${name}: resources lists its SKILL.md`);

    const text = readText(await client.ok("resources/read", { uri: entry.uri }), entry.uri);
    assert.equal(descriptor.digest, sha256Digest(text), `${name}: digest of served bytes`);
    assert.equal(descriptor.size, Buffer.byteLength(text), `${name}: size of served bytes`);

    const legacyText = readText(await client.ok("resources/read", { uri: legacyUri(name) }), legacyUri(name));
    assert.equal(legacyText, text, `${name}: c64://skills text differs from ${entry.uri}`);

    const got = await client.ok("skills/get", { uri: entry.uri });
    assert.deepEqual(got.skill, entry, `skills/get ${entry.uri} equals the listing entry`);
    assert.ok(Number.isInteger(got.ttlMs) && got.ttlMs >= 0, `skills/get ttlMs for ${name}`);
    assert.ok(["public", "private"].includes(got.cacheScope), `skills/get cacheScope for ${name}`);
  }

  const unknown = await client.request("skills/get", { uri: "skill://nope/SKILL.md" });
  assertRpcError(unknown, INVALID_PARAMS_CODE, "skills/get unknown uri");
}

async function checkLegacySkillsList(client) {
  const result = await client.ok("skills/list", {});
  assert.equal(result.skills.length, EXPECTED_NAMES.length, "legacy skills/list answers with all skills");
  assert.equal("ttlMs" in result, false, "legacy skills/list carries no ttlMs");
  assert.equal("cacheScope" in result, false, "legacy skills/list carries no cacheScope");

  const hello = readText(await client.ok("resources/read", { uri: skillUri("hello-world") }), skillUri("hello-world"));
  const helloLegacy = readText(await client.ok("resources/read", { uri: legacyUri("hello-world") }), legacyUri("hello-world"));
  assert.equal(helloLegacy, hello, "legacy client: c64://skills/hello-world equals skill://hello-world/SKILL.md");
}

async function checkNotFound(client, label) {
  for (const uri of NOT_FOUND_URIS) {
    const reply = await client.request("resources/read", { uri });
    assertRpcError(reply, INVALID_PARAMS_CODE, `${label} resources/read ${uri}`);
    assert.equal(reply.error.data?.uri, uri, `${label} ${uri}: error.data.uri`);
  }
}

async function checkResourceList(client, label) {
  const uris = (await listAll(client, "resources/list", "resources")).map((resource) => resource.uri);
  assert.equal(new Set(uris).size, uris.length, `${label} resources/list has duplicate uris`);
  assert.equal(uris.filter((uri) => uri.startsWith(SKILL_URI_PREFIX)).length, 0, `${label} resources/list lists no skill:// uris`);
  const skillUris = uris.filter((uri) => uri.startsWith(LEGACY_URI_PREFIX));
  assert.equal(skillUris.length, EXPECTED_NAMES.length, `${label} resources/list skill entries`);
  assert.deepEqual([...skillUris].sort(), EXPECTED_NAMES.map(legacyUri).sort(), `${label} resources/list skill uris`);
}


for (const transport of TRANSPORTS) {
  test(`[${transport}] skills extension for a modern client, legacy client, not-found, resource and prompt listings`, TEST_OPTIONS, async (t) => {
    const modernServer = await startServer(t, { transport });
    const legacyServer = await startServer(t, { transport });
    const modern = await connect(modernServer, { era: "modern", extensions: { [SKILLS_EXT]: {} } });
    const legacy = await connect(legacyServer, { era: "legacy" });

    await checkModernSkillsList(modern);
    await checkLegacySkillsList(legacy);
    await checkNotFound(modern, "modern");
    await checkNotFound(legacy, "legacy");
    await checkResourceList(modern, "modern");
    await checkResourceList(legacy, "legacy");

    const modernPrompts = await listAll(modern, "prompts/list", "prompts");
    const legacyPrompts = await listAll(legacy, "prompts/list", "prompts");
    assert.deepEqual(legacyPrompts, modernPrompts, "prompts/list is identical for legacy and modern clients");
  });

  test(`[${transport}] skills/list pagination with page size ${PAGE_SIZE}`, TEST_OPTIONS, async (t) => {
    const server = await startServer(t, { transport, env: { C64BRIDGE_SKILLS_PAGE_SIZE: String(PAGE_SIZE) } });
    const client = await connect(server, { era: "modern", extensions: { [SKILLS_EXT]: {} } });

    const expectedSizes = [PAGE_SIZE, PAGE_SIZE, EXPECTED_NAMES.length - 2 * PAGE_SIZE];
    const names = [];
    let cursor;
    for (const [index, size] of expectedSizes.entries()) {
      const result = await client.ok("skills/list", cursor === undefined ? {} : { cursor });
      assert.equal(result.skills.length, size, `page ${index + 1} size`);
      if (index < expectedSizes.length - 1) {
        assert.equal(typeof result.nextCursor, "string", `page ${index + 1} has nextCursor`);
      } else {
        assert.equal(result.nextCursor, undefined, "last page has no nextCursor");
      }
      names.push(...result.skills.map((entry) => nameFromSkillUri(entry.uri)));
      cursor = result.nextCursor;
    }
    assert.deepEqual(names, EXPECTED_NAMES, "concatenated pages equal the full ordered list");
    assert.equal(new Set(names).size, names.length, "no duplicates across pages");

    for (const [label, badCursor] of INVALID_CURSORS) {
      const reply = await client.request("skills/list", { cursor: badCursor });
      assertRpcError(reply, INVALID_PARAMS_CODE, `invalid cursor (${label})`);
    }
  });
}
