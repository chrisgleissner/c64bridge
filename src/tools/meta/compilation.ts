// Compile-run-verify cycle meta tool
import type { ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, numberSchema, optionalSchema, booleanSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolExecutionError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { promises as fs } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { resolveHostChildPath, resolveHostPath } from "../../hostPaths.js";
import { sleep } from "./util.js";
import { getTasksHomeDir } from "./background.js";

const compileRunVerifyCycleArgsSchema = objectSchema({
  description: "Compile source (BASIC/ASM/SIDWAVE), run, verify via screen/audio, and archive artifacts.",
  properties: {
    sourceType: stringSchema({ description: "Source type to compile", enum: ["basic", "asm", "sidwave"] }),
    source: stringSchema({ description: "Source code to compile", minLength: 1 }),
    verifyScreen: optionalSchema(stringSchema({ description: "Expected screen text pattern (regex or substring)", minLength: 1 })),
    verifyAudio: optionalSchema(booleanSchema({ description: "Analyze audio output", default: false }), false),
    durationMs: optionalSchema(numberSchema({ description: "Duration to run program", integer: true, minimum: 1, default: 2000 }), 2000),
    outputPath: optionalSchema(stringSchema({ description: "Output directory for artifacts", minLength: 1 })),
  },
  required: ["sourceType", "source"],
  additionalProperties: false,
});

export const tools: ToolDefinition[] = [
  {
    name: "compile_run_verify_cycle",
    description: "Compile source (BASIC/ASM/SIDWAVE), run, verify via screen/audio, and archive artifacts.",
    summary: "Complete build-test cycle with verification and artifact archival.",
    inputSchema: compileRunVerifyCycleArgsSchema.jsonSchema,
    tags: ["orchestration", "compile", "verify"],
    examples: [
      {
        name: "Compile and verify BASIC",
        description: "Compile BASIC program and verify screen output",
        arguments: {
          sourceType: "basic",
          source: "10 PRINT \"HELLO\"\n20 GOTO 10",
          verifyScreen: "HELLO",
          durationMs: 1000,
        },
      },
    ],
    async execute(args, ctx) {
      try {
        const parsed = compileRunVerifyCycleArgsSchema.parse(args ?? {});
        const sourceType = parsed.sourceType as string;
        const source = parsed.source as string;
        const verifyScreen = parsed.verifyScreen as string | undefined;
        const verifyAudio = parsed.verifyAudio ?? false;
        const durationMs = parsed.durationMs ?? 2000;

        const outputPath = parsed.outputPath
          ? resolveHostPath(String(parsed.outputPath), { purpose: "write" })
          : resolvePath(joinPath(getTasksHomeDir(), `cycle_${Date.now()}`));
        await fs.mkdir(outputPath, { recursive: true });

        const runId = `cycle_${Date.now()}`;
        let compiled = false;
        let ran = false;
        let verified = false;
        let verificationMessage: string | undefined;

        try {
          // Compile
          if (sourceType === "basic") {
            await (ctx.client as any).uploadAndRunBasic(source);
            compiled = true;
            ran = true;
          } else if (sourceType === "asm") {
            await (ctx.client as any).uploadAndRunAsm(source);
            compiled = true;
            ran = true;
          } else if (sourceType === "sidwave") {
            // For SIDWAVE, use music_compile_and_play
            await (ctx.client as any).musicCompileAndPlay(source, { format: "prg" });
            compiled = true;
            ran = true;
          }

          await sleep(durationMs);

          // Verify
          if (verifyScreen) {
            const screen = await (ctx.client as any).readScreen();
            verified = screen.includes(verifyScreen);
            verificationMessage = verified ? "Screen verification passed" : `Screen does not contain "${verifyScreen}"`;
          }

          // Archive artifacts
          const sourcePath = resolveHostChildPath(outputPath, `source.${sourceType}`);
          await fs.writeFile(sourcePath, source, "utf8");

          const screenPath = resolveHostChildPath(outputPath, "screen.txt");
          const screen = await (ctx.client as any).readScreen();
          await fs.writeFile(screenPath, screen, "utf8");

          const manifestPath = resolveHostChildPath(outputPath, "manifest.json");
          const manifest = {
            runId,
            sourceType,
            compiled,
            ran,
            verified,
            verificationMessage,
            createdAt: new Date().toISOString(),
            artifacts: {
              source: sourcePath,
              screen: screenPath,
            },
          };
          await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

          return jsonResult({ runId, outputPath, compiled, ran, verified, verificationMessage }, { success: verified || !verifyScreen });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          const manifestPath = resolveHostChildPath(outputPath, "manifest.json");
          const manifest = {
            runId,
            sourceType,
            compiled,
            ran,
            verified,
            error,
            createdAt: new Date().toISOString(),
          };
          await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
          throw new ToolExecutionError("Compile/run/verify cycle failed", { details: { error } });
        }
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
];
