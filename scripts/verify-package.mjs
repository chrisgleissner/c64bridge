#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import crypto from 'node:crypto';

function usage() {
  console.error('Usage: node scripts/verify-package.mjs <package-dir>');
  process.exit(1);
}

const dirArg = process.argv[2];
if (!dirArg) {
  usage();
}

const packageDir = resolve(process.cwd(), dirArg);

function ensureExists(relPath, type = 'file') {
  const fullPath = resolve(packageDir, relPath);
  try {
    const stats = statSync(fullPath);
    if (type === 'file' && !stats.isFile()) {
      console.error(`Expected file at ${relPath}, found other type`);
      process.exit(1);
    }
    if (type === 'dir' && !stats.isDirectory()) {
      console.error(`Expected directory at ${relPath}, found other type`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Missing required ${type} at ${relPath}:`, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function assertSpotChecks() {
  const files = [
    'package.json',
    'mcp.json',
    'README.md',
    'LICENSE',
    'dist/index.js',
    'dist/c64Client.js',
    'dist/rag/sources.csv',
    'dist/rag/discover.config.json',
    'generated/c64/index.js',
    'scripts/cli.js',
    'scripts/start.mjs',
  ];
  const dirs = [
    'doc',
    'data',
    'dist/rag',
  ];

  files.forEach((file) => ensureExists(file, 'file'));
  dirs.forEach((dir) => ensureExists(dir, 'dir'));

  const embeddings = readdirSync(resolve(packageDir, 'data')).filter((name) => name.startsWith('embeddings_') && name.endsWith('.json'));
  if (embeddings.length === 0) {
    console.error('Expected embeddings JSON files under data/, none found');
    process.exit(1);
  }
}

function detectDuplicates() {
  const hashes = new Map();
  const duplicates = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        // Bundled dependencies (sidwave, c64-asm6502 and their yaml dependency) are separate
        // packages: data/sound/* are intentional copies of sidwave files at their public paths,
        // and third-party packages may contain identical files of their own.
        if (dir === packageDir && entry.name === 'node_modules') continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const rel = relative(packageDir, fullPath);
        const data = readFileSync(fullPath);
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        if (hashes.has(hash)) {
          duplicates.push([hashes.get(hash), rel]);
        } else {
          hashes.set(hash, rel);
        }
      }
    }
  };

  walk(packageDir);

  if (duplicates.length > 0) {
    console.error('Duplicate files detected in package (identical content):');
    for (const [first, dup] of duplicates) {
      console.error(` - ${first} == ${dup}`);
    }
    process.exit(1);
  }
}

function showSourcesCsvPreview() {
  const csvPath = resolve(packageDir, 'dist/rag/sources.csv');
  try {
    const preview = readFileSync(csvPath, 'utf8').split('\n').slice(0, 5).join('\n');
    console.log('Preview dist/rag/sources.csv:');
    console.log(preview);
  } catch (error) {
    console.error('Failed to read dist/rag/sources.csv:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function logPackageContents() {
  const items = [];
  const stack = ['.'];
  while (stack.length > 0) {
    const current = stack.pop();
    const fullPath = resolve(packageDir, current);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (current !== '.') {
        items.push(`${current}/`);
      }
      const children = readdirSync(fullPath)
        .map((name) => (current === '.' ? name : `${current}/${name}`))
        .sort()
        .reverse();
      for (const child of children) {
        stack.push(child);
      }
    } else if (stats.isFile()) {
      items.push(current);
    }
  }

  items.sort((a, b) => a.localeCompare(b));
  console.log('Package file listing:');
  for (const entry of items) {
    console.log(` - ${entry}`);
  }
}

assertSpotChecks();
detectDuplicates();
showSourcesCsvPreview();
logPackageContents();

console.log('Package verification succeeded.');
