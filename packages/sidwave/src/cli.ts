import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseSidwave } from "./sidwave.js";
import {
  compileSidwaveBytes, confinedReadOptions, describeSidwave, isExampleName, lintSidwave, listSidwaveExamples,
  readExampleScore, validationFailure, type SidwaveOutputFormat,
} from "./sidwaveOps.js";

/** Exit codes: 0 success, 1 invalid input or failed verdict, 2 operational or usage error. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export interface CliIo {
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  outBytes(bytes: Uint8Array): void;
}

export const HELP = `sidwave: compile SIDWAVE scores to C64 programs and SID files

Usage:
  sidwave validate <file> [--json] [--allow-dir <dir>]
  sidwave compile  <file> [-o <out>] [--format prg|sid] [--loop|--no-loop] [--json] [--allow-dir <dir>]
  sidwave lint     <file> [--loop|--no-loop] [--strict] [--json] [--allow-dir <dir>]
  sidwave examples [<name>] [-o <dir>] [--force] [--json]
  sidwave --help | --version

Commands:
  validate   Parse a score. Exit 0 when it is valid, 1 with the path of the first error otherwise.
  compile    Write a PRG (default) or PSID file. The output defaults to the input name with .prg or .sid in the
             current directory; "-o -" writes the bytes to standard output. With --format omitted, a -o name
             ending in .sid selects PSID. --json prints the format, sizes, addresses, SID count and duration.
  lint       Print the lint findings. Exit 0 unless the score is invalid; with --strict, exit 1 when there is a
             finding that is not an informational note.
  examples   Without a name, list the bundled example scores. With a name, print the score, or write
             <name>.yaml into the directory given by -o (it is not overwritten without --force).

Options:
  --allow-dir <dir>   Allow "file:" sample sources below <dir>. Without it they must lie below the current
                      directory. May be repeated. The sidwave command never uses the network.
  --json              Machine-readable output on standard output.
  -h, --help          Show this text.
  -V, --version       Show the package version.

Exit codes: 0 success, 1 invalid input or failed verdict, 2 operational or usage error.
`;

interface Options {
  positional: string[];
  output?: string;
  format?: string;
  loop?: boolean;
  json: boolean;
  strict: boolean;
  force: boolean;
  help: boolean;
  version: boolean;
  allowDirs: string[];
}

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["-o", "--output", "--format", "--allow-dir"]);

function parseArgs(args: string[]): Options {
  const options: Options = { positional: [], json: false, strict: false, force: false, help: false, version: false, allowDirs: [] };
  for (let i = 0; i < args.length; i++) {
    let arg = args[i]!;
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      inline = arg.slice(arg.indexOf("=") + 1);
      arg = arg.slice(0, arg.indexOf("="));
    }
    if (arg === "--") { options.positional.push(...args.slice(i + 1)); break; }
    if (VALUE_FLAGS.has(arg)) {
      const value = inline ?? args[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      if (arg === "--format") options.format = value;
      else if (arg === "--allow-dir") options.allowDirs.push(value);
      else options.output = value;
    } else if (inline !== undefined) throw new UsageError(`${arg} does not take a value`);
    else if (arg === "--loop") options.loop = true;
    else if (arg === "--no-loop") options.loop = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-V" || arg === "--version") options.version = true;
    else if (arg !== "-" && arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return manifest.version;
}

function pickFile(options: Options, command: string): string {
  if (options.positional.length !== 1) throw new UsageError(`${command} needs exactly one score file`);
  return options.positional[0]!;
}

function rejectOptions(options: Options, command: string, unsupported: Array<[keyof Options, string]>): void {
  for (const [key, flag] of unsupported) {
    const value = options[key];
    if (value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0)) {
      throw new UsageError(`${flag} does not apply to ${command}`);
    }
  }
}

function readScore(io: CliIo, file: string): { text: string; path: string } {
  const path = resolve(io.cwd, file);
  try {
    return { text: readFileSync(path, "utf8"), path };
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
}

function emit(io: CliIo, options: Options, value: unknown, text: string): void {
  io.out(options.json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

/** Reports invalid input. Returns EXIT_FAILED for a score error and rethrows anything else. */
function invalid(io: CliIo, options: Options, file: string, error: unknown): number {
  const failure = validationFailure(error);
  if (!failure) throw error;
  if (options.json) io.out(`${JSON.stringify({ ok: false, file, error: failure }, null, 2)}\n`);
  else io.err(`${file}: ${failure.message}\n`);
  return EXIT_FAILED;
}

function validate(io: CliIo, options: Options): number {
  rejectOptions(options, "validate", [["output", "-o"], ["format", "--format"], ["loop", "--loop/--no-loop"], ["strict", "--strict"], ["force", "--force"]]);
  const file = pickFile(options, "validate");
  const { text } = readScore(io, file);
  try {
    const description = describeSidwave(parseSidwave(text, confinedReadOptions(io.cwd, options.allowDirs)));
    emit(io, options, { ok: true, file, ...description }, `${file}: valid SIDWAVE ${description.version}, ${description.voices} voices, ${description.sids} SID${description.sids === 1 ? "" : "s"}`);
    return EXIT_OK;
  } catch (error) {
    return invalid(io, options, file, error);
  }
}

function pickFormat(options: Options): SidwaveOutputFormat {
  if (options.format !== undefined) {
    if (options.format !== "prg" && options.format !== "sid") throw new UsageError(`--format must be prg or sid, not ${options.format}`);
    return options.format;
  }
  return options.output !== undefined && extname(options.output).toLowerCase() === ".sid" ? "sid" : "prg";
}

function sameFile(a: string, b: string): boolean {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  return real(a) === real(b);
}

function compile(io: CliIo, options: Options): number {
  rejectOptions(options, "compile", [["strict", "--strict"], ["force", "--force"]]);
  const file = pickFile(options, "compile");
  const format = pickFormat(options);
  const { text, path } = readScore(io, file);
  const toStdout = options.output === "-";
  const stem = basename(file, extname(file)).replace(/\.sidwave$/i, "");
  const outPath = toStdout ? undefined : resolve(io.cwd, options.output ?? `${stem}.${format}`);
  if (outPath !== undefined && sameFile(outPath, path)) throw new UsageError("the output file is the input file; refusing to overwrite it");
  let compiled;
  try {
    compiled = compileSidwaveBytes(parseSidwave(text, confinedReadOptions(io.cwd, options.allowDirs)), { format, ...(options.loop === undefined ? {} : { loop: options.loop }) });
  } catch (error) {
    return invalid(io, options, file, error);
  }
  const { summary, bytes } = compiled;
  if (outPath === undefined) io.outBytes(bytes);
  else {
    try {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, bytes);
    } catch (error) {
      throw new UsageError(`cannot write ${outPath}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
  }
  const where = outPath ?? "standard output";
  const line = `${where}: ${summary.format.toUpperCase()} ${summary.outputBytes} bytes, ${summary.durationSeconds.toFixed(1)} s, ${summary.sidCount} SID${summary.sidCount === 1 ? "" : "s"}`;
  const report = options.json ? `${JSON.stringify({ ok: true, file, output: outPath ?? null, ...summary }, null, 2)}\n` : `${line}\n`;
  // With bytes on standard output the summary goes to standard error so the two never mix.
  if (toStdout) io.err(report); else io.out(report);
  for (const warning of summary.warnings) io.err(`warning: ${warning}\n`);
  return EXIT_OK;
}

function lint(io: CliIo, options: Options): number {
  rejectOptions(options, "lint", [["output", "-o"], ["format", "--format"], ["force", "--force"]]);
  const file = pickFile(options, "lint");
  const { text } = readScore(io, file);
  try {
    const report = lintSidwave(parseSidwave(text, confinedReadOptions(io.cwd, options.allowDirs)), options.loop === undefined ? {} : { loop: options.loop });
    const failed = options.strict && report.actionable > 0;
    emit(io, options, { ok: !failed, file, findings: report.findings, actionable: report.actionable },
      report.findings.length === 0 ? `${file}: no lint findings` : report.formatted.map((line) => `${file}: ${line}`).join("\n"));
    return failed ? EXIT_FAILED : EXIT_OK;
  } catch (error) {
    return invalid(io, options, file, error);
  }
}

function examples(io: CliIo, options: Options): number {
  rejectOptions(options, "examples", [["format", "--format"], ["loop", "--loop/--no-loop"], ["strict", "--strict"], ["allowDirs", "--allow-dir"]]);
  if (options.positional.length > 1) throw new UsageError("examples takes at most one name");
  const name = options.positional[0];
  if (name === undefined) {
    rejectOptions(options, "examples without a name", [["output", "-o"], ["force", "--force"]]);
    const list = listSidwaveExamples();
    emit(io, options, list, list.map((e) => `${e.name.padEnd(18)} ${e.title}: ${e.style}`).join("\n"));
    return EXIT_OK;
  }
  if (!isExampleName(name)) throw new UsageError(`unknown example "${name}"; run "sidwave examples" for the list`);
  const score = readExampleScore(name);
  if (options.output === undefined) {
    io.out(score);
    return EXIT_OK;
  }
  const target = join(resolve(io.cwd, options.output), `${name}.yaml`);
  if (existsSync(target) && !options.force) throw new UsageError(`${target} exists; use --force to overwrite it`);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, score);
  } catch (error) {
    throw new UsageError(`cannot write ${target}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  emit(io, options, { ok: true, name, output: target, bytes: Buffer.byteLength(score) }, `wrote ${target}`);
  return EXIT_OK;
}

const COMMANDS: Record<string, (io: CliIo, options: Options) => number> = { validate, compile, lint, examples };

/** Runs the command line. `args` excludes the node binary and script path. */
export function runCli(args: string[], io: CliIo): number {
  try {
    const [first, ...rest] = args;
    if (first === undefined) { io.err(HELP); return EXIT_USAGE; }
    if (first === "-h" || first === "--help" || first === "help") { io.out(HELP); return EXIT_OK; }
    if (first === "-V" || first === "--version") { io.out(`${packageVersion()}\n`); return EXIT_OK; }
    const command = Object.prototype.hasOwnProperty.call(COMMANDS, first) ? COMMANDS[first] : undefined;
    if (!command) throw new UsageError(`unknown command "${first}"`);
    const options = parseArgs(rest);
    if (options.help) { io.out(HELP); return EXIT_OK; }
    if (options.version) { io.out(`${packageVersion()}\n`); return EXIT_OK; }
    return command(io, options);
  } catch (error) {
    if (error instanceof UsageError) io.err(`sidwave: ${error.message}\nRun "sidwave --help" for usage.\n`);
    else io.err(`sidwave: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }
}
