#!/usr/bin/env node
/**
 * Line coverage of each workspace package, measured with Bun over the package's own tests and
 * limited to the package's src/. Blank and comment-only lines that Bun reports inside executed
 * functions are dropped, as in scripts/run-coverage.mjs. Each package has a .c8rc.json whose
 * `lines` value is the minimum percentage.
 *
 *   node scripts/run-package-coverage.mjs [package-dir ...]   default: every package directory next to scripts/
 *
 * This file lives in packages/scripts. packages/ is the root of the standalone sidwave repository, so the
 * script only refers to its own parent directory and works in c64bridge and in the standalone repository.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARD_SIZE = Number(process.env.C64BRIDGE_COVERAGE_SHARD_SIZE) || 12;

export function parseLcov(text, packageDir) {
  const files = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const abs = path.resolve(packageDir, line.slice(3).trim());
      const rel = path.relative(packageDir, abs).split(path.sep).join("/");
      current = rel.startsWith("src/") && rel.endsWith(".ts") ? (files.get(rel) ?? files.set(rel, new Map()).get(rel)) : null;
    } else if (current && line.startsWith("DA:")) {
      const [no, hits] = line.slice(3).split(",").map(Number);
      current.set(no, Math.max(current.get(no) ?? 0, hits));
    }
  }
  return files;
}

export function codeLinesOnly(files, packageDir) {
  const result = new Map();
  for (const [rel, lines] of files) {
    const source = fs.readFileSync(path.join(packageDir, rel), "utf8").split(/\r?\n/);
    const kept = new Map();
    for (const [no, hits] of lines) {
      const text = (source[no - 1] ?? "").trim();
      if (text === "" || text.startsWith("//") || text.startsWith("/*") || text.startsWith("*")) continue;
      kept.set(no, hits);
    }
    result.set(rel, kept);
  }
  return result;
}

export function summarise(files) {
  let covered = 0, total = 0;
  const perFile = {};
  for (const [rel, lines] of files) {
    let c = 0;
    for (const hits of lines.values()) if (hits > 0) c++;
    perFile[rel] = lines.size ? Math.round((c * 10000) / lines.size) / 100 : 100;
    covered += c; total += lines.size;
  }
  return { covered, total, pct: total ? Math.round((covered * 10000) / total) / 100 : 0, perFile };
}

function listTests(packageDir) {
  const dir = path.join(packageDir, "test");
  return fs.readdirSync(dir).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => `test/${name}`);
}

export function coverPackage(packageDir) {
  const config = JSON.parse(fs.readFileSync(path.join(packageDir, ".c8rc.json"), "utf8"));
  const minimum = Number(config.lines);
  const outDir = path.join(packageDir, "coverage");
  fs.rmSync(outDir, { recursive: true, force: true });
  const bun = process.env.C64BRIDGE_BUN_BIN || "bun";
  const tests = listTests(packageDir);
  const merged = new Map();
  for (let i = 0; i < tests.length; i += SHARD_SIZE) {
    const shard = path.join(outDir, `shard-${i / SHARD_SIZE}`);
    const run = spawnSync(bun, ["test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${shard}`, ...tests.slice(i, i + SHARD_SIZE)], { cwd: packageDir, stdio: "inherit", env: process.env });
    if (run.status !== 0) throw new Error(`bun test failed in ${packageDir} (exit ${run.status})`);
    const files = parseLcov(fs.readFileSync(path.join(shard, "lcov.info"), "utf8"), packageDir);
    for (const [rel, lines] of files) {
      const target = merged.get(rel) ?? merged.set(rel, new Map()).get(rel);
      for (const [no, hits] of lines) target.set(no, Math.max(target.get(no) ?? 0, hits));
    }
  }
  const summary = summarise(codeLinesOnly(merged, packageDir));
  return { name: path.basename(packageDir), minimum, ...summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2).length
    ? process.argv.slice(2).map((dir) => path.resolve(dir))
    : fs.readdirSync(packagesRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(packagesRoot, e.name, ".c8rc.json"))).map((e) => path.join(packagesRoot, e.name));
  let failed = false;
  for (const dir of dirs) {
    const result = coverPackage(dir);
    console.log(JSON.stringify({ package: result.name, lines: { covered: result.covered, total: result.total, pct: result.pct }, minimum: result.minimum, below90: Object.entries(result.perFile).filter(([, pct]) => pct < result.minimum) }, null, 2));
    if (!(result.pct >= result.minimum)) { console.error(`Line coverage ${result.pct}% of ${result.name} is below the required ${result.minimum}%`); failed = true; }
  }
  process.exitCode = failed ? 1 : 0;
}
