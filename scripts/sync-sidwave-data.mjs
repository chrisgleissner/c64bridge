#!/usr/bin/env node
/**
 * The SIDWAVE specification, JSON schema and example scores live in the sidwave package (node_modules/sidwave/data/sound). The public
 * paths data/sound/sidwave.md, data/sound/sidwave.schema.json and data/sound/examples/*.yaml (resources, RAG index,
 * schema URL in editors) are generated from those files. The schema and examples are copies. The specification is
 * composed from the package file and the c64bridge additions in scripts/sidwave-spec-mcp.md.
 *
 *   node scripts/sync-sidwave-data.mjs          write the generated files
 *   node scripts/sync-sidwave-data.mjs --check  list differences and exit 1 when there are any
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(root, "node_modules/sidwave/data/sound");
const TARGET = path.join(root, "data/sound");
const ADDENDUM = path.join(root, "scripts/sidwave-spec-mcp.md");

/** The schema URL the package specification names, and the public URL c64bridge has published since 1.x. */
const PACKAGE_SCHEMA_URL = "https://raw.githubusercontent.com/chrisgleissner/sidwave/main/sidwave/data/sound/sidwave.schema.json";
const SCHEMA_URL = "https://raw.githubusercontent.com/chrisgleissner/c64bridge/refs/heads/main/data/sound/sidwave.schema.json";
const EXAMPLES_HEADING = "## Playable examples";

/** Relative paths (posix) of the generated files. */
export function listSyncedFiles(source = SOURCE) {
  const files = ["sidwave.md", "sidwave.schema.json"];
  const examples = path.join(source, "examples");
  if (fs.existsSync(examples)) {
    for (const name of fs.readdirSync(examples).sort()) if (name.endsWith(".yaml")) files.push(`examples/${name}`);
  }
  return files;
}

/** The `<!-- after: <heading> -->` blocks of the addendum; text before the first marker is ignored. */
function parseAddendum(addendum) {
  const parts = addendum.split(/^<!-- after: (.+?) -->$/m);
  const blocks = [];
  for (let i = 1; i < parts.length; i += 2) blocks.push({ heading: parts[i], text: parts[i + 1].trim() });
  return blocks;
}

/**
 * The c64bridge specification: each addendum block is inserted below its heading, the schema URL is replaced by the
 * c64bridge URL, and example names in the examples section become c64://sound/examples links. Throws when a heading
 * does not occur exactly once, so that a renamed section cannot silently drop guidance.
 */
export function composeSpec(spec, addendum, examples = []) {
  const lines = spec.replaceAll(PACKAGE_SCHEMA_URL, SCHEMA_URL).split("\n");
  for (const { heading, text } of parseAddendum(addendum)) {
    const matches = lines.flatMap((line, index) => (line === heading ? [index] : []));
    if (matches.length !== 1) {
      throw new Error(`scripts/sidwave-spec-mcp.md: the heading "${heading}" occurs ${matches.length} times in the sidwave specification; expected once`);
    }
    lines.splice(matches[0] + 1, 0, "", ...text.split("\n"));
  }
  const start = lines.indexOf(EXAMPLES_HEADING);
  for (let i = start + 1; start >= 0 && i < lines.length && !lines[i].startsWith("## "); i += 1) {
    lines[i] = lines[i].replace(/\(`([a-z0-9_]+)`\)/g, (match, name) =>
      examples.includes(name) ? `([\`${name}\`](c64://sound/examples/${name}))` : match);
  }
  return lines.join("\n");
}

/** The content a generated file must have. */
function generated(rel, source, addendum) {
  const content = fs.readFileSync(path.join(source, rel));
  if (rel !== "sidwave.md") return content;
  const examples = listSyncedFiles(source).filter((file) => file.startsWith("examples/")).map((file) => path.basename(file, ".yaml"));
  return Buffer.from(composeSpec(content.toString("utf8"), fs.readFileSync(addendum, "utf8"), examples));
}

/** Generated files that are missing or differ from their sources, and generated example copies without a source. */
export function findDrift(source = SOURCE, target = TARGET, addendum = ADDENDUM) {
  const drift = [];
  const wanted = listSyncedFiles(source);
  for (const rel of wanted) {
    const to = path.join(target, rel);
    if (!fs.existsSync(to)) drift.push(`${rel}: missing`);
    else if (!generated(rel, source, addendum).equals(fs.readFileSync(to))) drift.push(`${rel}: differs`);
  }
  const targetExamples = path.join(target, "examples");
  if (fs.existsSync(targetExamples)) {
    for (const name of fs.readdirSync(targetExamples)) {
      if (name.endsWith(".yaml") && !wanted.includes(`examples/${name}`)) drift.push(`examples/${name}: no source in the package`);
    }
  }
  return drift;
}

export function syncData(source = SOURCE, target = TARGET, addendum = ADDENDUM) {
  for (const rel of listSyncedFiles(source)) {
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    fs.writeFileSync(path.join(target, rel), generated(rel, source, addendum));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const drift = findDrift();
    if (drift.length) {
      console.error(`Generated SIDWAVE data differs from the sidwave package (node_modules/sidwave/data/sound) and scripts/sidwave-spec-mcp.md:\n  ${drift.join("\n  ")}\nRun: node scripts/sync-sidwave-data.mjs`);
      process.exit(1);
    }
  } else {
    syncData();
  }
}
