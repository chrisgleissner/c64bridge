export const RESOURCE_URIS = {
  guide: {
    index: "c64://guide/index",
    bootstrap: "c64://guide/bootstrap",
    fastPaths: "c64://guide/fast-paths",
  },
  vice: {
    binaryMonitorSpec: "c64://vice/binary-monitor-spec",
  },
  basic: {
    spec: "c64://basic/spec",
    pitfalls: "c64://basic/pitfalls",
  },
  assembly: {
    spec6510: "c64://assembly/6510-spec",
  },
  sound: {
    sid: {
      spec: "c64://sound/sid/spec",
      fileFormat: "c64://sound/sid/file-format",
      bestPractices: "c64://sound/sid/best-practices",
    },
    sidwave: {
      spec: "c64://sound/sidwave/spec",
    },
  },
  graphics: {
    vic: {
      spec: "c64://graphics/vic/spec",
    },
    characterSet: "c64://graphics/character-set",
    petscii: {
      styleGuide: "c64://graphics/petscii/style-guide",
    },
    spriteCharset: {
      bestPractices: "c64://graphics/sprite-charset/best-practices",
    },
  },
  memory: {
    map: "c64://memory/map",
    zeroPageAndWorkspace: "c64://memory/zero-page-and-workspace",
  },
  kernal: {
    romRoutines: "c64://kernal/rom-routines",
  },
  io: {
    spec: "c64://io/spec",
    cia: {
      spec: "c64://io/cia/spec",
    },
  },
  printer: {
    spec: "c64://printer/spec",
    commodore: {
      text: "c64://printer/commodore/text",
      bitmap: "c64://printer/commodore/bitmap",
    },
    epson: {
      text: "c64://printer/epson/text",
      bitmap: "c64://printer/epson/bitmap",
    },
    promptGuide: "c64://printer/prompt-guide",
  },
} as const;

export const PLATFORM_RESOURCE_URI = "c64://platform/status";

export const CANONICAL_KNOWLEDGE_RESOURCE_URIS: readonly string[] = Object.freeze([
  RESOURCE_URIS.guide.bootstrap,
  RESOURCE_URIS.guide.fastPaths,
  RESOURCE_URIS.vice.binaryMonitorSpec,
  RESOURCE_URIS.basic.spec,
  RESOURCE_URIS.basic.pitfalls,
  RESOURCE_URIS.assembly.spec6510,
  RESOURCE_URIS.sound.sid.spec,
  RESOURCE_URIS.sound.sidwave.spec,
  RESOURCE_URIS.sound.sid.fileFormat,
  RESOURCE_URIS.sound.sid.bestPractices,
  RESOURCE_URIS.graphics.vic.spec,
  RESOURCE_URIS.graphics.characterSet,
  RESOURCE_URIS.graphics.petscii.styleGuide,
  RESOURCE_URIS.graphics.spriteCharset.bestPractices,
  RESOURCE_URIS.memory.map,
  RESOURCE_URIS.memory.zeroPageAndWorkspace,
  RESOURCE_URIS.kernal.romRoutines,
  RESOURCE_URIS.io.spec,
  RESOURCE_URIS.io.cia.spec,
  RESOURCE_URIS.printer.spec,
  RESOURCE_URIS.printer.commodore.text,
  RESOURCE_URIS.printer.commodore.bitmap,
  RESOURCE_URIS.printer.epson.text,
  RESOURCE_URIS.printer.epson.bitmap,
  RESOURCE_URIS.printer.promptGuide,
  RESOURCE_URIS.guide.index,
] as const);
