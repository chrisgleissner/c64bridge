import test from "#test/runner";
import assert from "#test/assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tsLoader = "tsx/esm";

function resolveNodeExecutable() {
  const candidates = [
    process.env.C64BRIDGE_TEST_NODE_BIN,
    process.env.C64BRIDGE_NODE_BIN,
    process.env.NODE_BINARY,
    process.env.NODE_EXEC_PATH,
    process.env.npm_node_execpath,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) return candidate.trim();
  }
  // process.execPath can be the Bun binary when this file runs under `bun
  // test`; Bun's --eval/--import flag handling differs from Node's, so a
  // real `node` binary is required for this child regardless of runner.
  return "node";
}

test("HARD01-025 initRag loads the bundled indexes from the package directory even when the process cwd is a foreign (installed-package-style) working directory", async (t) => {
  const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-foreign-cwd-"));
  t.after(() => fs.rmSync(foreignCwd, { recursive: true, force: true }));

  const scriptPath = path.join(os.tmpdir(), `c64bridge-rag-foreign-cwd-probe-${process.pid}-${Date.now()}.mjs`);
  const resultPath = path.join(os.tmpdir(), `c64bridge-rag-foreign-cwd-result-${process.pid}-${Date.now()}.json`);
  t.after(() => {
    fs.rmSync(scriptPath, { force: true });
    fs.rmSync(resultPath, { force: true });
  });
  fs.writeFileSync(
    scriptPath,
    `
    // Simulate the documented npm-installed layout: the server module lives
    // under the caller's node_modules, but the caller's own project (an
    // unrelated cwd) is what's actually running. process.chdir happens
    // before any RAG module import, so module-level path resolution must
    // not have baked in the launch cwd.
    process.chdir(${JSON.stringify(foreignCwd)});
    const { initRag } = await import(${JSON.stringify(path.join(repoRoot, "src", "rag", "init.ts"))});
    const retriever = await initRag();
    const results = await retriever.retrieve("PRINT statement", 3, "basic");
    // Write to a dedicated result file rather than stdout: debug logging
    // (console.debug) also writes to stdout and would otherwise corrupt it.
    const fs2 = await import("node:fs");
    fs2.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ count: results.length, cwd: process.cwd() }));
    `,
    "utf8",
  );

  const stdoutChunks = [];
  const stderrChunks = [];

  // The test harness itself points RAG_EMBEDDINGS_DIR at a small fixture
  // directory for speed/determinism (see scripts/run-tests.ts). This test's
  // whole point is the package-relative default resolution, so that
  // override must not leak into the child.
  const childEnv = { ...process.env };
  delete childEnv.RAG_EMBEDDINGS_DIR;
  delete childEnv.C64BRIDGE_ASSET_ROOT;

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      resolveNodeExecutable(),
      ["--import", tsLoader, scriptPath],
      {
        cwd: repoRoot,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`RAG foreign-cwd child probe failed with exit code ${exitCode}\n${stderrChunks.join("")}`);
  }

  const output = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(output.cwd, fs.realpathSync(foreignCwd));
  // The bundled BASIC index must have resolved and returned real snippets
  // despite the foreign cwd, not the empty-index silent failure HARD01-025
  // describes.
  assert.ok(output.count > 0, "expected at least one retrieved BASIC reference");
});
