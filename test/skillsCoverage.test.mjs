import test from "#test/runner";
import assert from "#test/assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSkillDiagnostics, listSkillExtensionEntries, readSkillBytes } from "../src/mcp/skills.ts";
import { SKILLS_PAGE_SIZE_ENV, isSkillExtensionUri, readSkillExtensionResource, registerSkillsHandlers } from "../src/mcp/skillsAdapter.js";

function fixture(skills) {
  const root = mkdtempSync(join(tmpdir(), "skill-cov-"));
  const base = join(root, ".github", "skills");
  mkdirSync(base, { recursive: true });
  for (const [dir, files] of Object.entries(skills)) {
    mkdirSync(join(base, dir), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(base, dir, file, ".."), { recursive: true });
      writeFileSync(join(base, dir, file), content);
    }
  }
  return { root, base, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const md = (name, extra = "") => `---\nname: ${name}\ndescription: Use when testing.\n${extra}---\n\nBody\n`;

test("catalogue: MIME types follow the file extension", () => {
  const expected = {
    "a.md": "text/markdown", "a.markdown": "text/markdown", "a.txt": "text/plain", "a.json": "application/json",
    "a.yaml": "application/yaml", "a.yml": "application/yaml", "a.js": "text/javascript", "a.mjs": "text/javascript",
    "a.ts": "text/typescript", "a.py": "text/x-python", "a.sh": "application/x-sh", "a.html": "text/html",
    "a.css": "text/css", "a.csv": "text/csv", "a.svg": "image/svg+xml", "a.png": "image/png",
    "a.BIN": "application/octet-stream", "noextension": "application/octet-stream",
  };
  const files = { "SKILL.md": md("mime") };
  for (const name of Object.keys(expected)) files[`refs/${name}`] = "x";
  const f = fixture({ mime: files });
  try {
    for (const [name, mime] of Object.entries(expected)) {
      assert.equal(readSkillBytes(`skill://mime/refs/${name}`, { root: f.root })?.mimeType, mime, name);
    }
    assert.equal(readSkillBytes("skill://mime/SKILL.md", { root: f.root }).mimeType, "text/markdown");
  } finally {
    f.cleanup();
  }
});

test("catalogue: files with unsupported names, dangling symlinks and dot files are skipped with diagnostics", () => {
  const f = fixture({ odd: { "SKILL.md": md("odd"), "bad name.txt": "x", "-lead.txt": "x", ".hidden": "x", "ok.txt": "x" } });
  try {
    symlinkSync(join(f.base, "odd", "missing-target"), join(f.base, "odd", "dangling.txt"));
    const [entry] = listSkillExtensionEntries({ root: f.root });
    assert.deepEqual(entry.resources.map((r) => r.uri), ["skill://odd/SKILL.md", "skill://odd/ok.txt"]);
    const messages = getSkillDiagnostics({ root: f.root }).map((d) => d.message);
    assert.ok(messages.some((m) => m.includes("file bad name.txt skipped: unsupported characters")));
    assert.ok(messages.some((m) => m.includes("file -lead.txt skipped: unsupported characters")));
    assert.ok(messages.some((m) => m.includes("symlink dangling.txt skipped: target does not exist")));
    assert.equal(messages.some((m) => m.includes(".hidden")), false);
  } finally {
    f.cleanup();
  }
});

test("catalogue: a symlink to a file inside the skill directory is served", () => {
  const f = fixture({ inner: { "SKILL.md": md("inner"), "real.txt": "content" } });
  try {
    symlinkSync("real.txt", join(f.base, "inner", "alias.txt"));
    const uris = listSkillExtensionEntries({ root: f.root })[0].resources.map((r) => r.uri);
    assert.ok(uris.includes("skill://inner/alias.txt"));
    assert.equal(Buffer.from(readSkillBytes("skill://inner/alias.txt", { root: f.root }).bytes).toString(), "content");
  } finally {
    f.cleanup();
  }
});

test("catalogue: invalid compatibility, metadata and UTF-8 exclude the skill with a specific diagnostic", () => {
  const f = fixture({
    good: { "SKILL.md": md("good", "compatibility: works\nmetadata:\n  a: b\n") },
    "compat-empty": { "SKILL.md": md("compat-empty", 'compatibility: ""\n') },
    "compat-type": { "SKILL.md": md("compat-type", "compatibility: 5\n") },
    "compat-long": { "SKILL.md": md("compat-long", `compatibility: ${"x".repeat(501)}\n`) },
    "meta-list": { "SKILL.md": md("meta-list", "metadata: [a]\n") },
    "meta-number": { "SKILL.md": md("meta-number", "metadata:\n  a: 1\n") },
    "meta-scalar": { "SKILL.md": md("meta-scalar", "metadata: text\n") },
    "bad-utf8": { "SKILL.md": Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]) },
    "not-mapping": { "SKILL.md": "---\n- a\n- b\n---\nbody\n" },
    "no-skill-md": { "README.md": "x" },
  });
  try {
    assert.deepEqual(listSkillExtensionEntries({ root: f.root }).map((e) => e.frontmatter.name), ["good"]);
    const by = new Map(getSkillDiagnostics({ root: f.root }).map((d) => [d.skill, d.message]));
    for (const dir of ["compat-empty", "compat-type", "compat-long"]) assert.match(by.get(dir), /compatibility must be a string of 1-500 characters/, dir);
    for (const dir of ["meta-list", "meta-number", "meta-scalar"]) assert.match(by.get(dir), /metadata must map strings to strings/, dir);
    assert.match(by.get("bad-utf8"), /not valid UTF-8/);
    assert.match(by.get("not-mapping"), /must be a YAML mapping/);
    assert.equal(by.has("no-skill-md"), false, "a directory without SKILL.md is not a skill");
  } finally {
    f.cleanup();
  }
});

test("catalogue: a missing skills directory yields an empty catalogue without diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-cov-empty-"));
  try {
    assert.deepEqual(listSkillExtensionEntries({ root }), []);
    assert.deepEqual(getSkillDiagnostics({ root }), []);
    assert.equal(readSkillBytes("skill://x/SKILL.md", { root }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalogue: a skill directory symlink that resolves outside the skills directory is rejected", () => {
  const outside = mkdtempSync(join(tmpdir(), "skill-cov-out-"));
  writeFileSync(join(outside, "SKILL.md"), md("linked"));
  const f = fixture({});
  try {
    symlinkSync(outside, join(f.base, "linked"));
    assert.deepEqual(listSkillExtensionEntries({ root: f.root }), []);
    assert.ok(getSkillDiagnostics({ root: f.root }).some((d) => d.skill === "linked" && /outside the skills directory/.test(d.message)));
  } finally {
    f.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("catalogue: a skill directory symlink inside the skills directory is served under its link name", () => {
  const f = fixture({ target: { "SKILL.md": md("alias") } });
  try {
    symlinkSync(join(f.base, "target"), join(f.base, "alias"));
    assert.deepEqual(listSkillExtensionEntries({ root: f.root }).map((e) => e.frontmatter.name), ["alias"]);
  } finally {
    f.cleanup();
  }
});

function fakeServer() {
  const handlers = new Map();
  return { handlers, setRequestHandler: (method, _schema, fn) => handlers.set(method, fn) };
}

async function withPageSize(value, fn) {
  const previous = process.env[SKILLS_PAGE_SIZE_ENV];
  if (value === undefined) delete process.env[SKILLS_PAGE_SIZE_ENV];
  else process.env[SKILLS_PAGE_SIZE_ENV] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[SKILLS_PAGE_SIZE_ENV];
    else process.env[SKILLS_PAGE_SIZE_ENV] = previous;
  }
}

const withEnvelope = { mcpReq: { envelope: {} } };
const withoutEnvelope = { mcpReq: {} };

test("skills/list: page size comes from the environment, cursors continue, cache fields need an envelope", async () => {
  const server = fakeServer();
  registerSkillsHandlers(server);
  const list = server.handlers.get("skills/list");
  const all = listSkillExtensionEntries().map((e) => e.uri);
  await withPageSize("4", async () => {
    const first = await list({}, withEnvelope);
    assert.equal(first.skills.length, 4);
    assert.equal(typeof first.nextCursor, "string");
    assert.equal(first.ttlMs, 60_000);
    assert.equal(first.cacheScope, "public");
    const collected = first.skills.map((e) => e.uri);
    let cursor = first.nextCursor;
    while (cursor !== undefined) {
      const page = await list({ cursor }, withoutEnvelope);
      assert.equal("ttlMs" in page, false);
      assert.equal("cacheScope" in page, false);
      collected.push(...page.skills.map((e) => e.uri));
      cursor = page.nextCursor;
    }
    assert.deepEqual(collected, all);
  });
  for (const bad of ["0", "-1", "2.5", "abc", "", "  "]) {
    await withPageSize(bad, async () => {
      const page = await list({}, withoutEnvelope);
      assert.equal(page.skills.length, all.length, `page size ${JSON.stringify(bad)} falls back to the default`);
      assert.equal(page.nextCursor, undefined);
    });
  }
  await withPageSize(undefined, async () => {
    assert.equal((await list({}, withoutEnvelope)).skills.length, all.length);
  });
});

test("skills/list: an invalid cursor is an invalid-params protocol error", async () => {
  const server = fakeServer();
  registerSkillsHandlers(server);
  await assert.rejects(server.handlers.get("skills/list")({ cursor: "!!!" }, withoutEnvelope), (error) => {
    assert.equal(error.name, "ProtocolError");
    assert.equal(error.code, -32602);
    assert.match(error.message, /Invalid skills cursor/);
    return true;
  });
});

test("skills/get: returns the entry for a known uri and rejects an unknown uri", async () => {
  const server = fakeServer();
  registerSkillsHandlers(server);
  const get = server.handlers.get("skills/get");
  const result = await get({ uri: "skill://hello-world/SKILL.md" }, withEnvelope);
  assert.equal(result.skill.frontmatter.name, "hello-world");
  assert.equal(result.ttlMs, 60_000);
  assert.equal("ttlMs" in (await get({ uri: "skill://hello-world/SKILL.md" }, withoutEnvelope)), false);
  await assert.rejects(get({ uri: "skill://nope/SKILL.md" }, withoutEnvelope), (error) => {
    assert.equal(error.code, -32602);
    assert.match(error.message, /No skill is served at skill:\/\/nope\/SKILL\.md/);
    return true;
  });
});

test("skill extension resources: uri detection, unknown uri and binary fallback", () => {
  assert.equal(isSkillExtensionUri("skill://a/SKILL.md"), true);
  assert.equal(isSkillExtensionUri("c64://skills/a"), false);
  assert.throws(() => readSkillExtensionResource("skill://nope/SKILL.md"), /Unknown resource: skill:\/\/nope\/SKILL\.md/);
  const f = fixture({ bin: { "SKILL.md": md("bin"), "data.bin": Buffer.from([0xff, 0xfe, 0x00]) } });
  try {
    const result = readSkillExtensionResource("skill://bin/data.bin", { root: f.root });
    assert.equal(result.blob, Buffer.from([0xff, 0xfe, 0x00]).toString("base64"));
    assert.equal("text" in result, false);
    assert.equal(result.mimeType, "application/octet-stream");
  } finally {
    f.cleanup();
  }
});
