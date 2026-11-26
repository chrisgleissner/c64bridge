import test from "#test/runner";
import assert from "#test/assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSkillDiagnostics,
  listSkillExtensionEntries,
  listSkillResources,
  pageSkillExtensionEntries,
  readSkillBytes,
  readSkillResource,
  SkillCursorError,
} from "../src/mcp/skills.ts";

const REAL_ROOT = new URL("..", import.meta.url).pathname;

function fixture(skills) {
  const root = mkdtempSync(join(tmpdir(), "skill-catalogue-"));
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

const md = (name, description = "Use when testing.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n## Intent\nBody of ${name}\n`;

test("catalogue: sorted by name and pr-converge excluded", () => {
  const f = fixture({ zeta: { "SKILL.md": md("zeta") }, alpha: { "SKILL.md": md("alpha") }, "pr-converge": { "SKILL.md": md("pr-converge") } });
  try {
    const names = listSkillExtensionEntries({ root: f.root }).map((entry) => entry.frontmatter.name);
    assert.deepEqual(names, ["alpha", "zeta"]);
    assert.deepEqual(listSkillResources(f.root).map((s) => s.uri), ["c64://skills/alpha", "c64://skills/zeta"]);
  } finally {
    f.cleanup();
  }
});

test("catalogue: the real repository serves 13 skills in name order", () => {
  const entries = listSkillExtensionEntries();
  assert.equal(entries.length, 13);
  const names = entries.map((entry) => entry.frontmatter.name);
  assert.deepEqual(names, [...names].sort());
  assert.equal(names.includes("pr-converge"), false);
  assert.deepEqual(getSkillDiagnostics(), []);
});

test("catalogue: YAML error, invalid name, name mismatch and bad description are reported and excluded", () => {
  const f = fixture({
    good: { "SKILL.md": md("good") },
    broken: { "SKILL.md": "---\nname: [unclosed\ndescription: x\n---\nbody\n" },
    "Bad_Name": { "SKILL.md": md("Bad_Name") },
    "double--hyphen": { "SKILL.md": md("double--hyphen") },
    mismatch: { "SKILL.md": md("other") },
    nodesc: { "SKILL.md": "---\nname: nodesc\n---\nbody\n" },
    longdesc: { "SKILL.md": md("longdesc", "x".repeat(1025)) },
    nofront: { "SKILL.md": "just text\n" },
  });
  try {
    const names = listSkillExtensionEntries({ root: f.root }).map((entry) => entry.frontmatter.name);
    assert.deepEqual(names, ["good"]);
    const diagnostics = getSkillDiagnostics({ root: f.root });
    const bySkill = new Map(diagnostics.map((d) => [d.skill, d.message]));
    for (const dir of ["broken", "Bad_Name", "double--hyphen", "mismatch", "nodesc", "longdesc", "nofront"]) {
      assert.ok(bySkill.has(dir), `diagnostic for ${dir}`);
    }
    assert.match(bySkill.get("mismatch"), /directory/);
  } finally {
    f.cleanup();
  }
});

test("catalogue: duplicate names are rejected", () => {
  // Two directories cannot share a name, so a duplicate can only come from a name that differs from its directory.
  const f = fixture({ one: { "SKILL.md": md("one") }, two: { "SKILL.md": md("one") } });
  try {
    const names = listSkillExtensionEntries({ root: f.root }).map((entry) => entry.frontmatter.name);
    assert.deepEqual(names, ["one"]);
    assert.ok(getSkillDiagnostics({ root: f.root }).some((d) => d.skill === "two"));
  } finally {
    f.cleanup();
  }
});

test("catalogue: digest and size describe exactly the served bytes", () => {
  const f = fixture({
    demo: { "SKILL.md": `${md("demo")}\nSee .github/skills/hello-world/SKILL.md\n`, "refs/notes.txt": "plain notes\n" },
  });
  try {
    const [entry] = listSkillExtensionEntries({ root: f.root });
    assert.equal(entry.uri, "skill://demo/SKILL.md");
    assert.deepEqual(entry.resources.map((r) => r.uri), ["skill://demo/SKILL.md", "skill://demo/refs/notes.txt"]);
    for (const resource of entry.resources) {
      const served = readSkillBytes(resource.uri, { root: f.root });
      assert.ok(served, resource.uri);
      assert.equal(resource.size, served.bytes.byteLength);
      assert.equal(resource.digest, `sha256:${createHash("sha256").update(served.bytes).digest("hex")}`);
    }
    const skillMd = Buffer.from(readSkillBytes("skill://demo/SKILL.md", { root: f.root }).bytes).toString("utf8");
    assert.ok(skillMd.includes("c64://skills/hello-world"));
    assert.equal(skillMd.includes(".github/skills"), false);
    assert.equal(readSkillBytes("skill://demo/refs/notes.txt", { root: f.root }).mimeType, "text/plain");
  } finally {
    f.cleanup();
  }
});

test("catalogue: skill:// and c64://skills serve identical content", () => {
  for (const entry of listSkillExtensionEntries()) {
    const name = entry.frontmatter.name;
    const a = readSkillBytes(`skill://${name}/SKILL.md`);
    const b = readSkillBytes(`c64://skills/${name}`);
    assert.ok(a && b, name);
    assert.deepEqual(Buffer.from(a.bytes), Buffer.from(b.bytes));
    assert.equal(a.mimeType, "text/markdown");
    const legacy = readSkillResource(`c64://skills/${name}`);
    assert.equal(legacy.text, Buffer.from(a.bytes).toString("utf8"));
    assert.equal(legacy.uri, `c64://skills/${name}`);
    assert.equal(a.uri, `skill://${name}/SKILL.md`);
  }
});

test("catalogue: pagination returns pages, a final page without cursor, and rejects invalid cursors", () => {
  const all = listSkillExtensionEntries().map((entry) => entry.uri);
  const collected = [];
  let cursor;
  let pages = 0;
  do {
    const page = pageSkillExtensionEntries({ cursor, pageSize: 5 });
    assert.ok(page.entries.length <= 5);
    collected.push(...page.entries.map((entry) => entry.uri));
    cursor = page.nextCursor;
    pages += 1;
    if (cursor !== undefined) assert.equal(typeof cursor, "string");
  } while (cursor !== undefined && pages < 10);
  assert.equal(pages, 3);
  assert.deepEqual(collected, all);
  assert.equal(pageSkillExtensionEntries({ pageSize: 100 }).nextCursor, undefined);
  assert.equal(pageSkillExtensionEntries({ pageSize: 13 }).nextCursor, undefined);
  for (const bad of ["", "not base64 !!", Buffer.from("{}").toString("base64url"), Buffer.from('{"after":5}').toString("base64url"), Buffer.from("plain").toString("base64url")]) {
    assert.throws(() => pageSkillExtensionEntries({ cursor: bad, pageSize: 5 }), SkillCursorError, `cursor ${bad}`);
  }
  assert.throws(() => pageSkillExtensionEntries({ pageSize: 0 }), RangeError);
});

test("catalogue: unknown URIs resolve to undefined", () => {
  for (const uri of ["skill://nope/SKILL.md", "c64://skills/nope", "c64://skills/pr-converge", "skill://hello-world/missing.md", "skill://hello-world", "http://x/y", "c64://skills/", "skill:///SKILL.md"]) {
    assert.equal(readSkillBytes(uri), undefined, uri);
  }
  assert.equal(readSkillResource("c64://skills/nope"), undefined);
});

test("catalogue: path traversal in URIs is rejected", () => {
  const f = fixture({ x: { "SKILL.md": md("x") }, y: { "SKILL.md": md("y") } });
  try {
    for (const uri of [
      "skill://x/../y/SKILL.md",
      "skill://x/%2e%2e/y/SKILL.md",
      "skill://x/%2E%2E/y/SKILL.md",
      "skill://x/..%2fy/SKILL.md",
      "skill://x/./SKILL.md",
      "skill://x//SKILL.md",
      "skill://x/..\\y\\SKILL.md",
      "skill://x/SKILL.md%00",
      "skill://../x/SKILL.md",
      "c64://skills/../x",
      "c64://skills/x/../y",
      "c64://skills/%2e%2e",
    ]) {
      assert.equal(readSkillBytes(uri, { root: f.root }), undefined, uri);
    }
    assert.ok(readSkillBytes("skill://x/SKILL.md", { root: f.root }));
  } finally {
    f.cleanup();
  }
});

test("catalogue: symlinks that resolve outside the skill directory are rejected, inside links are not followed blindly", () => {
  const outside = mkdtempSync(join(tmpdir(), "skill-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  const f = fixture({ esc: { "SKILL.md": md("esc") }, ok: { "SKILL.md": md("ok"), "data.txt": "data" }, linkdir: { "SKILL.md": md("linkdir") } });
  try {
    symlinkSync(join(outside, "secret.txt"), join(f.base, "esc", "leak.txt"));
    symlinkSync(outside, join(f.base, "linkdir", "dir"));
    symlinkSync(join(outside, "secret.txt"), join(f.base, "ok", "link.txt"));
    const entries = listSkillExtensionEntries({ root: f.root });
    const names = entries.map((entry) => entry.frontmatter.name);
    assert.ok(names.includes("ok"));
    for (const entry of entries) {
      for (const resource of entry.resources) assert.equal(resource.uri.includes("leak") || resource.uri.endsWith("/link.txt") || resource.uri.includes("/dir/"), false, resource.uri);
    }
    assert.equal(readSkillBytes("skill://esc/leak.txt", { root: f.root }), undefined);
    assert.equal(readSkillBytes("skill://ok/link.txt", { root: f.root }), undefined);
    assert.equal(readSkillBytes("skill://linkdir/dir/secret.txt", { root: f.root }), undefined);
    assert.ok(getSkillDiagnostics({ root: f.root }).some((d) => /symlink/i.test(d.message)));
    // SKILL.md itself as an escaping symlink excludes the skill.
    const g = fixture({});
    try {
      mkdirSync(join(g.base, "evil"));
      writeFileSync(join(outside, "SKILL.md"), md("evil"));
      symlinkSync(join(outside, "SKILL.md"), join(g.base, "evil", "SKILL.md"));
      assert.deepEqual(listSkillExtensionEntries({ root: g.root }), []);
      assert.equal(readSkillBytes("skill://evil/SKILL.md", { root: g.root }), undefined);
    } finally {
      g.cleanup();
    }
  } finally {
    f.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("catalogue: per-skill file limit is enforced", () => {
  const files = { "SKILL.md": md("many") };
  for (let i = 0; i < 512; i += 1) files[`f/${i}.txt`] = "x";
  const f = fixture({ many: files, fine: { "SKILL.md": md("fine") } });
  try {
    const names = listSkillExtensionEntries({ root: f.root }).map((entry) => entry.frontmatter.name);
    assert.deepEqual(names, ["fine"]);
    assert.ok(getSkillDiagnostics({ root: f.root }).some((d) => d.skill === "many" && /512/.test(d.message)));
  } finally {
    f.cleanup();
  }
});

test("catalogue: published skill sizes stay inside Claude Code limits", () => {
  const base = join(REAL_ROOT, ".github", "skills");
  for (const entry of listSkillExtensionEntries()) {
    let total = 0;
    for (const resource of entry.resources) {
      assert.ok(resource.size < 100 * 1024, `${resource.uri} is ${resource.size} bytes`);
      total += resource.size;
    }
    assert.ok(total < 400 * 1024, `${entry.uri} totals ${total} bytes`);
  }
  for (const dir of readdirSync(base)) assert.ok(statSync(join(base, dir)).isDirectory());
});

test("catalogue: every real skill has a trigger description of at most 220 characters", () => {
  for (const entry of listSkillExtensionEntries()) {
    const description = entry.frontmatter.description;
    assert.ok(description.length <= 220, `${entry.frontmatter.name}: ${description.length}`);
    assert.match(description, /\bUse (when|for|to)\b/, entry.frontmatter.name);
  }
});

test("catalogue: legacy listing keeps its shape", () => {
  const skill = listSkillResources().find((entry) => entry.uri === "c64://skills/hello-world");
  assert.equal(skill.name, "Skill: hello-world");
  assert.equal(skill.mimeType, "text/markdown");
  assert.ok(skill.path.endsWith(join("hello-world", "SKILL.md")));
  assert.ok(skill.description.length > 0);
});

test("catalogue: tool and op names in the skills match the published interface", () => {
  execFileSync(process.execPath, [join(REAL_ROOT, "scripts", "check-skills.mjs")], { stdio: "pipe" });
});
