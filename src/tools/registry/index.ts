import type { ToolDescriptor, ToolExecutionContext, ToolModule, ToolRunResult } from "../types.js";
import { getPlatformStatus, setPlatform } from "../../platform.js";
import { programModule } from "./program.js";
import { memoryModuleGroup as memoryModule } from "./memory.js";
import { soundModuleGroup as soundModule } from "./sound.js";
import { systemModuleGroup as systemModule } from "./system.js";
import { platformModuleGroup } from "./platform.js";
import { graphicsModuleGroup as graphicsModule } from "./graphics.js";
import { ragModuleGroup as ragModule } from "./rag.js";
import { diskModuleGroup as diskModule } from "./disk.js";
import { driveModuleGroup as driveModule } from "./drive.js";
import { printerModuleGroup as printerModule } from "./printer.js";
import { configModuleGroup as configModule } from "./config.js";
import { extractModule } from "./extract.js";
import { streamModule } from "./stream.js";
import { debugModuleGroup as debugModule } from "../debug.js";
import { viceModuleGroup as viceModule } from "../vice.js";
import { inputModuleGroup as inputModule } from "./input.js";
import { batchModuleGroup as batchModule } from "./batch.js";

interface RegisteredTool {
  readonly module: ToolModule;
  readonly descriptor: ToolDescriptor;
}

export interface ToolModuleDescriptor {
  readonly domain: string;
  readonly summary: string;
  readonly defaultTags: readonly string[];
  readonly workflowHints: readonly string[];
  readonly tools: readonly ToolDescriptor[];
}

const modules: readonly ToolModule[] = [
  programModule,
  memoryModule,
  soundModule,
  systemModule,
  platformModuleGroup,
  graphicsModule,
  ragModule,
  diskModule,
  driveModule,
  printerModule,
  configModule,
  extractModule,
  streamModule,
  debugModule,
  viceModule,
  inputModule,
  batchModule,
];

const toolMap: Map<string, RegisteredTool> = new Map();

for (const module of modules) {
  for (const descriptor of module.describeTools()) {
    if (toolMap.has(descriptor.name)) {
      throw new Error(`Duplicate tool name detected while registering modules: ${descriptor.name}`);
    }
    toolMap.set(descriptor.name, { module, descriptor });
  }
}

export const toolRegistry = {
  list(): readonly ToolDescriptor[] {
    return Array.from(toolMap.values(), (entry) => entry.descriptor);
  },

  async invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
    const enrichedCtx: ToolExecutionContext = {
      ...ctx,
      platform: ctx.platform ?? getPlatformStatus(),
      setPlatform: ctx.setPlatform ?? setPlatform,
    };

    const entry = toolMap.get(name);
    if (!entry) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return entry.module.invoke(name, args, enrichedCtx);
  },
};

export function describeToolModules(): readonly ToolModuleDescriptor[] {
  return modules.map((module) => ({
    domain: module.domain,
    summary: module.summary,
    defaultTags: module.defaultTags,
    workflowHints: module.workflowHints ?? [],
    tools: module.describeTools(),
  }));
}
