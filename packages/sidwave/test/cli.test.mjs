import test from "#test/runner";
import assert from "#test/assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, EXIT_OK, EXIT_FAILED, EXIT_USAGE } from "../src/cli.js";
import { confinedFileReader, compileSidwaveBytes, lintSidwave, listSidwaveExamples, readExampleScore, isExampleName } from "../src/sidwaveOps.js";
import { parseSidwave } from "../src/sidwave.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binJs = path.join(packageRoot, "dist", "bin.js");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-cli-")));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** In-process run; returns the exit code and what was written. */
function run(cwd, ...args) {
  const out = [], err = [], bytes = [];
  const code = runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: (b) => bytes.push(Buffer.from(b)) });
  return { code, out: out.join(""), err: err.join(""), bytes: Buffer.concat(bytes) };
}

const ELISE = readExampleScore("fuer_elise");

test("--help, --version and no arguments", () => {
  assert.equal(run(".", "--help").code, EXIT_OK);
  assert.match(run(".", "--help").out, /sidwave validate/);
  assert.match(run(".", "compile", "--help").out, /Exit codes/);
  assert.equal(run(".", "help").code, EXIT_OK);
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  assert.equal(run(".", "--version").out, `${version}\n`);
  assert.equal(run(".", "lint", "-V").out, `${version}\n`);
  const none = run(".");
  assert.equal(none.code, EXIT_USAGE);
  assert.match(none.err, /Usage:/);
});

test("usage errors exit 2", () => {
  const { dir, done } = sandbox();
  try {
    for (const args of [["frobnicate"], ["validate"], ["validate", "a", "b"], ["validate", "--bogus", "x"], ["compile", "x", "-o"], ["compile", "x", "--format", "wav"],
      ["validate", "x", "--json=1"], ["validate", "x", "-o", "y"], ["validate", "x", "--strict"], ["examples", "a", "b"], ["examples", "nope"], ["examples", "--force"],
      ["examples", "--allow-dir", "."], ["compile", "x", "--force"], ["lint", "x", "--format", "prg"], ["validate", "missing.yaml"]]) {
      const result = run(dir, ...args);
      assert.equal(result.code, EXIT_USAGE, args.join(" "));
      assert.match(result.err, /^sidwave: /);
    }
  } finally { done(); }
});

test("validate accepts a valid score and reports the error path of an invalid one", () => {
  const { dir, done } = sandbox();
  try {
    fs.writeFileSync(path.join(dir, "ok.yaml"), ELISE);
    const ok = run(dir, "validate", "ok.yaml");
    assert.equal(ok.code, EXIT_OK);
    assert.match(ok.out, /valid SIDWAVE 1\.0, 3 voices, 1 SID$/m);
    assert.deepEqual(JSON.parse(run(dir, "validate", "ok.yaml", "--json").out), { ok: true, file: "ok.yaml", version: "1.0", title: "Für Elise", mode: "PAL", voices: 3, sids: 1 });
    fs.writeFileSync(path.join(dir, "bad.yaml"), ELISE.replace("tempo:", "tempoo:"));
    const bad = run(dir, "validate", "bad.yaml");
    assert.equal(bad.code, EXIT_FAILED);
    assert.match(bad.err, /^bad\.yaml: Invalid SIDWAVE at \$/);
    const json = JSON.parse(run(dir, "validate", "bad.yaml", "--json").out);
    assert.equal(json.ok, false);
    assert.equal(json.error.path, "$.song.tempoo");
    fs.writeFileSync(path.join(dir, "junk.yaml"), "a: [");
    assert.equal(run(dir, "validate", "junk.yaml").code, EXIT_FAILED);
  } finally { done(); }
});

test("compile writes PRG and PSID, selects the format, never overwrites the input", () => {
  const { dir, done } = sandbox();
  try {
    fs.writeFileSync(path.join(dir, "song.sidwave.yaml"), ELISE);
    const prg = run(dir, "compile", "song.sidwave.yaml");
    assert.equal(prg.code, EXIT_OK);
    const written = fs.readFileSync(path.join(dir, "song.prg"));
    const expected = compileSidwaveBytes(parseSidwave(ELISE));
    assert.equal(sha(written), sha(expected.bytes));
    const sid = run(dir, "compile", "song.sidwave.yaml", "-o", "out/x.sid", "--json");
    assert.equal(sid.code, EXIT_OK);
    const summary = JSON.parse(sid.out);
    assert.equal(summary.format, "sid");
    assert.equal(summary.sidCount, 1);
    assert.equal(summary.initAddress, 0x0810);
    assert.equal(summary.playAddress, 0x0813);
    assert.equal(summary.outputBytes, fs.statSync(path.join(dir, "out/x.sid")).size);
    assert.equal(fs.readFileSync(path.join(dir, "out/x.sid")).subarray(0, 4).toString(), "PSID");
    assert.equal(run(dir, "compile", "song.sidwave.yaml", "--format", "sid", "-o", "y.bin").code, EXIT_OK);
    assert.equal(fs.readFileSync(path.join(dir, "y.bin")).subarray(0, 4).toString(), "PSID");
    const noLoop = JSON.parse(run(dir, "compile", "song.sidwave.yaml", "--no-loop", "-o", "n.prg", "--json").out);
    assert.equal(noLoop.loop, false);
    assert.ok(noLoop.prgBytes > summary.prgBytes);
    assert.equal(JSON.parse(run(dir, "compile", "song.sidwave.yaml", "--loop", "-o", "l.prg", "--json").out).prgBytes, summary.prgBytes);
    const refused = run(dir, "compile", "song.sidwave.yaml", "-o", "song.sidwave.yaml");
    assert.equal(refused.code, EXIT_USAGE);
    assert.equal(fs.readFileSync(path.join(dir, "song.sidwave.yaml"), "utf8"), ELISE);
    fs.symlinkSync("song.sidwave.yaml", path.join(dir, "link.prg"));
    assert.equal(run(dir, "compile", "song.sidwave.yaml", "-o", "link.prg").code, EXIT_USAGE);
    fs.writeFileSync(path.join(dir, "blocker"), "");
    assert.equal(run(dir, "compile", "song.sidwave.yaml", "-o", "blocker/x.prg").code, EXIT_USAGE);
  } finally { done(); }
});

test("compile to standard output keeps the bytes and the summary apart; invalid input writes nothing", () => {
  const { dir, done } = sandbox();
  try {
    fs.writeFileSync(path.join(dir, "a.yaml"), ELISE);
    const result = run(dir, "compile", "a.yaml", "-o", "-");
    assert.equal(result.code, EXIT_OK);
    assert.equal(sha(result.bytes), sha(compileSidwaveBytes(parseSidwave(ELISE)).bytes));
    assert.equal(result.out, "");
    assert.match(result.err, /standard output: PRG/);
    assert.equal(JSON.parse(run(dir, "compile", "a.yaml", "-o", "-", "--json").err).output, null);
    fs.writeFileSync(path.join(dir, "bad.yaml"), "voices: 3\n");
    const bad = run(dir, "compile", "bad.yaml");
    assert.equal(bad.code, EXIT_FAILED);
    assert.equal(fs.existsSync(path.join(dir, "bad.prg")), false);
    assert.equal(JSON.parse(run(dir, "compile", "bad.yaml", "--json").out).ok, false);
  } finally { done(); }
});

test("lint reports findings and --strict turns them into exit 1", () => {
  const { dir, done } = sandbox();
  try {
    fs.writeFileSync(path.join(dir, "clean.yaml"), ELISE);
    assert.match(run(dir, "lint", "clean.yaml").out, /no lint findings/);
    const withFindings = listSidwaveExamples().map(({ name }) => name).find((name) => lintSidwave(parseSidwave(readExampleScore(name))).actionable > 0);
    assert.ok(withFindings, "an example with lint findings");
    fs.writeFileSync(path.join(dir, "f.yaml"), readExampleScore(withFindings));
    const plain = run(dir, "lint", "f.yaml");
    assert.equal(plain.code, EXIT_OK);
    assert.match(plain.out, /^f\.yaml: [A-Z-]+: /m);
    assert.equal(run(dir, "lint", "f.yaml", "--strict").code, EXIT_FAILED);
    const json = JSON.parse(run(dir, "lint", "f.yaml", "--strict", "--json", "--no-loop").out);
    assert.equal(json.ok, false);
    assert.ok(json.findings.length > 0);
    fs.writeFileSync(path.join(dir, "bad.yaml"), "x: 1\n");
    assert.equal(run(dir, "lint", "bad.yaml").code, EXIT_FAILED);
  } finally { done(); }
});

test("examples lists, prints and writes the bundled scores", () => {
  const { dir, done } = sandbox();
  try {
    const list = run(dir, "examples");
    assert.equal(list.code, EXIT_OK);
    assert.equal(list.out.trim().split("\n").length, 14);
    const json = JSON.parse(run(dir, "examples", "--json").out);
    assert.equal(json.length, 14);
    assert.ok(isExampleName("acid_line") && !isExampleName("../x"));
    assert.equal(run(dir, "examples", "acid_line").out, readExampleScore("acid_line"));
    const wrote = run(dir, "examples", "acid_line", "-o", "ex");
    assert.equal(wrote.code, EXIT_OK);
    assert.equal(fs.readFileSync(path.join(dir, "ex/acid_line.yaml"), "utf8"), readExampleScore("acid_line"));
    assert.equal(run(dir, "examples", "acid_line", "-o", "ex").code, EXIT_USAGE);
    assert.equal(run(dir, "examples", "acid_line", "-o", "ex", "--force", "--json").code, EXIT_OK);
    fs.writeFileSync(path.join(dir, "file"), "");
    assert.equal(run(dir, "examples", "acid_line", "-o", "file").code, EXIT_USAGE);
    assert.throws(() => readExampleScore("nope"), /unknown example/);
    assert.equal(run(dir, "validate", path.join(dir, "ex/acid_line.yaml")).code, EXIT_OK);
  } finally { done(); }
});

test("file: sample sources are confined to the working directory unless --allow-dir is given", () => {
  const { dir, done } = sandbox();
  try {
    const score = readExampleScore("digi_groove").replace(/^ {4}kick: .*$/m, "    kick: { file: sub/kick.u8, file_rate: 4000 }");
    assert.notEqual(score, readExampleScore("digi_groove"));
    const work = path.join(dir, "work");
    fs.mkdirSync(path.join(work, "sub"), { recursive: true });
    fs.writeFileSync(path.join(work, "d.yaml"), score);
    assert.match(run(work, "validate", "d.yaml").err, /ENOENT/);
    fs.writeFileSync(path.join(work, "sub/kick.u8"), Buffer.alloc(200, 128));
    assert.equal(run(work, "validate", "d.yaml").code, EXIT_OK);
    assert.equal(run(work, "compile", "d.yaml").code, EXIT_OK);
    // A link inside the working directory that points outside is refused.
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "kick.u8"), Buffer.alloc(200, 128));
    fs.rmSync(path.join(work, "sub/kick.u8"));
    fs.symlinkSync(path.join(outside, "kick.u8"), path.join(work, "sub/kick.u8"));
    const refused = run(work, "validate", "d.yaml");
    assert.equal(refused.code, EXIT_FAILED);
    assert.match(refused.err, /outside the allowed directories/);
    assert.equal(run(work, "validate", "d.yaml", "--allow-dir", outside).code, EXIT_OK);
    assert.equal(run(work, "lint", "d.yaml", `--allow-dir=${outside}`).code, EXIT_OK);
    assert.throws(() => confinedFileReader(work)("../outside/kick.u8"), /outside the allowed/);
  } finally { done(); }
});

function spawnCli(runtime, cwd, ...args) {
  const result = spawnSync(runtime, [binJs, ...args], { cwd, encoding: "buffer" });
  return { code: result.status, out: result.stdout, err: result.stderr.toString() };
}

const hasBun = spawnSync("bun", ["--version"]).status === 0;
const runtimes = [["node", "node"], ...(hasBun ? [["bun", "bun"]] : [])];

for (const [label, runtime] of runtimes) {
  test(`the built CLI runs under ${label}: all commands, exit codes and identical bytes`, () => {
    assert.ok(fs.existsSync(binJs), "dist/bin.js is missing; run npm run build in packages/sidwave");
    const { dir, done } = sandbox();
    try {
      fs.writeFileSync(path.join(dir, "s.yaml"), ELISE);
      assert.match(spawnCli(runtime, dir, "--version").out.toString(), /^\d+\.\d+\.\d+\n$/);
      assert.equal(spawnCli(runtime, dir, "--help").code, 0);
      assert.equal(spawnCli(runtime, dir, "validate", "s.yaml").code, 0);
      assert.equal(spawnCli(runtime, dir, "lint", "s.yaml").code, 0);
      assert.equal(spawnCli(runtime, dir, "examples").code, 0);
      assert.equal(spawnCli(runtime, dir, "examples", "fuer_elise", "-o", "e").code, 0);
      assert.equal(spawnCli(runtime, dir, "examples", "fuer_elise", "-o", "e").code, 2);
      const compiled = spawnCli(runtime, dir, "compile", "s.yaml", "--format", "sid", "--json");
      assert.equal(compiled.code, 0);
      assert.equal(JSON.parse(compiled.out.toString()).format, "sid");
      assert.equal(sha(fs.readFileSync(path.join(dir, "s.sid"))), sha(compileSidwaveBytes(parseSidwave(ELISE), { format: "sid" }).bytes));
      const stdout = spawnCli(runtime, dir, "compile", "s.yaml", "-o", "-");
      assert.equal(sha(stdout.out), sha(compileSidwaveBytes(parseSidwave(ELISE)).bytes));
      fs.writeFileSync(path.join(dir, "bad.yaml"), "nonsense: true\n");
      const bad = spawnCli(runtime, dir, "validate", "bad.yaml");
      assert.equal(bad.code, 1);
      assert.match(bad.err, /Invalid SIDWAVE at \$/);
      assert.equal(spawnCli(runtime, dir, "validate", "missing.yaml").code, 2);
      assert.equal(spawnCli(runtime, dir, "nonsense").code, 2);
      assert.equal(spawnCli(runtime, dir).code, 2);
      assert.equal(spawnCli(runtime, dir, "compile", "s.yaml", "-o", "s.yaml").code, 2);
    } finally { done(); }
  });
}
