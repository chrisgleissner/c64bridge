#!/usr/bin/env node
/**
 * The SIDWAVE specification, JSON schema and example scores live in packages/sidwave/data/sound. The public
 * paths data/sound/sidwave.md, data/sound/sidwave.schema.json and data/sound/examples/*.yaml (resources, RAG index,
 * schema URL in editors) are generated copies of those files.
 *
 *   node scripts/sync-sidwave-data.mjs          copy the package files over the generated copies
 *   node scripts/sync-sidwave-data.mjs --check  list differences and exit 1 when there are any
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(root, "packages/sidwave/data/sound");
const TARGET = path.join(root, "data/sound");

/** Relative paths (posix) of the files that are copied. */
export function listSyncedFiles(source = SOURCE) {
  const files = ["sidwave.md", "sidwave.schema.json"];
  const examples = path.join(source, "examples");
  if (fs.existsSync(examples)) {
    for (const name of fs.readdirSync(examples).sort()) if (name.endsWith(".yaml")) files.push(`examples/${name}`);
  }
  return files;
}

/** Files whose generated copy is missing or differs from the package file, and generated example copies without a source. */
export function findDrift(source = SOURCE, target = TARGET) {
  const drift = [];
  const wanted = listSyncedFiles(source);
  for (const rel of wanted) {
    const from = path.join(source, rel), to = path.join(target, rel);
    if (!fs.existsSync(to)) drift.push(`${rel}: missing`);
    else if (!fs.readFileSync(from).equals(fs.readFileSync(to))) drift.push(`${rel}: differs`);
  }
  const targetExamples = path.join(target, "examples");
  if (fs.existsSync(targetExamples)) {
    for (const name of fs.readdirSync(targetExamples)) {
      if (name.endsWith(".yaml") && !wanted.includes(`examples/${name}`)) drift.push(`examples/${name}: no source in the package`);
    }
  }
  return drift;
}

export function syncData(source = SOURCE, target = TARGET) {
  for (const rel of listSyncedFiles(source)) {
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    fs.copyFileSync(path.join(source, rel), path.join(target, rel));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const drift = findDrift();
    if (drift.length) {
      console.error(`Generated SIDWAVE data differs from packages/sidwave/data/sound:\n  ${drift.join("\n  ")}\nRun: node scripts/sync-sidwave-data.mjs`);
      process.exit(1);
    }
  } else {
    syncData();
  }
}
