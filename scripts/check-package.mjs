#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';

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

/**
 * Packs c64bridge, installs the tarball in an empty project and checks the bundled workspace packages: they must be
 * real directories (no workspace symbolic links), contain no absolute home paths, and `sidwave` and `c64-asm6502`
 * must load from the installed copy. Needs the npm registry for the other dependencies.
 */
async function cleanInstallCheck() {
  const work = mkdtempSync(path.join(os.tmpdir(), 'c64bridge-install-'));
  try {
    const [info] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], { cwd: root }));
    const project = path.join(work, 'project');
    mkdirSync(project);
    writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
    run('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts', path.join(work, info.filename)], { cwd: project });
    const installed = path.join(project, 'node_modules', 'c64bridge');
    for (const name of ['sidwave', 'c64-asm6502']) {
      const dir = path.join(installed, 'node_modules', name);
      if (lstatSync(dir).isSymbolicLink()) throw new Error(`${name} is a workspace symbolic link in the installed package`);
      if (lstatSync(path.join(project, 'node_modules', name), { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${name} is a symbolic link in the consumer project`);
    }
    const offenders = [];
    const stack = [installed];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.name === '.bin') continue; // npm's own relative bin links
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isSymbolicLink()) offenders.push(`${path.relative(installed, full)} is a symbolic link`);
        else if (entry.name !== 'package-lock.json' && /\.(js|mjs|json|ts)$/.test(entry.name) && /\/home\/|\/Users\//.test(readFileSync(full, 'utf8'))) offenders.push(`${path.relative(installed, full)} contains an absolute home path`);
      }
    }
    if (offenders.length) throw new Error(`Installed package problems:\n  ${offenders.slice(0, 10).join('\n  ')}`);
    run(process.execPath, ['--input-type=module', '-e', "const s = await import('sidwave'); const a = await import('c64-asm6502'); if (typeof s.parseSidwave !== 'function' || !a) process.exit(1);"], { cwd: installed });
    console.log('Clean install check passed: bundled sidwave and c64-asm6502 are real directories, no absolute home paths.');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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
  if (process.argv.includes('--install')) await cleanInstallCheck();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
