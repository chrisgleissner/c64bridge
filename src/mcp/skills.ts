import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Skills (`.github/skills/<name>/SKILL.md`) hold the execution steps that prompts route to. They
 * ship in the npm package, but a client outside this repository cannot read repository paths, so
 * each skill is served as the resource `c64://skills/<name>`.
 */
export const SKILL_URI_PREFIX = "c64://skills/";

/** Developer-only skills that are not part of the package. */
const EXCLUDED_SKILLS = new Set(["pr-converge"]);

export interface SkillResource {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: "text/markdown";
  readonly path: string;
}

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let cached: readonly SkillResource[] | undefined;

export function skillUri(name: string): string {
  return `${SKILL_URI_PREFIX}${name}`;
}

function frontmatterValue(text: string, key: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return undefined;
  const line = match[1]!.split(/\r?\n/).find((entry) => entry.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim() || undefined;
}

export function listSkillResources(root: string = PROJECT_ROOT): readonly SkillResource[] {
  if (cached && root === PROJECT_ROOT) return cached;
  const directory = join(root, ".github", "skills");
  const skills: SkillResource[] = [];
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || EXCLUDED_SKILLS.has(entry.name) || !/^[a-z0-9-]+$/.test(entry.name)) continue;
      const path = join(directory, entry.name, "SKILL.md");
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      skills.push({
        uri: skillUri(entry.name),
        name: `Skill: ${frontmatterValue(text, "name") ?? entry.name}`,
        description: frontmatterValue(text, "description") ?? `Execution steps for ${entry.name}.`,
        mimeType: "text/markdown",
        path,
      });
    }
  }
  skills.sort((a, b) => a.uri.localeCompare(b.uri));
  if (root === PROJECT_ROOT) cached = skills;
  return skills;
}

/** Rewrites repository skill paths in served text to their resource URIs, which every client can read. */
export function rewriteSkillPaths(text: string): string {
  return text.replace(/(?:\.\/)?\.github\/skills\/\*\/SKILL\.md/g, `${SKILL_URI_PREFIX}<name>`).replace(/(?:\.\.\/skills|(?:\.\/)?\.github\/skills)\/([a-z0-9-]+)\/SKILL\.md/g, (whole, name: string) =>
    EXCLUDED_SKILLS.has(name) ? whole : skillUri(name));
}

export function readSkillResource(uri: string): { uri: string; mimeType: "text/markdown"; text: string } | undefined {
  if (!uri.startsWith(SKILL_URI_PREFIX)) return undefined;
  const skill = listSkillResources().find((entry) => entry.uri === uri);
  if (!skill) return undefined;
  return { uri, mimeType: "text/markdown", text: rewriteSkillPaths(readFileSync(skill.path, "utf8")) };
}
