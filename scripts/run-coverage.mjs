#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const coverageDir = path.join(repoRoot, "coverage");
const runner = path.join(repoRoot, "scripts", "invoke-bun.mjs");
const configPath = path.join(repoRoot, ".c8rc.json");
const testRoot = path.join(repoRoot, "test");
const DEFAULT_COVERAGE_SHARD_SIZE = 12;
const DEFAULT_VICE_MOCK_TEST_FILES = [
  "test/device.test.mjs",
  "test/viceIntegration.test.mjs",
  "test/viceModule.test.mjs",
  "test/groupedToolsShims.test.mjs",
  "test/toolsTypes.test.mjs",
  "test/platformRegistry.test.mjs",
  "test/meta/program.test.mjs",
  "test/mcpServerIntegration.test.mjs",
  "test/c64Client.test.mjs",
  "test/vice/viceSmokeTest.ts",
];
const DEFAULT_VICE_DEVICE_TEST_FILES = [
  "test/device.test.mjs",
  "test/vice/viceSmokeTest.ts",
];

const legs = [
  { name: "c64u-mock", args: ["--platform=c64u", "--target=mock"] },
  { name: "vice-mock", args: ["--platform=vice", "--target=mock"] },
  { name: "vice-device", args: ["--platform=vice", "--target=device"] },
];

const supplementalTests = [
  "test/toolsCoverage.test.mjs",
  "test/audioModule.test.mjs",
  "test/updateReadme.test.mjs",
  "test/viceIntegration.test.mjs",
];

// Tests that use mock.module() must run in isolation to prevent the module
// mock from leaking into concurrently-executing test files.
const isolatedTests = [
  "test/audioRuntime.test.mjs",
];

const coverageConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
const includeMatchers = (coverageConfig.include ?? []).map(globToRegExp);
const excludeMatchers = (coverageConfig.exclude ?? []).map(globToRegExp);

if (import.meta.main) {
  await main();
}

export async function main() {
  await fs.mkdir(coverageDir, { recursive: true });
  await fs.rm(path.join(coverageDir, "matrix"), { recursive: true, force: true });
  await fs.mkdir(path.join(coverageDir, "matrix"), { recursive: true });

  const legOutputs = [];
  const allTestFiles = await listRepoTestFiles(testRoot);
  const isolatedTestSet = new Set(isolatedTests);
  const defaultTestFiles = allTestFiles.filter((f) => !isolatedTestSet.has(f));
  for (const leg of legs) {
    const legDir = path.join(coverageDir, "matrix", leg.name);
    await fs.mkdir(legDir, { recursive: true });

    const legDefaultFiles = leg.name === "vice-mock"
      ? DEFAULT_VICE_MOCK_TEST_FILES
      : leg.name === "vice-device"
        ? DEFAULT_VICE_DEVICE_TEST_FILES
        : defaultTestFiles;
    const legSupplementalTests = leg.name.startsWith("vice")
      ? []
      : [...supplementalTests, ...isolatedTests];
    const coverageBatches = buildCoverageBatches(legDefaultFiles, legSupplementalTests, process.env);

    const reports = [];
    for (const batch of coverageBatches) {
      reports.push(await runCoverageLeg(leg, legDir, batch.label, batch.files));
    }

    const mergedLeg = mergeReports(await Promise.all(reports.map(readReport)));
    const legPath = path.join(coverageDir, `${leg.name}.lcov.info`);
    await fs.writeFile(legPath, serializeReport(mergedLeg), "utf8");
    legOutputs.push(legPath);
  }

  const finalReport = mergeReports(await Promise.all(legOutputs.map(readReport)));
  const finalPath = path.join(coverageDir, "lcov.info");
  await fs.writeFile(finalPath, serializeReport(finalReport), "utf8");

  const summary = summariseReport(finalReport);
  console.log(JSON.stringify({ lines: summary }, null, 2));
}

export function buildCoverageBatches(testFiles, extraTests, env = process.env) {
  const shardSize = resolveCoverageShardSize(env.C64BRIDGE_COVERAGE_SHARD_SIZE);
  const batches = chunkFiles(testFiles, shardSize).map((files, index, all) => ({
    label: all.length === 1 ? "all" : `all-${String(index + 1).padStart(2, "0")}`,
    files,
  }));

  for (const testFile of extraTests) {
    batches.push({
      label: path.basename(testFile, path.extname(testFile)),
      files: [testFile],
    });
  }

  return batches;
}

export function resolveCoverageShardSize(raw) {
  const parsed = Number(raw ?? "");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_COVERAGE_SHARD_SIZE;
}

export function chunkFiles(files, chunkSize) {
  if (files.length === 0) {
    return [[]];
  }

  const chunks = [];
  for (let index = 0; index < files.length; index += chunkSize) {
    chunks.push(files.slice(index, index + chunkSize));
  }
  return chunks;
}

async function listRepoTestFiles(root) {
  const files = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && /\.test\.(mjs|ts)$/i.test(entry.name)) {
        files.push(path.relative(repoRoot, fullPath));
      }
    }
  }

  await walk(root);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function runCoverageLeg(leg, legDir, label, files) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(legDir, `${label}.lcov.info`);
    const args = [runner, "scripts/run-tests.ts", "--coverage", ...leg.args, ...files];
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", async (code) => {
      if (code !== 0) {
        reject(new Error(`Coverage run failed for ${leg.name}/${label} with exit code ${code ?? 1}`));
        return;
      }
      try {
        await fs.copyFile(path.join(coverageDir, "lcov.info"), outputPath);
        resolve(outputPath);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function readReport(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return parseReport(text);
}

function parseReport(text) {
  const report = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("SF:")) {
      const filePath = line.slice(3).trim();
      const relative = toRelativeSourcePath(filePath);
      current = relative ? getOrCreate(report, relative) : null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("DA:")) {
      const [lineNoRaw, hitsRaw] = line.slice(3).split(",", 2);
      const lineNo = Number(lineNoRaw);
      const hits = Number(hitsRaw);
      current.lines.set(lineNo, Math.max(current.lines.get(lineNo) ?? 0, Number.isFinite(hits) ? hits : 0));
    }
  }
  return report;
}

function mergeReports(reports) {
  const merged = new Map();
  for (const report of reports) {
    for (const [filePath, record] of report.entries()) {
      const target = getOrCreate(merged, filePath);
      for (const [lineNo, hits] of record.lines.entries()) {
        target.lines.set(lineNo, Math.max(target.lines.get(lineNo) ?? 0, hits));
      }
    }
  }
  return merged;
}

function serializeReport(report) {
  const lines = [];
  for (const [filePath, record] of [...report.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let lf = 0;
    let lh = 0;
    lines.push("TN:");
    lines.push(`SF:${filePath}`);
    for (const [lineNo, hits] of [...record.lines.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`DA:${lineNo},${hits}`);
      lf += 1;
      if (hits > 0) lh += 1;
    }
    lines.push(`LF:${lf}`);
    lines.push(`LH:${lh}`);
    lines.push("end_of_record");
  }
  return `${lines.join("\n")}\n`;
}

function summariseReport(report) {
  let covered = 0;
  let total = 0;
  for (const record of report.values()) {
    for (const hits of record.lines.values()) {
      total += 1;
      if (hits > 0) covered += 1;
    }
  }
  return {
    covered,
    total,
    pct: total === 0 ? "0.00" : ((covered * 100) / total).toFixed(2),
  };
}

function getOrCreate(report, filePath) {
  let record = report.get(filePath);
  if (!record) {
    record = { lines: new Map() };
    report.set(filePath, record);
  }
  return record;
}

function toRelativeSourcePath(filePath) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
  if (relative.startsWith("..")) {
    return null;
  }
  if (!includeMatchers.some((matcher) => matcher.test(relative))) {
    return null;
  }
  if (excludeMatchers.some((matcher) => matcher.test(relative))) {
    return null;
  }
  return relative;
}

function globToRegExp(glob) {
  const normalized = glob.split(path.sep).join("/");
  let regex = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += ".";
      continue;
    }
    if ("\\.^$+{}()|[]".includes(char)) {
      regex += `\\${char}`;
      continue;
    }
    regex += char;
  }
  regex += "$";
  return new RegExp(regex);
}