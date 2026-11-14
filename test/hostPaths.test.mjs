import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowedHostRoots, defaultHostOutputDir, isWithin, resolveHostChildPath, resolveHostPath } from "../src/hostPaths.js";
import { ToolValidationError } from "../src/tools/errors.js";

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
  const restore = () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function makeFixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-hostpaths-")));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "small.bin"), Buffer.alloc(10));
  fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(100));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(outside, path.join(root, "link-dir"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-file"));
  fs.symlinkSync(path.join(outside, "does-not-exist"), path.join(root, "dangling"));
  return { base, root, outside };
}

test("resolveHostPath table: containment with an explicit root", () => {
  const { base, root, outside } = makeFixture();
  try {
    const cases = [
      { name: "file inside the root", input: path.join(root, "small.bin"), purpose: "read", ok: true },
      { name: "root itself", input: root, purpose: "write", ok: true },
      { name: "nonexistent nested write target inside the root", input: path.join(root, "a", "b", "c.bin"), purpose: "write", ok: true },
      { name: "traversal out of the root", input: path.join(root, "..", "outside", "x.bin"), purpose: "write", ok: false },
      { name: "traversal that stays inside", input: path.join(root, "a", "..", "small.bin"), purpose: "read", ok: true },
      { name: "absolute path outside", input: path.join(outside, "x.bin"), purpose: "write", ok: false },
      { name: "symlinked directory escape (existing target)", input: path.join(root, "link-dir", "secret.txt"), purpose: "read", ok: false },
      { name: "symlinked directory escape (new file)", input: path.join(root, "link-dir", "new.bin"), purpose: "write", ok: false },
      { name: "symlinked file escape", input: path.join(root, "link-file"), purpose: "read", ok: false },
      { name: "dangling symlink", input: path.join(root, "dangling"), purpose: "write", ok: false },
      { name: "sibling directory sharing a name prefix", input: `${root}-evil/x`, purpose: "write", ok: false },
      { name: "NUL byte", input: path.join(root, "a\0b"), purpose: "write", ok: false },
    ];
    for (const c of cases) {
      const run = () => resolveHostPath(c.input, { purpose: c.purpose, roots: [root] });
      if (c.ok) {
        const result = run();
        assert.ok(isWithin(root, result), `${c.name}: ${result}`);
      } else {
        assert.throws(run, (error) => error instanceof ToolValidationError, c.name);
      }
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("resolveHostPath rejection names the path, the roots and C64BRIDGE_ALLOWED_DIRS", () => {
  const { base, root, outside } = makeFixture();
  try {
    assert.throws(
      () => resolveHostPath(path.join(outside, "x.bin"), { purpose: "write", roots: [root] }),
      (error) => error instanceof ToolValidationError
        && error.message.includes(path.join(outside, "x.bin"))
        && error.message.includes(root)
        && error.message.includes("C64BRIDGE_ALLOWED_DIRS"),
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("resolveHostPath enforces the read size cap before reading", () => {
  const { base, root } = makeFixture();
  try {
    assert.ok(resolveHostPath(path.join(root, "small.bin"), { purpose: "read", maxBytes: 50, roots: [root] }));
    assert.throws(
      () => resolveHostPath(path.join(root, "big.bin"), { purpose: "read", maxBytes: 50, roots: [root] }),
      (error) => error instanceof ToolValidationError && /too large/.test(error.message),
    );
    // The size cap applies to reads only.
    assert.ok(resolveHostPath(path.join(root, "big.bin"), { purpose: "write", maxBytes: 50, roots: [root] }));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("default roots: cwd, ~/.c64bridge and the temp directory", () => {
  const { base, root } = makeFixture();
  const fakeHome = path.join(base, "home");
  fs.mkdirSync(fakeHome);
  const originalCwd = process.cwd();
  try {
    withEnv({ HOME: fakeHome, TMPDIR: path.join(base, "tmp"), C64BRIDGE_ALLOWED_DIRS: undefined }, () => {
      process.chdir(root);
      const roots = allowedHostRoots();
      assert.ok(roots.includes(root));
      assert.ok(roots.includes(path.join(fakeHome, ".c64bridge")));
      assert.ok(roots.includes(path.join(base, "tmp")));
      assert.ok(resolveHostPath(path.join(fakeHome, ".c64bridge", "tasks", "x.json"), { purpose: "write" }));
      assert.throws(() => resolveHostPath(path.join(fakeHome, ".bashrc"), { purpose: "write" }), ToolValidationError);
    });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a working directory equal to the home directory is not an allowed root", () => {
  const { base, root } = makeFixture();
  const originalCwd = process.cwd();
  try {
    withEnv({ HOME: root, TMPDIR: path.join(base, "tmp"), C64BRIDGE_ALLOWED_DIRS: undefined }, () => {
      process.chdir(root);
      assert.ok(!allowedHostRoots().includes(root));
      assert.throws(() => resolveHostPath(path.join(root, ".bashrc"), { purpose: "write" }), ToolValidationError);
    });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a working directory of / is not an allowed root", () => {
  const originalCwd = process.cwd();
  try {
    withEnv({ C64BRIDGE_ALLOWED_DIRS: undefined }, () => {
      process.chdir("/");
      assert.ok(!allowedHostRoots().includes("/"));
      assert.throws(() => resolveHostPath("/etc/c64bridge-test-should-not-exist", { purpose: "write" }), ToolValidationError);
    });
  } finally {
    process.chdir(originalCwd);
  }
});

test("C64BRIDGE_ALLOWED_DIRS adds roots separated by the path delimiter", () => {
  const { base, root, outside } = makeFixture();
  try {
    const target = path.join(outside, "x.bin");
    // The temp directory is a default root, so move it away from the fixture.
    withEnv({ C64BRIDGE_ALLOWED_DIRS: undefined, TMPDIR: path.join(base, "tmpx") }, () => {
      assert.throws(() => resolveHostPath(target, { purpose: "write" }), ToolValidationError);
    });
    withEnv({ TMPDIR: path.join(base, "tmpx"), C64BRIDGE_ALLOWED_DIRS: `${path.join(base, "nothing")}${path.delimiter}${outside}` }, () => {
      assert.equal(resolveHostPath(target, { purpose: "write" }), target);
      assert.throws(() => resolveHostPath(path.join(root, "..", "x.bin"), { purpose: "write" }), ToolValidationError);
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("C64BRIDGE_ALLOWED_DIRS=* disables confinement", () => {
  const { base, outside } = makeFixture();
  try {
    withEnv({ TMPDIR: path.join(base, "tmpx"), C64BRIDGE_ALLOWED_DIRS: "*" }, () => {
      assert.equal(resolveHostPath(path.join(outside, "x.bin"), { purpose: "write" }), path.join(outside, "x.bin"));
      assert.ok(resolveHostPath("/etc/c64bridge-test-should-not-exist", { purpose: "write" }));
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("resolveHostChildPath rejects a symbolic link planted at the appended name", () => {
  const { base, root, outside } = makeFixture();
  try {
    withEnv({ TMPDIR: path.join(base, "tmp"), C64BRIDGE_ALLOWED_DIRS: root }, () => {
      assert.throws(() => resolveHostChildPath(root, "link-file"), ToolValidationError);
      assert.throws(() => resolveHostChildPath(root, "link-dir", "manifest.json"), ToolValidationError);
      assert.throws(() => resolveHostChildPath(root, "dangling"), ToolValidationError);
      assert.equal(resolveHostChildPath(root, "manifest.json"), path.join(root, "manifest.json"));
      assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("defaultHostOutputDir falls back to ~/.c64bridge when the working directory is not a root", () => {
  const { base, root } = makeFixture();
  const originalCwd = process.cwd();
  try {
    withEnv({ HOME: root, TMPDIR: path.join(base, "tmp"), C64BRIDGE_ALLOWED_DIRS: undefined }, () => {
      process.chdir(root);
      assert.equal(defaultHostOutputDir("artifacts", "run_1"), path.join(root, ".c64bridge", "artifacts", "run_1"));
    });
    process.chdir(base);
    withEnv({ C64BRIDGE_ALLOWED_DIRS: undefined }, () => {
      assert.equal(defaultHostOutputDir("artifacts", "run_1"), path.join(base, "artifacts", "run_1"));
    });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("host reads accept only regular files and read through the opened handle", async () => {
  if (process.platform === "win32") return;
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostpaths-fifo-"));
  try {
    const fifo = path.join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    // A FIFO reports size 0, so only a file-type check rejects it before a read would block.
    assert.throws(() => resolveHostPath(fifo, { purpose: "read" }), /not a regular file/);
    assert.throws(() => resolveHostPath(dir, { purpose: "read" }), /not a regular file/);

    const { readHostFile } = await import("../src/hostPaths.js");
    await assert.rejects(() => readHostFile(fifo), /not a regular file/);

    const file = path.join(dir, "data.bin");
    fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(Array.from(await readHostFile(file)), [1, 2, 3, 4]);
    await assert.rejects(() => readHostFile(file, { maxBytes: 3 }), /too large/);
    // Symlinks to regular files inside the allowed roots still resolve to the real file.
    const link = path.join(dir, "link.bin");
    fs.symlinkSync(file, link);
    assert.deepEqual(Array.from(await readHostFile(link)), [1, 2, 3, 4]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHostPath expands a leading ~ to the home directory", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-home-")));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-cwd-")));
  const savedCwd = process.cwd();
  try {
    fs.mkdirSync(path.join(home, ".c64bridge"));
    fs.writeFileSync(path.join(home, ".c64bridge", "x.json"), "{}");
    process.chdir(cwd);
    withEnv({ HOME: home, C64BRIDGE_ALLOWED_DIRS: undefined }, () => {
      const write = resolveHostPath("~/.c64bridge/x.json", { purpose: "write" });
      assert.equal(write, path.join(home, ".c64bridge", "x.json"));
      assert.ok(isWithin(home, write));
      const read = resolveHostPath("~/.c64bridge/x.json", { purpose: "read" });
      assert.equal(read, path.join(home, ".c64bridge", "x.json"));
      assert.ok(!fs.existsSync(path.join(cwd, "~")));
      assert.equal(resolveHostPath("~", { purpose: "write", roots: [home] }), home);
      let error;
      try { resolveHostPath("~other/x", { purpose: "write", roots: [home] }); } catch (e) { error = e; }
      assert.ok(error instanceof ToolValidationError);
      assert.ok(error.message.includes(path.join(cwd, "~other", "x")), error.message);
    });
  } finally {
    process.chdir(savedCwd);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
