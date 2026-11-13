// Configuration snapshot and restore meta tool
import type { ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, optionalSchema, booleanSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolUnsupportedPlatformError, ToolExecutionError, ToolValidationError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { getPlatformStatus } from "../../platform.js";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { readHostFile, resolveHostPath } from "../../hostPaths.js";
import { captureConfigSnapshot, stripRedactedSecrets, validateSnapshotCategories } from "./configInventory.js";
import { normalizeErrorDetails } from "./util.js";

const configSnapshotAndRestoreArgsSchema = objectSchema({
  description: "Snapshot or restore full device configuration. Snapshot writes versioned JSON.",
  properties: {
    action: stringSchema({ description: "One of: snapshot|restore|diff", enum: ["snapshot", "restore", "diff"] }),
    path: stringSchema({ description: "Snapshot file path", minLength: 1 }),
    includeSecretValues: optionalSchema(booleanSchema({ description: "Snapshot and diff only: store credential values (network password, FTP/Telnet passwords, Wi-Fi keys) in plain text in the snapshot file. Default false: they are written as ***, and restore skips them.", default: false }), false),
    applyToFlash: optionalSchema(booleanSchema({ description: "Save configuration to flash after restore (C64U/U64 and U2 only)", default: false }), false),
  },
  required: ["action", "path"],
  additionalProperties: false,
});

// JSON.parse errors can quote the start of the file, so only the path is reported.
async function readSnapshotFile(path: string): Promise<any> {
  const text = (await readHostFile(path)).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolValidationError(`Snapshot file is not valid JSON: ${path}`, { path: "$.path" });
  }
}

function valuesEqual(wanted: unknown, actual: unknown): boolean {
  if (wanted !== null && typeof wanted === "object") return JSON.stringify(wanted) === JSON.stringify(actual);
  if (actual !== null && typeof actual === "object") return false;
  return String(wanted) === String(actual);
}

/** Items of the snapshot payload ({ category: { item: value } }) whose value differs from the device. */
function changedConfigItems(
  payload: Record<string, object>,
  current: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const changes: Record<string, Record<string, unknown>> = {};
  for (const [category, items] of Object.entries(payload)) {
    if (!items || typeof items !== "object" || Array.isArray(items)) continue;
    const live = current[category];
    const liveItems = live && typeof live === "object" && !Array.isArray(live) ? live as Record<string, unknown> : {};
    const originalCategory = original[category] as Record<string, unknown> | undefined;
    for (const [item, value] of Object.entries(items as Record<string, unknown>)) {
      // A redacted credential was removed from the payload; it is never compared or written.
      if (originalCategory && JSON.stringify(originalCategory[item]) !== JSON.stringify(value)) continue;
      if (!Object.prototype.hasOwnProperty.call(liveItems, item) || !valuesEqual(value, liveItems[item])) {
        (changes[category] ??= {})[item] = value;
      }
    }
  }
  return changes;
}

function countItems(changes: Record<string, Record<string, unknown>>): number {
  return Object.values(changes).reduce((sum, items) => sum + Object.keys(items).length, 0);
}

function describeWriteFailure(details: unknown): { status?: number; message: string } {
  const d = (details && typeof details === "object" ? details : {}) as Record<string, any>;
  const status = typeof d.status === "number" ? d.status : undefined;
  if (status === 403) {
    return { status, message: "the firmware does not accept REST writes to this category" };
  }
  const failedItems = Array.isArray(d.results)
    ? d.results.filter((r: any) => r && r.success === false).map((r: any) => `${r.item}: ${r.error ?? "failed"}`)
    : [];
  const message = failedItems.length > 0
    ? failedItems.join("; ")
    : typeof d.message === "string" ? d.message
    : Array.isArray(d.errors) && d.errors.length > 0 ? d.errors.map(String).join("; ")
    : "write failed";
  return status === undefined ? { message } : { status, message };
}

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
        const path = resolveHostPath(String(parsed.path), { purpose: action === "snapshot" ? "write" : "read" });

        if (action === "snapshot") {
          // A newly created directory is private to the user; an existing directory keeps its mode.
          await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const [version, info, snapshotData] = await Promise.all([
            (ctx.client as any).version(),
            (ctx.client as any).info(),
            captureConfigSnapshot(ctx.client as any, { includeSecretValues: parsed.includeSecretValues === true }),
          ]);
          const snapshot = {
            createdAt: new Date().toISOString(),
            version,
            info,
            inventory: snapshotData.inventory,
            categories: snapshotData.categories,
          };
          // The mode applies only when the file is created, so an existing file is tightened as well.
          await fs.writeFile(path, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
          await fs.chmod(path, 0o600);
          return jsonResult({
            path,
            categoryCount: Object.keys(snapshotData.categories).length,
            itemCount: snapshotData.inventory.length,
          }, { success: true });
        }

        if (action === "restore") {
          const snapshot = await readSnapshotFile(path);
          if (!snapshot || typeof snapshot !== "object") {
            throw new ToolValidationError("Invalid snapshot file", { path: "$.path" });
          }
          let payload: Record<string, object>;
          try {
            payload = stripRedactedSecrets(validateSnapshotCategories(snapshot.categories) as Record<string, object>);
          } catch {
            throw new ToolValidationError("Invalid snapshot file", { path: "$.path" });
          }
          const client = ctx.client as any;
          const current = (await captureConfigSnapshot(client, { includeSecretValues: true })).categories;
          const changes = changedConfigItems(payload, current, validateSnapshotCategories(snapshot.categories));
          const changedItems = countItems(changes);
          const categories = Object.keys(changes);
          if (categories.length === 0) {
            return jsonResult({ restored: true, changedItems: 0, categories: 0 }, { success: true });
          }
          const failedCategories: Array<{ category: string; status?: number; message: string }> = [];
          let restoredCategories: string[] = categories;
          const batch = await client.configBatchUpdate(changes);
          if (!batch.success) {
            restoredCategories = [];
            for (const category of categories) {
              const single = await client.configBatchUpdate({ [category]: changes[category] });
              if (single.success) {
                restoredCategories.push(category);
              } else {
                failedCategories.push({ category, ...describeWriteFailure(single.details) });
              }
            }
          }
          if (failedCategories.length > 0) {
            throw new ToolExecutionError(
              `Configuration restore failed for ${failedCategories.length} of ${categories.length} categories`,
              { details: { restoredCategories, failedCategories, changedItems } },
            );
          }
          if (parsed.applyToFlash) {
            const saved = await client.configSaveToFlash();
            if (!saved.success) {
              throw new ToolExecutionError("Configuration restored, but saving to flash failed", { details: normalizeErrorDetails(saved.details) });
            }
          }
          return jsonResult({ restored: true, changedItems, categories: categories.length, restoredCategories }, { success: true });
        }

        const snapshot = await readSnapshotFile(path);
        const snapCats = validateSnapshotCategories(snapshot.categories ?? {});
        const current = (await captureConfigSnapshot(ctx.client as any, { includeSecretValues: parsed.includeSecretValues === true })).categories;
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
