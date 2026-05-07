import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_KNOWLEDGE_RESOURCE_URIS, PLATFORM_RESOURCE_URI, RESOURCE_URIS } from "./resourceUris.js";

function generateCharsetQuickref(): string {
  const csvPath = join(process.cwd(), "data/graphics/character-set.csv");
  const csvContent = readFileSync(csvPath, "utf-8");
  const lines = csvContent.trim().split("\n");
  const headers = lines[0].split(",");
  
  let markdown = "# PETSCII Character Set Reference\n\n";
  markdown += "Complete reference of C64 character codes, screen codes, and glyphs.\n\n";
  markdown += "## Character Code Table\n\n";
  markdown += "| Screen Code | PETSCII | Char | Name | Keyboard |\n";
  markdown += "|-------------|---------|------|------|----------|\n";
  
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 8) continue;
    
    const screenCode = parts[0];
    const petsciiCode = parts[2];
    const char = parts[4] || " ";
    const name = parts[6] || "";
    const keyboard = parts[7] || "";
    
    markdown += `| ${screenCode} | ${petsciiCode} | ${char} | ${name} | ${keyboard} |\n`;
  }
  
  markdown += "\n## Usage Notes\n\n";
  markdown += "- **Screen Code**: Value used in screen memory ($0400-$07E7)\n";
  markdown += "- **PETSCII Code**: Value used in BASIC strings and CHR$() function\n";
  markdown += "- **Keyboard**: Key combination to type the character\n";
  markdown += "\n## Common Patterns\n\n";
  markdown += "- Uppercase letters: PETSCII $41-$5A (A-Z)\n";
  markdown += "- Lowercase letters: PETSCII $61-$7A (a-z) in graphics mode\n";
  markdown += "- Digits: PETSCII $30-$39 (0-9)\n";
  markdown += "- Graphics characters: Screen codes $60-$7F and $E0-$FF\n";
  
  return markdown;
}

export type ResourcePriority = "critical" | "reference" | "supplemental";

interface BundleResourceDefinition {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly relativePath: string;
  readonly priority: ResourcePriority;
  readonly summary: string;
  readonly prompts: readonly string[];
  readonly tools: readonly string[];
  readonly relatedResources?: readonly string[];
  readonly tags?: readonly string[];
}

interface KnowledgeBundle {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly prompts: readonly string[];
  readonly tools: readonly string[];
  readonly resources: readonly BundleResourceDefinition[];
}

export interface KnowledgeResourceMetadata {
  readonly domain: string;
  readonly priority: ResourcePriority;
  readonly summary: string;
  readonly prompts: readonly string[];
  readonly tools: readonly string[];
  readonly tags: readonly string[];
  readonly bundle: {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly order: number;
  };
  readonly order: number;
  readonly relatedResources: readonly string[];
}

export interface KnowledgeResourceDefinition {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: "text/markdown";
  readonly metadata: KnowledgeResourceMetadata;
  readonly relativePath?: string;
  readonly buildContent?: (resources: readonly KnowledgeResourceDefinition[]) => string;
}

const KNOWLEDGE_BUNDLES: readonly KnowledgeBundle[] = [
  {
    id: "guide",
    title: "Guides & Orientation",
    summary: "Mandatory workflow and safety guidance before issuing any C64 commands.",
    prompts: ["basic-program", "assembly-program", "memory-debug", "cross-platform-demo", "preset-music-demo"],
    tools: ["upload_run_basic", "upload_run_asm", "cross_platform_greeting", "music_play_preset", "read_screen", "read"],
    resources: [
      {
        uri: RESOURCE_URIS.guide.bootstrap,
        name: "Workflow Rules & Best Practices",
        description: "CRITICAL: Mandatory workflow rules for all C64 programming",
        relativePath: "data/context/bootstrap.md",
        priority: "critical",
        summary: "Step-by-step rules for safe automation, verification, and rollback on the C64.",
          prompts: ["basic-program", "assembly-program", "memory-debug", "cross-platform-demo", "preset-music-demo"],
        tools: ["upload_run_basic", "upload_run_asm", "cross_platform_greeting", "music_play_preset", "read_screen", "read"],
        tags: ["workflow", "safety"],
      },
      {
        uri: RESOURCE_URIS.guide.fastPaths,
        name: "Fast Path Workflows",
        description: "Shortest reliable workflows for common C64U and VICE tasks, including dual-backend demos.",
        relativePath: "data/context/fast-paths.md",
        priority: "critical",
        summary: "Condensed routing guide for one-call demos, backend switching, and when to prefer orchestration over manual tool composition.",
        prompts: ["basic-program", "graphics-demo", "cross-platform-demo", "sid-music", "preset-music-demo"],
        tools: ["c64_program", "c64_sound", "c64_select_backend", "c64_memory", "c64_graphics"],
        relatedResources: [RESOURCE_URIS.guide.bootstrap, PLATFORM_RESOURCE_URI],
        tags: ["workflow", "fast-path", "routing"],
      },
    ],
  },
  {
    id: "vice",
    title: "VICE Emulator",
    summary: "Critical Binary Monitor protocol guidance for any workflow that targets the VICE backend.",
    prompts: [
      "hello-world",
      "basic-program",
      "cross-platform-demo",
      "preset-music-demo",
      "assembly-program",
      "sid-music",
      "graphics-demo",
      "memory-debug",
      "drive-manager",
    ],
    tools: ["c64_program", "c64_memory", "c64_debug", "c64_vice", "c64_system"],
    resources: [
      {
        uri: RESOURCE_URIS.vice.binaryMonitorSpec,
        name: "VICE Binary Monitor Specification",
        description: "Critical VICE Binary Monitor reference for emulator-backed workflows and debugger operations.",
        relativePath: "data/vice/vice-binary-monitor-spec.md",
        priority: "critical",
        summary: "Transport framing, single-client constraints, command semantics, and monitor side effects that shape all VICE-backed operations.",
        prompts: [
          "hello-world",
          "basic-program",
          "cross-platform-demo",
          "preset-music-demo",
          "assembly-program",
          "sid-music",
          "graphics-demo",
          "memory-debug",
          "drive-manager",
        ],
        tools: ["c64_program", "c64_memory", "c64_debug", "c64_vice", "c64_system"],
        relatedResources: [
          RESOURCE_URIS.guide.bootstrap,
          RESOURCE_URIS.guide.fastPaths,
          PLATFORM_RESOURCE_URI,
        ],
        tags: ["vice", "binary-monitor", "emulator", "debugger"],
      },
    ],
  },
  {
    id: "languages",
    title: "Programming Languages",
    summary: "Language references required before generating BASIC or 6502 assembly programs.",
    prompts: ["basic-program", "assembly-program"],
    tools: ["upload_run_basic", "upload_run_asm", "read_screen", "read"],
    resources: [
      {
        uri: RESOURCE_URIS.basic.spec,
        name: "Commodore BASIC v2 Specification",
        description: "Complete BASIC v2 reference. READ THIS BEFORE generating any BASIC code!",
        relativePath: "data/basic/basic-spec.md",
        priority: "critical",
        summary: "Token definitions, syntax rules, and device I/O guidance for BASIC v2.",
        prompts: ["basic-program"],
        tools: ["upload_run_basic", "read_screen"],
        relatedResources: [RESOURCE_URIS.guide.bootstrap, RESOURCE_URIS.basic.pitfalls],
        tags: ["basic", "language"],
      },
      {
        uri: RESOURCE_URIS.basic.pitfalls,
        name: "BASIC Pitfalls & Gotchas",
        description: "Common mistakes and gotchas when writing Commodore BASIC v2 programs",
        relativePath: "data/basic/basic-pitfalls.md",
        priority: "reference",
        summary: "Quickref covering quotation handling, line length, tokenization, variable names, and other BASIC traps.",
        prompts: ["basic-program"],
        tools: ["upload_run_basic"],
        relatedResources: [RESOURCE_URIS.basic.spec],
        tags: ["basic", "pitfalls", "quickref"],
      },
      {
        uri: RESOURCE_URIS.assembly.spec6510,
        name: "6502/6510 Assembly Reference",
        description: "Full instruction set and addressing modes. READ THIS BEFORE generating assembly!",
        relativePath: "data/assembly/assembly-spec.md",
        priority: "critical",
        summary: "Official opcode matrix, addressing modes, and zero-page strategy for the 6510 CPU.",
        prompts: ["assembly-program"],
  tools: ["upload_run_asm", "read"],
        relatedResources: [RESOURCE_URIS.guide.bootstrap],
        tags: ["assembly", "language"],
      },
    ],
  },
  {
    id: "audio",
    title: "SID & Audio",
    summary: "All references needed to compose, play, and verify SID music.",
    prompts: ["sid-music"],
    tools: ["c64_sound"],
    resources: [
      {
        uri: RESOURCE_URIS.sound.sid.spec,
        name: "SID Chip Programming Guide",
        description: "Sound Interface Device registers and music programming",
  relativePath: "data/sound/sid-spec.md",
        priority: "critical",
        summary: "Register map, waveform behaviour, and ADSR envelopes for expressive SID playback.",
        prompts: ["sid-music"],
        tools: ["c64_sound"],
        relatedResources: [RESOURCE_URIS.sound.sidwave.spec, RESOURCE_URIS.sound.sid.fileFormat],
        tags: ["sid", "audio"],
      },
      {
        uri: RESOURCE_URIS.sound.sidwave.spec,
        name: "SIDWAVE Music Format Specification",
        description: "YAML/JSON music composition format for SID chip",
  relativePath: "data/sound/sidwave.md",
        priority: "reference",
        summary: "Defines the SIDWAVE interchange format used by the SID composer workflow.",
        prompts: ["sid-music"],
        tools: ["c64_sound"],
        relatedResources: [RESOURCE_URIS.sound.sid.spec, RESOURCE_URIS.sound.sid.fileFormat],
        tags: ["sid", "format"],
      },
      {
        uri: RESOURCE_URIS.sound.sid.fileFormat,
        name: "SID File Structure Reference",
        description: "Breakdown of the SID file format layout and metadata",
  relativePath: "data/sound/sid-file-structure.md",
        priority: "reference",
        summary: "Explains PSID/RSID headers, metadata blocks, and compatibility notes for imported music.",
        prompts: ["sid-music"],
        tools: ["c64_sound"],
        relatedResources: [RESOURCE_URIS.sound.sid.spec, RESOURCE_URIS.sound.sidwave.spec],
        tags: ["sid", "format"],
      },
      {
        uri: RESOURCE_URIS.sound.sid.bestPractices,
        name: "SID Programming Best Practices",
        description: "Expressive SID composition defaults, ADSR guidance, and musical phrasing tips.",
  relativePath: "data/sound/sid-programming-best-practices.md",
        priority: "reference",
        summary: "Captures proven waveforms, ADSR presets, phrasing, and verification workflow for pleasant SID music.",
        prompts: ["sid-music"],
        tools: ["c64_sound"],
        relatedResources: [RESOURCE_URIS.sound.sid.spec, RESOURCE_URIS.sound.sidwave.spec],
        tags: ["sid", "best-practices", "audio"],
      },
    ],
  },
  {
    id: "graphics",
    title: "Graphics & VIC-II",
    summary: "Key material for PETSCII art, sprites, and raster control on the VIC-II.",
    prompts: ["graphics-demo"],
    tools: ["c64_graphics", "c64_memory"],
    resources: [
      {
        uri: RESOURCE_URIS.graphics.vic.spec,
        name: "VIC-II Graphics Specification",
        description: "Video chip, sprites, raster programming, and timing",
  relativePath: "data/graphics/vic-spec.md",
        priority: "critical",
        summary: "Covers raster timing, sprite control, colour RAM, and bitmap modes on the VIC-II.",
        prompts: ["graphics-demo"],
        tools: ["c64_graphics", "c64_memory"],
        relatedResources: [RESOURCE_URIS.assembly.spec6510, RESOURCE_URIS.graphics.characterSet, RESOURCE_URIS.graphics.petscii.styleGuide],
        tags: ["vic", "graphics"],
      },
      {
        uri: RESOURCE_URIS.graphics.characterSet,
        name: "PETSCII Character Set Reference",
        description: "Complete PETSCII character codes, screen codes, and glyph mappings",
  relativePath: "data/graphics/character-set.csv",
        priority: "reference",
        summary: "Character code table mapping PETSCII codes to screen codes, glyphs, and keyboard input.",
        prompts: ["graphics-demo"],
        tools: ["c64_graphics"],
        relatedResources: [RESOURCE_URIS.graphics.vic.spec, RESOURCE_URIS.graphics.petscii.styleGuide],
        tags: ["petscii", "charset", "graphics"],
      },
      {
        uri: RESOURCE_URIS.graphics.petscii.styleGuide,
        name: "PETSCII Style Guide and Presets",
        description: "Colour combinations, contrast guidelines, and recommended presets for PETSCII art",
  relativePath: "data/graphics/petscii-style-guide.md",
        priority: "reference",
        summary: "Documents colour palette, readability presets, dithering patterns, and best practices for creating artistic and readable PETSCII displays.",
        prompts: ["graphics-demo"],
        tools: ["c64_graphics"],
        relatedResources: [RESOURCE_URIS.graphics.vic.spec, RESOURCE_URIS.graphics.characterSet, RESOURCE_URIS.graphics.spriteCharset.bestPractices],
        tags: ["petscii", "style", "colours", "graphics"],
      },
      {
        uri: RESOURCE_URIS.graphics.spriteCharset.bestPractices,
        name: "Sprite & Charset Workflows Best Practices",
        description: "Comprehensive guide to creating, managing, and deploying sprites and custom character sets",
  relativePath: "data/graphics/sprite-charset-best-practices.md",
        priority: "reference",
        summary: "Documents sprite and charset workflows, memory layout, VIC-II configuration, common pitfalls, and proven techniques for hardware-accelerated graphics.",
        prompts: ["graphics-demo"],
        tools: ["c64_graphics", "c64_memory", "c64_program"],
        relatedResources: [RESOURCE_URIS.graphics.vic.spec, RESOURCE_URIS.graphics.characterSet, RESOURCE_URIS.graphics.petscii.styleGuide, RESOURCE_URIS.memory.map],
        tags: ["sprites", "charset", "graphics", "workflows"],
      },
    ],
  },
  {
    id: "memory",
    title: "Memory & I/O Reference",
    summary: "Critical tables for RAM layout, zero-page vectors, and peripheral I/O registers.",
    prompts: ["memory-debug", "assembly-program"],
  tools: ["read", "write", "verify_and_write_memory", "debugreg_read", "debugreg_write"],
    resources: [
      {
        uri: RESOURCE_URIS.memory.map,
        name: "C64 Memory Map",
        description: "Complete RAM, ROM, and I/O address map for the Commodore 64.",
        relativePath: "data/memory/memory-map.md",
        priority: "critical",
        summary: "Page-by-page breakdown of the 64 KB address space with hardware, ROM, and RAM regions.",
        prompts: ["memory-debug", "assembly-program"],
  tools: ["read", "write", "verify_and_write_memory"],
        relatedResources: [RESOURCE_URIS.assembly.spec6510],
        tags: ["memory", "hardware"],
      },
      {
        uri: RESOURCE_URIS.memory.zeroPageAndWorkspace,
        name: "Low Memory Usage Guide",
        description: "Zero-page and system vector reference for low-memory addresses.",
        relativePath: "data/memory/low-memory-map.md",
        priority: "reference",
        summary: "Documents zero-page variables, BASIC pointers, and KERNAL workspace addresses.",
        prompts: ["memory-debug", "assembly-program"],
  tools: ["read", "write", "verify_and_write_memory"],
        relatedResources: [RESOURCE_URIS.memory.map, RESOURCE_URIS.assembly.spec6510],
        tags: ["memory", "zero-page"],
      },
      {
        uri: RESOURCE_URIS.kernal.romRoutines,
        name: "KERNAL Memory Map",
        description: "Detailed breakdown of KERNAL ROM routines and entry points.",
        relativePath: "data/memory/kernal-memory-map.md",
        priority: "reference",
        summary: "Lists KERNAL ROM vectors and service routines for OS-level functionality.",
        prompts: ["memory-debug", "assembly-program"],
  tools: ["read", "verify_and_write_memory"],
        relatedResources: [RESOURCE_URIS.memory.map, RESOURCE_URIS.assembly.spec6510],
        tags: ["memory", "kernal"],
      },
      {
        uri: RESOURCE_URIS.io.spec,
        name: "C64 I/O Register Map",
        description: "Comprehensive table of memory-mapped hardware registers.",
        relativePath: "data/io/io-spec.md",
        priority: "critical",
        summary: "Covers VIC-II, SID, CIA, and system control registers with address ranges and usage notes.",
        prompts: ["memory-debug", "assembly-program"],
  tools: ["read", "write", "verify_and_write_memory", "debugreg_read", "debugreg_write"],
        relatedResources: [RESOURCE_URIS.memory.map, RESOURCE_URIS.assembly.spec6510],
        tags: ["io", "hardware"],
      },
      {
        uri: RESOURCE_URIS.io.cia.spec,
        name: "CIA Register Reference",
        description: "Timer, keyboard, and peripheral register reference for CIA chips.",
        relativePath: "data/io/cia-spec.md",
        priority: "reference",
        summary: "Details CIA 1/2 registers, timers, interrupts, and keyboard matrix layout.",
        prompts: ["memory-debug", "assembly-program"],
  tools: ["read", "write", "verify_and_write_memory", "debugreg_read"],
        relatedResources: [RESOURCE_URIS.io.spec, RESOURCE_URIS.memory.map],
        tags: ["io", "hardware"],
      },
    ],
  },
  {
    id: "printer",
    title: "Printers & Hardcopy",
    summary: "Guides for Commodore MPS and Epson FX printing workflows, including prompts.",
    prompts: ["printer-job"],
    tools: [
      "printer_guide",
      "printer_commodore_text",
      "printer_commodore_bitmap",
      "printer_epson_text",
      "printer_epson_bitmap",
      "printer_prompts",
    ],
    resources: [
      {
        uri: RESOURCE_URIS.printer.spec,
        name: "Printer Programming Guide",
        description: "Commodore MPS and Epson FX printer control",
        relativePath: "data/printer/printer-spec.md",
        priority: "critical",
        summary: "Covers device setup, control codes, and Ultimate 64 integration for printers.",
        prompts: ["printer-job"],
        tools: ["printer_guide", "printer_commodore_text", "printer_epson_text"],
        relatedResources: [
          RESOURCE_URIS.printer.commodore.text,
          RESOURCE_URIS.printer.epson.text,
        ],
        tags: ["printer", "spec"],
      },
      {
        uri: RESOURCE_URIS.printer.commodore.text,
        name: "Commodore Printer Text Guide",
        description: "Device 4 character printing reference for Commodore MPS printers",
        relativePath: "data/printer/printer-commodore.md",
        priority: "reference",
        summary: "Character sets, control codes, and formatting for Commodore MPS text output.",
        prompts: ["printer-job"],
        tools: ["printer_commodore_text"],
        relatedResources: [
          RESOURCE_URIS.printer.spec,
          RESOURCE_URIS.printer.commodore.bitmap,
        ],
        tags: ["printer", "commodore"],
      },
      {
        uri: RESOURCE_URIS.printer.commodore.bitmap,
        name: "Commodore Printer Bitmap Guide",
        description: "Bitmap and custom character printing workflow for Commodore printers",
        relativePath: "data/printer/printer-commodore-bitmap.md",
        priority: "reference",
        summary: "Details bitmap modes, graphics commands, and data layout for MPS bitmap printing.",
        prompts: ["printer-job"],
        tools: ["printer_commodore_bitmap"],
        relatedResources: [
          RESOURCE_URIS.printer.commodore.text,
          RESOURCE_URIS.printer.spec,
        ],
        tags: ["printer", "commodore", "graphics"],
      },
      {
        uri: RESOURCE_URIS.printer.epson.text,
        name: "Epson Printer Text Guide",
        description: "Text control sequences for Epson FX-compatible printers",
        relativePath: "data/printer/printer-epson.md",
        priority: "reference",
        summary: "Lists ESC/P control codes and formatting advice for Epson FX text output.",
        prompts: ["printer-job"],
        tools: ["printer_epson_text"],
        relatedResources: [
          RESOURCE_URIS.printer.epson.bitmap,
          RESOURCE_URIS.printer.spec,
        ],
        tags: ["printer", "epson"],
      },
      {
        uri: RESOURCE_URIS.printer.epson.bitmap,
        name: "Epson Printer Bitmap Guide",
        description: "Bitmap printing and graphics control for Epson FX printers",
        relativePath: "data/printer/printer-epson-bitmap.md",
        priority: "reference",
        summary: "Explains bit-image modes, density options, and data packing for Epson bitmap jobs.",
        prompts: ["printer-job"],
        tools: ["printer_epson_bitmap"],
        relatedResources: [
          RESOURCE_URIS.printer.epson.text,
          RESOURCE_URIS.printer.spec,
        ],
        tags: ["printer", "epson", "graphics"],
      },
      {
        uri: RESOURCE_URIS.printer.promptGuide,
        name: "Printer Prompt Templates",
        description: "Template prompts and workflow guidance for printer jobs",
        relativePath: "data/printer/printer-prompts.md",
        priority: "supplemental",
        summary: "Reusable prompt templates that drive complex printer jobs through the MCP server.",
        prompts: ["printer-job"],
        tools: ["printer_prompts"],
        relatedResources: [
          RESOURCE_URIS.printer.spec,
          RESOURCE_URIS.printer.commodore.text,
          RESOURCE_URIS.printer.epson.text,
        ],
        tags: ["printer", "prompts"],
      },
    ],
  },
];

const CANONICAL_KNOWLEDGE_RESOURCE_URI_SET = new Set<string>(CANONICAL_KNOWLEDGE_RESOURCE_URIS);

const BASE_RESOURCES: readonly KnowledgeResourceDefinition[] = KNOWLEDGE_BUNDLES.flatMap(
  (bundle, bundleIndex) =>
    bundle.resources.map((resource, resourceIndex): KnowledgeResourceDefinition => {
      if (!CANONICAL_KNOWLEDGE_RESOURCE_URI_SET.has(resource.uri)) {
        throw new Error(
          `Knowledge resource URI ${resource.uri} is not part of the canonical resource set`,
        );
      }

      const baseResource = {
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: "text/markdown" as const,
        relativePath: resource.relativePath,
        metadata: {
          domain: bundle.id,
          priority: resource.priority,
          summary: resource.summary,
          prompts: resource.prompts,
          tools: resource.tools,
          tags: resource.tags ?? [],
          bundle: {
            id: bundle.id,
            title: bundle.title,
            summary: bundle.summary,
            order: bundleIndex,
          },
          order: resourceIndex,
          relatedResources: resource.relatedResources ?? [],
        },
      };
      
      // Add buildContent for resources that need dynamic generation
      if (resource.uri === RESOURCE_URIS.graphics.characterSet) {
        return { ...baseResource, buildContent: generateCharsetQuickref };
      }
      
      return baseResource;
    }),
);

const INDEX_RESOURCE: KnowledgeResourceDefinition = {
  uri: RESOURCE_URIS.guide.index,
  name: "C64 Knowledge Map",
  description: "Start here for a guided tour of all Commodore 64 knowledge resources",
  mimeType: "text/markdown",
  metadata: {
    domain: "guide",
    priority: "critical",
    summary: "Explains how to approach each knowledge bundle and when to consult it.",
    prompts: ["basic-program", "assembly-program", "sid-music", "graphics-demo", "printer-job", "memory-debug", "cross-platform-demo", "preset-music-demo"],
    tools: [
      "upload_run_basic",
      "upload_run_asm",
      "music_generate",
      "render_petscii_text",
      "printer_guide",
  "read",
    ],
    tags: ["overview"],
    bundle: {
      id: "guide",
      title: "Knowledge Overview",
      summary: "Read this first to understand how the MCP server organizes Commodore 64 expertise.",
      order: -1,
    },
    order: 0,
    relatedResources: BASE_RESOURCES.map((resource) => resource.uri),
  },
  buildContent: (resources: readonly KnowledgeResourceDefinition[]) => renderKnowledgeIndex(resources),
};

const ALL_RESOURCES: readonly KnowledgeResourceDefinition[] = [...BASE_RESOURCES, INDEX_RESOURCE];

function renderKnowledgeIndex(resources: readonly KnowledgeResourceDefinition[]): string {
  const sections = KNOWLEDGE_BUNDLES.map((bundle) => {
    const bundleResources = resources.filter(
      (resource) => resource.metadata.bundle.id === bundle.id,
    );

    const entries = bundleResources
      .map((resource) => {
        const star = resource.metadata.priority === "critical" ? "★ " : "";
        const prompts = resource.metadata.prompts.length
          ? ` Prompts: ${resource.metadata.prompts
              .map((prompt) => `\`${prompt}\``)
              .join(", ")}.`
          : "";
        const tools = resource.metadata.tools.length
          ? ` Tools: ${resource.metadata.tools
              .map((tool) => `\`${tool}\``)
              .join(", ")}.`
          : "";
        const tags = resource.metadata.tags.length
          ? ` Tags: ${resource.metadata.tags.join(", ")}.`
          : "";
        return `- ${star}**${resource.name}** (\`${resource.uri}\`) — ${resource.metadata.summary}.${prompts}${tools}${tags}`;
      })
      .join("\n");

    return `## ${bundle.title}\n\n${bundle.summary}\n\n${entries}`;
  });

  return [
    "# C64 Knowledge Map",
    "Start with critical (★) entries before invoking tools or generating code.",
    ...sections,
  ].join("\n\n");
}

export function listKnowledgeResources(): readonly KnowledgeResourceDefinition[] {
  return ALL_RESOURCES;
}

export function getKnowledgeResource(
  uri: string,
): KnowledgeResourceDefinition | undefined {
  return ALL_RESOURCES.find((resource) => resource.uri === uri);
}

export function readKnowledgeResource(
  uri: string,
  projectRoot: string,
): { uri: string; mimeType: string; text: string } | undefined {
  const resource = getKnowledgeResource(uri);
  if (!resource) {
    return undefined;
  }

  if (resource.buildContent) {
    const baseResources = ALL_RESOURCES.filter(
      (item) => item.uri !== resource.uri,
    );
    return {
      uri,
      mimeType: resource.mimeType,
      text: resource.buildContent(baseResources),
    };
  }

  if (!resource.relativePath) {
    return undefined;
  }

  const fullPath = join(projectRoot, resource.relativePath);
  const text = readFileSync(fullPath, "utf-8");

  return {
    uri,
    mimeType: resource.mimeType,
    text,
  };
}
