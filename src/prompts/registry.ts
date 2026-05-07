import { listKnowledgeResources } from "../rag/knowledgeIndex.js";
import type { KnowledgeResourceDefinition } from "../rag/knowledgeIndex.js";
import { RESOURCE_URIS } from "../rag/resourceUris.js";
import { toolRegistry } from "../tools/registry/index.js";
import type { ToolDescriptor } from "../tools/types.js";

export interface PromptDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly requiredResources: readonly string[];
  readonly optionalResources?: readonly string[];
  readonly tools: readonly string[];
  readonly tags?: readonly string[];
}

export interface PromptArgumentDefinition {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly options?: readonly string[];
}

export interface PromptSegment {
  readonly id: string;
  readonly role: "assistant" | "user" | "system";
  readonly content: string;
}

interface PromptDefinition {
  readonly descriptor: PromptDescriptor;
  readonly skillPath: string;
  readonly routingNotes: readonly string[];
  readonly arguments?: readonly PromptArgumentDefinition[];
  readonly prepareArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  readonly selectOptionalResources?: (args: Record<string, unknown>) => readonly string[];
  readonly selectTools?: (args: Record<string, unknown>) => readonly string[];
  readonly renderRoutingNotes?: (args: Record<string, unknown>) => readonly string[];
}

export interface PromptListEntry {
  readonly descriptor: PromptDescriptor;
  readonly arguments?: readonly PromptArgumentDefinition[];
}

export interface ResolvedPrompt {
  readonly name: string;
  readonly description: string;
  readonly arguments?: Record<string, unknown>;
  readonly messages: readonly PromptSegment[];
  readonly resources: readonly KnowledgeResourceDefinition[];
  readonly tools: readonly ToolDescriptor[];
}

export interface PromptRegistry {
  list(): readonly PromptListEntry[];
  resolve(name: string, args: Record<string, unknown>): ResolvedPrompt;
}

type AssemblyHardware = "sid" | "vic" | "cia" | "multi";
type GraphicsMode = "text" | "multicolour" | "bitmap" | "sprite";
type PrinterType = "commodore" | "epson";

const ASSEMBLY_HARDWARE_NOTES: Record<AssemblyHardware, readonly string[]> = {
  sid: [
    "When routing this request, keep SID register usage, voice allocation, and timing side effects in scope.",
  ],
  vic: [
    "When routing this request, keep VIC-II register usage, raster timing, and display-mode side effects in scope.",
  ],
  cia: [
    "When routing this request, keep CIA timer, interrupt, and I/O side effects in scope.",
  ],
  multi: [
    "When routing this request, keep cross-chip coordination across SID, VIC-II, and CIA state in scope.",
  ],
};

const GRAPHICS_MODE_NOTES: Record<GraphicsMode, readonly string[]> = {
  text: [
    "When routing this request, keep screen-code layout, PETSCII constraints, and colour RAM updates in scope.",
  ],
  multicolour: [
    "When routing this request, keep multicolour cell constraints, palette choices, and VIC-II mode flags in scope.",
  ],
  bitmap: [
    "When routing this request, keep bitmap memory layout, colour sources, and frame-capture validation in scope.",
  ],
  sprite: [
    "When routing this request, keep sprite data layout, sprite pointers, enable masks, and expansion flags in scope.",
  ],
};

const ROUTING_CORE_SEGMENT: PromptSegment = {
  id: "routing/core",
  role: "assistant",
  content: [
    "Prompts in this repository define intent and routing only.",
    "Execution logic, validation steps, and safety rules live exclusively in `.github/skills/*/SKILL.md`.",
    `When the request targets the \`vice\` backend, read \`${RESOURCE_URIS.vice.binaryMonitorSpec}\` before executing the skill so Binary Monitor single-client behaviour, trap/resume semantics, and monitor-side side effects stay in scope.`,
    "Use the referenced skill, extract missing inputs from the user request, execute the skill, and summarize the outcome.",
  ].join("\n"),
};

function buildSkillRoutingSegment(skillPath: string, routingNotes: readonly string[]): PromptSegment {
  return {
    id: `routing/${skillPath}`,
    role: "assistant",
    content: [
      `Use the skill defined in \`${skillPath}\` as the single source of truth for execution.`,
      ...routingNotes,
    ].join("\n"),
  };
}

function mergeUniqueStrings(base: readonly string[], extras?: readonly string[]): string[] {
  if (!extras || extras.length === 0) {
    return [...base];
  }

  const seen = new Set(base);
  const combined: string[] = [...base];
  for (const value of extras) {
    if (!seen.has(value)) {
      seen.add(value);
      combined.push(value);
    }
  }
  return combined;
}

function prepareAssemblyArgs(args: Record<string, unknown>): Record<string, unknown> {
  const hardware = args.hardware;
  if (hardware === undefined || hardware === null) {
    return {};
  }
  if (typeof hardware !== "string") {
    throw new Error("assembly-program prompt argument \"hardware\" must be a string");
  }
  const normalized = hardware.trim().toLowerCase();
  const allowed: AssemblyHardware[] = ["sid", "vic", "cia", "multi"];
  if (!allowed.includes(normalized as AssemblyHardware)) {
    throw new Error(
      `assembly-program prompt does not support hardware \"${hardware}\". Expected one of: ${allowed.join(", ")}`,
    );
  }
  return { hardware: normalized };
}

function prepareGraphicsArgs(args: Record<string, unknown>): Record<string, unknown> {
  const mode = args.mode;
  if (mode === undefined || mode === null) {
    return {};
  }
  if (typeof mode !== "string") {
    throw new Error("graphics-demo prompt argument \"mode\" must be a string");
  }
  const normalized = mode.trim().toLowerCase();
  const allowed: GraphicsMode[] = ["text", "multicolour", "bitmap", "sprite"];
  if (!allowed.includes(normalized as GraphicsMode)) {
    throw new Error(
      `graphics-demo prompt does not support mode \"${mode}\". Expected one of: ${allowed.join(", ")}`,
    );
  }
  return { mode: normalized };
}

function preparePrinterArgs(args: Record<string, unknown>): Record<string, unknown> {
  const printerType = args.printerType;
  if (printerType === undefined || printerType === null) {
    return {};
  }
  if (typeof printerType !== "string") {
    throw new Error("printer-job prompt argument \"printerType\" must be a string");
  }
  const normalized = printerType.trim().toLowerCase();
  const allowed: PrinterType[] = ["commodore", "epson"];
  if (!allowed.includes(normalized as PrinterType)) {
    throw new Error(
      `printer-job prompt does not support printerType \"${printerType}\". Expected one of: ${allowed.join(", ")}`,
    );
  }
  return { printerType: normalized };
}

export function createPromptRegistry(): PromptRegistry {
  const knowledgeByUri = new Map(
    listKnowledgeResources().map((resource) => [resource.uri, resource] as const),
  );
  const toolByName = new Map(toolRegistry.list().map((tool) => [tool.name, tool] as const));

  const definitions: readonly PromptDefinition[] = [
    {
      descriptor: {
        name: "hello-world",
        title: "Hello World Workflow",
        description: "Route ultra-fast hello-world and smoke-test requests to the canonical greeting skill.",
        requiredResources: [RESOURCE_URIS.guide.bootstrap, RESOURCE_URIS.guide.fastPaths, RESOURCE_URIS.guide.index],
        optionalResources: [],
        tools: ["c64_program"],
        tags: ["hello", "demo", "greeting", "smoke-test"],
      },
      skillPath: ".github/skills/hello-world/SKILL.md",
      routingNotes: [
        "Use this prompt for the narrowest hello-world, greeting, or smoke-test path.",
        "Backend-pinned requests such as `vice: write a small BASIC program that clears the screen and prints HELLO VICE` should prefer this prompt over the bespoke BASIC prompt.",
        "`c64_program` is a grouped tool, so every direct invocation must include `op`; for this prompt the canonical call is `{ op: \"cross_platform_greeting\", ... }`.",
        "If the current agent cannot directly call `c64_program`, immediately delegate the same request to the `C64` agent instead of exploring repository files or manifests.",
        "For visible single-backend VICE greetings, prefer the no-probe fast path unless the user explicitly asks for screenshots or verification.",
      ],
    },
    {
      descriptor: {
        name: "basic-program",
        title: "BASIC Program Workflow",
        description: "Route bespoke Commodore BASIC v2 requests to the canonical BASIC skill.",
        requiredResources: [RESOURCE_URIS.basic.spec, RESOURCE_URIS.guide.bootstrap, RESOURCE_URIS.guide.index],
        optionalResources: [RESOURCE_URIS.guide.fastPaths],
        tools: ["c64_program", "c64_memory"],
        tags: ["basic", "program"],
      },
      skillPath: ".github/skills/basic-program/SKILL.md",
      routingNotes: [
        "This prompt is for bespoke BASIC programs rather than generic quick demos.",
        "If the request collapses to a hello-world or smoke test, the selected skill should redirect to the hello-world flow.",
      ],
    },
    {
      descriptor: {
        name: "cross-platform-demo",
        title: "Cross-Platform Demo Workflow",
        description: "Route quick visible demo requests to the cross-platform demo skill.",
        requiredResources: [RESOURCE_URIS.guide.bootstrap, RESOURCE_URIS.guide.fastPaths, RESOURCE_URIS.guide.index],
        optionalResources: [],
        tools: ["c64_program"],
        tags: ["demo", "platform", "greeting"],
      },
      skillPath: ".github/skills/cross-platform-demo/SKILL.md",
      routingNotes: [
        "This prompt is for the shortest visible confirmation path across one or more configured backends.",
        "`c64_program` is a grouped tool, so always call it with `op: \"cross_platform_greeting\"` for this workflow.",
      ],
    },
    {
      descriptor: {
        name: "preset-music-demo",
        title: "Preset Music Demo Workflow",
        description: "Route quick recognizable tune requests to the SID music skill.",
        requiredResources: [RESOURCE_URIS.sound.sid.spec, RESOURCE_URIS.sound.sidwave.spec, RESOURCE_URIS.guide.fastPaths],
        optionalResources: [RESOURCE_URIS.sound.sid.bestPractices],
        tools: ["c64_sound"],
        tags: ["sid", "music", "demo"],
      },
      skillPath: ".github/skills/sid-music/SKILL.md",
      routingNotes: [
        "This prompt is for the built-in preset playback path, using `fuer_elise` as the canonical preset.",
      ],
    },
    {
      descriptor: {
        name: "assembly-program",
        title: "Assembly Program Workflow",
        description: "Route 6502/6510 routine requests to the canonical assembly skill.",
        requiredResources: [RESOURCE_URIS.assembly.spec6510, RESOURCE_URIS.graphics.vic.spec, RESOURCE_URIS.sound.sid.spec, RESOURCE_URIS.guide.bootstrap],
        optionalResources: [RESOURCE_URIS.sound.sid.bestPractices],
        tools: ["c64_program", "c64_memory"],
        tags: ["assembly", "program"],
      },
      skillPath: ".github/skills/assembly-program/SKILL.md",
      routingNotes: [
        "Use this prompt when the user needs assembly-level control, IRQ handling, or direct register work.",
      ],
      arguments: [
        {
          name: "hardware",
          description: "Optional focus area for the routine (sid, vic, cia, or multi for combined work).",
          options: ["sid", "vic", "cia", "multi"],
        },
      ],
      prepareArgs: prepareAssemblyArgs,
      selectOptionalResources: (args) => {
        const hardware = args.hardware as AssemblyHardware | undefined;
        return hardware === "sid" || hardware === "multi"
          ? [RESOURCE_URIS.sound.sid.bestPractices]
          : [];
      },
      renderRoutingNotes: (args) => {
        const hardware = args.hardware as AssemblyHardware | undefined;
        return hardware
          ? [
              `Prompt argument hardware is set to \`${hardware}\`; keep that focus while executing the skill.`,
              ...ASSEMBLY_HARDWARE_NOTES[hardware],
            ]
          : [];
      },
    },
    {
      descriptor: {
        name: "sid-music",
        title: "SID Composition Workflow",
        description: "Route SID playback and composition work to the canonical SID skill.",
        requiredResources: [
          RESOURCE_URIS.sound.sid.spec,
          RESOURCE_URIS.sound.sidwave.spec,
          RESOURCE_URIS.sound.sid.fileFormat,
          RESOURCE_URIS.sound.sid.bestPractices,
        ],
        optionalResources: [RESOURCE_URIS.guide.fastPaths],
        tools: ["c64_sound"],
        tags: ["sid", "music"],
      },
      skillPath: ".github/skills/sid-music/SKILL.md",
      routingNotes: [
        "Use this prompt for custom SID work or when the user wants to move beyond the preset demo path.",
      ],
    },
    {
      descriptor: {
        name: "graphics-demo",
        title: "Graphics Demo Workflow",
        description: "Route graphics requests to the canonical graphics skill.",
        requiredResources: [RESOURCE_URIS.graphics.vic.spec, RESOURCE_URIS.guide.bootstrap],
        optionalResources: [RESOURCE_URIS.assembly.spec6510, RESOURCE_URIS.graphics.characterSet, RESOURCE_URIS.graphics.petscii.styleGuide],
        tools: ["c64_program", "c64_memory", "c64_graphics"],
        tags: ["graphics", "vic"],
      },
      skillPath: ".github/skills/graphics-demo/SKILL.md",
      routingNotes: [
        "Use this prompt for PETSCII, sprite, bitmap, or frame-capture work.",
      ],
      arguments: [
        {
          name: "mode",
          description: "Target VIC-II technique (text, multicolour, bitmap, or sprite).",
          options: ["text", "multicolour", "bitmap", "sprite"],
        },
      ],
      prepareArgs: prepareGraphicsArgs,
      renderRoutingNotes: (args) => {
        const mode = args.mode as GraphicsMode | undefined;
        return mode
          ? [
              `Prompt argument mode is set to \`${mode}\`; keep that mode constraint while executing the skill.`,
              ...GRAPHICS_MODE_NOTES[mode],
            ]
          : [];
      },
    },
    {
      descriptor: {
        name: "printer-job",
        title: "Printer Job Workflow",
        description: "Route printer work to the canonical printer skill.",
        requiredResources: [RESOURCE_URIS.printer.spec, RESOURCE_URIS.printer.promptGuide],
        optionalResources: [
          RESOURCE_URIS.printer.commodore.text,
          RESOURCE_URIS.printer.commodore.bitmap,
          RESOURCE_URIS.printer.epson.text,
          RESOURCE_URIS.printer.epson.bitmap,
        ],
        tools: ["c64_printer"],
        tags: ["printer"],
      },
      skillPath: ".github/skills/printer-job/SKILL.md",
      routingNotes: [
        "Use this prompt when the user needs Commodore or Epson printer workflows.",
      ],
      arguments: [
        {
          name: "printerType",
          description: "Select Commodore (device 4) or Epson FX workflow helpers.",
          options: ["commodore", "epson"],
        },
      ],
      prepareArgs: preparePrinterArgs,
      selectOptionalResources: (args) => {
        const printerType = args.printerType as PrinterType | undefined;
        if (printerType === "commodore") {
          return [RESOURCE_URIS.printer.commodore.text, RESOURCE_URIS.printer.commodore.bitmap];
        }
        if (printerType === "epson") {
          return [RESOURCE_URIS.printer.epson.text, RESOURCE_URIS.printer.epson.bitmap];
        }
        return [];
      },
      renderRoutingNotes: (args) => {
        const printerType = args.printerType as PrinterType | undefined;
        return printerType
          ? [`Prompt argument printerType is set to \`${printerType}\`; preserve that choice while executing the skill.`]
          : [];
      },
    },
    {
      descriptor: {
        name: "memory-debug",
        title: "Memory Debug Workflow",
        description: "Route reversible memory inspection or patching work to the canonical memory skill.",
        requiredResources: [RESOURCE_URIS.guide.bootstrap, RESOURCE_URIS.assembly.spec6510, RESOURCE_URIS.guide.index],
        optionalResources: [],
        tools: ["c64_memory", "c64_system"],
        tags: ["memory", "debug"],
      },
      skillPath: ".github/skills/memory-debug/SKILL.md",
      routingNotes: [
        "Use this prompt for screen reads, memory reads, polling, and carefully scoped writes.",
      ],
    },
    {
      descriptor: {
        name: "drive-manager",
        title: "Drive Manager Workflow",
        description: "Route disk-image and drive-state requests to the canonical drive skill.",
        requiredResources: [RESOURCE_URIS.guide.bootstrap],
        optionalResources: [],
        tools: ["c64_disk", "c64_drive"],
        tags: ["drive", "storage"],
      },
      skillPath: ".github/skills/drive-manager/SKILL.md",
      routingNotes: [
        "Use this prompt for image mounts, blank media creation, drive resets, and mode changes.",
      ],
    },
  ];

  const definitionByName = new Map(definitions.map((def) => [def.descriptor.name, def] as const));

  return {
    list(): readonly PromptListEntry[] {
      return definitions.map((definition) => ({
        descriptor: definition.descriptor,
        arguments: definition.arguments,
      }));
    },
    resolve(name: string, args: Record<string, unknown>): ResolvedPrompt {
      const definition = definitionByName.get(name);
      if (!definition) {
        throw new Error(`Unknown prompt: ${name}`);
      }

      const rawArgs = args ?? {};
      const prepared = definition.prepareArgs ? definition.prepareArgs(rawArgs) : {};
      const argumentValues = Object.keys(prepared).length > 0 ? prepared : undefined;

      const requiredResourceUris = definition.descriptor.requiredResources;
      const optionalBase = definition.descriptor.optionalResources ?? [];
      const optionalExtra = definition.selectOptionalResources
        ? definition.selectOptionalResources(prepared)
        : [];
      const optionalUris = mergeUniqueStrings(optionalBase, optionalExtra);
      const resourceUris = mergeUniqueStrings(requiredResourceUris, optionalUris);

      const resources: KnowledgeResourceDefinition[] = resourceUris
        .map((uri) => {
          const resource = knowledgeByUri.get(uri);
          if (!resource) {
            if (requiredResourceUris.includes(uri)) {
              throw new Error(`Prompt ${name} references unknown knowledge resource: ${uri}`);
            }
            return undefined;
          }
          return resource;
        })
        .filter((value): value is KnowledgeResourceDefinition => Boolean(value));

      if (resources.length < requiredResourceUris.length) {
        throw new Error(`Prompt ${name} missing required knowledge resources after resolution`);
      }

      const toolNames = mergeUniqueStrings(
        definition.descriptor.tools,
        definition.selectTools ? definition.selectTools(prepared) : undefined,
      );
      const tools: ToolDescriptor[] = toolNames.map((toolName) => {
        const tool = toolByName.get(toolName);
        if (!tool) {
          throw new Error(`Prompt ${name} references unknown tool: ${toolName}`);
        }
        return tool;
      });

      const routingNotes = definition.renderRoutingNotes
        ? [...definition.routingNotes, ...definition.renderRoutingNotes(prepared)]
        : [...definition.routingNotes];
      const messages: PromptSegment[] = [
        ROUTING_CORE_SEGMENT,
        buildSkillRoutingSegment(definition.skillPath, routingNotes),
      ];

      return {
        name: definition.descriptor.name,
        description: definition.descriptor.description,
        arguments: argumentValues,
        messages,
        resources,
        tools,
      };
    },
  };
}
