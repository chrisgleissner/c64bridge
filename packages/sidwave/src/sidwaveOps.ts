import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseSidwave, SidwaveValidationError, type ParsedSidwave } from "./sidwave.js";
import { compileSidwaveToPrg, compileSidwaveToSid, type CompileResult } from "./sidwaveCompiler.js";
import { SIDWAVE_SCORE_RESOURCES, readSidwaveExample } from "./sidwaveExamples.js";
import { formatFinding, isInfoCode, type SidwaveFinding } from "./sidwaveLint.js";
import type { SidwaveFileReader, SidwaveReadOptions } from "./sidwavePcm.js";

/**
 * Whole-score operations behind the `sidwave` command line. The command line only translates arguments and
 * output; everything it does is one of these functions.
 */

export type SidwaveOutputFormat = "prg" | "sid";

/**
 * A reader for `file:` sample sources that serves only files below `root` or one of `allowedDirs`.
 * Symbolic links are resolved first, so a link that points outside is refused.
 */
export function confinedFileReader(root: string, allowedDirs: readonly string[] = []): SidwaveFileReader {
  const roots = [root, ...allowedDirs].map((dir) => realpathSync(resolve(dir)));
  return (file) => {
    const target = realpathSync(resolve(root, file));
    if (!roots.some((dir) => isInside(dir, target))) {
      throw new Error(`${file} is outside the allowed directories (${roots.join(", ")}); pass --allow-dir to permit it`);
    }
    return readFileSync(target);
  };
}

function isInside(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function confinedReadOptions(root: string, allowedDirs: readonly string[] = []): SidwaveReadOptions {
  return { readFile: confinedFileReader(root, allowedDirs) };
}

export interface ScoreDescription {
  version: string;
  title: string;
  mode: string;
  voices: number;
  sids: number;
}

export function describeSidwave(doc: ParsedSidwave): ScoreDescription {
  return { version: doc.version, title: doc.song.title, mode: doc.song.mode, voices: doc.voices.length, sids: doc.sids.length };
}

/** The path and message of a validation failure, or undefined for any other error. */
export function validationFailure(error: unknown): { path: string; message: string } | undefined {
  return error instanceof SidwaveValidationError ? { path: error.path, message: error.message } : undefined;
}

export interface CompileSummary {
  format: SidwaveOutputFormat;
  /** Size of the output file in bytes. */
  outputBytes: number;
  /** Size of the PRG the player and streams are compiled into (the PSID body). */
  prgBytes: number;
  /** Total bytes of the per-voice command streams. */
  streamBytes: number;
  loadAddress: number;
  entryAddress: number;
  initAddress: number;
  playAddress: number;
  endAddress: number;
  sidCount: number;
  durationSeconds: number;
  totalFrames: number;
  framesPerSecond: number;
  loop: boolean;
  worstCaseCyclesPerCall: number;
  lintFindings: number;
  warnings: string[];
}

export interface CompiledScore {
  bytes: Buffer;
  summary: CompileSummary;
  result: CompileResult;
}

export function compileSidwaveBytes(doc: ParsedSidwave, options: { format?: SidwaveOutputFormat; loop?: boolean } = {}): CompiledScore {
  const format = options.format ?? "prg";
  const result = compileSidwaveToPrg(doc, options.loop === undefined ? {} : { loop: options.loop });
  const bytes = format === "sid" ? compileSidwaveToSid(doc, result.prg).sid : result.prg;
  const summary: CompileSummary = {
    format,
    outputBytes: bytes.length,
    prgBytes: result.prg.length,
    streamBytes: result.streamBytes.reduce((sum, n) => sum + n, 0),
    loadAddress: result.loadAddress,
    entryAddress: result.entryAddress,
    initAddress: result.initAddress,
    playAddress: result.playAddress,
    endAddress: result.endAddress,
    sidCount: doc.sids.length,
    durationSeconds: result.durationSeconds,
    totalFrames: result.totalFrames,
    framesPerSecond: result.framesPerSecond,
    loop: options.loop ?? true,
    worstCaseCyclesPerCall: result.worstCaseCyclesPerCall,
    lintFindings: (result.lint ?? []).length,
    warnings: result.warnings,
  };
  return { bytes, summary, result };
}

export interface LintReport {
  findings: SidwaveFinding[];
  /** Findings that are not informational notes. */
  actionable: number;
  formatted: string[];
}

export function lintSidwave(doc: ParsedSidwave, options: { loop?: boolean } = {}): LintReport {
  const result = compileSidwaveToPrg(doc, options.loop === undefined ? {} : { loop: options.loop });
  const findings = result.lint ?? [];
  return { findings, actionable: findings.filter((f) => !isInfoCode(f.code)).length, formatted: findings.map(formatFinding) };
}

export interface ExampleInfo { name: string; title: string; style: string }

export function listSidwaveExamples(): ExampleInfo[] {
  return SIDWAVE_SCORE_RESOURCES.map(({ name, title, style }) => ({ name, title, style }));
}

export function isExampleName(name: string): name is (typeof SIDWAVE_SCORE_RESOURCES)[number]["name"] {
  return SIDWAVE_SCORE_RESOURCES.some((example) => example.name === name);
}

export function readExampleScore(name: string): string {
  if (!isExampleName(name)) throw new Error(`unknown example "${name}"`);
  return readSidwaveExample(name);
}
