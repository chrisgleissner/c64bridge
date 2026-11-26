#!/usr/bin/env node
// Checks that every `c64_<tool>` name and `op: "<op>"` string in .github/skills/*/SKILL.md exists in the
// published tool interface (mcp/tools.json, produced by `npm run build`). Exit code 1 lists the stale items.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tools = JSON.parse(readFileSync(join(root, "mcp", "tools.json"), "utf8"));
const list = Array.isArray(tools) ? tools : tools.tools;
const opsByTool = new Map(list.map((tool) => [tool.name, new Set(tool.inputSchema?.properties?.op?.enum ?? [])]));
const allOps = new Set([...opsByTool.values()].flatMap((ops) => [...ops]));

const problems = [];
const skillsDir = join(root, ".github", "skills");
for (const dir of readdirSync(skillsDir)) {
  let text;
  try {
    text = readFileSync(join(skillsDir, dir, "SKILL.md"), "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  const toolsInSkill = new Set();
  lines.forEach((line, index) => {
    const where = `${dir}/SKILL.md:${index + 1}`;
    for (const [, name] of line.matchAll(/\b(c64_[a-z_]+)\b/g)) {
      toolsInSkill.add(name);
      if (!opsByTool.has(name)) problems.push(`${where}: unknown tool ${name}`);
    }
  });
  lines.forEach((line, index) => {
    const where = `${dir}/SKILL.md:${index + 1}`;
    const lineTools = [...line.matchAll(/\b(c64_[a-z_]+)\b/g)].map((m) => m[1]).filter((name) => opsByTool.has(name));
    const candidates = lineTools.length > 0 ? lineTools : [...toolsInSkill].filter((name) => opsByTool.has(name));
    for (const [, op] of line.matchAll(/\bop(?::\s*|\s+)"([a-z_0-9]+)"/g)) {
      if (!allOps.has(op)) problems.push(`${where}: op "${op}" exists in no tool`);
      else if (!candidates.some((name) => opsByTool.get(name).has(op))) problems.push(`${where}: op "${op}" is not an op of ${candidates.join(", ") || "any tool named in this skill"}`);
    }
  });
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("Skill tool and op references match mcp/tools.json.");
