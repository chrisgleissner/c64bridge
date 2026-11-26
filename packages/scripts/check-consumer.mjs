#!/usr/bin/env node
/**
 * Clean-consumer check. Packs c64-asm6502 and sidwave, installs the two tarballs in an empty project with npm,
 * then parses and compiles an example score to PRG and PSID with an ESM program on Node and on Bun, and with the
 * installed `sidwave` command. The byte hashes must agree between runtimes and, with --baseline, equal the
 * values recorded for that example in the S0 baseline file.
 *
 *   node scripts/check-consumer.mjs [--baseline <sidwave-baseline.json>] [--example <name>] [--out <result.json>]
 *
 * This file lives in packages/scripts and refers only to its parent directory, so it runs in c64bridge and in the
 * standalone repository. Run the build first (npm run build); the script does not build.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const example = option("--example") ?? "fuer_elise";
const baselinePath = option("--baseline");
const outPath = option("--out");

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (exit ${r.status}):\n${(r.stderr || r.stdout || "").slice(-2000)}`);
  return r.stdout;
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-consumer-"));
const result = { example, runtimes: {}, checks: [] };
try {
  const tarballs = [];
  for (const dir of ["asm6502", "sidwave"]) {
    const pkgDir = path.join(packagesRoot, dir);
    if (!fs.existsSync(path.join(pkgDir, "dist"))) throw new Error(`${dir}/dist is missing; run the build first`);
    const [info] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], { cwd: pkgDir }));
    tarballs.push(path.join(work, info.filename));
    result.checks.push({ pack: info.name, files: info.files.length, bytes: info.size });
  }
  const consumer = path.join(work, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock", ...tarballs], { cwd: consumer });

  for (const name of ["sidwave", "c64-asm6502"]) {
    const dir = path.join(consumer, "node_modules", name);
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`${name} is a symbolic link in the consumer project`);
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (/\.(js|json|md|ts|yaml)$/.test(e.name) && /\/home\/|\/Users\/|[A-Z]:\\Users/.test(fs.readFileSync(p, "utf8"))) throw new Error(`absolute home path in ${path.relative(consumer, p)}`);
      }
    }
  }
  result.checks.push({ installed: "no symbolic links, no absolute home paths" });

  const scoreFile = path.join(consumer, "node_modules", "sidwave", "data", "sound", "examples", `${example}.yaml`);
  fs.writeFileSync(path.join(consumer, "compile.mjs"), `
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseSidwave, compileSidwaveToPrg, compileSidwaveToSid } from "sidwave";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const doc = parseSidwave(readFileSync(process.argv[2], "utf8"));
const out = {};
for (const loop of [true, false]) {
  const r = compileSidwaveToPrg(doc, { loop });
  out["loop_" + loop] = { prg_sha256: sha(r.prg), prg_length: r.prg.length, psid_sha256: sha(compileSidwaveToSid(doc, r.prg).sid) };
}
console.log(JSON.stringify(out));
`);
  for (const runtime of ["node", "bun"]) {
    const hashes = JSON.parse(run(runtime, ["compile.mjs", scoreFile], { cwd: consumer }));
    const version = run(runtime, ["--version"]).trim();
    const bin = path.join(consumer, "node_modules", "sidwave", "dist", "bin.js");
    const cliDir = path.join(consumer, `cli-${runtime}`);
    fs.mkdirSync(cliDir);
    const summary = JSON.parse(run(runtime, [bin, "compile", scoreFile, "--json"], { cwd: cliDir }));
    const sid = JSON.parse(run(runtime, [bin, "compile", scoreFile, "--format", "sid", "--json"], { cwd: cliDir }));
    const cliPrg = sha(fs.readFileSync(path.join(cliDir, `${example}.prg`)));
    const cliSid = sha(fs.readFileSync(path.join(cliDir, `${example}.sid`)));
    if (cliPrg !== hashes.loop_true.prg_sha256 || cliSid !== hashes.loop_true.psid_sha256) throw new Error(`${runtime}: the sidwave command and the library disagree`);
    result.runtimes[runtime] = { version, ...hashes, cli: { prg_sha256: cliPrg, psid_sha256: cliSid, prgBytes: summary.outputBytes, sidBytes: sid.outputBytes } };
  }
  const { node, bun } = result.runtimes;
  for (const key of ["loop_true", "loop_false"]) {
    if (JSON.stringify(node[key]) !== JSON.stringify(bun[key])) throw new Error(`Node and Bun differ for ${key}`);
  }
  result.checks.push({ nodeEqualsBun: true });
  if (baselinePath) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")).scores[`data/sound/examples/${example}.yaml`]?.prg;
    if (!baseline) throw new Error(`no baseline for ${example}`);
    for (const key of ["loop_true", "loop_false"]) {
      const want = { prg_sha256: baseline[key].prg_sha256, psid_sha256: baseline[key].psid_sha256 };
      const have = { prg_sha256: node[key].prg_sha256, psid_sha256: node[key].psid_sha256 };
      if (JSON.stringify(want) !== JSON.stringify(have)) throw new Error(`baseline mismatch for ${key}: want ${JSON.stringify(want)}, have ${JSON.stringify(have)}`);
    }
    result.checks.push({ baseline: path.basename(baselinePath), equal: true });
  }
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
if (outPath) fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
