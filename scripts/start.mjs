#!/usr/bin/env node
/**
 * Flexible launcher for the MCP server.
 *
 * - Prefer running the TypeScript sources directly under Bun during local
 *   development.
 * - Fall back to the compiled JavaScript in dist/ when the package is
 *   consumed from npm, where the sources and dev dependencies are omitted.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveProjectRoot() {
  return process.env.C64BRIDGE_PROJECT_ROOT
    ? path.resolve(process.env.C64BRIDGE_PROJECT_ROOT)
    : path.resolve(here, '..');
}

function shouldImportTypeScriptDirectly() {
  return typeof globalThis.Bun !== 'undefined' && process.env.C64BRIDGE_START_FORCE_NODE_RUNTIME !== '1';
}

async function fileExists(filePath) {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch (error) {
    const err = error;
    if (err && typeof err === 'object' && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

function resolveBunExecutable() {
  const homeDir = process.env.HOME || os.homedir();
  const candidates = [
    process.env.BUN_BIN,
    process.env.C64BRIDGE_TEST_BUN_BIN,
    process.env.C64BRIDGE_BUN_BIN,
    process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', 'bun') : null,
    homeDir ? path.join(homeDir, '.bun', 'bin', 'bun') : null,
  ];

  for (const candidate of candidates) {
    if (!candidate || !candidate.trim()) {
      continue;
    }

    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return 'bun';
}

async function runWithBun(entryPath) {
  const bunExecutable = resolveBunExecutable();
  const projectRoot = path.dirname(path.dirname(entryPath));

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bunExecutable, [entryPath], {
        cwd: projectRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
        },
      });

      // Forward termination signals so the server child does not outlive the launcher.
      const forwardedSignals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
      const forwarders = new Map();
      for (const name of forwardedSignals) {
        const forward = () => {
          try {
            child.kill(name);
          } catch {}
        };
        forwarders.set(name, forward);
        process.on(name, forward);
      }
      const removeForwarders = () => {
        for (const [name, forward] of forwarders) {
          process.removeListener(name, forward);
        }
      };

      child.on('error', (error) => {
        removeForwarders();
        reject(error);
      });
      child.on('exit', (code, signal) => {
        removeForwarders();
        if (signal) {
          try {
            process.kill(process.pid, signal);
          } catch {}
          resolve();
          return;
        }
        process.exitCode = code ?? 1;
        resolve();
      });
    });
  } catch (error) {
    const err = error;
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  return true;
}

async function launch() {
  const projectRoot = resolveProjectRoot();
  const srcEntry = path.resolve(projectRoot, 'src/index.ts');
  const distEntry = path.resolve(projectRoot, 'dist/index.js');

  if (shouldImportTypeScriptDirectly() && await fileExists(srcEntry)) {
    await import(pathToFileURL(srcEntry).href);
    return;
  }

  if (await fileExists(srcEntry) && await runWithBun(srcEntry)) {
    return;
  }

  if (await fileExists(distEntry)) {
    await import(pathToFileURL(distEntry).href);
    return;
  }

  console.error('[start] Unable to locate server entry point: dist/index.js or src/index.ts.');
  console.error('[start] Build the project with `npm run build` or install Bun to run the TypeScript sources directly.');
  process.exitCode = 1;
}

export {
  fileExists,
  resolveBunExecutable,
  resolveProjectRoot,
  runWithBun,
  shouldImportTypeScriptDirectly,
  launch,
};

if (process.env.C64BRIDGE_START_SKIP_AUTO_LAUNCH !== '1') {
  await launch();
}
