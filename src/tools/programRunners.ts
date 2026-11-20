import fs from "node:fs";
import { readHostFile, resolveHostPath } from "../hostPaths.js";
import { assemblyToPrgDetailed, AssemblyError } from "./translation/assembler.js";
import { basicToPrg } from "./translation/basicTokenizer.js";
import {
  defineToolModule,
  OPERATION_DISCRIMINATOR,
  type OperationHandlerMap,
  type OperationMap,
  type ToolExecutionContext,
  type ToolRunResult,
} from "./types.js";
import { booleanSchema, objectSchema, optionalSchema, stringSchema } from "./schema.js";
import { textResult } from "./responses.js";
import {
  ToolExecutionError,
  ToolError,
  ToolValidationError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";
import { checkAsmProgramLoaded, pollForProgramOutcome, type AsmPollResult, type BasicPollResult } from "./pollValidator.js";
import { clearViceSymbols, setViceSymbols, parseSymbolFile, SYMBOL_FILE_FORMATS } from "./translation/symbolRegistry.js";

function extractFailureDetails(details: unknown): Record<string, unknown> | undefined {
  if (details === undefined || details === null) {
    return undefined;
  }
  if (typeof details === "object") {
    return details as Record<string, unknown>;
  }
  return { value: details };
}

function toRecord(details: unknown): Record<string, unknown> | undefined {
  if (details === undefined || details === null) {
    return undefined;
  }
  if (typeof details === "object") {
    return details as Record<string, unknown>;
  }
  return { value: details };
}

const BASIC_MAX_LINE = 63999;

const prgPathDescription = "Path to the PRG file: Ultimate path such as //USB0/demo.prg on c64u/u2 (or a host path with location host); host path on VICE.";
const crtPathDescription = "Path to the CRT image on Ultimate-visible storage (c64u and u2; not VICE).";

type OperationlessArgs<T extends Record<string, unknown>> = Omit<T, typeof OPERATION_DISCRIMINATOR>;

function stripOperationDiscriminator<T extends Record<string, unknown>>(
  value: T,
): OperationlessArgs<T> {
  const { [OPERATION_DISCRIMINATOR]: _ignored, ...rest } = value;
  return rest as OperationlessArgs<T>;
}

export interface ProgramOperationMap extends OperationMap {
  readonly load_prg: {
    readonly path: string;
  };
  readonly run_prg: {
    readonly path: string;
  };
  readonly run_crt: {
    readonly path: string;
  };
  readonly upload_run_basic: {
    readonly program: string;
    readonly verify?: boolean;
  };
  readonly upload_run_asm: {
    readonly program: string;
    readonly verify?: boolean;
  };
}

type BasicRuntimeError = {
  readonly line: number;
  readonly type?: string;
  readonly raw: string;
};

type BasicAutoFixChange = {
  readonly line: number;
  readonly notes: readonly string[];
  /** The program line as submitted and as rewritten. */
  readonly before: string;
  readonly after: string;
};

type BasicAutoFixResult = {
  readonly program: string;
  readonly changes: readonly BasicAutoFixChange[];
};

type StructuredRuntimeError = {
  readonly line: number;
  readonly type?: string;
  readonly text: string;
};

function parseBasicRuntimeErrors(screen: string): readonly BasicRuntimeError[] {
  const errors: BasicRuntimeError[] = [];
  const seen = new Set<number>();
  const rows = screen.replace(/\r\n?/g, "\n").split("\n");

  for (const row of rows) {
    if (!row || !row.toUpperCase().includes("ERROR IN")) {
      continue;
    }

    const match = /ERROR\s+IN\s+(\d{1,5})/i.exec(row);
    if (!match) {
      continue;
    }

    const lineNumber = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > BASIC_MAX_LINE) {
      continue;
    }
    if (seen.has(lineNumber)) {
      continue;
    }
    seen.add(lineNumber);

    // The apostrophe covers UNDEF'D STATEMENT, REDIM'D ARRAY and UNDEF'D FUNCTION.
    const typeMatch = /\?([A-Z' ?]+?)\s+ERROR\s+IN/i.exec(row.toUpperCase());
    const type = typeMatch?.[1]?.trim().replace(/\s+/g, " ") || undefined;

    errors.push({
      line: lineNumber,
      type,
      raw: row.trim(),
    });
  }

  return errors;
}

function attemptAutoFixBasicProgram(
  program: string,
  errors: readonly BasicRuntimeError[],
): BasicAutoFixResult | undefined {
  if (errors.length === 0) {
    return undefined;
  }

  const normalized = program.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const indexByLine = new Map<number, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine) {
      continue;
    }
    const match = /^\s*(\d+)\s*(.*)$/u.exec(rawLine);
    if (!match) {
      continue;
    }
    const lineNumber = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(lineNumber)) {
      continue;
    }
    if (!indexByLine.has(lineNumber)) {
      indexByLine.set(lineNumber, index);
    }
  }

  const changes: BasicAutoFixChange[] = [];

  for (const error of errors) {
    const index = indexByLine.get(error.line);
    if (index === undefined) {
      continue;
    }

    const rawLine = lines[index] ?? "";
    const match = /^\s*(\d+)\s*(.*)$/u.exec(rawLine);
    if (!match) {
      continue;
    }

    const lineNumber = Number.parseInt(match[1] ?? "", 10);
    let content = match[2] ?? "";
    const notes: string[] = [];

    const quoteAdjusted = content.replace(/""/g, "");
    const quoteCount = (quoteAdjusted.match(/"/g) ?? []).length;
    if (quoteCount % 2 !== 0) {
      content = `${content}"`;
      notes.push('appended missing closing quote (")');
    }

    const sanitized = stripRemarks(stripStrings(content));
    const openParens = (sanitized.match(/\(/g) ?? []).length;
    const closeParens = (sanitized.match(/\)/g) ?? []).length;
    if (openParens > closeParens) {
      const deficit = openParens - closeParens;
      content = `${content}${")".repeat(deficit)}`;
      notes.push(`appended ${deficit} closing parenthesis${deficit > 1 ? "es" : ""}`);
    }

    if (notes.length > 0) {
      const updated = content.length > 0 ? `${lineNumber} ${content}` : `${lineNumber}`;
      const before = rawLine.trim();
      lines[index] = updated;
      changes.push({
        line: lineNumber,
        notes,
        before,
        after: updated,
      });
    }
  }

  if (changes.length === 0) {
    return undefined;
  }

  return {
    program: lines.join("\n"),
    changes,
  };
}

function stripStrings(content: string): string {
  let result = "";
  let inString = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (char === '"') {
      if (inString && content[index + 1] === '"') {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }

    if (!inString) {
      result += char;
    }
  }

  return result;
}

function stripRemarks(content: string): string {
  const upper = content.toUpperCase();
  const remIndex = upper.search(/(^|:)\s*REM\b/);
  if (remIndex >= 0) {
    return content.slice(0, remIndex);
  }
  return content;
}

function normalizeRuntimeErrors(errors: readonly BasicRuntimeError[]): readonly StructuredRuntimeError[] {
  return errors.map((error) => ({
    line: error.line,
    ...(error.type ? { type: error.type } : {}),
    text: error.raw,
  }));
}

export const __programRunnerHelpersForTests = {
  extractFailureDetails,
  toRecord,
  stripOperationDiscriminator,
  parseBasicRuntimeErrors,
  attemptAutoFixBasicProgram,
  normalizeRuntimeErrors,
};

function structuredExecutionError(
  message: string,
  data: Record<string, unknown>,
): ToolRunResult {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    metadata: {
      error: {
        kind: "execution",
        details: data,
      },
    },
    structuredContent: {
      type: "json",
      data,
    },
    isError: true,
  };
}

const uploadBasicArgsSchema = objectSchema({
  description: "Arguments for uploading and running a BASIC program.",
  properties: {
    program: stringSchema({
      description: "Commodore BASIC v2 program source to upload and run.",
      minLength: 1,
    }),
    verify: booleanSchema({
      description: "Poll the screen until the program ends, shows a BASIC error (reported with its line) or the poll window (C64BRIDGE_POLL_MAX_MS, default 2 s) ends. Without verify nothing is observed.",
      default: false,
    }),
    autoFix: optionalSchema(booleanSchema({
      description: "With verify:true, on a BASIC error append a missing closing quote or parenthesis to the failing line and run again (default true; rewritten lines are reported). Set false for programs with side effects.",
      default: true,
    })),
  },
  required: ["program"],
  additionalProperties: false,
});

const uploadAsmArgsSchema = objectSchema({
  description: "Arguments for uploading and running a 6502/6510 assembly program.",
  properties: {
    program: stringSchema({
      description: "Assembly source that will be assembled to a PRG and executed.",
      minLength: 1,
    }),
    verify: booleanSchema({
      description: "Poll the screen for evidence of execution (up to C64BRIDGE_POLL_MAX_MS, default 2 s); a program that changes nothing on screen and does not return to BASIC is an error. Without verify nothing is polled and execution is reported as \"unconfirmed\". The bytes at the load address must match the assembled program either way.",
      default: false,
    }),
  },
  required: ["program"],
  additionalProperties: false,
});

const prgFileArgsSchema = objectSchema({
  description: "Arguments for loading or running a PRG file.",
  properties: {
    path: stringSchema({
      description: prgPathDescription,
      minLength: 1,
    }),
    location: optionalSchema(stringSchema({
      description: "auto (default): Ultimate device path on c64u/u2, host path on VICE. host: read the file from the host and upload it (Ultimate). device: Ultimate path only.",
      enum: ["auto", "host", "device"],
    })),
    symbolsFile: optionalSchema(stringSchema({
      description: "Label file (VICE .vs, 64tass, ACME or KickAssembler); labels annotate disassembly and are accepted where c64_memory and c64_debug take an address.",
      minLength: 1,
    })),
  },
  required: ["path"],
  additionalProperties: false,
});

const crtFileArgsSchema = objectSchema({
  description: "Arguments for running a CRT image stored on Ultimate-visible storage.",
  properties: {
    path: stringSchema({
      description: crtPathDescription,
      minLength: 1,
    }),
  },
  required: ["path"],
  additionalProperties: false,
});

async function executeUploadRunBasic(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = uploadBasicArgsSchema.parse(rawArgs ?? {});
    const shouldVerify = parsed.verify === true;
    ctx.logger.info("Uploading BASIC program", {
      sourceLength: parsed.program.length,
      ...(shouldVerify ? { verify: true } : {}),
    });

    const originalProgram = parsed.program;

    // Compute PRG locally to expose structured metadata
    let activeProgram = originalProgram;
    let prg = basicToPrg(activeProgram);
    let entryAddress = prg.readUInt16LE(0);

    const runBasic = async (source: string) => {
      const started = await ctx.client.uploadAndRunBasic(source);
      if (started.success) clearViceSymbols(); // labels belong to one program
      return started;
    };

    const readScreenSafely = async (what: string): Promise<string | undefined> => {
      try {
        return await ctx.client.readScreen();
      } catch (screenError) {
        ctx.logger.warn(`Unable to read screen ${what}`, toRecord(screenError));
        return undefined;
      }
    };

    // Polls the outcome of one run. The screen before the run lets the poll tell a program that
    // cleared the screen from one that never ran.
    const pollRun = (programPrg: Buffer, before: string | undefined) =>
      pollForProgramOutcome("BASIC", ctx.client, ctx.logger, undefined, { address: programPrg.readUInt16LE(0), bytes: programPrg.subarray(2) }, before) as Promise<BasicPollResult>;

    const verifyError = (error: unknown) => {
      ctx.logger.warn("BASIC verification failed", toRecord(error));
      return toolErrorResult(new ToolExecutionError("Failed to verify BASIC program execution", { details: toRecord(error) ?? undefined }));
    };

    if (!shouldVerify) {
      // RUN was only just typed, so the screen would still show the state before the run: it is not read.
      const result = await runBasic(activeProgram);
      if (!result.success) {
        throw new ToolExecutionError("C64 backend reported failure while running BASIC program", {
          details: extractFailureDetails(result.details),
        });
      }
      const addresses = prgAddresses(prg);
      const message = `BASIC program uploaded and started (RUN typed); it occupies ${addresses.load}-${addresses.end}. Its outcome was not observed; pass verify:true to poll the screen for BASIC errors (auto-fix applies there).`;
      const fields = { entryAddress, addresses, prgSize: prg.length };
      const base = textResult(message, { success: true, ...fields, details: result.details ?? null });
      return { ...base, structuredContent: { type: "json", data: { kind: "upload_run_basic" as const, format: "prg" as const, ...fields, resources: ["c64://basic/spec", "c64://guide/bootstrap"] } } };
    }

    const screenBeforeRun = await readScreenSafely("before BASIC execution");
    const result = await runBasic(activeProgram);
    if (!result.success) {
      throw new ToolExecutionError("C64 backend reported failure while running BASIC program", {
        details: extractFailureDetails(result.details),
      });
    }

    let outcome: BasicPollResult;
    try {
      outcome = await pollRun(prg, screenBeforeRun);
    } catch (pollError) {
      return verifyError(pollError);
    }

    const lineErrorOf = (o: BasicPollResult): BasicRuntimeError[] =>
      o.status === "error" && o.line !== undefined
        ? [{ line: o.line, ...(o.message ? { type: o.message } : {}), raw: o.text ?? `?${o.message ?? ""} ERROR IN ${o.line}` }]
        : [];
    const verificationFailed = (o: BasicPollResult) => {
      ctx.logger.warn("BASIC verification detected error", {
        ...(o.message ? { message: o.message } : {}),
        ...(o.line !== undefined ? { line: o.line } : {}),
      });
      return toolErrorResult(
        new ToolExecutionError("BASIC program verification failed", {
          details: {
            ...(o.message ? { message: o.message } : {}),
            ...(o.line !== undefined ? { line: o.line } : {}),
            ...(o.screen ? { screen: o.screen } : {}),
          },
        }),
      );
    };

    let screenOutput = outcome.screen;
    let autoFixInfo:
      | {
          readonly changes: readonly BasicAutoFixChange[];
          readonly originalErrors: readonly BasicRuntimeError[];
        }
      | undefined;

    if (outcome.status === "error") {
      const errors = lineErrorOf(outcome);
      if (errors.length === 0) return verificationFailed(outcome);
      ctx.logger.warn("Detected BASIC runtime errors", { errors: errors.map((error) => ({ line: error.line, type: error.type })) });

      const normalizedErrors = normalizeRuntimeErrors(errors);
      const errorFields = { message: outcome.message, line: outcome.line };
      const fixAttempt = parsed.autoFix === false ? undefined : attemptAutoFixBasicProgram(activeProgram, errors);
      if (!fixAttempt) {
        const data = {
          kind: "basic_runtime_error" as const,
          ...errorFields,
          programSource: originalProgram,
          errors: normalizedErrors,
          ...(screenOutput ? { screen: screenOutput } : {}),
          autoFix: {
            attempted: false,
            ...(parsed.autoFix === false ? { disabled: true } : {}),
          },
        };
        const where = `${errors[0]!.raw}`;
        return structuredExecutionError(
          parsed.autoFix === false
            ? `Detected BASIC runtime errors after execution (${where}). Auto-fix is disabled (autoFix:false), so the program was not rewritten or run again.`
            : `Detected BASIC runtime errors after execution (${where}).`,
          data,
        );
      }

      ctx.logger.info("Attempting BASIC auto-fix", {
        changes: fixAttempt.changes.map((change) => ({ line: change.line, notes: change.notes })),
      });

      const retryBefore = await readScreenSafely("before the BASIC auto-fix run");
      const retryResult = await runBasic(fixAttempt.program);
      if (!retryResult.success) {
        const data = {
          kind: "basic_runtime_error" as const,
          ...errorFields,
          programSource: originalProgram,
          errors: normalizedErrors,
          ...(screenOutput ? { screen: screenOutput } : {}),
          autoFix: {
            attempted: true,
            changes: fixAttempt.changes,
            programSource: fixAttempt.program,
            failure: {
              reason: "firmware_failure",
              details: extractFailureDetails(retryResult.details),
            },
          },
        };
        return structuredExecutionError("Auto-fix failed due to firmware error while re-running BASIC program.", data);
      }

      const retryPrg = basicToPrg(fixAttempt.program);
      let retryOutcome: BasicPollResult;
      try {
        retryOutcome = await pollRun(retryPrg, retryBefore);
      } catch (pollError) {
        return verifyError(pollError);
      }
      const remainingErrors = lineErrorOf(retryOutcome);
      if (remainingErrors.length > 0) {
        const data = {
          kind: "basic_runtime_error" as const,
          ...errorFields,
          programSource: originalProgram,
          errors: normalizedErrors,
          ...(screenOutput ? { screen: screenOutput } : {}),
          autoFix: {
            attempted: true,
            changes: fixAttempt.changes,
            programSource: fixAttempt.program,
            resultingErrors: normalizeRuntimeErrors(remainingErrors),
            ...(retryOutcome.screen ? { screen: retryOutcome.screen } : {}),
          },
        };
        return structuredExecutionError(`BASIC program still reports errors after auto-fix attempt (${remainingErrors[0]!.raw}).`, data);
      }
      if (retryOutcome.status === "error") return verificationFailed(retryOutcome);

      activeProgram = fixAttempt.program;
      prg = retryPrg;
      entryAddress = prg.readUInt16LE(0);
      screenOutput = retryOutcome.screen;
      autoFixInfo = { changes: fixAttempt.changes, originalErrors: errors };
    }

    const changedLines = autoFixInfo
      ? autoFixInfo.changes.map((change) => `line ${change.line}: "${change.before}" -> "${change.after}"`).join("; ")
      : "";
    const message = autoFixInfo
      ? `Detected BASIC errors on execution; applied auto-fix and ran the program a second time (changed lines: ${changedLines}). The second run was verified without a BASIC error.`
      : "BASIC program uploaded and executed successfully (verified).";
    const addresses = prgAddresses(prg);

    const autoFixFields = autoFixInfo
      ? {
          autoFix: {
            applied: true,
            changes: autoFixInfo.changes,
            originalErrors: autoFixInfo.originalErrors,
            programSource: activeProgram,
          },
        }
      : {};
    const metadata = {
      success: true,
      entryAddress,
      addresses,
      prgSize: prg.length,
      details: result.details ?? null,
      ...(screenOutput ? { screen: screenOutput } : {}),
      ...autoFixFields,
      verified: true,
    };

    const data = {
      kind: "upload_run_basic" as const,
      format: "prg" as const,
      entryAddress,
      addresses,
      prgSize: prg.length,
      resources: ["c64://basic/spec", "c64://guide/bootstrap"],
      ...(screenOutput ? { screen: screenOutput } : {}),
      ...autoFixFields,
      verified: true,
    };

    const base = textResult(`${message} Program at ${addresses.load}-${addresses.end}.`, metadata);
    return { ...base, structuredContent: { type: "json", data } };
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return unknownErrorResult(error);
  }
}

async function executeUploadRunAsm(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = uploadAsmArgsSchema.parse(rawArgs ?? {});
    const shouldVerify = parsed.verify === true;
    ctx.logger.info("Uploading assembly program", {
      sourceLength: parsed.program.length,
      ...(shouldVerify ? { verify: true } : {}),
    });

    // Assemble locally to expose structured metadata and capture symbols
    const asmResult = assemblyToPrgDetailed(parsed.program);
    const prg = asmResult.prg;
    const entryAddress = asmResult.entryAddress;

    const loadAddress = prg.length >= 2 ? prg.readUInt16LE(0) : 0;
    const programEnd = loadAddress + Math.max(0, prg.length - 2); // exclusive
    const result = await ctx.client.uploadAndRunAsm(parsed.program, asmResult);
    const keyboardFeed = toRecord(result.details)?.keyboard as { status?: string; pending?: number; stoppedAt?: number } | undefined;
    // A checkpoint that stops the CPU inside the loaded program means SYS reached the program: it
    // started and is held at the checkpoint. A stop anywhere else (BASIC or KERNAL while SYS was
    // typed) means it did not start.
    const stoppedAt = keyboardFeed?.status === "stopped" && typeof keyboardFeed.stoppedAt === "number" ? keyboardFeed.stoppedAt : undefined;
    const stoppedInProgram = stoppedAt !== undefined && stoppedAt >= loadAddress && stoppedAt < programEnd;
    if (!result.success && !stoppedInProgram) {
      return toolErrorResult(
        new ToolExecutionError("C64 backend reported failure while running assembly program", {
          details: extractFailureDetails(result.details),
        }),
      );
    }
    const startQueued = keyboardFeed?.status === "queued";
    if (startQueued && shouldVerify) {
      return toolErrorResult(
        new ToolExecutionError(
          "Assembly program was loaded, but the SYS command is only queued (the CPU is paused), so it has not started and its execution could not be verified",
          { details: { keyboard: keyboardFeed, started: false } },
        ),
      );
    }
    // Replace the registered symbols only once the program has started, so a
    // failed run keeps the previous table.
    setViceSymbols(asmResult.symbols.entries());
    const symbolEntries = [...asmResult.symbols.entries()].sort((a, b) => a[1] - b[1]);
    const symbolsTruncated = symbolEntries.length > 256;
    // fromEntries defines own properties, so a label named __proto__ is kept like any other.
    const symbolList: Record<string, string> = Object.fromEntries(
      symbolEntries.slice(0, 256).map(([name, address]) => [name, `$${address.toString(16).toUpperCase().padStart(4, "0")}`]),
    );
    const symbolFields = symbolEntries.length > 0
      ? { symbols: symbolList, ...(symbolsTruncated ? { symbolsTruncated: true } : {}) }
      : {};

    // Read back the program bytes (load evidence). Only verify:true polls for signs of execution.
    let verified = false;
    let execution: "confirmed" | "unconfirmed" | undefined;
    let loadCheck: string | undefined;
    const expected = { address: loadAddress, bytes: prg.subarray(2) };
    if (stoppedInProgram) {
      // The CPU is held at a checkpoint inside the program: that is evidence of execution, and
      // polling the screen of a stopped machine would only wait.
      execution = "confirmed";
      verified = shouldVerify;
    } else try {
      const outcome: { status: string; reason?: string; loadCheck?: string; load?: { address: number; expected: string; found: string } } = shouldVerify
        ? await pollForProgramOutcome("ASM", ctx.client, ctx.logger, undefined, expected) as AsmPollResult
        : await (async () => {
            const check = await checkAsmProgramLoaded(ctx.client, ctx.logger, expected);
            return check.load
              ? { status: "not_loaded", reason: `memory at $${check.load.address.toString(16).toUpperCase().padStart(4, "0")} does not contain the assembled program`, ...check }
              : { status: "not_observed", ...check };
          })();
      loadCheck = outcome.loadCheck;
      if (outcome.status === "not_loaded") {
        ctx.logger.warn("ASM program was not loaded", { reason: outcome.reason });
        return toolErrorResult(
          new ToolExecutionError(
            `Assembly program was not loaded: ${outcome.reason}. The backend reported success, but the bytes read back at the load address differ from the assembled program (a program that overwrites its own first bytes also looks like this).`,
            { details: { reason: outcome.reason, ...(outcome.load ? { loadAddress: outcome.load.address, expected: outcome.load.expected, found: outcome.load.found } : {}) } },
          ),
        );
      }
      if (outcome.status === "unconfirmed") {
        ctx.logger.warn("ASM execution could not be verified", { reason: outcome.reason });
        return toolErrorResult(
          new ToolExecutionError(
            "Assembly program was loaded, but no screen change was observed, so its execution could not be verified",
            { details: { reason: outcome.reason, loadCheck: outcome.loadCheck, execution: "unconfirmed" } },
          ),
        );
      }
      if (outcome.status === "not_observed") {
        execution = "unconfirmed";
      } else {
        execution = "confirmed";
        verified = true;
      }
    } catch (pollError) {
      ctx.logger.debug("Polling encountered an error", toRecord(pollError));
      if (shouldVerify) {
        return toolErrorResult(
          new ToolExecutionError("Failed to verify assembly program execution", {
            details: toRecord(pollError) ?? undefined,
          }),
        );
      }
    }

    const fmt = (value: number) => `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
    const stopLabel = stoppedInProgram ? symbolEntries.find(([, address]) => address === stoppedAt)?.[0] : undefined;
    const addresses = prgAddresses(prg, entryAddress);
    const where = ` Program at ${addresses.load}-${addresses.end}, entry ${addresses.entry} (SYS ${entryAddress}).`;
    const stopFields = stoppedInProgram ? { stopped: true, stoppedAt: fmt(stoppedAt!), ...(stopLabel ? { stoppedAtLabel: stopLabel } : {}) } : {};
    const data = {
      kind: "upload_run_asm" as const,
      format: "prg" as const,
      entryAddress,
      addresses,
      prgSize: prg.length,
      resources: ["c64://assembly/6510-spec", "c64://guide/bootstrap"],
      ...(loadCheck ? { loadCheck } : {}),
      ...(execution ? { execution } : {}),
      ...(keyboardFeed ? { keyboard: keyboardFeed } : {}),
      ...(shouldVerify && verified ? { verified: true } : {}),
      ...stopFields,
      ...symbolFields,
    };
    const message = stoppedInProgram
      ? `Assembly program assembled, uploaded and started; a checkpoint stopped the CPU at ${fmt(stoppedAt!)}${stopLabel ? ` (${stopLabel})` : ""} inside the program. Use c64_debug to inspect, step or continue.`
      : startQueued
      ? `Assembly program assembled, uploaded and loaded. The SYS command is queued (${keyboardFeed?.pending ?? "?"} character(s) pending) because the CPU is paused; the program starts when the machine resumes.`
      : execution === "unconfirmed"
      ? "Assembly program assembled, uploaded and loaded, and the SYS command was typed. Execution was not observed (verify:false does not poll); pass verify:true to poll the screen for evidence."
      : "Assembly program assembled, uploaded, and executed successfully (verified).";
    const base = textResult(message + where, {
      success: true,
      entryAddress,
      addresses,
      prgSize: prg.length,
      details: result.details ?? null,
      ...(loadCheck ? { loadCheck } : {}),
      ...(execution ? { execution } : {}),
      ...(keyboardFeed ? { keyboard: keyboardFeed } : {}),
      ...(shouldVerify && verified ? { verified: true } : {}),
      ...stopFields,
      ...symbolFields,
    });
    return { ...base, structuredContent: { type: "json", data } };
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    if (error instanceof AssemblyError) {
      const { file, line } = error.location;
      const validationError = new ToolValidationError("Assembly failed", {
        details: {
          file,
          line,
          message: error.message,
        },
        cause: error,
      });
      return toolErrorResult(validationError);
    }
    return unknownErrorResult(error);
  }
}

async function readSymbolsFile(file: string): Promise<Map<string, number>> {
  const symbolsPath = resolveHostPath(file, { purpose: "read" });
  try {
    return parseSymbolFile((await readHostFile(symbolsPath)).toString("utf8"));
  } catch (fileError) {
    throw new ToolExecutionError(`Failed to read symbols file: ${file}`, {
      details: { message: fileError instanceof Error ? fileError.message : String(fileError) },
    });
  }
}

// Replaces the registered symbols after a successful start. Without a symbols
// file the table is cleared only when clearWithoutFile is set: run_prg starts a
// new program on every backend, while load_prg may add data to a running one.
function applySymbols(newSymbols: Map<string, number> | undefined, ctx: ToolExecutionContext, clearWithoutFile: boolean) {
  if (!newSymbols) {
    if (clearWithoutFile) clearViceSymbols();
    return { loaded: 0, note: "", fields: {} as Record<string, unknown> };
  }
  clearViceSymbols();
  setViceSymbols(newSymbols.entries());
  const loaded = newSymbols.size;
  ctx.logger.info("Loaded symbols from file", { count: loaded });
  if (loaded === 0) {
    const warning = `symbolsFile contained no recognisable labels; accepted formats: ${SYMBOL_FILE_FORMATS}.`;
    return { loaded, note: ` Warning: ${warning}`, fields: { symbolsLoaded: 0, warnings: [warning] } as Record<string, unknown> };
  }
  // A bounded sample, lowest addresses first, so the next call can use a label without guessing.
  const sample = [...newSymbols.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, LABEL_SAMPLE_SIZE);
  const labels: Record<string, string> = Object.fromEntries(sample.map(([name, address]) => [name, hex4(address)]));
  const shown = sample.map(([name, address]) => `${name}=${hex4(address)}`).join(", ");
  return {
    loaded,
    note: ` Loaded ${loaded} debug symbol(s)${loaded > sample.length ? `; the first ${sample.length} by address` : ""}: ${shown}.`,
    fields: { symbolsLoaded: loaded, labels, ...(loaded > sample.length ? { labelsTruncated: true } : {}) } as Record<string, unknown>,
  };
}

const MAX_UPLOAD_PRG_BYTES = 65538;
const LABEL_SAMPLE_SIZE = 20;

function hex4(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Load range of a PRG image (two-byte load address, then the body): first and last byte. */
function prgAddresses(prg: Buffer, entry?: number): { load: string; end: string; entry?: string } {
  const load = prg.readUInt16LE(0);
  const end = Math.min(0xffff, load + Math.max(1, prg.length - 2) - 1);
  return { load: hex4(load), end: hex4(end), ...(entry !== undefined ? { entry: hex4(entry) } : {}) };
}

/** VICE reads host PRG files itself; the header is read here only to report the load range. */
async function peekHostPrg(file: string): Promise<Buffer | undefined> {
  try {
    const bytes = await readHostFile(file, { maxBytes: MAX_UPLOAD_PRG_BYTES + 1 });
    return bytes.length >= 2 && bytes.length <= MAX_UPLOAD_PRG_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

type PrgSource = { location: "host" | "device"; bytes?: Buffer; loadAddress?: number; header?: Buffer };

// Decides where the PRG comes from. Host files are read and validated here, so
// nothing reaches the device when the path or size is unacceptable.
async function resolvePrgSource(
  parsed: { path: string; location?: string },
  ctx: ToolExecutionContext,
): Promise<PrgSource> {
  const requested = parsed.location ?? "auto";
  const isVice = ctx.platform.id === "vice";
  if (isVice) {
    if (requested === "device") {
      throw new ToolValidationError("location \"device\" is not available on VICE; PRG paths are host paths there.", { path: "$.location" });
    }
    const peeked = await peekHostPrg(parsed.path);
    return { location: "host", ...(peeked ? { header: peeked, loadAddress: peeked.readUInt16LE(0) } : {}) };
  }
  if (requested !== "host") return { location: "device" };
  const bytes = await readHostFile(parsed.path, { maxBytes: MAX_UPLOAD_PRG_BYTES + 1 });
  if (bytes.length < 2 || bytes.length > MAX_UPLOAD_PRG_BYTES) {
    throw new ToolValidationError(
      `PRG file must be 2 to ${MAX_UPLOAD_PRG_BYTES} bytes (load address plus at most 64 KiB); ${parsed.path} is ${bytes.length} bytes.`,
      { path: "$.path" },
    );
  }
  return { location: "host", bytes, header: bytes, loadAddress: bytes.readUInt16LE(0) };
}

/**
 * On Ultimate hardware a path without `location` is a device path. When the device rejects it but
 * the path names a PRG on this host (inside the allowed roots), say how to upload it instead.
 */
function hostLocationHint(parsed: { path: string; location?: string }, source: PrgSource, ctx: ToolExecutionContext): string {
  if (parsed.location !== undefined || source.location !== "device" || ctx.platform.id === "vice") return "";
  try {
    const resolved = resolveHostPath(parsed.path, { purpose: "read" });
    if (!fs.statSync(resolved).isFile()) return "";
  } catch {
    return "";
  }
  return ` (${parsed.path} was used as a path on the Ultimate device, but it is a file on this host; pass location: "host" to upload it)`;
}

async function executeLoadPrg(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = prgFileArgsSchema.parse(rawArgs ?? {});
    ctx.logger.info("Loading PRG file", { path: parsed.path });

    const source = await resolvePrgSource(parsed, ctx);
    const newSymbols = parsed.symbolsFile ? await readSymbolsFile(parsed.symbolsFile) : undefined;

    const result = source.bytes ? await ctx.client.loadPrg(source.bytes) : await ctx.client.loadPrgFile(parsed.path);
    if (!result.success) {
      throw new ToolExecutionError(`C64 backend reported failure while loading PRG${hostLocationHint(parsed, source, ctx)}`, {
        details: extractFailureDetails(result.details),
      });
    }

    const symbolReport = applySymbols(newSymbols, ctx, false);
    const addresses = source.header ? prgAddresses(source.header) : undefined;
    const rangeNote = addresses ? ` Load range ${addresses.load}-${addresses.end}.` : "";

    const data = {
      kind: "load_prg" as const,
      format: "prg" as const,
      path: parsed.path,
      entryAddress: null as number | null,
      resources: ["c64://guide/bootstrap"],
      location: source.location,
      ...(source.loadAddress !== undefined ? { loadAddress: source.loadAddress } : {}),
      ...(addresses ? { addresses } : {}),
      ...symbolReport.fields,
    };
    const base = textResult(`PRG ${parsed.path} loaded into memory.${rangeNote}${symbolReport.note}`, {
      success: true,
      path: parsed.path,
      entryAddress: null,
      details: toRecord(result.details) ?? null,
      location: source.location,
      ...(source.loadAddress !== undefined ? { loadAddress: source.loadAddress } : {}),
      ...(addresses ? { addresses } : {}),
      ...symbolReport.fields,
    });
    return { ...base, structuredContent: { type: "json", data } };
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return unknownErrorResult(error);
  }
}

async function executeRunPrg(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = prgFileArgsSchema.parse(rawArgs ?? {});
    ctx.logger.info("Running PRG file", { path: parsed.path });

    // Validate and parse the symbols file before touching the registered
    // symbols, and replace them only after the PRG has started. A bad path or a
    // failed run then leaves the previous symbol table as it was.
    const source = await resolvePrgSource(parsed, ctx);
    const newSymbols = parsed.symbolsFile ? await readSymbolsFile(parsed.symbolsFile) : undefined;

    const result = source.bytes ? await ctx.client.runPrg(source.bytes) : await ctx.client.runPrgFile(parsed.path);
    if (!result.success) {
      throw new ToolExecutionError(`C64 backend reported failure while running PRG${hostLocationHint(parsed, source, ctx)}`, {
        details: extractFailureDetails(result.details),
      });
    }

    const symbolReport = applySymbols(newSymbols, ctx, true);
    const symbolsLoaded = symbolReport.loaded;
    const addresses = source.header ? prgAddresses(source.header) : undefined;
    const rangeNote = addresses ? ` Load range ${addresses.load}-${addresses.end}.` : "";

    const data = {
      kind: "run_prg" as const,
      format: "prg" as const,
      path: parsed.path,
      entryAddress: null as number | null,
      resources: ["c64://guide/bootstrap"],
      location: source.location,
      ...(source.loadAddress !== undefined ? { loadAddress: source.loadAddress } : {}),
      ...(addresses ? { addresses } : {}),
      ...symbolReport.fields,
    };
    const base = textResult(`PRG ${parsed.path} loaded and executed.${rangeNote}${symbolReport.note}`, {
      success: true,
      path: parsed.path,
      entryAddress: null,
      details: toRecord(result.details) ?? null,
      location: source.location,
      ...(source.loadAddress !== undefined ? { loadAddress: source.loadAddress } : {}),
      ...(addresses ? { addresses } : {}),
      ...symbolReport.fields,
    });
    return { ...base, structuredContent: { type: "json", data } };
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return unknownErrorResult(error);
  }
}

async function executeRunCrt(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = crtFileArgsSchema.parse(rawArgs ?? {});
    ctx.logger.info("Running CRT file", { path: parsed.path });

    const result = await ctx.client.runCrtFile(parsed.path);
    if (result.success) clearViceSymbols(); // labels belong to one program
    if (!result.success) {
      throw new ToolExecutionError("C64 backend reported failure while running CRT", {
        details: extractFailureDetails(result.details),
      });
    }

    const data = {
      kind: "run_crt" as const,
      format: "crt" as const,
      path: parsed.path,
      entryAddress: null as number | null,
      resources: ["c64://guide/bootstrap"],
    };
    const base = textResult(`PRG ${parsed.path} loaded and executed.`, {
      success: true,
      path: parsed.path,
      entryAddress: null,
      details: toRecord(result.details) ?? null,
    });
    return { ...base, structuredContent: { type: "json", data } };
  } catch (error) {
    if (error instanceof ToolError) {
      return toolErrorResult(error);
    }
    return unknownErrorResult(error);
  }
}

export const programOperationHandlers: OperationHandlerMap<ProgramOperationMap> = {
  load_prg: async (args, ctx) => executeLoadPrg(stripOperationDiscriminator(args), ctx),
  run_prg: async (args, ctx) => executeRunPrg(stripOperationDiscriminator(args), ctx),
  run_crt: async (args, ctx) => executeRunCrt(stripOperationDiscriminator(args), ctx),
  upload_run_basic: async (args, ctx) => executeUploadRunBasic(stripOperationDiscriminator(args), ctx),
  upload_run_asm: async (args, ctx) => executeUploadRunAsm(stripOperationDiscriminator(args), ctx),
};

export const programRunnersModule = defineToolModule({
  domain: "programs",
  summary: "Program uploaders, runners, and compilation workflows for BASIC, assembly, and PRG files.",
  resources: [
    "c64://guide/bootstrap",
    "c64://basic/spec",
    "c64://assembly/6510-spec",
  ],
  prompts: ["basic-program", "assembly-program"],
  defaultTags: ["programs", "execution"],
  workflowHints: [
    "Choose BASIC or assembly uploaders based on the language you just generated for the user.",
    "Prefer PRG or CRT runners when the user supplies an Ultimate filesystem path instead of source text.",
  ],
  tools: [
    {
      name: "upload_run_basic",
      description: "Upload a BASIC program to the C64 and execute it immediately. Refer to c64://basic/spec for syntax and device I/O.",
      summary: "Uploads Commodore BASIC v2 source and runs it via Ultimate 64 firmware.",
      inputSchema: uploadBasicArgsSchema.jsonSchema,
      relatedResources: ["c64://basic/spec", "c64://basic/pitfalls", "c64://guide/bootstrap"],
      relatedPrompts: ["basic-program"],
      tags: ["basic", "execution"],
      prerequisites: ["read_screen"],
      examples: [
        {
          name: "Hello loop",
          description: "Print HELLO in a loop",
          arguments: { program: "10 PRINT \"HELLO\"\n20 GOTO 10" },
        },
      ],
      workflowHints: [
        "Invoke right after you generate BASIC source so it runs on the C64 without extra user steps.",
        "Ensure the program includes line numbers and uppercase keywords before calling the tool.",
      ],
      supportedPlatforms: ["c64u", "u2", "vice"] as const,
      async execute(args, ctx) {
        return executeUploadRunBasic(args, ctx);
      },
    },
    {
      name: "upload_run_asm",
      description: "Assemble 6502/6510 source code, upload the PRG, and run it immediately. See c64://assembly/6510-spec.",
      summary: "Compiles assembly to a PRG and executes it on the C64 via Ultimate 64 firmware.",
      inputSchema: uploadAsmArgsSchema.jsonSchema,
      relatedResources: ["c64://assembly/6510-spec", "c64://guide/bootstrap"],
      relatedPrompts: ["assembly-program"],
      tags: ["assembly", "execution"],
      prerequisites: ["read_screen"],
      examples: [
        {
          name: "Set screen char",
          description: "Write 1 to $0400 then RTS",
          arguments: { program: "start: lda #$01\n sta $0400\n rts" },
        },
      ],
      workflowHints: [
        "Use when the user requests to run new 6502 code; surface any assembler diagnostics in your reply.",
        "Mention the entry routine or important addresses after execution so the user can continue debugging.",
      ],
      supportedPlatforms: ["c64u", "u2", "vice"] as const,
      async execute(args, ctx) {
        return executeUploadRunAsm(args, ctx);
      },
    },
    {
      name: "load_prg",
      description: "Load a PRG into C64 memory without executing it.",
      summary: "Instructs the Ultimate firmware to transfer a PRG into memory without RUN.",
      inputSchema: prgFileArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["programs", "file"],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Load PRG from USB",
          description: "Load without running",
          arguments: { path: "//USB0/demo.prg" },
        },
      ],
      workflowHints: [
        "Stage PRG files without running when the user wants to inspect memory first.",
        "Confirm the Ultimate filesystem path (e.g. //USB0/demo.prg) is accessible before invoking.",
      ],
      supportedPlatforms: ["c64u", "u2", "vice"] as const,
      async execute(args, ctx) {
        return executeLoadPrg(args, ctx);
      },
    },
    {
      name: "run_prg",
      description: "Run a PRG located on the Ultimate filesystem without uploading source.",
      summary: "Loads and executes a PRG file residing on attached storage.",
      inputSchema: prgFileArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["programs", "execution", "file"],
      workflowHints: [
        "Call when the user provides a PRG path and expects immediate execution without compiling.",
        "Mention that firmware issues a RUN so the user knows the machine state changed.",
      ],
      supportedPlatforms: ["c64u", "u2", "vice"] as const,
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Run PRG from USB",
          description: "Load and RUN",
          arguments: { path: "//USB0/demo.prg" },
        },
      ],
      async execute(args, ctx) {
        return executeRunPrg(args, ctx);
      },
    },
    {
      name: "run_crt",
      description: "Run a cartridge image stored on the Ultimate filesystem.",
      summary: "Mounts and autostarts the specified CRT file through the firmware.",
      inputSchema: crtFileArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["programs", "cartridge"],
      workflowHints: [
        "Use for cartridge images and remind the user that the machine will reset into the CRT.",
        "Suggest capturing the screen afterwards if they need to verify the cartridge booted.",
      ],
      prerequisites: ["drives_list"],
      examples: [
        {
          name: "Start CRT",
          description: "Mount and run game.crt",
          arguments: { path: "//USB0/game.crt" },
        },
      ],
      supportedPlatforms: ["c64u", "u2"] as const,
      async execute(args, ctx) {
        try {
          const parsed = crtFileArgsSchema.parse(args ?? {});
          ctx.logger.info("Running CRT file", { path: parsed.path });

          const result = await ctx.client.runCrtFile(parsed.path);
          if (result.success) clearViceSymbols(); // labels belong to one program
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while running CRT", {
              details: extractFailureDetails(result.details),
            });
          }

          const data = {
            kind: "run_crt" as const,
            format: "crt" as const,
            path: parsed.path,
            entryAddress: null as number | null,
            resources: ["c64://guide/bootstrap"],
          };
          const base = textResult(`CRT ${parsed.path} mounted and started.`, {
            success: true,
            path: parsed.path,
            details: toRecord(result.details) ?? null,
          });
          return { ...base, structuredContent: { type: "json", data } };
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
  ],
});
