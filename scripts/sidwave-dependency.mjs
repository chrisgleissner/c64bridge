#!/usr/bin/env node
/**
 * Switches the sidwave and 6502-toolkit dependencies between local tarballs and a registry version.
 *
 *   node scripts/sidwave-dependency.mjs tarballs [--dir <dir>] [--no-install]
 *       Copy the tarballs `npm pack` produced in <dir> (default ~/.c64bridge/sidwave-standalone/tarballs) to the
 *       ignored directory vendor/sidwave-tarballs and point both dependencies at the copies, so that package.json and
 *       the lock files hold relative paths. Run this in a new checkout before `npm ci`. Because sidwave itself depends
 *       on 6502-toolkit from the registry, an override makes npm use the same tarball for that nested dependency.
 *   node scripts/sidwave-dependency.mjs registry --sidwave <x.y.z> --toolkit <x.y.z> [--no-install]
 *       Use caret ranges of published versions and remove the override. This is the only step of the release PR that
 *       changes the dependency source.
 *   node scripts/sidwave-dependency.mjs check
 *       Exit 1 while any dependency still uses a file: specifier. Run it in the release PR.
 *
 * After editing package.json the script refreshes package-lock.json and, when bun is on PATH, bun.lock, unless
 * --no-install is given. Run it again after rebuilding the tarballs, then `npm ci`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(root, "package.json");
const PACKAGES = ["sidwave", "6502-toolkit"];
/** Ignored by git; relative to the repository root. */
const VENDOR_DIR = "vendor/sidwave-tarballs";

/**
 * Overrides for a scratch project that installs the packed c64bridge: a relative file: dependency does not resolve
 * from the installed copy, so it is pointed at the tarball in this checkout. Empty for registry versions.
 */
export function consumerOverrides(pkg = readPackage()) {
  return Object.fromEntries(PACKAGES
    .map((name) => [name, String(pkg.dependencies?.[name] ?? "")])
    .filter(([, spec]) => spec.startsWith("file:"))
    .map(([name, spec]) => [name, `file:${path.resolve(root, spec.slice(5))}`]));
}

const args = process.argv.slice(2);
const mode = args[0];
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

function fail(message) {
  console.error(`sidwave-dependency: ${message}`);
  process.exit(1);
}

function readPackage() {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

function writePackage(pkg) {
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** Finds <name>-<version>.tgz in dir; fails when it is missing or ambiguous. */
function findTarball(dir, name) {
  const matches = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((file) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+\\.\\d+\\.\\d+.*\\.tgz$`).test(file))
    : [];
  if (matches.length === 0) fail(`no ${name}-<version>.tgz in ${dir}; run npm pack in the ${name} workspace of the sidwave repository`);
  if (matches.length > 1) fail(`several ${name} tarballs in ${dir}: ${matches.join(", ")}; keep one`);
  return path.join(dir, matches[0]);
}

/**
 * Removes the two packages from package-lock.json. npm keeps the recorded integrity of a file: dependency whose path and
 * version are unchanged, so a rebuilt tarball would otherwise fail to install with EINTEGRITY.
 */
function dropLockEntries() {
  const lockPath = path.join(root, "package-lock.json");
  if (!fs.existsSync(lockPath)) return;
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  for (const key of Object.keys(lock.packages ?? {})) {
    if (PACKAGES.some((name) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))) delete lock.packages[key];
  }
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function refreshLocks() {
  if (args.includes("--no-install")) return;
  dropLockEntries();
  const npm = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
  if (npm.status !== 0) fail("npm install --package-lock-only failed");
  const bun = spawnSync("bun", ["install", "--lockfile-only"], { cwd: root, stdio: "inherit" });
  if (bun.error) console.warn("sidwave-dependency: bun not found; bun.lock was not refreshed");
  else if (bun.status !== 0) fail("bun install --lockfile-only failed");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (mode === "tarballs") {
    const dir = path.resolve(option("--dir") ?? path.join(os.homedir(), ".c64bridge", "sidwave-standalone", "tarballs"));
    const pkg = readPackage();
    pkg.dependencies ??= {};
    const sources = PACKAGES.map((name) => [name, findTarball(dir, name)]);
    fs.rmSync(path.join(root, VENDOR_DIR), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, VENDOR_DIR), { recursive: true });
    for (const [name, source] of sources) {
      const target = `${VENDOR_DIR}/${path.basename(source)}`;
      fs.copyFileSync(source, path.join(root, target));
      pkg.dependencies[name] = `file:${target}`;
    }
    pkg.overrides = { ...pkg.overrides, "6502-toolkit": "$6502-toolkit" };
    pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => (a < b ? -1 : 1)));
    writePackage(pkg);
    refreshLocks();
  } else if (mode === "registry") {
    const versions = { sidwave: option("--sidwave"), "6502-toolkit": option("--toolkit") };
    for (const [name, version] of Object.entries(versions)) {
      if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`pass an exact version for ${name}, for example ${name === "sidwave" ? "--sidwave" : "--toolkit"} 1.0.0`);
    }
    const pkg = readPackage();
    pkg.dependencies ??= {};
    for (const name of PACKAGES) pkg.dependencies[name] = `^${versions[name]}`;
    if (pkg.overrides) {
      delete pkg.overrides["6502-toolkit"];
      if (Object.keys(pkg.overrides).length === 0) delete pkg.overrides;
    }
    pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => (a < b ? -1 : 1)));
    writePackage(pkg);
    refreshLocks();
  } else if (mode === "check") {
    const pkg = readPackage();
    const offenders = PACKAGES.filter((name) => String(pkg.dependencies?.[name] ?? "").startsWith("file:"));
    if (offenders.length) fail(`${offenders.join(", ")} still use file: tarballs; run: node scripts/sidwave-dependency.mjs registry --sidwave <x.y.z> --toolkit <x.y.z>`);
    console.log("sidwave-dependency: both dependencies use registry versions");
  } else {
    fail("usage: sidwave-dependency.mjs tarballs [--dir <dir>] | registry --sidwave <x.y.z> --toolkit <x.y.z> | check");
  }
}
