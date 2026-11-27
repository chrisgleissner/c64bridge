#!/usr/bin/env node
/**
 * Verify that the packaged build remains consumable from npm + Node.js.
 *
 * 1. npm pack (real tarball)
 * 2. Extract into temp dir
 * 3. npm install --omit=dev inside the packed output
 * 4. Import a few key modules with Node (ESM)
 *
 * Exits non-zero if any step fails.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${command} ${args.join(" ")}): ${result.error ?? result.stderr ?? ""}`.trim(),
    );
  }
  return result;
}

function runInDir(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${command} ${args.join(" ")} in ${cwd}): ${result.error ?? result.stderr ?? ""}`.trim(),
    );
  }
  return result;
}

let tarball = "";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-node-compat-"));
let extractDir = "";

try {
  const packResult = run("npm", ["pack", "--silent"], { stdio: "pipe" });
  tarball = packResult.stdout.trim().split("\n").pop();
  if (!tarball) {
    throw new Error("npm pack did not produce a tarball name");
  }

  console.log(`✔ Created tarball ${tarball}`);

  run("tar", ["-xzf", tarball, "-C", tempDir]);
  extractDir = path.join(tempDir, "package");
  if (!fs.existsSync(extractDir)) {
    throw new Error("Failed to extract npm package");
  }

  console.log("✔ Extracted tarball for inspection");

  // The tarball bundles the workspace packages sidwave and 6502-toolkit, which are not on the registry, so a plain
  // `npm install` inside the extracted directory cannot resolve them. Install the tarball into an empty project, as a
  // user does, and import from the installed copy.
  const consumerDir = path.join(tempDir, "consumer");
  fs.mkdirSync(consumerDir);
  fs.writeFileSync(path.join(consumerDir, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  runInDir("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", path.resolve(repoRoot, tarball)], consumerDir);
  extractDir = path.join(consumerDir, "node_modules", "c64bridge");
  console.log("✔ Installed the tarball and its runtime dependencies via npm");

  const modulesToCheck = [
    "./dist/c64Client.js",
    "./dist/tools/programRunners.js",
    "./dist/tools/memory.js",
  ];

  for (const mod of modulesToCheck) {
    const code = `await import(${JSON.stringify(mod)});`;
    runInDir(process.execPath, ["--input-type=module", "-e", code], extractDir);
    console.log(`✔ Node imported ${mod}`);
  }

  console.log("✅ Node compatibility check passed");
} finally {
  if (tarball) {
    try {
      fs.rmSync(path.join(repoRoot, tarball), { force: true });
    } catch {
      // ignore
    }
  }
  if (extractDir && fs.existsSync(extractDir)) {
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
