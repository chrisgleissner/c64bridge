import fs from "node:fs";
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
import { pollForProgramOutcome } from "./pollValidator.js";
import { clearViceSymbols, setViceSymbols, parseViceSymbolFile } from "./translation/symbolRegistry.js";

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

const prgPathDescription = "Path to the PRG image. Use an Ultimate-visible filesystem path on c64u, or a host-local filesystem path on VICE.";
const crtPathDescription = "Path to the CRT image on Ultimate-visible storage. CRT mounting is only supported on c64u.";

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

    const typeMatch = /\?([A-Z ?]+?)\s+ERROR\s+IN/i.exec(row.toUpperCase());
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
      lines[index] = updated;
      changes.push({
        line: lineNumber,
        notes,
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
      description: "Run post-execution polling to ensure the BASIC program executed without errors.",
      default: false,
    }),
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
      description: "Run post-execution polling to confirm the assembly program remained stable.",
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
    symbolsFile: optionalSchema(stringSchema({
      description: "Path to a VICE symbol file (.vs) to load alongside the PRG. Symbols are used by the disassemble tool when annotating addresses.",
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

    const runBasic = async (source: string) => ctx.client.uploadAndRunBasic(source);

    let result = await runBasic(activeProgram);
    if (!result.success) {
      throw new ToolExecutionError("C64 firmware reported failure while running BASIC program", {
        details: extractFailureDetails(result.details),
      });
    }

    let screenOutput: string | undefined;
    try {
      screenOutput = await ctx.client.readScreen();
    } catch (screenError) {
      ctx.logger.warn("Unable to read screen after BASIC execution", toRecord(screenError));
    }

    let autoFixInfo:
      | {
          readonly changes: readonly BasicAutoFixChange[];
          readonly originalErrors: readonly BasicRuntimeError[];
        }
      | undefined;
    let verified: boolean | undefined;

    if (screenOutput) {
      const errors = parseBasicRuntimeErrors(screenOutput);
      if (errors.length > 0) {
        ctx.logger.warn("Detected BASIC runtime errors", {
          errors: errors.map((error) => ({ line: error.line, type: error.type })),
        });

        const normalizedErrors = normalizeRuntimeErrors(errors);
        const fixAttempt = attemptAutoFixBasicProgram(activeProgram, errors);
        if (!fixAttempt) {
          const data = {
            kind: "basic_runtime_error" as const,
            programSource: originalProgram,
            errors: normalizedErrors,
            ...(screenOutput ? { screen: screenOutput } : {}),
            autoFix: {
              attempted: false,
            },
          };
          return structuredExecutionError("Detected BASIC runtime errors after execution.", data);
        }

        ctx.logger.info("Attempting BASIC auto-fix", {
          changes: fixAttempt.changes.map((change) => ({
            line: change.line,
            notes: change.notes,
          })),
        });

        const retryResult = await ctx.client.uploadAndRunBasic(fixAttempt.program);
        if (!retryResult.success) {
          const data = {
            kind: "basic_runtime_error" as const,
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
          return structuredExecutionError(
            "Auto-fix failed due to firmware error while re-running BASIC program.",
            data,
          );
        }

        let retryScreen: string | undefined;
        try {
          retryScreen = await ctx.client.readScreen();
        } catch (retryScreenError) {
          ctx.logger.warn("Unable to read screen after BASIC auto-fix execution", toRecord(retryScreenError));
        }

        const remainingErrors = retryScreen ? parseBasicRuntimeErrors(retryScreen) : [];
        if (remainingErrors.length > 0) {
          const data = {
            kind: "basic_runtime_error" as const,
            programSource: originalProgram,
            errors: normalizedErrors,
            ...(screenOutput ? { screen: screenOutput } : {}),
            autoFix: {
              attempted: true,
              changes: fixAttempt.changes,
              programSource: fixAttempt.program,
              resultingErrors: normalizeRuntimeErrors(remainingErrors),
              ...(retryScreen ? { screen: retryScreen } : {}),
            },
          };
          return structuredExecutionError(
            "BASIC program still reports errors after auto-fix attempt.",
            data,
          );
        }

        activeProgram = fixAttempt.program;
        prg = basicToPrg(activeProgram);
        entryAddress = prg.readUInt16LE(0);
        result = retryResult;
        screenOutput = retryScreen;
        autoFixInfo = {
          changes: fixAttempt.changes,
          originalErrors: errors,
        };
      }
    }

    if (shouldVerify) {
      try {
        const outcome = await pollForProgramOutcome("BASIC", ctx.client, ctx.logger);
        if (outcome.status === "error") {
          ctx.logger.warn("BASIC verification detected error", {
            ...(outcome.message ? { message: outcome.message } : {}),
            ...(outcome.line !== undefined ? { line: outcome.line } : {}),
          });
          return toolErrorResult(
            new ToolExecutionError("BASIC program verification failed", {
              details: {
                ...(outcome.message ? { message: outcome.message } : {}),
                ...(outcome.line !== undefined ? { line: outcome.line } : {}),
              },
            }),
          );
        }
        verified = true;
      } catch (verifyError) {
        ctx.logger.warn("BASIC verification failed", toRecord(verifyError));
        return toolErrorResult(
          new ToolExecutionError("Failed to verify BASIC program execution", {
            details: toRecord(verifyError) ?? undefined,
          }),
        );
      }
    }

    const message = autoFixInfo
      ? "Detected BASIC errors on execution; applied auto-fix and re-ran successfully."
      : "BASIC program uploaded and executed successfully.";

    const metadata = {
      success: true,
      entryAddress,
      prgSize: prg.length,
      details: result.details ?? null,
      ...(screenOutput ? { screen: screenOutput } : {}),
      ...(autoFixInfo
        ? {
            autoFix: {
              applied: true,
              changes: autoFixInfo.changes,
              originalErrors: autoFixInfo.originalErrors,
            },
          }
        : {}),
      ...(verified ? { verified: true } : {}),
    };

    const data = {
      kind: "upload_run_basic" as const,
      format: "prg" as const,
      entryAddress,
      prgSize: prg.length,
      resources: ["c64://basic/spec", "c64://guide/bootstrap"],
      ...(screenOutput ? { screen: screenOutput } : {}),
      ...(autoFixInfo
        ? {
            autoFix: {
              changes: autoFixInfo.changes,
              originalErrors: autoFixInfo.originalErrors,
            },
          }
        : {}),
      ...(verified ? { verified: true } : {}),
    };

    const base = textResult(message, metadata);
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
    const entryAddress = prg.readUInt16LE(0);
    if (ctx.platform.id === "vice") {
      setViceSymbols(asmResult.symbols.entries());
    }

    const result = await ctx.client.uploadAndRunAsm(parsed.program);
    if (!result.success) {
      return toolErrorResult(
        new ToolExecutionError("C64 firmware reported failure while running assembly program", {
          details: extractFailureDetails(result.details),
        }),
      );
    }

    // Poll for ASM execution outcome
    let verified = false;
    try {
      const outcome = await pollForProgramOutcome("ASM", ctx.client, ctx.logger);
      if (outcome.status === "crashed") {
        ctx.logger.warn("Polling detected ASM program crash", { reason: outcome.reason });
        return toolErrorResult(
          new ToolExecutionError("Assembly program appears to have crashed (no screen changes detected)", {
            details: { reason: outcome.reason },
          }),
        );
      }
      if (shouldVerify) {
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

    const data = {
      kind: "upload_run_asm" as const,
      format: "prg" as const,
      entryAddress,
      prgSize: prg.length,
      resources: ["c64://assembly/6510-spec", "c64://guide/bootstrap"],
      ...(shouldVerify && verified ? { verified: true } : {}),
    };
    const base = textResult("Assembly program assembled, uploaded, and executed successfully.", {
      success: true,
      entryAddress,
      prgSize: prg.length,
      details: result.details ?? null,
      ...(shouldVerify && verified ? { verified: true } : {}),
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

async function executeLoadPrg(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = prgFileArgsSchema.parse(rawArgs ?? {});
    ctx.logger.info("Loading PRG file", { path: parsed.path });

    const result = await ctx.client.loadPrgFile(parsed.path);
    if (!result.success) {
      throw new ToolExecutionError("C64 firmware reported failure while loading PRG", {
        details: extractFailureDetails(result.details),
      });
    }

    const data = {
      kind: "load_prg" as const,
      format: "prg" as const,
      path: parsed.path,
      entryAddress: null as number | null,
      resources: ["c64://guide/bootstrap"],
    };
    const base = textResult(`PRG ${parsed.path} loaded into memory.`, {
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

async function executeRunPrg(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const parsed = prgFileArgsSchema.parse(rawArgs ?? {});
    ctx.logger.info("Running PRG file", { path: parsed.path });

    let symbolsLoaded = 0;
    if (ctx.platform.id === "vice") {
      clearViceSymbols();
      if (parsed.symbolsFile) {
        try {
          const content = await fs.promises.readFile(parsed.symbolsFile, "utf8");
          const syms = parseViceSymbolFile(content);
          setViceSymbols(syms.entries());
          symbolsLoaded = syms.size;
          ctx.logger.info("Loaded VICE symbols from file", { path: parsed.symbolsFile, count: symbolsLoaded });
        } catch (fileError) {
          throw new ToolExecutionError(`Failed to read symbols file: ${parsed.symbolsFile}`, {
            details: { message: fileError instanceof Error ? fileError.message : String(fileError) },
          });
        }
      }
    }

    const result = await ctx.client.runPrgFile(parsed.path);
    if (!result.success) {
      throw new ToolExecutionError("C64 firmware reported failure while running PRG", {
        details: extractFailureDetails(result.details),
      });
    }

    const data = {
      kind: "run_prg" as const,
      format: "prg" as const,
      path: parsed.path,
      entryAddress: null as number | null,
      resources: ["c64://guide/bootstrap"],
      ...(symbolsLoaded > 0 ? { symbolsLoaded } : {}),
    };
    const symbolNote = symbolsLoaded > 0 ? ` Loaded ${symbolsLoaded} debug symbol(s).` : "";
    const base = textResult(`PRG ${parsed.path} loaded and executed.${symbolNote}`, {
      success: true,
      path: parsed.path,
      entryAddress: null,
      details: toRecord(result.details) ?? null,
      ...(symbolsLoaded > 0 ? { symbolsLoaded } : {}),
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
    if (!result.success) {
      throw new ToolExecutionError("C64 firmware reported failure while running CRT", {
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
      supportedPlatforms: ["c64u", "vice"] as const,
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
          arguments: { program: ".org $0801\nstart: lda #$01\n sta $0400\n rts" },
        },
      ],
      workflowHints: [
        "Use when the user requests to run new 6502 code; surface any assembler diagnostics in your reply.",
        "Mention the entry routine or important addresses after execution so the user can continue debugging.",
      ],
      supportedPlatforms: ["c64u", "vice"] as const,
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
      supportedPlatforms: ["c64u"] as const,
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
      supportedPlatforms: ["c64u", "vice"] as const,
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
      supportedPlatforms: ["c64u"] as const,
      async execute(args, ctx) {
        try {
          const parsed = crtFileArgsSchema.parse(args ?? {});
          ctx.logger.info("Running CRT file", { path: parsed.path });

          const result = await ctx.client.runCrtFile(parsed.path);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while running CRT", {
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
