// Artifact bundling meta tool
import type { ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, arraySchema, numberSchema, optionalSchema, booleanSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolValidationError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { promises as fs } from "node:fs";
import { resolve as resolvePath, join as joinPath, relative, sep, isAbsolute } from "node:path";

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
    captureDebugReg: optionalSchema(booleanSchema({ description: "Capture debugreg state", default: true }), true),
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
        const outputPath = resolvePath(String(parsed.outputPath));
        const captureScreen = parsed.captureScreen !== false;
        const captureDebugReg = parsed.captureDebugReg !== false;
        const memoryRanges = (parsed.memoryRanges ?? []) as Array<{ address: string; length: number }>;

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
          for (let i = 0; i < memoryRanges.length; i++) {
            const range = memoryRanges[i]!;
            const result = await (ctx.client as any).readMemory(range.address, String(range.length));
            const rangePath = containedPath(memoryPath, `range_${i}.hex`);
            await fs.writeFile(rangePath, result.data ?? "", "utf8");
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
  const rel = relative(base, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ToolValidationError("Artifact path escapes its output directory.");
  return candidate;
}
