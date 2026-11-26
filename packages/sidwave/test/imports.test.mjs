import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const declared = new Set(Object.keys(manifest.dependencies ?? {}));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Every module specifier of an import or export declaration, dynamic import or require call. */
function specifiers(text) {
  const found = [];
  const patterns = [/\b(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g, /\brequire\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push(match[1]);
  return found;
}

test("the package source imports only itself, node: builtins and declared dependencies", () => {
  const srcDir = path.join(packageRoot, "src");
  const files = sourceFiles(srcDir);
  assert.ok(files.length > 0);
  const offenders = [];
  for (const file of files) {
    for (const spec of specifiers(fs.readFileSync(file, "utf8"))) {
      if (spec.startsWith("node:") || builtinModules.includes(spec)) continue;
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(file), spec);
        if (path.relative(srcDir, target).startsWith("..")) offenders.push(`${path.relative(packageRoot, file)}: ${spec} leaves the package`);
        continue;
      }
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!declared.has(name)) offenders.push(`${path.relative(packageRoot, file)}: ${spec} is not a declared dependency`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the command line is covered by the import scan and uses no network module", () => {
  const srcDir = path.join(packageRoot, "src");
  const scanned = sourceFiles(srcDir).map((file) => path.relative(srcDir, file));
  for (const file of ["cli.ts", "bin.ts", "sidwaveOps.ts"]) assert.ok(scanned.includes(file), `${file} is scanned`);
  const network = new Set(["http", "https", "http2", "net", "tls", "dns", "dgram", "child_process", "worker_threads"]);
  for (const file of ["cli.ts", "bin.ts", "sidwaveOps.ts"]) {
    for (const spec of specifiers(fs.readFileSync(path.join(srcDir, file), "utf8"))) {
      assert.ok(!network.has(spec.replace(/^node:/, "")), `${file} imports ${spec}`);
    }
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(fs.readFileSync(path.join(srcDir, file), "utf8")), `${file} makes a network call`);
  }
  assert.equal(manifest.bin.sidwave, "./dist/bin.js");
});
