import test from '#test/runner';
import assert from '#test/assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { validateReleaseMetadata } from '../../scripts/validate-release.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-metadata-'));
  const pkg = { name: 'c64bridge', version: '1.2.3', mcpName: 'io.github.chrisgleissner/c64bridge', main: 'dist/index.js', bin: { c64bridge: 'scripts/cli.js' }, dependencies: { axios: '^1.20.0' }, devDependencies: {}, optionalDependencies: {} };
  const files = {
    'package.json': pkg,
    'package-lock.json': { name: pkg.name, version: pkg.version, packages: { '': pkg } },
    'mcp.json': { version: pkg.version },
    'mcp/server.json': { version: pkg.version },
    'server.json': { name: pkg.mcpName, version: pkg.version, packages: [{ identifier: pkg.name, version: pkg.version }] },
  };
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  }
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3 - 2026-10-07\n\n### Bug Fixes\n\n- Fixed.\n');
  return dir;
}

function change(dir, file, apply) {
  const target = path.join(dir, file);
  const data = JSON.parse(fs.readFileSync(target, 'utf8'));
  apply(data);
  fs.writeFileSync(target, JSON.stringify(data));
}

test('release metadata requires one version across package, lockfile, MCP manifests, and changelog', () => {
  const dir = fixture();
  try {
    assert.equal(validateReleaseMetadata(dir, '1.2.3').version, '1.2.3');
    assert.throws(() => validateReleaseMetadata(dir, '1.2.4'), /release tag/);
    assert.throws(() => validateReleaseMetadata(dir, '1.2.3-beta.1'), /stable release/);
    for (const file of ['mcp.json', 'mcp/server.json', 'server.json', 'package-lock.json']) {
      const original = fs.readFileSync(path.join(dir, file));
      change(dir, file, (data) => { data.version = '1.2.2'; });
      assert.throws(() => validateReleaseMetadata(dir, '1.2.3'), /version mismatch/);
      fs.writeFileSync(path.join(dir, file), original);
    }
    change(dir, 'server.json', (data) => { data.packages[0].version = '1.2.2'; });
    assert.throws(() => validateReleaseMetadata(dir, '1.2.3'), /npm version mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release metadata rejects lockfile drift, wrong registry package, private packages, and missing release notes', () => {
  for (const [file, apply, pattern] of [
    ['package-lock.json', (data) => { data.packages[''].version = '1.2.2'; }, /root version mismatch/],
    ['package-lock.json', (data) => { data.packages[''].dependencies = {}; }, /dependencies differs/],
    ['server.json', (data) => { data.packages[0].identifier = 'another-package'; }, /npm name mismatch/],
    ['package.json', (data) => { data.name = 'another-package'; }, /Wrong npm package/],
    ['package.json', (data) => { data.private = true; }, /must be public/],
  ]) {
    const dir = fixture();
    try {
      change(dir, file, apply);
      assert.throws(() => validateReleaseMetadata(dir, '1.2.3'), pattern);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const dir = fixture();
  try {
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n');
    assert.throws(() => validateReleaseMetadata(dir, '1.2.3'), /Missing release changelog/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packed release metadata still verifies every manifest without requiring npm-excluded lockfiles', () => {
  const dir = fixture();
  try {
    fs.rmSync(path.join(dir, 'package-lock.json'));
    fs.rmSync(path.join(dir, 'CHANGELOG.md'));
    validateReleaseMetadata(dir, '1.2.3', { packed: true });
    change(dir, 'mcp/server.json', (data) => { data.version = '1.2.2'; });
    assert.throws(() => validateReleaseMetadata(dir, '1.2.3', { packed: true }), /version mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release workflow publishes only the unchanged artifact tested from its exact prepared tag', () => {
  const workflow = YAML.parse(fs.readFileSync('.github/workflows/release.yaml', 'utf8'));
  const steps = workflow.jobs.release.steps;
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkout.with.ref.includes('refs/tags/'));
  assert.ok(checkout.with.ref.includes('github.ref'));
  assert.ok(!steps.some((step) => /release:prepare|git push origin HEAD:main/.test(step.run ?? '')));
  const index = (name) => steps.findIndex((step) => step.name === name);
  const publish = steps[index('Publish validated artifact to npm')];
  assert.match(publish.run, /sha256sum --check/);
  assert.match(publish.run, /npm publish "\.\/\$RELEASE_TARBALL" --ignore-scripts/);
  assert.match(publish.run, /--registry https:\/\/registry\.npmjs\.org/);
  assert.ok(index('Verify prepared release tag') < index('Build project'));
  assert.ok(index('Validate exact packed artifact before publishing') < index('Publish validated artifact to npm'));
  assert.ok(index('Validate MCP Registry manifest') < index('Publish validated artifact to npm'));
  assert.match(steps[index('Wait for npm package visibility')].run, /PUBLISHED_INTEGRITY.*EXPECTED_INTEGRITY/);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});
