// Configuration snapshot and restore meta tool
import type { ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, optionalSchema, booleanSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolUnsupportedPlatformError, ToolExecutionError, ToolValidationError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { getPlatformStatus } from "../../platform.js";
import { promises as fs } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { captureConfigSnapshot, validateSnapshotCategories } from "./configInventory.js";
import { normalizeErrorDetails } from "./util.js";

const configSnapshotAndRestoreArgsSchema = objectSchema({
  description: "Snapshot or restore full device configuration. Snapshot writes versioned JSON.",
  properties: {
    action: stringSchema({ description: "One of: snapshot|restore|diff", enum: ["snapshot", "restore", "diff"] }),
    path: stringSchema({ description: "Snapshot file path", minLength: 1 }),
    applyToFlash: optionalSchema(booleanSchema({ description: "Save configuration to flash after restore (C64U/U64 and U2 only)", default: false }), false),
  },
  required: ["action", "path"],
  additionalProperties: false,
});

export const tools: ToolDefinition[] = [
  {
    name: "config_snapshot_and_restore",
    description: "Read all configuration categories and write a versioned snapshot, or restore from a snapshot; supports diff mode.",
    summary: "Snapshot/restore configuration with simple diff reporting.",
    inputSchema: configSnapshotAndRestoreArgsSchema.jsonSchema,
    tags: ["config", "snapshot"],
    async execute(args, ctx) {
      try {
        const parsed = configSnapshotAndRestoreArgsSchema.parse(args ?? {});
        const action = parsed.action as string;
        const platform = ctx.platform?.id ?? getPlatformStatus().id;
        if (action === "restore" && parsed.applyToFlash && platform === "vice") {
          throw new ToolUnsupportedPlatformError("config_save_to_flash", platform, ["c64u", "u2"]);
        }
        const path = resolvePath(String(parsed.path));

        if (action === "snapshot") {
          await fs.mkdir(dirname(path), { recursive: true });
          const [version, info, snapshotData] = await Promise.all([
            (ctx.client as any).version(),
            (ctx.client as any).info(),
            captureConfigSnapshot(ctx.client as any),
          ]);
          const snapshot = {
            createdAt: new Date().toISOString(),
            version,
            info,
            inventory: snapshotData.inventory,
            categories: snapshotData.categories,
          };
          await fs.writeFile(path, JSON.stringify(snapshot, null, 2), "utf8");
          return jsonResult({
            path,
            categoryCount: Object.keys(snapshotData.categories).length,
            itemCount: snapshotData.inventory.length,
          }, { success: true });
        }

        if (action === "restore") {
          const text = await fs.readFile(path, "utf8");
          const snapshot = JSON.parse(text);
          if (!snapshot || typeof snapshot !== "object") {
            throw new ToolValidationError("Invalid snapshot file", { path: "$.path" });
          }
          let payload: Record<string, object>;
          try {
            payload = validateSnapshotCategories(snapshot.categories) as Record<string, object>;
          } catch {
            throw new ToolValidationError("Invalid snapshot file", { path: "$.path" });
          }
          const result = await (ctx.client as any).configBatchUpdate(payload);
          if (!result.success) {
            throw new ToolExecutionError("Batch update failed", { details: normalizeErrorDetails(result.details) });
          }
          if (parsed.applyToFlash) {
            const saved = await (ctx.client as any).configSaveToFlash();
            if (!saved.success) {
              throw new ToolExecutionError("Configuration restored, but saving to flash failed", { details: normalizeErrorDetails(saved.details) });
            }
          }
          return jsonResult({ restored: true, categories: Object.keys(payload).length }, { success: true });
        }

        const text = await fs.readFile(path, "utf8");
        const snapshot = JSON.parse(text);
        const snapCats = validateSnapshotCategories(snapshot.categories ?? {});
        const current = (await captureConfigSnapshot(ctx.client as any)).categories;
        const diff: Record<string, Record<string, { expected: unknown; actual: unknown }>> = {};
        for (const [cat, snapVal] of Object.entries(snapCats)) {
          const curVal = current[cat];
          if (JSON.stringify(snapVal) !== JSON.stringify(curVal)) {
            diff[cat] = { _changed: { expected: snapVal, actual: curVal } } as any;
          }
        }
        return jsonResult({ diff }, { success: true, changed: Object.keys(diff).length });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
];
