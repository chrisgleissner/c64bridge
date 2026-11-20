#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function resolveBunExecutable() {
  const candidates = [
    process.env.BUN_BIN,
    process.env.C64BRIDGE_TEST_BUN_BIN,
    process.env.C64BRIDGE_BUN_BIN,
    process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, "bin", "bun") : null,
    path.join(os.homedir(), ".bun", "bin", "bun"),
    "bun",
  ];

  for (const candidate of candidates) {
    if (!candidate || !candidate.trim()) {
      continue;
    }

    if (candidate === "bun") {
      return "bun";
    }

    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return "bun";
}

const BUN_SUBCOMMANDS = new Set([
  "test",
  "run",
  "x",
  "install",
  "add",
  "remove",
  "update",
  "pm",
  "build",
  "create",
  "exec",
  "repl",
  "help",
]);

function looksLikeScriptPath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("-")
    && /\.(?:[cm]?[jt]s|tsx?)$/i.test(value);
}

export function buildBunArgs(args) {
  const [firstArg, ...rest] = args;
  if (!firstArg) {
    return [];
  }

  if (BUN_SUBCOMMANDS.has(firstArg) || !looksLikeScriptPath(firstArg)) {
    return args;
  }

  return ["run", firstArg, ...rest];
}

function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return fileURLToPath(moduleUrl) === path.resolve(entry);
}

if (isMainModule(import.meta.url)) {
  if (process.argv.length < 3) {
    console.error("Usage: node scripts/invoke-bun.mjs <command> [args...]");
    process.exit(1);
  }

  const rawArgs = process.argv.slice(2);
  const bunExecutable = resolveBunExecutable();
  const child = spawn(bunExecutable, buildBunArgs(rawArgs), {
    stdio: "inherit",
    env: {
      ...process.env,
    },
  });

  const forwarders = new Map();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const forward = () => {
      try {
        child.kill(signal);
      } catch {}
    };
    forwarders.set(signal, forward);
    process.on(signal, forward);
  }
  const removeForwarders = () => {
    for (const [signal, forward] of forwarders) {
      process.removeListener(signal, forward);
    }
  };

  child.on("error", (error) => {
    removeForwarders();
    console.error(`[invoke-bun] Unable to start Bun: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    removeForwarders();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
