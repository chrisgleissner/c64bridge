#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateReleaseMetadata(root, version, { packed = false } = {}) {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Expected a stable release version');
  const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  const pkg = read('package.json');
  assert.equal(pkg.name, 'c64bridge', 'Wrong npm package');
  assert.equal(pkg.version, version, 'package.json version does not match release tag');
  assert.equal(pkg.private, undefined, 'Release package must be public');
  assert.equal(pkg.main, 'dist/index.js', 'Wrong compiled entry point');
  assert.equal(pkg.bin.c64bridge, 'scripts/cli.js', 'Wrong CLI entry point');
  assert.equal(read('mcp.json').version, version, 'mcp.json version mismatch');
  assert.equal(read('mcp/server.json').version, version, 'Generated MCP metadata version mismatch');
  const server = read('server.json');
  assert.equal(server.name, pkg.mcpName, 'MCP Registry server name mismatch');
  assert.equal(server.version, version, 'MCP Registry version mismatch');
  assert.equal(server.packages[0].identifier, pkg.name, 'MCP Registry npm name mismatch');
  assert.equal(server.packages[0].version, version, 'MCP Registry npm version mismatch');
  if (!packed) {
    const lock = read('package-lock.json');
    assert.equal(lock.name, pkg.name, 'Lockfile package name mismatch');
    assert.equal(lock.version, version, 'Lockfile version mismatch');
    assert.equal(lock.packages[''].version, version, 'Lockfile root version mismatch');
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      assert.deepEqual(lock.packages[''][section], pkg[section], `Lockfile ${section} differs from package.json`);
    }
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, new RegExp(`^## ${version.replaceAll('.', '\\.')} - \\d{4}-\\d{2}-\\d{2}$`, 'm'), 'Missing release changelog entry');
  }
  return pkg;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  validateReleaseMetadata(process.cwd(), process.argv[2]);
  console.log(`Release metadata agrees on c64bridge@${process.argv[2]}.`);
}
