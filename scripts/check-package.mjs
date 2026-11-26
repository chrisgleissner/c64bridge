#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

async function listPackFiles() {
  const json = run('npm', ['pack', '--dry-run', '--json'], { cwd: root });
  const parsed = JSON.parse(json);
  const files = parsed?.[0]?.files || [];
  return files.map((f) => f.path);
}

async function assertIncludes(files, required) {
  for (const r of required) {
    if (!files.includes(r)) {
      throw new Error(`Package missing required file: ${r}`);
    }
  }
}

async function assertNoDuplicates(files) {
  const seen = new Set();
  for (const f of files) {
    const lower = f.toLowerCase();
    if (seen.has(lower)) {
      throw new Error(`Duplicate entry in package tarball: ${f}`);
    }
    seen.add(lower);
  }
}

async function spotCheckTarball(included) {
  // Also inspect the actual tarball via system tar to double-verify
  const json = run('npm', ['pack', '--json'], { cwd: root });
  const parsed = JSON.parse(json);
  const filename = parsed?.[0]?.filename;
  if (!filename) throw new Error('npm pack did not return filename');

  const tgzPath = path.resolve(root, filename);
  const listing = run('tar', ['-tzf', tgzPath], { cwd: root });
  const lines = listing.split(/\r?\n/).filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    const p = line.replace(/^package\//, '');
    const lower = p.toLowerCase();
    if (seen.has(lower)) {
      throw new Error(`Duplicate path detected inside tarball: ${p}`);
    }
    seen.add(lower);
  }

  for (const r of included) {
    if (!seen.has(r.toLowerCase())) {
      throw new Error(`Tarball missing required file: ${r}`);
    }
  }

  await fs.unlink(tgzPath).catch(() => {});
}

async function main() {
  const files = await listPackFiles();

  const required = [
    'README.md',
    'data/assembly/assembly-spec.md',
    'data/embeddings_basic.json',
    'dist/index.js',
    'dist/mcp/skillsAdapter.js',
    'dist/mcp/tasksAdapter.js',
    'dist/tasks/engine.js',
    'dist/tasks/allowlist.js',
    'dist/tasks/resources.js',
    'dist/monitor/waitUntil.js',
    'dist/monitor/conditions.js',
    'dist/monitor/poller.js',
    'dist/rag/discover.config.json',
    'dist/rag/sources.csv',
  ];

  // Every served skill ships in the tarball; the developer-only pr-converge skill does not.
  const skillDirs = (await fs.readdir(path.join(root, '.github', 'skills'), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name !== 'pr-converge')
    .map((e) => e.name);
  for (const name of skillDirs) required.push(`.github/skills/${name}/SKILL.md`);
  if (skillDirs.length === 0) throw new Error('No skills found under .github/skills');
  if (files.some((f) => f.startsWith('.github/skills/pr-converge/'))) {
    throw new Error('Package must not contain the developer-only pr-converge skill');
  }

  await assertIncludes(files, required);
  await assertNoDuplicates(files);
  await spotCheckTarball(required);

  console.log('Package checks passed. Required files present and no duplicates found.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
