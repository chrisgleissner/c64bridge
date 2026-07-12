#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const run = (command, options = {}) => {
  execSync(command, { stdio: 'inherit', ...options });
};

const updateJsonFile = async (relativePath, updater) => {
  const filePath = path.resolve(relativePath);
  const raw = await readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  const updated = await updater(data);
  await writeFile(filePath, JSON.stringify(updated, null, 2) + '\n');
};

const fileExists = async (relativePath) => {
  try {
    await access(path.resolve(relativePath));
    return true;
  } catch {
    return false;
  }
};

const getRepositoryMetadata = (repository) => {
  const rawUrl = typeof repository === 'string' ? repository : repository?.url;
  if (!rawUrl) {
    return undefined;
  }

  let url = rawUrl.trim();
  if (url.startsWith('git+')) {
    url = url.slice(4);
  }
  if (url.endsWith('.git')) {
    url = url.slice(0, -4);
  }
  if (!/^https?:\/\//.test(url)) {
    return undefined;
  }

  return {
    url,
    source: url.includes('github.com') ? 'github' : undefined,
  };
};

const normaliseVersion = (value) => value.replace(/^v/, '');

const isExactVersion = (value) => /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const changelogHasVersion = async (version) => {
  try {
    const raw = await readFile(path.resolve('CHANGELOG.md'), 'utf8');
    const pattern = new RegExp(`^##\\s+${escapeRegExp(version)}\\b`, 'm');
    return pattern.test(raw);
  } catch {
    return false;
  }
};

const usage = `Usage: npm run release:prepare -- <new-version|major|minor|patch>

Examples:
  npm run release:prepare -- 0.2.0
  npm run release:prepare -- minor`;

const arg = process.argv[2];
if (!arg) {
  console.error('Error: missing version argument.');
  console.error(usage);
  process.exit(1);
}

const currentPkgRaw = await readFile(path.resolve('package.json'), 'utf8');
const currentPkg = JSON.parse(currentPkgRaw);
const requestedVersion = normaliseVersion(arg);

let skippedVersionBump = false;

if (isExactVersion(arg) && requestedVersion === currentPkg.version) {
  skippedVersionBump = true;
  console.log(`Version already set to ${currentPkg.version}; skipping npm version.`);
} else {
  try {
    run(`npm version ${arg} --no-git-tag-version`);
  } catch (error) {
    console.error('npm version failed.');
    process.exit(error.status || 1);
  }
}

const pkgRaw = await readFile(path.resolve('package.json'), 'utf8');
const pkg = JSON.parse(pkgRaw);
const newVersion = pkg.version;

await updateJsonFile('mcp.json', async (data) => ({
  ...data,
  version: newVersion,
}));

if (await fileExists('server.json')) {
  await updateJsonFile('server.json', async (data) => {
    const packages = Array.isArray(data.packages) ? [...data.packages] : [];
    const primaryPackage = packages[0] ?? {
      registryType: 'npm',
      transport: {
        type: 'stdio',
      },
    };

    packages[0] = {
      ...primaryPackage,
      identifier: pkg.name,
      version: newVersion,
      transport: primaryPackage.transport ?? {
        type: 'stdio',
      },
    };

    const repository = getRepositoryMetadata(pkg.repository);

    return {
      ...data,
      name: pkg.mcpName ?? data.name,
      version: newVersion,
      repository: repository
        ? {
            ...(data.repository ?? {}),
            ...repository,
          }
        : data.repository,
      packages,
    };
  });
}

// Manifest generation removed (runtime discovery via MCP stdio)

// Update CHANGELOG.md from commits since last tag using Conventional Commits subjects.
const hasExistingChangelogEntry = await changelogHasVersion(newVersion);

if (skippedVersionBump && hasExistingChangelogEntry) {
  console.log(`CHANGELOG.md already contains ${newVersion}; skipping changelog generation.`);
} else {
  try {
    run(`node scripts/generate-changelog.mjs ${newVersion}`);
  } catch (e) {
    console.warn('WARN: Failed to generate CHANGELOG.md. You can run it manually: npm run changelog:generate');
  }
}

console.log(`Release metadata updated to ${newVersion}.`);
console.log('Next steps: commit and push the changes, then create the release tag from GitHub once main is ready.');
