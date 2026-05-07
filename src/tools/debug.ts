import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
  type OperationHandlerMap,
  type OperationMap,
} from "./types.js";
import {
  arraySchema,
  booleanSchema,
  literalSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "./schema.js";
import { jsonResult, textResult } from "./responses.js";
import {
  ToolError,
  ToolValidationError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";

interface DebugOperationMap extends OperationMap {
  readonly list_checkpoints: Record<string, never>;
  readonly get_checkpoint: { readonly id: number };
  readonly create_checkpoint: {
    readonly address: string;
    readonly endAddress?: string;
    readonly stopOnHit?: boolean;
    readonly enabled?: boolean;
    readonly temporary?: boolean;
    readonly label?: string;
    readonly operations?: {
      readonly execute?: boolean;
      readonly load?: boolean;
      readonly store?: boolean;
    };
    readonly memspace?: number;
  };
  readonly delete_checkpoint: { readonly id: number };
  readonly toggle_checkpoint: { readonly id: number; readonly enabled: boolean };
  readonly set_condition: { readonly id: number; readonly expression: string };
  readonly list_registers: { readonly memspace?: number };
  readonly get_registers: {
    readonly memspace?: number;
    readonly registers?: readonly RegisterSelector[];
  };
  readonly set_registers: {
    readonly memspace?: number;
    readonly writes: readonly RegisterWriteSpec[];
  };
  readonly step: { readonly count?: number; readonly mode?: "into" | "over" };
  readonly step_return: Record<string, never>;
  readonly get_monitor_state: { readonly memspace?: number };
  readonly wait_for_state: { readonly expectedPC?: string; readonly timeoutMs?: number; readonly pollMs?: number };
  readonly nuclear_reset: Record<string, never>;
  readonly continue_execution: Record<string, never>;
}

interface RegisterSelector {
  readonly name?: string;
  readonly id?: number;
}

interface RegisterWriteSpec extends RegisterSelector {
  readonly value: number;
}

interface RegisterSelectorRecord extends Record<string, unknown> {
  readonly name?: string;
  readonly id?: number;
}

interface RegisterWriteRecord extends RegisterSelectorRecord {
  readonly value: number;
}

interface CheckpointOperationsRecord extends Record<string, unknown> {
  readonly execute?: boolean;
  readonly load?: boolean;
  readonly store?: boolean;
}

const checkpointIdSchema = numberSchema({
  description: "Debugger checkpoint identifier.",
  integer: true,
  minimum: 1,
});

const memspaceSchema = optionalSchema(numberSchema({
  description: "VICE memory space (0=CPU, 1=Drive8, etc.).",
  integer: true,
  minimum: 0,
  maximum: 4,
}));

const registerSelectorSchema = objectSchema<RegisterSelectorRecord>({
  description: "Selects a register by id or name.",
  properties: {
    name: optionalSchema(stringSchema({ description: "Register name (case-insensitive)." })),
    id: optionalSchema(numberSchema({ description: "Register id.", integer: true, minimum: 0 })),
  },
  additionalProperties: false,
});

const registerWriteSchema = objectSchema<RegisterWriteRecord>({
  description: "Register write descriptor.",
  properties: {
    name: optionalSchema(stringSchema({ description: "Register name (case-insensitive)." })),
    id: optionalSchema(numberSchema({ description: "Register id.", integer: true, minimum: 0 })),
    value: numberSchema({ description: "Value to write.", integer: true, minimum: 0 }),
  },
  required: ["value"],
  additionalProperties: false,
});

const listCheckpointsArgsSchema = objectSchema({
  description: "List all active VICE checkpoints (breakpoints).",
  properties: {
    op: literalSchema("list_checkpoints"),
  },
  required: ["op"],
  additionalProperties: false,
});

const getCheckpointArgsSchema = objectSchema({
  description: "Fetch a single checkpoint by id.",
  properties: {
    op: literalSchema("get_checkpoint"),
    id: checkpointIdSchema,
  },
  required: ["op", "id"],
  additionalProperties: false,
});

const createCheckpointArgsSchema = objectSchema({
  description: "Create a new checkpoint (breakpoint) in VICE.",
  properties: {
    op: literalSchema("create_checkpoint"),
    address: stringSchema({ description: "Start address (e.g. $0801).", minLength: 1 }),
    endAddress: optionalSchema(stringSchema({ description: "Optional end address for range.", minLength: 1 })),
    stopOnHit: optionalSchema(booleanSchema({ description: "Pause execution when hit (default true).", default: true })),
    enabled: optionalSchema(booleanSchema({ description: "Whether the checkpoint is enabled (default true).", default: true })),
    temporary: optionalSchema(booleanSchema({ description: "Automatically remove after first hit.", default: false })),
    label: optionalSchema(stringSchema({ description: "Optional human-readable label stored in-process.", maxLength: 64 })),
    operations: optionalSchema(objectSchema<CheckpointOperationsRecord>({
      description: "Checkpoint operation filters.",
      properties: {
        execute: optionalSchema(booleanSchema({ description: "Trigger on execute (default true).", default: true })),
        load: optionalSchema(booleanSchema({ description: "Trigger on memory load.", default: false })),
        store: optionalSchema(booleanSchema({ description: "Trigger on memory store.", default: false })),
      },
      additionalProperties: false,
    })),
    memspace: memspaceSchema,
  },
  required: ["op", "address"],
  additionalProperties: false,
});

const deleteCheckpointArgsSchema = objectSchema({
  description: "Remove a checkpoint by id.",
  properties: {
    op: literalSchema("delete_checkpoint"),
    id: checkpointIdSchema,
  },
  required: ["op", "id"],
  additionalProperties: false,
});

const toggleCheckpointArgsSchema = objectSchema({
  description: "Enable or disable a checkpoint by id.",
  properties: {
    op: literalSchema("toggle_checkpoint"),
    id: checkpointIdSchema,
    enabled: booleanSchema({ description: "Set to true to enable, false to disable." }),
  },
  required: ["op", "id", "enabled"],
  additionalProperties: false,
});

const setConditionArgsSchema = objectSchema({
  description: "Attach a conditional expression to a checkpoint.",
  properties: {
    op: literalSchema("set_condition"),
    id: checkpointIdSchema,
    expression: stringSchema({ description: "VICE monitor conditional expression.", minLength: 1 }),
  },
  required: ["op", "id", "expression"],
  additionalProperties: false,
});

const listRegistersArgsSchema = objectSchema({
  description: "List available registers (metadata).",
  properties: {
    op: literalSchema("list_registers"),
    memspace: memspaceSchema,
  },
  required: ["op"],
  additionalProperties: false,
});

const getRegistersArgsSchema = objectSchema({
  description: "Read register values, optionally filtered by name or id.",
  properties: {
    op: literalSchema("get_registers"),
    memspace: memspaceSchema,
    registers: optionalSchema(arraySchema(registerSelectorSchema, { description: "Registers to include." })),
  },
  required: ["op"],
  additionalProperties: false,
});

const setRegistersArgsSchema = objectSchema({
  description: "Write register values.",
  properties: {
    op: literalSchema("set_registers"),
    memspace: memspaceSchema,
    writes: arraySchema(registerWriteSchema, { description: "Register writes to apply.", minItems: 1 }),
  },
  required: ["op", "writes"],
  additionalProperties: false,
});

const stepArgsSchema = objectSchema({
  description: "Single-step CPU execution.",
  properties: {
    op: literalSchema("step"),
    count: optionalSchema(numberSchema({ description: "Number of instructions to step.", integer: true, minimum: 1, default: 1 })),
    mode: optionalSchema(stringSchema({ description: "Step mode (into or over).", enum: ["into", "over"] })),
  },
  required: ["op"],
  additionalProperties: false,
});

const stepReturnArgsSchema = objectSchema({
  description: "Continue execution until the current routine returns.",
  properties: {
    op: literalSchema("step_return"),
  },
  required: ["op"],
  additionalProperties: false,
});

const getMonitorStateArgsSchema = objectSchema({
  description: "Read CPU registers and return the current monitor state.",
  properties: {
    op: literalSchema("get_monitor_state"),
    memspace: memspaceSchema,
  },
  required: ["op"],
  additionalProperties: false,
});

const waitForStateArgsSchema = objectSchema({
  description: "Poll CPU registers until PC equals expectedPC or timeout elapses.",
  properties: {
    op: literalSchema("wait_for_state"),
    expectedPC: optionalSchema(stringSchema({ description: "Target PC address to wait for (e.g. $0810).", minLength: 1 })),
    timeoutMs: optionalSchema(numberSchema({ description: "Maximum wait time in milliseconds.", integer: true, minimum: 1, maximum: 60000, default: 5000 })),
    pollMs: optionalSchema(numberSchema({ description: "Poll interval in milliseconds.", integer: true, minimum: 10, maximum: 1000, default: 100 })),
  },
  required: ["op"],
  additionalProperties: false,
});

const nuclearResetArgsSchema = objectSchema({
  description: "Kill and restart the VICE process (managed instances only).",
  properties: {
    op: literalSchema("nuclear_reset"),
  },
  required: ["op"],
  additionalProperties: false,
});

const continueExecutionArgsSchema = objectSchema({
  description: "Exit the Binary Monitor and resume CPU execution (BM 0xAA Exit).",
  properties: {
    op: literalSchema("continue_execution"),
  },
  required: ["op"],
  additionalProperties: false,
});

const debugOperationSchemas = [
  listCheckpointsArgsSchema,
  getCheckpointArgsSchema,
  createCheckpointArgsSchema,
  deleteCheckpointArgsSchema,
  toggleCheckpointArgsSchema,
  setConditionArgsSchema,
  listRegistersArgsSchema,
  getRegistersArgsSchema,
  setRegistersArgsSchema,
  stepArgsSchema,
  stepReturnArgsSchema,
  getMonitorStateArgsSchema,
  waitForStateArgsSchema,
  nuclearResetArgsSchema,
  continueExecutionArgsSchema,
] as const;

const checkpointLabels = new Map<number, string>();

const debugOperationHandlers: OperationHandlerMap<DebugOperationMap> = {
  list_checkpoints: async (_args, ctx) => {
    try {
      listCheckpointsArgsSchema.parse(_args);
      ctx.logger.info("Listing VICE checkpoints");
      const checkpoints = await ctx.client.viceCheckpointList();
      return jsonResult(
        { checkpoints: checkpoints.map((cp) => formatCheckpoint(cp, checkpointLabels.get(cp.id))) },
        { success: true, count: checkpoints.length },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  get_checkpoint: async (args, ctx) => {
    try {
      const parsed = getCheckpointArgsSchema.parse(args);
      const checkpoint = await ctx.client.viceCheckpointGet(parsed.id);
      return jsonResult(
        { checkpoint: formatCheckpoint(checkpoint, checkpointLabels.get(checkpoint.id)) },
        { success: true },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  create_checkpoint: async (args, ctx) => {
    try {
      const parsed = createCheckpointArgsSchema.parse(args);
      const start = parseAddress(parsed.address, "address");
      const end = parsed.endAddress ? parseAddress(parsed.endAddress, "endAddress") : start;
      const operations = parsed.operations ?? ({} as CheckpointOperationsRecord);
      const created = await ctx.client.viceCheckpointCreate({
        start,
        end,
        stopOnHit: parsed.stopOnHit ?? true,
        enabled: parsed.enabled ?? true,
        temporary: parsed.temporary ?? false,
        operations: {
          execute: operations.execute !== false,
          load: operations.load === true,
          store: operations.store === true,
        },
        memspace: normaliseMemspace(parsed.memspace),
      });
      if (parsed.label) {
        checkpointLabels.set(created.id, parsed.label);
      }
      ctx.logger.info("Created VICE checkpoint", { id: created.id, start: formatAddress(created.start), label: parsed.label });
      return jsonResult(
        { checkpoint: formatCheckpoint(created, checkpointLabels.get(created.id)) },
        { success: true, id: created.id },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  delete_checkpoint: async (args, ctx) => {
    try {
      const parsed = deleteCheckpointArgsSchema.parse(args);
      await ctx.client.viceCheckpointDelete(parsed.id);
      checkpointLabels.delete(parsed.id);
      ctx.logger.info("Deleted VICE checkpoint", { id: parsed.id });
      return textResult(`Deleted checkpoint ${parsed.id}.`, { success: true, id: parsed.id });
    } catch (error) {
      return handleToolError(error);
    }
  },
  toggle_checkpoint: async (args, ctx) => {
    try {
      const parsed = toggleCheckpointArgsSchema.parse(args);
      await ctx.client.viceCheckpointToggle(parsed.id, parsed.enabled);
      ctx.logger.info(parsed.enabled ? "Enabled VICE checkpoint" : "Disabled VICE checkpoint", { id: parsed.id });
      return textResult(
        `Checkpoint ${parsed.id} ${parsed.enabled ? "enabled" : "disabled"}.`,
        { success: true, id: parsed.id, enabled: parsed.enabled },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  set_condition: async (args, ctx) => {
    try {
      const parsed = setConditionArgsSchema.parse(args);
      await ctx.client.viceCheckpointSetCondition(parsed.id, parsed.expression);
      ctx.logger.info("Updated checkpoint condition", { id: parsed.id });
      return textResult(
        `Updated condition for checkpoint ${parsed.id}.`,
        { success: true, id: parsed.id },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  list_registers: async (args, ctx) => {
    try {
      const parsed = listRegistersArgsSchema.parse(args);
      const memspace = normaliseMemspace(parsed.memspace);
      const metadata = await ctx.client.viceRegistersAvailable(memspace);
      return jsonResult(
        {
          memspace,
          registers: metadata.map((entry) => ({
            id: entry.id,
            name: entry.name,
            bits: entry.bits,
            size: entry.size,
          })),
        },
        { success: true, count: metadata.length, memspace },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  get_registers: async (args, ctx) => {
    try {
      const parsed = getRegistersArgsSchema.parse(args);
      const memspace = normaliseMemspace(parsed.memspace);
      const metadata = await ctx.client.viceRegistersAvailable(memspace);
      const values = await ctx.client.viceRegistersGet(memspace);
      const metadataById = new Map(metadata.map((entry) => [entry.id, entry]));
      let filtered = values;
      if (parsed.registers && parsed.registers.length > 0) {
        const requested = buildRegisterPredicate(parsed.registers, metadataById);
        filtered = values.filter((value) => requested(value.id));
      }
      return jsonResult(
        {
          memspace,
          registers: filtered.map((value) => {
            const meta = metadataById.get(value.id);
            return {
              id: value.id,
              name: meta?.name,
              bits: meta?.bits,
              size: value.size,
              value: value.value,
            };
          }),
        },
        { success: true, count: filtered.length, memspace },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  set_registers: async (args, ctx) => {
    try {
      const parsed = setRegistersArgsSchema.parse(args);
      const memspace = normaliseMemspace(parsed.memspace);
      const metadata = await ctx.client.viceRegistersAvailable(memspace);
      const writes = parsed.writes.map((entry) => {
        if (!entry.name && entry.id === undefined) {
          throw new ToolValidationError("Each write must specify a name or id.", { path: "$.writes" });
        }
        return entry;
      });
      const updated = await ctx.client.viceRegistersSet(writes, { memspace, metadata });
      const metadataById = new Map(metadata.map((entry) => [entry.id, entry]));
      return jsonResult(
        {
          memspace,
          registers: updated.map((value) => {
            const meta = metadataById.get(value.id);
            return {
              id: value.id,
              name: meta?.name,
              bits: meta?.bits,
              size: value.size,
              value: value.value,
            };
          }),
        },
        { success: true, count: updated.length, memspace },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  step: async (args, ctx) => {
    try {
      const parsed = stepArgsSchema.parse(args);
      const count = parsed.count ?? 1;
      const stepOver = parsed.mode === "over";
      await ctx.client.viceStepInstructions(count, { stepOver });
      ctx.logger.info("Stepped instructions", { count, stepOver });
      return textResult(
        `Stepped ${count} instruction${count === 1 ? "" : "s"}${stepOver ? " (over)" : ""}.`,
        { success: true, count, mode: stepOver ? "over" : "into" },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  step_return: async (args, ctx) => {
    try {
      stepReturnArgsSchema.parse(args);
      await ctx.client.viceStepReturn();
      ctx.logger.info("Stepped until return");
      return textResult("Continued execution until current routine return.", { success: true });
    } catch (error) {
      return handleToolError(error);
    }
  },
  get_monitor_state: async (args, ctx) => {
    try {
      const parsed = getMonitorStateArgsSchema.parse(args);
      const memspace = normaliseMemspace(parsed.memspace);
      const [metadata, values] = await Promise.all([
        ctx.client.viceRegistersAvailable(memspace),
        ctx.client.viceRegistersGet(memspace),
      ]);
      const metadataById = new Map(metadata.map((m) => [m.id, m]));
      const registers = values.map((v) => {
        const meta = metadataById.get(v.id);
        return { id: v.id, name: meta?.name, bits: meta?.bits, size: v.size, value: v.value };
      });
      const pc = registers.find((r) => r.name?.toUpperCase() === "PC");
      ctx.logger.info("Read monitor state", { memspace, pc: pc ? formatAddress(pc.value) : "unknown" });
      return jsonResult(
        { memspace, registers, pc: pc ? formatAddress(pc.value) : undefined },
        { success: true, memspace, count: registers.length },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  wait_for_state: async (args, ctx) => {
    try {
      const parsed = waitForStateArgsSchema.parse(args);
      const timeoutMs = parsed.timeoutMs ?? 5000;
      const pollMs = parsed.pollMs ?? 100;
      const targetPC = parsed.expectedPC ? parseAddress(parsed.expectedPC, "expectedPC") : undefined;
      const metadata = await ctx.client.viceRegistersAvailable(0);
      const metadataById = new Map(metadata.map((m) => [m.id, m]));
      const pcId = metadata.find((m) => m.name.toUpperCase() === "PC")?.id;
      const deadline = Date.now() + timeoutMs;
      let values: import("../vice/viceClient.js").ViceRegisterValue[] = [];
      let currentPC: number | undefined;
      while (Date.now() < deadline) {
        values = await ctx.client.viceRegistersGet(0);
        currentPC = pcId !== undefined ? values.find((v) => v.id === pcId)?.value : undefined;
        if (targetPC === undefined || currentPC === targetPC) {
          break;
        }
        await new Promise<void>((res) => setTimeout(res, pollMs));
      }
      const matched = targetPC === undefined || currentPC === targetPC;
      const regs = values.map((v) => {
        const meta = metadataById.get(v.id);
        return { id: v.id, name: meta?.name, bits: meta?.bits, size: v.size, value: v.value };
      });
      ctx.logger.info("wait_for_state settled", { matched, pc: currentPC !== undefined ? formatAddress(currentPC) : "unknown" });
      return jsonResult(
        {
          matched,
          timedOut: !matched,
          pc: currentPC !== undefined ? formatAddress(currentPC) : undefined,
          registers: regs,
        },
        { success: true, matched },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  nuclear_reset: async (args, ctx) => {
    try {
      nuclearResetArgsSchema.parse(args);
      ctx.logger.info("Performing nuclear reset of VICE process");
      await ctx.client.viceNuclearReset();
      checkpointLabels.clear();
      return textResult("VICE process stopped and restarted.", { success: true });
    } catch (error) {
      return handleToolError(error);
    }
  },
  continue_execution: async (args, ctx) => {
    try {
      continueExecutionArgsSchema.parse(args);
      await ctx.client.viceExitMonitor();
      ctx.logger.info("Exited Binary Monitor — CPU resumed");
      return textResult("Execution resumed.", { success: true });
    } catch (error) {
      return handleToolError(error);
    }
  },
};

const debugOperationDispatcher = createOperationDispatcher<DebugOperationMap>(
  "c64_debug",
  debugOperationHandlers,
);

export const debugModuleGroup = defineToolModule({
  domain: "debug",
  summary: "VICE Binary Monitor debugger operations (breakpoints, registers, stepping).",
  resources: ["c64://assembly/6510-spec", "c64://memory/map"],
  prompts: ["assembly-program", "memory-debug"],
  defaultTags: ["debug", "vice"],
  workflowHints: [
    "Use debugger tools after pausing execution so memory and screen reads remain stable.",
    "Communicate breakpoint effects clearly and restore original state when toggling them.",
  ],
  supportedPlatforms: ["vice"],
  tools: [
    {
      name: "c64_debug",
      description: "Grouped entry point for VICE debugger operations (breakpoints, registers, stepping).",
      summary: "Manage breakpoints, inspect registers, and step through code on the VICE backend.",
      inputSchema: discriminatedUnionSchema({
        description: "Available debugger operations.",
        variants: debugOperationSchemas.map((schema) => schema.jsonSchema),
      }),
      tags: ["debug", "breakpoint", "registers", "grouped"],
      examples: [
        {
          name: "List checkpoints",
          description: "Show all breakpoints defined in the emulator.",
          arguments: { op: "list_checkpoints" },
        },
        {
          name: "Step over instruction",
          description: "Advance one instruction without entering subroutines.",
          arguments: { op: "step", mode: "over" },
        },
        {
          name: "Inspect registers",
          description: "Read CPU registers from memspace 0 (default).",
          arguments: { op: "get_registers" },
        },
        {
          name: "Create labelled breakpoint",
          description: "Set a breakpoint at $0810 with a descriptive label.",
          arguments: { op: "create_checkpoint", address: "$0810", label: "entry_point" },
        },
        {
          name: "Get monitor state",
          description: "Read current CPU state including all registers and PC.",
          arguments: { op: "get_monitor_state" },
        },
        {
          name: "Wait for PC",
          description: "Poll until PC reaches $0810 or 5 s elapses.",
          arguments: { op: "wait_for_state", expectedPC: "$0810", timeoutMs: 5000 },
        },
        {
          name: "Nuclear reset",
          description: "Kill and restart the VICE process, clearing all state.",
          arguments: { op: "nuclear_reset" },
        },
        {
          name: "Continue execution",
          description: "Exit the BM monitor and let the CPU run freely.",
          arguments: { op: "continue_execution" },
        },
      ],
      execute: debugOperationDispatcher,
    },
  ],
});

function handleToolError(error: unknown) {
  if (error instanceof ToolError) {
    return toolErrorResult(error);
  }
  return unknownErrorResult(error);
}

function formatCheckpoint(checkpoint: import("../vice/viceClient.js").ViceCheckpoint, label?: string) {
  return {
    id: checkpoint.id,
    ...(label ? { label } : {}),
    start: formatAddress(checkpoint.start),
    end: formatAddress(checkpoint.end),
    enabled: checkpoint.enabled,
    stopOnHit: checkpoint.stopOnHit,
    temporary: checkpoint.temporary,
    hitCount: checkpoint.hitCount,
    ignoreCount: checkpoint.ignoreCount,
    operations: {
      execute: checkpoint.operations.execute,
      load: checkpoint.operations.load,
      store: checkpoint.operations.store,
    },
    memspace: checkpoint.memspace,
    hasCondition: checkpoint.hasCondition,
  };
}

function formatAddress(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function parseAddress(value: string, label: string): number {
  const trimmed = value.trim();
  let radix = 10;
  let literal = trimmed;
  if (trimmed.startsWith("$")) {
    radix = 16;
    literal = trimmed.slice(1);
  } else if (trimmed.toLowerCase().startsWith("0x")) {
    radix = 16;
    literal = trimmed.slice(2);
  }
  const parsed = Number.parseInt(literal, radix);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) {
    throw new ToolValidationError(`Invalid ${label}`, { path: `$.${label}` });
  }
  return parsed;
}

function normaliseMemspace(value: number | undefined): import("../vice/viceClient.js").ViceMemspace {
  const allowed = [0, 1, 2, 3, 4] as const;
  if (value === undefined) {
    return 0;
  }
  const numeric = Number(value);
  if (allowed.includes(numeric as typeof allowed[number])) {
    return numeric as import("../vice/viceClient.js").ViceMemspace;
  }
  throw new ToolValidationError("memspace must be between 0 and 4", { path: "$.memspace" });
}

function buildRegisterPredicate(
  selectors: readonly RegisterSelector[],
  metadataById: Map<number, { name: string }>,
): (id: number) => boolean {
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const selector of selectors) {
    if (selector.id !== undefined) {
      ids.add(selector.id);
    }
    if (selector.name) {
      names.add(selector.name.toLowerCase());
    }
  }
  return (id: number) => {
    if (ids.has(id)) {
      return true;
    }
    const meta = metadataById.get(id);
    if (!meta) {
      return false;
    }
    return names.has(meta.name.toLowerCase());
  };
}
