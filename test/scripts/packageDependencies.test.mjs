import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "#test/runner";
import assert from "#test/assert";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

test("PACKAGE-6 every runtime dependency is referenced by shipped code", () => {
  const files = [...sourceFiles(path.join(root, "src")), ...sourceFiles(path.join(root, "generated"))];
  const text = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const unused = Object.keys(pkg.dependencies ?? {}).filter((name) => !text.includes(`"${name}`) && !text.includes(`'${name}`));
  assert.deepEqual(unused, []);
});
