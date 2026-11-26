#!/usr/bin/env node
import { runCli } from "./cli.js";

process.exitCode = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => { process.stdout.write(text); },
  err: (text) => { process.stderr.write(text); },
  outBytes: (bytes) => { process.stdout.write(bytes); },
});
