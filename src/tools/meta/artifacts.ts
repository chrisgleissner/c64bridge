// Artifact bundling meta tool
import type { ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, arraySchema, numberSchema, optionalSchema, booleanSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolExecutionError, ToolValidationError, ToolUnsupportedPlatformError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { getPlatformStatus } from "../../platform.js";
import { promises as fs } from "node:fs";
import { resolve as resolvePath, join as joinPath, isAbsolute } from "node:path";
import { resolveAddressSymbol } from "../../knowledge.js";
import { parseNumericLiteral, assertNotBareHex, assertAddressRange } from "../../numericArg.js";
import { isWithin, resolveHostChildPath, resolveHostPath } from "../../hostPaths.js";

const bundleRunArtifactsArgsSchema = objectSchema({
  description: "Gather screen capture, memory snapshot, and debugreg into a structured bundle.",
  properties: {
    runId: stringSchema({ description: "Unique identifier for this run", minLength: 1 }),
    outputPath: stringSchema({ description: "Output directory for artifacts bundle", minLength: 1 }),
    captureScreen: optionalSchema(booleanSchema({ description: "Capture screen content", default: true }), true),
    memoryRanges: optionalSchema(arraySchema(objectSchema({
      description: "Memory range to snapshot",
      properties: {
        address: stringSchema({ description: "Start address", minLength: 1 }),
        length: numberSchema({ description: "Length in bytes", integer: true, minimum: 1 }),
      },
      required: ["address", "length"],
      additionalProperties: false,
    }))),
    captureDebugReg: optionalSchema(booleanSchema({ description: "Capture Ultimate debug registers (C64U/U64 only). Defaults to true on C64U/U64 and false on U2/VICE." })),
  },
  required: ["runId", "outputPath"],
  additionalProperties: false,
});

export const tools: ToolDefinition[] = [
  {
    name: "bundle_run_artifacts",
    description: "Gather screen capture, memory snapshots, and debugreg into a structured bundle for a run.",
    summary: "Artifact bundling for run analysis and debugging.",
    inputSchema: bundleRunArtifactsArgsSchema.jsonSchema,
    tags: ["orchestration", "artifacts", "debugging"],
    examples: [
      {
        name: "Bundle artifacts",
        description: "Capture screen and memory for run analysis",
        arguments: { runId: "demo_001", outputPath: "/tmp/artifacts", memoryRanges: [{ address: "$0400", length: 1000 }] },
      },
    ],
    async execute(args, ctx) {
      try {
        const parsed = bundleRunArtifactsArgsSchema.parse(args ?? {});
        const runId = parsed.runId as string;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === "." || runId === "..") {
          throw new ToolValidationError("runId must be a non-empty safe filename (letters, digits, dot, underscore, and dash only).", { path: "$.runId" });
        }
        const outputPath = resolveHostPath(String(parsed.outputPath), { purpose: "write" });
        const captureScreen = parsed.captureScreen !== false;
        const platform = ctx.platform?.id ?? getPlatformStatus().id;
        const captureDebugReg = parsed.captureDebugReg ?? (platform === "c64u");
        if (captureDebugReg && platform !== "c64u") {
          throw new ToolUnsupportedPlatformError("debugreg_read", platform, ["c64u"]);
        }
        const memoryRanges = (parsed.memoryRanges ?? []) as Array<{ address: string; length: number }>;

        // Validate every range before anything is created, with the shared address parser.
        const resolvedRanges = memoryRanges.map((range, i) => {
          const rangePath = `$.memoryRanges[${i}]`;
          const literal = parseNumericLiteral(range.address, `${rangePath}.address`);
          const address = literal ?? resolveAddressSymbol(range.address);
          if (address === undefined) {
            assertNotBareHex(range.address, `${rangePath}.address`);
            throw new ToolValidationError(`Invalid address "${range.address}"`, { path: `${rangePath}.address` });
          }
          assertAddressRange(address, range.length, `${rangePath}.length`);
          return { address, length: range.length };
        });

        await fs.mkdir(outputPath, { recursive: true });
        const runPath = containedPath(outputPath, runId);
        await fs.mkdir(runPath, { recursive: true });

        const artifacts: Record<string, string> = {};

        // Capture screen
        if (captureScreen) {
          const screen = await (ctx.client as any).readScreen();
          const screenPath = containedPath(runPath, "screen.txt");
          await fs.writeFile(screenPath, screen, "utf8");
          artifacts.screen = screenPath;
        }

        // Capture memory ranges
        if (memoryRanges.length > 0) {
          const memoryPath = containedPath(runPath, "memory");
          await fs.mkdir(memoryPath, { recursive: true });
          // Read every range first, so a failed read leaves no range file behind.
          const reads: string[] = [];
          for (let i = 0; i < resolvedRanges.length; i++) {
            const range = resolvedRanges[i]!;
            const result = await (ctx.client as any).readMemory(`$${range.address.toString(16).toUpperCase().padStart(4, "0")}`, String(range.length));
            if (!result || result.success === false || typeof result.data !== "string") {
              throw new ToolExecutionError(`Memory read failed for range ${i} ($${range.address.toString(16).toUpperCase().padStart(4, "0")}, ${range.length} bytes): ${result?.error ?? "no data returned"}`, { details: { range: i } });
            }
            reads.push(result.data);
          }
          for (let i = 0; i < reads.length; i++) {
            const rangePath = containedPath(memoryPath, `range_${i}.hex`);
            await fs.writeFile(rangePath, reads[i]!, "utf8");
            artifacts[`memory_range_${i}`] = rangePath;
          }
        }

        // Capture debugreg
        if (captureDebugReg) {
          const debugreg = await (ctx.client as any).debugregRead();
          const debugPath = containedPath(runPath, "debugreg.json");
          await fs.writeFile(debugPath, JSON.stringify(debugreg, null, 2), "utf8");
          artifacts.debugreg = debugPath;
        }

        // Write manifest
        const manifestPath = containedPath(runPath, "manifest.json");
        const manifest = {
          runId,
          createdAt: new Date().toISOString(),
          artifacts,
        };
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

        return jsonResult({ runId, runPath, artifacts }, { success: true });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
];

function containedPath(base: string, name: string): string {
  if (!name || isAbsolute(name) || name.includes("/") || name.includes("\\")) throw new ToolValidationError("Unsafe artifact filename.");
  const candidate = resolvePath(joinPath(base, name));
  if (candidate === base || !isWithin(base, candidate)) throw new ToolValidationError("Artifact path escapes its output directory.");
  return resolveHostChildPath(base, name);
}
