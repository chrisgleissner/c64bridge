#!/usr/bin/env node
/**
 * Package budget check for an extracted npm package (PACKAGE-4).
 *
 * Usage: node scripts/check-package-budget.mjs <package-dir> <tarball>
 *
 * Fails when the published package grows past its budget, ships files that are
 * not needed at run time, answers `initialize` slowly or publishes a larger
 * `tools/list` than the budget allows. Budgets leave headroom over the values
 * measured on 2026-11-19 (tarball about 1.3 MB after PACKAGE-9, unpacked about
 * 6 MB, `initialize` about 0.6 s on a developer machine, `tools/list` 70.7 KB).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUDGETS = Object.freeze({
  tarballBytes: 2_000_000,
  unpackedBytes: 8_000_000,
  initializeMs: 3_000,
  toolsListBytes: 80_000,
});

export const FORBIDDEN_PATTERNS = Object.freeze([
  /^src\//,
  /^test\//,
  /^doc\/img\//,
  /^node_modules\/(?!(?:sidwave|6502-toolkit|yaml)\/)/, // bundleDependencies: the workspace packages and the yaml they need
  /\.map$/,
  /\.tsbuildinfo$/,
  /^scripts\/(run-tests|run-coverage|test-state-dir|vice-soak|sid2wav|prepare-release|validate-release|generate-|update-readme|rag-rebuild|fetch-external)/,
]);

export function evaluateBudgets(measured, budgets = BUDGETS) {
  const violations = [];
  for (const [key, limit] of Object.entries(budgets)) {
    const value = measured[key];
    if (typeof value !== "number" || Number.isNaN(value)) {
      violations.push(`${key} was not measured`);
    } else if (value > limit) {
      violations.push(`${key} is ${value}, budget ${limit}`);
    }
  }
  for (const file of measured.files ?? []) {
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file))) {
      violations.push(`forbidden file in package: ${file}`);
    }
  }
  return violations;
}

function listFiles(root) {
  const out = [];
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Runtime dependencies are installed into the extracted copy by the workflow.
        if (dir === root && entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
        bytes += fs.statSync(full).size;
      }
    }
  };
  walk(root);
  return { files: out, bytes };
}

/** Starts the packaged server on stdio, times `initialize` and measures the `tools/list` payload. */
export function measureServer(packageDir, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-budget-"));
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: packageDir,
      env: { ...process.env, C64BRIDGE_STATE_DIR: stateDir },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const result = {};
    let buffer = "";
    const finish = (error) => {
      clearTimeout(timer);
      child.kill("SIGTERM");
      fs.rmSync(stateDir, { recursive: true, force: true });
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`server did not answer within ${timeoutMs} ms`)), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", finish);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          result.initializeMs = Date.now() - startedAt;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (message.id === 2) {
          result.toolsListBytes = Buffer.byteLength(line);
          finish();
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package-budget", version: "1" } },
    });
  });
}

async function main() {
  const [packageDir, tarball] = process.argv.slice(2);
  if (!packageDir || !tarball) {
    console.error("Usage: node scripts/check-package-budget.mjs <package-dir> <tarball>");
    process.exit(2);
  }
  const { files, bytes } = listFiles(path.resolve(packageDir));
  const server = await measureServer(path.resolve(packageDir));
  const measured = { tarballBytes: fs.statSync(tarball).size, unpackedBytes: bytes, files, ...server };
  console.log(`Package budget: ${JSON.stringify({ ...measured, files: files.length })}`);
  const violations = evaluateBudgets(measured);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`::error::${violation}`);
    process.exit(1);
  }
  console.log("Package budgets respected.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
